import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

export const TEST_ROOT = path.resolve(import.meta.dirname, '../..');

function resolveChillinRoot() {
    if (process.env.CHILLIN_ROOT) return path.resolve(process.env.CHILLIN_ROOT);
    const candidates = [
        path.resolve(TEST_ROOT, '..', 'chillin'),
        path.resolve(TEST_ROOT, '..', '7', 'chillin'),
        path.resolve(TEST_ROOT, 'chillin'),
    ];
    return candidates.find((p) => fs.existsSync(path.join(p, 'wrangler.toml'))) || candidates[0];
}

export const CHILLIN_ROOT = resolveChillinRoot();
export const TMP_DIR = path.join(TEST_ROOT, '.tmp');
export const RUNTIME_FILE = path.join(TMP_DIR, 'runtime.json');

export function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            srv.close((err) => (err ? reject(err) : resolve(port)));
        });
    });
}

export function readRuntime() {
    if (!fs.existsSync(RUNTIME_FILE)) {
        throw new Error(`Runtime file not found at ${RUNTIME_FILE}. Is globalSetup running?`);
    }
    return JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
}

export function writeRuntime(data) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.writeFileSync(RUNTIME_FILE, JSON.stringify(data, null, 2), 'utf8');
}
