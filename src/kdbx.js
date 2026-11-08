import kdbx from 'kdbxweb';

const { Consts, Credentials, CryptoEngine, Int64, Kdbx, KdbxUuid, ProtectedValue, VarDictionary } = kdbx;

CryptoEngine.setArgon2Impl(async (key, salt, memory, iterations, length, parallelism, type, version) => {
  if (memory > 512 * 1024 || iterations > 1000 || parallelism > 64) {
    throw new Error('Die Argon2-Einstellungen dieser Datei überschreiten das Browserlimit.');
  }
  const password = key.slice(0);
  const parameters = { password, salt, memory, iterations, length, parallelism, type, version };
  if (typeof Worker === 'undefined') {
    const { deriveArgon2 } = await import('./argon2.js');
    return deriveArgon2(parameters);
  }

  const worker = new Worker(new URL('./argon2.worker.js', import.meta.url), { type: 'module' });
  let timeout;
  try {
    return await new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Die Schlüsselableitung dauerte zu lange.')), 60_000);
      worker.onmessage = ({ data }) => {
        if (data.failed) reject(new Error('Die Argon2-Schlüsselableitung ist fehlgeschlagen.'));
        else resolve(data.key);
      };
      worker.onerror = () => reject(new Error('Der Argon2-Worker konnte nicht gestartet werden.'));
      worker.postMessage(parameters, [password]);
    });
  } finally {
    clearTimeout(timeout);
    worker.terminate();
    if (password.byteLength) new Uint8Array(password).fill(0);
  }
});

export { KdbxUuid, ProtectedValue };

export async function makeCredentials(password, keyFileBytes) {
  const secret = password || !keyFileBytes ? ProtectedValue.fromString(password) : null;
  try {
    return await new Credentials(secret, keyFileBytes).ready;
  } finally {
    if (keyFileBytes) new Uint8Array(keyFileBytes).fill(0);
  }
}

export function createVault(credentials, name) {
  const db = Kdbx.create(credentials, name);
  db.setVersion(4);
  db.setKdf(Consts.KdfId.Argon2id);
  const { UInt32, UInt64 } = VarDictionary.ValueType;
  db.header.kdfParameters.set('M', UInt64, new Int64(64 * 1024 * 1024));
  db.header.kdfParameters.set('I', UInt64, new Int64(3));
  db.header.kdfParameters.set('P', UInt32, 2);
  return db;
}

export async function loadVault(bytes, credentials) {
  try {
    const db = await Kdbx.load(bytes, credentials);
    db.getDefaultGroup();
    return db;
  } catch (error) {
    if (error.code === 'InvalidKey') {
      throw new Error('Entsperren fehlgeschlagen. Prüfe das Master-Passwort und die Schlüsseldatei.');
    }
    if (['InvalidVersion', 'BadSignature', 'Unsupported'].includes(error.code)) {
      throw new Error('Diese Datei oder eine ihrer Einstellungen wird nicht unterstützt. Erwartet wird eine KeePass-Datei im KDBX-3- oder KDBX-4-Format.');
    }
    if (error.code || error instanceof RangeError) {
      throw new Error('Die KDBX-Datei konnte nicht vollständig gelesen werden.');
    }
    throw error;
  }
}

export function fieldText(entry, key) {
  const value = entry.fields.get(key);
  return value instanceof ProtectedValue ? value.getText() : value ?? '';
}

export function* activeGroups(db) {
  const trash = db.meta.recycleBinEnabled ? db.meta.recycleBinUuid?.id : undefined;
  function* walk(group) {
    if (group.uuid.id === trash) return;
    yield group;
    for (const child of group.groups) yield* walk(child);
  }
  for (const group of db.groups) yield* walk(group);
}

export function* activeEntries(db) {
  for (const group of activeGroups(db)) yield* group.entries;
}

export function findEntry(db, id) {
  for (const entry of activeEntries(db)) {
    if (entry.uuid.id === id) return entry;
  }
}

export function findGroup(db, id) {
  for (const group of activeGroups(db)) {
    if (group.uuid.id === id) return group;
  }
}

export function webUrl(text) {
  try {
    const url = new URL(text);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return url;
  } catch {
    // KeePass supports arbitrary URL strings. Only web URLs can become links.
  }
}
