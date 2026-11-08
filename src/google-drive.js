import { MAX_IMPORT_FILE_BYTES } from './import-session.js';
import { readImportDownload } from './import-bytes.js';

const folderMimeType = 'application/vnd.google-apps.folder';
const api = 'https://www.googleapis.com/drive/v3/files';

export async function connectGoogleDrive({ clientId, authenticate }) {
  const accessToken = await authenticate({
    provider: 'google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    clientId,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    authorizeParams: { prompt: 'select_account' }
  });

  async function request(url, signal) {
    const timeout = AbortSignal.timeout(60_000);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error('Google Drive hat den Zugriff verweigert. Prüfe die Freigabe oder melde dich erneut an.');
    }
    if (!response.ok) throw new Error('Google Drive konnte die Anfrage nicht ausführen.');
    return response;
  }

  return {
    async list(folder, nextPage, signal) {
      const parent = folder?.id ?? 'root';
      if (!/^[\w-]+$/.test(parent)) throw new Error('Ungültiger Google-Drive-Ordner.');
      const url = new URL(api);
      url.search = new URLSearchParams({
        q: `'${parent}' in parents and trashed = false`,
        orderBy: 'folder,name_natural',
        fields: 'nextPageToken,files(id,name,mimeType,size)',
        pageSize: '100'
      });
      if (nextPage) url.searchParams.set('pageToken', nextPage);
      const data = await (await request(url, signal)).json();
      const items = (data.files ?? []).filter((item) => typeof item.id === 'string' && typeof item.name === 'string')
        .map((item) => ({
          id: item.id, name: item.name, size: Number(item.size),
          kind: item.mimeType === folderMimeType ? 'folder' : 'file'
        }))
        .filter((item) => item.kind === 'folder' || item.name.toLowerCase().endsWith('.kdbx'));
      return { items, nextPage: data.nextPageToken ?? null };
    },

    async download(file, signal) {
      if (file.size > MAX_IMPORT_FILE_BYTES) throw new Error('Die Datei überschreitet das Importlimit von 128 MiB.');
      if (file.kind !== 'file' || !/^[\w-]+$/.test(file.id)) throw new Error('Ungültige Google-Drive-Datei.');
      return readImportDownload(await request(`${api}/${encodeURIComponent(file.id)}?alt=media`, signal));
    }
  };
}
