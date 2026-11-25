import { test, expect } from '@playwright/test';
import { attachPwaHarness } from '../src/support/pwa-harness.mjs';
import { uniqueUser } from '../src/support/test-data.mjs';

test.describe('Desktop Web (1280×800 Chromium) 核心体验验证', () => {
    test('桌面端登录、核心 CRUD、顶部导航切换、Cmd+K 搜索、AI 对话与常见弹窗', async ({ browser }) => {
        const context = await browser.newContext();
        const harness = await attachPwaHarness(context);
        const page = await context.newPage();
        const user = uniqueUser('desk');

        // 1. 登录/注册
        await harness.registerAndEnter(page, user);

        // 确认桌面端 1280×800 下左侧边栏导航可见且无横向溢出
        await expect(page.locator('#app-desktop-sidebar')).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
        expect(overflow).toBe(true);

        // 2. 桌面边栏导航切换与随手记 CRUD
        await page.locator('#app-desktop-sidebar .sidebar-nav-item[data-view="feeds"]').click();
        await expect(page.locator('#view-feeds')).toHaveClass(/active/);
        const feedText = `桌面端工作台随手记_${Date.now()}`;
        await page.locator('#feed-input-text').fill(feedText);
        await Promise.all([
            page.waitForResponse((r) => r.url().includes('/api/feeds') && r.ok()),
            page.locator('#btn-send-feed').click(),
        ]);
        await expect(page.locator('.feed-item-card', { hasText: feedText })).toBeVisible();

        // 3. 笔记 CRUD（桌面端通过 Ctrl+K 命令面板或新建笔记入口打开编辑器）
        await page.locator('#app-desktop-sidebar .sidebar-nav-item[data-view="notes"]').click();
        await expect(page.locator('#view-notes')).toHaveClass(/active/);
        await page.keyboard.press('Control+k');
        await expect(page.locator('#global-search-modal')).toHaveClass(/show/);
        await page.locator('#global-search-results .global-search-item', { hasText: /新建笔记|笔记/ }).first().click();
        await expect(page.locator('#view-note-editor')).toHaveClass(/active/, { timeout: 10_000 });
        await page.locator('#edit-note-title').fill('桌面端长文笔记');
        await page.locator('#edit-note-content').fill('桌面端宽屏输入验证内容 DESKTOP_SEARCH_KEY');
        await Promise.all([
            page.waitForResponse((r) => (r.url().includes('/api/sync/batch') || r.url().includes('/api/notes')) && r.ok()),
            page.locator('#btn-save-note').click(),
        ]);
        await expect(page.locator('#notes-list-container .note-item', { hasText: '桌面端长文笔记' })).toBeVisible();

        // 4. 快捷键 Ctrl/Cmd + K 唤起全局搜索
        await page.keyboard.press('Control+k');
        await expect(page.locator('#global-search-modal')).toHaveClass(/show/);
        await page.locator('#global-search-input').fill('DESKTOP_SEARCH_KEY');
        const hit = page.locator('#global-search-results .global-search-item').first();
        await expect(hit).toBeVisible({ timeout: 5000 });
        await hit.click();
        await expect(page.locator('body')).toContainText('桌面端长文笔记');

        // 5. AI 记忆回响弹窗
        await page.locator('#btn-open-ai-chat').click();
        await expect(page.locator('#ai-chat-modal')).toHaveClass(/show/);
        await page.locator('#ai-chat-input').fill('桌面端测试提问');
        await Promise.all([
            page.waitForResponse((r) => r.url().includes('/api/ai/chat') && r.ok()),
            page.locator('#btn-send-ai-chat').click(),
        ]);
        await expect(page.locator('#ai-chat-body')).toContainText('本地仿真 AI 的记忆回响', { timeout: 15_000 });
        await page.locator('#btn-close-ai-chat').click();
        await expect(page.locator('#ai-chat-modal')).not.toHaveClass(/show/);

        // 6. 常见弹窗：账号与安全弹窗、Agent 目标弹窗
        await page.locator('#btn-open-security').click();
        await expect(page.locator('#btn-security-logout-all')).toBeVisible({ timeout: 5000 });
        await page.keyboard.press('Escape');

        await page.locator('#app-desktop-sidebar .sidebar-nav-item[data-view="home"]').click();
        await expect(page.locator('#view-home')).toHaveClass(/active/);
        await page.locator('#btn-open-agent-goals').click();
        await expect(page.locator('#agent-goals-modal')).toHaveClass(/show/);
        await page.locator('#btn-close-agent-goals').click();

        harness.assertNoBugs('Desktop Web (1280×800)');
        await context.close();
    });
});
