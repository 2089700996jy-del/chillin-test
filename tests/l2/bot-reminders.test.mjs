import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CHILLIN_ROOT } from '../../src/env/ports.mjs';
import { openMigratedLocalD1 } from '../../src/support/local-d1.mjs';
import { startL2FakeExternals } from '../../src/support/l2-harness.mjs';

const remindersUrl = pathToFileURL(path.join(CHILLIN_ROOT, 'workers/src/bot-reminders.js')).href;
const clawUrl = pathToFileURL(path.join(CHILLIN_ROOT, 'workers/src/bot-claw.js')).href;
const maintenanceUrl = pathToFileURL(path.join(CHILLIN_ROOT, 'workers/src/maintenance.js')).href;

test('L2 Reminders 协议仿真：创建、到时触发、追问、完成、取消与重试上限', async () => {
    const fakeExt = await startL2FakeExternals();
    const db = openMigratedLocalD1();

    try {
        const {
            createReminderAt,
            cancelReminder,
            completeReminder,
            runReminderChecks,
            followUpMsForText,
        } = await import(remindersUrl);
        const { upsertQrcode, markBound } = await import(clawUrl);

        await db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'rem_u1', 'hash')").run();
        await upsertQrcode(db, 1, 'qr-rem-1');
        await markBound(db, 1, {
            baseurl: fakeExt.origin,
            botToken: 'fake-bot-token',
            ilinkBotId: 'fake-bot-1',
            ilinkUserId: 'wx-rem-1',
        });
        const env = { DB: db };
        const fakeIlinkFetch = (url, init) => fetch(String(url).replace('https://ilinkai.weixin.qq.com', fakeExt.origin), init);

        // 1. 验证慢任务与普通任务的追问间隔差异
        const normalGap = followUpMsForText('吃维C');
        const slowGap = followUpMsForText('读完这本书并写一篇深度复盘长文章');
        assert.ok(slowGap >= normalGap);

        // 2. 创建并取消提醒
        const now = Date.now();
        const rCancel = await createReminderAt(db, 1, '要被取消的提醒', now + 5 * 60_000, now, normalGap);
        assert.equal(rCancel.ok, true);
        await cancelReminder(db, 1, '要被取消的提醒', now);
        const rowCancel = await db.prepare('SELECT status FROM bot_reminders WHERE id = ?1').bind(rCancel.id).first();
        assert.equal(rowCancel.status, 'cancelled');

        // 3. 创建提醒 -> 到时触发 -> 追问 -> 完成
        await fakeExt.setFaultMode({ ilinkSendFail: false, clearRequests: true });
        const r1 = await createReminderAt(db, 1, '提交周报', now + 120_000, now, 5000);
        assert.equal(r1.ok, true);
        const tick1 = await runReminderChecks(env, db, fakeIlinkFetch, { nowMs: now + 120_200 });
        assert.ok(tick1.due >= 1);

        const rowFired = await db.prepare('SELECT * FROM bot_reminders WHERE id = ?1').bind(r1.id).first();
        assert.equal(rowFired.status, 'fired');

        await runReminderChecks(env, db, fakeIlinkFetch, { nowMs: now + 130_000 });
        const ext1 = await fakeExt.getControlState();
        assert.ok(ext1.ilinkSentMessages.length >= 1);

        await completeReminder(db, 1, rowFired);
        const rowDone = await db.prepare('SELECT status FROM bot_reminders WHERE id = ?1').bind(r1.id).first();
        assert.equal(rowDone.status, 'done');

        // 4. 重试与最大重试次数（注入 sendmessage 500 直到耗尽）
        await fakeExt.setFaultMode({ ilinkSendFail: true, clearRequests: true });
        const rFail = await createReminderAt(db, 1, '测试重试上限', now + 120_000, now, 1000);
        assert.equal(rFail.ok, true);
        let t = now + 120_200;
        await runReminderChecks(env, db, fakeIlinkFetch, { nowMs: t });
        for (let i = 0; i < 6; i++) {
            t += 11 * 60 * 1000;
            await runReminderChecks(env, db, fakeIlinkFetch, { nowMs: t });
        }
        const rowExhausted = await db.prepare('SELECT status, follow_up_status, follow_up_attempts FROM bot_reminders WHERE id = ?1').bind(rFail.id).first();
        assert.equal(rowExhausted.status, 'missed', '达到最大重试次数后提醒主状态应严格进入 missed');
        assert.equal(rowExhausted.follow_up_status, 'failed', '达到最大重试上限时 follow_up_status 应严格进入 failed');
        assert.equal(rowExhausted.follow_up_attempts, 5, '重试次数应严格耗尽至 5 次');
        assert.equal((await fakeExt.getControlState()).ilinkSentMessages.length, 0, '注入 500 时不得有成功投递记录');
    } finally {
        db.close();
        await fakeExt.close();
    }
});

test('L2 Reminders 真实 scheduled handler 端到端链路：到期触发、幂等不重发与失败重试', async () => {
    const fakeExt = await startL2FakeExternals();
    const db = openMigratedLocalD1();
    const origFetch = globalThis.fetch;

    try {
        const { createReminderAt } = await import(remindersUrl);
        const { upsertQrcode, markBound } = await import(clawUrl);
        const { runScheduled, CLAW_CRON } = await import(maintenanceUrl);

        globalThis.fetch = (url, init) => {
            const target = String(url).replace('https://ilinkai.weixin.qq.com', fakeExt.origin);
            return origFetch(target, init);
        };

        await db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'rem_sched', 'hash')").run();
        await upsertQrcode(db, 1, 'qr-rem-sched');
        await markBound(db, 1, {
            baseurl: fakeExt.origin,
            botToken: 'fake-bot-token',
            ilinkBotId: 'fake-bot-sched',
            ilinkUserId: 'wx-rem-sched',
        });

        const env = { DB: db };
        const now = Date.now();
        await fakeExt.setFaultMode({ ilinkSendFail: false, clearRequests: true });
        const rem = await createReminderAt(db, 1, '真实Cron到期提醒', now + 120_000, now, 600_000);
        assert.equal(rem.ok, true);

        // 1. 通过真实 runScheduled 执行每分钟 Cron，验证状态变为 fired 且实际投递 1 次
        await runScheduled(env, { cron: CLAW_CRON, scheduledTime: now + 121_000 }, { nowMs: now + 121_000, budgetMs: 0, errorBackoffMs: 1, defer: () => {} });
        const firedRow = await db.prepare('SELECT status, follow_up_status FROM bot_reminders WHERE id = ?1').bind(rem.id).first();
        assert.equal(firedRow.status, 'fired');
        assert.equal((await fakeExt.getControlState()).ilinkSentMessages.length, 1);

        // 2. 追问间隔内重复触发 runScheduled 不得产生重复投递
        await runScheduled(env, { cron: CLAW_CRON, scheduledTime: now + 122_000 }, { nowMs: now + 122_000, budgetMs: 0, errorBackoffMs: 1, defer: () => {} });
        assert.equal((await fakeExt.getControlState()).ilinkSentMessages.length, 1, '追问间隔内重复触发不得重复投递');

        // 3. 注入发送失败，通过真实 runScheduled 触发应记录失败重试而非误标成功
        await fakeExt.setFaultMode({ ilinkSendFail: true, clearRequests: true });
        const remFail = await createReminderAt(db, 1, '真实Cron失败重试', now + 180_000, now, 1000);
        assert.equal(remFail.ok, true);
        await runScheduled(env, { cron: CLAW_CRON, scheduledTime: now + 181_000 }, { nowMs: now + 181_000, budgetMs: 0, errorBackoffMs: 1, defer: () => {} });
        await runScheduled(env, { cron: CLAW_CRON, scheduledTime: now + 185_000 }, { nowMs: now + 185_000, budgetMs: 0, errorBackoffMs: 1, defer: () => {} });
        const retryRow = await db.prepare('SELECT status, follow_up_attempts FROM bot_reminders WHERE id = ?1').bind(remFail.id).first();
        assert.equal(retryRow.status, 'pending');
        assert.ok(retryRow.follow_up_attempts >= 1, '注入发送失败后应记录重试次数');
        assert.equal((await fakeExt.getControlState()).ilinkSentMessages.length, 0);
    } finally {
        globalThis.fetch = origFetch;
        db.close();
        await fakeExt.close();
    }
});

