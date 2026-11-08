import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createVaultServer, readConfig } from '../server/http.mjs';

const worker = '/assets/import-download.worker-fixture.js';
const page = '<!doctype html><title>Keevault</title>';

async function setup(context, env = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'keevault-static-'));
    const staticRoot = join(directory, 'dist');
    const fixtureVault = join(directory, 'original.kdbx');
    const vaultBytes = Buffer.from('fixture bytes outside the static root');
    await mkdir(join(staticRoot, 'assets'), { recursive: true });
    await Promise.all([
        writeFile(join(staticRoot, 'index.html'), page),
        writeFile(join(staticRoot, worker.slice(1)), 'self.onmessage = () => {};'),
        writeFile(join(staticRoot, 'assets', 'index-fixture.js'), 'export {};'),
        writeFile(join(staticRoot, 'unpublished.kdbx'), 'fixture bytes inside the static root'),
        writeFile(fixtureVault, vaultBytes),
    ]);
    let app;
    context.after(async () => {
        await app?.close();
        await rm(directory, { recursive: true, force: true });
    });
    app = await createVaultServer({ ...readConfig({ VAULT_PATH: fixtureVault, ...env }), staticRoot });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const origin = 'http://127.0.0.1:' + app.server.address().port;
    return { url: (path = '/') => origin + path, fixtureVault, vaultBytes };
}

function statusWithHost(url, host) {
    return new Promise((resolve, reject) => {
        get(url, { headers: { Host: host } }, (response) => {
            response.resume();
            resolve(response.statusCode);
        }).on('error', reject);
    });
}

function connections(policy) {
    return policy.split('; ').find((directive) => directive.startsWith('connect-src ')).split(' ').slice(1);
}

test('the server only serves static assets and health, without any vault file route or write method', async (context) => {
    const { url, fixtureVault, vaultBytes } = await setup(context);
    const index = await fetch(url());
    assert.equal(index.status, 200);
    assert.equal(await index.text(), page);
    const head = await fetch(url(), { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(page)));
    assert.equal(await head.text(), '');
    assert.equal((await fetch(url('/healthz'))).status, 204);
    for (const path of ['/api/vault', '/api/events', '/data/vault.kdbx', '/unpublished.kdbx', '/%2e%2e%2foriginal.kdbx']) {
        assert.equal((await fetch(url(path))).status, 404);
    }
    for (const method of ['PUT', 'POST', 'PATCH', 'DELETE']) {
        const response = await fetch(url('/api/vault'), { method, body: Buffer.from('client data') });
        assert.equal(response.status, 405);
        assert.equal(response.headers.get('allow'), 'GET, HEAD');
    }
    assert.deepEqual(await readFile(fixtureVault), vaultBytes);
});

test('the runtime cloud config exposes only configured public application identifiers', async (context) => {
    const { url } = await setup(context, {
        CLOUD_ONEDRIVE_CLIENT_ID: '  example-microsoft-id  ',
        CLOUD_GOOGLE_CLIENT_ID: 'example-google-id',
        CLOUD_DROPBOX_CLIENT_ID: '   ',
        GOOGLE_CLIENT_SECRET: 'test private value',
    });
    const response = await fetch(url('/cloud-config.json'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
        onedrive: { clientId: 'example-microsoft-id', tenant: 'common' },
        google: { clientId: 'example-google-id' },
    });
    assert.deepEqual(readConfig({}).cloud, {});
    assert.deepEqual(readConfig({ CLOUD_DROPBOX_CLIENT_ID: 'example-dropbox-id' }).cloud, {
        dropbox: { clientId: 'example-dropbox-id' },
    });
    assert.equal(readConfig({ CLOUD_ONEDRIVE_CLIENT_ID: 'id', CLOUD_ONEDRIVE_TENANT: 'organizations' }).cloud.onedrive.tenant, 'organizations');
});

test('only the specific download worker can make requests to arbitrary HTTPS URLs', async (context) => {
    const { url } = await setup(context);
    const main = await fetch(url());
    const mainPolicy = main.headers.get('content-security-policy');
    assert.match(mainPolicy, /script-src 'self' 'wasm-unsafe-eval'/);
    assert.deepEqual(connections(mainPolicy), [
        "'self'", 'https://login.microsoftonline.com', 'https://graph.microsoft.com',
        'https://www.googleapis.com', 'https://api.dropboxapi.com', 'https://content.dropboxapi.com',
    ]);
    const module = await fetch(url('/assets/index-fixture.js'));
    assert.equal(module.headers.get('content-security-policy'), mainPolicy);
    const download = await fetch(url(worker));
    assert.equal(download.status, 200);
    assert.deepEqual(connections(download.headers.get('content-security-policy')), ['https:']);
    assert.equal((await fetch(url('/assets/import-download.worker-missing.js'))).headers.get('content-security-policy'), mainPolicy);
});

test('Host and origin restrictions and optional Basic authentication still apply', async (context) => {
    const { url } = await setup(context, { VAULT_HTTP_USER: 'reader', VAULT_HTTP_PASSWORD: 'http password' });
    assert.equal(await statusWithHost(url(), 'attacker.example'), 421);
    const response = await fetch(url());
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /^Basic /);
    assert.equal((await fetch(url('/cloud-config.json'))).status, 401);
    assert.equal((await fetch(url('/healthz'))).status, 204);
    const authorization = 'Basic ' + Buffer.from('reader:http password').toString('base64');
    assert.equal((await fetch(url(), { headers: { authorization } })).status, 200);
    assert.equal((await fetch(url('/cloud-config.json'), { headers: { authorization, Origin: 'https://attacker.example' } })).status, 403);
    assert.equal((await fetch(url('/cloud-config.json'), { headers: { authorization, 'Sec-Fetch-Site': 'same-site' } })).status, 403);
    const config = await fetch(url('/cloud-config.json'), { headers: { authorization } });
    assert.deepEqual(await config.json(), {});
});
