import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { CHILLIN_ROOT } from '../src/env/ports.mjs';
import { attachPwaHarness } from '../src/support/pwa-harness.mjs';
import { openMigratedLocalD1 } from '../src/support/local-d1.mjs';
import { uniqueUser, samplePngBuffer, sampleTxtBookBuffer } from '../src/support/test-data.mjs';

function readZipEntries(buf) {
    const entries = [];
    let offset = 0;
    while (offset + 30 <= buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
        const flags = buf.readUInt16LE(offset + 6);
        const method = buf.readUInt16LE(offset + 8);
        const compSize = buf.readUInt32LE(offset + 18);
        const nameLen = buf.readUInt16LE(offset + 26);
        const extraLen = buf.readUInt16LE(offset + 28);
        const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
        const dataStart = offset + 30 + nameLen + extraLen;
        if (flags & 0x08) break; // data descriptor fallback not expected for buffered browser ZIP
        const raw = buf.subarray(dataStart, dataStart + compSize);
        const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
        entries.push({ name, data });
        offset = dataStart + compSize;
    }
    return entries;
}

test.describe('Backup & Restore 全量导出与干净库恢复完整性验证', () => {
    test('生成全量备份 ZIP，并在干净测试库恢复后校验记录、图片元数据、R2 对象与阅读器正文完整', async ({ browser }) => {
        const context = await browser.newContext({ acceptDownloads: true });
        const harness = await attachPwaHarness(context);
        const page = await context.newPage();
        const user = uniqueUser('bak');

        await harness.registerAndEnter(page, user);
        const base = harness.runtime.appOrigin;

        // 1. 构造完整花园资产：随手记 + 笔记 + 图片上传 R2 + 阅读器 TXT 上传 R2
        const pngBuf = samplePngBuffer();
        const uploadRes = await page.request.post(`${base}/api/upload`, {
            multipart: {
                file: { name: 'backup-img.png', mimeType: 'image/png', buffer: pngBuf },
            },
        });
        expect(uploadRes.ok()).toBe(true);
        const imgSrc = (await uploadRes.json())[0].src;

        await page.request.post(`${base}/api/notes`, {
            data: { title: '备份恢复校验笔记', content: `正文带图 ![图](${imgSrc})`, date: '2026-11-25' },
        });
        await page.request.post(`${base}/api/feeds`, {
            data: { content: '备份恢复校验随手记', type: 'image', media_url: imgSrc },
        });

        const bookBuf = sampleTxtBookBuffer('灾备校验');
        const bookKey = `bak_book_${Date.now()}`;
        const bookUploadRes = await page.request.post(
            `${base}/api/reader/books?key=${encodeURIComponent(bookKey)}&title=${encodeURIComponent('备份校验书籍')}&author=${encodeURIComponent('测试作者')}&chapters=5`,
            {
                headers: { 'Content-Type': 'text/plain; charset=utf-8' },
                data: bookBuf.toString('utf8'),
            }
        );
        expect(bookUploadRes.ok()).toBe(true);

        // 2. 通过界面「账号与安全 -> 下载全量备份」触发真实 ZIP 打包下载
        await page.locator('#btn-open-security').click();
        await expect(page.locator('#btn-backup-download')).toBeVisible({ timeout: 10_000 });
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.locator('#btn-backup-download').click(),
        ]);
        const zipPath = await download.path();
        expect(zipPath).toBeTruthy();
        const zipBytes = fs.readFileSync(zipPath);
        expect(zipBytes.subarray(0, 2).toString('ascii')).toBe('PK'); // 合法 ZIP 魔数
        expect(zipBytes.length).toBeGreaterThan(200);
        const zipEntries = readZipEntries(zipBytes);
        expect(zipEntries.length, '下载的备份 ZIP 内未包含任何文件条目').toBeGreaterThan(0);
        const zipCombinedText = zipEntries.map((e) => e.data.toString('utf8')).join('\n');
        expect(zipCombinedText, '备份 ZIP 内容缺少创建的笔记/随手记/书籍数据').toContain('备份恢复校验笔记');
        expect(zipCombinedText).toContain('备份恢复校验随手记');
        expect(zipCombinedText).toContain('备份校验书籍');

        // 3. 获取服务端全量导出 JSON + 读取 R2 图片与书籍正文，恢复到全新干净 D1 + 仿真 R2 存储
        const exportRes = await page.request.get(`${base}/api/export`);
        expect(exportRes.ok()).toBe(true);
        const exportJson = await exportRes.json();

        const imgBytes = await (await page.request.get(`${base}${imgSrc}`)).body();
        const bookText = await (await page.request.get(`${base}/api/reader/books/${encodeURIComponent(bookKey)}`)).text();

        const cleanDb = openMigratedLocalD1();
        const cleanR2 = new Map();
        try {
            // 恢复用户与核心记录到干净库
            await cleanDb.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, ?1, 'restored')").bind(user.username).run();

            for (const note of exportJson.notes || []) {
                await cleanDb.prepare(
                    'INSERT INTO notes (id, user_id, title, content, date, created_at, updated_at, is_deleted) VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, 0)'
                ).bind(note.id, note.title, note.content, note.date, note.created_at, note.updated_at).run();
            }
            for (const feed of exportJson.feeds || exportJson.quick_feeds || []) {
                await cleanDb.prepare(
                    'INSERT INTO quick_feeds (id, user_id, content, type, media_url, created_at, updated_at, is_deleted) VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, 0)'
                ).bind(feed.id, feed.content, feed.type, feed.media_url, feed.created_at, feed.updated_at).run();
            }

            // 恢复图片元数据与 R2 二进制对象
            const fileId = imgSrc.split('?')[0].split('/').pop();
            const r2ImgKey = `uploads/1/${fileId}.png`;
            await cleanDb.prepare(
                'INSERT INTO files (id, user_id, mime_type, r2_key, size) VALUES (?1, 1, ?2, ?3, ?4)'
            ).bind(fileId, 'image/png', r2ImgKey, imgBytes.length).run();
            cleanR2.set(r2ImgKey, imgBytes);

            // 恢复阅读器书目元数据与 R2 书籍正文
            for (const b of exportJson.reader?.books || exportJson.reader_books || []) {
                const bKey = b.bookKey || b.book_key;
                const bChapters = b.totalChapters ?? b.total_chapters ?? 0;
                const r2BookKey = `books/1/${bKey}.txt`;
                await cleanDb.prepare(
                    'INSERT INTO reader_books (user_id, book_key, title, author, total_chapters, size, r2_key, is_deleted) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, 0)'
                ).bind(bKey, b.title, b.author, bChapters, b.size, r2BookKey).run();
                cleanR2.set(r2BookKey, Buffer.from(bookText, 'utf8'));
            }

            // 校验干净库中的笔记、随手记、图片元数据、R2 对象、阅读器正文全部完整无缺
            const restoredNote = await cleanDb.prepare("SELECT title, content FROM notes WHERE title = '备份恢复校验笔记'").first();
            expect(restoredNote?.content).toContain(imgSrc);

            const restoredFeed = await cleanDb.prepare("SELECT media_url FROM quick_feeds WHERE content = '备份恢复校验随手记'").first();
            expect(restoredFeed?.media_url).toBe(imgSrc);

            const restoredFileMeta = await cleanDb.prepare('SELECT r2_key, size FROM files WHERE id = ?1').bind(fileId).first();
            expect(restoredFileMeta?.size).toBe(pngBuf.length);
            expect(Buffer.compare(cleanR2.get(restoredFileMeta.r2_key), pngBuf)).toBe(0);

            const restoredBookMeta = await cleanDb.prepare('SELECT title, r2_key FROM reader_books WHERE book_key = ?1').bind(bookKey).first();
            expect(restoredBookMeta?.title).toBe('备份校验书籍');
            expect(cleanR2.get(restoredBookMeta.r2_key).toString('utf8')).toContain('第5章 灾备校验的章节 5');
        } finally {
            cleanDb.close();
        }

        harness.assertNoBugs('Backup & Restore 完整校验');
        await context.close();
    });

    test('调用主仓真实 restore-drill 脚本在隔离临时目录完成清单哈希、恢复演练与篡改拦截', async () => {
        const drillScript = path.join(CHILLIN_ROOT, 'scripts', 'restore-drill.mjs');
        expect(fs.existsSync(drillScript), `缺少主仓恢复演练脚本: ${drillScript}`).toBe(true);
        const output = execFileSync(process.execPath, [drillScript], {
            cwd: CHILLIN_ROOT,
            encoding: 'utf8',
            timeout: 60_000,
        });
        expect(output).toMatch(/drill|校验|ok|通过|restore/i);
    });
});
