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
        test.setTimeout(240_000);
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

        // 3. 调用 Chillin 正式 backup-full.mjs --local --persist-to <源状态目录> 生成真实完整备份包
        const imgBytes = await (await page.request.get(`${base}${imgSrc}`)).body();
        const bookText = await (await page.request.get(`${base}/api/reader/books/${encodeURIComponent(bookKey)}`)).text();
        const fileId = imgSrc.split('?')[0].split('/').pop();

        const { MANIFEST_NAME, MANIFEST_HASH_NAME, sha256File, sha256Text } = await import(
            pathToFileURL(path.join(CHILLIN_ROOT, 'scripts', 'backup-kit.mjs')).href
        );

        const tmpRoot = path.resolve(CHILLIN_ROOT, '..', '.tmp');
        fs.mkdirSync(tmpRoot, { recursive: true });
        const tmpBackupDir = fs.mkdtempSync(path.join(tmpRoot, 'qa-backup-pkg-'));
        const tmpStateDir = fs.mkdtempSync(path.join(tmpRoot, 'qa-restore-state-'));
        const tmpVerifyDir = fs.mkdtempSync(path.join(tmpRoot, 'qa-restore-verify-'));
        const tmpWorkerdDir = fs.mkdtempSync(path.join(tmpRoot, 'qa-restore-workerd-'));

        try {
            expect(fs.readdirSync(tmpStateDir)).toEqual([]);

            const sourcePersistRel = path.relative(CHILLIN_ROOT, harness.runtime.stateDir) || harness.runtime.stateDir;
            const backupOutRel = path.relative(CHILLIN_ROOT, tmpBackupDir) || tmpBackupDir;
            const backupScript = path.join(CHILLIN_ROOT, 'scripts', 'backup-full.mjs');
            const restoreEnv = isolatedWranglerEnv(tmpWorkerdDir);

            const backupRun = spawnSync(
                process.execPath,
                [backupScript, '--local', '--persist-to', sourcePersistRel, '--out', backupOutRel],
                { cwd: CHILLIN_ROOT, env: restoreEnv, encoding: 'utf8', timeout: 120_000 }
            );
            expect(backupRun.status, `backup-full --local 失败:\n${backupRun.stdout}\n${backupRun.stderr}`).toBe(0);

            const manifestPath = path.join(tmpBackupDir, MANIFEST_NAME);
            expect(fs.existsSync(manifestPath)).toBe(true);
            expect(fs.existsSync(path.join(tmpBackupDir, MANIFEST_HASH_NAME))).toBe(true);
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            expect(manifest.complete).toBe(true);
            expect(manifest.r2.objects.length).toBeGreaterThanOrEqual(2);
            expect(manifest.d1.tables.length).toBeGreaterThan(0);

            const querySourceD1 = (sql) => {
                const res = runWranglerLocal(['d1', 'execute', 'DB', '--local', '--persist-to', sourcePersistRel, '--json', '--command', sql], { env: restoreEnv });
                expect(res.status, `源库 D1 查询失败 (${sql}): ${res.stderr}`).toBe(0);
                return JSON.parse(res.stdout)?.[0]?.results || [];
            };

            // 4. 真正执行 Chillin 正式恢复程序 restore-full.mjs --local --persist-to <目标隔离目录>（不使用 --dry-run）
            const restoreScript = path.join(CHILLIN_ROOT, 'scripts', 'restore-full.mjs');
            const persistRel = path.relative(CHILLIN_ROOT, tmpStateDir) || tmpStateDir;
            const restoreRun = spawnSync(
                process.execPath,
                [restoreScript, tmpBackupDir, '--local', '--persist-to', persistRel],
                { cwd: CHILLIN_ROOT, env: restoreEnv, encoding: 'utf8', timeout: 120_000 }
            );
            expect(restoreRun.status, `restore-full --local 失败:\n${restoreRun.stdout}\n${restoreRun.stderr}`).toBe(0);
            expect(restoreRun.stdout).toContain('[restore-full] D1 SQL 预校验通过');
            expect(restoreRun.stdout).toContain('[restore-full] 完成');

            // 5. 核验目标 D1 Schema、全部核心业务表记录数与内容一致性（对比源库）
            const queryTargetD1 = (sql) => {
                const res = runWranglerLocal(['d1', 'execute', 'DB', '--local', '--persist-to', persistRel, '--json', '--command', sql], { env: restoreEnv });
                expect(res.status, `目标 D1 查询失败 (${sql}): ${res.stderr}`).toBe(0);
                return JSON.parse(res.stdout)?.[0]?.results || [];
            };

            const targetTables = queryTargetD1("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_cf_KV' ORDER BY name")
                .map((r) => r.name);
            for (const t of manifest.d1.tables) {
                expect(targetTables, `恢复后缺少表 ${t}`).toContain(t);
            }

            for (const tbl of ['users', 'notes', 'quick_feeds', 'weeklies', 'files', 'reader_books', 'reader_progress', 'd1_migrations']) {
                const srcCnt = Number(querySourceD1(`SELECT COUNT(*) AS c FROM ${tbl}`)[0]?.c ?? -1);
                const dstCnt = Number(queryTargetD1(`SELECT COUNT(*) AS c FROM ${tbl}`)[0]?.c ?? -2);
                expect(dstCnt, `表 ${tbl} 恢复后记录数与源库不一致`).toBe(srcCnt);
                expect(dstCnt, `表 ${tbl} 不应为空`).toBeGreaterThan(0);
            }

            const restoredNotes = queryTargetD1("SELECT n.id, n.user_id, n.title, n.content, u.username FROM notes n JOIN users u ON u.id = n.user_id WHERE n.title = '备份恢复校验笔记'");
            expect(restoredNotes.length).toBe(1);
            expect(restoredNotes[0].content).toContain(imgSrc);
            expect(restoredNotes[0].username).toBe(user.username);

            const restoredFeeds = queryTargetD1("SELECT id, user_id, media_url FROM quick_feeds WHERE content = '备份恢复校验随手记'");
            expect(restoredFeeds.length).toBe(1);
            expect(restoredFeeds[0].media_url).toBe(imgSrc);

            const restoredWeeklies = queryTargetD1("SELECT id, title, summary, content FROM weeklies WHERE title = '2026-W48 灾备校验周记'");
            expect(restoredWeeklies.length).toBe(1);
            expect(restoredWeeklies[0].summary).toBe('周记灾备摘要');

            const restoredFiles = queryTargetD1('SELECT id, r2_key, size FROM files WHERE id = ' + sqlLit(fileId));
            expect(restoredFiles.length).toBe(1);

            const restoredBooks = queryTargetD1('SELECT b.book_key, b.title, b.r2_key, p.chapter_index, p.scroll_percentage FROM reader_books b JOIN reader_progress p ON p.user_id = b.user_id AND p.book_key = b.book_key WHERE b.book_key = ' + sqlLit(bookKey));
            expect(restoredBooks.length).toBe(1);
            expect(restoredBooks[0].title).toBe('备份校验书籍');
            expect(Number(restoredBooks[0].chapter_index)).toBe(2);
            expect(Number(restoredBooks[0].scroll_percentage)).toBe(42);

            // 6. 遍历核验备份清单中的全部 R2 对象：数量、对象键、文件大小与 SHA-256
            let verifiedImg = false;
            let verifiedBook = false;
            for (const obj of manifest.r2.objects) {
                expect(obj.status).toBe('ok');
                const gotPath = path.join(tmpVerifyDir, path.basename(obj.key) + '-' + crypto.randomBytes(2).toString('hex'));
                const r2Get = runWranglerLocal(['r2', 'object', 'get', `chillin-media/${obj.key}`, '--local', '--persist-to', persistRel, '--file', gotPath], { env: restoreEnv });
                expect(r2Get.status, `R2 读取对象 ${obj.key} 失败: ${r2Get.stderr}`).toBe(0);
                const gotBytes = fs.readFileSync(gotPath);
                expect(gotBytes.length, `R2 对象 ${obj.key} 大小不一致`).toBe(obj.size);
                expect(sha256Buf(gotBytes), `R2 对象 ${obj.key} SHA-256 不一致`).toBe(obj.sha256);
                if (obj.key.includes(fileId)) {
                    expect(sha256Buf(gotBytes)).toBe(sha256Buf(imgBytes));
                    verifiedImg = true;
                }
                if (obj.category === 'book' && gotBytes.toString('utf8') === bookText) {
                    verifiedBook = true;
                }
            }
            expect(verifiedImg).toBe(true);
            expect(verifiedBook).toBe(true);
        } finally {
            fs.rmSync(tmpBackupDir, { recursive: true, force: true });
            fs.rmSync(tmpStateDir, { recursive: true, force: true });
            fs.rmSync(tmpVerifyDir, { recursive: true, force: true });
            fs.rmSync(tmpWorkerdDir, { recursive: true, force: true });
        }

        harness.assertNoBugs('Backup & Restore 真实闭环恢复校验');
        await context.close();
    });

    test('恢复失败安全性验证：R2 损坏 / SQL 语法错误（哈希合法）/ 中途失败均不破坏目标库既有数据', async () => {
        test.setTimeout(240_000);
        const { BACKUP_FORMAT, MANIFEST_NAME, MANIFEST_HASH_NAME, sha256File, sha256Text } = await import(
            pathToFileURL(path.join(CHILLIN_ROOT, 'scripts', 'backup-kit.mjs')).href
        );

        const tmpRoot = path.resolve(CHILLIN_ROOT, '..', '.tmp');
        fs.mkdirSync(tmpRoot, { recursive: true });
        const tmpBackupDir = fs.mkdtempSync(path.join(tmpRoot, 'qa-fail-pkg-'));
        const tmpTargetStateDir = fs.mkdtempSync(path.join(tmpRoot, 'qa-fail-target-'));
        const tmpWorkerdDir = fs.mkdtempSync(path.join(tmpRoot, 'qa-fail-workerd-'));
        const tmpCheckDir = fs.mkdtempSync(path.join(tmpRoot, 'qa-fail-check-'));
        const restoreEnv = isolatedWranglerEnv(tmpWorkerdDir);
        const targetRel = path.relative(CHILLIN_ROOT, tmpTargetStateDir) || tmpTargetStateDir;

        const queryTargetD1 = (sql) => {
            const res = runWranglerLocal(['d1', 'execute', 'DB', '--local', '--persist-to', targetRel, '--json', '--command', sql], { env: restoreEnv });
            expect(res.status, `目标 D1 查询失败: ${res.stderr}`).toBe(0);
            return JSON.parse(res.stdout)?.[0]?.results || [];
        };

        try {
            // 1. 在隔离目标库预先写入哨兵用户、哨兵笔记与哨兵 R2 对象
            const migApply = runWranglerLocal(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', targetRel], { env: restoreEnv });
            expect(migApply.status, `初始化目标库失败: ${migApply.stderr}`).toBe(0);

            const seedSqlPath = path.join(tmpCheckDir, 'seed.sql');
            fs.writeFileSync(seedSqlPath, [
                "INSERT INTO users (id, username, password_hash) VALUES (1, 'sentinel_user', 'hash');",
                "INSERT INTO notes (id, user_id, title, content, date, created_at, updated_at, is_deleted) VALUES (9001, 1, '现有重要笔记_不可丢失', '保护目标库不被恢复失败清空', '2026-11-27', 1000, 1000, 0);",
            ].join('\n'));
            const seedRun = runWranglerLocal(['d1', 'execute', 'DB', '--local', '--persist-to', targetRel, '--file', seedSqlPath], { env: restoreEnv });
            expect(seedRun.status, `种子 SQL 执行失败:\n${seedRun.stdout}\n${seedRun.stderr}`).toBe(0);

            const sentinelR2Key = 'uploads/1/sentinel-keep.txt';
            const sentinelR2File = path.join(tmpCheckDir, 'sentinel-keep.txt');
            fs.writeFileSync(sentinelR2File, 'SENTINEL_R2_CONTENT_DO_NOT_OVERWRITE', 'utf8');
            const r2Put = runWranglerLocal(['r2', 'object', 'put', `chillin-media/${sentinelR2Key}`, '--file', sentinelR2File, '--content-type', 'text/plain', '--local', '--persist-to', targetRel], { env: restoreEnv });
            expect(r2Put.status).toBe(0);

            // 构造一份含 1 个 R2 对象与 1 条新笔记的合法备份包作为故障注入基础
            const r2ObjKey = 'uploads/1/restore-test.png';
            const r2ObjPath = path.join(tmpBackupDir, 'r2', r2ObjKey);
            fs.mkdirSync(path.dirname(r2ObjPath), { recursive: true });
            const pngBytes = samplePngBuffer();
            fs.writeFileSync(r2ObjPath, pngBytes);

            const migDir = path.join(CHILLIN_ROOT, 'migrations');
            const schemaSql = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()
                .map((f) => fs.readFileSync(path.join(migDir, f), 'utf8')).join('\n');
            const validSql = schemaSql + '\n'
                + "INSERT INTO users (id, username, password_hash) VALUES (1, 'restored_user', 'hash');\n"
                + "INSERT INTO notes (id, user_id, title, content, date, created_at, updated_at, is_deleted) VALUES (9002, 1, '新备份笔记', '来自备份', '2026-11-27', 2000, 2000, 0);\n";
            const d1GzPath = path.join(tmpBackupDir, 'chillin-d1.sql.gz');
            fs.writeFileSync(d1GzPath, zlib.gzipSync(Buffer.from(validSql, 'utf8'), { level: 9 }));

            const manifest = {
                format: BACKUP_FORMAT,
                createdAt: new Date().toISOString(),
                appVersion: '2.5.287',
                target: 'local',
                complete: true,
                hashAlgorithm: 'sha256',
                d1: {
                    binding: 'DB',
                    file: 'chillin-d1.sql.gz',
                    size: fs.statSync(d1GzPath).size,
                    sha256: await sha256File(d1GzPath),
                    sqlBytes: Buffer.byteLength(validSql),
                    sqlSha256: sha256Text(validSql),
                    tables: ['users', 'notes'],
                    migrations: [],
                },
                r2: {
                    bucket: 'chillin-media',
                    objects: [{
                        key: r2ObjKey,
                        category: 'image',
                        expectedSize: pngBytes.length,
                        mime: 'image/png',
                        path: `r2/${r2ObjKey}`,
                        size: pngBytes.length,
                        sha256: await sha256File(r2ObjPath),
                        status: 'ok',
                    }],
                    totals: { objects: 1, bytes: pngBytes.length },
                    excludes: [],
                },
                restore: { command: 'restore-full --local' },
                notes: [],
            };
            const manifestPath = path.join(tmpBackupDir, MANIFEST_NAME);
            const writeManifestAndHash = async () => {
                fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
                fs.writeFileSync(path.join(tmpBackupDir, MANIFEST_HASH_NAME), (await sha256File(manifestPath)) + '\n');
            };
            await writeManifestAndHash();

            const restoreScript = path.join(CHILLIN_ROOT, 'scripts', 'restore-full.mjs');
            const assertTargetIntact = () => {
                const notes = queryTargetD1("SELECT id, title FROM notes ORDER BY id");
                expect(notes.some((n) => Number(n.id) === 9001 && n.title === '现有重要笔记_不可丢失')).toBe(true);
                expect(notes.some((n) => Number(n.id) === 9002)).toBe(false);

                const gotSentinelPath = path.join(tmpCheckDir, 'got-sentinel.txt');
                const getSentinel = runWranglerLocal(['r2', 'object', 'get', `chillin-media/${sentinelR2Key}`, '--local', '--persist-to', targetRel, '--file', gotSentinelPath], { env: restoreEnv });
                expect(getSentinel.status).toBe(0);
                expect(fs.readFileSync(gotSentinelPath, 'utf8')).toBe('SENTINEL_R2_CONTENT_DO_NOT_OVERWRITE');
            };

            // 场景 A：损坏的 R2 对象 -> verifyBackup 拦截，目标库与 R2 零破坏
            const corruptedPng = Buffer.from(pngBytes);
            corruptedPng[0] = corruptedPng[0] ^ 0xff;
            fs.writeFileSync(r2ObjPath, corruptedPng);
            const badR2Run = spawnSync(process.execPath, [restoreScript, tmpBackupDir, '--local', '--persist-to', targetRel], {
                cwd: CHILLIN_ROOT, env: restoreEnv, encoding: 'utf8', timeout: 30_000,
            });
            expect(badR2Run.status).not.toBe(0);
            expect(badR2Run.stderr).toContain('校验失败');
            assertTargetIntact();

            // 场景 B：R2 还原正常，但 D1 SQL 存在语法错误（且清单 SHA-256 合法）-> 独立预校验阶段拦截，不写 R2 也不清空目标库
            fs.writeFileSync(r2ObjPath, pngBytes);
            const brokenSql = 'CREATE TABLE notes (id INTEGER PRIMARY KEY);\nTHIS IS INVALID SQL SYNTAX;\n';
            fs.writeFileSync(d1GzPath, zlib.gzipSync(Buffer.from(brokenSql, 'utf8'), { level: 9 }));
            manifest.d1.size = fs.statSync(d1GzPath).size;
            manifest.d1.sha256 = await sha256File(d1GzPath);
            manifest.d1.sqlBytes = Buffer.byteLength(brokenSql);
            manifest.d1.sqlSha256 = sha256Text(brokenSql);
            await writeManifestAndHash();

            const badSqlRun = spawnSync(process.execPath, [restoreScript, tmpBackupDir, '--local', '--persist-to', targetRel], {
                cwd: CHILLIN_ROOT, env: restoreEnv, encoding: 'utf8', timeout: 60_000,
            });
            expect(badSqlRun.status).not.toBe(0);
            assertTargetIntact();
            // 确认预校验失败后未提前把新 R2 对象写入目标库
            const checkNoPartialR2 = runWranglerLocal(['r2', 'object', 'get', `chillin-media/${r2ObjKey}`, '--local', '--persist-to', targetRel, '--file', path.join(tmpCheckDir, 'should-not-exist.png')], { env: restoreEnv });
            expect(checkNoPartialR2.status).not.toBe(0);

            // 场景 C：恢复中途失败（合法备份 + --no-reset 撞上非空目标库已有表结构导致目标 D1 导入中途报错）-> 原有数据保持完整
            fs.writeFileSync(d1GzPath, zlib.gzipSync(Buffer.from(validSql, 'utf8'), { level: 9 }));
            manifest.d1.size = fs.statSync(d1GzPath).size;
            manifest.d1.sha256 = await sha256File(d1GzPath);
            manifest.d1.sqlBytes = Buffer.byteLength(validSql);
            manifest.d1.sqlSha256 = sha256Text(validSql);
            await writeManifestAndHash();

            const midFailRun = spawnSync(process.execPath, [restoreScript, tmpBackupDir, '--local', '--persist-to', targetRel, '--no-reset'], {
                cwd: CHILLIN_ROOT, env: restoreEnv, encoding: 'utf8', timeout: 60_000,
            });
            expect(midFailRun.status).not.toBe(0);
            assertTargetIntact();
        } finally {
            fs.rmSync(tmpBackupDir, { recursive: true, force: true });
            fs.rmSync(tmpTargetStateDir, { recursive: true, force: true });
            fs.rmSync(tmpWorkerdDir, { recursive: true, force: true });
            fs.rmSync(tmpCheckDir, { recursive: true, force: true });
        }
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
