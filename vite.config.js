import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vite';

const noticeFile = 'third-party-licenses.json';
const require = createRequire(import.meta.url);

export default defineConfig({
  build: {
    license: { fileName: noticeFile },
    rolldownOptions: {
      output: {
        postBanner: `/* Bundled dependency licenses: /${noticeFile} */`
      }
    }
  },
  plugins: [{
    name: 'kdbxweb-bundled-license',
    apply: 'build',
    generateBundle: {
      order: 'post',
      async handler(_options, bundle) {
        const notice = bundle[noticeFile];
        if (!notice) this.error('Vite did not generate the third-party license file.');

        // The kdbxweb 2.1.1 UMD release bundles fflate 0.7.1 before Vite sees it.
        const kdbxRequire = createRequire(require.resolve('kdbxweb/package.json'));
        const fflateDirectory = dirname(dirname(kdbxRequire.resolve('fflate')));
        const licenses = JSON.parse(notice.source);
        licenses.push({
          name: 'fflate',
          version: '0.7.1',
          identifier: 'MIT',
          text: (await readFile(resolve(fflateDirectory, 'LICENSE'), 'utf8')).trim()
        });
        notice.source = JSON.stringify(licenses, null, 2) + '\n';
      }
    }
  }]
});
