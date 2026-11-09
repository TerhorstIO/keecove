import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectDropbox } from '../src/dropbox.js';
import { CloudAuthError, VaultSourceConflictError } from '../src/vault-source.js';

const cloudFile = { provider: 'dropbox', id: 'id:vault', name: 'Vault.KDBX' };
const revision = 'a1c10ce0dd78';
const nextRevision = 'a1c10ce0dd79';
const laterRevision = 'a1c10ce0dd7a';

function vaultBytes() {
  const bytes = new Uint8Array(64);
  bytes.set([0x03, 0xd9, 0xa2, 0x9a, 0x67, 0xfb, 0x4b, 0xb5, 0x01, 0, 0x04, 0]);
  return bytes;
}

function downloadResponse(bytes, rev = revision) {
  return new Response(bytes, { headers: { 'Dropbox-API-Result': JSON.stringify({ id: cloudFile.id, rev }) } });
}

test('Dropbox lists and opens the selected file by immutable ID with a short-lived token', async (t) => {
  const bytes = vaultBytes();
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, ...options });
    assert.equal(options.headers.Authorization, 'Bearer token');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    if (url.endsWith('/continue')) {
      return Response.json({
        entries: [
          { '.tag': 'file', id: 'id:note', name: 'Note.txt' },
          { '.tag': 'file', id: 'id:locked', name: 'Other.kdbx', is_downloadable: false },
          { '.tag': 'file', id: 'id:vault', name: 'Vault.KDBX', size: bytes.length }
        ],
        has_more: false
      });
    }
    if (url.endsWith('/list_folder')) {
      return Response.json({
        entries: [{ '.tag': 'folder', id: 'id:folder', name: 'Work' }],
        cursor: 'opaque',
        has_more: true
      });
    }
    return downloadResponse(bytes);
  });

  const client = await connectDropbox({
    clientId: 'example',
    async authenticate(options) {
      assert.equal(options.provider, 'dropbox');
      assert.equal(options.scope, 'files.metadata.read files.content.read files.content.write');
      assert.equal(options.authorizeParams.token_access_type, 'online');
      return 'token';
    }
  });

  const first = await client.list();
  assert.equal(first.nextPage, 'opaque');
  assert.equal(first.items[0].kind, 'folder');
  const second = await client.list(null, first.nextPage);
  assert.deepEqual(second.items.map(({ name }) => name), ['Vault.KDBX']);
  assert.deepEqual(await client.open(second.items[0]), { bytes: bytes.buffer, revision, cloudFile });
  assert.equal(requests[0].url, 'https://api.dropboxapi.com/2/files/list_folder');
  assert.deepEqual(JSON.parse(requests[0].body), { path: '', limit: 100 });
  assert.equal(requests[1].url, 'https://api.dropboxapi.com/2/files/list_folder/continue');
  assert.deepEqual(JSON.parse(requests[1].body), { cursor: 'opaque' });
  assert.equal(requests[2].url, 'https://content.dropboxapi.com/2/files/download');
  assert.deepEqual(JSON.parse(requests[2].headers['Dropbox-API-Arg']), { path: 'id:vault' });
});

test('Dropbox skips unchanged revisions and uses the revision attached to a changed download', async (t) => {
  const bytes = vaultBytes();
  let latest = revision;
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://api.dropboxapi.com/2/files/get_metadata') {
      assert.deepEqual(JSON.parse(options.body), { path: cloudFile.id });
      return Response.json({ id: cloudFile.id, rev: latest });
    }
    assert.equal(url, 'https://content.dropboxapi.com/2/files/download');
    assert.deepEqual(JSON.parse(options.headers['Dropbox-API-Arg']), { path: cloudFile.id });
    downloads++;
    return downloadResponse(bytes, laterRevision);
  });
  const connection = await connectDropbox({ clientId: 'example', authenticate: async () => 'token' });
  const source = connection.source(cloudFile);
  assert.equal(source.label, 'Dropbox');
  assert.equal(await source.read(revision), null);
  assert.equal(downloads, 0);
  latest = nextRevision;
  assert.deepEqual(await source.read(revision), { bytes: bytes.buffer, revision: laterRevision });
  assert.equal(downloads, 1);
});

test('Dropbox writes KDBX bytes with strict revision matching on the original immutable ID', async (t) => {
  const bytes = vaultBytes();
  const signal = new AbortController().signal;
  let checked = false;
  let writes = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(checked, true);
    assert.equal(url, 'https://content.dropboxapi.com/2/files/upload');
    assert.equal(options.headers.Authorization, 'Bearer token');
    assert.equal(options.headers['Content-Type'], 'application/octet-stream');
    assert.deepEqual(JSON.parse(options.headers['Dropbox-API-Arg']), {
      path: cloudFile.id, mode: { '.tag': 'update', update: revision }, autorename: false, strict_conflict: true
    });
    assert.equal(options.body, bytes.buffer);
    return ++writes === 1
      ? Response.json({ id: cloudFile.id, rev: nextRevision })
      : Response.json({ error: { '.tag': 'path', path: { '.tag': 'conflict' } } }, { status: 409 });
  });
  const connection = await connectDropbox({ clientId: 'example', authenticate: async () => 'token' });
  const source = connection.source(cloudFile);
  assert.equal(await source.write(bytes.buffer, revision, { signal, beforeCommit: async () => { checked = true; } }), nextRevision);
  await assert.rejects(source.write(bytes.buffer, revision), VaultSourceConflictError);
  await assert.rejects(source.write(bytes.buffer, undefined), VaultSourceConflictError);
  await assert.rejects(source.write(new ArrayBuffer(64), revision), /KDBX/);
  await assert.rejects(source.write(bytes.buffer, revision, {
    beforeCommit: async () => { throw new Error('session expired'); }
  }), /session expired/);
  assert.equal(writes, 2);
});

test('Dropbox rejects downloads without an attached revision and reports expired authorization', async (t) => {
  const bytes = vaultBytes();
  let response = new Response(bytes);
  t.mock.method(globalThis, 'fetch', async () => response);
  const connection = await connectDropbox({ clientId: 'example', authenticate: async () => 'token' });
  const source = connection.source(cloudFile);
  await assert.rejects(source.read(), /keine Dateiversion/);
  response = new Response(bytes, {
    headers: { 'Dropbox-API-Result': JSON.stringify({ id: 'id:other', rev: revision }) }
  });
  await assert.rejects(source.read(), VaultSourceConflictError);
  response = new Response(null, { status: 401 });
  await assert.rejects(source.read(), CloudAuthError);
});
