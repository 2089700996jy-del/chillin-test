import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CHILLIN_ROOT } from '../../src/env/ports.mjs';
import { openMigratedLocalD1 } from '../../src/support/local-d1.mjs';
import { startL2FakeExternals } from '../../src/support/l2-harness.mjs';

const botClawUrl = pathToFileURL(path.join(CHILLIN_ROOT, 'workers/src/bot-claw.js')).href;

test('L2 ClawBot 协议仿真：消息去重、连续消息处理、并发互斥、游标推进与回信失败恢复', async () => {
    const fakeExt = await startL2FakeExternals();
    const db = openMigratedLocalD1();

    try {
        const {
            upsertQrcode,
            markBound,
            readAccount,
            pollClawAccounts,
            drainClawInbox,
            enqueueClawMessage,
        } = await import(botClawUrl);

        await db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'claw_u1', 'hash')").run();
        await upsertQrcode(db, 1, 'qr-fake-1');
        await markBound(db, 1, {
            baseurl: fakeExt.origin,
            botToken: 'fake-bot-token',
            ilinkBotId: 'fake-bot-1',
            ilinkUserId: 'wx-user-1',
        });

        const boundAtMs = Date.now() - 10_000;
        await db.prepare('UPDATE bot_claw_accounts SET bound_at_ms = ?1 WHERE user_id = 1').bind(boundAtMs).run();

        const env = { DB: db, LLM_API_BASE: `${fakeExt.origin}/v1`, LLM_API_KEY: 'e2e-fake-key' };
        const fakeIlinkFetch = (url, init) => fetch(String(url).replace('https://ilinkai.weixin.qq.com', fakeExt.origin), init);

        // 1. 连续消息 + 重复消息去重 + 游标推进
        await fakeExt.setFaultMode({
            clearRequests: true,
            ilinkSendFail: false,
            ilinkGetUpdatesFail: false,
            pushClawUpdates: [
                {
                    message_id: 'msg-dup-1',
                    message_type: 1,
                    from_user_id: 'wx-user-1',
                    create_time_ms: Date.now(),
                    context_token: 'ctx-1',
                    item_list: [{ type: 1, text_item: { text: '记录：第一条协议仿真随手记' } }],
                },
                {
                    message_id: 'msg-dup-1',
                    message_type: 1,
                    from_user_id: 'wx-user-1',
                    create_time_ms: Date.now(),
                    context_token: 'ctx-1',
                    item_list: [{ type: 1, text_item: { text: '记录：第一条协议仿真随手记' } }],
                },
                {
                    message_id: 'msg-seq-2',
                    message_type: 1,
                    from_user_id: 'wx-user-1',
                    create_time_ms: Date.now() + 100,
                    context_token: 'ctx-2',
                    item_list: [{ type: 1, text_item: { text: '记录：第二条连续消息' } }],
                },
            ],
        });

        await pollClawAccounts(env, db, fakeIlinkFetch, { budgetMs: 300 });

        const accAfterPoll = await readAccount(db, 1);
        assert.ok(accAfterPoll.cursor, '游标应推进');

        const feeds = (await db.prepare('SELECT content FROM quick_feeds WHERE user_id = 1 AND is_deleted = 0').all()).results;
        assert.equal(feeds.length, 2, '重复 message_id 未去重或连续消息未全部入库');

        const extAfterPoll = await fakeExt.getControlState();
        assert.equal(extAfterPoll.ilinkSentMessages.length, 2);

        // 2. 后台并发 drainClawInbox：同一条入站消息同时触发两次 drain 只消费一次
        const rowBeforeDrain = await readAccount(db, 1);
        const concurrentMsg = {
            message_id: 'msg-concurrent-3',
            message_type: 1,
            from_user_id: 'wx-user-1',
            create_time_ms: Date.now() + 200,
            context_token: 'ctx-3',
            item_list: [{ type: 1, text_item: { text: '记录：并发消费验证' } }],
        };
        await enqueueClawMessage(db, rowBeforeDrain.id, 1, 'msg-concurrent-3', concurrentMsg);
        await Promise.all([
            drainClawInbox(env, db, rowBeforeDrain, 1, fakeIlinkFetch),
            drainClawInbox(env, db, rowBeforeDrain, 1, fakeIlinkFetch),
        ]);
        const concurrentFeeds = (await db.prepare("SELECT id FROM quick_feeds WHERE user_id = 1 AND content LIKE '%并发消费验证%'").all()).results;
        assert.equal(concurrentFeeds.length, 1);

        // 3. 回信失败与后续恢复：注入 sendmessage 500 失败
        await fakeExt.setFaultMode({
            ilinkSendFail: true,
            pushClawUpdates: [
                {
                    message_id: 'msg-fail-reply-4',
                    message_type: 1,
                    from_user_id: 'wx-user-1',
                    create_time_ms: Date.now() + 300,
                    context_token: 'ctx-4',
                    item_list: [{ type: 1, text_item: { text: '记录：回信失败容错测试' } }],
                },
            ],
        });
        const bgTasks = [];
        await pollClawAccounts(env, db, fakeIlinkFetch, { budgetMs: 300, defer: (p) => bgTasks.push(p) });
        await Promise.all(bgTasks);
        const inboxRow = await db.prepare("SELECT status, attempts, last_error, dedup_key FROM bot_claw_inbox WHERE dedup_key LIKE '%msg-fail-reply-4%' ORDER BY id DESC LIMIT 1").first();
        assert.ok(inboxRow, '入站消息应记录在 bot_claw_inbox');
        assert.equal(inboxRow.status, 'pending', '首次回信 500 失败后应保持 pending 等待退避重试');
        assert.equal(inboxRow.attempts, 1, '首次回信失败 attempts 应严格为 1');
        assert.match(String(inboxRow.last_error || ''), /500/, 'last_error 应记录 500 失败原因');
        const failSideEffects = (await db.prepare("SELECT id FROM quick_feeds WHERE user_id = 1 AND content LIKE '%回信失败容错测试%'").all()).results;
        assert.equal(failSideEffects.length, 1, '业务副作用应只持久化 1 条');

        // 恢复 Fake iLink 正常状态后再次 poll，验证账号不死锁且能继续处理新消息，且不产生重复副作用
        await fakeExt.setFaultMode({
            ilinkSendFail: false,
            clearRequests: true,
            pushClawUpdates: [
                {
                    message_id: 'msg-recover-5',
                    message_type: 1,
                    from_user_id: 'wx-user-1',
                    create_time_ms: Date.now() + 400,
                    context_token: 'ctx-5',
                    item_list: [{ type: 1, text_item: { text: '记录：故障恢复后新消息' } }],
                },
            ],
        });
        await pollClawAccounts(env, db, fakeIlinkFetch, { budgetMs: 300 });
        const recovered = (await db.prepare("SELECT id FROM quick_feeds WHERE user_id = 1 AND content LIKE '%故障恢复后新消息%'").all()).results;
        assert.equal(recovered.length, 1, '故障恢复后新消息应严格入库 1 条');
        const failSideEffectsAfter = (await db.prepare("SELECT id FROM quick_feeds WHERE user_id = 1 AND content LIKE '%回信失败容错测试%'").all()).results;
        assert.equal(failSideEffectsAfter.length, 1, '恢复后不得重复写入失败消息的业务副作用');
    } finally {
        db.close();
        await fakeExt.close();
    }
});

