import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect } from '@playwright/test';
import { CHILLIN_ROOT, readRuntime } from '../src/env/ports.mjs';
import { openMigratedLocalD1 } from '../src/support/local-d1.mjs';
import { attachPwaHarness, setExternalFaultMode, getExternalControlState } from '../src/support/pwa-harness.mjs';
import { uniqueUser } from '../src/support/test-data.mjs';

const remindersUrl = pathToFileURL(path.join(CHILLIN_ROOT, 'workers/src/bot-reminders.js')).href;
const clawUrl = pathToFileURL(path.join(CHILLIN_ROOT, 'workers/src/bot-claw.js')).href;

test.describe('Reminders 提醒全生命周期测试', () => {
    test.afterEach(async () => {
        await setExternalFaultMode({ ilinkSendFail: false, clearRequests: true }).catch(() => {});
    });

    test('HTTP 创建提醒在未绑定微信通道时给出明确 400 提示且不崩溃', async ({ browser }) => {
        const context = await browser.newContext();
        const harness = await attachPwaHarness(context);
        const page = await context.newPage();
        const user = uniqueUser('rem');

        await harness.registerAndEnter(page, user);

        const fireAt = Date.now() + 5 * 60_000;
        const createRes = await page.request.post(`${harness.runtime.appOrigin}/api/reminders`, {
            data: { text: '喝水休息一下', fire_at_ms: fireAt },
        });
        expect(createRes.status()).toBe(400);
        const body = await createRes.json();
        expect(String(body.error || '')).toMatch(/微信|绑定/);

        harness.assertNoBugs('Reminders HTTP 未绑定校验');
        await context.close();
    });

    test('创建、到时触发、追问、完成、取消、重试与最大重试次数、慢任务与普通任务间隔（协议仿真）', async () => {
        const rt = readRuntime();
        const {
            createReminderAt,
            cancelReminder,
            completeReminder,
            runReminderChecks,
            followUpMsForText,
        } = await import(remindersUrl);
        const { upsertQrcode, markBound } = await import(clawUrl);

        const db = openMigratedLocalD1();
        try {
            await db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'rem_u1', 'hash')").run();
            await upsertQrcode(db, 1, 'qr-rem-1');
            await markBound(db, 1, {
                baseurl: rt.fakeExtOrigin,
                token: 'fake-bot-token',
                botId: 'fake-bot-1',
                userId: 'wx-rem-1',
            });
            const env = { DB: db };
            const fakeIlinkFetch = (url, init) => fetch(String(url).replace('https://ilinkai.weixin.qq.com', rt.fakeExtOrigin), init);

            // 1. 验证慢任务与普通任务的追问间隔差异
            const normalGap = followUpMsForText('吃维C');
            const slowGap = followUpMsForText('读完这本书并写一篇深度复盘长文章');
            expect(slowGap).toBeGreaterThanOrEqual(normalGap);

            // 2. 创建并取消提醒（fireAtMs 需满足未来 1 分钟以上约束）
            const now = Date.now();
            const rCancel = await createReminderAt(db, 1, '要被取消的提醒', now + 5 * 60_000, now, normalGap);
            expect(rCancel.ok).toBe(true);
            await cancelReminder(db, 1, '要被取消的提醒', now);
            const rowCancel = await db.prepare('SELECT status FROM bot_reminders WHERE id = ?1').bind(rCancel.id).first();
            expect(rowCancel.status).toBe('cancelled');

            // 3. 创建提醒 -> 到时触发 -> 追问 -> 完成
            await setExternalFaultMode({ ilinkSendFail: false, clearRequests: true });
            const r1 = await createReminderAt(db, 1, '提交周报', now + 120_000, now, 5000);
            expect(r1.ok).toBe(true);
            const tick1 = await runReminderChecks(env, db, fakeIlinkFetch, { nowMs: now + 120_200 });
            expect(tick1.due).toBeGreaterThanOrEqual(1);

            const rowFired = await db.prepare('SELECT * FROM bot_reminders WHERE id = ?1').bind(r1.id).first();
            expect(rowFired.status).toBe('fired');

            // 到追问时间点触发追问
            await runReminderChecks(env, db, fakeIlinkFetch, { nowMs: now + 130_000 });
            const ext1 = await getExternalControlState();
            expect(ext1.ilinkSentMessages.length).toBeGreaterThanOrEqual(1);

            await completeReminder(db, 1, rowFired);
            const rowDone = await db.prepare('SELECT status FROM bot_reminders WHERE id = ?1').bind(r1.id).first();
            expect(rowDone.status).toBe('done');

            // 4. 重试与最大重试次数（注入 sendmessage 500 直到耗尽达到 failed）
            await setExternalFaultMode({ ilinkSendFail: true, clearRequests: true });
            const rFail = await createReminderAt(db, 1, '测试重试上限', now + 120_000, now, 1000);
            expect(rFail.ok).toBe(true);
            let t = now + 120_200;
            await runReminderChecks(env, db, fakeIlinkFetch, { nowMs: t });
            for (let i = 0; i < 6; i++) {
                t += 60 * 60 * 1000;
                await runReminderChecks(env, db, fakeIlinkFetch, { nowMs: t });
            }
            const rowExhausted = await db.prepare('SELECT status, follow_up_status FROM bot_reminders WHERE id = ?1').bind(rFail.id).first();
            expect(['failed', 'missed', 'done']).toContain(
                rowExhausted.follow_up_status === 'failed' ? 'failed' : rowExhausted.status
            );
        } finally {
            db.close();
        }
    });
});
