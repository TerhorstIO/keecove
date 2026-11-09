export const extensionApi = globalThis.browser ?? globalThis.chrome;

export function secureWebUrl(value) {
  try {
    const url = new URL(value);
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.username || url.password) return null;
    if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) return url;
  } catch {
    return null;
  }
  return null;
}

export function vaultAddress(value) {
  const url = secureWebUrl(value);
  return url && url.href === `${url.origin}/` ? url : null;
}

export function hostPattern(url) {
  // Host permissions omit the port. Tab and script checks use the full origin.
  return `${url.protocol}//${url.hostname}/*`;
}
