import { MAX_IMPORT_FILE_BYTES } from './import-session.js';

const graphOrigin = 'https://graph.microsoft.com';
const graphScope = `${graphOrigin}/Files.Read`;

function graphUrl(path) {
  const url = new URL(path, graphOrigin);
  if (url.origin !== graphOrigin || url.username || url.password ||
      !/^\/v1\.0\/(?:me\/drive\/|drives\/)/.test(url.pathname)) {
    throw new Error('OneDrive hat eine ungültige Folgeadresse geliefert.');
  }
  return url;
}

function graphItemPath(item) {
  const path = item.driveId ? `/v1.0/drives/${encodeURIComponent(item.driveId)}` : '/v1.0/me/drive';
  return `${path}/items/${encodeURIComponent(item.id)}`;
}

function toFile(item) {
  const data = item?.remoteItem ?? item;
  const name = data?.name ?? item?.name;
  if (typeof data?.id !== 'string' || !data.id || typeof name !== 'string' || !name) return;
  const kind = data.folder ? 'folder' : data.file && /\.kdbx$/i.test(name) ? 'file' : null;
  if (!kind) return;
  return { id: data.id, name, kind, driveId: data.parentReference?.driveId, size: data.size };
}

async function fetchGraph(path, accessToken, signal) {
  const url = graphUrl(path);
  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
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
  if (response.status === 401) throw new Error('Die OneDrive-Anmeldung ist abgelaufen. Melde dich erneut an.');
  if (response.status === 403) throw new Error('OneDrive erlaubt keinen Zugriff auf diese Datei oder diesen Ordner.');
  if (response.status === 404) throw new Error('Die Datei oder der Ordner ist in OneDrive nicht mehr verfügbar.');
  if (!response.ok) throw new Error('OneDrive konnte die Anfrage nicht abschließen.');
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
  return {
    async list(folder = null, nextPage = null, signal = AbortSignal.timeout(20_000)) {
      const path = folder ? `${graphItemPath(folder)}/children` : '/v1.0/me/drive/root/children';
      const url = graphUrl(nextPage ?? path);
      if (!nextPage) {
        url.searchParams.set('$select', 'id,name,folder,file,parentReference,remoteItem,size');
        url.searchParams.set('$top', '100');
      }
      const page = await fetchGraph(url, accessToken, signal);
      if (!Array.isArray(page.value)) throw new Error('OneDrive hat eine ungültige Dateiliste geliefert.');
      return {
        items: page.value.map(toFile).filter(Boolean),
        nextPage: page['@odata.nextLink'] ? graphUrl(page['@odata.nextLink']).href : null
      };
    },

    async download(file, signal = AbortSignal.timeout(60_000)) {
      if (file?.kind !== 'file' || !/\.kdbx$/i.test(file.name)) throw new Error('Wähle eine OneDrive-Tresordatei aus.');
      if (file.size > MAX_IMPORT_FILE_BYTES) throw new Error('Die Tresordatei überschreitet das Importlimit von 128 MiB.');
      const url = graphUrl(graphItemPath(file));
      url.searchParams.set('$select', 'id,size,@microsoft.graph.downloadUrl');
      const item = await fetchGraph(url, accessToken, signal);
      if (item.size > MAX_IMPORT_FILE_BYTES) throw new Error('Die Tresordatei überschreitet das Importlimit von 128 MiB.');
      return downloadUrl(safeDownloadUrl(item['@microsoft.graph.downloadUrl']));
    }
  };
}
