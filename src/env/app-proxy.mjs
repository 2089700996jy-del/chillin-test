import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
};

/**
 * Local same-origin static server + /api/* reverse proxy to local wrangler dev.
 * Replays Chillin's CSP & Trusted Types headers (adapted for http://127.0.0.1) so
 * real browser runs catch any CSP or Trusted Types violations immediately.
 */
export function createAppProxyServer({ publicDir, wranglerOrigin }) {
    // Same CSP hash allowlist & Trusted Types enforcement as public/_headers, minus upgrade-insecure-requests
    const LOCAL_CSP = [
        "default-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "object-src 'none'",
        "frame-src 'none'",
        "script-src 'self' 'sha256-Mq81jcs71LPrFhsUMRnnXA3wRXBUjd2vzOxLfy+PRSc=' 'sha256-5+zDwXlOqyZqQHUII7XJ2cRjzyTxPEveaQDQC9oRLZ4=' 'sha256-HvH7sVf6BfOj3H403dgMIaGABQf8vNCbZH89efba3SY='",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https: http://127.0.0.1:*",
        "connect-src 'self'",
        "worker-src 'self'",
        "manifest-src 'self'",
        "require-trusted-types-for 'script'",
        "trusted-types chillin#html dompurify"
    ].join('; ');

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url || '/', 'http://127.0.0.1');

            // Proxy /api/* to local Wrangler Worker
            if (url.pathname.startsWith('/api/')) {
                const targetUrl = new URL(url.pathname + url.search, wranglerOrigin);
                const headers = new Headers();
                for (const [k, v] of Object.entries(req.headers)) {
                    if (v === undefined) continue;
                    const lk = k.toLowerCase();
                    if (lk === 'host' || lk === 'connection' || lk === 'content-length' || lk === 'x-e2e-client-ip') continue;
                    if (Array.isArray(v)) {
                        for (const item of v) headers.append(k, item);
                    } else {
                        headers.set(k, v);
                    }
                }
                const virtualIp = req.headers['x-e2e-client-ip'];
                if (typeof virtualIp === 'string' && virtualIp) {
                    headers.set('X-Chillin-Client-IP', virtualIp);
                    headers.set('X-Chillin-Proxy-Token', 'e2e-proxy-secret');
                }

                let bodyBuf;
                if (req.method !== 'GET' && req.method !== 'HEAD') {
                    const chunks = [];
                    for await (const c of req) chunks.push(c);
                    bodyBuf = Buffer.concat(chunks);
                }

                const upstream = await fetch(targetUrl, {
                    method: req.method,
                    headers,
                    body: bodyBuf,
                    redirect: 'manual',
                });

                const outHeaders = {};
                upstream.headers.forEach((v, k) => {
                    const lk = k.toLowerCase();
                    if (lk === 'transfer-encoding' || lk === 'content-encoding' || lk === 'content-length') return;
                    if (lk === 'set-cookie') return; // handled via getSetCookie
                    outHeaders[k] = v;
                });
                const cookies = typeof upstream.headers.getSetCookie === 'function'
                    ? upstream.headers.getSetCookie()
                    : [];
                if (cookies.length) outHeaders['set-cookie'] = cookies;

                res.writeHead(upstream.status, outHeaders);
                if (upstream.body) {
                    const reader = upstream.body.getReader();
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        res.write(value);
                    }
                }
                res.end();
                return;
            }

            // Static file resolution under D:\7\chillin\public
            let reqPath = decodeURIComponent(url.pathname);
            if (reqPath === '/') reqPath = '/index.html';

            // Serve local same-origin config.js override at HTTP boundary (never mutating chillin repo on disk)
            if (reqPath === '/js/config.js') {
                res.writeHead(200, {
                    'Content-Type': 'text/javascript; charset=utf-8',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Content-Security-Policy': LOCAL_CSP,
                });
                res.end(
                    "export const CLOUD_WORKER_BASE = '';\n"
                    + "export function resolveApiBase() { return ''; }\n"
                );
                return;
            }

            const resolved = path.resolve(publicDir, '.' + reqPath);
            if (!resolved.startsWith(path.resolve(publicDir))) {
                res.writeHead(403);
                res.end('Forbidden');
                return;
            }
            if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
                res.writeHead(404);
                res.end('Not found');
                return;
            }

            const ext = path.extname(resolved).toLowerCase();
            const contentType = MIME_TYPES[ext] || 'application/octet-stream';
            const headers = {
                'Content-Type': contentType,
                'X-Content-Type-Options': 'nosniff',
                'X-Frame-Options': 'DENY',
                'Cross-Origin-Opener-Policy': 'same-origin',
                'Content-Security-Policy': LOCAL_CSP,
            };
            if (reqPath === '/sw.js' || reqPath === '/index.html' || reqPath === '/version.json' || reqPath === '/js/version.js') {
                headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
            } else {
                headers['Cache-Control'] = 'no-cache, must-revalidate';
            }
            res.writeHead(200, headers);
            fs.createReadStream(resolved).pipe(res);
        } catch (err) {
            console.error('[app-proxy] error:', err);
            if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Local proxy error', detail: String(err?.message || err) }));
        }
    });

    return {
        start: (port = 0) => new Promise((resolve) => {
            server.listen(port, '127.0.0.1', () => {
                const addr = server.address();
                resolve({ port: addr.port, origin: `http://127.0.0.1:${addr.port}` });
            });
        }),
        stop: () => new Promise((resolve) => server.close(() => resolve())),
    };
}
