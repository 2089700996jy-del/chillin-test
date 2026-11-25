import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
const MIGRATIONS_DIR = path.join(CHILLIN_ROOT, 'migrations');

const E2E_TMP_ROOT = process.env.E2E_TMP_DIR
    ? path.resolve(process.env.E2E_TMP_DIR)
    : path.resolve(CHILLIN_ROOT, '..', '.tmp');
const STATE_DIR_ABS = path.join(E2E_TMP_ROOT, 'e2e-wrangler-state');
const STATE_DIR_REL = path.relative(CHILLIN_ROOT, STATE_DIR_ABS) || STATE_DIR_ABS;
const WORKERD_TMP = path.join(E2E_TMP_ROOT, 'e2e-workerd-tmp');

let activeHandles = null;

function validateChillinWorkspace() {
    if (!fs.existsSync(CHILLIN_ROOT)) {
        throw new Error(`CHILLIN_ROOT does not exist: ${CHILLIN_ROOT}`);
    }
    if (!fs.existsSync(WRANGLER_CONFIG)) {
        throw new Error(`wrangler.toml not found at: ${WRANGLER_CONFIG}`);
    }
    if (!fs.existsSync(PUBLIC_DIR) || !fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
        throw new Error(`Chillin public/ directory invalid at: ${PUBLIC_DIR}`);
    }
    if (!fs.existsSync(MIGRATIONS_DIR)) {
        throw new Error(`Chillin migrations/ directory missing at: ${MIGRATIONS_DIR}`);
    }
    const toml = fs.readFileSync(WRANGLER_CONFIG, 'utf8');
    if (!/main\s*=\s*"workers\/api\.js"/.test(toml)) {
        throw new Error(`wrangler.toml at ${WRANGLER_CONFIG} does not point to workers/api.js`);
    }
    if (!/\[\[d1_databases\]\]/.test(toml) || !/\[\[r2_buckets\]\]/.test(toml)) {
        throw new Error(`wrangler.toml must declare local [[d1_databases]] and [[r2_buckets]] bindings`);
    }
}

function collectChillinMetadata() {
    let gitSha = 'unknown';
    let gitDirty = false;
    try {
        gitSha = execSync('git rev-parse --short HEAD', { cwd: CHILLIN_ROOT, encoding: 'utf8' }).trim();
        const status = execSync('git status --porcelain', { cwd: CHILLIN_ROOT, encoding: 'utf8' }).trim();
        gitDirty = status.length > 0;
    } catch { /* ignore if not git repo */ }

    let appVersion = 'unknown';
    try {
        const apiSrc = fs.readFileSync(path.join(CHILLIN_ROOT, 'workers/api.js'), 'utf8');
        const m = apiSrc.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
        if (m) appVersion = m[1];
    } catch { /* ignore */ }

    let latestMigration = 'unknown';
    let migrationCount = 0;
    try {
        const sqlFiles = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
        migrationCount = sqlFiles.length;
        if (sqlFiles.length) latestMigration = sqlFiles[sqlFiles.length - 1];
    } catch { /* ignore */ }

    return {
        chillinRoot: CHILLIN_ROOT,
        gitSha,
        gitDirty,
        appVersion,
        latestMigration,
        migrationCount,
        nodeVersion: process.version,
        platform: `${process.platform} (${process.arch})`,
    };
}

function cleanEnvForLocal() {
    const env = { ...process.env };
    // Prevent accidental remote Cloudflare access or proxy interference
    delete env.CLOUDFLARE_API_TOKEN;
    delete env.CF_API_TOKEN;
    delete env.CLOUDFLARE_ACCOUNT_ID;
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
                if (json && json.ok) return json;
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
            try {
                process.kill(-pid, 'SIGKILL');
            } catch {
                process.kill(pid, 'SIGKILL');
            }
        }
    } catch { /* ignore already exited */ }
}

export async function globalSetup() {
    validateChillinWorkspace();
    const chillinMeta = collectChillinMetadata();
    const testRunId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(2).toString('hex')}`;

    fs.mkdirSync(TMP_DIR, { recursive: true });
    try {
        fs.rmSync(STATE_DIR_ABS, { recursive: true, force: true });
        fs.rmSync(WORKERD_TMP, { recursive: true, force: true });
    } catch { /* ignore */ }
    fs.mkdirSync(STATE_DIR_ABS, { recursive: true });
    fs.mkdirSync(WORKERD_TMP, { recursive: true });

    const env = cleanEnvForLocal();
    const cleanupStack = [];
    const rollback = async () => {
        while (cleanupStack.length) {
            const fn = cleanupStack.pop();
            await fn().catch(() => {});
        }
    };

    try {
        // 1. Start controllable fake externals (LLM + iLink Bot simulation)
        const fakeExt = createFakeExternalsServer();
        const fakeExtInfo = await fakeExt.start();
        cleanupStack.push(() => fakeExt.stop());

        // 2. Apply all D1 migrations strictly to isolated local D1
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

        // Verify local D1 sqlite store was actually created inside STATE_DIR_ABS
        const d1Dir = path.join(STATE_DIR_ABS, 'v3', 'd1');
        if (!fs.existsSync(d1Dir)) {
            throw new Error(`Local D1 directory missing after migrations: ${d1Dir}`);
        }

        // 3. Spawn real local Wrangler Worker (local mode only, detached on POSIX for process-group kill)
        const wranglerPort = await getFreePort();
        const inspectorPort = await getFreePort();
        const wranglerOrigin = `http://127.0.0.1:${wranglerPort}`;
        const wranglerLogPath = path.join(TMP_DIR, 'wrangler.log');
        const logStream = fs.createWriteStream(wranglerLogPath, { flags: 'w' });
        cleanupStack.push(() => new Promise((r) => logStream.end(r)));

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
                detached: process.platform !== 'win32',
                stdio: ['ignore', 'pipe', 'pipe'],
            }
        );
        cleanupStack.push(async () => killTree(wranglerProc.pid));
        wranglerProc.stdout.pipe(logStream);
        wranglerProc.stderr.pipe(logStream);

        // 4. Start same-origin static + /api/* reverse proxy server
        const appProxy = createAppProxyServer({
            publicDir: PUBLIC_DIR,
            wranglerOrigin,
        });
        const appInfo = await appProxy.start(0);
        cleanupStack.push(() => appProxy.stop());

        // 5. Wait until full stack (/api/health -> D1) is ready
        try {
            await waitForHealth(`${appInfo.origin}/api/health`, 45000);
        } catch (err) {
            const logs = fs.existsSync(wranglerLogPath) ? fs.readFileSync(wranglerLogPath, 'utf8') : '';
            throw new Error(`${err.message}\n--- wrangler.log ---\n${logs.slice(-2000)}`);
        }

        writeRuntime({
            testRunId,
            startedAt: new Date().toISOString(),
            appOrigin: appInfo.origin,
            wranglerOrigin,
            fakeExtOrigin: fakeExtInfo.origin,
            stateDir: STATE_DIR_ABS,
            wranglerPid: wranglerProc.pid,
            chillinMeta,
        });

        activeHandles = { rollback };

        return async () => {
            await teardown();
        };
    } catch (err) {
        await rollback();
        throw err;
    }
}

export async function teardown() {
    if (activeHandles) {
        await activeHandles.rollback();
        activeHandles = null;
    } else {
        try {
            const rt = readRuntime();
            killTree(rt.wranglerPid);
        } catch { /* ignore */ }
    }
}

export default globalSetup;
