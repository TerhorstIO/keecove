export const IMPORT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const MAX_IMPORT_FILE_BYTES = 128 * 1024 * 1024;

const databaseName = 'keevault-imports';
const markerKey = 'keevault.import-session';
const metadataStore = 'sessions';
const fileStore = 'files';

class ImportSessionError extends Error {}

export function assertImportFileBytes(bytes) {
  if (bytes instanceof ArrayBuffer && bytes.byteLength > MAX_IMPORT_FILE_BYTES) {
    throw new ImportSessionError('Die KDBX-Datei darf höchstens 128 MiB groß sein.');
  }
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 12) {
    throw new ImportSessionError('Für die Sitzung wird eine verschlüsselte KDBX-Datei benötigt.');
  }
  const header = new DataView(bytes);
  if (header.getUint32(0, true) !== 0x9aa2d903 || header.getUint32(4, true) !== 0xb54bfb67) {
    throw new ImportSessionError('Für die Sitzung wird eine verschlüsselte KDBX-Datei benötigt.');
  }
}

function cloudFileReference(file) {
  if (!file) return;
  const { provider, id, driveId, name } = file;
  const text = (value) => typeof value === 'string' && Boolean(value.trim()) && value.length <= 2048;
  if (!['onedrive', 'dropbox', 'google'].includes(provider) || !text(id) || !text(name) ||
      !/\.kdbx$/i.test(name) || (provider === 'onedrive' && !text(driveId))) {
    throw new ImportSessionError('Die Cloud-Datei konnte nicht für die Sitzung gespeichert werden.');
  }
  return provider === 'onedrive' ? { provider, id, name, driveId } : { provider, id, name };
}

function openDatabase(indexedDB) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore(metadataStore, { keyPath: 'id' }).createIndex('expiresAt', 'expiresAt');
      database.createObjectStore(fileStore);
    };
    request.onblocked = () => {
      blocked = true;
      reject(new Error('IndexedDB is blocked.'));
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
  });
}

export function createImportSessionStore({
  getIndexedDB = () => globalThis.indexedDB,
  getStorage = () => globalThis.sessionStorage,
  now = Date.now,
} = {}) {
  let queue = Promise.resolve();
  let nextCleanup = 0;

  function serialize(operation) {
    const pending = queue.then(async () => {
      try {
        return await operation(getStorage());
      } catch (error) {
        if (error instanceof ImportSessionError) throw error;
        throw new ImportSessionError('Der Browser konnte die Tresordatei nicht in der Sitzung speichern oder abrufen.', { cause: error });
      }
    });
    queue = pending.catch(() => {});
    return pending;
  }

  async function transact(mode, operation) {
    const database = await openDatabase(getIndexedDB());
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction([metadataStore, fileStore], mode);
        let result;
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
        try {
          operation(transaction.objectStore(metadataStore), transaction.objectStore(fileStore), (value) => {
            result = value;
          });
        } catch (error) {
          transaction.abort();
          reject(error);
        }
      });
    } finally {
      database.close();
    }
  }

  async function cleanupExpired() {
    const cutoff = now();
    if (cutoff < nextCleanup) return;
    await transact('readwrite', (metadata, files) => {
      const scan = metadata.index('expiresAt').openKeyCursor();
      scan.onsuccess = () => {
        const cursor = scan.result;
        if (!cursor || cursor.key > cutoff) return;
        files.delete(cursor.primaryKey);
        metadata.delete(cursor.primaryKey);
        cursor.continue();
      };
    });
    nextCleanup = cutoff + 60_000;
  }

  function removeRecord(id) {
    return transact('readwrite', (metadata, files) => {
      metadata.delete(id);
      files.delete(id);
    });
  }

  function read(includeBytes) {
    return serialize(async (storage) => {
      const id = storage.getItem(markerKey);
      if (!id) {
        // Old sessions can be removed independently of the currently selected file.
        await cleanupExpired().catch(() => {});
        return null;
      }
      const record = await transact('readonly', (metadata, files, report) => {
        const lookup = metadata.get(id);
        lookup.onsuccess = () => {
          const data = lookup.result;
          if (!data) return;
          if (!includeBytes || data.fileHandle || data.cloudFile || data.expiresAt <= now()) {
            report(data);
            return;
          }
          const file = files.get(id);
          file.onsuccess = () => {
            if (file.result instanceof ArrayBuffer) report({ ...data, bytes: file.result });
          };
        };
      });
      if (record && record.expiresAt > now() && (!includeBytes || record.bytes || record.fileHandle || record.cloudFile)) {
        await cleanupExpired().catch(() => {});
        return record;
      }
      storage.removeItem(markerKey);
      await removeRecord(id);
      return null;
    });
  }

  function startImportSession(bytes, { fileHandle, cloudFile } = {}) {
    return serialize(async (storage) => {
      assertImportFileBytes(bytes);
      if (fileHandle && (fileHandle.kind !== 'file' || (typeof FileSystemFileHandle === 'function' && !(fileHandle instanceof FileSystemFileHandle)))) {
        throw new ImportSessionError('Der Browser hat keinen gültigen Dateizugriff für die Sitzung geliefert.');
      }
      const reference = cloudFileReference(cloudFile);
      if (reference && fileHandle) throw new ImportSessionError('Die Tresordatei hat mehrere Quellen.');
      const previousId = storage.getItem(markerKey);
      await cleanupExpired();
      const id = crypto.randomUUID();
      const record = { id, expiresAt: now() + IMPORT_SESSION_TTL_MS };
      if (fileHandle) record.fileHandle = fileHandle;
      if (reference) record.cloudFile = reference;
      await transact('readwrite', (metadata, files) => {
        metadata.add(record);
        if (!fileHandle && !reference) files.add(bytes, id);
      });
      try {
        storage.setItem(markerKey, id);
      } catch (error) {
        await removeRecord(id).catch(() => {});
        throw error;
      }
      if (previousId) await removeRecord(previousId).catch(() => {});
      return { ...record, bytes };
    });
  }

  function clearImportSession(id) {
    return serialize(async (storage) => {
      const activeId = storage.getItem(markerKey);
      if (!activeId || (id !== undefined && id !== activeId)) return;
      storage.removeItem(markerKey);
      await removeRecord(activeId);
    });
  }

  return {
    readImportSession: () => read(true),
    readImportSessionMetadata: () => read(false),
    startImportSession,
    clearImportSession
  };
}

export const {
  readImportSession,
  readImportSessionMetadata,
  startImportSession,
  clearImportSession
} = createImportSessionStore();
