// Chromium serialisiert diese Funktionen und führt sie ohne Modulkontext aus.
export function requestVault(expectedUrl, request) {
  if (window.top !== window || !window.isSecureContext || location.href !== expectedUrl) return null;
  if (typeof window.keevaultBrowser?.request !== 'function') return { status: 'unavailable' };
  return window.keevaultBrowser.request(request);
}

export function probeTarget(expectedOrigin) {
  return window.top === window && window.isSecureContext && location.origin === expectedOrigin;
}

export function fillLogin(expectedOrigin, credential) {
  if (window.top !== window || !window.isSecureContext || location.origin !== expectedOrigin) return false;

  function editable(input) {
    return input instanceof HTMLInputElement
      && !input.matches(':disabled')
      && !input.readOnly
      && input.offsetWidth > 0
      && input.offsetHeight > 0
      && input.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }

  function hasAutocomplete(input, value) {
    return (input.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/).includes(value);
  }

  function safeAction(action) {
    try {
      return new URL(action || location.href, document.baseURI).origin === expectedOrigin;
    } catch {
      return false;
    }
  }

  const passwords = [...document.querySelectorAll('input[type="password"]')].filter(editable);
  const current = passwords.filter((input) => hasAutocomplete(input, 'current-password'));
  const candidates = current.length ? current : passwords.filter((input) => !hasAutocomplete(input, 'new-password'));
  if (candidates.length !== 1) return false;

  const [password] = candidates;
  const form = password.form;
  if (form) {
    if (form.getAttribute('method')?.toLowerCase() !== 'post' || !safeAction(form.getAttribute('action'))) return false;
    const submitters = document.querySelectorAll('[formaction], [formmethod]');
    for (const submitter of submitters) {
      if (submitter.form !== form || !['submit', 'image'].includes(submitter.type)) continue;
      const method = submitter.getAttribute('formmethod');
      const action = submitter.getAttribute('formaction');
      if ((method !== null && method.toLowerCase() !== 'post') || (action !== null && !safeAction(action))) return false;
    }
  }

  const inputs = form ? [...form.elements] : [...document.querySelectorAll('input')];
  const textInputs = inputs.filter((input) => editable(input) && ['text', 'email', 'tel'].includes(input.type));
  const named = textInputs.filter((input) => hasAutocomplete(input, 'username'));
  const preceding = textInputs.filter((input) => (form || input.type === 'email')
    && !hasAutocomplete(input, 'one-time-code')
    && (input.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING));
  const users = named.length ? named : preceding;

  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const filled = [];
  if (users.length === 1 && credential.username) {
    setter.call(users[0], credential.username);
    filled.push(users[0]);
  }
  setter.call(password, credential.password);
  filled.push(password);

  for (const input of filled) {
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return true;
}
