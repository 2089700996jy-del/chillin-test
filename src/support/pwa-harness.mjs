import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { expect } from '@playwright/test';
import { readRuntime } from '../env/ports.mjs';

const require = createRequire(import.meta.url);
const axePath = require.resolve('axe-core/axe.min.js');
const AXE_SOURCE = fs.readFileSync(axePath, 'utf8');

/**
 * Attaches production firewall, virtual per-context IP isolation, and zero-tolerance
 * runtime monitors (pageerror, console.error, post-auth 401s, 5xx, static 4xx) to a BrowserContext.
 * Exposes registerAndEnter / loginAndEnter directly on the returned harness so authenticated
 * monitoring is always enabled automatically.
 */
export async function attachPwaHarness(context, options = {}) {
    const runtime = readRuntime();
    const rnd = crypto.randomBytes(2);
    const virtualIp = `10.20.${(rnd[0] % 240) + 1}.${(rnd[1] % 240) + 1}`;
    await context.setExtraHTTPHeaders({ 'x-e2e-client-ip': virtualIp });

    const state = {
        authenticated: false,
        pageErrors: [],
        consoleErrors: [],
        postAuth401s: [],
        api5xx: [],
        staticErrors: [],
        allowServerErrors: Boolean(options.allowServerErrors),
        allowConsoleErrors: Boolean(options.allowConsoleErrors),
    };

    // Guardrail: never allow tests to silently hit production Pages/Worker
    await context.route(/^https:\/\/(chillin-bfc\.pages\.dev|chillin-api\.2089700996jy\.workers\.dev)\b/, (route) => {
        route.abort('blockedbyclient');
    });

    const wirePage = (page) => {
        page.on('pageerror', (err) => {
            state.pageErrors.push(`[pageerror] ${err?.message || String(err)}`);
        });
        page.on('console', (msg) => {
            if (msg.type() === 'error') {
                const text = msg.text();
                if (state.allowConsoleErrors) return;
                if (text.includes('net::ERR_INTERNET_DISCONNECTED') || text.includes('Failed to load resource: net::ERR_FAILED')) return;
                state.consoleErrors.push(`[console.error] ${text}`);
            }
        });
        page.on('response', (res) => {
            const url = res.url();
            if (!url.startsWith(runtime.appOrigin)) return;
            const pathname = new URL(url).pathname;
            if (pathname.startsWith('/api/')) {
                if (res.status() === 401 && state.authenticated) {
                    state.postAuth401s.push(`[401 after login] ${res.request().method()} ${pathname}`);
                }
                if (res.status() >= 500 && !state.allowServerErrors) {
                    state.api5xx.push(`[${res.status()}] ${res.request().method()} ${pathname}`);
                }
            } else if (res.status() >= 400 && !pathname.includes('favicon')) {
                state.staticErrors.push(`[${res.status()}] ${pathname}`);
            }
        });
    };

    context.on('page', wirePage);
    for (const p of context.pages()) wirePage(p);

    const harness = {
        runtime,
        state,
        markAuthenticated() { state.authenticated = true; },
        setAllowServerErrors(v) { state.allowServerErrors = v; },
        setAllowConsoleErrors(v) { state.allowConsoleErrors = v; },
        clearBugs() {
            state.pageErrors.length = 0;
            state.consoleErrors.length = 0;
            state.postAuth401s.length = 0;
            state.api5xx.length = 0;
            state.staticErrors.length = 0;
        },
        assertNoBugs(label = 'Page health', { strictConsole = false } = {}) {
            const problems = [
                ...state.pageErrors,
                ...state.api5xx,
                ...state.staticErrors,
                ...(strictConsole ? state.consoleErrors : []),
                ...(strictConsole ? state.postAuth401s : []),
            ];
            expect(problems, `${label} detected unexpected runtime/network errors:\n${problems.join('\n')}`).toEqual([]);
        },
        /**
         * Registers a brand-new user via UI and automatically enables post-auth monitoring.
         */
        async registerAndEnter(page, user) {
            await page.goto(runtime.appOrigin + '/', { waitUntil: 'load' });
            await expect(page.locator('#auth-overlay')).toBeVisible();
            await expect(page.locator('#auth-overlay')).not.toHaveClass(/hidden/);

            await page.locator('#auth-tab-register').click();
            await expect(page.locator('#auth-tab-register')).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });
            await page.locator('#auth-username').fill(user.username);
            await page.locator('#auth-password').fill(user.password);
            await page.locator('#btn-auth-submit').click();

            await expect(page.locator('#auth-overlay')).toHaveClass(/hidden/, { timeout: 15_000 });
            await expect(page.locator('#nav-username')).toContainText(user.username, { timeout: 10_000 });
            state.authenticated = true;
        },
        /**
         * Logs into an existing user via UI and automatically enables post-auth monitoring.
         */
        async loginAndEnter(page, user) {
            await page.goto(runtime.appOrigin + '/', { waitUntil: 'load' });
            await expect(page.locator('#auth-overlay')).not.toHaveClass(/hidden/);

            await page.locator('#auth-tab-login').click();
            await expect(page.locator('#auth-tab-login')).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });
            await page.locator('#auth-username').fill(user.username);
            await page.locator('#auth-password').fill(user.password);
            await page.locator('#btn-auth-submit').click();

            await expect(page.locator('#auth-overlay')).toHaveClass(/hidden/, { timeout: 15_000 });
            await expect(page.locator('#nav-username')).toContainText(user.username, { timeout: 10_000 });
            state.authenticated = true;
        },
    };

    return harness;
}

/**
 * Ensures the Service Worker is activated and controlling the current page.
 */
export async function waitForServiceWorkerReady(page) {
    const controlled = await page.evaluate(async () => {
        if (!('serviceWorker' in navigator)) return { supported: false };
        const reg = await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) {
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, 4000);
                navigator.serviceWorker.addEventListener('controllerchange', () => {
                    clearTimeout(timer);
                    resolve();
                }, { once: true });
            });
        }
        const cacheKeys = await caches.keys();
        let cachedCount = 0;
        if (cacheKeys.length) {
            const cache = await caches.open(cacheKeys[0]);
            const reqs = await cache.keys();
            cachedCount = reqs.length;
        }
        return {
            supported: true,
            active: Boolean(reg.active),
            hasController: Boolean(navigator.serviceWorker.controller),
            cacheKeys,
            cachedCount,
        };
    });
    expect(controlled.supported).toBe(true);
    expect(controlled.active).toBe(true);
    expect(controlled.hasController).toBe(true);
    expect(controlled.cachedCount).toBeGreaterThan(25);
    return controlled;
}

/**
 * Verifies Mobile PWA viewport has zero unintended horizontal overflow.
 */
export async function assertNoMobileOverflow(page, label) {
    const metrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        bodyScrollWidth: document.body.scrollWidth,
    }));
    expect(
        metrics.scrollWidth,
        `[${label}] Horizontal overflow detected: scrollWidth=${metrics.scrollWidth} > innerWidth=${metrics.innerWidth}`
    ).toBeLessThanOrEqual(metrics.innerWidth + 1);
}

export async function injectAxeInitScript(context) {
    await context.addInitScript(AXE_SOURCE);
}

/**
 * Runs WCAG 2.1 AA accessibility & color-contrast scan via axe-core.
 * Expects injectAxeInitScript(context) to have pre-loaded window.axe safely under Trusted Types.
 */
export async function runAxeScan(page, label) {
    const hasAxe = await page.evaluate(() => typeof window.axe !== 'undefined');
    if (!hasAxe) {
        throw new Error('axe-core not initialized; call injectAxeInitScript(context) before navigation');
    }
    const violations = await page.evaluate(async () => {
        const res = await window.axe.run(document, {
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
        });
        return res.violations.map((v) => ({
            id: v.id,
            impact: v.impact,
            description: v.description,
            count: v.nodes.length,
            targets: v.nodes.slice(0, 4).map((n) => n.target.join(' ')),
        }));
    });
    return { label, violations };
}

/**
 * Controls the local Fake Externals server (e.g. inject 500, slow response, or restore ok).
 */
export async function setExternalFaultMode(patch) {
    const { fakeExtOrigin } = readRuntime();
    const res = await fetch(`${fakeExtOrigin}/__control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`Failed to set fake externals mode: ${res.status}`);
    return res.json();
}
