import { hostPattern, vaultAddress } from './config.js';

const form = document.querySelector('#settings-form');
const input = document.querySelector('#vault-url');
const save = form.querySelector('button');
const status = document.querySelector('#status');

try {
  const stored = await chrome.storage.local.get('vaultUrl');
  input.value = stored.vaultUrl ?? '';
  save.disabled = false;
} catch {
  status.textContent = 'Die Einstellungen konnten nicht gelesen werden.';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (save.disabled) return;
  const vault = vaultAddress(input.value.trim());
  if (!vault) {
    status.textContent = 'Gib eine Keevault-Startadresse ohne Pfad, Parameter oder Anmeldedaten ein.';
    return;
  }

  const pattern = hostPattern(vault);
  save.disabled = true;
  input.disabled = true;
  try {
    const granted = await chrome.permissions.request({ origins: [pattern] });
    if (!granted) {
      status.textContent = 'Der Zugriff wurde nicht erteilt.';
      return;
    }

    const stored = await chrome.storage.local.get('vaultUrl');
    const previous = vaultAddress(stored.vaultUrl);
    await chrome.storage.local.set({ vaultUrl: vault.href });
    if (previous && hostPattern(previous) !== pattern) {
      await chrome.permissions.remove({ origins: [hostPattern(previous)] });
    }
    input.value = vault.href;
    status.textContent = 'Adresse gespeichert. Du kannst Keevault jetzt über das Browser-Symbol öffnen.';
  } catch {
    status.textContent = 'Die Einrichtung konnte nicht abgeschlossen werden.';
  } finally {
    input.disabled = false;
    save.disabled = false;
  }
});
