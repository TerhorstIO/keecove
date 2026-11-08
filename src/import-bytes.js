import { assertImportFileBytes, MAX_IMPORT_FILE_BYTES } from './import-session.js';

export function checkImportBytes(bytes) {
  assertImportFileBytes(bytes);
  return bytes;
}

export async function readImportDownload(response) {
  if (!response.ok || !response.body) throw new Error('Die Tresordatei konnte nicht heruntergeladen werden.');
  if (Number(response.headers.get('Content-Length')) > MAX_IMPORT_FILE_BYTES) {
    await response.body.cancel();
    throw new Error('Die Datei überschreitet das Importlimit von 128 MiB.');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMPORT_FILE_BYTES) {
        await reader.cancel();
        throw new Error('Die Datei überschreitet das Importlimit von 128 MiB.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return checkImportBytes(bytes.buffer);
}
