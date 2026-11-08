export function downloadImportUrl(input, signal) {
  const url = URL.parse(input);
  if (!url || url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Die Cloud hat keine gültige HTTPS-Download-Adresse geliefert.');
  }
  signal?.throwIfAborted();
  url.hash = '';
  const worker = new Worker(new URL('./import-download.worker.js', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    const finish = (action, value) => {
      worker.terminate();
      signal?.removeEventListener('abort', abort);
      action(value);
    };
    const abort = () => finish(reject, signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }) => data.error ? finish(reject, new Error(data.error)) : finish(resolve, data.bytes);
    worker.onerror = () => finish(reject, new Error('Der Download konnte im Browser nicht gestartet werden.'));
    worker.postMessage(url.href);
  });
}
