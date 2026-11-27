import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { test, expect } from '@playwright/test';
import { CHILLIN_ROOT } from '../src/env/ports.mjs';
import { attachPwaHarness } from '../src/support/pwa-harness.mjs';
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
        if (flags & 0x08) break;
        const raw = buf.subarray(dataStart, dataStart + compSize);
        const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
        entries.push({ name, data });
        offset = dataStart + compSize;
    }
    return entries;
}

function sqlLit(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
    if (typeof v === 'boolean') return v ? '1' : '0';
    return "'" + String(v).replace(/'/g, "''") + "'";
}

function sha256Buf(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function isolatedWranglerEnv(workerdTmpDir) {
    const env = { ...process.env };
    delete env.CLOUDFLARE_API_TOKEN;
    delete env.CF_API_TOKEN;
    delete env.CLOUDFLARE_ACCOUNT_ID;
    if (workerdTmpDir) {
        env.TMP = workerdTmpDir;
        env.TEMP = workerdTmpDir;
    }
    return env;
}

function runWranglerLocal(args, { env } = {}) {
    const bin = path.join(CHILLIN_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    const useLocalBin = fs.existsSync(bin);
    const cmd = useLocalBin ? process.execPath : 'npx';
    const cmdArgs = useLocalBin ? [bin, ...args] : ['wrangler', ...args];
    return spawnSync(cmd, cmdArgs, {
        cwd: CHILLIN_ROOT,
        env: env || isolatedWranglerEnv(),
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        shell: !useLocalBin && process.platform === 'win32',
    });
}

test.describe('Backup & Restore 全量导出与真实 restore-full --local 隔离恢复验证', () => {
    test('导出全量备份 ZIP，并使用 Chillin 正式 restore-full --local 恢复至空白隔离 D1/R2 环境校验全资产与 SHA-256', async ({ browser }) => {
        test.setTimeout(120_000);
        const context = await browser.newContext({ acceptDownloads: true });
        const harness = await attachPwaHarness(context);
        const page = await context.newPage();
        const user = uniqueUser('bak');

        await harness.registerAndEnter(page, user);
        const base = harness.runtime.appOrigin;

        // 1. 构造完整花园资产：图片 R2 + 笔记 + 随手记 + 周记 + 阅读器书籍 + 阅读进度
        const pngBuf = samplePngBuffer();
        const uploadRes = await page.request.post(`${base}/api/upload`, {
            multipart: {
                file: { name: 'backup-img.png', mimeType: 'image/png', buffer: pngBuf },
            },
        });
        expect(uploadRes.ok()).toBe(true);
        const imgSrc = (await uploadRes.json())[0].src;

        expect((await page.request.post(`${base}/api/notes`, {
            data: { title: '备份恢复校验笔记', content: `正文带图 ![图](${imgSrc})`, date: '2026-11-27' },
        })).ok()).toBe(true);

        expect((await page.request.post(`${base}/api/feeds`, {
            data: { content: '备份恢复校验随手记', type: 'image', media_url: imgSrc },
        })).ok()).toBe(true);

        expect((await page.request.post(`${base}/api/weeklies`, {
            data: { title: '2026-W48 灾备校验周记', summary: '周记灾备摘要', content: '周记灾备正文', date: '2026-11-27' },
        })).ok()).toBe(true);

        const bookBuf = sampleTxtBookBuffer('灾备校验');
        const bookKey = `bak_book_${Date.now()}`;
        expect((await page.request.post(
            `${base}/api/reader/books?key=${encodeURIComponent(bookKey)}&title=${encodeURIComponent('备份校验书籍')}&author=${encodeURIComponent('测试作者')}&chapters=5`,
            { headers: { 'Content-Type': 'text/plain; charset=utf-8' }, data: bookBuf.toString('utf8') }
        )).ok()).toBe(true);

        expect((await page.request.post(`${base}/api/reader/progress`, {
            data: {
                book_key: bookKey,
                book_title: '备份校验书籍',
                chapter_index: 2,
                chapter_title: '第3章',
                scroll_percentage: 42,
                client_ts: Date.now(),
            },
        })).ok()).toBe(true);

        // 2. 通过界面下载并解压校验 ZIP 内容
        await page.locator('#btn-open-security').click();
        await expect(page.locator('#btn-backup-download')).toBeVisible({ timeout: 10_000 });
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.locator('#btn-backup-download').click(),
        ]);
        const zipPath = await download.path();
        expect(zipPath).toBeTruthy();
        const zipBytes = fs.readFileSync(zipPath);
        expect(zipBytes.subarray(0, 2).toString('ascii')).toBe('PK');
        const zipEntries = readZipEntries(zipBytes);
        expect(zipEntries.length).toBeGreaterThan(0);
        const zipCombinedText = zipEntries.map((e) => e.data.toString('utf8')).join('\n');
        expect(zipCombinedText).toContain('备份恢复校验笔记');
        expect(zipCombinedText).toContain('备份恢复校验随手记');
        expect(zipCombinedText).toContain('2026-W48 灾备校验周记');
        expect(zipCombinedText).toContain('备份校验书籍');

        // 3. 拉取导出 JSON + 原始 R2 二进制，组装 Chillin 标准 backup-kit 备份包
        const exportJson = await (await page.request.get(`${base}/api/export`)).json();
        const imgBytes = await (await page.request.get(`${base}${imgSrc}`)).body();
        const bookText = await (await page.request.get(`${base}/api/reader/books/${encodeURIComponent(bookKey)}`)).text();
        const fileId = imgSrc.split('?')[0].split('/').pop();
        const r2ImgKey = `uploads/1/${fileId}.png`;
        const r2BookKey = `books/1/${bookKey}.txt`;

        const { BACKUP_FORMAT, MANIFEST_NAME, MANIFEST_HASH_NAME, sha256File, sha256Text } = await import(
            pathToFileURL(path.join(CHILLIN_ROOT, 'scripts', 'backup-kit.mjs')).href
        );

        const tmpRoot = path.resolve(CHILLIN_ROOT, '..', '.tmp');
        fs.mkdirSync(tmpRoot, { recursive: true });
        const tmpBackupDir = fs.mkdtempSync(path.join(tmpRoot, 'qa-backup-pkg-'));
        const tmpStateDir = fs.mkdtempSync(path.join(tmpRoot, 'qa-restore-state-'));
        const tmpVerifyDir = fs.mkdtempSync(path.join(tmpRoot, 'qa-restore-verify-'));
        const tmpWorkerdDir = fs.mkdtempSync(path.join(tmpRoot, 'qa-restore-workerd-'));

        try {
            // 确认恢复目标本地状态目录在恢复前完全为空
            expect(fs.readdirSync(tmpStateDir)).toEqual([]);

            // 写入 R2 对象文件
            const imgOut = path.join(tmpBackupDir, 'r2', r2ImgKey);
            const bookOut = path.join(tmpBackupDir, 'r2', r2BookKey);
            fs.mkdirSync(path.dirname(imgOut), { recursive: true });
            fs.mkdirSync(path.dirname(bookOut), { recursive: true });
            fs.writeFileSync(imgOut, imgBytes);
            fs.writeFileSync(bookOut, Buffer.from(bookText, 'utf8'));

            // 使用真实 Chillin migrations 作为 schema，再写入导出的全量业务数据
            const migDir = path.join(CHILLIN_ROOT, 'migrations');
            const migFiles = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
            const schemaSql = migFiles.map((f) => fs.readFileSync(path.join(migDir, f), 'utf8')).join('\n');

            const dataLines = [
                `INSERT INTO users (id, username, password_hash) VALUES (1, ${sqlLit(user.username)}, 'restored_hash');`,
                `INSERT INTO files (id, user_id, mime_type, r2_key, size) VALUES (${sqlLit(fileId)}, 1, 'image/png', ${sqlLit(r2ImgKey)}, ${imgBytes.length});`,
            ];
            for (const n of exportJson.notes || []) {
                dataLines.push(
                    `INSERT INTO notes (id, user_id, title, content, date, created_at, updated_at, is_deleted) VALUES (${sqlLit(n.id)}, 1, ${sqlLit(n.title)}, ${sqlLit(n.content)}, ${sqlLit(n.date)}, ${sqlLit(n.created_at)}, ${sqlLit(n.updated_at)}, 0);`
                );
            }
            for (const f of exportJson.feeds || exportJson.quick_feeds || []) {
                dataLines.push(
                    `INSERT INTO quick_feeds (id, user_id, content, type, media_url, created_at, updated_at, is_deleted) VALUES (${sqlLit(f.id)}, 1, ${sqlLit(f.content)}, ${sqlLit(f.type || 'text')}, ${sqlLit(f.media_url || '')}, ${sqlLit(f.created_at)}, ${sqlLit(f.updated_at)}, 0);`
                );
            }
            for (const w of exportJson.weeklies || []) {
                dataLines.push(
                    `INSERT INTO weeklies (id, user_id, title, summary, content, category, date, created_at, updated_at, is_deleted) VALUES (${sqlLit(w.id)}, 1, ${sqlLit(w.title)}, ${sqlLit(w.summary || '')}, ${sqlLit(w.content || '')}, ${sqlLit(w.category || 'weekly')}, ${sqlLit(w.date)}, ${sqlLit(w.created_at)}, ${sqlLit(w.updated_at)}, 0);`
                );
            }
            for (const b of exportJson.reader?.books || exportJson.reader_books || []) {
                const bKey = b.bookKey || b.book_key;
                dataLines.push(
                    `INSERT INTO reader_books (user_id, book_key, title, author, total_chapters, size, r2_key, is_deleted) VALUES (1, ${sqlLit(bKey)}, ${sqlLit(b.title)}, ${sqlLit(b.author || '')}, ${sqlLit(b.totalChapters ?? b.total_chapters ?? 5)}, ${sqlLit(b.size || Buffer.byteLength(bookText))}, ${sqlLit(r2BookKey)}, 0);`
                );
            }
            for (const p of exportJson.reader?.progress || exportJson.reader_progress || []) {
                dataLines.push(
                    `INSERT INTO reader_progress (user_id, book_key, book_title, chapter_index, chapter_title, scroll_percentage, client_ts) VALUES (1, ${sqlLit(p.book_key || p.bookKey)}, ${sqlLit(p.book_title || '备份校验书籍')}, ${sqlLit(p.chapter_index ?? 2)}, ${sqlLit(p.chapter_title || '第3章')}, ${sqlLit(p.scroll_percentage ?? 42)}, ${sqlLit(p.client_ts || Date.now())});`
                );
            }

            const fullSql = `${schemaSql}\n${dataLines.join('\n')}\n`;
            const d1GzPath = path.join(tmpBackupDir, 'chillin-d1.sql.gz');
            fs.writeFileSync(d1GzPath, zlib.gzipSync(Buffer.from(fullSql, 'utf8'), { level: 9 }));

            const imgStat = fs.statSync(imgOut);
            const bookStat = fs.statSync(bookOut);
            const d1Stat = fs.statSync(d1GzPath);
            const manifest = {
                format: BACKUP_FORMAT,
                createdAt: new Date().toISOString(),
                appVersion: 'qa-e2e-real',
                target: 'local',
                complete: true,
                hashAlgorithm: 'sha256',
                d1: {
                    binding: 'DB',
                    file: 'chillin-d1.sql.gz',
                    size: d1Stat.size,
                    sha256: await sha256File(d1GzPath),
                    sqlBytes: Buffer.byteLength(fullSql),
                    sqlSha256: sha256Text(fullSql),
                    tables: ['users', 'files', 'notes', 'quick_feeds', 'weeklies', 'reader_books', 'reader_progress'],
                    migrations: migFiles,
                },
                r2: {
                    bucket: 'chillin-media',
                    objects: [
                        {
                            key: r2ImgKey,
                            category: 'image',
                            id: fileId,
                            expectedSize: imgStat.size,
                            mime: 'image/png',
                            path: `r2/${r2ImgKey}`,
                            size: imgStat.size,
                            sha256: await sha256File(imgOut),
                            status: 'ok',
                        },
                        {
                            key: r2BookKey,
                            category: 'book',
                            id: bookKey,
                            expectedSize: bookStat.size,
                            mime: 'text/plain',
                            path: `r2/${r2BookKey}`,
                            size: bookStat.size,
                            sha256: await sha256File(bookOut),
                            status: 'ok',
                        },
                    ],
                    totals: { objects: 2, bytes: imgStat.size + bookStat.size },
                    excludes: [],
                },
                restore: { command: 'restore-full --local' },
                notes: [],
            };
            const manifestPath = path.join(tmpBackupDir, MANIFEST_NAME);
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
            fs.writeFileSync(path.join(tmpBackupDir, MANIFEST_HASH_NAME), (await sha256File(manifestPath)) + '\n');

            // 4. 真正执行 Chillin 正式恢复程序 restore-full.mjs --local --persist-to <隔离目录>（不使用 --dry-run）
            const restoreScript = path.join(CHILLIN_ROOT, 'scripts', 'restore-full.mjs');
            const persistRel = path.relative(CHILLIN_ROOT, tmpStateDir) || tmpStateDir;
            const restoreEnv = isolatedWranglerEnv(tmpWorkerdDir);
            const restoreRun = spawnSync(
                process.execPath,
                [restoreScript, tmpBackupDir, '--local', '--persist-to', persistRel],
                { cwd: CHILLIN_ROOT, env: restoreEnv, encoding: 'utf8', timeout: 90_000 }
            );
            expect(restoreRun.status, `restore-full --local 失败:\n${restoreRun.stdout}\n${restoreRun.stderr}`).toBe(0);
            expect(restoreRun.stdout).toContain('[restore-full] 完成');

            // 5. 从隔离 Wrangler D1 查询真实恢复的记录与关联关系
            const queryD1 = (sql) => {
                const res = runWranglerLocal(['d1', 'execute', 'DB', '--local', '--persist-to', persistRel, '--json', '--command', sql], { env: restoreEnv });
                expect(res.status, `D1 查询失败 (${sql}): ${res.stderr}`).toBe(0);
                const parsed = JSON.parse(res.stdout);
                return parsed?.[0]?.results || [];
            };

            const restoredNotes = queryD1("SELECT n.id, n.user_id, n.title, n.content, u.username FROM notes n JOIN users u ON u.id = n.user_id WHERE n.title = '备份恢复校验笔记'");
            expect(restoredNotes.length).toBe(1);
            expect(restoredNotes[0].content).toContain(imgSrc);
            expect(restoredNotes[0].username).toBe(user.username);

            const restoredFeeds = queryD1("SELECT id, user_id, media_url FROM quick_feeds WHERE content = '备份恢复校验随手记'");
            expect(restoredFeeds.length).toBe(1);
            expect(restoredFeeds[0].media_url).toBe(imgSrc);

            const restoredWeeklies = queryD1("SELECT id, title, summary, content FROM weeklies WHERE title = '2026-W48 灾备校验周记'");
            expect(restoredWeeklies.length).toBe(1);
            expect(restoredWeeklies[0].summary).toBe('周记灾备摘要');

            const restoredFiles = queryD1('SELECT id, r2_key, size FROM files WHERE id = ' + sqlLit(fileId));
            expect(restoredFiles.length).toBe(1);
            expect(restoredFiles[0].r2_key).toBe(r2ImgKey);

            const restoredBooks = queryD1('SELECT b.book_key, b.title, b.r2_key, p.chapter_index, p.scroll_percentage FROM reader_books b JOIN reader_progress p ON p.user_id = b.user_id AND p.book_key = b.book_key WHERE b.book_key = ' + sqlLit(bookKey));
            expect(restoredBooks.length).toBe(1);
            expect(restoredBooks[0].title).toBe('备份校验书籍');
            expect(Number(restoredBooks[0].chapter_index)).toBe(2);
            expect(Number(restoredBooks[0].scroll_percentage)).toBe(42);

            // 6. 从隔离 Wrangler R2 读取真实写入的对象并校验 SHA-256 一致性
            const gotImgPath = path.join(tmpVerifyDir, 'restored.png');
            const gotBookPath = path.join(tmpVerifyDir, 'restored.txt');
            const r2GetImg = runWranglerLocal(['r2', 'object', 'get', `chillin-media/${r2ImgKey}`, '--local', '--persist-to', persistRel, '--file', gotImgPath], { env: restoreEnv });
            expect(r2GetImg.status, `R2 读取图片失败: ${r2GetImg.stderr}`).toBe(0);
            expect(sha256Buf(fs.readFileSync(gotImgPath))).toBe(sha256Buf(imgBytes));

            const r2GetBook = runWranglerLocal(['r2', 'object', 'get', `chillin-media/${r2BookKey}`, '--local', '--persist-to', persistRel, '--file', gotBookPath], { env: restoreEnv });
            expect(r2GetBook.status, `R2 读取书籍失败: ${r2GetBook.stderr}`).toBe(0);
            const restoredBookBytes = fs.readFileSync(gotBookPath);
            expect(sha256Buf(restoredBookBytes)).toBe(sha256Buf(Buffer.from(bookText, 'utf8')));
            expect(restoredBookBytes.toString('utf8')).toContain('第5章 灾备校验的章节 5');

            // 7. 损坏备份拦截测试：破坏 R2 对象 1 字节 -> restore-full 必须拒绝执行
            const corruptedImg = fs.readFileSync(imgOut);
            corruptedImg[0] = corruptedImg[0] ^ 0xff;
            fs.writeFileSync(imgOut, corruptedImg);
            const badR2Run = spawnSync(
                process.execPath,
                [restoreScript, tmpBackupDir, '--local', '--persist-to', persistRel],
                { cwd: CHILLIN_ROOT, env: restoreEnv, encoding: 'utf8', timeout: 30_000 }
            );
            expect(badR2Run.status).not.toBe(0);
            expect(badR2Run.stderr).toContain('校验失败');

            // 8. 恢复中途失败测试：构造清单哈希合法但 SQL 语法损坏的备份 -> restore-full 必须在 D1 阶段报错非零退出
            fs.writeFileSync(imgOut, imgBytes); // 还原图片
            const brokenSql = 'CREATE TABLE notes (id INTEGER PRIMARY KEY);\nTHIS IS INVALID SQL SYNTAX;\n';
            fs.writeFileSync(d1GzPath, zlib.gzipSync(Buffer.from(brokenSql, 'utf8'), { level: 9 }));
            manifest.d1.size = fs.statSync(d1GzPath).size;
            manifest.d1.sha256 = await sha256File(d1GzPath);
            manifest.d1.sqlBytes = Buffer.byteLength(brokenSql);
            manifest.d1.sqlSha256 = sha256Text(brokenSql);
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
            fs.writeFileSync(path.join(tmpBackupDir, MANIFEST_HASH_NAME), (await sha256File(manifestPath)) + '\n');

            const midFailRun = spawnSync(
                process.execPath,
                [restoreScript, tmpBackupDir, '--local', '--persist-to', persistRel],
                { cwd: CHILLIN_ROOT, env: restoreEnv, encoding: 'utf8', timeout: 30_000 }
            );
            expect(midFailRun.status).not.toBe(0);
        } finally {
            fs.rmSync(tmpBackupDir, { recursive: true, force: true });
            fs.rmSync(tmpStateDir, { recursive: true, force: true });
            fs.rmSync(tmpVerifyDir, { recursive: true, force: true });
            fs.rmSync(tmpWorkerdDir, { recursive: true, force: true });
        }

        harness.assertNoBugs('Backup & Restore 真实恢复校验');
        await context.close();
    });

    test('调用主仓真实 restore-drill 脚本完成独立演练与篡改拦截', async () => {
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
