import { checkImportBytes, readImportDownload } from './import-bytes.js';
import { MAX_IMPORT_FILE_BYTES } from './import-session.js';
import { CloudAuthError, VaultSourceConflictError } from './vault-source.js';

const apiOrigin = 'https://api.dropboxapi.com';
const contentOrigin = 'https://content.dropboxapi.com';
const fileId = /^id:[^\r\n]+$/;
const fileRevision = /^[0-9a-f]{9,}$/;

function toFile(item) {
  if (typeof item?.id !== 'string' || !fileId.test(item.id) || typeof item.name !== 'string' || !item.name) return;
  const type = item['.tag'];
  if (type === 'folder') return { id: item.id, name: item.name, kind: 'folder' };
  if (type === 'file' && item.is_downloadable !== false && /\.kdbx$/i.test(item.name)) {
    return { id: item.id, name: item.name, kind: 'file', size: item.size };
  }
}

function apiArgument(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) =>
    '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
}

function revisionOf(item, id) {
  if (item?.id !== id) throw new VaultSourceConflictError('Dropbox hat eine andere Datei zurückgegeben.');
  if (typeof item.rev !== 'string' || !fileRevision.test(item.rev)) {
    throw new Error('Dropbox hat keine gültige Dateiversion geliefert.');
  }
  return item.rev;
}

async function requestDropbox(url, accessToken, { headers, body, signal, timeoutMs = 20_000 }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  requestSignal.throwIfAborted();
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, Authorization: `Bearer ${accessToken}` },
      body,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: requestSignal
    });
  } catch (error) {
    if (requestSignal.aborted) throw requestSignal.reason;
    throw new Error('Dropbox ist gerade nicht erreichbar.', { cause: error });
  }
  if (response.status === 401) throw new CloudAuthError('Dropbox');
  if (response.status === 403) throw new Error('Dropbox erlaubt keinen Zugriff auf diese Datei oder diesen Ordner.');
  if (response.status === 409) {
    if (url === `${contentOrigin}/2/files/upload`) {
      const result = await response.json().catch(() => null);
      requestSignal.throwIfAborted();
      const error = result?.error;
      if (error?.['.tag'] === 'path' && error.path?.['.tag'] === 'conflict') {
        throw new VaultSourceConflictError('Die Dropbox-Datei wurde zwischenzeitlich geändert.');
      }
      throw new Error('Dropbox konnte die Datei nicht speichern.');
    }
    throw new Error('Dropbox konnte die Datei oder den Ordner nicht öffnen.');
  }
  if (!response.ok) throw new Error('Dropbox konnte die Anfrage nicht abschließen.');
  return response;
}

export async function connectDropbox({ clientId, authenticate }) {
  const accessToken = await authenticate({
    provider: 'dropbox',
    clientId,
    authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: `${apiOrigin}/oauth2/token`,
    scope: 'files.metadata.read files.content.read files.content.write',
    authorizeParams: { token_access_type: 'online' }
  });

  async function downloadFile(id, signal) {
    const response = await requestDropbox(`${contentOrigin}/2/files/download`, accessToken, {
      headers: { 'Dropbox-API-Arg': apiArgument({ path: id }) },
      signal,
      timeoutMs: 60_000
    });
    let metadata;
    try {
      metadata = JSON.parse(response.headers.get('Dropbox-API-Result'));
    } catch {
      // Do not use a revision from a separate metadata request for downloaded bytes.
    }
    let revision;
    try {
      if (!metadata) throw new Error('Dropbox hat keine Dateiversion für den Download geliefert.');
      revision = revisionOf(metadata, id);
    } catch (error) {
      await response.body?.cancel().catch(() => {});
      throw error;
    }
    return { bytes: await readImportDownload(response), revision };
  }

  return {
    async list(folder = null, nextPage = null, signal) {
      const path = nextPage ? '/2/files/list_folder/continue' : '/2/files/list_folder';
      const body = nextPage ? { cursor: nextPage } : { path: folder?.id ?? '', limit: 100 };
      const response = await requestDropbox(apiOrigin + path, accessToken, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal
      });
      const page = await response.json();
      if (!Array.isArray(page.entries) || (page.has_more && typeof page.cursor !== 'string')) {
        throw new Error('Dropbox hat eine ungültige Dateiliste geliefert.');
      }
      return { items: page.entries.map(toFile).filter(Boolean), nextPage: page.has_more ? page.cursor : null };
    },

    async open(file, signal) {
      if (file?.kind !== 'file' || typeof file.id !== 'string' || !fileId.test(file.id) ||
          typeof file.name !== 'string' || !/\.kdbx$/i.test(file.name)) {
        throw new Error('Wähle eine Dropbox-Tresordatei aus.');
      }
      if (file.size > MAX_IMPORT_FILE_BYTES) throw new Error('Die Tresordatei überschreitet das Importlimit von 128 MiB.');
      const result = await downloadFile(file.id, signal);
      return { ...result, cloudFile: { provider: 'dropbox', id: file.id, name: file.name } };
    },

    source(cloudFile) {
      const id = cloudFile?.id;
      if (cloudFile?.provider !== 'dropbox' || typeof id !== 'string' || !fileId.test(id)) {
        throw new Error('Die ursprüngliche Dropbox-Datei ist nicht verfügbar.');
      }
      return {
        label: 'Dropbox',
        async read(previousRevision, signal) {
          if (previousRevision) {
            const response = await requestDropbox(`${apiOrigin}/2/files/get_metadata`, accessToken, {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: id }),
              signal
            });
            if (revisionOf(await response.json(), id) === previousRevision) return null;
          }
          return downloadFile(id, signal);
        },
        async write(bytes, expectedRevision, { signal, beforeCommit } = {}) {
          checkImportBytes(bytes);
          if (typeof expectedRevision !== 'string' || !fileRevision.test(expectedRevision)) {
            throw new VaultSourceConflictError('Die Dateiversion für den Dropbox-Schreibzugriff fehlt.');
          }
          await beforeCommit?.();
          const response = await requestDropbox(`${contentOrigin}/2/files/upload`, accessToken, {
            headers: {
              'Content-Type': 'application/octet-stream',
              'Dropbox-API-Arg': apiArgument({
                path: id,
                mode: { '.tag': 'update', update: expectedRevision },
                autorename: false,
                strict_conflict: true
              })
            },
            body: bytes,
            signal,
            timeoutMs: 60_000
          });
          return revisionOf(await response.json(), id);
        }
      };
    }
  };
}
