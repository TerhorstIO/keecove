import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectOneDrive } from '../src/onedrive.js';

test('OneDrive scopes credentials to Graph and delegates only the signed download URL', async (t) => {
  const origin = 'https://graph.microsoft.com';
  const nextPage = `${origin}/v1.0/me/drive/root/children?$skiptoken=opaque`;
  const signedUrl = 'https://download.files.1drv.com/example?sig=fixture';
  const fileBytes = new ArrayBuffer(8);
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
    return Response.json({ '@microsoft.graph.downloadUrl': signedUrl });
  });

  const client = await connectOneDrive({
    clientId: 'example',
    async authenticate(options) {
      assert.equal(options.provider, 'onedrive');
      assert.equal(options.clientId, 'example');
      assert.equal(options.scope, `${origin}/Files.Read`);
      assert.equal(options.tokenUrl, 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
      return 'token';
    },
    async downloadUrl(...args) {
      assert.deepEqual(args, [signedUrl]);
      return fileBytes;
    }
  });

  const first = await client.list();
  assert.equal(first.nextPage, nextPage);
  assert.deepEqual(first.items.map(({ name, kind }) => ({ name, kind })), [{ name: 'Vault.KDBX', kind: 'file' }]);
  assert.equal((await client.list(null, first.nextPage)).items[0].kind, 'folder');
  assert.equal(await client.download(first.items[0]), fileBytes);
  assert.equal(new URL(requests[2]).pathname, '/v1.0/drives/drive/items/vault');
  await assert.rejects(client.list(null, 'https://elsewhere.example/v1.0/me/drive/root/children'));
  assert.equal(requests.length, 3);
});
