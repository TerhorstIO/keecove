const browsers = {
  chrome: {
    name: 'Chrome',
    archive: '/keecove-browser.zip',
    settings: 'chrome://extensions',
  },
  edge: {
    name: 'Edge',
    archive: '/keecove-browser.zip',
    settings: 'edge://extensions',
  },
  firefox: {
    name: 'Firefox',
    archive: '/keecove-firefox.zip',
    settings: 'about:debugging#/runtime/this-firefox',
  },
};

export function detectExtensionBrowser({ userAgent = '', userAgentData } = {}) {
  if (userAgentData?.mobile || /Android|iPhone|iPad|iPod/i.test(userAgent)) return null;
  const brands = userAgentData?.brands?.map(({ brand }) => brand) ?? [];
  if (brands.includes('Microsoft Edge') || /\bEdg(?:e)?\//.test(userAgent)) return 'edge';
  if (/\bFirefox\//.test(userAgent)) return 'firefox';
  if (/\b(?:OPR|Vivaldi|SamsungBrowser)\//.test(userAgent)) return null;
  if (brands.includes('Google Chrome') || /\bChrome\//.test(userAgent)) return 'chrome';
  return null;
}

export function createExtensionInstaller() {
  const browser = detectExtensionBrowser(navigator);
  const details = browser && browsers[browser];
  const label = details ? `${details.name}-Erweiterung installieren` : 'Browser-Erweiterung installieren';
  let installUrl;
  let dialog;

  if (details) {
    fetch('/extension-config.json', { cache: 'no-store', credentials: 'same-origin' })
      .then((response) => response.ok ? response.json() : null)
      .then((config) => {
        if (typeof config?.[browser] !== 'string') return;
        const url = new URL(config[browser]);
        if (url.protocol !== 'https:' || url.username || url.password) return;
        installUrl = url;
        if (dialog?.open) renderDialog();
      })
      .catch(() => {});
  }

  function install() {
    if (browser === 'firefox' && installUrl.pathname.toLowerCase().endsWith('.xpi')) {
      window.location.assign(installUrl.href);
    } else {
      window.open(installUrl.href, '_blank', 'noopener,noreferrer');
    }
  }

  function renderDialog() {
    const temporary = browser === 'firefox';
    dialog.innerHTML = `
      <div class="extension-dialog-header">
        <h2 id="extension-dialog-title">${label}</h2>
        <form method="dialog"><button class="btn quiet" type="submit">Schließen</button></form>
      </div>
      ${installUrl ? `
        <button class="btn primary" type="button" data-install-now>Installieren</button>` : details ? `
        <ol>
          <li><a href="${details.archive}" download>ZIP herunterladen</a>${temporary ? '.' : ' und entpacken.'}</li>
          <li><code>${details.settings}</code> öffnen.${temporary ? '' : ' Entwicklermodus aktivieren.'}</li>
          <li>${temporary ? '„Temporäres Add-on laden“ wählen und die ZIP öffnen.' : '„Entpackte Erweiterung laden“ wählen und den Ordner öffnen.'}</li>
        </ol>
        ${temporary ? '<p>Für Firefox ab Version 153. Die temporäre Installation endet beim Browser-Neustart.</p>' : ''}`
        : '<p>KeeCove bietet Erweiterungen für Chrome, Edge und Firefox am Desktop.</p>'}`;
    dialog.querySelector('[data-install-now]')?.addEventListener('click', install);
  }

  function open() {
    if (installUrl) {
      install();
      return;
    }
    if (dialog?.open) return;
    const panel = document.createElement('dialog');
    dialog = panel;
    panel.className = 'extension-dialog';
    panel.setAttribute('aria-labelledby', 'extension-dialog-title');
    panel.addEventListener('close', () => {
      panel.remove();
      if (dialog === panel) dialog = null;
    }, { once: true });
    document.body.append(panel);
    renderDialog();
    panel.showModal();
  }

  return { label, open, close: () => dialog?.close() };
}
