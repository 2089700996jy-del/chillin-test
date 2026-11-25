import { test, expect } from '@playwright/test';
import { attachPwaHarness } from '../src/support/pwa-harness.mjs';
import { uniqueUser } from '../src/support/test-data.mjs';

test.describe('整合自 audit-tools 的核心 UI 体验回归（分页、搜索跳转、时间线）', () => {
    test('大量笔记自动分页续载与全站搜索跨分页扩窗高亮跳转', async ({ browser }) => {
        const context = await browser.newContext();
        const harness = await attachPwaHarness(context);
        const page = await context.newPage();
        const user = uniqueUser('page');

        await harness.registerAndEnter(page, user);
        await expect(page.locator('#sync-status')).toHaveAttribute('data-tone', 'ok', { timeout: 10_000 });
        // 确保 D1 datetime('now', '+8 hours') 至少推进 1 秒，避免与首屏 sync_cursor 同秒被 since_notes 过滤
        await page.waitForTimeout(1100);

        // 通过真实后端 /api/sync/batch 灌入 120 条笔记（经过真实 D1 -> /api/sync/pull -> IndexedDB 完整链条）
        const nowStr = new Date(Date.now() + 8 * 3600_000 + 60_000).toISOString().replace('T', ' ').slice(0, 19);
        const notes = Array.from({ length: 120 }, (_, i) => ({
            id: 9000 + i,
            title: `分页测试笔记_${i}`,
            content: `这是第 ${i} 条笔记的正文，包含特殊标记词 TARGET_NEEDLE_${i}`,
            date: nowStr.slice(0, 10),
            created_at: nowStr,
            updated_at: nowStr,
        }));

        const batchRes = await page.request.post(`${harness.runtime.appOrigin}/api/sync/batch`, {
            data: { notes },
        });
        expect(batchRes.ok()).toBe(true);
        const notesCheckRes = await page.request.get(`${harness.runtime.appOrigin}/api/notes`);
        expect(notesCheckRes.ok()).toBe(true);
        const notesCheck = await notesCheckRes.json();
        expect(notesCheck.length, `D1 notes count after batch: ${notesCheck.length}`).toBeGreaterThanOrEqual(120);

        // 刷新并等待云端拉取完成，再切换到笔记列表页
        await Promise.all([
            page.waitForResponse((r) => r.url().includes('/api/sync/pull') && r.status() === 200),
            page.reload({ waitUntil: 'load' }),
        ]);
        await expect(page.locator('#auth-overlay')).toHaveClass(/hidden/, { timeout: 15_000 });

        await page.locator('.mobile-tab-item[data-view="notes"]').click();
        await expect(page.locator('#view-notes')).toHaveClass(/active/);

        const noteItems = page.locator('#notes-list-container .note-item');
        await expect.poll(() => noteItems.count(), { timeout: 10_000 }).toBeGreaterThan(2);
        const initialCount = await noteItems.count();
        expect(initialCount).toBeGreaterThan(0);
        expect(initialCount).toBeLessThan(120); // 确认首屏确实分页而非一次全量渲染卡死

        // 滚到底触发自动续载更多（使用状态轮询替代硬编码 sleep）
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await expect.poll(() => noteItems.count(), { timeout: 10_000 }).toBeGreaterThan(initialCount);

        // 滚回顶部以使用顶部全局搜索按钮（模拟移动端用户点开搜索查找跨页记录）
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.locator('#btn-open-global-search').click();
        await expect(page.locator('#global-search-modal')).toHaveClass(/active|open|show|visible/i);
        await page.locator('#global-search-input').fill('TARGET_NEEDLE_119');
        const hit = page.locator('#global-search-results .global-search-item').first();
        await expect(hit).toBeVisible({ timeout: 5000 });
        await hit.click();

        // 验证跳转到对应笔记、目标内容可见且关键词被高亮渲染
        await expect(page.locator('body')).toContainText('分页测试笔记_119');
        await expect(page.locator('body')).toContainText('TARGET_NEEDLE_119');
        const hasHighlight = await page.evaluate(() => {
            return Boolean(document.querySelector('.highlight-flash, mark'));
        });
        expect(hasHighlight, '搜索跳转后未发现高亮标记 (.highlight-flash 或 <mark>)').toBe(true);
        harness.assertNoBugs('分页与跨页搜索跳转');
        await context.close();
    });
});
