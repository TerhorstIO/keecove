import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectDropbox } from '../src/dropbox.js';

test('Dropbox lists and downloads through fixed read-only endpoints with a short-lived token', async (t) => {
  const bytes = new Uint8Array(64);
  bytes.set([0x03, 0xd9, 0xa2, 0x9a, 0x67, 0xfb, 0x4b, 0xb5, 0x01, 0, 0x04, 0]);
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
    return new Response(bytes);
  });

  const client = await connectDropbox({
    clientId: 'example',
    async authenticate(options) {
      assert.equal(options.provider, 'dropbox');
      assert.equal(options.scope, 'files.metadata.read files.content.read');
      assert.equal(options.authorizeParams.token_access_type, 'online');
      return 'token';
    }
  });

  const first = await client.list();
  assert.equal(first.nextPage, 'opaque');
  assert.equal(first.items[0].kind, 'folder');
  const second = await client.list(null, first.nextPage);
  assert.deepEqual(second.items.map(({ name }) => name), ['Vault.KDBX']);
  assert.deepEqual(new Uint8Array(await client.download(second.items[0])), bytes);
  assert.equal(requests[0].url, 'https://api.dropboxapi.com/2/files/list_folder');
  assert.deepEqual(JSON.parse(requests[0].body), { path: '', limit: 100 });
  assert.equal(requests[1].url, 'https://api.dropboxapi.com/2/files/list_folder/continue');
  assert.deepEqual(JSON.parse(requests[1].body), { cursor: 'opaque' });
  assert.equal(requests[2].url, 'https://content.dropboxapi.com/2/files/download');
  assert.deepEqual(JSON.parse(requests[2].headers['Dropbox-API-Arg']), { path: 'id:vault' });
});
