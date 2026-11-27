import { test, expect } from '@playwright/test';
import {
    attachPwaHarness,
    setExternalFaultMode,
    getExternalControlState,
} from '../src/support/pwa-harness.mjs';
import { uniqueUser, samplePngBuffer, sampleTxtBookBuffer } from '../src/support/test-data.mjs';

test.describe('RAG 多资源召回与跨账号权限隔离测试 @core', () => {
    test.afterEach(async () => {
        await setExternalFaultMode({ mode: 'ok', delayMs: 0, clearRequests: true }).catch(() => { });
    });

    test('Account Isolation：两个账号所有数据接口、文件与阅读器资源严格不可跨账号访问或覆盖', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const harnessA = await attachPwaHarness(ctxA);
        const harnessB = await attachPwaHarness(ctxB);
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        const userA = uniqueUser('isoA');
        const userB = uniqueUser('isoB');
        await harnessA.registerAndEnter(pageA, userA);
        await harnessB.registerAndEnter(pageB, userB);

        const base = harnessA.runtime.appOrigin;

        // 账号 A 创建全套私有资源
        const noteRes = await pageA.request.post(`${base}/api/notes`, {
            data: { title: 'A的私密笔记', content: 'A_SECRET_NOTE', date: '2026-11-25' },
        });
        expect(noteRes.ok(), `POST /api/notes failed: ${noteRes.status()}`).toBe(true);
        const noteA = await noteRes.json();

        const feedRes = await pageA.request.post(`${base}/api/feeds`, {
            data: { content: 'A的私密随手记 A_SECRET_FEED', type: 'text' },
        });
        expect(feedRes.ok(), `POST /api/feeds failed: ${feedRes.status()}`).toBe(true);
        const feedA = await feedRes.json();

        const weeklyRes = await pageA.request.post(`${base}/api/weeklies`, {
            data: { title: 'A的周记', summary: 'A_SECRET_WEEKLY', date: '2026-11-25', content: '周记正文' },
        });
        expect(weeklyRes.ok(), `POST /api/weeklies failed: ${weeklyRes.status()}`).toBe(true);
        const weeklyA = await weeklyRes.json();

        const bmRes = await pageA.request.post(`${base}/api/bookmarks`, {
            data: { type: '🌐 网站', title: 'A的书签', url: 'https://example.com/a', description: 'A_SECRET_BM' },
        });
        expect(bmRes.ok(), `POST /api/bookmarks failed: ${bmRes.status()}`).toBe(true);
        const bmA = await bmRes.json();

        const promptRes = await pageA.request.post(`${base}/api/prompts`, {
            data: { title: 'A的提示词', project: '私有', scene: '开发', content: 'A_SECRET_PROMPT' },
        });
        expect(promptRes.ok(), `POST /api/prompts failed: ${promptRes.status()}`).toBe(true);
        const promptA = await promptRes.json();

        // 账号 A 上传私有图片到 R2
        const uploadRes = await pageA.request.post(`${base}/api/upload`, {
            multipart: {
                file: {
                    name: 'secret-a.png',
                    mimeType: 'image/png',
                    buffer: samplePngBuffer(),
                },
            },
        });
        expect(uploadRes.ok(), `POST /api/upload failed: ${uploadRes.status()}`).toBe(true);
        const uploadedA = (await uploadRes.json())[0];

        // 账号 A 上传私有书籍到 R2
        const bookKeyA = `book_iso_${Date.now()}`;
        const bookRes = await pageA.request.post(
            `${base}/api/reader/books?key=${encodeURIComponent(bookKeyA)}&title=${encodeURIComponent('A的私密书籍')}&author=A&chapters=5`,
            {
                headers: { 'Content-Type': 'text/plain; charset=utf-8' },
                data: sampleTxtBookBuffer('A私密').toString('utf8'),
            }
        );
        expect(bookRes.ok(), `POST /api/reader/books failed: ${bookRes.status()}`).toBe(true);

        // 账号 A 创建 Agent 目标
        const goalRes = await pageA.request.post(`${base}/api/agent/goals`, {
            data: { title: 'A的私密目标', description: '不可泄露给B' },
        });
        expect(goalRes.ok(), `POST /api/agent/goals failed: ${goalRes.status()}`).toBe(true);
        const goalA = (await goalRes.json()).goal || await goalRes.json();

        // ── 账号 B 尝试越权读取、篡改、删除或覆盖账号 A 的全部资源 ──
        for (const listPath of ['/api/notes', '/api/feeds', '/api/weeklies', '/api/bookmarks', '/api/prompts', '/api/agent/goals']) {
            const r = await pageB.request.get(`${base}${listPath}`);
            expect(r.ok()).toBe(true);
            const raw = await r.text();
            expect(raw, `账号 B 列表接口 ${listPath} 泄露了账号 A 数据`).not.toContain('A的私密');
            expect(raw).not.toContain('A_SECRET_');
        }

        const forbiddenOps = [
            ['PUT', `/api/notes/${noteA.id}`, { title: '越权改', content: 'hack' }],
            ['DELETE', `/api/notes/${noteA.id}`],
            ['POST', '/api/notes', { id: noteA.id, title: 'ID覆盖劫持', content: 'hijack' }],
            ['PUT', `/api/feeds/${feedA.id}`, { content: 'hack' }],
            ['DELETE', `/api/feeds/${feedA.id}`],
            ['PUT', `/api/weeklies/${weeklyA.id}`, { title: 'hack' }],
            ['DELETE', `/api/weeklies/${weeklyA.id}`],
            ['PUT', `/api/bookmarks/${bmA.id}`, { title: 'hack' }],
            ['DELETE', `/api/bookmarks/${bmA.id}`],
            ['PUT', `/api/prompts/${promptA.id}`, { title: 'hack' }],
            ['DELETE', `/api/prompts/${promptA.id}`],
            ['GET', `/api/reader/books/${encodeURIComponent(bookKeyA)}`],
            ['DELETE', `/api/reader/books/${encodeURIComponent(bookKeyA)}`],
            ['GET', `/api/agent/goals/${goalA.id}`],
            ['DELETE', `/api/agent/goals/${goalA.id}`],
            ['POST', `/api/agent/goals/${goalA.id}/run`],
            ['POST', `/api/agent/goals/${goalA.id}/pause`],
            ['POST', `/api/agent/goals/${goalA.id}/cancel`],
        ];

        for (const [method, endpoint, data] of forbiddenOps) {
            const resp = await pageB.request.fetch(`${base}${endpoint}`, {
                method,
                ...(data ? { data } : {}),
            });
            expect(
                [403, 404, 409].includes(resp.status()),
                `越权操作 ${method} ${endpoint} 未被拦截，返回 HTTP ${resp.status()}`
            ).toBe(true);
        }

        // 账号 B 用相同 bookKey + force=1 上传，绝不能覆盖账号 A 的同名书籍正文
        const sameKeyUploadB = await pageB.request.post(
            `${base}/api/reader/books?key=${encodeURIComponent(bookKeyA)}&title=hijack&author=B&chapters=1&force=1`,
            { headers: { 'Content-Type': 'text/plain; charset=utf-8' }, data: '越权书籍正文' }
        );
        expect(sameKeyUploadB.status()).toBeLessThan(500);
        const bookAAfterUploadB = await pageA.request.get(`${base}/api/reader/books/${encodeURIComponent(bookKeyA)}`);
        expect(bookAAfterUploadB.ok()).toBe(true);
        expect(await bookAAfterUploadB.text()).toContain('第5章 A私密的章节 5');

        // 账号 B 通过 /api/sync/batch 携带账号 A 的资源 ID 尝试批量劫持覆盖与批量软删除，绝不能修改或删除账号 A 数据
        const batchHijackRes = await pageB.request.post(`${base}/api/sync/batch`, {
            data: {
                notes: [{ id: noteA.id, title: '越权批量覆盖', content: 'hijack', date: '2026-11-26' }],
                feeds: [{ id: feedA.id, content: '越权批量覆盖随手记' }],
                weeklies: [{ id: weeklyA.id, title: '越权批量覆盖周记', summary: 'hijack', content: 'hijack', date: '2026-11-26' }],
                deleted: [
                    { resource: 'notes', id: noteA.id },
                    { resource: 'feeds', id: feedA.id },
                    { resource: 'weeklies', id: weeklyA.id },
                ],
            },
        });
        expect(batchHijackRes.status()).toBeLessThan(500);
        const batchBody = await batchHijackRes.json().catch(() => ({}));
        const updatedIds = (batchBody.updated || []).map((u) => String(u.id));
        expect(updatedIds, 'sync/batch 返回的 updated 不得包含账号 A 的任何资源 ID').not.toContain(String(noteA.id));
        expect(updatedIds).not.toContain(String(feedA.id));
        expect(updatedIds).not.toContain(String(weeklyA.id));

        // 分别重新读取账号 A 的笔记、随手记、周记，验证无部分成功导致的数据破坏或软删除
        const [notesAAfter, feedsAAfter, weekliesAAfter] = await Promise.all([
            (await pageA.request.get(`${base}/api/notes`)).json(),
            (await pageA.request.get(`${base}/api/feeds`)).json(),
            (await pageA.request.get(`${base}/api/weeklies`)).json(),
        ]);
        const noteACheck = notesAAfter.find((n) => String(n.id) === String(noteA.id));
        expect(noteACheck, '账号 A 笔记不得被批量删除').toBeTruthy();
        expect(Boolean(noteACheck?.is_deleted)).toBe(false);
        expect(noteACheck?.title).toBe('A的私密笔记');
        expect(noteACheck?.content).toContain('A_SECRET_NOTE');

        const feedACheck = feedsAAfter.find((f) => String(f.id) === String(feedA.id));
        expect(feedACheck, '账号 A 随手记不得被批量删除').toBeTruthy();
        expect(Boolean(feedACheck?.is_deleted)).toBe(false);
        expect(feedACheck?.content).toContain('A的私密随手记');

        const weeklyACheck = weekliesAAfter.find((w) => String(w.id) === String(weeklyA.id));
        expect(weeklyACheck, '账号 A 周记不得被批量删除').toBeTruthy();
        expect(Boolean(weeklyACheck?.is_deleted)).toBe(false);
        expect(weeklyACheck?.title).toBe('A的周记');

        // 账号 B 访问账号 A 的私有图片文件（无 token 与带 B 会话访问原签名 URL）均不得泄露
        const bareFileUrl = uploadedA.src.split('?')[0];
        const fileNoToken = await pageB.request.get(`${base}${bareFileUrl}`);
        expect([401, 403, 404]).toContain(fileNoToken.status());

        harnessA.assertNoBugs('Account Isolation 账号 A');
        harnessB.assertNoBugs('Account Isolation 账号 B');
        await ctxA.close();
        await ctxB.close();
    });

    test('RAG 多资源召回（笔记/随手记/周记）、跨用户隔离、无结果与证据追踪', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const harnessA = await attachPwaHarness(ctxA);
        const harnessB = await attachPwaHarness(ctxB);
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        await harnessA.registerAndEnter(pageA, uniqueUser('ragA'));
        await harnessB.registerAndEnter(pageB, uniqueUser('ragB'));
        const base = harnessA.runtime.appOrigin;

        // 账号 A 在不同资源写入关键词「星云协议」
        await pageA.request.post(`${base}/api/notes`, {
            data: { title: '星云协议笔记', content: '星云协议_NOTE_EVIDENCE 核心设计文档', date: '2026-11-25' },
        });
        await pageA.request.post(`${base}/api/feeds`, {
            data: { content: '今天思考了 星云协议_FEED_EVIDENCE 的边缘缓存策略', type: 'text' },
        });
        await pageA.request.post(`${base}/api/weeklies`, {
            data: { title: 'W48 周记', summary: '星云协议_WEEKLY_EVIDENCE 总结', date: '2026-11-25', content: '星云协议周记内容' },
        });

        // 账号 B 写入同名关键词但含绝密干扰词，检验 RAG 绝不能跨账号召回
        await pageB.request.post(`${base}/api/notes`, {
            data: { title: 'B的星云协议', content: 'B_SECRET_DO_NOT_LEAK 星云协议', date: '2026-11-25' },
        });

        await setExternalFaultMode({ mode: 'ok', delayMs: 0, clearRequests: true });

        // 1. 账号 A 查询「星云协议」，校验多资源证据进入 LLM 上下文且无 B 的数据
        const chatRes = await pageA.request.post(`${base}/api/ai/chat`, {
            data: { question: '梳理一下我关于星云协议的记录' },
        });
        expect(chatRes.ok()).toBe(true);
        const chatBodyText = await chatRes.text();
        expect(chatBodyText).toContain('记忆回响');

        const extState = await getExternalControlState();
        const llmCtx = JSON.stringify(extState.requests.map((r) => r.messages));
        expect(llmCtx).toContain('星云协议_NOTE_EVIDENCE');
        expect(llmCtx).toContain('星云协议_FEED_EVIDENCE');
        expect(llmCtx).toContain('星云协议_WEEKLY_EVIDENCE');
        expect(llmCtx).not.toContain('B_SECRET_DO_NOT_LEAK');

        // 2. 无结果查询：不存在的关键词不返回错误召回，也不应伪造星云协议证据
        await setExternalFaultMode({ mode: 'ok', delayMs: 0, clearRequests: true });
        const emptyRes = await pageA.request.post(`${base}/api/ai/chat`, {
            data: { question: '完全不存在的火星词_ZZZ999' },
        });
        expect(emptyRes.ok()).toBe(true);
        const emptyData = await emptyRes.json();
        const extEmpty = await getExternalControlState();
        const emptyCtx = JSON.stringify(extEmpty.requests.map((r) => r.messages));
        expect(emptyCtx).not.toContain('B_SECRET_DO_NOT_LEAK');
        expect(emptyCtx).not.toContain('星云协议_NOTE_EVIDENCE');
        expect(emptyCtx).not.toContain('星云协议_FEED_EVIDENCE');
        expect(emptyCtx).not.toContain('星云协议_WEEKLY_EVIDENCE');
        expect(JSON.stringify(emptyData)).not.toContain('星云协议_');

        harnessA.assertNoBugs('RAG 测试账号 A');
        harnessB.assertNoBugs('RAG 测试账号 B');
        await ctxA.close();
        await ctxB.close();
    });
});
