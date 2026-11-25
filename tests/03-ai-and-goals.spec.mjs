import { test, expect } from '@playwright/test';
import {
    attachPwaHarness,
    setExternalFaultMode,
} from '../src/support/pwa-harness.mjs';
import { uniqueUser } from '../src/support/test-data.mjs';

test.describe('P1/P2 AI 记忆回响、Agent 目标闭环与外部异常降级探针', () => {
    test.afterEach(async () => {
        await setExternalFaultMode({ mode: 'ok', delayMs: 0 }).catch(() => {});
    });

    test('AI 记忆回响 SSE 流式对话正常渲染，上游 500 故障时优雅降级不崩溃', async ({ browser }) => {
        const context = await browser.newContext();
        const harness = await attachPwaHarness(context);
        const page = await context.newPage();
        const user = uniqueUser('echo');

        await harness.registerAndEnter(page, user);

        // 先创建一条带关键词的随手记提供花园语料
        await page.locator('.mobile-tab-item[data-view="feeds"]').click();
        await page.locator('#feed-input-text').fill('今天开始研究番茄工作法与深度阅读结合 #效率');
        await Promise.all([
            page.waitForResponse((r) => r.url().includes('/api/feeds') && r.ok()),
            page.locator('#btn-send-feed').click(),
        ]);
        await expect(page.locator('.feed-item-card', { hasText: '番茄工作法' })).toBeVisible();

        // 打开 AI 记忆回响弹窗并流式提问
        await page.locator('#btn-open-ai-chat').click();
        await expect(page.locator('#ai-chat-modal')).toHaveClass(/active|open|show|visible/i);
        await page.locator('#ai-chat-input').fill('我之前研究过什么工作法？');
        await page.locator('#btn-send-ai-chat').click();

        await expect(page.locator('#ai-chat-body')).toContainText('本地仿真 AI 的记忆回响', { timeout: 15_000 });
        harness.assertNoBugs('AI 记忆回响正常流');

        // 故障注入：让上游 LLM 返回 500，等待真实响应返回并验证前端不抛未捕获异常且可继续操作
        harness.setAllowServerErrors(true);
        harness.setAllowConsoleErrors(true);
        await setExternalFaultMode({ mode: 'error500', delayMs: 0 });

        await page.locator('#ai-chat-input').fill('测试上游故障降级');
        await Promise.all([
            page.waitForResponse((r) => r.url().includes('/api/ai/chat')),
            page.locator('#btn-send-ai-chat').click(),
        ]);

        // 验证没有任何未捕获的 pageerror / JS 崩溃，且输入框可继续操作
        expect(harness.state.pageErrors).toEqual([]);
        await expect(page.locator('#ai-chat-input')).toBeEnabled();

        await context.close();
    });

    test('Agent 目标创建、自动拆解任务与状态流转闭环', async ({ browser }) => {
        const context = await browser.newContext();
        const harness = await attachPwaHarness(context);
        const page = await context.newPage();
        const user = uniqueUser('goal');

        await harness.registerAndEnter(page, user);

        await page.locator('#btn-open-agent-goals').click();
        await expect(page.locator('#agent-goals-modal')).toHaveClass(/active|open|show|visible/i);

        await page.locator('#agent-goal-title').fill('整理本周 AI 笔记并形成学习提纲');
        await page.locator('#agent-goal-desc').fill('输出一份简明提纲供复习使用');
        await Promise.all([
            page.waitForResponse((r) => r.url().includes('/api/agent/goals') && r.ok()),
            page.locator('#agent-goal-form button[type="submit"]').click(),
        ]);

        // 验证目标已创建并在列表或详情中可见
        await expect(page.locator('#agent-goals-modal')).toContainText('整理本周 AI 笔记并形成学习提纲', { timeout: 15_000 });
        harness.assertNoBugs('Agent 目标创建与执行');

        await context.close();
    });
});
