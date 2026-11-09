import { bytesToHex } from '@noble/hashes/utils.js';
import { MAX_IMPORT_FILE_BYTES } from './import-session.js';
import { checkImportBytes, readImportDownload } from './import-bytes.js';
import { CloudAuthError, VaultSourceConflictError } from './vault-source.js';

const folderMimeType = 'application/vnd.google-apps.folder';
const apiOrigin = 'https://www.googleapis.com';
const listEndpoint = `${apiOrigin}/drive/v3/files`;
const fileEndpoint = `${apiOrigin}/drive/v2/files`;
const uploadEndpoint = `${apiOrigin}/upload/drive/v2/files`;
const fileFields = 'id,fileSize,labels(trashed),version,etag,capabilities(canModifyContent),mimeType,sha256Checksum';
const multipartLimit = 5_000_000;

function fileRevision(item) {
  if (typeof item.version !== 'string' || !/^\d+$/.test(item.version)) return;
  const etag = typeof item.etag === 'string' && /^"[\x21\x23-\x7e]+"$/.test(item.etag) ? item.etag : '';
  return { etag, revision: `${item.version}:${etag}` };
}

function resumableUrl(location, original) {
  const url = location && URL.parse(location, original);
  const paths = [original.pathname, `/resumable${original.pathname}`];
  const uploadType = url && url.searchParams.get('uploadType');
  if (!url || url.origin !== apiOrigin || !paths.includes(url.pathname) || url.username || url.password ||
      (uploadType !== null && uploadType !== 'resumable') || !url.searchParams.get('upload_id')) {
    throw new Error('Google Drive hat keine gültige Adresse für den Upload geliefert.');
  }
  return url;
}

async function matchesChecksum(bytes, checksum) {
  if (!checksum) return true;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return typeof checksum === 'string' && bytesToHex(digest) === checksum.toLowerCase();
}

export async function connectGoogleDrive({ clientId, authenticate }) {
  const accessToken = await authenticate({
    provider: 'google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    clientId,
    scope: 'https://www.googleapis.com/auth/drive',
    authorizeParams: { prompt: 'select_account' }
  });

  async function request(url, signal, { method = 'GET', headers, body, timeoutMs = 60_000 } = {}) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetch(url, {
      method, headers: { ...headers, Authorization: `Bearer ${accessToken}` }, body,
      credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    if (response.status === 401) throw new CloudAuthError('Google Drive');
    if (response.status === 412) {
      throw new VaultSourceConflictError('Die Tresordatei wurde in Google Drive zwischenzeitlich geändert.');
    }
    if (response.status === 403) {
      throw new Error('Google Drive hat den Zugriff verweigert. Prüfe die Freigabe oder melde dich erneut an.');
    }
    if (response.status === 404) throw new Error('Die Datei ist in Google Drive nicht mehr verfügbar.');
    if (!response.ok) throw new Error('Google Drive konnte die Anfrage nicht ausführen.');
    return response;
  }

  function source(file) {
    if (file?.provider !== 'google' || !/^[\w-]+$/.test(file.id ?? '') || !/\.kdbx$/i.test(file.name ?? '')) {
      throw new Error('Ungültige Google-Drive-Datei.');
    }
    const id = encodeURIComponent(file.id);
    const item = `${fileEndpoint}/${id}`;
    const metadataUrl = new URL(item);
    metadataUrl.search = new URLSearchParams({ fields: fileFields, supportsAllDrives: 'true' });
    async function metadata(signal) {
      const data = await (await request(metadataUrl, signal)).json();
      const revision = fileRevision(data);
      if (data.id !== file.id || data.labels?.trashed || !revision) {
        throw new Error('Die Dateiversion in Google Drive konnte nicht geprüft werden.');
      }
      if (Number(data.fileSize) > MAX_IMPORT_FILE_BYTES) throw new Error('Die Datei überschreitet das Importlimit von 128 MiB.');
      return { ...data, ...revision };
    }
    return {
      label: 'Google Drive',
      async read(previousRevision, signal) {
        for (let attempt = 0; attempt < 2; attempt++) {
          const { revision, sha256Checksum } = await metadata(signal);
          if (revision === previousRevision) return null;
          const bytes = await readImportDownload(await request(`${item}?alt=media&supportsAllDrives=true`, signal));
          const current = await metadata(signal);
          if (current.revision === revision && await matchesChecksum(bytes, sha256Checksum)) return { bytes, revision };
        }
        throw new VaultSourceConflictError('Die Tresordatei wird gerade in Google Drive geändert. Versuche es erneut.');
      },

      async write(bytes, expectedRevision, { signal, beforeCommit } = {}) {
        checkImportBytes(bytes);
        const current = await metadata(signal);
        if (current.revision !== expectedRevision) throw new VaultSourceConflictError();
        if (current.capabilities?.canModifyContent === false) throw new Error('Die Datei ist in Google Drive schreibgeschützt.');
        if (!current.etag) {
          throw new Error('Die Datei kann in Google Drive nicht mit Versionsprüfung gespeichert werden.');
        }
        const contentType = typeof current.mimeType === 'string' && /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(current.mimeType)
          ? current.mimeType : 'application/octet-stream';
        const upload = new URL(`${uploadEndpoint}/${id}`);
        upload.search = new URLSearchParams({ supportsAllDrives: 'true', fields: 'id,etag,version' });
        let destination = upload;
        let body = bytes;
        let headers;
        if (bytes.byteLength <= multipartLimit) {
          upload.searchParams.set('uploadType', 'multipart');
          const boundary = `keecove-${crypto.randomUUID()}`;
          body = new Blob([
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{}\r\n`,
            `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
            bytes,
            `\r\n--${boundary}--\r\n`
          ]);
          headers = { 'If-Match': current.etag, 'Content-Type': `multipart/related; boundary=${boundary}` };
        } else {
          upload.searchParams.set('uploadType', 'resumable');
          // Chromium's Drive v2 client sets If-Match at initiation and handles 412 on the final PUT.
          const started = await request(upload, signal, {
            method: 'PUT', headers: {
              'If-Match': current.etag,
              'X-Upload-Content-Type': contentType,
              'X-Upload-Content-Length': String(bytes.byteLength)
            }
          });
          destination = resumableUrl(started.headers.get('Location'), upload);
          if ((await metadata(signal)).revision !== expectedRevision) throw new VaultSourceConflictError();
          headers = { 'Content-Type': contentType, 'Content-Range': `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}` };
        }
        await beforeCommit?.();
        signal?.throwIfAborted();
        const response = await request(destination, signal, { method: 'PUT', headers, body, timeoutMs: 120_000 });
        const saved = await response.json();
        if (saved.id !== file.id) throw new Error('Google Drive hat den Schreibvorgang für diese Datei nicht bestätigt.');
        return fileRevision(saved)?.revision;
      }
    };
  }

  return {
    async list(folder, nextPage, signal) {
      const parent = folder?.id ?? 'root';
      if (!/^[\w-]+$/.test(parent)) throw new Error('Ungültiger Google-Drive-Ordner.');
      const url = new URL(listEndpoint);
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

    async open(file, signal) {
      if (file.size > MAX_IMPORT_FILE_BYTES) throw new Error('Die Datei überschreitet das Importlimit von 128 MiB.');
      if (file.kind !== 'file') throw new Error('Ungültige Google-Drive-Datei.');
      const cloudFile = { provider: 'google', id: file.id, name: file.name };
      return { ...await source(cloudFile).read(undefined, signal), cloudFile };
    },

    source
  };
}
