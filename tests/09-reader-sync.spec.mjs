import { test, expect } from '@playwright/test';
import { attachPwaHarness } from '../src/support/pwa-harness.mjs';
import { uniqueUser, sampleTxtBookBuffer } from '../src/support/test-data.mjs';

test.describe('Reader 云端书库、跨端进度、软删除墓碑、显式重导与并发竞争', () => {
    test('跨设备上传下载、进度同步、软删墓碑同步、显式重导与并发删传', async ({ browser }) => {
        const user = uniqueUser('reader');
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const harnessA = await attachPwaHarness(ctxA);
        const harnessB = await attachPwaHarness(ctxB);
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        await harnessA.registerAndEnter(pageA, user);
        const base = harnessA.runtime.appOrigin;

        // 1. 设备 A 导入书籍，校验书目与 R2 正文入云
        await pageA.locator('.mobile-tab-item[data-view="reader"]').click();
        await Promise.all([
            pageA.waitForResponse((r) => r.url().includes('/api/reader/books') && r.request().method() === 'POST' && r.ok()),
            pageA.locator('#book-file-input').setInputFiles({
                name: '云端同步小说.txt',
                mimeType: 'text/plain',
                buffer: sampleTxtBookBuffer('云端小说'),
            }),
        ]);

        const listResA = await pageA.request.get(`${base}/api/reader/books`);
        const booksA = (await listResA.json()).books || await listResA.json();
        const cloudBook = booksA.find((b) => String(b.title).includes('云端同步小说'));
        expect(cloudBook).toBeTruthy();
        const bookKey = cloudBook.book_key;

        // 2. 设备 B 登录进入阅读视图，能看到云端书库卡片并点击下载阅读
        await harnessB.loginAndEnter(pageB, user);
        await pageB.locator('.mobile-tab-item[data-view="reader"]').click();
        const cloudCardB = pageB.locator('#bookshelf-grid .book-card', { hasText: '云端同步小说' });
        await expect(cloudCardB).toBeVisible({ timeout: 15_000 });

        await Promise.all([
            pageB.waitForResponse((r) => r.url().includes(`/api/reader/books/${encodeURIComponent(bookKey)}`) && r.ok()),
            cloudCardB.click(),
        ]);
        await expect(pageB.locator('#view-reader-book')).toHaveClass(/active/, { timeout: 10_000 });

        // 设备 B 翻到第 3 章并校验进度写入服务端
        await pageB.locator('#btn-next-chapter').click();
        await expect(pageB.locator('#chapter-indicator')).toContainText('2 / 5');
        await Promise.all([
            pageB.waitForResponse((r) => r.url().includes('/api/reader/progress') && r.ok()),
            pageB.locator('#btn-next-chapter').click(),
        ]);
        await expect(pageB.locator('#chapter-indicator')).toContainText('3 / 5');

        // 校验设备 A 查询阅读进度已同步到第 3 章，并在设备 A 打开书籍确认 UI 恢复到 3 / 5
        const progResA = await pageA.request.get(`${base}/api/reader/progress`);
        expect(progResA.ok()).toBe(true);
        const progListA = await progResA.json();
        const matchedProg = progListA.find((p) => String(p.book_key || p.book_id || p.bookId || '') === String(bookKey) || String(p.title || p.book_title || '').includes('云端同步小说'));
        expect(matchedProg).toBeTruthy();
        const syncedChapter = Number(matchedProg.chapter_index ?? matchedProg.chapterIndex ?? matchedProg.chapter ?? 0);
        expect(syncedChapter).toBe(2); // 0-based index 2 = 第 3 章

        await pageA.reload({ waitUntil: 'load' });
        await pageA.locator('.mobile-tab-item[data-view="reader"]').click();
        const cloudCardA = pageA.locator('#bookshelf-grid .book-card', { hasText: '云端同步小说' });
        await expect(cloudCardA).toBeVisible({ timeout: 15_000 });
        await cloudCardA.click();
        await expect(pageA.locator('#view-reader-book')).toHaveClass(/active/, { timeout: 10_000 });
        await expect(pageA.locator('#chapter-indicator')).toContainText('3 / 5', { timeout: 10_000 });

        // 旧数据与重复同步保护：发送更早 client_ts 的旧进度 (第 1 章)，不应覆盖已同步的第 3 章进度
        const staleRes = await pageB.request.post(`${base}/api/reader/progress`, {
            data: {
                book_key: bookKey,
                book_title: '云端同步小说',
                chapter_index: 0,
                chapter_title: '第1章',
                scroll_percentage: 0,
                client_ts: 1000,
            },
        });
        expect(staleRes.status()).toBeLessThan(500);
        const progAfterStale = await (await pageA.request.get(`${base}/api/reader/progress`)).json();
        const latestRow = progAfterStale.find((p) => String(p.book_key || p.book_id || p.bookId || '') === String(bookKey));
        expect(Number(latestRow?.chapter_index ?? latestRow?.chapterIndex ?? latestRow?.chapter ?? -1)).toBe(2);

        // 3. 软删除与墓碑同步：设备 A 删除书籍 -> 校验常规列表消失且 include_deleted=1 暴露墓碑
        const delRes = await pageA.request.delete(`${base}/api/reader/books/${encodeURIComponent(bookKey)}`);
        expect(delRes.ok()).toBe(true);

        const listAfterDel = await (await pageA.request.get(`${base}/api/reader/books`)).json();
        const arrAfterDel = Array.isArray(listAfterDel) ? listAfterDel : (listAfterDel.books || []);
        expect(arrAfterDel.some((b) => b.book_key === bookKey)).toBe(false);

        const tombRes = await pageA.request.get(`${base}/api/reader/books?include_deleted=1`);
        const tombJson = await tombRes.json();
        const tombList = Array.isArray(tombJson) ? tombJson : (tombJson.books || []);
        const tombRow = tombList.find((b) => b.book_key === bookKey);
        expect(Boolean(tombRow?.is_deleted)).toBe(true);

        const bookBodyText = sampleTxtBookBuffer('云端小说').toString('utf8');
        // 普通无 force=1 上传不应复活已删除书籍（返回 409）
        const silentReupload = await pageA.request.post(
            `${base}/api/reader/books?key=${encodeURIComponent(bookKey)}&title=${encodeURIComponent('云端同步小说')}&author=${encodeURIComponent('未知作者')}&chapters=5`,
            { headers: { 'Content-Type': 'text/plain; charset=utf-8' }, data: bookBodyText }
        );
        expect(silentReupload.status()).toBe(409);

        // 4. 显式重新导入（force=1）应成功复活书籍
        const forceReupload = await pageA.request.post(
            `${base}/api/reader/books?key=${encodeURIComponent(bookKey)}&title=${encodeURIComponent('云端同步小说')}&author=${encodeURIComponent('未知作者')}&chapters=5&force=1`,
            { headers: { 'Content-Type': 'text/plain; charset=utf-8' }, data: bookBodyText }
        );
        expect(forceReupload.ok()).toBe(true);
        const listAfterReimportJson = await (await pageA.request.get(`${base}/api/reader/books`)).json();
        const arrAfterReimport = Array.isArray(listAfterReimportJson) ? listAfterReimportJson : (listAfterReimportJson.books || []);
        expect(arrAfterReimport.some((b) => b.book_key === bookKey)).toBe(true);

        // 5. 并发删除与上传：不应产生 500 内部错误
        const [concDel, concPut] = await Promise.all([
            pageA.request.delete(`${base}/api/reader/books/${encodeURIComponent(bookKey)}`),
            pageA.request.post(
                `${base}/api/reader/books?key=${encodeURIComponent(bookKey)}&title=${encodeURIComponent('云端同步小说')}&author=${encodeURIComponent('未知作者')}&chapters=5&force=1`,
                { headers: { 'Content-Type': 'text/plain; charset=utf-8' }, data: bookBodyText }
            ),
        ]);
        expect(concDel.status()).toBeLessThan(500);
        expect(concPut.status()).toBeLessThan(500);

        harnessA.assertNoBugs('Reader 跨端设备 A');
        harnessB.assertNoBugs('Reader 跨端设备 B');
        await ctxA.close();
        await ctxB.close();
    });
});
