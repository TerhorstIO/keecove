import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { createImportSessionStore, IMPORT_SESSION_TTL_MS, ImportSessionConflictError } from '../src/import-session.js';
import { LocalFileConflictError, LocalFilePermissionError, readLocalFile, writeLocalFile } from '../src/local-file.js';

function kdbxFixture(lastByte) {
  return Uint8Array.from([3, 217, 162, 154, 103, 251, 75, 181, 1, 0, 4, 0, lastByte]).buffer;
}

function setup() {
  const indexedDB = new IDBFactory();
  let time = 1_000_000;
  function makeTab(values = new Map()) {
    const storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key)
    };
    return { storage, values, open: () => createImportSessionStore({ getIndexedDB: () => indexedDB, getStorage: () => storage, now: () => time }) };
  }
  return { indexedDB, makeTab, advance: (duration) => { time += duration; } };
}

function storedFileCount(indexedDB) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('keevault-imports', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const tx = database.transaction('files');
      const count = tx.objectStore('files').count();
      tx.oncomplete = () => {
        database.close();
        resolve(count.result);
      };
      tx.onabort = () => {
        database.close();
        reject(tx.error);
      };
    };
  });
}

test('the encrypted file survives a reload only in the tab with the session marker', async () => {
  const { makeTab } = setup();
  const tab = makeTab();
  const bytes = kdbxFixture(1);
  const session = await tab.open().startImportSession(bytes);

  assert.deepEqual(await tab.open().readImportSession(), session);
  assert.deepEqual(await tab.open().readImportSessionMetadata(), {
    id: session.id,
    revision: session.revision,
    expiresAt: session.expiresAt
  });
  assert.deepEqual([...tab.values.values()], [session.id]);
  assert.equal(await makeTab().open().readImportSession(), null);
});

test('a save refreshes the revision without extending expiry', async () => {
  const { makeTab, advance, indexedDB } = setup();
  const tab = makeTab();
  const cache = tab.open();
  const initial = await cache.startImportSession(kdbxFixture(1));
  const bytes = kdbxFixture(2);
  advance(IMPORT_SESSION_TTL_MS - 1);
  const updated = await cache.saveImportSession(initial.id, bytes, initial.revision);

  assert.notEqual(updated.revision, initial.revision);
  assert.equal(updated.expiresAt, initial.expiresAt);
  assert.deepEqual((await cache.readImportSession()).bytes, bytes);

  advance(1);
  assert.equal(await cache.saveImportSession(initial.id, bytes, updated.revision), null);
  assert.equal(await tab.open().readImportSession(), null);
  assert.equal(tab.values.size, 0);
  assert.equal(await storedFileCount(indexedDB), 0);
});

test('duplicated tabs reject a stale revision without changing the file', async () => {
  const { makeTab } = setup();
  const tab = makeTab();
  const cache = tab.open();
  const initial = await cache.startImportSession(kdbxFixture(1));
  const duplicate = makeTab(new Map(tab.values)).open();
  const bytes = kdbxFixture(2);
  const results = await Promise.allSettled([
    cache.saveImportSession(initial.id, bytes, initial.revision),
    duplicate.saveImportSession(initial.id, bytes, initial.revision)
  ]);

  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  const rejected = results.find(({ status }) => status === 'rejected');
  assert.ok(rejected.reason instanceof ImportSessionConflictError);
  assert.deepEqual((await cache.readImportSession()).bytes, bytes);
  assert.deepEqual(await duplicate.readImportSession(), await cache.readImportSession());
});

test('replacement and explicit removal forget only the selected session', async () => {
  const { makeTab, indexedDB } = setup();
  const cache = makeTab().open();
  const first = await cache.startImportSession(kdbxFixture(1));
  const second = await cache.startImportSession(kdbxFixture(2));

  await cache.clearImportSession(first.id);
  assert.deepEqual(await cache.readImportSession(), second);
  assert.equal(await storedFileCount(indexedDB), 1);
  await cache.clearImportSession(second.id);
  assert.equal(await cache.readImportSession(), null);
  assert.equal(await storedFileCount(indexedDB), 0);
});

test('expired encrypted files left by closed tabs are collected on a future read', async () => {
  const { makeTab, advance, indexedDB } = setup();
  await makeTab().open().startImportSession(kdbxFixture(1));
  advance(IMPORT_SESSION_TTL_MS);

  assert.equal(await makeTab().open().readImportSession(), null);
  assert.equal(await storedFileCount(indexedDB), 0);
});

test('a blocked marker write rolls back the encrypted file', async () => {
  const { makeTab, indexedDB } = setup();
  const tab = makeTab();
  tab.storage.setItem = () => { throw new Error('Quota exceeded'); };

  await assert.rejects(tab.open().startImportSession(kdbxFixture(1)), /Der Browser konnte die Tresordatei/);
  assert.equal(tab.values.size, 0);
  assert.equal(await storedFileCount(indexedDB), 0);
});

test('the session refuses data without a KDBX signature', async () => {
  const { makeTab } = setup();
  const tab = makeTab();
  const bytes = new TextEncoder().encode('plain text is not an encrypted vault').buffer;

  await assert.rejects(tab.open().startImportSession(bytes), /verschlüsselte KDBX-Datei/);
  assert.equal(tab.values.size, 0);
});

test('the optional selected-file handle survives a reload and a cache save', async () => {
  const { makeTab } = setup();
  const tab = makeTab();
  const cache = tab.open();
  const fileHandle = { kind: 'file', name: 'selected.kdbx' };
  const first = await cache.startImportSession(kdbxFixture(1), { fileHandle });

  await cache.saveImportSession(first.id, kdbxFixture(2), first.revision);
  assert.deepEqual((await tab.open().readImportSessionMetadata()).fileHandle, fileHandle);
  assert.deepEqual((await tab.open().readImportSession()).fileHandle, fileHandle);
  assert.deepEqual([...tab.values.values()], [first.id]);
});

function localFileFixture() {
  let disk = kdbxFixture(1);
  let staged;
  const writes = [];
  const handle = {
    getFile: async () => new File([disk], 'selected.kdbx'),
    queryPermission: async () => 'granted',
    createWritable: async (options) => {
      assert.equal(options.mode, 'exclusive');
      writes.push('open');
      return {
        write: async (bytes) => {
          writes.push('stage');
          staged = bytes;
          handle.afterStage?.();
        },
        close: async () => {
          writes.push('commit');
          disk = staged;
        },
        abort: async () => {
          writes.push('abort');
          staged = null;
        }
      };
    },
    replace: (bytes) => { disk = bytes; }
  };
  return { handle, writes };
}

test('direct file writes check the revision and commit encrypted bytes', async () => {
  const { handle, writes } = localFileFixture();
  const { revision } = await readLocalFile(handle);
  const bytes = kdbxFixture(2);
  const updated = await writeLocalFile(handle, bytes, revision);

  assert.match(updated, /^[0-9a-f]{64}$/);
  assert.notEqual(updated, revision);
  assert.deepEqual(await readLocalFile(handle), { bytes, revision: updated });
  await assert.rejects(writeLocalFile(handle, kdbxFixture(3), revision), LocalFileConflictError);
  assert.deepEqual(writes, ['open', 'stage', 'commit']);
});

test('a desktop change during staging is preserved and the staged write is aborted', async () => {
  const { handle, writes } = localFileFixture();
  const { revision } = await readLocalFile(handle);
  const external = kdbxFixture(2);
  handle.afterStage = () => handle.replace(external);

  await assert.rejects(writeLocalFile(handle, kdbxFixture(3), revision), LocalFileConflictError);
  assert.deepEqual((await readLocalFile(handle)).bytes, external);
  assert.deepEqual(writes, ['open', 'stage', 'abort']);
});

test('direct writes require previously granted permission', async () => {
  const { handle, writes } = localFileFixture();
  const { revision } = await readLocalFile(handle);
  handle.queryPermission = async ({ mode }) => mode === 'read' ? 'granted' : 'prompt';
  handle.requestPermission = () => assert.fail('Background writes cannot prompt for access');

  await assert.rejects(writeLocalFile(handle, kdbxFixture(2), revision), (error) =>
    error instanceof LocalFilePermissionError && error.mode === 'readwrite');
  assert.deepEqual(writes, []);
});

test('locking during a direct write aborts before committing', async () => {
  const { handle, writes } = localFileFixture();
  const original = await readLocalFile(handle);
  const controller = new AbortController();
  handle.afterStage = () => controller.abort();

  await assert.rejects(writeLocalFile(handle, kdbxFixture(2), original.revision, { signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(await readLocalFile(handle), original);
  assert.deepEqual(writes, ['open', 'stage', 'abort']);
});
