import http from 'node:http';

/**
 * Controllable local Fake External Services:
 * 1. DeepSeek/OpenAI-compatible LLM (/v1/chat/completions) with full prompt capture & fault injection
 * 2. Fake iLink WeChat ClawBot protocol server (/ilink/bot/*) for protocol simulation
 * 3. Fake QWeather (/geo/v2/*, /v7/*), Resend Email (/emails), and Web Push (/push/send)
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
        weatherScenario: 'calm', // 'calm' | 'rain_storm' | 'error500'
        emailFail: false,
        sentEmails: [],
        pushFail: false,
        sentPushes: [],
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
                    state.sentEmails = [];
                    state.sentPushes = [];
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
                weatherScenario: state.weatherScenario,
                sentEmails: state.sentEmails,
                sentPushes: state.sentPushes,
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

        // ── Fake QWeather Endpoints ──
        if (url.pathname.startsWith('/geo/v2/') || url.pathname.startsWith('/v7/')) {
            if (state.weatherScenario === 'error500') {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ code: '500', error: 'Injected QWeather 500 failure' }));
                return;
            }
            const isStorm = state.weatherScenario === 'rain_storm';
            if (url.pathname === '/geo/v2/city/lookup') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    code: '200',
                    location: [{ id: '101010100', name: '北京', adm1: '北京市', adm2: '北京' }],
                }));
                return;
            }
            if (url.pathname === '/v7/weather/24h') {
                const hourly = Array.from({ length: 6 }, (_, i) => ({
                    fxTime: `2026-11-25T0${8 + i}:00+08:00`,
                    temp: isStorm ? String(18 - i * 3) : '22',
                    text: isStorm && i >= 1 ? '大雨' : '晴',
                    precip: isStorm && i >= 1 ? '8.5' : '0.0',
                }));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ code: '200', hourly }));
                return;
            }
            if (url.pathname === '/v7/weather/3d') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    code: '200',
                    daily: [{
                        fxDate: '2026-11-25',
                        tempMax: isStorm ? '18' : '23',
                        tempMin: isStorm ? '3' : '17',
                        textDay: isStorm ? '暴雨' : '晴',
                        textNight: isStorm ? '中雨' : '多云',
                    }],
                }));
                return;
            }
            if (url.pathname === '/v7/warning/now') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    code: '200',
                    warning: isStorm ? [{ title: '北京市发布暴雨蓝色预警', text: '预计今天白天有强降水' }] : [],
                }));
                return;
            }
            if (url.pathname === '/v7/indices/1d') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    code: '200',
                    daily: [{ type: '5', level: isStorm ? '1' : '2', name: '紫外线指数', text: '适中' }],
                }));
                return;
            }
        }

        // ── Fake Resend Email & Web Push Endpoints ──
        if (url.pathname === '/emails' && req.method === 'POST') {
            if (state.emailFail) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Injected Resend failure' }));
                return;
            }
            let body = {};
            try { body = JSON.parse(rawBody || '{}'); } catch { /* ignore */ }
            state.sentEmails.push({ to: body.to, subject: body.subject, at: Date.now() });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: `fake-email-${state.sentEmails.length}` }));
            return;
        }

        if (url.pathname === '/push/send' && req.method === 'POST') {
            if (state.pushFail) {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Injected Web Push failure' }));
                return;
            }
            let body = {};
            try { body = JSON.parse(rawBody || '{}'); } catch { /* ignore */ }
            state.sentPushes.push({ payload: body, at: Date.now() });
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
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
