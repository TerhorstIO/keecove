import './styles.css';
import './import.css';
import { activeEntries, activeGroups, createVault, fieldText, findEntry, KdbxUuid, loadVault, makeCredentials, ProtectedValue, webUrl } from './kdbx.js';
import { deleteFingerprint, EditConflict, entryValues, standardFields } from './mutations.js';
import { BrowserVaultSession, clearImportSession, readImportSession, readImportSessionMetadata, SessionExpiredError } from './browser-vault.js';
import { mountCloudPicker } from './cloud-picker.js';
import { checkImportBytes } from './import-bytes.js';
import { MAX_IMPORT_FILE_BYTES } from './import-session.js';
import { canPickLocalFile, LocalFilePermissionError, pickLocalFile, readLocalFile, requestLocalFilePermission } from './local-file.js';
import { icon } from './icons.js';
import { renderVaultTree } from './vault-tree.js';

const app = document.querySelector('#app');
const toast = document.querySelector('#toast');
const idleLimit = 5 * 60 * 1000;
const labels = { Title: 'Titel', UserName: 'Benutzername', Password: 'Passwort', URL: 'Website', Notes: 'Notizen' };
const state = {
  session: null, available: null, pendingImport: null, mode: 'file', busy: false, lockError: '', syncError: '',
  selection: null, group: '', query: '', draft: null, reveal: false, mobileDetail: false,
  lastActivity: 0, externalChange: false
};

let polling;
let toastTimer;
let unmountCloudPicker;
let pageEpoch = 0;
const brand = '<img src="/keevault.svg" alt="" width="40" height="40"><span>Keevault</span>';
const iconButton = (action, glyph, label, extra = '') =>
  `<button type="button" class="icon-btn ${extra}" data-action="${action}" aria-label="${label}" title="${label}">${icon(glyph)}</button>`;

function text(tag, content, className) {
  const element = document.createElement(tag);
  element.textContent = content;
  if (className) element.className = className;
  return element;
}

function notify(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; toast.textContent = ''; }, 3200);
}

function currentDb() {
  return state.session?.snapshot?.db;
}

function entryTitle(entry) {
  return fieldText(entry, 'Title') || 'Ohne Titel';
}

function setSyncStatus() {
  const status = app.querySelector('#sync-status');
  const error = app.querySelector('#sync-error');
  if (!status || !error) return;
  status.textContent = state.busy ? 'Speichert …' : state.syncError ? 'Dateizugriff prüfen'
    : state.session?.isDirect ? 'Lokale Datei' : 'Sitzungskopie';
  status.parentElement.classList.toggle('sync-warning', Boolean(state.syncError));
  error.textContent = state.syncError;
  error.hidden = !state.syncError;
  const notice = app.querySelector('#draft-notice');
  if (notice) notice.hidden = !state.externalChange;
}

function renderLocked() {
  unmountCloudPicker?.();
  unmountCloudPicker = null;
  const create = state.mode === 'create';
  const resumed = state.mode === 'session' && state.available;
  const hasSource = resumed || state.pendingImport;
  const modes = [
    ['file', 'Datei', 'file'], ['cloud', 'Cloud', 'folder'], ['create', 'Neu', 'plus']
  ];
  if (state.available) modes.unshift(['session', 'Sitzung', 'lock']);
  app.innerHTML = `
    <main class="lock-screen">
      <header class="lock-header">
        <div class="brand">${brand}</div>
        <a class="subtle-link" href="/keevault-browser.zip" download>${icon('puzzle', 17)} Browser-Erweiterung</a>
      </header>
      <div class="lock-content">
        <div class="lock-card">
          <div class="lock-emblem">${icon(hasSource ? 'lock' : 'shield', 25)}</div>
          <p class="eyebrow">DEIN KEEPASS-TRESOR</p>
          <h1>${hasSource ? 'Tresor entsperren' : create ? 'Tresor erstellen' : 'Tresor öffnen'}</h1>
          <p class="lock-description">${hasSource ? 'Gib das Master-Passwort und bei Bedarf deine Schlüsseldatei ein.' : create
            ? 'Keevault verschlüsselt den neuen Tresor im Browser und lädt ihn als KDBX herunter.'
            : 'Öffne eine KeePass-Datei von deinem Gerät oder aus deiner Cloud.'}</p>
          <div class="error-message" id="lock-error" role="alert" hidden></div>
          <div class="segmented source-tabs" aria-label="Tresorquelle">
            ${modes.map(([mode, label, glyph]) => `<button type="button" data-action="mode-${mode}" aria-pressed="${state.mode === mode}">${icon(glyph, 15)}${label}</button>`).join('')}
          </div>
          ${state.available && state.mode !== 'session' ? '<p class="input-hint previous-session">Eine neue Datei ersetzt die bisherige Sitzung. Exportiere sie bei Bedarf vorher.</p>' : ''}
          ${hasSource || create ? `
            ${hasSource ? `<div class="source-ready">${icon('file', 17)}<span id="source-label"></span>
              ${iconButton(resumed ? 'forget-session' : 'discard-source', 'x', resumed ? 'Sitzung beenden' : 'Andere Datei wählen')}</div>` : ''}
            <form id="unlock-form" autocomplete="off">
              ${create ? '<label for="vault-name">Tresorname</label><input id="vault-name" name="name" maxlength="120" value="Mein Tresor" required>' : ''}
              <label for="master-password">Master-Passwort</label>
              <div class="password-input">
                <input id="master-password" name="password" type="password" autocomplete="off" spellcheck="false" placeholder="Master-Passwort eingeben" ${create ? 'minlength="12" required' : ''}>
                ${iconButton('toggle-input', 'eye', 'Passwort anzeigen')}
              </div>
              ${create
                ? '<p class="input-hint">Mindestens 12 Zeichen</p><label for="master-repeat">Master-Passwort bestätigen</label><input id="master-repeat" name="repeat" type="password" autocomplete="off" required>'
                : '<details class="key-file"><summary>Schlüsseldatei verwenden <span>Optional</span></summary><label for="key-file">Schlüsseldatei</label><input id="key-file" name="keyfile" type="file"></details>'}
              <button class="btn primary unlock-button" type="submit">${icon(create ? 'download' : 'lock')} ${create ? 'Erstellen und herunterladen' : 'Entsperren'} ${icon('arrow', 17)}</button>
            </form>` : state.mode === 'cloud' ? '<div id="cloud-picker" class="cloud-picker" aria-label="Cloud-Dateien"></div>' : `
            ${canPickLocalFile() ? `<button type="button" class="btn primary source-direct" data-action="pick-direct">${icon('folder')} Lokale Datei direkt öffnen</button>
              <p class="input-hint source-hint">Änderungen werden in der ausgewählten Datei gespeichert.</p>` : ''}
            <form id="source-form" autocomplete="off">
              <label for="vault-file">Datei als Sitzungskopie öffnen</label>
              <input id="vault-file" name="database" type="file" accept=".kdbx" required>
              <button type="submit" class="btn secondary">${icon('upload')} Datei übernehmen</button>
            </form>`}
          <div class="privacy-note">${icon('shield', 17)} Entschlüsselung direkt in deinem Browser</div>
        </div>
      </div>
      <footer class="lock-footer"><span>Powered by TerhorstIO</span><span class="footer-dot"></span><span>KDBX 3 &amp; 4</span></footer>
    </main>`;
  showLockError(state.lockError);
  const sourceLabel = app.querySelector('#source-label');
  if (sourceLabel) {
    sourceLabel.textContent = resumed ? 'Datei aus dieser Browsersitzung' : state.pendingImport.name;
  }
  const picker = app.querySelector('#cloud-picker');
  if (picker) {
    unmountCloudPicker = mountCloudPicker(picker, (source) => {
      state.pendingImport = source;
      state.lockError = '';
      renderLocked();
      app.querySelector('#master-password')?.focus();
    });
  }
}

function showLockError(message) {
  state.lockError = message;
  const output = app.querySelector('#lock-error');
  if (!output) return;
  output.textContent = message;
  output.hidden = !message;
}

async function checkCachedSession({ initial = false } = {}) {
  if (state.session || state.busy) return;
  try {
    const available = await readImportSessionMetadata();
    if (state.session || state.busy) return;
    if (state.available?.id === available?.id) return;
    state.available = available;
    if (initial && state.mode === 'file' && available && !app.querySelector('#vault-file')?.files.length) state.mode = 'session';
    if (!available && state.mode === 'session') {
      state.mode = 'file';
      state.lockError = new SessionExpiredError().message;
    }
    renderLocked();
  } catch (error) {
    if (!state.session && !state.busy) showLockError(error.message);
  }
}

async function chooseSource(action) {
  if (state.busy) return;
  const epoch = pageEpoch;
  state.busy = true;
  showLockError('');
  const form = app.querySelector('#source-form');
  if (form) form.inert = true;
  try {
    const source = await action();
    if (epoch !== pageEpoch) return;
    state.pendingImport = source;
    renderLocked();
    app.querySelector('#master-password')?.focus();
  } catch (error) {
    if (epoch === pageEpoch && error.name !== 'AbortError') showLockError(error.message);
  } finally {
    if (form) form.inert = false;
    if (epoch === pageEpoch) state.busy = false;
  }
}

async function endCachedSession() {
  if (state.busy) return;
  if (!window.confirm('Dateiauswahl und Änderungen in der Sitzungskopie verwerfen?')) return;
  state.busy = true;
  try {
    await clearImportSession(state.available?.id);
    state.available = null;
    state.mode = 'file';
    state.lockError = '';
    renderLocked();
  } catch (error) {
    showLockError(error.message);
  } finally {
    state.busy = false;
  }
}

async function unlock(form) {
  if (state.busy) return;
  const epoch = pageEpoch;
  if (!window.isSecureContext || !globalThis.crypto?.subtle) {
    showLockError('Zum Entsperren brauchst du HTTPS oder eine lokale Adresse wie http://localhost.');
    return;
  }
  const input = form.elements.password;
  let password = input.value;
  const creating = state.mode === 'create';
  if (creating && password !== form.elements.repeat.value) {
    showLockError('Die beiden Master-Passwörter stimmen nicht überein.');
    return;
  }
  const keyFile = form.elements.keyfile?.files[0];
  const name = form.elements.name?.value.trim();
  if (creating && !name) {
    showLockError('Gib einen Namen für den Tresor ein.');
    return;
  }

  state.busy = true;
  showLockError('');
  const submit = form.querySelector('[type="submit"]');
  const submitLabel = submit.innerHTML;
  submit.disabled = true;
  submit.textContent = 'Tresor wird geöffnet …';
  input.value = '';
  if (form.elements.repeat) form.elements.repeat.value = '';
  try {
    if (keyFile?.size > 16 * 1024 * 1024) throw new Error('Die Schlüsseldatei ist größer als 16 MiB.');
    const resuming = state.mode === 'session';
    const fileHandle = (resuming ? state.available : state.pendingImport)?.fileHandle;
    if (fileHandle && !await requestLocalFilePermission(fileHandle, { write: true })) {
      throw new LocalFilePermissionError('readwrite');
    }
    const cached = resuming ? await readImportSession() : null;
    if (resuming && cached?.id !== state.available?.id) throw new SessionExpiredError();
    const credentials = await makeCredentials(password, await keyFile?.arrayBuffer());
    password = '';
    if (epoch !== pageEpoch) return;
    let session;
    if (creating) {
      const db = createVault(credentials, name);
      const bytes = await db.save();
      if (epoch !== pageEpoch) return;
      download(bytes, `${name}.kdbx`);
      session = await BrowserVaultSession.start({ bytes, db, credentials });
    } else if (cached) {
      session = await BrowserVaultSession.reopen(cached, credentials);
    } else {
      const disk = fileHandle ? await readLocalFile(fileHandle) : null;
      const bytes = checkImportBytes(disk?.bytes ?? state.pendingImport.bytes);
      const db = await loadVault(bytes, credentials);
      if (epoch !== pageEpoch) return;
      session = await BrowserVaultSession.start({ bytes, db, credentials, fileHandle, diskRevision: disk?.revision });
    }
    if (epoch !== pageEpoch) {
      session.close();
      return;
    }
    state.session = session;
    const { id, expiresAt, fileHandle: sessionFile } = session.snapshot;
    state.available = { id, expiresAt, fileHandle: sessionFile };
    state.pendingImport = null;
    state.lastActivity = Date.now();
    state.selection = activeEntries(session.snapshot.db).next().value?.uuid.id ?? null;
    state.busy = false;
    renderVault();
  } catch (error) {
    if (epoch !== pageEpoch) return;
    if (error instanceof SessionExpiredError) {
      state.available = null;
      state.mode = 'file';
      state.lockError = error.message;
      renderLocked();
    } else {
      showLockError(error.message);
      submit.innerHTML = submitLabel;
      submit.disabled = false;
    }
  } finally {
    if (epoch === pageEpoch) state.busy = false;
  }
}

function lock(message = '') {
  state.session?.close();
  Object.assign(state, {
    session: null, busy: false, selection: null, group: '', query: '', draft: null,
    reveal: false, mobileDetail: false, syncError: '', lockError: message, externalChange: false,
    mode: state.available ? 'session' : 'file'
  });
  toast.hidden = true;
  toast.textContent = '';
  renderLocked();
}

function expireSession() {
  const id = state.available?.id;
  state.available = null;
  lock(new SessionExpiredError().message);
  if (id) void clearImportSession(id).catch(() => {});
}

function glyphFor(entry) {
  const title = entryTitle(entry);
  const first = Array.from(title.trim())[0]?.toLocaleUpperCase('de') || '·';
  const tone = title.codePointAt(0) % 5;
  return text('span', first, `entry-avatar tone-${tone}`);
}

function filteredEntries() {
  const query = state.query.trim().toLocaleLowerCase('de');
  return [...activeEntries(currentDb())].filter((entry) => {
    if (state.group && entry.parentGroup.uuid.id !== state.group) return false;
    if (!query) return true;
    return ['Title', 'UserName', 'URL'].some((key) => fieldText(entry, key).toLocaleLowerCase('de').includes(query));
  }).sort((a, b) => entryTitle(a).localeCompare(entryTitle(b), 'de'));
}

function renderList() {
  const list = app.querySelector('#entry-list');
  const entries = filteredEntries();
  app.querySelector('#entry-count').textContent = `${entries.length} ${entries.length === 1 ? 'Eintrag' : 'Einträge'}`;
  list.replaceChildren();
  if (!entries.length) {
    const empty = text('div', '', 'list-empty');
    empty.innerHTML = icon(state.query ? 'search' : 'key', 25);
    empty.append(text('p', state.query ? 'Keine passenden Einträge' : state.group ? 'Diese Gruppe enthält keine Einträge' : 'Noch keine Einträge'));
    list.append(empty);
    return;
  }
  for (const entry of entries) {
    const button = text('button', '', 'entry-row');
    button.type = 'button';
    button.dataset.action = 'select';
    button.dataset.id = entry.uuid.id;
    button.setAttribute('aria-pressed', String(state.selection === entry.uuid.id && !state.draft));
    const description = text('span', '', 'entry-row-copy');
    description.append(text('strong', entryTitle(entry)));
    if (!state.group && entry.parentGroup?.name) description.append(text('small', entry.parentGroup.name));
    const title = text('span', '', 'entry-row-title');
    title.append(glyphFor(entry), description);
    const username = text('span', fieldText(entry, 'UserName') || '—', 'entry-cell entry-user');
    const website = text('span', webUrl(fieldText(entry, 'URL'))?.host || '—', 'entry-cell entry-website');
    button.append(title, username, website);
    list.append(button);
  }
}

function renderGroups(db) {
  const path = renderVaultTree(app.querySelector('#group-list'), db, state.group, state.session);
  app.querySelector('#entry-heading').textContent = path.at(-1) ?? 'Alle Einträge';
  const location = app.querySelector('#group-path');
  location.textContent = path.slice(0, -1).join(' / ');
  location.hidden = path.length < 2;
}

function renderVault() {
  const db = currentDb();
  if (!db) return;
  const focused = document.activeElement;
  app.innerHTML = `
    <main class="workspace ${state.mobileDetail ? 'show-detail' : ''}">
      <aside class="sidebar" aria-label="Tresornavigation">
        <div class="brand">${brand}</div>
        <div class="vault-badge">${icon('shield', 19)}<div><small>AKTIVER TRESOR</small><strong id="vault-label"></strong></div></div>
        <nav class="group-navigation" aria-label="Tresorgruppen">
          <button type="button" class="nav-link all-entries-link" data-action="filter" aria-pressed="${!state.group}">${icon('grid', 17)} <span>Alle Einträge</span></button>
          <div class="nav-caption"><span>ORDNER</span>${iconButton('new-group', 'plus', 'Gruppe erstellen')}</div>
          <div id="group-list" class="group-list"></div>
        </nav>
        <div class="sidebar-footer">
          <a class="nav-link" href="/keevault-browser.zip" aria-label="Browser-Erweiterung herunterladen" download>${icon('puzzle', 17)}<span>Browser-Erweiterung</span></a>
          <button type="button" class="nav-link" data-action="download" aria-label="KDBX exportieren">${icon('download', 17)}<span>KDBX exportieren</span></button>
          <button type="button" class="nav-link" data-action="lock" aria-label="Tresor sperren">${icon('lock', 17)}<span>Tresor sperren</span></button>
        </div>
      </aside>
      <section class="workspace-body" aria-label="Tresorinhalt">
        <header class="workspace-header">
          <div><p class="eyebrow">KEEPASS-DATENBANK</p><h1>Tresor</h1></div>
          <div class="workspace-actions">
            <button type="button" class="sync-pill" data-action="refresh" aria-label="Dateiversion jetzt prüfen"><span class="status-dot"></span><span id="sync-status"></span>${icon('refresh', 14)}</button>
            <button type="button" class="btn primary" data-action="new">${icon('plus', 18)} <span>Neuer Eintrag</span></button>
          </div>
        </header>
        <p id="sync-error" class="sync-error" role="status" hidden></p>
        ${state.session.isDirect ? '' : '<p class="workspace-source-note">Änderungen bleiben in dieser Sitzung. Mit „KDBX exportieren“ lädst du die aktuelle Datei herunter.</p>'}
        <div class="workspace-columns">
          <section class="entry-panel" aria-label="Einträge">
            <div class="entry-panel-header">
              <div class="list-heading"><div class="entry-heading-wrap"><p id="group-path" class="group-path" hidden></p><h2 id="entry-heading">Alle Einträge</h2></div><span class="count-badge" id="entry-count"></span></div>
              <label class="search-box" for="search">${icon('search', 17)}<input id="search" type="search" placeholder="Einträge suchen …" aria-label="Einträge suchen" autocomplete="off" spellcheck="false"></label>
            </div>
            <div class="entry-columns" aria-hidden="true"><span>Titel</span><span>Benutzername</span><span class="entry-website">Website</span></div>
            <div id="entry-list" class="entry-list"></div>
          </section>
          <section class="detail-panel" id="detail-panel" aria-label="Eintragsdetails"></section>
        </div>
      </section>
    </main>`;
  app.querySelector('#vault-label').textContent = db.meta.name || db.getDefaultGroup().name || 'KeePass';
  app.querySelector('#search').value = state.query;
  renderGroups(db);
  renderList();
  renderDetail();
  setSyncStatus();
  if (focused?.id === 'search') {
    const search = app.querySelector('#search');
    search.focus({ preventScroll: true });
    search.setSelectionRange(focused.selectionStart, focused.selectionEnd);
  } else if (['filter', 'select'].includes(focused?.dataset?.action)) {
    const match = Array.from(app.querySelectorAll('[data-action]')).find((button) =>
      button.dataset.action === focused.dataset.action && button.dataset.id === focused.dataset.id);
    match?.focus({ preventScroll: true });
  }
}

function fieldRow(container, label, value, options = {}) {
  const row = text('div', '', 'field-row');
  const body = text('div', '', 'field-body');
  body.append(text('span', label, 'field-label'));
  const safeUrl = options.link && webUrl(value);
  if (safeUrl) {
    const link = text('a', value, 'field-value field-link');
    link.href = safeUrl.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    body.append(link);
  } else {
    body.append(text('span', value || '—', `field-value${options.mono ? ' mono' : ''}`));
  }
  row.append(body);
  if (options.buttons) {
    const buttons = text('div', '', 'field-actions');
    buttons.innerHTML = options.buttons;
    row.append(buttons);
  }
  container.append(row);
}

function renderDetail() {
  const panel = app.querySelector('#detail-panel');
  if (!panel) return;
  if (state.draft) {
    renderEditor(panel);
    return;
  }
  const entry = findEntry(currentDb(), state.selection);
  if (!entry) {
    panel.innerHTML = `<div class="detail-empty">
      <div class="empty-icon">${icon('key', 29)}</div>
      <h2>Deine Zugangsdaten</h2><p>Wähle einen Eintrag aus oder lege einen neuen an.</p>
      <button class="btn secondary" data-action="new">${icon('plus', 17)} Neuer Eintrag</button>
    </div>`;
    return;
  }
  panel.innerHTML = `<div class="detail-inner">
    <button type="button" class="btn quiet mobile-back" data-action="back">${icon('back', 17)} Alle Einträge</button>
    <header class="detail-header"><div class="detail-identity" id="detail-identity"></div><div class="detail-toolbar">
      <button type="button" class="btn secondary" data-action="edit">${icon('edit', 16)} Bearbeiten</button>
      ${iconButton('delete', 'trash', 'Eintrag löschen', 'delete-button')}
    </div></header>
    <h3 class="section-label">ZUGANGSDATEN</h3><div id="credentials" class="field-card"></div>
    <div id="extra-fields"></div><div id="attachments"></div>
    <p id="entry-date" class="detail-footer"></p>
  </div>`;
  const name = text('div', '');
  name.append(text('h2', entryTitle(entry)), text('p', entry.parentGroup?.name || 'Stammordner'));
  panel.querySelector('#detail-identity').append(glyphFor(entry), name);
  const fields = panel.querySelector('#credentials');
  const username = fieldText(entry, 'UserName');
  const passwordField = entry.fields.get('Password');
  fieldRow(fields, 'Benutzername', username, { buttons: username ? iconButton('copy-user', 'copy', 'Benutzername kopieren') : '' });
  fieldRow(fields, 'Passwort', state.reveal ? fieldText(entry, 'Password') : passwordField ? '••••••••••••' : '', {
    mono: true, buttons: passwordField ? iconButton('reveal', state.reveal ? 'eyeOff' : 'eye', state.reveal ? 'Passwort verbergen' : 'Passwort anzeigen') + iconButton('copy-password', 'copy', 'Passwort kopieren') : ''
  });
  fieldRow(fields, 'Website', fieldText(entry, 'URL'), { link: true });
  const notes = fieldText(entry, 'Notes');
  if (notes) fieldRow(fields, 'Notizen', notes);

  const customFields = [...entry.fields].filter(([key]) => !standardFields.includes(key));
  if (customFields.length) {
    const extra = panel.querySelector('#extra-fields');
    const list = text('div', '', 'field-card');
    for (const [key, value] of customFields) {
      if (value instanceof ProtectedValue) {
        fieldRow(list, key, '••••••••••••', { buttons: iconButton('copy-extra', 'copy', 'Geschütztes Feld kopieren') });
        list.lastElementChild.querySelector('button').dataset.id = key;
      } else {
        fieldRow(list, key, value);
      }
    }
    extra.append(text('h3', 'WEITERE FELDER', 'section-label'), list);
  }

  if (entry.binaries.size) {
    const attachments = panel.querySelector('#attachments');
    const list = text('div', '', 'field-card');
    for (const key of entry.binaries.keys()) {
      fieldRow(list, 'Datei', key, { buttons: iconButton('attachment', 'download', 'Anhang herunterladen') });
      list.lastElementChild.querySelector('button').dataset.id = key;
    }
    attachments.append(text('h3', 'ANHÄNGE', 'section-label'), list);
  }
  if (entry.times.lastModTime) {
    const modified = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(entry.times.lastModTime);
    panel.querySelector('#entry-date').textContent = `Zuletzt geändert am ${modified}`;
  }
}

function renderEditor(panel) {
  const draft = state.draft;
  if (draft.type === 'group') {
    panel.innerHTML = `<div class="detail-inner edit-inner"><h2>Neue Gruppe</h2>
      <form id="edit-form" autocomplete="off">
        <label for="group-name">Gruppenname</label><input id="group-name" name="name" maxlength="120" required>
        <label for="edit-group">Übergeordnete Gruppe</label><select id="edit-group" name="group"></select>
        <p id="edit-error" class="error-message" role="alert" hidden></p>
        <div class="editor-actions"><button class="btn secondary" type="button" data-action="cancel">Abbrechen</button><button class="btn primary" type="submit">Gruppe erstellen</button></div>
      </form></div>`;
    panel.querySelector('#group-name').value = draft.name;
  } else {
    panel.innerHTML = `<div class="detail-inner edit-inner"><h2>${draft.type === 'edit' ? 'Eintrag bearbeiten' : 'Neuer Eintrag'}</h2>
      <form id="edit-form" autocomplete="off">
        <p id="draft-notice" class="draft-notice" hidden>Die Dateiversion wurde geändert. Dein Entwurf bleibt erhalten.</p>
        <label for="edit-Title">Titel</label><input id="edit-Title" name="Title" placeholder="z. B. E-Mail" maxlength="300" required spellcheck="false">
        <label for="edit-UserName">Benutzername</label><input id="edit-UserName" name="UserName" spellcheck="false">
        <label for="edit-Password">Passwort</label><div class="password-input">
          <input id="edit-Password" name="Password" type="password" autocomplete="new-password" spellcheck="false">
          ${iconButton('toggle-input', 'eye', 'Passwort anzeigen')}${iconButton('generate', 'spark', 'Passwort generieren')}
        </div>
        <label for="edit-URL">Website</label><input id="edit-URL" name="URL" placeholder="https://…" spellcheck="false">
        <label for="edit-group">Gruppe</label><select id="edit-group" name="group"></select>
        <label for="edit-Notes">Notizen</label><textarea id="edit-Notes" name="Notes" rows="3" spellcheck="false"></textarea>
        <p id="edit-error" class="error-message" role="alert" hidden></p>
        <button type="button" class="btn secondary conflict-action" data-action="save-copy" hidden>Als neuen Eintrag speichern</button>
        <div class="editor-actions"><button class="btn secondary" type="button" data-action="cancel">Abbrechen</button><button class="btn primary" type="submit">Speichern</button></div>
      </form></div>`;
    for (const key of standardFields) panel.querySelector(`#edit-${key}`).value = draft.values[key];
  }
  const select = panel.querySelector('#edit-group');
  for (const group of activeGroups(currentDb())) {
    const option = text('option', group.name || 'Ohne Namen');
    option.value = group.uuid.id;
    select.append(option);
  }
  if (![...select.options].some((option) => option.value === draft.group)) {
    const option = text('option', 'Gruppe wurde entfernt');
    option.value = draft.group;
    select.append(option);
  }
  select.value = draft.group;
  setSyncStatus();
}

function openEditor(type) {
  const db = currentDb();
  if (state.draft && !window.confirm('Aktuellen Entwurf verwerfen?')) return;
  const group = state.group || db.getDefaultGroup().uuid.id;
  if (type === 'group') {
    state.draft = { type, id: KdbxUuid.random().id, name: '', group };
  } else if (type === 'create') {
    const values = Object.fromEntries(standardFields.map((key) => [key, '']));
    state.draft = { type, id: KdbxUuid.random().id, values, group };
  } else {
    const entry = findEntry(db, state.selection);
    if (!entry) return;
    const before = entryValues(entry);
    const beforeGroup = entry.parentGroup.uuid.id;
    state.draft = { type, id: entry.uuid.id, before, values: { ...before }, beforeGroup, group: beforeGroup };
  }
  state.reveal = false;
  state.externalChange = false;
  state.mobileDetail = true;
  renderVault();
  app.querySelector('#edit-Title, #group-name')?.focus();
}

function discardDraft() {
  if (state.draft && !window.confirm('Entwurf verwerfen?')) return false;
  state.draft = null;
  state.externalChange = false;
  return true;
}

async function saveOperation(operation) {
  if (state.busy) return;
  const session = state.session;
  state.busy = true;
  setSyncStatus();
  const form = app.querySelector('#edit-form');
  if (form) form.inert = true;
  try {
    const result = await session.save(operation);
    if (state.session !== session) return;
    state.busy = false;
    state.syncError = '';
    state.draft = null;
    state.externalChange = false;
    state.reveal = false;
    if (operation.type === 'group') state.group = result.id;
    else state.selection = result.id ?? null;
    if (state.selection && state.group && findEntry(currentDb(), state.selection)?.parentGroup.uuid.id !== state.group) state.group = '';
    renderVault();
    notify(operation.type === 'delete' ? 'Eintrag entfernt' : session.isDirect ? 'Lokale Datei gespeichert' : 'Sitzungskopie gespeichert');
  } catch (error) {
    if (state.session !== session) return;
    if (error instanceof SessionExpiredError) {
      expireSession();
      return;
    }
    const output = app.querySelector('#edit-error');
    if (output) {
      output.textContent = error.message;
      output.hidden = false;
      const copy = app.querySelector('[data-action="save-copy"]');
      if (copy) copy.hidden = !(error instanceof EditConflict && state.draft.type === 'edit');
      state.externalChange = error instanceof EditConflict || state.externalChange;
    } else {
      notify(error.message);
      renderVault();
    }
  } finally {
    if (state.session === session) {
      state.busy = false;
      if (form) form.inert = false;
      setSyncStatus();
      void refresh();
    }
  }
}

async function removeEntry() {
  if (state.busy) return;
  const session = state.session;
  const entry = findEntry(currentDb(), state.selection);
  if (!entry || !window.confirm(`„${entryTitle(entry)}“ wirklich entfernen?`)) return;
  const fingerprint = await deleteFingerprint(entry);
  if (session === state.session) await saveOperation({ type: 'delete', id: entry.uuid.id, fingerprint });
}

async function refresh({ manual = false } = {}) {
  if (!state.session) {
    if (manual) await checkCachedSession();
    return false;
  }
  if (Date.now() >= state.session.snapshot.expiresAt) {
    expireSession();
    return false;
  }
  if (Date.now() - state.lastActivity >= idleLimit) {
    lock();
    return false;
  }
  if (state.busy) return false;
  if (polling?.session === state.session) return polling.promise;
  const session = state.session;
  const promise = (async () => {
    try {
      const changed = await session.refresh();
      if (state.session !== session) return false;
      state.syncError = '';
      if (changed) {
        state.reveal = false;
        if (state.draft) {
          state.externalChange = true;
          renderList();
        } else {
          const db = currentDb();
          if (state.group && ![...activeGroups(db)].some((group) => group.uuid.id === state.group)) state.group = '';
          if (state.selection && !findEntry(db, state.selection)) state.selection = null;
          renderVault();
        }
        if (manual) notify('Änderungen übernommen');
      } else if (manual) {
        notify('Datei ist aktuell');
      }
      setSyncStatus();
      return true;
    } catch (error) {
      if (state.session === session) {
        if (error instanceof SessionExpiredError) expireSession();
        else {
          state.syncError = error.message;
          setSyncStatus();
        }
      }
      return false;
    }
  })();
  polling = { session, promise };
  try {
    return await promise;
  } finally {
    if (polling?.promise === promise) polling = null;
  }
}

function download(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function copy(value, label) {
  try {
    await navigator.clipboard.writeText(value);
    notify(`${label} kopiert`);
  } catch {
    notify('Die Zwischenablage ist gerade nicht verfügbar.');
  }
}

function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%&*-_';
  let password = '';
  while (password.length < 24) {
    for (const byte of crypto.getRandomValues(new Uint8Array(24))) {
      if (byte < 256 - 256 % alphabet.length) password += alphabet[byte % alphabet.length];
      if (password.length === 24) break;
    }
  }
  return password;
}

app.addEventListener('input', ({ target }) => {
  if (target.id === 'search') {
    state.query = target.value;
    renderList();
  }
  if (target.form?.id !== 'edit-form' || !state.draft) return;
  if (target.name === 'group' || target.name === 'name') state.draft[target.name] = target.value;
  else if (standardFields.includes(target.name)) state.draft.values[target.name] = target.value;
});

app.addEventListener('submit', (event) => {
  event.preventDefault();
  if (event.target.id === 'source-form') {
    const file = event.target.elements.database.files[0];
    if (!file) return;
    void chooseSource(async () => {
      if (file.size > MAX_IMPORT_FILE_BYTES) throw new Error('Die KDBX-Datei darf höchstens 128 MiB groß sein.');
      return { bytes: checkImportBytes(await file.arrayBuffer()), name: file.name };
    });
  }
  if (event.target.id === 'unlock-form') void unlock(event.target);
  if (event.target.id === 'edit-form' && state.draft) {
    const operation = state.draft;
    if (operation.type === 'group') operation.name = operation.name.trim();
    else operation.values.Title = operation.values.Title.trim();
    if (operation.type === 'group' ? !operation.name : !operation.values.Title) {
      const output = app.querySelector('#edit-error');
      output.textContent = operation.type === 'group' ? 'Gib einen Gruppennamen ein.' : 'Gib einen Titel ein.';
      output.hidden = false;
      return;
    }
    void saveOperation(operation);
  }
});

app.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, id } = button.dataset;
  if (state.busy && action !== 'lock') return;
  if (action.startsWith('mode-')) {
    const mode = action.slice(5);
    if (mode === state.mode) return;
    state.mode = mode;
    state.pendingImport = null;
    state.lockError = '';
    renderLocked();
  }
  if (action === 'pick-direct') {
    void chooseSource(async () => {
      const fileHandle = await pickLocalFile();
      return { fileHandle, name: fileHandle.name };
    });
  }
  if (action === 'forget-session') void endCachedSession();
  if (action === 'discard-source') {
    state.pendingImport = null;
    state.lockError = '';
    renderLocked();
  }
  if (action === 'toggle-input') {
    const input = button.parentElement.querySelector('input');
    input.type = input.type === 'password' ? 'text' : 'password';
    const visible = input.type === 'text';
    button.innerHTML = icon(visible ? 'eyeOff' : 'eye');
    button.title = visible ? 'Passwort verbergen' : 'Passwort anzeigen';
    button.setAttribute('aria-label', button.title);
  }
  if (!state.session) return;

  if (action === 'lock') lock();
  if (action === 'refresh') void refresh({ manual: true });
  if (action === 'new') openEditor('create');
  if (action === 'edit') openEditor('edit');
  if (action === 'new-group') openEditor('group');
  if (action === 'delete') void removeEntry();
  if (action === 'back' || action === 'cancel') {
    if (!discardDraft()) return;
    state.mobileDetail = action !== 'back' && Boolean(state.selection);
    renderVault();
  }
  if (action === 'select' || action === 'filter') {
    if (!discardDraft()) return;
    state.reveal = false;
    state.mobileDetail = action === 'select';
    if (action === 'filter') {
      state.group = id ?? '';
      state.selection = null;
    } else {
      state.selection = id;
    }
    renderVault();
  }
  if (action === 'generate' && state.draft) {
    const password = generatePassword();
    state.draft.values.Password = password;
    app.querySelector('#edit-Password').value = password;
    notify('Passwort generiert');
  }
  if (action === 'save-copy' && state.draft?.type === 'edit') {
    if (!state.draft.values.Title.trim()) return;
    const operation = {
      type: 'create', id: state.draft.copyId ??= KdbxUuid.random().id,
      values: { ...state.draft.values }, group: state.draft.group
    };
    void saveOperation(operation);
  }
  if (action === 'download') {
    const { bytes, db } = state.session.snapshot;
    download(bytes, `${db.meta.name || 'Tresor'}.kdbx`);
  }
  const db = currentDb();
  const entry = db && findEntry(db, state.selection);
  if (!entry) return;
  if (action === 'reveal') {
    state.reveal = !state.reveal;
    renderDetail();
    app.querySelector('[data-action="reveal"]')?.focus();
  }
  if (action === 'copy-user') void copy(fieldText(entry, 'UserName'), 'Benutzername');
  if (action === 'copy-password') void copy(fieldText(entry, 'Password'), 'Passwort');
  if (action === 'copy-extra') void copy(fieldText(entry, id), 'Feldinhalt');
  if (action === 'attachment') {
    const binary = entry.binaries.get(id);
    if (binary instanceof ProtectedValue) {
      const bytes = binary.getBinary();
      download(bytes, id);
      bytes.fill(0);
    } else if (binary) {
      download(binary.value ?? binary, id);
    }
  }
});

Object.defineProperty(window, 'keevaultBrowser', { value: Object.freeze({
  async request({ action, origin, id } = {}) {
    if (!state.session || Date.now() - state.lastActivity >= idleLimit) return { status: 'locked' };
    if (!['list', 'fill'].includes(action) || webUrl(origin)?.origin !== origin) return { status: 'not-found' };
    const session = state.session;
    if (!await refresh() || state.session !== session) return { status: 'unavailable' };
    const matches = [...activeEntries(currentDb())].filter((entry) =>
      webUrl(fieldText(entry, 'URL'))?.origin === origin &&
      !(entry.times.expires && entry.times.expiryTime?.getTime() <= Date.now()));
    if (action === 'list') {
      return { status: 'ok', entries: matches.map((entry) => ({
        id: entry.uuid.id, title: entryTitle(entry), username: fieldText(entry, 'UserName')
      })) };
    }
    const match = matches.find((entry) => entry.uuid.id === id);
    if (!match) return { status: 'not-found' };
    state.lastActivity = Date.now();
    return { status: 'ok', entry: { username: fieldText(match, 'UserName'), password: fieldText(match, 'Password') } };
  }
}) });

for (const event of ['pointerdown', 'keydown', 'input']) {
  document.addEventListener(event, () => {
    if (!state.session) return;
    if (Date.now() >= state.session.snapshot.expiresAt) expireSession();
    else if (Date.now() - state.lastActivity >= idleLimit) lock();
    else state.lastActivity = Date.now();
  }, { capture: true, passive: true });
}
window.addEventListener('focus', () => { void refresh({ manual: !state.session }); });
window.addEventListener('pagehide', () => {
  pageEpoch++;
  unmountCloudPicker?.();
  if (state.session) lock();
  else {
    state.pendingImport = null;
    state.busy = false;
    app.replaceChildren();
  }
});
window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  renderLocked();
  void checkCachedSession({ initial: true });
});
setInterval(() => {
  if (state.session) void refresh();
  else void checkCachedSession();
}, 4000);

renderLocked();
void checkCachedSession({ initial: true });
