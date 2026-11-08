import { readImportDownload } from './import-bytes.js';
import { MAX_IMPORT_FILE_BYTES } from './import-session.js';

const apiOrigin = 'https://api.dropboxapi.com';
const contentOrigin = 'https://content.dropboxapi.com';

function toFile(item) {
  if (typeof item?.id !== 'string' || !item.id || typeof item.name !== 'string' || !item.name) return;
  const type = item['.tag'];
  if (type === 'folder') return { id: item.id, name: item.name, kind: 'folder' };
  if (type === 'file' && item.is_downloadable !== false && /\.kdbx$/i.test(item.name)) {
    return { id: item.id, name: item.name, kind: 'file', size: item.size };
  }
}

async function requestDropbox(url, accessToken, { headers, body, signal }) {
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
      signal
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new Error('Dropbox ist gerade nicht erreichbar.', { cause: error });
  }
  if (response.status === 401) throw new Error('Die Dropbox-Anmeldung ist abgelaufen. Melde dich erneut an.');
  if (response.status === 403) throw new Error('Dropbox erlaubt keinen Zugriff auf diese Datei oder diesen Ordner.');
  if (response.status === 409) throw new Error('Dropbox konnte die Datei oder den Ordner nicht öffnen.');
  if (!response.ok) throw new Error('Dropbox konnte die Anfrage nicht abschließen.');
  return response;
}

export async function connectDropbox({ clientId, authenticate }) {
  const accessToken = await authenticate({
    provider: 'dropbox',
    clientId,
    authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: `${apiOrigin}/oauth2/token`,
    scope: 'files.metadata.read files.content.read',
    authorizeParams: { token_access_type: 'online' }
  });
  return {
    async list(folder = null, nextPage = null, signal = AbortSignal.timeout(20_000)) {
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

    async download(file, signal = AbortSignal.timeout(60_000)) {
      if (file?.kind !== 'file' || !/\.kdbx$/i.test(file.name)) throw new Error('Wähle eine Dropbox-Tresordatei aus.');
      if (file.size > MAX_IMPORT_FILE_BYTES) throw new Error('Die Tresordatei überschreitet das Importlimit von 128 MiB.');
      const argument = JSON.stringify({ path: file.id }).replace(/[\u007f-\uffff]/g, (character) =>
        '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
      const response = await requestDropbox(`${contentOrigin}/2/files/download`, accessToken, {
        headers: { 'Dropbox-API-Arg': argument },
        signal
      });
      return readImportDownload(response);
    }
  };
}
