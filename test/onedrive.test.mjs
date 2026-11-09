import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectOneDrive } from '../src/onedrive.js';
import { CloudAuthError, VaultSourceConflictError } from '../src/vault-source.js';

const origin = 'https://graph.microsoft.com';
const file = { id: 'vault', name: 'Vault.KDBX', kind: 'file', driveId: 'drive' };
const cloudFile = { provider: 'onedrive', id: file.id, driveId: file.driveId, name: file.name };
const header = [0x03, 0xd9, 0xa2, 0x9a, 0x67, 0xfb, 0x4b, 0xb5, 0x01, 0, 0x04, 0];

function metadata(eTag, extra) {
  return { id: file.id, name: file.name, parentReference: { driveId: file.driveId }, eTag, ...extra };
}

test('OneDrive scopes credentials to Graph and recovers a signed download URL from full metadata', async (t) => {
  const nextPage = `${origin}/v1.0/me/drive/root/children?$skiptoken=opaque`;
  const signedUrl = 'https://download.files.1drv.com/example?sig=fixture';
  const fileBytes = Uint8Array.from(header).buffer;
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(url.href);
    assert.equal(url.origin, origin);
    assert.equal(options.headers.Authorization, 'Bearer token');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    if (url.searchParams.has('$skiptoken')) {
      return Response.json({ value: [{ id: 'folder', name: 'Work', folder: {} }] });
    }
    if (url.pathname.endsWith('/children')) {
      return Response.json({
        value: [
          { id: 'ignored', name: 'Other.txt', file: {} },
          { id: 'vault', name: 'Vault.KDBX', file: {}, parentReference: { driveId: 'drive' } }
        ],
        '@odata.nextLink': nextPage
      });
    }
    if (!url.searchParams.has('$select')) return Response.json(metadata('revision', { '@downloadUrl': signedUrl }));
    return Response.json(metadata('revision'));
  });

  const client = await connectOneDrive({
    clientId: 'example',
    async authenticate(options) {
      assert.equal(options.provider, 'onedrive');
      assert.equal(options.clientId, 'example');
      assert.equal(options.scope, `${origin}/Files.ReadWrite`);
      assert.equal(options.tokenUrl, 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
      return 'token';
    },
    async downloadUrl(url, signal) {
      assert.equal(url, signedUrl);
      assert.ok(signal instanceof AbortSignal);
      return fileBytes;
    }
  });

  const first = await client.list();
  assert.equal(first.nextPage, nextPage);
  assert.deepEqual(first.items.map(({ name, kind }) => ({ name, kind })), [{ name: 'Vault.KDBX', kind: 'file' }]);
  assert.equal((await client.list(null, first.nextPage)).items[0].kind, 'folder');
  assert.deepEqual(await client.open(first.items[0]), { bytes: fileBytes, revision: '"revision"', cloudFile });
  assert.equal(new URL(requests[2]).pathname, '/v1.0/drives/drive/items/vault');
  assert.equal(new URL(requests[3]).search, '');
  await assert.rejects(client.list(null, 'https://elsewhere.example/v1.0/me/drive/root/children'));
  assert.equal(requests.length, 5);
});

test('OneDrive only returns bytes for a stable revision and writes with a strong precondition', async (t) => {
  const bytes = Uint8Array.from([...header, 1]).buffer;
  const oldBytes = Uint8Array.from([...header, 0]).buffer;
  const oldLink = 'https://tenant.sharepoint.com/_layouts/15/download.aspx?temp=old';
  const newLink = 'https://tenant.sharepoint.com/_layouts/15/download.aspx?temp=new';
  let metadataRequests = 0;
  let writes = 0;
  let beforeCommitCalls = 0;
  let expired = false;
  let advanced = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.origin, origin);
    if (expired) return new Response(null, { status: 401 });
    if (options.method === 'PUT') {
      assert.equal(url.pathname, '/v1.0/drives/drive/items/vault/content');
      assert.equal(options.headers['If-Match'], '"current"');
      assert.equal(options.headers['Content-Type'], 'text/plain');
      assert.equal(options.body, bytes);
      assert.equal(beforeCommitCalls, writes + 1);
      writes++;
      if (writes === 1) return new Response(null, { status: 412 });
      return Response.json(metadata(writes === 2 ? '"updated"' : undefined));
    }
    metadataRequests++;
    const first = metadataRequests === 1;
    const includesDownload = url.searchParams.get('$select')?.includes('@microsoft.graph.downloadUrl');
    return Response.json(metadata(first ? 'stale' : advanced ? '"different"' : '"current"', includesDownload ? {
      '@microsoft.graph.downloadUrl': first ? oldLink : newLink
    } : undefined));
  });
  const client = await connectOneDrive({
    clientId: 'example',
    authenticate: async () => 'token',
    downloadUrl: async (url) => url === oldLink ? oldBytes : bytes
  });
  const opened = await client.open(file);
  assert.deepEqual(opened, { bytes, revision: '"current"', cloudFile });
  assert.equal(metadataRequests, 4);
  const source = client.source(opened.cloudFile);
  assert.equal(await source.read(opened.revision), null);
  assert.equal(metadataRequests, 5);

  await assert.rejects(source.write(bytes, '*'), /keine gültige Dateiversion/);
  await assert.rejects(source.write(bytes, opened.revision, { beforeCommit() { throw new Error('revoked'); } }), /revoked/);
  assert.equal(writes, 0);
  const options = { async beforeCommit() { beforeCommitCalls++; } };
  await assert.rejects(source.write(bytes, opened.revision, options), VaultSourceConflictError);
  assert.equal(await source.write(bytes, opened.revision, options), '"updated"');
  assert.equal(await source.write(bytes, opened.revision, options), undefined);
  advanced = true;
  await assert.rejects(source.write(bytes, opened.revision, options), VaultSourceConflictError);
  assert.equal(writes, 3);
  assert.equal(beforeCommitCalls, 3);
  expired = true;
  await assert.rejects(source.read(opened.revision), CloudAuthError);
});
