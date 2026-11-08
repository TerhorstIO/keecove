import { readImportDownload } from './import-bytes.js';

self.onmessage = async ({ data: url }) => {
  try {
    let response;
    try {
      response = await fetch(url, {
        credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(60_000)
      });
    } catch {
      throw new Error('Die Cloud-Datei konnte nicht geladen werden.');
    }
    if (new URL(response.url).protocol !== 'https:') throw new Error('Die Cloud-Datei konnte nicht sicher geladen werden.');
    const bytes = await readImportDownload(response);
    self.postMessage({ bytes }, [bytes]);
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
