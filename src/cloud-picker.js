import { authenticate } from './cloud-auth.js';
import { connectDropbox } from './dropbox.js';
import { connectGoogleDrive } from './google-drive.js';
import { downloadImportUrl } from './import-download.js';
import { connectOneDrive } from './onedrive.js';
import { icon } from './icons.js';

const providers = [
  ['onedrive', 'OneDrive', connectOneDrive],
  ['google', 'Google Drive', connectGoogleDrive],
  ['dropbox', 'Dropbox', connectDropbox]
];

export function mountCloudPicker(root, onSelect) {
  const lifetime = new AbortController();
  let operation;
  let config;
  let drive;
  let selected;
  let folders = [];
  let items = [];
  let nextPage;
  let status = 'Cloud-Anbieter werden geladen …';
  let error = '';

  function button(label, run, { glyph, disabled, className = 'btn secondary' } = {}) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = className;
    element.disabled = Boolean(disabled);
    if (glyph) element.innerHTML = icon(glyph, 16);
    element.append(document.createTextNode(label));
    element.addEventListener('click', run);
    return element;
  }

  function paragraph(message, className) {
    const p = document.createElement('p');
    p.className = className;
    p.textContent = message;
    root.append(p);
  }

  function draw() {
    root.replaceChildren();
    if (!drive && config) {
      const available = providers.filter(([id]) => config[id]?.clientId);
      if (available.length) {
        const choices = document.createElement('div');
        choices.className = 'cloud-choices';
        for (const [id, label, connect] of available) {
          choices.append(button(label, () => void connectProvider(id, label, connect), {
            glyph: 'folder', disabled: operation
          }));
        }
        root.append(choices);
      } else {
        paragraph('Keine Cloud-Anbieter verfügbar.', 'input-hint');
      }
    }
    if (drive) {
      const toolbar = document.createElement('div');
      toolbar.className = 'cloud-toolbar';
      const location = document.createElement('span');
      location.textContent = [selected, ...folders.map((folder) => folder.name)].join(' / ');
      toolbar.append(location, button('Verbindung trennen', reset, { className: 'btn quiet' }));
      root.append(toolbar);
      if (folders.length) {
        root.append(button('Übergeordneter Ordner', () => void loadFolder(folders.slice(0, -1)), {
          glyph: 'back', disabled: operation, className: 'btn quiet'
        }));
      }
      const list = document.createElement('ul');
      list.className = 'cloud-list';
      for (const item of items) {
        const row = document.createElement('li');
        row.append(button(item.name, () => item.kind === 'folder' ? void loadFolder([...folders, item]) : void selectFile(item), {
          glyph: item.kind === 'folder' ? 'folder' : 'file', disabled: operation, className: 'cloud-row'
        }));
        list.append(row);
      }
      root.append(list);
      if (!items.length && !operation) paragraph('Keine Tresordateien oder Unterordner.', 'input-hint');
      if (nextPage) root.append(button('Weitere Dateien anzeigen', () => void loadFolder(folders, nextPage), { disabled: operation }));
    }
    if (status) paragraph(status, 'input-hint cloud-status');
    if (error) {
      paragraph(error, 'error-message');
      root.lastElementChild.setAttribute('role', 'alert');
    }
    if (operation) root.append(button('Abbrechen', reset, { className: 'btn quiet' }));
  }

  function reset() {
    operation?.abort();
    operation = null;
    drive = null;
    selected = null;
    folders = [];
    items = [];
    nextPage = null;
    status = '';
    error = '';
    draw();
  }

  async function run(message, action) {
    if (operation) return;
    const controller = new AbortController();
    operation = controller;
    status = message;
    error = '';
    draw();
    try {
      await action(controller.signal);
    } catch (failure) {
      if (!controller.signal.aborted) error = failure.message;
    } finally {
      if (operation === controller) {
        operation = null;
        status = '';
        draw();
      }
    }
  }

  function connectProvider(id, label, connect) {
    return run('Setze die Anmeldung im neuen Fenster fort. Erlaube Pop-ups, falls es sich nicht geöffnet hat.', async (signal) => {
      const connection = await connect({
        ...config[id],
        authenticate: (options) => authenticate(options, signal),
        downloadUrl: downloadImportUrl
      });
      signal.throwIfAborted();
      const page = await connection.list(undefined, undefined, signal);
      signal.throwIfAborted();
      drive = connection;
      selected = label;
      showPage([], page, false);
    });
  }

  function showPage(path, page, append) {
    folders = path;
    items = [...(append ? items : []), ...page.items].sort((a, b) =>
      (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1) || a.name.localeCompare(b.name, 'de'));
    nextPage = page.nextPage;
  }

  function loadFolder(path, page) {
    return run('Dateiliste wird geladen …', async (signal) => {
      const result = await drive.list(path.at(-1), page, signal);
      signal.throwIfAborted();
      showPage(path, result, Boolean(page));
    });
  }

  function selectFile(file) {
    return run('Verschlüsselte Datei wird geladen …', async (signal) => {
      const bytes = await drive.download(file, signal);
      signal.throwIfAborted();
      onSelect({ bytes, name: file.name });
    });
  }

  draw();
  fetch('/cloud-config.json', { cache: 'no-store', signal: lifetime.signal }).then(async (response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    config = await response.json();
    status = '';
    draw();
  }).catch(() => {
    if (lifetime.signal.aborted) return;
    status = '';
    error = 'Cloud-Anbieter konnten nicht geladen werden.';
    draw();
  });
  return () => {
    lifetime.abort();
    operation?.abort();
    operation = null;
    drive = null;
  };
}
