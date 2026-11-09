import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createVaultServer, readConfig } from '../server/http.mjs';

const worker = '/assets/import-download.worker-fixture.js';
const page = '<!doctype html><title>KeeCove</title>';
const extensionArchive = 'extension archive fixture';

async function setup(context, env = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'keevault-static-'));
    const staticRoot = join(directory, 'dist');
    const fixtureVault = join(directory, 'original.kdbx');
    const vaultBytes = Buffer.from('fixture bytes outside the static root');
    await mkdir(join(staticRoot, 'assets'), { recursive: true });
    await Promise.all([
        writeFile(join(staticRoot, 'index.html'), page),
        writeFile(join(staticRoot, 'keecove-browser.zip'), extensionArchive),
        writeFile(join(staticRoot, 'keecove-firefox.xpi'), extensionArchive),
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

function getWithHeaders(url, headers) {
    return new Promise((resolve, reject) => {
        get(url, { headers }, (response) => {
            response.on('end', () => resolve(response));
            response.on('error', reject);
            response.resume();
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
    for (const path of ['/keecove-browser.zip', '/keevault-browser.zip']) {
        const archive = await fetch(url(path));
        assert.equal(archive.status, 200);
        assert.equal(archive.headers.get('content-type'), 'application/zip');
        assert.equal(await archive.text(), extensionArchive);
    }
    const xpi = await fetch(url('/keecove-firefox.xpi'));
    assert.equal(xpi.status, 200);
    assert.equal(xpi.headers.get('content-type'), 'application/x-xpinstall');
    assert.equal(await xpi.text(), extensionArchive);
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

test('the extension config serves validated store and signed XPI URLs without caching', async (context) => {
    const chrome = 'https://chromewebstore.google.com/detail/keecove/abcdefghijklmnopabcdefghijklmnop?hl=de';
    const edge = 'https://microsoftedge.microsoft.com/addons/detail/keecove/ponmlkjihgfedcbaponmlkjihgfedcba';
    const firefox = 'https://addons.mozilla.org/de/firefox/addon/keecove/';
    const { url } = await setup(context, {
        EXTENSION_CHROME_URL: '  ' + chrome + '  ',
        EXTENSION_EDGE_URL: edge,
        EXTENSION_FIREFOX_URL: firefox,
    });

    const endpoint = url('/extension-config.json');
    const response = await fetch(endpoint);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { chrome, edge, firefox });
    const head = await fetch(endpoint, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), response.headers.get('content-length'));
    assert.equal(await head.text(), '');

    const signedXpi = 'https://vault.example:8443/keecove.xpi';
    assert.deepEqual(readConfig({ EXTENSION_FIREFOX_URL: signedXpi }).extensions, { firefox: signedXpi });
    assert.deepEqual(readConfig({ EXTENSION_CHROME_URL: '', EXTENSION_EDGE_URL: '   ' }).extensions, {});
    assert.deepEqual(readConfig({
        EXTENSION_CHROME_URL: chrome.replace('chromewebstore.google.com', 'chromewebstore.google.com.invalid'),
        EXTENSION_EDGE_URL: edge.replace('/detail/', '/search/'),
        EXTENSION_FIREFOX_URL: signedXpi.replace('https://', 'http://'),
    }).extensions, {});
    assert.deepEqual(readConfig({
        EXTENSION_CHROME_URL: chrome.replace('/keecove/', '/other%2Fkeecove/'),
        EXTENSION_EDGE_URL: edge.replace('ponmlkjihgfedcbaponmlkjihgfedcba', 'not-an-extension-id'),
        EXTENSION_FIREFOX_URL: signedXpi.replace('https://', 'https://user:password@'),
    }).extensions, {});
    assert.deepEqual(readConfig({
        EXTENSION_CHROME_URL: chrome.replace('https://', 'javascript:'),
        EXTENSION_EDGE_URL: edge.replace('https://', 'https://user@'),
        EXTENSION_FIREFOX_URL: firefox.replace('/addon/', '/search/'),
    }).extensions, {});
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

test('the HTTP backend honors an HTTPS public origin and rejects forged hosts and origins', async (context) => {
    const publicOrigin = 'https://vault.example:8443';
    const publicHost = new URL(publicOrigin).host;
    const { url } = await setup(context, { PUBLIC_ORIGIN: publicOrigin });

    assert.equal((await fetch(url('/healthz'))).status, 204);
    const index = await getWithHeaders(url(), { Host: publicHost });
    assert.equal(index.statusCode, 200);
    assert.equal(index.headers['www-authenticate'], undefined);
    assert.equal((await getWithHeaders(url(), {
        Host: 'attacker.example', 'X-Forwarded-Host': publicHost,
    })).statusCode, 421);

    for (const configPath of ['/cloud-config.json', '/extension-config.json']) {
        const configUrl = url(configPath);
        const config = await getWithHeaders(configUrl, { Host: publicHost, Origin: publicOrigin, 'Sec-Fetch-Site': 'same-origin' });
        assert.equal(config.statusCode, 200);
        assert.equal(config.headers['www-authenticate'], undefined);
        assert.equal((await getWithHeaders(configUrl, { Host: 'attacker.example', Origin: publicOrigin })).statusCode, 421);
        assert.equal((await getWithHeaders(configUrl, { Host: publicHost, Origin: 'https://attacker.example' })).statusCode, 403);
        assert.equal((await getWithHeaders(configUrl, { Host: publicHost, 'Sec-Fetch-Site': 'same-site' })).statusCode, 403);
    }
});
