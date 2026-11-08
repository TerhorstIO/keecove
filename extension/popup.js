import { hostPattern, secureWebUrl, vaultAddress } from './config.js';
import { fillLogin, probeTarget, requestVault } from './injections.js';

const status = document.querySelector('#status');
const accounts = document.querySelector('#accounts');
const targetLabel = document.querySelector('#target');
const openVault = document.querySelector('#open-vault');

document.querySelector('#settings').addEventListener('click', async () => {
  try {
    await chrome.runtime.openOptionsPage();
  } catch {
    status.textContent = 'Die Einstellungen konnten nicht geöffnet werden.';
  }
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function findVaultTabs(vault, incognito) {
  const tabs = await chrome.tabs.query({ url: hostPattern(vault) });
  return tabs.filter((tab) => tab.url === vault.href && tab.incognito === incognito && Number.isInteger(tab.id));
}

async function callVault(target, vault, request) {
  const [response] = await chrome.scripting.executeScript({
    target,
    world: 'MAIN',
    func: requestVault,
    args: [vault.href, request],
  });
  return response;
}

async function fillAccount(vault, vaultTarget, target, id) {
  async function targetIsActive() {
    const tab = await getActiveTab();
    return tab?.id === target.tabId && secureWebUrl(tab.url)?.origin === target.origin;
  }

  for (const button of accounts.querySelectorAll('button')) button.disabled = true;
  status.textContent = 'Eintrag wird geprüft …';
  try {
    if (!await targetIsActive()) {
      status.textContent = 'Der aktive Tab hat gewechselt. Öffne die Erweiterung erneut.';
      return;
    }

    const response = await callVault(vaultTarget, vault, { action: 'fill', origin: target.origin, id });
    const result = response?.result;
    const entry = result?.entry;
    if (result?.status !== 'ok' || typeof entry?.username !== 'string' || typeof entry.password !== 'string' || !entry.password) {
      status.textContent = 'Der Eintrag ist derzeit nicht verfügbar. Prüfe den entsperrten Vault und öffne die Erweiterung erneut.';
      return;
    }
    if (!await targetIsActive()) {
      status.textContent = 'Der aktive Tab hat gewechselt. Öffne die Erweiterung erneut.';
      return;
    }

    const [filled] = await chrome.scripting.executeScript({
      target: { tabId: target.tabId, documentIds: [target.documentId] },
      world: 'ISOLATED',
      func: fillLogin,
      args: [target.origin, { username: entry.username, password: entry.password }],
    });
    status.textContent = filled?.result
      ? 'Anmeldedaten eingefügt. Du kannst das Formular jetzt prüfen und absenden.'
      : 'Kein eindeutiges, unterstütztes Anmeldeformular gefunden.';
  } catch {
    status.textContent = 'Ausfüllen fehlgeschlagen. Öffne die Erweiterung auf der Anmeldeseite erneut.';
  } finally {
    for (const button of accounts.querySelectorAll('button')) button.disabled = false;
  }
}

function renderAccounts(entries, vault, vaultTarget, target) {
  for (const entry of entries) {
    if (typeof entry?.id !== 'string' || !entry.id) continue;
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'account';
    button.textContent = typeof entry.title === 'string' && entry.title ? entry.title : 'Eintrag ohne Titel';
    if (typeof entry.username === 'string' && entry.username) {
      const username = document.createElement('small');
      username.textContent = entry.username;
      button.append(username);
    }
    button.addEventListener('click', () => fillAccount(vault, vaultTarget, target, entry.id));
    row.append(button);
    accounts.append(row);
  }
  status.textContent = accounts.childElementCount
    ? 'Wähle den Eintrag zum Ausfüllen.'
    : 'Kein KeePass-Eintrag mit dieser Adresse gefunden.';
}

async function load() {
  const settings = await chrome.storage.local.get('vaultUrl');
  const vault = vaultAddress(settings.vaultUrl);
  if (!vault) {
    status.textContent = 'KeeCove-Adresse fehlt.';
    return;
  }

  const tab = await getActiveTab();
  const incognito = tab?.incognito ?? false;
  openVault.hidden = false;
  openVault.addEventListener('click', async () => {
    try {
      const [existing] = await findVaultTabs(vault, incognito);
      if (existing) {
        await chrome.tabs.update(existing.id, { active: true });
        await chrome.windows.update(existing.windowId, { focused: true });
      } else {
        await chrome.tabs.create({ url: vault.href });
      }
    } catch {
      status.textContent = 'Der Vault konnte nicht geöffnet werden.';
    }
  });

  if (!await chrome.permissions.contains({ origins: [hostPattern(vault)] })) {
    status.textContent = 'Erteile den Host-Zugriff erneut über die Einstellungen.';
    return;
  }
  const url = secureWebUrl(tab?.url);
  if (!url || !Number.isInteger(tab.id) || url.origin === vault.origin) {
    status.textContent = 'Öffne die Erweiterung auf einer Anmeldeseite per HTTPS oder lokalem HTTP.';
    return;
  }

  targetLabel.textContent = url.origin;
  targetLabel.hidden = false;
  const [probe] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: probeTarget,
    args: [url.origin],
  });
  if (!probe?.result || !probe.documentId) {
    status.textContent = 'Die Anmeldeseite konnte nicht geprüft werden.';
    return;
  }
  const target = { tabId: tab.id, documentId: probe.documentId, origin: url.origin };

  const vaultTabs = await findVaultTabs(vault, incognito);
  if (!vaultTabs.length) {
    status.textContent = 'Öffne und entsperre KeeCove zuerst im selben Browserprofil.';
    return;
  }

  let locked = false;
  for (const vaultTab of vaultTabs) {
    const response = await callVault({ tabId: vaultTab.id }, vault, { action: 'list', origin: target.origin })
      .catch(() => null);
    const result = response?.result;
    if (result?.status === 'locked') locked = true;
    if (result?.status !== 'ok' || !response.documentId || !Array.isArray(result.entries)) continue;
    const vaultTarget = { tabId: vaultTab.id, documentIds: [response.documentId] };
    renderAccounts(result.entries, vault, vaultTarget, target);
    return;
  }
  status.textContent = locked
    ? 'Entsperre KeeCove und öffne die Erweiterung erneut.'
    : 'Der Vault antwortet gerade nicht. Prüfe die Adresse und den Status in KeeCove.';
}

load().catch(() => {
  status.textContent = 'Die Seite konnte nicht geprüft werden. Öffne die Erweiterung auf der Anmeldeseite erneut.';
});
