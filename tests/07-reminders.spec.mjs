import { test, expect } from '@playwright/test';
import { attachPwaHarness } from '../src/support/pwa-harness.mjs';
import { uniqueUser } from '../src/support/test-data.mjs';

test.describe('Reminders 提醒 HTTP 边界验证 (L3)', () => {
    test('HTTP 创建提醒在未绑定微信通道时给出明确 400 提示且不崩溃', async ({ browser }) => {
        const context = await browser.newContext();
        const harness = await attachPwaHarness(context);
        const page = await context.newPage();
        const user = uniqueUser('rem');

        await harness.registerAndEnter(page, user);

        const fireAt = Date.now() + 5 * 60_000;
        const createRes = await page.request.post(`${harness.runtime.appOrigin}/api/reminders`, {
            data: { text: '喝水休息一下', fire_at_ms: fireAt },
        });
        expect(createRes.status()).toBe(400);
        const body = await createRes.json();
        expect(String(body.error || '')).toMatch(/微信|绑定/);

        harness.assertNoBugs('Reminders HTTP 未绑定校验');
        await context.close();
    });
});
