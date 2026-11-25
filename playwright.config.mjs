import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

function resolveLocalChromePath() {
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
        return process.env.CHROME_PATH;
    }
    const candidates = process.platform === 'win32'
        ? [
            'C:/Program Files/Google/Chrome/Application/chrome.exe',
            'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
            process.env.LOCALAPPDATA
                ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe')
                : '',
        ]
        : process.platform === 'darwin'
            ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
            : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
    return candidates.find((p) => p && fs.existsSync(p));
}

const localChrome = resolveLocalChromePath();

export default defineConfig({
    testDir: './tests',
    timeout: 60_000,
    expect: {
        timeout: 10_000,
    },
    fullyParallel: false,
    workers: 1, // Single isolated local Wrangler D1 + controllable Fake Externals
    retries: 0, // Zero retries so flaky/race bugs surface immediately instead of being masked
    reporter: [
        ['list'],
        ['html', { open: 'never', outputFolder: 'playwright-report' }],
        ['./src/reporters/bug-reporter.mjs', { outputFile: 'test-results/bug-report.md' }],
    ],
    globalSetup: './src/env/orchestrator.mjs',
    use: {
        launchOptions: {
            ...(localChrome ? { executablePath: localChrome } : {}),
            args: ['--no-sandbox'],
        },
        serviceWorkers: 'allow', // Critical: test real Service Worker offline & cache lifecycle
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
        actionTimeout: 10_000,
        navigationTimeout: 20_000,
    },
    projects: [
        {
            name: 'mobile-pwa',
            use: {
                ...devices['iPhone 14'],
                // Keep Chromium / local Chrome engine while enforcing mobile viewport & touch
                browserName: 'chromium',
                viewport: { width: 390, height: 844 },
                hasTouch: true,
                isMobile: true,
            },
        },
        // Reserved for Phase 2 Desktop Web parity:
        // {
        //     name: 'desktop-web',
        //     use: {
        //         viewport: { width: 1280, height: 800 },
        //         hasTouch: false,
        //         isMobile: false,
        //     },
        // },
    ],
});
