import { test, expect } from '@playwright/test';
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
});

