import http from 'node:http';

/**
 * Controllable local Fake External Services (DeepSeek/OpenAI-compatible LLM + Fault Injection).
 * Allows deterministic E2E testing of streaming AI Echo, Agent Goal planning/execution,
 * and chaos fault injection (500 errors, timeouts, malformed JSON).
 */
export function createFakeExternalsServer() {
    let state = {
        mode: 'ok',       // 'ok' | 'slow' | 'error500' | 'bad_json'
        delayMs: 0,
        requests: [],
    };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const rawBody = Buffer.concat(chunks).toString('utf8');

        // Control plane for chaos & fault injection tests
        if (url.pathname === '/__control' && req.method === 'POST') {
            try {
                const patch = JSON.parse(rawBody || '{}');
                state = { ...state, ...patch };
                if (patch.clearRequests) state.requests = [];
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
            res.end(JSON.stringify({ mode: state.mode, delayMs: state.delayMs, count: state.requests.length }));
            return;
        }

        if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
            let body = {};
            try { body = JSON.parse(rawBody || '{}'); } catch { /* ignore */ }
            state.requests.push({ path: url.pathname, stream: Boolean(body.stream), at: Date.now() });

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

            // Handle Agent Goal planning prompts deterministically
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
                        { title: '生成整理总结草案', description: '汇总上述线索形成结构化结论', kind: 'synthesize', dependsOn: [0] }
                    ]
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
