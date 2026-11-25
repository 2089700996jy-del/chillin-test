import { test, expect } from '@playwright/test';
import {
    attachPwaHarness,
    waitForServiceWorkerReady,
} from '../src/support/pwa-harness.mjs';
import { uniqueUser } from '../src/support/test-data.mjs';

test.describe('P1 PWA 离线生命线、增量补偿与双端同步冲突', () => {
    test('真实 Service Worker 预缓存、断网零白屏启动、离线写作重连自动同步到另一台设备', async ({ browser }) => {
        const user = uniqueUser('pwa');
        const deviceA = await browser.newContext();
        const harnessA = await attachPwaHarness(deviceA);
        const pageA = await deviceA.newPage();

        await harnessA.registerAndEnter(pageA, user);
        const swInfo = await waitForServiceWorkerReady(pageA);
        expect(swInfo.cachedCount).toBeGreaterThan(25);

        // 先在线发一条随手记确保云端基线就绪
        await pageA.locator('.mobile-tab-item[data-view="feeds"]').click();
        await pageA.locator('#feed-input-text').fill('在线基线随手记 #sync');
        await Promise.all([
            pageA.waitForResponse((r) => r.url().includes('/api/feeds') && r.ok()),
            pageA.locator('#btn-send-feed').click(),
        ]);
        await expect(pageA.locator('.feed-item-card', { hasText: '在线基线随手记' })).toBeVisible();

        // 模拟真机进入地铁/飞机彻底断网
        harnessA.setAllowConsoleErrors(true);
        await deviceA.setOffline(true);

        // 断网下直接冷刷新整页：验证 Service Worker + IndexedDB 零白屏秒开！
        await pageA.reload({ waitUntil: 'domcontentloaded' });
        await expect(pageA.locator('#auth-overlay')).toHaveClass(/hidden/, { timeout: 10_000 });
        await expect(pageA.locator('#view-feeds')).toHaveClass(/active/);
        await expect(pageA.locator('.feed-item-card', { hasText: '在线基线随手记' })).toBeVisible();

        // 断网下新建笔记与随手记
        await pageA.locator('#feed-input-text').fill('地铁断网期间记录的想法 #offline');
        await pageA.locator('#btn-send-feed').click();
        await expect(pageA.locator('.feed-item-card', { hasText: '地铁断网期间记录的想法' })).toBeVisible();

        await pageA.locator('.mobile-tab-item[data-view="notes"]').click();
        await pageA.locator('#btn-create-new').click();
        await pageA.locator('#edit-note-title').fill('离线创作的长笔记');
        await pageA.locator('#edit-note-content').fill('断网时保存在 IndexedDB，联网后应自动补偿同步到云端 D1。');
        await pageA.locator('#btn-save-note').click();
        await expect(pageA.locator('#notes-list-container .note-item', { hasText: '离线创作的长笔记' })).toBeVisible();

        // 恢复网络并等待真实批量同步推送请求完成
        await deviceA.setOffline(false);
        harnessA.setAllowConsoleErrors(false);
        await Promise.all([
            pageA.waitForResponse((r) => r.url().includes('/api/sync/batch') && r.status() === 200),
            pageA.evaluate(() => window.dispatchEvent(new Event('online'))),
        ]);

        // 打开全新第二台设备（无任何本地 IndexedDB 缓存）登录同一账号，验证数据全部上云
        const deviceB = await browser.newContext();
        const harnessB = await attachPwaHarness(deviceB);
        const pageB = await deviceB.newPage();
        await harnessB.loginAndEnter(pageB, user);

        await pageB.locator('.mobile-tab-item[data-view="feeds"]').click();
        await expect(pageB.locator('.feed-item-card', { hasText: '地铁断网期间记录的想法' })).toBeVisible({ timeout: 15_000 });

        await pageB.locator('.mobile-tab-item[data-view="notes"]').click();
        await expect(pageB.locator('#notes-list-container .note-item', { hasText: '离线创作的长笔记' })).toBeVisible({ timeout: 15_000 });

        harnessA.assertNoBugs('PWA 断网重连设备 A');
        harnessB.assertNoBugs('PWA 同步验证设备 B');
        await deviceA.close();
        await deviceB.close();
    });

    test('双设备同时修改同一条笔记触发同步冲突中心并成功裁决（不静默覆盖丢失）', async ({ browser }) => {
        const user = uniqueUser('conflict');
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const harnessA = await attachPwaHarness(ctxA);
        const harnessB = await attachPwaHarness(ctxB);
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        // 设备 A 创建初始笔记并等待入库确认
        await harnessA.registerAndEnter(pageA, user);
        await pageA.locator('.mobile-tab-item[data-view="notes"]').click();
        await pageA.locator('#btn-create-new').click();
        await pageA.locator('#edit-note-title').fill('双端冲突靶子笔记');
        await pageA.locator('#edit-note-content').fill('初始版本 v1');
        await Promise.all([
            pageA.waitForResponse((r) => r.url().includes('/api/notes') && r.ok()),
            pageA.locator('#btn-save-note').click(),
        ]);
        await expect(pageA.locator('#notes-list-container .note-item', { hasText: '双端冲突靶子笔记' })).toBeVisible();

        // 设备 B 登录并拉取同一版本 v1
        await harnessB.loginAndEnter(pageB, user);
        await pageB.locator('.mobile-tab-item[data-view="notes"]').click();
        await expect(pageB.locator('#notes-list-container .note-item', { hasText: '双端冲突靶子笔记' })).toBeVisible({ timeout: 15_000 });

        // 设备 A 先在线修改为 v2 并等待云端落库响应
        await pageA.locator('#notes-list-container .note-item', { hasText: '双端冲突靶子笔记' }).click();
        await pageA.locator('#edit-note-content').fill('设备 A 修改后的内容 v2');
        await Promise.all([
            pageA.waitForResponse((r) => r.url().includes('/api/notes') && r.ok()),
            pageA.locator('#btn-save-note').click(),
        ]);

        // 设备 B 断网并离线把同一条笔记改写为 v3
        harnessB.setAllowConsoleErrors(true);
        await ctxB.setOffline(true);
        await pageB.locator('#notes-list-container .note-item', { hasText: '双端冲突靶子笔记' }).click();
        await pageB.locator('#edit-note-content').fill('设备 B 离线修改的内容 v3');
        await pageB.locator('#btn-save-note').click();

        // 设备 B 恢复联网，仅通过真实 online 事件触发黑盒自动同步，等待 /api/sync/pull 完成
        await ctxB.setOffline(false);
        harnessB.setAllowConsoleErrors(false);
        await Promise.all([
            pageB.waitForResponse((r) => r.url().includes('/api/sync/pull') && r.status() === 200),
            pageB.evaluate(() => window.dispatchEvent(new Event('online'))),
        ]);

        await expect(pageB.locator('#sync-conflict-banner')).toBeVisible({ timeout: 15_000 });
        await pageB.locator('#sync-conflict-open').click();
        await expect(pageB.locator('#sync-conflict-modal')).toHaveClass(/active|open|show|visible/i);
        await expect(pageB.locator('#sync-conflict-list')).toContainText('双端冲突靶子笔记');

        // 裁决保留本地版本或云端版本后冲突条消失
        await pageB.locator('#sync-conflict-list button', { hasText: /保留本地|保留云端/ }).first().click();
        await expect(pageB.locator('#sync-conflict-banner')).toBeHidden({ timeout: 10_000 });

        harnessA.assertNoBugs('冲突测试设备 A');
        harnessB.assertNoBugs('冲突测试设备 B');
        await ctxA.close();
        await ctxB.close();
    });
});
