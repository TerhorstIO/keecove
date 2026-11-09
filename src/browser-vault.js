import { loadVault } from './kdbx.js';
import { applyOperation } from './mutations.js';
import { clearImportSession, readImportSession, readImportSessionMetadata, startImportSession } from './import-session.js';
import { readLocalFile, writeLocalFile } from './local-file.js';
import { VaultSourceConflictError } from './vault-source.js';

export class SessionExpiredError extends Error {
  constructor() {
    super('Die Browsersitzung ist abgelaufen. Wähle die Tresordatei erneut aus.');
  }
}

function localSource(handle) {
  if (!handle) return;
  return {
    label: 'Lokale Datei',
    async read(previousRevision) {
      const file = await readLocalFile(handle);
      return file.revision !== previousRevision ? file : null;
    },
    write: (bytes, revision, options) => writeLocalFile(handle, bytes, revision, options)
  };
}

export class BrowserVaultSession {
  #controller = new AbortController();
  #queue = Promise.resolve();
  #snapshot;
  #credentials;
  #source;

  constructor(snapshot, credentials, source) {
    this.#snapshot = snapshot;
    this.#credentials = credentials;
    this.#source = source;
  }

  static async start({ bytes, db, credentials, fileHandle, diskRevision, cloudFile, source, sourceRevision }) {
    const directSource = cloudFile ? source : localSource(fileHandle);
    if (cloudFile && !directSource) throw new Error('Verbinde die Cloud-Datei erneut.');
    const record = await startImportSession(bytes, { fileHandle, cloudFile });
    return new BrowserVaultSession({ ...record, db, sourceRevision: fileHandle ? diskRevision : sourceRevision }, credentials, directSource);
  }

  static async reopen(record, credentials, { source, signal } = {}) {
    const directSource = record.cloudFile ? source : localSource(record.fileHandle);
    if (record.cloudFile && !directSource) throw new Error('Verbinde die Cloud-Datei erneut.');
    const latest = await directSource?.read(undefined, signal);
    signal?.throwIfAborted();
    const bytes = latest?.bytes ?? record.bytes;
    const db = await loadVault(bytes, credentials);
    const metadata = await readImportSessionMetadata();
    signal?.throwIfAborted();
    if (metadata?.id !== record.id) throw new SessionExpiredError();
    return new BrowserVaultSession({ ...record, bytes, db, sourceRevision: latest?.revision }, credentials, directSource);
  }

  get snapshot() {
    return this.#snapshot;
  }

  get canWrite() {
    return typeof this.#source?.write === 'function';
  }

  get sourceLabel() {
    return this.#source?.label ?? 'Schreibgeschützt';
  }

  close() {
    this.#controller.abort();
    this.#snapshot = null;
    this.#credentials = null;
    this.#source = null;
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
    if (!this.#source) return false;
    const next = await this.#source.read(snapshot.sourceRevision, signal);
    signal.throwIfAborted();
    if (!next) return false;
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
    this.#snapshot = { ...metadata, bytes: next.bytes, db, sourceRevision: next.revision };
    return true;
  }

  refresh() {
    return this.#serial((signal) => this.#refresh(signal));
  }

  save(operation) {
    return this.#serial(async (signal) => {
      if (!this.canWrite) throw new Error('Diese Tresordatei ist schreibgeschützt geöffnet.');
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
          const beforeCommit = async () => {
            const active = await readImportSessionMetadata();
            signal.throwIfAborted();
            if (active?.id !== previous.id || Date.now() >= previous.expiresAt) throw new SessionExpiredError();
          };
          const sourceRevision = await this.#source.write(bytes, previous.sourceRevision, { signal, beforeCommit });
          signal.throwIfAborted();
          this.#snapshot = { ...previous, bytes, db, sourceRevision };
          return result;
        } catch (error) {
          if (!(error instanceof VaultSourceConflictError) || attempt === 2) throw error;
        }
      }
    });
  }
}

export { clearImportSession, readImportSession, readImportSessionMetadata };
