import { bytesToHex } from '@noble/hashes/utils.js';
import { findEntry, findGroup, fieldText, KdbxUuid, ProtectedValue } from './kdbx.js';

export const standardFields = ['Title', 'UserName', 'Password', 'URL', 'Notes'];

export class EditConflict extends Error {}

export function entryValues(entry) {
  return Object.fromEntries(standardFields.map((key) => [key, fieldText(entry, key)]));
}

function setFields(entry, values) {
  for (const [key, value] of Object.entries(values)) {
    const protect = key === 'Password' || entry.fields.get(key) instanceof ProtectedValue;
    entry.fields.set(key, protect ? ProtectedValue.fromString(value) : value);
  }
}

function sortedKeys(map) {
  return [...map.keys()].sort();
}

async function binaryFingerprint(binary) {
  if (binary.hash) return binary.hash;
  const raw = binary instanceof ProtectedValue ? binary.getBinary() : binary;
  try {
    return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)));
  } finally {
    if (binary instanceof ProtectedValue) raw.fill(0);
  }
}

async function entryContent(entry) {
  const { creationTime, lastModTime, expiryTime, expires, locationChanged } = entry.times;
  const seconds = (date) => date ? Math.floor(date.getTime() / 1000) : null;
  return {
    parent: entry.parentGroup?.uuid.id,
    previousParent: entry.previousParentGroup?.id,
    times: [seconds(creationTime), seconds(lastModTime), seconds(expiryTime), expires, seconds(locationChanged)],
    options: [entry.icon, entry.customIcon?.id, entry.fgColor, entry.bgColor, entry.overrideUrl, entry.qualityCheck],
    tags: entry.tags,
    autoType: entry.autoType,
    customData: [...(entry.customData ?? [])].sort(([a], [b]) => a.localeCompare(b)),
    fields: sortedKeys(entry.fields).map((key) => [key, fieldText(entry, key), entry.fields.get(key) instanceof ProtectedValue]),
    binaries: await Promise.all(sortedKeys(entry.binaries).map(async (key) => [key, await binaryFingerprint(entry.binaries.get(key))])),
    history: await Promise.all(entry.history.map(entryContent))
  };
}

export async function deleteFingerprint(entry) {
  const bytes = new TextEncoder().encode(JSON.stringify(await entryContent(entry)));
  try {
    return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  } finally {
    bytes.fill(0);
  }
}

export async function applyOperation(db, operation) {
  if (operation.type === 'group') {
    if (operation.id && findGroup(db, operation.id)) return { changed: false, id: operation.id };
    const parent = findGroup(db, operation.group);
    if (!parent) throw new EditConflict('Die übergeordnete Gruppe wurde inzwischen entfernt.');
    const group = db.createGroup(parent, operation.name);
    if (operation.id) group.uuid = new KdbxUuid(operation.id);
    return { changed: true, id: group.uuid.id };
  }

  if (operation.type === 'create') {
    if (operation.id && findEntry(db, operation.id)) return { changed: false, id: operation.id };
    const parent = findGroup(db, operation.group);
    if (!parent) throw new EditConflict('Die Zielgruppe wurde inzwischen entfernt.');
    const entry = db.createEntry(parent);
    if (operation.id) entry.uuid = new KdbxUuid(operation.id);
    setFields(entry, operation.values);
    return { changed: true, id: entry.uuid.id };
  }

  const entry = findEntry(db, operation.id);
  if (!entry && operation.type === 'delete') return { changed: false };
  if (!entry) throw new EditConflict('Der Eintrag wurde inzwischen entfernt.');

  if (operation.type === 'delete') {
    if (await deleteFingerprint(entry) !== operation.fingerprint) {
      throw new EditConflict('Der Eintrag hat sich inzwischen geändert. Prüfe ihn vor dem Löschen erneut.');
    }
    db.remove(entry);
    return { changed: true };
  }

  const patch = {};
  for (const key of standardFields) {
    if (operation.values[key] === operation.before[key]) continue;
    const current = fieldText(entry, key);
    if (current === operation.values[key]) continue;
    if (current !== operation.before[key]) {
      throw new EditConflict('Ein bearbeitetes Feld wurde inzwischen auch extern geändert.');
    }
    patch[key] = operation.values[key];
  }

  const groupId = entry.parentGroup.uuid.id;
  let destination;
  if (operation.group !== operation.beforeGroup && operation.group !== groupId) {
    if (groupId !== operation.beforeGroup) throw new EditConflict('Der Eintrag wurde inzwischen in eine andere Gruppe verschoben.');
    destination = findGroup(db, operation.group);
    if (!destination) throw new EditConflict('Die Zielgruppe wurde inzwischen entfernt.');
  }

  const hasPatch = Object.keys(patch).length > 0;
  if (hasPatch) {
    entry.pushHistory();
    const historical = entry.history.at(-1);
    if (entry.customData) historical.customData = new Map(entry.customData);
    historical.qualityCheck = entry.qualityCheck;
    historical.previousParentGroup = entry.previousParentGroup;
    setFields(entry, patch);
    const nextSecond = Math.floor(entry.lastModTime / 1000) * 1000 + 1000;
    entry.times.update();
    entry.times.lastModTime = new Date(Math.max(Date.now(), nextSecond));
  }
  if (destination) db.move(entry, destination);
  return { changed: hasPatch || Boolean(destination), id: entry.uuid.id };
}
