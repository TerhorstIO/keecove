const tokenFlow = Boolean(location.hash);
const response = new URLSearchParams(tokenFlow ? location.hash.slice(1) : location.search);
history.replaceState(null, '', location.pathname);
const state = response.get('state');
if (/^[A-Za-z0-9_-]{43}$/.test(state ?? '')) {
  const channel = new BroadcastChannel(`keevault-auth-${state}`);
  const result = response.has('error') ? {} : tokenFlow
    ? { accessToken: response.get('access_token'), tokenType: response.get('token_type'), scope: response.get('scope') }
    : { code: response.get('code') };
  channel.postMessage({ state, ...result });
  channel.close();
  window.close();
}
