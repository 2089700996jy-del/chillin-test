import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CHILLIN_ROOT } from '../../src/env/ports.mjs';
import { openMigratedLocalD1 } from '../../src/support/local-d1.mjs';
import { startL2FakeExternals } from '../../src/support/l2-harness.mjs';

const weatherUrl = pathToFileURL(path.join(CHILLIN_ROOT, 'workers/src/bot-weather.js')).href;
const clawUrl = pathToFileURL(path.join(CHILLIN_ROOT, 'workers/src/bot-claw.js')).href;

test('L2 Weather 智能晨报：舒适静默、极端天气触发、同日幂等与上游 500 降级', async () => {
    const fakeExt = await startL2FakeExternals();
    const db = openMigratedLocalD1();

    try {
        const { runMorningWeatherCare } = await import(weatherUrl);
        const { upsertQrcode, markBound } = await import(clawUrl);

        await db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'weather_u1', 'hash')").run();
        await upsertQrcode(db, 1, 'qr-weather-1');
        await markBound(db, 1, {
            baseurl: fakeExt.origin,
            botToken: 'fake-bot-token',
            ilinkBotId: 'fake-bot-1',
            ilinkUserId: 'wx-weather-1',
        });
        await db.prepare('UPDATE bot_claw_accounts SET outreach_enabled = 1 WHERE user_id = 1').run();

        const env = {
            DB: db,
            QWEATHER_KEY: 'fake-qweather-key',
            QWEATHER_API_HOST: new URL(fakeExt.origin).host,
        };
        const fakeFetch = (url, init) => {
            const target = String(url).replace(/^https:\/\/[^/]+/, fakeExt.origin);
            return fetch(target, init);
        };
        const morning8amMs = Date.UTC(2026, 10, 25, 0, 5, 0); // 东八区 2026-11-25 08:05

        // 1. 舒适天气：应保持静默（无事不扰），且 failed === 0
        await fakeExt.setFaultMode({ weatherScenario: 'calm', clearRequests: true });
        const calmRes = await runMorningWeatherCare(env, db, fakeFetch, { nowMs: morning8amMs });
        assert.equal(calmRes.checked, 1);
        assert.equal(calmRes.notified, 0);
        assert.equal(calmRes.silent, 1);
        assert.equal(calmRes.failed, 0, '正常静默时 failed 必须为 0');
        assert.equal((await fakeExt.getControlState()).ilinkSentMessages.length, 0);

        // 2. 极端暴雨预警：应触发一次晨报并标记 notified=1
        await fakeExt.setFaultMode({ weatherScenario: 'rain_storm', clearRequests: true });
        const stormRes = await runMorningWeatherCare(env, db, fakeFetch, { nowMs: morning8amMs + 60_000 });
        assert.equal(stormRes.notified, 1);
        assert.equal(stormRes.failed, 0);
        assert.equal((await fakeExt.getControlState()).ilinkSentMessages.length, 1);

        const dailyRow = await db.prepare("SELECT notified FROM bot_weather_daily WHERE user_id = 1 AND date = '2026-11-25'").first();
        assert.equal(dailyRow?.notified, 1);

        // 3. 同一天再次执行：必须幂等静默，不重复打扰
        const repeatRes = await runMorningWeatherCare(env, db, fakeFetch, { nowMs: morning8amMs + 120_000 });
        assert.equal(repeatRes.notified, 0);
        assert.equal(repeatRes.silent, 1);
        assert.equal(repeatRes.failed, 0);
        assert.equal((await fakeExt.getControlState()).ilinkSentMessages.length, 1);

        // 4. 次日上游 QWeather 500：必须明确计入 failed=1，不得伪装为正常静默，且不误标 notified=1
        const nextDay8amMs = morning8amMs + 24 * 3600 * 1000;
        await fakeExt.setFaultMode({ weatherScenario: 'error500', clearRequests: true });
        const errRes = await runMorningWeatherCare(env, db, fakeFetch, { nowMs: nextDay8amMs });
        assert.equal(errRes.notified, 0);
        assert.equal(errRes.silent, 0, '上游 API 500 不得计入正常静默');
        assert.equal(errRes.failed, 1, '上游 API 500 必须计入 failed=1');
        const nextDayRow = await db.prepare("SELECT notified FROM bot_weather_daily WHERE user_id = 1 AND date = '2026-11-26'").first();
        assert.equal(nextDayRow, null);

        // 5. 暴雨预警但 iLink 回信推送 500 失败：必须计入 failed=1，且 notified 保持 0
        await fakeExt.setFaultMode({ weatherScenario: 'rain_storm', ilinkSendFail: true, clearRequests: true });
        const sendFailRes = await runMorningWeatherCare(env, db, fakeFetch, { nowMs: nextDay8amMs + 60_000 });
        assert.equal(sendFailRes.notified, 0);
        assert.equal(sendFailRes.failed, 1, 'iLink 推送失败必须计入 failed=1');
        const sendFailRow = await db.prepare("SELECT notified FROM bot_weather_daily WHERE user_id = 1 AND date = '2026-11-26'").first();
        assert.equal(sendFailRow?.notified, 0, '推送失败不得误标 notified=1');
    } finally {
        db.close();
        await fakeExt.close();
    }
});

