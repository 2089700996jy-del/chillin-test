import { test, expect } from '@playwright/test';
import {
    attachPwaHarness,
    assertNoMobileOverflow,
} from '../src/support/pwa-harness.mjs';
import { uniqueUser, samplePngBuffer, sampleTxtBookBuffer } from '../src/support/test-data.mjs';

test.describe('P0 黄金全链路体验验证 (Mobile PWA)', () => {
    test('新用户注册、刷新免重登、随手记图文待办、双向链接笔记、收藏提示词与阅读器全链路', async ({ browser }) => {
        const context = await browser.newContext();
        const harness = await attachPwaHarness(context);
        const page = await context.newPage();
        const user = uniqueUser('golden');

        // 1. 注册并进入主界面
        await harness.registerAndEnter(page, user);
        await assertNoMobileOverflow(page, 'home-initial');

        // 2. 刷新页面验证 HttpOnly Cookie 会话持久性（像原生 App 一样无需重新登录）
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.locator('#auth-overlay')).toHaveClass(/hidden/, { timeout: 15_000 });
        await expect(page.locator('#nav-username')).toContainText(user.username);

        // 3. 随手记 Feeds：上传图片 + 待办 + 标签并发送
        await page.locator('.mobile-tab-item[data-view="feeds"]').click();
        await expect(page.locator('#view-feeds')).toHaveClass(/active/);
        await assertNoMobileOverflow(page, 'feeds-view');

        await page.locator('#feed-input-text').fill('- [ ] 验证今天上线体验 #技术 灵感记录');
        const fileChooserPromise = page.waitForEvent('filechooser');
        await page.locator('#btn-feed-add-media').click();
        const fileChooser = await fileChooserPromise;
        await fileChooser.setFiles({
            name: 'pixel.png',
            mimeType: 'image/png',
            buffer: samplePngBuffer(),
        });
        await expect(page.locator('#feed-media-preview')).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('#feed-media-url')).not.toHaveValue('', { timeout: 10_000 });
        await page.locator('#btn-send-feed').click();

        const feedCard = page.locator('.feed-item-card', { hasText: '验证今天上线体验' });
        await expect(feedCard).toBeVisible({ timeout: 10_000 });
        await expect(feedCard.locator('img')).toBeVisible();

        // 4. 笔记与双向链接 [[wikilink]] + 反向引用
        await page.locator('.mobile-tab-item[data-view="notes"]').click();
        await expect(page.locator('#view-notes')).toHaveClass(/active/);
        await assertNoMobileOverflow(page, 'notes-list');

        // 新建目标笔记 A
        await page.locator('#btn-create-new').click();
        await expect(page.locator('#view-note-editor')).toHaveClass(/active/);
        await page.locator('#edit-note-title').fill('核心目标卡片');
        await page.locator('#edit-note-content').fill('这是被其他笔记双向引用的核心节点。');
        await page.locator('#btn-save-note').click();
        await expect(page.locator('#view-notes')).toHaveClass(/active/, { timeout: 10_000 });

        // 新建笔记 B 并使用 [[核心目标卡片]]
        await page.locator('#btn-create-new').click();
        await page.locator('#edit-note-title').fill('关联笔记B');
        await page.locator('#edit-note-content').fill('今天复盘参考了 [[核心目标卡片]] 的思路。');
        await page.locator('#btn-save-note').click();
        await expect(page.locator('#view-notes')).toHaveClass(/active/, { timeout: 10_000 });

        // 重新打开笔记 A，校验反向引用显示 1 条来自关联笔记 B
        await page.locator('#notes-list-container .note-item').filter({
            has: page.locator('.note-item-title', { hasText: /^核心目标卡片$/ }),
        }).click();
        await expect(page.locator('#note-backlinks-section')).toBeVisible();
        await expect(page.locator('#note-backlinks-count')).toHaveText('1');
        await expect(page.locator('#note-backlinks-section')).toContainText('关联笔记B');
        await page.locator('#btn-back').click();

        // 5. 收藏与提示词库（{{变量}} 填参预览）
        await page.locator('.mobile-tab-item[data-view="bookmarks"]').click();
        await expect(page.locator('#view-bookmarks')).toHaveClass(/active/);
        await assertNoMobileOverflow(page, 'bookmarks-view');

        // 切换到提示词子Tab并新建提示词
        await page.locator('#bookmarks-tab-switcher button[data-subtab="prompts"]').click();
        await page.locator('#btn-create-new').click();
        await expect(page.locator('#view-prompt-editor')).toHaveClass(/active/);
        await page.locator('#edit-prompt-project').fill('测试工坊');
        await page.locator('#edit-prompt-title').fill('代码审计助手');
        await page.locator('#edit-prompt-content').fill('请用 {{语言}} 审查以下模块：{{模块名}}');
        await expect(page.locator('#prompt-content-counter')).toContainText('2 个参数');
        await page.locator('#btn-save-prompt').click();
        await expect(page.locator('#view-bookmarks')).toHaveClass(/active/, { timeout: 10_000 });

        // 6. TXT 阅读器：导入本地 TXT + 分章阅读 + 翻章 + 调字号
        await page.locator('.mobile-tab-item[data-view="reader"]').click();
        await expect(page.locator('#view-reader')).toHaveClass(/active/);
        await assertNoMobileOverflow(page, 'reader-shelf');

        const bookInput = page.locator('#book-file-input');
        await bookInput.setInputFiles({
            name: '流浪数字花园.txt',
            mimeType: 'text/plain',
            buffer: sampleTxtBookBuffer('数字花园'),
        });

        const bookCard = page.locator('#bookshelf-grid .book-card', { hasText: '流浪数字花园' });
        await expect(bookCard).toBeVisible({ timeout: 15_000 });
        await bookCard.click();

        await expect(page.locator('#view-reader-book')).toHaveClass(/active/, { timeout: 10_000 });
        await expect(page.locator('#chapter-indicator')).toContainText('1 / 5');
        await page.locator('#btn-next-chapter').click();
        await expect(page.locator('#chapter-indicator')).toContainText('2 / 5');

        // 调节排版字号并校验无报错
        await page.locator('#btn-reader-typography-toggle').click();
        await expect(page.locator('#reader-typography-modal')).toHaveClass(/active|open|visible|show/i);
        await page.locator('#btn-reader-font-increase').click();

        harness.assertNoBugs('P0 黄金全链路');
        await context.close();
    });
});
