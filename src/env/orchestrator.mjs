import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import {
    CHILLIN_ROOT,
    TMP_DIR,
    getFreePort,
    writeRuntime,
    readRuntime,
} from './ports.mjs';
import { createFakeExternalsServer } from './fake-externals.mjs';
import { createAppProxyServer } from './app-proxy.mjs';

const WRANGLER_CONFIG = path.join(CHILLIN_ROOT, 'wrangler.toml');
const PUBLIC_DIR = path.join(CHILLIN_ROOT, 'public');
// Resolve temp state relative to CHILLIN_ROOT (or E2E_TMP_DIR) to avoid non-ASCII path & ACL issues in workerd
const E2E_TMP_ROOT = process.env.E2E_TMP_DIR
    ? path.resolve(process.env.E2E_TMP_DIR)
    : path.resolve(CHILLIN_ROOT, '..', '.tmp');
const STATE_DIR_ABS = path.join(E2E_TMP_ROOT, 'e2e-wrangler-state');
const STATE_DIR_REL = path.relative(CHILLIN_ROOT, STATE_DIR_ABS) || STATE_DIR_ABS;
const WORKERD_TMP = path.join(E2E_TMP_ROOT, 'e2e-workerd-tmp');

let activeHandles = null;

function cleanEnvForLocal() {
    const env = { ...process.env };
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
    delete env.http_proxy;
    delete env.https_proxy;
    delete env.ALL_PROXY;
    delete env.all_proxy;
    env.NO_PROXY = '127.0.0.1,localhost';
    env.CI = '1';
    env.TEMP = WORKERD_TMP;
    env.TMP = WORKERD_TMP;
    return env;
}

function runSyncChecked(cmd, args, cwd, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            cwd,
            env,
            shell: process.platform === 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve({ out, err });
            else reject(new Error(`Command failed (${code}): ${cmd} ${args.join(' ')}\n${out}\n${err}`));
        });
    });
}

async function waitForHealth(url, timeoutMs = 45000) {
    const start = Date.now();
    let lastErr = '';
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(url);
            if (res.ok) {
                const json = await res.json();
                if (json && json.ok) return;
                lastErr = JSON.stringify(json);
            } else {
                lastErr = `HTTP ${res.status}`;
            }
        } catch (err) {
            lastErr = String(err?.message || err);
        }
        await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`Timed out waiting for ${url}: ${lastErr}`);
}

function killTree(pid) {
    if (!pid) return;
    try {
        if (process.platform === 'win32') {
            execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
        } else {
            process.kill(-pid, 'SIGKILL');
        }
    } catch { /* ignore already exited */ }
}

export async function globalSetup() {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    // Start with a fresh isolated local D1 + R2 state every run
    try {
        fs.rmSync(STATE_DIR_ABS, { recursive: true, force: true });
        fs.rmSync(WORKERD_TMP, { recursive: true, force: true });
    } catch { /* ignore */ }
    fs.mkdirSync(STATE_DIR_ABS, { recursive: true });
    fs.mkdirSync(WORKERD_TMP, { recursive: true });

    const env = cleanEnvForLocal();

    // 1. Start controllable fake externals (LLM / fault injection)
    const fakeExt = createFakeExternalsServer();
    const fakeExtInfo = await fakeExt.start();

    // 2. Apply all D1 migrations to isolated local D1
    await runSyncChecked(
        'npx',
        [
            'wrangler', 'd1', 'migrations', 'apply', 'DB',
            '--local',
            '--config', WRANGLER_CONFIG,
            '--persist-to', STATE_DIR_REL,
        ],
        CHILLIN_ROOT,
        env
    );

    // 3. Spawn real local Wrangler Worker (with registration enabled & fake LLM wired)
    const wranglerPort = await getFreePort();
    const inspectorPort = await getFreePort();
    const wranglerOrigin = `http://127.0.0.1:${wranglerPort}`;
    const wranglerLogPath = path.join(TMP_DIR, 'wrangler.log');
    const logStream = fs.createWriteStream(wranglerLogPath, { flags: 'w' });

    const wranglerProc = spawn(
        'npx',
        [
            'wrangler', 'dev',
            '--config', WRANGLER_CONFIG,
            '--local',
            '--ip', '127.0.0.1',
            '--port', String(wranglerPort),
            '--inspector-port', String(inspectorPort),
            '--persist-to', STATE_DIR_REL,
            '--show-interactive-dev-session=false',
            '--test-scheduled',
            '--var', 'ALLOW_REGISTRATION:true',
            '--var', 'PROXY_SHARED_SECRET:e2e-proxy-secret',
            '--var', `LLM_API_BASE:${fakeExtInfo.origin}/v1`,
            '--var', 'LLM_API_KEY:e2e-fake-key',
            '--var', 'VISION_API_KEY:e2e-fake-key',
        ],
        {
            cwd: CHILLIN_ROOT,
            env,
            shell: process.platform === 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
        }
    );
    wranglerProc.stdout.pipe(logStream);
    wranglerProc.stderr.pipe(logStream);

    // 4. Start same-origin static + /api/* reverse proxy server
    const appProxy = createAppProxyServer({
        publicDir: PUBLIC_DIR,
        wranglerOrigin,
    });
    const appInfo = await appProxy.start(0);

    // 5. Wait until full stack (/api/health -> D1) is ready
    try {
        await waitForHealth(`${appInfo.origin}/api/health`, 45000);
    } catch (err) {
        killTree(wranglerProc.pid);
        await appProxy.stop();
        await fakeExt.stop();
        const logs = fs.existsSync(wranglerLogPath) ? fs.readFileSync(wranglerLogPath, 'utf8') : '';
        throw new Error(`${err.message}\n--- wrangler.log ---\n${logs.slice(-2000)}`);
    }

    writeRuntime({
        appOrigin: appInfo.origin,
        wranglerOrigin,
        fakeExtOrigin: fakeExtInfo.origin,
        stateDir: STATE_DIR_ABS,
        wranglerPid: wranglerProc.pid,
    });

    activeHandles = { fakeExt, appProxy, wranglerProc, logStream };

    return async () => {
        await teardown();
    };
}

export async function teardown() {
    if (activeHandles) {
        killTree(activeHandles.wranglerProc?.pid);
        await activeHandles.appProxy?.stop().catch(() => {});
        await activeHandles.fakeExt?.stop().catch(() => {});
        activeHandles.logStream?.end();
        activeHandles = null;
    } else {
        try {
            const rt = readRuntime();
            killTree(rt.wranglerPid);
        } catch { /* ignore */ }
    }
}

export default globalSetup;
