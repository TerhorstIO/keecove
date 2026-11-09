import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { connectGoogleDrive } from '../src/google-drive.js';
import { VaultSourceConflictError } from '../src/vault-source.js';

const apiOrigin = 'https://www.googleapis.com';
const filePath = '/drive/v2/files/vault';
const uploadPath = '/upload/drive/v2/files/vault';
const uploadLocation = `${apiOrigin}${uploadPath}?uploadType=resumable&upload_id=upload-session`;
const cloudFile = { provider: 'google', id: 'vault', name: 'Imported.KDBX' };
const revision = '7:"drive-etag-7"';
const nextRevision = '8:"drive-etag-8"';

function vaultBytes(marker = 0, size = 64) {
  const bytes = new Uint8Array(size);
  bytes.set([0x03, 0xd9, 0xa2, 0x9a, 0x67, 0xfb, 0x4b, 0xb5, 0x01, 0, 0x04, 0]);
  bytes[bytes.length - 1] = marker;
  return bytes;
}

function metadata(version, bytes = vaultBytes()) {
  return {
    id: cloudFile.id,
    version: String(version),
    etag: `"drive-etag-${version}"`,
    fileSize: String(bytes.byteLength),
    mimeType: 'application/x-keepass2',
    capabilities: { canModifyContent: true },
    labels: { trashed: false },
    sha256Checksum: createHash('sha256').update(bytes).digest('hex')
  };
}

function mockDrive(t, handler) {
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    const url = new URL(target);
    assert.equal(url.origin, apiOrigin);
    assert.equal(options.headers.Authorization, 'Bearer token');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    return handler(url, options);
  });
}

function connect() {
  return connectGoogleDrive({
    clientId: 'example',
    async authenticate(options) {
      assert.equal(options.provider, 'google');
      assert.equal(options.scope, 'https://www.googleapis.com/auth/drive');
      return 'token';
    }
  });
}

test('Google Drive lists in v3 and reads and reopens the original KDBX in v2', async (t) => {
  let bytes = vaultBytes();
  let latest = metadata(7, bytes);
  let downloads = 0;
  const queries = [];
  mockDrive(t, (url, options) => {
    assert.equal(options.method, 'GET');
    if (url.pathname === '/drive/v3/files') {
      queries.push(url.searchParams.get('q'));
      if (url.searchParams.get('pageToken') === 'opaque') {
        return Response.json({ files: [{ id: cloudFile.id, name: cloudFile.name, size: latest.fileSize }] });
      }
      return Response.json({
        files: [
          { id: 'folder', name: 'Secure files', mimeType: 'application/vnd.google-apps.folder' },
          { id: 'ignored', name: 'Unrelated.txt' }
        ],
        nextPageToken: 'opaque'
      });
    }
    assert.equal(url.pathname, filePath);
    assert.equal(url.searchParams.get('supportsAllDrives'), 'true');
    if (url.searchParams.get('alt') === 'media') {
      downloads++;
      return new Response(bytes);
    }
    assert.match(url.searchParams.get('fields'), /version,etag/);
    return Response.json(latest);
  });

  const client = await connect();
  const first = await client.list();
  assert.equal(first.nextPage, 'opaque');
  assert.deepEqual(first.items.map(({ name, kind }) => ({ name, kind })), [{ name: 'Secure files', kind: 'folder' }]);
  const second = await client.list(first.items[0], first.nextPage);
  assert.equal(second.items[0].size, bytes.byteLength);
  assert.deepEqual(await client.open(second.items[0]), { bytes: bytes.buffer, revision, cloudFile });
  assert.deepEqual(queries, ["'root' in parents and trashed = false", "'folder' in parents and trashed = false"]);

  const source = (await connect()).source(cloudFile);
  assert.equal(source.label, 'Google Drive');
  assert.deepEqual(await source.read(), { bytes: bytes.buffer, revision });
  assert.equal(await source.read(revision), null);
  assert.equal(downloads, 2);
  bytes = vaultBytes(8);
  latest = metadata(8, bytes);
  assert.deepEqual(await source.read(revision), { bytes: bytes.buffer, revision: nextRevision });
  assert.equal(downloads, 3);

  await assert.rejects(client.list({ id: "' or true" }), /Ungültiger Google-Drive-Ordner/);
  await assert.rejects(client.open({ kind: 'file', id: '//other.example', name: 'vault.kdbx' }), /Ungültige Google-Drive-Datei/);
});

test('Google Drive retries a read if the original changes or downloaded bytes do not match the checksum', async (t) => {
  const previous = vaultBytes(7);
  const current = vaultBytes(8);
  let latest = metadata(7, previous);
  let downloads = 0;
  mockDrive(t, (url) => {
    assert.equal(url.pathname, filePath);
    if (url.searchParams.get('alt') !== 'media') return Response.json(latest);
    if (++downloads === 1) latest = metadata(8, current);
    return new Response(downloads === 2 ? current : previous);
  });

  const source = (await connect()).source(cloudFile);
  assert.deepEqual(await source.read(), { bytes: current.buffer, revision: nextRevision });
  assert.equal(downloads, 2);
  await assert.rejects(source.read(), VaultSourceConflictError);
  assert.equal(downloads, 4);
});

test('Google Drive conditionally uploads encrypted bytes to the original file and returns its new revision', async (t) => {
  const bytes = vaultBytes(8);
  let latest = metadata(7);
  const steps = [];
  mockDrive(t, async (url, { method, headers, body }) => {
    if (url.pathname === filePath) {
      assert.equal(method, 'GET');
      assert.equal(url.searchParams.get('alt'), null);
      steps.push('metadata');
      return Response.json(latest);
    }
    assert.equal(url.pathname, uploadPath);
    assert.equal(method, 'PUT');
    assert.equal(url.searchParams.get('uploadType'), 'multipart');
    assert.equal(url.searchParams.get('supportsAllDrives'), 'true');
    assert.equal(headers['If-Match'], latest.etag);
    const boundary = /^multipart\/related; boundary=(.+)$/.exec(headers['Content-Type'])?.[1];
    assert.ok(boundary);
    assert.deepEqual(Buffer.from(await body.arrayBuffer()), Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: ${latest.mimeType}\r\n\r\n`),
      Buffer.from(bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]));
    steps.push('upload');
    if (latest.version === '8') return new Response(null, { status: 412 });
    latest = metadata(8, bytes);
    return Response.json({ id: latest.id, etag: latest.etag, version: latest.version });
  });

  const source = (await connect()).source(cloudFile);
  const saved = await source.write(bytes.buffer, revision, { beforeCommit: async () => { steps.push('check session'); } });
  assert.equal(saved, nextRevision);
  assert.equal(await source.read(saved), null);
  assert.deepEqual(steps, ['metadata', 'check session', 'upload', 'metadata']);
  await assert.rejects(source.write(bytes.buffer, saved), VaultSourceConflictError);
});

test('Google Drive uses a conditional resumable upload for larger original files', async (t) => {
  const bytes = vaultBytes(8, 5_000_001);
  const current = metadata(7);
  const location = `${apiOrigin}/resumable${uploadPath}?upload_id=upload-session`;
  let latest = current;
  const steps = [];
  mockDrive(t, (url, { method, headers, body }) => {
    if (url.pathname === filePath) {
      assert.equal(method, 'GET');
      assert.equal(url.searchParams.get('alt'), null);
      steps.push('metadata');
      return Response.json(latest);
    }
    assert.equal(method, 'PUT');
    if (!url.searchParams.has('upload_id')) {
      assert.equal(url.pathname, uploadPath);
      assert.equal(url.searchParams.get('uploadType'), 'resumable');
      assert.equal(headers['If-Match'], current.etag);
      assert.equal(headers['X-Upload-Content-Type'], current.mimeType);
      assert.equal(headers['X-Upload-Content-Length'], String(bytes.byteLength));
      assert.equal(body, undefined);
      assert.equal(url.searchParams.get('supportsAllDrives'), 'true');
      steps.push('initiate');
      return new Response(null, { headers: { Location: location } });
    }
    assert.equal(url.href, location);
    assert.equal(headers['Content-Type'], current.mimeType);
    assert.equal(headers['Content-Range'], `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`);
    assert.equal(body, bytes.buffer);
    steps.push('upload');
    latest = metadata(8, bytes);
    return Response.json({ id: latest.id, etag: latest.etag, version: latest.version });
  });

  const source = (await connect()).source(cloudFile);
  const saved = await source.write(bytes.buffer, revision, { beforeCommit: async () => { steps.push('check session'); } });
  assert.equal(saved, nextRevision);
  assert.equal(await source.read(saved), null);
  assert.deepEqual(steps, ['metadata', 'initiate', 'metadata', 'check session', 'upload', 'metadata']);
});

test('Google Drive reports version conflicts before and during the resumable upload', async (t) => {
  for (const conflictAt of ['before initiation', 'initiation', 'after initiation', 'final upload']) {
    await t.test(conflictAt, async (t) => {
      const bytes = vaultBytes(0, 5_000_001);
      let metadataReads = 0;
      let initiations = 0;
      let uploads = 0;
      mockDrive(t, (url) => {
        if (url.pathname === filePath) {
          metadataReads++;
          const changed = conflictAt === 'before initiation' || (conflictAt === 'after initiation' && metadataReads === 2);
          return Response.json(metadata(changed ? 8 : 7));
        }
        assert.equal(url.pathname, uploadPath);
        if (!url.searchParams.has('upload_id')) {
          initiations++;
          return conflictAt === 'initiation'
            ? new Response(null, { status: 412 })
            : new Response(null, { headers: { Location: uploadLocation } });
        }
        uploads++;
        assert.equal(conflictAt, 'final upload');
        return new Response(null, { status: 412 });
      });

      const source = (await connect()).source(cloudFile);
      await assert.rejects(source.write(bytes.buffer, revision), VaultSourceConflictError);
      assert.equal(initiations, conflictAt === 'before initiation' ? 0 : 1);
      assert.equal(uploads, conflictAt === 'final upload' ? 1 : 0);
    });
  }
});

test('Google Drive refuses unsafe resumable upload locations', async (t) => {
  const bytes = vaultBytes(0, 5_000_001);
  const locations = {
    'different origin': uploadLocation.replace(apiOrigin, 'https://other.example'),
    'different file': uploadLocation.replace(uploadPath, '/upload/drive/v2/files/another-vault'),
    'missing upload ID': `${apiOrigin}${uploadPath}?uploadType=resumable`
  };
  for (const [name, location] of Object.entries(locations)) {
    await t.test(name, async (t) => {
      mockDrive(t, (url, { body }) => {
        if (url.pathname === filePath) return Response.json(metadata(7));
        assert.equal(url.pathname, uploadPath);
        assert.equal(body, undefined);
        return new Response(null, { headers: { Location: location } });
      });

      const source = (await connect()).source(cloudFile);
      await assert.rejects(source.write(bytes.buffer, revision), /keine gültige Adresse/);
    });
  }
});

test('Google Drive can read without an ETag but refuses an upload without a version precondition', async (t) => {
  const bytes = vaultBytes();
  const file = metadata(7, bytes);
  delete file.etag;
  mockDrive(t, (url, { method }) => {
    assert.equal(method, 'GET');
    assert.equal(url.pathname, filePath);
    return url.searchParams.has('alt') ? new Response(bytes) : Response.json(file);
  });

  const source = (await connect()).source(cloudFile);
  const opened = await source.read();
  assert.deepEqual(opened, { bytes: bytes.buffer, revision: '7:' });
  await assert.rejects(source.write(bytes.buffer, opened.revision), /nicht mit Versionsprüfung/);
});
