import { sha256 } from '@noble/hashes/sha2.js';

function randomValue(bytes = crypto.getRandomValues(new Uint8Array(32))) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function waitForAuthorization(url, state, tokenFlow, signal) {
  return new Promise((resolve, reject) => {
    const channel = new BroadcastChannel(`keevault-auth-${state}`);
    const timeout = setTimeout(() => finish(reject, new Error('Die Anmeldung ist abgelaufen. Öffne sie erneut.')), 300_000);
    const abort = () => finish(reject, signal.reason);
    function finish(action, value) {
      channel.close();
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      action(value);
    }
    channel.onmessage = ({ data }) => {
      if (data?.state !== state) return;
      const value = tokenFlow ? data.accessToken : data.code;
      if (typeof value !== 'string' || !value || value.length > 4096 ||
          (tokenFlow && data.tokenType?.toLowerCase() !== 'bearer')) {
        finish(reject, new Error('Die Cloud-Anmeldung wurde abgebrochen oder der Zugriff wurde nicht erlaubt.'));
      } else {
        finish(resolve, value);
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    // The callback uses a per-request same-origin channel, so the provider has no opener reference.
    window.open(url.href, '_blank', 'noopener,noreferrer,popup,width=620,height=740');
  });
}

export async function authenticate({ provider, authorizeUrl, tokenUrl, clientId, scope, authorizeParams }, signal) {
  signal?.throwIfAborted();
  if (!window.isSecureContext) throw new Error('Für die Cloud-Anmeldung ist eine sichere Browser-Verbindung erforderlich.');
  const redirectUri = new URL('/cloud-callback.html', location.origin).href;
  const state = randomValue();
  const tokenFlow = provider === 'google';
  const verifier = tokenFlow ? null : randomValue();
  const url = new URL(authorizeUrl);
  url.search = new URLSearchParams({
    ...authorizeParams,
    client_id: clientId, response_type: tokenFlow ? 'token' : 'code', redirect_uri: redirectUri, scope, state,
    ...(verifier && { code_challenge: randomValue(sha256(new TextEncoder().encode(verifier))), code_challenge_method: 'S256' })
  });
  const authorization = await waitForAuthorization(url, state, tokenFlow, signal);
  if (tokenFlow) return authorization;
  const exchangeTimeout = AbortSignal.timeout(20_000);
  const exchangeSignal = signal ? AbortSignal.any([signal, exchangeTimeout]) : exchangeTimeout;
  const response = await fetch(tokenUrl, {
    method: 'POST', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
    redirect: 'error', signal: exchangeSignal,
    body: new URLSearchParams({
      client_id: clientId, grant_type: 'authorization_code', code: authorization,
      redirect_uri: redirectUri, code_verifier: verifier
    })
  });
  if (!response.ok) throw new Error('Die Cloud-Anmeldung ist fehlgeschlagen.');
  const token = await response.json();
  if (typeof token.access_token !== 'string' || token.token_type?.toLowerCase() !== 'bearer') {
    throw new Error('Die Cloud-Anmeldung ist fehlgeschlagen.');
  }
  return token.access_token;
}
