import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect } from '@playwright/test';
import { CHILLIN_ROOT } from '../src/env/ports.mjs';
import { openMigratedLocalD1 } from '../src/support/local-d1.mjs';
import { setExternalFaultMode, getExternalControlState } from '../src/support/pwa-harness.mjs';
import { readRuntime } from '../src/env/ports.mjs';

const botClawUrl = pathToFileURL(path.join(CHILLIN_ROOT, 'workers/src/bot-claw.js')).href;

/**
 * ClawBot 协议仿真测试：
 * 注意：因主仓 bot-claw.js 硬编码了 ILINK_DEFAULT_BASE，本套件通过注入 fetchImpl
 * 指向本地 Fake iLink HTTP 服务进行协议仿真（去重、并发、游标推进、失败恢复与回信失败），
 * 不等同于真实微信客户端验收。
 */
test.describe('ClawBot 协议仿真（本地 Fake iLink + 真实 D1 migrations）', () => {
    test.afterEach(async () => {
        await setExternalFaultMode({
            ilinkSendFail: false,
            ilinkGetUpdatesFail: false,
            ilinkUpdatesQueue: [],
            clearRequests: true,
        }).catch(() => {});
    });

    test('消息去重、连续消息处理、后台并发互斥、游标推进与回信失败恢复', async () => {
        const rt = readRuntime();
        const {
            upsertQrcode,
            markBound,
            readAccount,
            pollClawAccounts,
            drainClawInbox,
            enqueueClawMessage,
        } = await import(botClawUrl);

        const db = openMigratedLocalD1();
        try {
            await db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'claw_u1', 'hash')").run();
            await upsertQrcode(db, 1, 'qr-fake-1');
            await markBound(db, 1, {
                baseurl: rt.fakeExtOrigin,
                botToken: 'fake-bot-token',
                ilinkBotId: 'fake-bot-1',
                ilinkUserId: 'wx-user-1',
            });

            const boundAtMs = Date.now() - 10_000;
            await db.prepare('UPDATE bot_claw_accounts SET bound_at_ms = ?1 WHERE user_id = 1').bind(boundAtMs).run();

            const env = { DB: db, LLM_API_BASE: `${rt.fakeExtOrigin}/v1`, LLM_API_KEY: 'e2e-fake-key' };
            const fakeIlinkFetch = (url, init) => fetch(String(url).replace('https://ilinkai.weixin.qq.com', rt.fakeExtOrigin), init);

            // 1. 连续消息 + 重复消息去重 + 游标推进
            await setExternalFaultMode({
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
                        message_id: 'msg-dup-1', // 重复 message_id 必须去重
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
            expect(accAfterPoll.cursor).toBeTruthy(); // 游标推进

            const feeds = (await db.prepare('SELECT content FROM quick_feeds WHERE user_id = 1 AND is_deleted = 0').all()).results;
            expect(feeds.length, '重复 message_id 未去重或连续消息未全部入库').toBe(2);

            const extAfterPoll = await getExternalControlState();
            expect(extAfterPoll.ilinkSentMessages.length).toBe(2);

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
            expect(concurrentFeeds.length).toBe(1);

            // 3. 回信失败与后续恢复：注入 sendmessage 500 失败
            await setExternalFaultMode({
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
            const inboxRow = await db.prepare("SELECT status, attempts, dedup_key FROM bot_claw_inbox WHERE dedup_key LIKE '%msg-fail-reply-4%' ORDER BY id DESC LIMIT 1").first();
            expect(inboxRow).toBeTruthy();
            expect(['failed', 'pending', 'done']).toContain(inboxRow.status);

            // 恢复 Fake iLink 正常状态后再次 poll，验证账号不死锁且能继续处理新消息
            await setExternalFaultMode({
                ilinkSendFail: false,
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
            const recovered = await db.prepare("SELECT id FROM quick_feeds WHERE user_id = 1 AND content LIKE '%故障恢复后新消息%'").first();
            expect(recovered).toBeTruthy();
        } finally {
            db.close();
        }
    });
});
