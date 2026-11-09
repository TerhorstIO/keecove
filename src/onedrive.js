import { checkImportBytes } from './import-bytes.js';
import { MAX_IMPORT_FILE_BYTES } from './import-session.js';
import { CloudAuthError, VaultSourceConflictError } from './vault-source.js';

const graphOrigin = 'https://graph.microsoft.com';
const graphScope = `${graphOrigin}/Files.ReadWrite`;

function graphUrl(path) {
  const url = new URL(path, graphOrigin);
  if (url.origin !== graphOrigin || url.username || url.password ||
      !/^\/v1\.0\/(?:me\/drive\/|drives\/)/.test(url.pathname)) {
    throw new Error('OneDrive hat eine ungültige Folgeadresse geliefert.');
  }
  return url;
}

function graphItemPath(item) {
  const path = item.driveId ? `/v1.0/drives/${itemSegment(item.driveId)}` : '/v1.0/me/drive';
  return `${path}/items/${itemSegment(item.id)}`;
}

function itemSegment(id) {
  if (typeof id !== 'string' || !id || id === '.' || id === '..') {
    throw new Error('OneDrive hat eine ungültige Dateikennung geliefert.');
  }
  return encodeURIComponent(id);
}

function toFile(item) {
  const data = item?.remoteItem ?? item;
  const name = data?.name ?? item?.name;
  if (typeof data?.id !== 'string' || !data.id || typeof name !== 'string' || !name) return;
  const kind = data.folder ? 'folder' : data.file && /\.kdbx$/i.test(name) ? 'file' : null;
  if (!kind) return;
  return { id: data.id, name, kind, driveId: data.parentReference?.driveId, size: data.size };
}

function deadline(signal, milliseconds) {
  const timeout = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function fetchGraph(path, accessToken, signal, { method = 'GET', headers, body } = {}) {
  const url = graphUrl(path);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { ...headers, Authorization: `Bearer ${accessToken}` },
      body,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new Error('OneDrive ist gerade nicht erreichbar.', { cause: error });
  }
  if (response.status === 401) throw new CloudAuthError('OneDrive');
  if (response.status === 403) throw new Error('OneDrive erlaubt keinen Zugriff auf diese Datei oder diesen Ordner.');
  if (response.status === 404) throw new Error('Die Datei oder der Ordner ist in OneDrive nicht mehr verfügbar.');
  if (response.status === 409 || response.status === 412 || response.status === 423) {
    throw new VaultSourceConflictError('Die OneDrive-Datei wurde geändert oder ist gesperrt.');
  }
  if (!response.ok) {
    const error = new Error('OneDrive konnte die Anfrage nicht abschließen.');
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function safeDownloadUrl(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    throw new Error('OneDrive hat keine gültige Download-Adresse geliefert.');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('OneDrive hat keine gültige HTTPS-Download-Adresse geliefert.');
  }
  return url.href;
}

function signedDownload(item) {
  return item['@microsoft.graph.downloadUrl'] || item['@downloadUrl'];
}

function revisionFromItem(item) {
  const value = item.eTag ?? item['@odata.etag'];
  if (typeof value === 'string' && value !== '*' && !value.startsWith('W/')) {
    // Personal OneDrive can return the opaque value without HTTP entity-tag quotes.
    const quoted = value.startsWith('"') ? value : `"${value}"`;
    if (/^"[\x21\x23-\x7e]+"$/.test(quoted)) return quoted;
  }
}

function strongRevision(item) {
  const revision = revisionFromItem(item);
  if (!revision) throw new Error('OneDrive hat keine gültige Dateiversion geliefert.');
  return revision;
}

function canonicalFile(item, requested) {
  const driveId = item.parentReference?.driveId ?? requested.driveId;
  itemSegment(driveId);
  if (item.id !== requested.id || (requested.driveId && requested.driveId !== driveId)) {
    throw new VaultSourceConflictError('OneDrive hat eine andere Datei zurückgegeben.');
  }
  return { provider: 'onedrive', id: item.id, driveId, name: item.name || requested.name };
}

export async function connectOneDrive({ clientId, tenant = 'common', authenticate, downloadUrl }) {
  if (!/^(?:common|organizations|consumers|[a-z\d][a-z\d.-]*[a-z\d])$/i.test(tenant)) {
    throw new Error('OneDrive ist nicht verfügbar.');
  }
  const endpoint = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
  const accessToken = await authenticate({
    provider: 'onedrive',
    clientId,
    authorizeUrl: `${endpoint}/authorize`,
    tokenUrl: `${endpoint}/token`,
    scope: graphScope,
    authorizeParams: { prompt: 'select_account' }
  });

  async function readMetadata(file, includeDownload, signal) {
    const url = graphUrl(graphItemPath(file));
    const fields = 'id,name,parentReference,size,eTag';
    url.searchParams.set('$select', includeDownload ? `${fields},@microsoft.graph.downloadUrl` : fields);
    try {
      const item = await fetchGraph(url, accessToken, signal);
      if (!includeDownload || signedDownload(item)) return item;
    } catch (error) {
      if (!includeDownload || error.status !== 400) throw error;
    }
    // Some OneDrive endpoints omit instance annotations from a projected response.
    return fetchGraph(graphItemPath(file), accessToken, signal);
  }

  async function readFile(file, previousRevision, signal) {
    const requestSignal = deadline(signal, 60_000);
    if (previousRevision != null) {
      const current = await readMetadata(file, false, requestSignal);
      canonicalFile(current, file);
      if (strongRevision(current) === previousRevision) return null;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const item = await readMetadata(file, true, requestSignal);
      const cloudFile = canonicalFile(item, file);
      const revision = strongRevision(item);
      if (revision === previousRevision) return null;
      if (item.size > MAX_IMPORT_FILE_BYTES) throw new Error('Die Tresordatei überschreitet das Importlimit von 128 MiB.');
      const bytes = checkImportBytes(await downloadUrl(safeDownloadUrl(signedDownload(item)), requestSignal));
      const current = await readMetadata(cloudFile, false, requestSignal);
      canonicalFile(current, cloudFile);
      if (strongRevision(current) === revision) return { bytes, revision, cloudFile };
    }
    throw new VaultSourceConflictError('Die OneDrive-Datei wurde während des Lesens geändert.');
  }

  return {
    async list(folder = null, nextPage = null, signal) {
      const path = folder ? `${graphItemPath(folder)}/children` : '/v1.0/me/drive/root/children';
      const url = graphUrl(nextPage ?? path);
      if (!nextPage) {
        url.searchParams.set('$select', 'id,name,folder,file,parentReference,remoteItem,size');
        url.searchParams.set('$top', '100');
      }
      const page = await fetchGraph(url, accessToken, deadline(signal, 20_000));
      if (!Array.isArray(page.value)) throw new Error('OneDrive hat eine ungültige Dateiliste geliefert.');
      return {
        items: page.value.map(toFile).filter(Boolean),
        nextPage: page['@odata.nextLink'] ? graphUrl(page['@odata.nextLink']).href : null
      };
    },

    async open(file, signal) {
      if (file?.kind !== 'file' || !/\.kdbx$/i.test(file.name)) throw new Error('Wähle eine OneDrive-Tresordatei aus.');
      if (file.size > MAX_IMPORT_FILE_BYTES) throw new Error('Die Tresordatei überschreitet das Importlimit von 128 MiB.');
      return readFile(file, null, signal);
    },

    source(cloudFile) {
      if (cloudFile?.provider !== 'onedrive' || !cloudFile.driveId) {
        throw new Error('Die OneDrive-Datei muss erneut ausgewählt werden.');
      }
      const path = graphItemPath(cloudFile);
      return {
        label: 'OneDrive',

        async read(previousRevision, signal) {
          const result = await readFile(cloudFile, previousRevision, signal);
          return result && { bytes: result.bytes, revision: result.revision };
        },

        async write(bytes, expectedRevision, { signal, beforeCommit } = {}) {
          checkImportBytes(bytes);
          const revision = strongRevision({ eTag: expectedRevision });
          const requestSignal = deadline(signal, 120_000);
          requestSignal.throwIfAborted();
          const current = await readMetadata(cloudFile, false, requestSignal);
          canonicalFile(current, cloudFile);
          if (strongRevision(current) !== revision) {
            throw new VaultSourceConflictError('Die OneDrive-Datei wurde zwischenzeitlich geändert.');
          }
          await beforeCommit?.();
          requestSignal.throwIfAborted();
          const item = await fetchGraph(`${path}/content`, accessToken, requestSignal, {
            method: 'PUT',
            headers: { 'If-Match': revision, 'Content-Type': 'text/plain' },
            body: bytes
          });
          canonicalFile(item, cloudFile);
          // A 2xx response may omit the updated tag. The caller rereads before writing again.
          return revisionFromItem(item);
        }
      };
    }
  };
}
