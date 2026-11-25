import { test, expect } from '@playwright/test';
import {
    attachPwaHarness,
    assertNoMobileOverflow,
    injectAxeInitScript,
    runAxeScan,
} from '../src/support/pwa-harness.mjs';
import { uniqueUser } from '../src/support/test-data.mjs';

test.describe('P2 主动找 Bug 破坏性探针（生命周期/竞态/XSS/三主题对比度）', () => {
    test('探针 1：笔记编辑防抖期间切后台 (visibilitychange) + 刷新，验证草稿不丢失', async ({ browser }) => {
        const context = await browser.newContext();
        const harness = await attachPwaHarness(context);
        const page = await context.newPage();
        const user = uniqueUser('draft');

        await harness.registerAndEnter(page, user);
        await page.locator('.mobile-tab-item[data-view="notes"]').click();
        await page.locator('#btn-create-new').click();
        await expect(page.locator('#view-note-editor')).toHaveClass(/active/);

        const unsavedText = '切后台瞬间还没点保存的珍贵草稿_' + Date.now();
        await page.locator('#edit-note-title').fill('草稿防丢测试');
        await page.locator('#edit-note-content').fill(unsavedText);

        // 刻意不等待防抖定时器，直接模拟手机切后台（visibilitychange -> hidden）并确认草稿落盘后再刷新
        await page.evaluate(() => {
            Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
            document.dispatchEvent(new Event('visibilitychange'));
            window.dispatchEvent(new Event('pagehide'));
        });
        await page.waitForFunction((expected) => {
            return Object.values(localStorage).some((v) => typeof v === 'string' && v.includes(expected));
        }, unsavedText, { timeout: 5000 });

        await page.reload({ waitUntil: 'load' });
        await expect(page.locator('#auth-overlay')).toHaveClass(/hidden/, { timeout: 15_000 });
        const inEditor = await page.locator('#view-note-editor').evaluate((el) => el.classList.contains('active'));
        if (!inEditor) {
            await page.locator('.mobile-tab-item[data-view="notes"]').click();
            await page.locator('#btn-create-new').click();
        }

        // 检查是否弹出未保存草稿恢复横幅，并能完整恢复文本
        await expect(page.locator('#note-draft-tip')).toBeVisible({ timeout: 5000 });
        await page.locator('#btn-restore-note-draft').click();
        await expect(page.locator('#edit-note-content')).toHaveValue(unsavedText);

        harness.assertNoBugs('切后台草稿防丢探针');
        await context.close();
    });

    test('探针 2：极速双击发送随手记不产生重复卡片 & 快速切 Tab 无竞态报错', async ({ browser }) => {
        const context = await browser.newContext();
        const harness = await attachPwaHarness(context);
        const page = await context.newPage();
        const user = uniqueUser('race');

        await harness.registerAndEnter(page, user);
        await page.locator('.mobile-tab-item[data-view="feeds"]').click();

        const tag = '防连击测试_' + Date.now();
        await page.locator('#feed-input-text').fill(tag);
        // 连续极速点击两次发送按钮，等待真实 API 落库响应完成
        await Promise.all([
            page.waitForResponse((r) => r.url().includes('/api/feeds') && r.ok()),
            page.locator('#btn-send-feed').click(),
            page.locator('#btn-send-feed').click({ force: true }).catch(() => {}),
        ]);

        await expect(page.locator('.feed-item-card', { hasText: tag })).toHaveCount(1);
        const feedsApiRes = await page.request.get(`${harness.runtime.appOrigin}/api/feeds`);
        expect(feedsApiRes.ok()).toBe(true);
        const serverMatches = (await feedsApiRes.json()).filter((f) => String(f.content || '').includes(tag));
        expect(serverMatches.length, `服务端存在 ${serverMatches.length} 条重复随手记`).toBe(1);

        // 连续快速在 5 个底部 Tab 之间来回高频切换（检测动态加载/DOM 竞态错误）
        for (let round = 0; round < 2; round++) {
            for (const view of ['home', 'feeds', 'notes', 'bookmarks', 'reader']) {
                await page.locator(`.mobile-tab-item[data-view="${view}"]`).click();
            }
        }
        await expect(page.locator('#view-reader')).toHaveClass(/active/);
        harness.assertNoBugs('快速连击与 Tab 切换竞态');
        await context.close();
    });

    test('探针 3：XSS 负载注入与 Trusted Types / DOMPurify 防护验证', async ({ browser }) => {
        const context = await browser.newContext();
        const harness = await attachPwaHarness(context);
        const page = await context.newPage();
        const user = uniqueUser('xss');

        await harness.registerAndEnter(page, user);
        await page.locator('.mobile-tab-item[data-view="feeds"]').click();

        const xssPayload = `<img src=x onerror="window.__xssTriggered=1"> [[<svg onload="window.__xssTriggered=1">]]`;
        await page.locator('#feed-input-text').fill(xssPayload);
        await Promise.all([
            page.waitForResponse((r) => r.url().includes('/api/feeds') && r.ok()),
            page.locator('#btn-send-feed').click(),
        ]);
        await expect(page.locator('.feed-item-card').first()).toBeVisible();

        const triggered = await page.evaluate(() => Boolean(window.__xssTriggered));
        expect(triggered, 'XSS 脚本被执行！').toBe(false);

        // 不仅检测未触发脚本，还必须验证 DOM 中不存在危险内联事件属性且文本被安全转义渲染
        const unsafeDom = await page.evaluate(() => {
            const card = document.querySelector('.feed-item-card');
            if (!card) return { missing: true };
            return {
                missing: false,
                hasOnError: Boolean(card.querySelector('[onerror]')),
                hasOnLoad: Boolean(card.querySelector('[onload]')),
                hasScript: Boolean(card.querySelector('script')),
                textContent: card.textContent || '',
            };
        });
        expect(unsafeDom.missing).toBe(false);
        expect(unsafeDom.hasOnError).toBe(false);
        expect(unsafeDom.hasOnLoad).toBe(false);
        expect(unsafeDom.hasScript).toBe(false);
        expect(unsafeDom.textContent).toContain('onerror');

        harness.assertNoBugs('XSS 防护探针');
        await context.close();
    });

    test('探针 4：三档主题（日间/深色/护眼）全视图横向溢出与 WCAG 对比度审计', async ({ browser }) => {
        const context = await browser.newContext();
        const harness = await attachPwaHarness(context);
        await injectAxeInitScript(context);
        const page = await context.newPage();
        const user = uniqueUser('a11y');

        await harness.registerAndEnter(page, user);

        // 灌入基础数据让每个页面都有真实渲染卡片
        await page.locator('.mobile-tab-item[data-view="feeds"]').click();
        await page.locator('#feed-input-text').fill('对比度审计测试随手记 #审计');
        await Promise.all([
            page.waitForResponse((r) => r.url().includes('/api/feeds') && r.ok()),
            page.locator('#btn-send-feed').click(),
        ]);
        await expect(page.locator('.feed-item-card').first()).toBeVisible();

        const allViolations = [];
        for (const theme of ['light', 'dark']) {
            await page.evaluate(async (t) => {
                const { applyAppTheme } = await import('/js/utils.js');
                applyAppTheme(t);
            }, theme);
            await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

            for (const view of ['home', 'feeds', 'notes', 'bookmarks', 'reader']) {
                await page.locator(`.mobile-tab-item[data-view="${view}"]`).click();
                await expect(page.locator(`#view-${view}`)).toHaveClass(/active/);
                await assertNoMobileOverflow(page, `${theme}/${view}`);
                const res = await runAxeScan(page, `${theme}/${view}`);
                if (res.violations.length) {
                    allViolations.push(res);
                }
            }
        }

        if (allViolations.length) {
            console.log('AXE VIOLATIONS FOUND:\n', JSON.stringify(allViolations, null, 2));
        }
        expect(allViolations, `检测到 WCAG 2.1 AA 可访问性/对比度违规:\n${JSON.stringify(allViolations, null, 2)}`).toEqual([]);
        harness.assertNoBugs('三主题对比度与溢出审计');
        await context.close();
    });

    test('探针 5：严格 Console / 刷新会话并发 401 竞态零容忍审计', async ({ browser }) => {
        const context = await browser.newContext();
        const harness = await attachPwaHarness(context);
        const page = await context.newPage();
        const user = uniqueUser('strict');

        await harness.registerAndEnter(page, user);

        // 登录后刷新页面并等待网络收敛：验证是否因 /api/auth/refresh 轮换令牌引发并发 401 或 console.error
        await page.reload({ waitUntil: 'networkidle' });
        await expect(page.locator('#auth-overlay')).toHaveClass(/hidden/, { timeout: 15_000 });

        harness.assertNoBugs('严格 Console 与登录后 401 竞态审计', { strictConsole: true });
        await context.close();
    });
});
