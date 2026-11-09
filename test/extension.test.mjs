import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { fillLogin, requestVault } from '../extension/injections.js';

const extension = new URL('../extension/', import.meta.url);

test('Firefox and Chromium manifests share the same narrow permissions and UI', async () => {
  const readManifest = async (name) => JSON.parse(await readFile(new URL(name, extension), 'utf8'));
  const { minimum_chrome_version: minimumChrome, ...chromium } = await readManifest('manifest.json');
  const { browser_specific_settings: { gecko }, ...firefox } = await readManifest('manifest.firefox.json');

  assert.deepEqual(firefox, chromium);
  assert.equal(chromium.manifest_version, 3);
  assert.equal(minimumChrome, '106');
  assert.equal(gecko.strict_min_version, '153.0');
  assert.equal(gecko.id, '@keecove');
  assert.deepEqual(gecko.data_collection_permissions.required, ['none']);
  assert.deepEqual(chromium.permissions, ['activeTab', 'scripting', 'storage']);
  assert.equal(chromium.host_permissions, undefined);
  assert.deepEqual(chromium.action.default_icon, { 16: chromium.icons[16], 32: chromium.icons[32] });

  for (const [size, path] of Object.entries(chromium.icons)) {
    const png = await readFile(new URL(path, extension));
    assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), Number(size));
    assert.equal(png.readUInt32BE(20), Number(size));
  }
});

test('vault bridge rejects a different port, path, insecure context, or child frame', async () => {
  const expectedUrl = 'https://vault.example.test:8443/';
  const request = { action: 'fill', origin: 'https://login.example.test', id: 'fixture' };
  const answer = { status: 'ok', entry: { username: 'fixture', password: 'fixture-only' } };
  const calls = [];

  function invoke({ href = expectedUrl, secure = true, topLevel = true } = {}) {
    const window = {
      isSecureContext: secure,
      keevaultBrowser: { async request(value) { calls.push(value); return answer; } },
    };
    window.top = topLevel ? window : {};
    return runInNewContext(`(${requestVault})(expectedUrl, request)`, {
      window, location: { href }, expectedUrl, request,
    });
  }

  assert.equal(invoke({ href: 'https://vault.example.test:9443/' }), null);
  assert.equal(invoke({ href: 'https://vault.example.test:8443/other' }), null);
  assert.equal(invoke({ secure: false }), null);
  assert.equal(invoke({ topLevel: false }), null);
  assert.equal(calls.length, 0);
  assert.deepEqual(await invoke(), answer);
  assert.deepEqual(calls, [request]);
});

test('autofill refuses a different origin before inspecting or updating page fields', () => {
  const window = { isSecureContext: true };
  window.top = window;
  const result = runInNewContext(`(${fillLogin})(expectedOrigin, credential)`, {
    window,
    location: { origin: 'https://login.example.test:9443' },
    expectedOrigin: 'https://login.example.test:8443',
    credential: { username: 'fixture', password: 'fixture-only' },
  });
  assert.equal(result, false);
});
