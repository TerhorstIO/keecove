import { loadVault } from './kdbx.js';
import { applyOperation } from './mutations.js';
import { clearImportSession, ImportSessionConflictError, readImportSession, readImportSessionMetadata, saveImportSession, startImportSession } from './import-session.js';
import { LocalFileConflictError, readLocalFile, writeLocalFile } from './local-file.js';

export class SessionExpiredError extends Error {
  constructor() {
    super('Die Browsersitzung ist abgelaufen. Wähle die Tresordatei erneut aus.');
  }
}

export class BrowserVaultSession {
  #controller = new AbortController();
  #queue = Promise.resolve();
  #snapshot;
  #credentials;
  #handle;

  constructor(snapshot, credentials, handle) {
    this.#snapshot = snapshot;
    this.#credentials = credentials;
    this.#handle = handle;
  }

  static async start({ bytes, db, credentials, fileHandle, diskRevision }) {
    const record = await startImportSession(bytes, { fileHandle });
    return new BrowserVaultSession({ ...record, db, diskRevision }, credentials, fileHandle);
  }

  static async reopen(record, credentials) {
    const latest = record.fileHandle ? await readLocalFile(record.fileHandle) : null;
    const bytes = latest?.bytes ?? record.bytes;
    const db = await loadVault(bytes, credentials);
    const metadata = await readImportSessionMetadata();
    if (metadata?.id !== record.id) throw new SessionExpiredError();
    const session = new BrowserVaultSession({ ...record, bytes, db, diskRevision: latest?.revision }, credentials, record.fileHandle);
    if (!record.fileHandle && metadata.revision !== record.revision) await session.refresh();
    return session;
  }

  get snapshot() {
    return this.#snapshot;
  }

  get isDirect() {
    return Boolean(this.#handle);
  }

  close() {
    this.#controller.abort();
    this.#snapshot = null;
    this.#credentials = null;
    this.#handle = null;
  }

  #serial(action) {
    const pending = this.#queue.then(() => {
      this.#controller.signal.throwIfAborted();
      return action(this.#controller.signal);
    });
    this.#queue = pending.catch(() => {});
    return pending;
  }

  async #refresh(signal) {
    const snapshot = this.#snapshot;
    const metadata = await readImportSessionMetadata();
    signal.throwIfAborted();
    if (metadata?.id !== snapshot.id) throw new SessionExpiredError();
    let next;
    if (this.#handle) {
      const disk = await readLocalFile(this.#handle);
      if (disk.revision === snapshot.diskRevision) return false;
      next = { ...metadata, bytes: disk.bytes, diskRevision: disk.revision };
    } else {
      if (metadata.revision === snapshot.revision) return false;
      next = await readImportSession();
      if (next?.id !== snapshot.id) throw new SessionExpiredError();
    }
    signal.throwIfAborted();
    let db;
    try {
      db = await loadVault(next.bytes, this.#credentials);
    } catch {
      signal.throwIfAborted();
      throw new Error('Die neue Dateiversion lässt sich nicht mit dem aktuellen Schlüssel öffnen. Sperre den Tresor und entsperre ihn erneut.');
    }
    signal.throwIfAborted();
    if (db.getDefaultGroup().uuid.id !== snapshot.db.getDefaultGroup().uuid.id) {
      throw new Error('An diesem Pfad liegt inzwischen ein anderer Tresor. Öffne die Datei erneut.');
    }
    this.#snapshot = { ...next, db };
    return true;
  }

  refresh() {
    return this.#serial((signal) => this.#refresh(signal));
  }

  save(operation) {
    return this.#serial(async (signal) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await this.#refresh(signal);
        signal.throwIfAborted();
        const previous = this.#snapshot;
        const db = await loadVault(previous.bytes, this.#credentials);
        signal.throwIfAborted();
        const result = await applyOperation(db, operation);
        if (!result.changed) return result;
        const bytes = await db.save();
        signal.throwIfAborted();
        try {
          if (this.#handle) {
            const checkExpiry = () => {
              if (Date.now() >= previous.expiresAt) throw new SessionExpiredError();
            };
            checkExpiry();
            const diskRevision = await writeLocalFile(this.#handle, bytes, previous.diskRevision, { signal, beforeCommit: checkExpiry });
            signal.throwIfAborted();
            this.#snapshot = { ...previous, bytes, db, diskRevision };
          } else {
            const metadata = await saveImportSession(previous.id, bytes, previous.revision);
            if (!metadata) throw new SessionExpiredError();
            signal.throwIfAborted();
            this.#snapshot = { ...metadata, bytes, db };
          }
          return result;
        } catch (error) {
          const conflict = error instanceof ImportSessionConflictError || error instanceof LocalFileConflictError;
          if (!conflict || attempt === 2) throw error;
        }
      }
    });
  }
}

export { clearImportSession, readImportSession, readImportSessionMetadata };
