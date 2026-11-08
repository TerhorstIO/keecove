import { assertImportFileBytes, MAX_IMPORT_FILE_BYTES } from './import-session.js';

export class LocalFileConflictError extends Error {
  constructor(message = 'Die KDBX-Datei wurde zwischenzeitlich geändert. Lade sie vor dem Speichern neu.', options) {
    super(message, options);
  }
}

export class LocalFilePermissionError extends Error {
  constructor(mode, options) {
    super(mode === 'readwrite'
      ? 'Erlaube Keevault den Schreibzugriff auf die KDBX-Datei.'
      : 'Erlaube Keevault erneut den Lesezugriff auf die KDBX-Datei.', options);
    this.mode = mode;
  }
}

export function canPickLocalFile() {
  return typeof globalThis.showOpenFilePicker === 'function';
}

export async function pickLocalFile() {
  if (!canPickLocalFile()) throw new Error('Dieser Browser unterstützt keinen direkten Dateizugriff.');
  const [handle] = await globalThis.showOpenFilePicker({
    id: 'keevault',
    multiple: false,
    excludeAcceptAllOption: true,
    types: [{ description: 'KeePass-Tresor', accept: { 'application/octet-stream': ['.kdbx'] } }]
  });
  return handle;
}

export async function requestLocalFilePermission(handle, { write = false } = {}) {
  const mode = write ? 'readwrite' : 'read';
  return (await handle.requestPermission({ mode })) === 'granted';
}

async function requirePermission(handle, mode) {
  if (typeof handle.queryPermission !== 'function') return;
  if (await handle.queryPermission({ mode }) !== 'granted') throw new LocalFilePermissionError(mode);
}

async function revisionOf(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)).toHex();
}

export async function readLocalFile(handle) {
  await requirePermission(handle, 'read');
  try {
    const file = await handle.getFile();
    if (file.size > MAX_IMPORT_FILE_BYTES) throw new Error('Die KDBX-Datei darf höchstens 128 MiB groß sein.');
    const bytes = await file.arrayBuffer();
    return { bytes, revision: await revisionOf(bytes) };
  } catch (error) {
    if (error.name === 'NotAllowedError') throw new LocalFilePermissionError('read', { cause: error });
    if (error.name === 'NotFoundError') {
      throw new Error('Die ausgewählte KDBX-Datei wurde verschoben oder gelöscht. Wähle sie erneut aus.', { cause: error });
    }
    if (error.name === 'NotReadableError') {
      throw new LocalFileConflictError('Die KDBX-Datei wird gerade geändert. Versuche es erneut.', { cause: error });
    }
    throw error;
  }
}

export async function writeLocalFile(handle, bytes, expectedRevision, { signal, beforeCommit } = {}) {
  assertImportFileBytes(bytes);
  signal?.throwIfAborted();
  await requirePermission(handle, 'readwrite');
  const revision = await revisionOf(bytes);
  async function checkRevision() {
    const current = await readLocalFile(handle);
    if (current.revision !== expectedRevision) throw new LocalFileConflictError();
    signal?.throwIfAborted();
  }

  await checkRevision();
  let writable;
  try {
    writable = await handle.createWritable({ mode: 'exclusive' });
    signal?.throwIfAborted();
    await writable.write(bytes);
    // The browser commits its staged file on close; desktop applications use their own locks.
    await checkRevision();
    beforeCommit?.();
    await writable.close();
    return revision;
  } catch (error) {
    if (writable) await writable.abort().catch(() => {});
    if (error.name === 'NotAllowedError') throw new LocalFilePermissionError('readwrite', { cause: error });
    if (error.name === 'NoModificationAllowedError') {
      throw new LocalFileConflictError('Die KDBX-Datei wird gerade von einem anderen Fenster gespeichert.', { cause: error });
    }
    throw error;
  }
}
