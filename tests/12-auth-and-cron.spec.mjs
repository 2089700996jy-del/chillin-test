import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn, spawnSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { CHILLIN_ROOT, getFreePort } from '../src/env/ports.mjs';
import { createFakeExternalsServer } from '../src/env/fake-externals.mjs';
import { attachPwaHarness } from '../src/support/pwa-harness.mjs';
import { uniqueUser } from '../src/support/test-data.mjs';

test.describe('Auth 会话撤销与 Wrangler Cron 真实调度验证 @core', () => {
    test('多设备会话列表、单设备撤销与全端登出后旧 Cookie 即时失效', async ({ browser }) => {
        const user = uniqueUser('sess');
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const harnessA = await attachPwaHarness(ctxA);
        const harnessB = await attachPwaHarness(ctxB);
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        await harnessA.registerAndEnter(pageA, user);
        await harnessB.loginAndEnter(pageB, user);

        const base = harnessA.runtime.appOrigin;

        // 1. 设备 A 查询活跃会话列表，应至少包含 2 个会话
        const listRes = await pageA.request.get(`${base}/api/auth/sessions`);
        expect(listRes.ok()).toBe(true);
        const sessionsBody = await listRes.json();
        const sessions = Array.isArray(sessionsBody) ? sessionsBody : (sessionsBody.sessions || []);
        expect(sessions.length).toBeGreaterThanOrEqual(2);

        // 2. 撤销非当前会话（设备 B），设备 B 后续请求必须立即返回 401
        const otherSession = sessions.find((s) => !s.current && !s.isCurrent && !s.is_current) || sessions[sessions.length - 1];
        expect(otherSession?.id).toBeTruthy();

        const revokeRes = await pageA.request.delete(`${base}/api/auth/sessions/${encodeURIComponent(otherSession.id)}`);
        expect(revokeRes.ok()).toBe(true);

        const probeBAfterRevoke = await pageB.request.get(`${base}/api/notes`);
        expect(probeBAfterRevoke.status(), '被撤销会话的设备 B 仍能访问受保护接口').toBe(401);

        // 3. 设备 A 执行全端登出（logout-all），设备 A 自身 Cookie 也应立即失效
        const logoutAllRes = await pageA.request.post(`${base}/api/auth/logout-all`);
        expect(logoutAllRes.ok()).toBe(true);

        const probeAAfterLogoutAll = await pageA.request.get(`${base}/api/notes`);
        expect(probeAAfterLogoutAll.status(), 'logout-all 后设备 A 仍能访问受保护接口').toBe(401);

        harnessA.assertNoBugs('Auth 会话撤销设备 A');
        await ctxA.close();
        await ctxB.close();
    });

    test('Wrangler 本地 --test-scheduled 双 Cron 触发（每分钟调度与每小时维护）真实业务效果验证', async ({ browser, request }) => {
        const { readRuntime } = await import('../src/env/ports.mjs');
        const rt = readRuntime();
        expect(rt.wranglerOrigin).toBeTruthy();

        // 创建一条真实业务数据，验证每小时维护 Cron 不会误删有效数据，且每分钟 Cron 触发后系统状态正常
        const ctx = await browser.newContext();
        const harness = await attachPwaHarness(ctx);
        const page = await ctx.newPage();
        const user = uniqueUser('cron');
        await harness.registerAndEnter(page, user);
        const base = harness.runtime.appOrigin;

        const noteRes = await page.request.post(`${base}/api/notes`, {
            data: { title: 'Cron维护保留测试', content: '不应被每小时维护清理的有效笔记', date: '2026-11-27' },
        });
        expect(noteRes.ok()).toBe(true);
        const createdNote = await noteRes.json();

        const minuteCron = await request.get(`${rt.wranglerOrigin}/__scheduled?cron=${encodeURIComponent('* * * * *')}`);
        expect(minuteCron.status(), '每分钟 Cron 调度返回异常状态').toBe(200);
        const minuteBody = await minuteCron.text();
        expect(minuteBody.toLowerCase()).not.toContain('exception');

        const hourlyCron = await request.get(`${rt.wranglerOrigin}/__scheduled?cron=${encodeURIComponent('13 * * * *')}`);
        expect(hourlyCron.status(), '每小时维护 Cron 调度返回异常状态').toBe(200);
        const hourlyBody = await hourlyCron.text();
        expect(hourlyBody.toLowerCase()).not.toContain('exception');

        // 验证维护 Cron 执行后有效业务数据依然完整可读
        const notesAfter = await page.request.get(`${base}/api/notes`);
        expect(notesAfter.ok()).toBe(true);
        const notesList = await notesAfter.json();
        expect(notesList.some((n) => n.id === createdNote.id && n.title === 'Cron维护保留测试')).toBe(true);

        harness.assertNoBugs('Cron 本地调度验证');
        await ctx.close();
    });

    test('真实 Worker /__scheduled 端到端链路：提醒到期/追问/幂等、东八区08:00天气关怀与上游500降级', async () => {
        test.setTimeout(120_000);
        const tmpRoot = path.resolve(CHILLIN_ROOT, '..', '.tmp');
        fs.mkdirSync(tmpRoot, { recursive: true });
        const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'qa-cron-e2e-'));
        const stateDir = path.join(tmpDir, 'state');
        const workerdTmp = path.join(tmpDir, 'workerd-tmp');
        fs.mkdirSync(stateDir, { recursive: true });
        fs.mkdirSync(workerdTmp, { recursive: true });

        const fakeExt = createFakeExternalsServer();
        let fakeOrigin = '';
        let wranglerProc = null;

        const cleanEnv = { ...process.env };
        delete cleanEnv.CLOUDFLARE_API_TOKEN;
        delete cleanEnv.CF_API_TOKEN;
        delete cleanEnv.CLOUDFLARE_ACCOUNT_ID;
        delete cleanEnv.HTTP_PROXY;
        delete cleanEnv.HTTPS_PROXY;
        delete cleanEnv.http_proxy;
        delete cleanEnv.https_proxy;
        delete cleanEnv.ALL_PROXY;
        delete cleanEnv.all_proxy;
        cleanEnv.NO_PROXY = '127.0.0.1,localhost';
        cleanEnv.CI = '1';
        cleanEnv.TEMP = workerdTmp;
        cleanEnv.TMP = workerdTmp;

        const persistRel = path.relative(CHILLIN_ROOT, stateDir) || stateDir;
        const wranglerBin = path.join(CHILLIN_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
        const runWrangler = (args) => {
            const useLocal = fs.existsSync(wranglerBin);
            return spawnSync(useLocal ? process.execPath : 'npx', useLocal ? [wranglerBin, ...args] : ['wrangler', ...args], {
                cwd: CHILLIN_ROOT,
                env: cleanEnv,
                encoding: 'utf8',
                shell: !useLocal && process.platform === 'win32',
            });
        };

        try {
            const fakeInfo = await fakeExt.start();
            fakeOrigin = fakeInfo.origin;

            // 1. 构造隔离 wrangler.toml 与测试专用 Worker 包装入口（仅重定向外网域名到 fakeExt 并注入受控时钟）
            const origToml = fs.readFileSync(path.join(CHILLIN_ROOT, 'wrangler.toml'), 'utf8');
            const workerEntryPath = path.join(tmpDir, 'cron-worker.mjs');
            const apiImport = path.relative(tmpDir, path.join(CHILLIN_ROOT, 'workers', 'api.js')).replace(/\\/g, '/');
            const workerSource = [
                `import api from ${JSON.stringify(apiImport)};`,
                `const FAKE_ORIGIN = ${JSON.stringify(fakeOrigin)};`,
                `const origFetch = globalThis.fetch;`,
                `globalThis.fetch = (input, init) => {`,
                `    const raw = typeof input === 'string' ? input : input.url;`,
                `    const rewritten = raw.replace('https://ilinkai.weixin.qq.com', FAKE_ORIGIN).replace('https://devapi.qweather.com', FAKE_ORIGIN);`,
                `    if (rewritten !== raw) return origFetch(rewritten, init);`,
                `    return origFetch(input, init);`,
                `};`,
                `let testClockMs = null;`,
                `export default {`,
                `    async fetch(request, env, ctx) {`,
                `        const u = new URL(request.url);`,
                `        if (u.pathname === '/__test_clock') {`,
                `            const ms = Number(u.searchParams.get('ms'));`,
                `            testClockMs = Number.isFinite(ms) ? ms : null;`,
                `            return Response.json({ ok: true, testClockMs });`,
                `        }`,
                `        return api.fetch(request, env, ctx);`,
                `    },`,
                `    async scheduled(event, env, ctx) {`,
                `        const patched = testClockMs != null ? { cron: event.cron, scheduledTime: testClockMs, noRetry: event.noRetry } : event;`,
                `        return api.scheduled(patched, env, ctx);`,
                `    },`,
                `};`,
            ].join('\n');
            fs.writeFileSync(workerEntryPath, workerSource, 'utf8');

            fs.cpSync(path.join(CHILLIN_ROOT, 'migrations'), path.join(tmpDir, 'migrations'), { recursive: true });
            const patchedToml = origToml
                .replace(/main\s*=\s*"workers\/api\.js"/, `main = ${JSON.stringify(workerEntryPath.replace(/\\/g, '/'))}`);
            const testTomlPath = path.join(tmpDir, 'wrangler.cron.toml');
            fs.writeFileSync(testTomlPath, patchedToml, 'utf8');

            // 2. 初始化隔离本地 D1 并写入测试用户、已绑定 ClawBot、待触发提醒
            const migRes = runWrangler(['d1', 'migrations', 'apply', 'DB', '--local', '--config', testTomlPath, '--persist-to', persistRel]);
            expect(migRes.status, `Cron 隔离 D1 迁移失败: ${migRes.stderr}`).toBe(0);

            const baseNow = Date.now();
            const seedSqlPath = path.join(tmpDir, 'seed.sql');
            fs.writeFileSync(seedSqlPath, [
                "INSERT INTO users (id, username, password_hash) VALUES (1, 'cron_e2e_user', 'hash');",
                "INSERT INTO bot_claw_accounts (id, user_id, status, qrcode, bot_token, ilink_bot_id, ilink_user_id, baseurl, outreach_enabled, is_deleted, created_at, updated_at) VALUES (1, 1, 'bound', 'qr-cron', 'fake-bot-token', 'fake-bot-1', 'wx-cron-1', 'https://ilinkai.weixin.qq.com', 1, 0, 1000, 1000);",
                `INSERT INTO bot_reminders (id, user_id, text, fire_at_ms, follow_up_ms, status, created_at, updated_at) VALUES (1, 1, '真实WorkerCron到期提醒', ${baseNow - 1000}, 60000, 'pending', ${baseNow - 120000}, ${baseNow - 120000});`,
            ].join('\n'), 'utf8');
            const seedRes = runWrangler(['d1', 'execute', 'DB', '--local', '--config', testTomlPath, '--persist-to', persistRel, '--file', seedSqlPath]);
            expect(seedRes.status, `Cron 种子数据写入失败: ${seedRes.stderr}`).toBe(0);

            const queryD1 = (sql) => {
                const r = runWrangler(['d1', 'execute', 'DB', '--local', '--config', testTomlPath, '--persist-to', persistRel, '--json', '--command', sql]);
                expect(r.status, `Cron D1 查询失败: ${r.stderr}`).toBe(0);
                return JSON.parse(r.stdout)?.[0]?.results || [];
            };

            // 3. 启动隔离本地 Wrangler Worker (--test-scheduled)
            const wPort = await getFreePort();
            const iPort = await getFreePort();
            const wOrigin = `http://127.0.0.1:${wPort}`;
            wranglerProc = spawn(
                'npx',
                [
                    'wrangler', 'dev',
                    '--config', testTomlPath,
                    '--local',
                    '--ip', '127.0.0.1',
                    '--port', String(wPort),
                    '--inspector-port', String(iPort),
                    '--persist-to', persistRel,
                    '--show-interactive-dev-session=false',
                    '--test-scheduled',
                    '--var', 'ALLOW_REGISTRATION:true',
                    '--var', 'CLAW_POLL_BUDGET_MS:0',
                    '--var', 'QWEATHER_KEY:fake-qweather-key',
                    '--var', 'QWEATHER_API_HOST:devapi.qweather.com',
                ],
                { cwd: CHILLIN_ROOT, env: cleanEnv, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] }
            );

            const startWait = Date.now();
            let healthy = false;
            while (Date.now() - startWait < 35_000) {
                try {
                    const h = await fetch(`${wOrigin}/api/health`);
                    if (h.ok) { healthy = true; break; }
                } catch { /* wait */ }
                await new Promise((r) => setTimeout(r, 400));
            }
            expect(healthy, '隔离 Cron Wrangler Worker 启动超时').toBe(true);

            const setControl = async (patch) => {
                const r = await fetch(`${fakeOrigin}/__control`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
                });
                expect(r.ok).toBe(true);
            };
            const getControl = async () => (await fetch(`${fakeOrigin}/__control`)).json();
            const setClock = async (ms) => {
                const r = await fetch(`${wOrigin}/__test_clock?ms=${ms}`);
                expect(r.ok).toBe(true);
            };
            const triggerCron = async () => {
                const r = await fetch(`${wOrigin}/__scheduled?cron=${encodeURIComponent('* * * * *')}`);
                expect(r.status).toBe(200);
            };

            // 4. 提醒端到端验证：到点触发 -> 窗口内幂等 -> 追问触发
            await setControl({ ilinkSendFail: false, clearRequests: true });
            await triggerCron();
            let remRow = queryD1('SELECT status, follow_up_status FROM bot_reminders WHERE id = 1')[0];
            expect(remRow.status).toBe('fired');
            expect((await getControl()).ilinkSentMessages.length).toBe(1);

            // 追问窗口内重复触发：幂等不重复发送
            await triggerCron();
            expect((await getControl()).ilinkSentMessages.length).toBe(1);

            // 推进追问到期时间后再次触发真实 Worker Cron：发送追问消息并更新 follow_up_status='sent'
            const pastTs = Date.now() - 1000;
            queryD1(`UPDATE bot_reminders SET follow_up_at_ms = ${pastTs}, follow_up_retry_at_ms = ${pastTs} WHERE id = 1`);
            await triggerCron();
            expect((await getControl()).ilinkSentMessages.length).toBe(2);
            remRow = queryD1('SELECT status, follow_up_status FROM bot_reminders WHERE id = 1')[0];
            expect(remRow.follow_up_status).toBe('sent');
            await triggerCron();
            expect((await getControl()).ilinkSentMessages.length).toBe(2);

            // 5. 东八区 08:00–08:15 天气关怀：舒适静默 -> 暴雨提醒 -> 同日幂等 -> 上游500 -> 推送失败不误标
            const morning8amMs = Date.UTC(2026, 10, 27, 0, 5, 0); // 东八区 2026-11-27 08:05
            await setControl({ weatherScenario: 'calm', ilinkSendFail: false, clearRequests: true });
            await setClock(morning8amMs);
            await triggerCron();
            expect((await getControl()).ilinkSentMessages.length).toBe(0);
            expect(Number(queryD1("SELECT notified FROM bot_weather_daily WHERE user_id = 1 AND date = '2026-11-27'")[0]?.notified ?? 0)).toBe(0);

            await setControl({ weatherScenario: 'rain_storm', ilinkSendFail: false, clearRequests: true });
            await setClock(morning8amMs + 60_000);
            await triggerCron();
            expect((await getControl()).ilinkSentMessages.length).toBe(1);
            expect(queryD1("SELECT notified FROM bot_weather_daily WHERE user_id = 1 AND date = '2026-11-27'")[0]?.notified).toBe(1);

            await setClock(morning8amMs + 120_000);
            await triggerCron();
            expect((await getControl()).ilinkSentMessages.length).toBe(1);

            const nextDayMs = morning8amMs + 24 * 3600 * 1000;
            await setControl({ weatherScenario: 'error500', ilinkSendFail: false, clearRequests: true });
            await setClock(nextDayMs);
            await triggerCron();
            expect((await getControl()).ilinkSentMessages.length).toBe(0);
            expect(queryD1("SELECT notified FROM bot_weather_daily WHERE user_id = 1 AND date = '2026-11-28'").length).toBe(0);

            await setControl({ weatherScenario: 'rain_storm', ilinkSendFail: true, clearRequests: true });
            await setClock(nextDayMs + 60_000);
            await triggerCron();
            expect((await getControl()).ilinkSentMessages.length).toBe(0);
            expect(Number(queryD1("SELECT notified FROM bot_weather_daily WHERE user_id = 1 AND date = '2026-11-28'")[0]?.notified ?? 0)).toBe(0);
        } finally {
            if (wranglerProc && wranglerProc.pid) {
                try {
                    if (process.platform === 'win32') execSync(`taskkill /pid ${wranglerProc.pid} /T /F`, { stdio: 'ignore' });
                    else process.kill(wranglerProc.pid, 'SIGKILL');
                } catch { /* ignore */ }
            }
            await fakeExt.stop().catch(() => {});
            try {
                fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
            } catch { /* ignore Windows handle release delay */ }
        }
    });
});

