import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectGoogleDrive } from '../src/google-drive.js';

test('Google Drive imports KDBX files through the fixed read-only API', async (t) => {
  const bytes = new Uint8Array(64);
  bytes.set([0x03, 0xd9, 0xa2, 0x9a, 0x67, 0xfb, 0x4b, 0xb5, 0x01, 0, 0x04, 0]);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    const url = new URL(target);
    requests.push(url);
    assert.equal(url.origin, 'https://www.googleapis.com');
    assert.equal(options.headers.Authorization, 'Bearer token');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    if (url.searchParams.get('alt') === 'media') return new Response(bytes);
    if (url.searchParams.get('pageToken') === 'opaque') {
      return Response.json({ files: [{ id: 'vault', name: 'Imported.KDBX', size: String(bytes.byteLength) }] });
    }
    return Response.json({
      files: [
        { id: 'folder', name: 'Secure files', mimeType: 'application/vnd.google-apps.folder' },
        { id: 'ignored', name: 'Unrelated.txt' }
      ],
      nextPageToken: 'opaque'
    });
  });

  const client = await connectGoogleDrive({
    clientId: 'example',
    async authenticate(options) {
      assert.equal(options.provider, 'google');
      assert.equal(options.scope, 'https://www.googleapis.com/auth/drive.readonly');
      return 'token';
    }
  });
  const first = await client.list();
  assert.equal(first.nextPage, 'opaque');
  assert.deepEqual(first.items.map(({ name, kind }) => ({ name, kind })), [{ name: 'Secure files', kind: 'folder' }]);
  const second = await client.list(first.items[0], first.nextPage);
  assert.equal(second.items[0].size, bytes.byteLength);
  assert.deepEqual(new Uint8Array(await client.download(second.items[0])), bytes);
  await assert.rejects(client.list({ id: "' or true" }), /Ungültiger Google-Drive-Ordner/);
  await assert.rejects(client.download({ kind: 'file', id: '//other.example' }), /Ungültige Google-Drive-Datei/);
  assert.deepEqual(requests.map((url) => url.pathname), [
    '/drive/v3/files', '/drive/v3/files', '/drive/v3/files/vault'
  ]);
  assert.equal(requests[0].searchParams.get('q'), "'root' in parents and trashed = false");
  assert.equal(requests[1].searchParams.get('q'), "'folder' in parents and trashed = false");
});
