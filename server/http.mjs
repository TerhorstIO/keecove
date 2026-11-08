import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mimeTypes = {
    '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon', '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
    '.webp': 'image/webp', '.woff2': 'font/woff2', '.zip': 'application/zip',
};
const loopback = ['localhost', '127.0.0.1', '[::1]'];
const providerConnections = [
    'https://login.microsoftonline.com', 'https://graph.microsoft.com', 'https://www.googleapis.com',
    'https://api.dropboxapi.com', 'https://content.dropboxapi.com',
];
const contentSecurityPolicy = [
    "default-src 'none'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self'",
    "img-src 'self' data:", "connect-src 'self' " + providerConnections.join(' '),
    "worker-src 'self'", "font-src 'self'", "object-src 'none'", "base-uri 'none'",
    "form-action 'self'", "frame-ancestors 'none'",
].join('; ');
const downloadWorkerPolicy = "default-src 'none'; script-src 'self'; connect-src https:";
const downloadWorkerPath = /^\/assets\/import-download\.worker-[A-Za-z0-9_-]+\.js$/;

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function readPort(value = '8080') {
    const port = Number(value);
    if (!/^\d+$/.test(value) || port < 1 || port > 65535) {
        throw new Error('PORT must be an integer between 1 and 65535.');
    }
    return port;
}

function readOrigin(value) {
    if (!value) return null;
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error('PUBLIC_ORIGIN must be a valid HTTPS origin or HTTP loopback origin.');
    }
    const secure = url.protocol === 'https:' || (url.protocol === 'http:' && loopback.includes(url.hostname));
    if (!secure || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('PUBLIC_ORIGIN must be an HTTPS origin or HTTP loopback origin without a path.');
    }
    return url;
}

function authDigest(value) {
    return createHash('sha256').update(value).digest();
}

export function readConfig(env = process.env) {
    const username = env.VAULT_HTTP_USER;
    const password = env.VAULT_HTTP_PASSWORD;
    if ((username || password) && (!username || !password || username.includes(':'))) {
        throw new Error('Set both VAULT_HTTP_USER and VAULT_HTTP_PASSWORD. The username cannot contain a colon.');
    }
    const certPath = env.TLS_CERT_PATH;
    const keyPath = env.TLS_KEY_PATH;
    if (Boolean(certPath) !== Boolean(keyPath)) {
        throw new Error('Set both TLS_CERT_PATH and TLS_KEY_PATH to enable HTTPS.');
    }

    const cloud = {};
    if (env.CLOUD_ONEDRIVE_CLIENT_ID?.trim()) {
        cloud.onedrive = {
            clientId: env.CLOUD_ONEDRIVE_CLIENT_ID.trim(),
            tenant: env.CLOUD_ONEDRIVE_TENANT?.trim() || 'common',
        };
    }
    if (env.CLOUD_GOOGLE_CLIENT_ID?.trim()) cloud.google = { clientId: env.CLOUD_GOOGLE_CLIENT_ID.trim() };
    if (env.CLOUD_DROPBOX_CLIENT_ID?.trim()) cloud.dropbox = { clientId: env.CLOUD_DROPBOX_CLIENT_ID.trim() };

    return {
        port: readPort(env.PORT),
        listenHost: env.LISTEN_HOST ?? '127.0.0.1',
        origin: readOrigin(env.PUBLIC_ORIGIN),
        tls: certPath ? { certPath, keyPath } : null,
        auth: username ? authDigest(username + ':' + password) : null,
        cloud,
        staticRoot: fileURLToPath(new URL('../dist/', import.meta.url)),
    };
}

function expectedOrigin(host, boundPort, configured, secure) {
    if (configured) return host === configured.host ? configured.origin : null;
    const defaultPort = secure ? 443 : 80;
    const scheme = secure ? 'https' : 'http';
    for (const name of loopback) {
        const authority = boundPort === defaultPort ? name : name + ':' + boundPort;
        if (authority === host) return scheme + '://' + authority;
    }
    return null;
}

function allowedUser(authorization, expectedDigest) {
    if (!expectedDigest) return true;
    if (!authorization || !/^Basic [A-Za-z0-9+/]+=*$/i.test(authorization)) return false;
    return timingSafeEqual(authDigest(Buffer.from(authorization.slice(6), 'base64')), expectedDigest);
}

function checkRequestOrigin(request, origin) {
    const fetchSite = request.headers['sec-fetch-site'];
    if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) {
        throw new HttpError(403, 'Cross-origin requests are disabled.');
    }
    if (request.headers.origin && request.headers.origin !== origin) {
        throw new HttpError(403, 'Cross-origin requests are disabled.');
    }
}

async function sendFile(request, response, path, staticRoot) {
    let pathname;
    try {
        pathname = decodeURIComponent(path);
    } catch {
        throw new HttpError(400, 'Invalid path.');
    }
    if (pathname === '/') pathname = '/index.html';
    if (/[\\:\0]/.test(pathname) || pathname.split('/').some((segment) => segment.startsWith('.'))) {
        throw new HttpError(404, 'Not found.');
    }
    const file = resolve(staticRoot, '.' + pathname);
    const inside = relative(staticRoot, file);
    const mime = mimeTypes[extname(file)];
    if (inside.startsWith('..') || isAbsolute(inside) || !mime) throw new HttpError(404, 'Not found.');

    const info = await stat(file).catch((error) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
        throw error;
    });
    if (!info?.isFile()) throw new HttpError(404, 'Not found.');
    if (downloadWorkerPath.test(pathname)) response.setHeader('Content-Security-Policy', downloadWorkerPolicy);
    response.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': info.size,
        'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(file).on('error', () => response.destroy()).pipe(response);
}

function sendError(request, response, error) {
    if (response.headersSent || response.destroyed) {
        response.destroy();
        return;
    }
    const status = error instanceof HttpError ? error.status : 500;
    const message = status === 500 ? 'Keevault could not access the file.' : error.message;
    if (status === 500) console.error('Keevault request failed.', error.code ?? error.name);
    const body = JSON.stringify({ error: message });
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : body);
}

export async function createVaultServer(config = readConfig()) {
    const options = { headersTimeout: 15000, requestTimeout: 120000 };
    const listener = (request, response) => {
        route(request, response).catch((error) => sendError(request, response, error));
    };
    let server;
    if (config.tls) {
        const [cert, key] = await Promise.all([readFile(config.tls.certPath), readFile(config.tls.keyPath)]);
        server = createHttpsServer({ ...options, cert, key, minVersion: 'TLSv1.2' }, listener);
    } else {
        server = createHttpServer(options, listener);
    }

    async function route(request, response) {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Security-Policy', contentSecurityPolicy);
        response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('X-Frame-Options', 'DENY');
        if (!request.url?.startsWith('/') || request.url.startsWith('//')) throw new HttpError(400, 'Invalid path.');
        const { pathname } = new URL(request.url, 'http://request.invalid');

        if (!['GET', 'HEAD'].includes(request.method)) {
            response.setHeader('Allow', 'GET, HEAD');
            response.setHeader('Connection', 'close');
            throw new HttpError(405, 'Method not allowed.');
        }
        if (pathname === '/healthz') {
            response.writeHead(204).end();
            return;
        }

        const origin = expectedOrigin(request.headers.host?.toLowerCase(), server.address()?.port, config.origin, Boolean(config.tls));
        if (!origin) throw new HttpError(421, 'Host is not configured for Keevault.');
        if (!allowedUser(request.headers.authorization, config.auth)) {
            response.setHeader('WWW-Authenticate', 'Basic realm="Keevault", charset="UTF-8"');
            throw new HttpError(401, 'Authentication required.');
        }
        if (pathname === '/cloud-config.json') {
            checkRequestOrigin(request, origin);
            const body = JSON.stringify(config.cloud ?? {});
            response.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(body),
            }).end(request.method === 'HEAD' ? undefined : body);
            return;
        }

        if (pathname.startsWith('/api/')) throw new HttpError(404, 'Not found.');
        await sendFile(request, response, pathname, config.staticRoot);
    }

    return {
        server,
        async close() {
            if (!server.listening) return;
            await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        },
    };
}
