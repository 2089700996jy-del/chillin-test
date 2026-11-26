import { test, expect } from '@playwright/test';
import {
    attachPwaHarness,
    setExternalFaultMode,
    getExternalControlState,
} from '../src/support/pwa-harness.mjs';
import { uniqueUser } from '../src/support/test-data.mjs';

test.describe('P1/P2 AI 记忆回响、Agent 目标闭环与外部异常降级探针', () => {
    test.afterEach(async () => {
        await setExternalFaultMode({ mode: 'ok', delayMs: 0, clearRequests: true }).catch(() => {});
    });

    test('AI 记忆回响验证历史记录真实进入 LLM 上下文，且上游 500 故障时优雅降级', async ({ browser }) => {
        const context = await browser.newContext();
        const harness = await attachPwaHarness(context);
        const page = await context.newPage();
        const user = uniqueUser('echo');

        await harness.registerAndEnter(page, user);

        // 先创建一条带独特关键词的随手记提供花园语料
        const uniqueMarker = `番茄工作法_${Date.now()}`;
        await page.locator('.mobile-tab-item[data-view="feeds"]').click();
        await page.locator('#feed-input-text').fill(`今天开始研究 ${uniqueMarker} 与深度阅读结合 #效率`);
        await Promise.all([
            page.waitForResponse((r) => r.url().includes('/api/feeds') && r.ok()),
            page.locator('#btn-send-feed').click(),
        ]);
        await expect(page.locator('.feed-item-card', { hasText: uniqueMarker })).toBeVisible();

        await setExternalFaultMode({ mode: 'ok', delayMs: 0, clearRequests: true });

        // 打开 AI 记忆回响弹窗并提问
        await page.locator('#btn-open-ai-chat').click();
        await expect(page.locator('#ai-chat-modal')).toHaveClass(/active|open|show|visible/i);
        await page.locator('#ai-chat-input').fill('我之前研究过什么工作法？');
        await Promise.all([
            page.waitForResponse((r) => r.url().includes('/api/ai/chat') && r.ok()),
            page.locator('#btn-send-ai-chat').click(),
        ]);

        await expect(page.locator('#ai-chat-body')).toContainText('本地仿真 AI 的记忆回响', { timeout: 15_000 });

        // 严格校验检索到的历史记录确实进入了发往 LLM 的上下文 messages 中
        const extState = await getExternalControlState();
        expect(extState.requests.length).toBeGreaterThan(0);
        const promptSerialized = JSON.stringify(extState.requests.map((r) => r.messages));
        expect(promptSerialized, 'LLM 请求上下文中未包含用户真实历史记录').toContain(uniqueMarker);

        harness.assertNoBugs('AI 记忆回响正常流');

        // 故障注入：让上游 LLM 返回 500，验证前端降级不崩溃
        harness.setAllowServerErrors(true);
        harness.setAllowConsoleErrors(true);
        await setExternalFaultMode({ mode: 'error500', delayMs: 0 });

        // 发送命中花园语料的提问，确保真实触发上游 LLM 请求并命中 500 故障注入
        await page.locator('#ai-chat-input').fill(`请结合 ${uniqueMarker} 测试上游故障降级`);
        await Promise.all([
            page.waitForResponse((r) => r.url().includes('/api/ai/chat')),
            page.locator('#btn-send-ai-chat').click(),
        ]);

        expect(harness.state.pageErrors).toEqual([]);
        await expect(page.locator('#ai-chat-input')).toBeEnabled();
        await expect(page.locator('#ai-chat-body')).toContainText(/当前大模型未响应|失败|错误|重试|异常|不可用/, { timeout: 5000 });

        await context.close();
    });

    test('Agent 目标创建、实际任务拆解、D1 持久化与刷新后状态保留', async ({ browser }) => {
        const context = await browser.newContext();
        const harness = await attachPwaHarness(context);
        const page = await context.newPage();
        const user = uniqueUser('goal');

        await harness.registerAndEnter(page, user);

        await page.locator('#btn-open-agent-goals').click();
        await expect(page.locator('#agent-goals-modal')).toHaveClass(/active|open|show|visible/i);

        const goalTitle = '整理本周 AI 笔记并形成学习提纲';
        await page.locator('#agent-goal-title').fill(goalTitle);
        await page.locator('#agent-goal-desc').fill('输出一份简明提纲供复习使用');
        await Promise.all([
            page.waitForResponse((r) => r.url().includes('/api/agent/goals') && r.request().method() === 'POST' && r.ok()),
            page.locator('#agent-goal-form button[type="submit"]').click(),
        ]);

        // 等待拆解计划返回并渲染
        await expect(page.locator('#agent-goals-modal')).toContainText(goalTitle, { timeout: 15_000 });
        await expect(page.locator('#agent-goals-modal')).toContainText('梳理已有笔记与随手记线索', { timeout: 15_000 });

        // 校验后端目标与任务列表真实持久化
        const goalsRes = await page.request.get(`${harness.runtime.appOrigin}/api/agent/goals`);
        expect(goalsRes.ok()).toBe(true);
        const goalsData = await goalsRes.json();
        const createdGoal = (goalsData.goals || goalsData).find((g) => g.title === goalTitle);
        expect(createdGoal, 'Agent 目标未在 D1 持久化').toBeTruthy();

        const detailRes = await page.request.get(`${harness.runtime.appOrigin}/api/agent/goals/${createdGoal.id}`);
        expect(detailRes.ok()).toBe(true);
        const detailJson = await detailRes.json();
        expect(Array.isArray(detailJson.tasks) && detailJson.tasks.length >= 2, 'Agent 目标缺少已持久化的拆解任务').toBe(true);

        // 刷新页面重新打开目标面板，确认目标和任务状态保留
        await page.reload({ waitUntil: 'load' });
        await expect(page.locator('#auth-overlay')).toHaveClass(/hidden/, { timeout: 15_000 });
        await page.locator('#btn-open-agent-goals').click();
        await expect(page.locator('#agent-goals-modal')).toContainText(goalTitle, { timeout: 10_000 });

        harness.assertNoBugs('Agent 目标创建与持久化');
        await context.close();
    });
});
