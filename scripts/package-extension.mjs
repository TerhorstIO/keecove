import { readdir, readFile, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';

const root = new URL('../extension/', import.meta.url);
const files = Object.create(null);

async function collect(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = new URL(encodeURIComponent(entry.name) + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) await collect(path, prefix + entry.name + '/');
    else if (entry.isFile()) files[prefix + entry.name] = await readFile(path);
  }
}

await collect(root);
if (!files['manifest.json']) throw new Error('Extension manifest is missing.');
await writeFile(new URL('../dist/keecove-browser.zip', import.meta.url), zipSync(files));
