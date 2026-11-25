import http from 'node:http';

/**
 * Controllable local Fake External Services:
 * 1. DeepSeek/OpenAI-compatible LLM (/v1/chat/completions) with full prompt capture & fault injection
 * 2. Fake iLink WeChat ClawBot protocol server (/ilink/bot/*) for protocol simulation
 */
export function createFakeExternalsServer() {
    let state = {
        mode: 'ok',       // 'ok' | 'slow' | 'error500' | 'bad_json'
        delayMs: 0,
        requests: [],
        ilinkUpdatesQueue: [],
        ilinkSentMessages: [],
        ilinkSendFail: false,
        ilinkGetUpdatesFail: false,
    };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const rawBody = Buffer.concat(chunks).toString('utf8');

        // Control plane for inspecting captured prompts/replies & injecting faults
        if (url.pathname === '/__control' && req.method === 'POST') {
            try {
                const patch = JSON.parse(rawBody || '{}');
                if (Array.isArray(patch.pushClawUpdates)) {
                    state.ilinkUpdatesQueue.push(...patch.pushClawUpdates);
                    delete patch.pushClawUpdates;
                }
                if (patch.clearRequests) {
                    state.requests = [];
                    state.ilinkSentMessages = [];
                    delete patch.clearRequests;
                }
                state = { ...state, ...patch };
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, mode: state.mode, delayMs: state.delayMs }));
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
            return;
        }

        if (url.pathname === '/__control' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                mode: state.mode,
                delayMs: state.delayMs,
                count: state.requests.length,
                requests: state.requests,
                ilinkSentMessages: state.ilinkSentMessages,
            }));
            return;
        }

        // ── Fake DeepSeek / OpenAI Chat Completions ──
        if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
            let body = {};
            try { body = JSON.parse(rawBody || '{}'); } catch { /* ignore */ }
            state.requests.push({
                path: url.pathname,
                stream: Boolean(body.stream),
                messages: Array.isArray(body.messages) ? body.messages : [],
                toolsCount: Array.isArray(body.tools) ? body.tools.length : 0,
                at: Date.now(),
            });

            if (state.delayMs > 0) {
                await new Promise((r) => setTimeout(r, state.delayMs));
            }
            if (state.mode === 'error500') {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Injected upstream LLM 500 failure' } }));
                return;
            }
            if (state.mode === 'bad_json') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{invalid-json-payload');
                return;
            }

            const lastMsg = Array.isArray(body.messages) ? body.messages[body.messages.length - 1] : null;
            const userPrompt = typeof lastMsg?.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg?.content || '');
            const sysPrompt = Array.isArray(body.messages) && body.messages[0]?.role === 'system'
                ? String(body.messages[0].content || '')
                : '';
            const hasToolResults = Array.isArray(body.messages) && body.messages.some((m) => m.role === 'tool');

            // When tools are provided and no tool result exists yet, emit a real tool_call
            // so Chillin's ai.js executes D1 memory retrieval and passes real history back on round 2.
            if (Array.isArray(body.tools) && body.tools.length > 0 && !hasToolResults && !body.stream) {
                const searchTool = body.tools.find((t) => t?.function?.name === 'search_memory')
                    || body.tools.find((t) => t?.function?.name === 'list_quick_feeds')
                    || body.tools[0];
                const fnName = searchTool?.function?.name;
                if (fnName) {
                    const kwMatch = userPrompt.match(/星云协议|工作法|番茄工作法|[\u4e00-\u9fa5A-Za-z0-9_]{2,12}/g);
                    const extractedQuery = userPrompt.includes('星云协议')
                        ? '星云协议'
                        : (kwMatch ? kwMatch[kwMatch.length - 1] : userPrompt.slice(0, 12));
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        id: 'chatcmpl-fake-tool-1',
                        object: 'chat.completion',
                        choices: [{
                            index: 0,
                            message: {
                                role: 'assistant',
                                content: null,
                                tool_calls: [{
                                    id: 'call_fake_1',
                                    type: 'function',
                                    function: {
                                        name: fnName,
                                        arguments: JSON.stringify({ query: extractedQuery, limit: 10 }),
                                    },
                                }],
                            },
                            finish_reason: 'tool_calls',
                        }],
                    }));
                    return;
                }
            }

            const isGoalPlan = sysPrompt.includes('规划') || userPrompt.includes('拆解') || sysPrompt.includes('tasks') || userPrompt.includes('JSON');
            if (body.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                });
                const replyText = `这是来自本地仿真 AI 的记忆回响：已结合你的花园记录回复「${userPrompt.slice(0, 40)}」。`;
                const tokens = replyText.match(/.{1,6}/g) || [replyText];
                for (const tk of tokens) {
                    const frame = { choices: [{ delta: { content: tk } }] };
                    res.write(`data: ${JSON.stringify(frame)}\n\n`);
                }
                res.write('data: [DONE]\n\n');
                res.end();
                return;
            }

            let content = `这是来自本地仿真 AI 的记忆回响：针对「${userPrompt.slice(0, 40)}」已完成分析。`;
            if (isGoalPlan && !body.tools?.length) {
                content = JSON.stringify({
                    summary: '本地测试拆解计划',
                    tasks: [
                        { title: '梳理已有笔记与随手记线索', description: '检查花园现有记录并归纳重点', kind: 'research', dependsOn: [] },
                        { title: '生成整理总结草案', description: '汇总上述线索形成结构化结论', kind: 'synthesize', dependsOn: [0] },
                    ],
                });
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                id: 'chatcmpl-fake-1',
                object: 'chat.completion',
                choices: [{
                    index: 0,
                    message: { role: 'assistant', content },
                    finish_reason: 'stop',
                }],
            }));
            return;
        }

        // ── Fake iLink WeChat ClawBot Protocol Endpoints (Protocol Simulation Only) ──
        if (url.pathname === '/ilink/bot/getupdates' && req.method === 'POST') {
            if (state.ilinkGetUpdatesFail) {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ret: -1, errmsg: 'Injected iLink getupdates failure' }));
                return;
            }
            let body = {};
            try { body = JSON.parse(rawBody || '{}'); } catch { /* ignore */ }
            const batch = state.ilinkUpdatesQueue.splice(0, state.ilinkUpdatesQueue.length);
            const nextCursor = batch.length
                ? `cursor-${Number(String(body.get_updates_buf || 'cursor-0').replace('cursor-', '')) + batch.length}`
                : (body.get_updates_buf || 'cursor-0');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                ret: 0,
                msgs: batch,
                get_updates_buf: nextCursor,
            }));
            return;
        }

        if (url.pathname === '/ilink/bot/sendmessage' && req.method === 'POST') {
            let body = {};
            try { body = JSON.parse(rawBody || '{}'); } catch { /* ignore */ }
            if (state.ilinkSendFail) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ret: -1, errmsg: 'Injected iLink sendmessage failure' }));
                return;
            }
            const text = body?.msg?.item_list?.[0]?.text_item?.text || '';
            state.ilinkSentMessages.push({
                to: body?.msg?.to_user_id || '',
                text,
                contextToken: body?.msg?.context_token || '',
                at: Date.now(),
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ret: 0, msg_id: `fake-reply-${state.ilinkSentMessages.length}` }));
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Fake externals: unhandled ${req.method} ${url.pathname}` }));
    });

    return {
        start: () => new Promise((resolve) => {
            server.listen(0, '127.0.0.1', () => {
                const addr = server.address();
                resolve({ port: addr.port, origin: `http://127.0.0.1:${addr.port}` });
            });
        }),
        stop: () => new Promise((resolve) => server.close(() => resolve())),
    };
}
