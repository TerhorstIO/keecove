import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { BrowserVaultSession, readImportSession } from '../src/browser-vault.js';
import { createVault, findEntry, KdbxUuid, loadVault, makeCredentials } from '../src/kdbx.js';
import { readLocalFile } from '../src/local-file.js';
import { applyOperation, EditConflict, entryValues } from '../src/mutations.js';

const masterPassword = 'Synthetic test vault password';
const initialValues = {
  Title: 'Test entry',
  UserName: 'test@example.com',
  Password: 'Synthetic entry password',
  URL: 'https://example.com/',
  Notes: ''
};

function browserStorage(t) {
  const storage = new Map();
  const replacements = {
    indexedDB: new IDBFactory(),
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key)
    }
  };
  for (const [key, value] of Object.entries(replacements)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else delete globalThis[key];
    });
  }
}

async function vaultFixture() {
  const credentials = await makeCredentials(masterPassword);
  const db = createVault(credentials, 'Synthetic Keevault fixture');
  const id = KdbxUuid.random().id;
  const group = db.getDefaultGroup().uuid.id;
  await applyOperation(db, { type: 'create', id, group, values: initialValues });
  const edit = (before, patch) => ({ type: 'edit', id, group, beforeGroup: group, before, values: { ...before, ...patch } });
  return { credentials, db, bytes: await db.save(), id, edit };
}

test('a real encrypted KDBX can be edited, locked and reopened from the browser session', async (t) => {
  browserStorage(t);
  const fixture = await vaultFixture();
  const session = await BrowserVaultSession.start(fixture);
  const patch = { Password: 'Updated synthetic password', Notes: 'Browser session edit' };
  const saved = await session.save(fixture.edit(initialValues, patch));
  assert.equal(saved.changed, true);

  session.close();
  assert.equal(session.snapshot, null);
  await assert.rejects(session.refresh(), { name: 'AbortError' });

  const record = await readImportSession();
  assert.notDeepEqual(record.bytes, fixture.bytes);
  const wrongCredentials = await makeCredentials('Wrong synthetic password');
  await assert.rejects(BrowserVaultSession.reopen(record, wrongCredentials), /Entsperren fehlgeschlagen/);
  const reopened = await BrowserVaultSession.reopen(record, await makeCredentials(masterPassword));
  assert.deepEqual(entryValues(findEntry(reopened.snapshot.db, fixture.id)), { ...initialValues, ...patch });
  reopened.close();
});

function localHandleFixture(bytes) {
  let file = bytes;
  let replacementDuringWrite = null;
  let abortedWrites = 0;
  const handle = { kind: 'file', name: 'synthetic.kdbx' };
  // A platform handle is structured-cloneable. Keep the mock's own methods out of the clone.
  Object.defineProperties(handle, {
    getFile: { value: async () => new File([file], handle.name) },
    queryPermission: { value: async () => 'granted' },
    createWritable: { value: async () => {
      let staged;
      return {
        write: async (next) => {
          staged = next;
          if (replacementDuringWrite) {
            file = replacementDuringWrite;
            replacementDuringWrite = null;
          }
        },
        close: async () => { file = staged; },
        abort: async () => { abortedWrites++; }
      };
    } }
  });
  return {
    handle,
    replace: (next) => { file = next; },
    replaceDuringWrite: (next) => { replacementDuringWrite = next; },
    get abortedWrites() { return abortedWrites; }
  };
}

test('the direct session retries a desktop write and rejects conflicting changes to the same field', async (t) => {
  browserStorage(t);
  const fixture = await vaultFixture();
  const local = localHandleFixture(fixture.bytes);
  const disk = await readLocalFile(local.handle);
  const session = await BrowserVaultSession.start({ ...fixture, fileHandle: local.handle, diskRevision: disk.revision });
  t.after(() => session.close());

  const desktop = await loadVault(disk.bytes, fixture.credentials);
  const desktopPatch = { UserName: 'external@example.com' };
  await applyOperation(desktop, fixture.edit(initialValues, desktopPatch));
  local.replaceDuringWrite(await desktop.save());

  const webPatch = { Notes: 'Web edit' };
  await session.save(fixture.edit(initialValues, webPatch));
  assert.equal(local.abortedWrites, 1);
  const merged = { ...initialValues, ...desktopPatch, ...webPatch };
  assert.deepEqual(entryValues(findEntry(session.snapshot.db, fixture.id)), merged);
  const committedDisk = await readLocalFile(local.handle);
  const committedDb = await loadVault(committedDisk.bytes, fixture.credentials);
  assert.deepEqual(entryValues(findEntry(committedDb, fixture.id)), merged);

  await applyOperation(committedDb, fixture.edit(merged, { Notes: 'Concurrent desktop edit' }));
  const external = await committedDb.save();
  local.replace(external);
  await assert.rejects(session.save(fixture.edit(merged, { Notes: 'Conflicting web edit' })), EditConflict);
  assert.deepEqual((await readLocalFile(local.handle)).bytes, external);
});
