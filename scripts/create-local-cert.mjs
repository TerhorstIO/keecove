import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const directory = resolve(process.env.KEEVAULT_TLS_DIR || join(process.env.LOCALAPPDATA || homedir(), '.keevault', 'tls'));
const certificate = join(directory, 'localhost.crt');
const key = join(directory, 'localhost.key');

mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
try {
  mkdirSync(directory, { mode: 0o700 });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  if (existsSync(certificate) && existsSync(key)) {
    console.log(`Reusing local certificate: ${certificate}`);
    process.exit(0);
  }
  throw new Error(`The TLS directory already exists but does not contain both certificate files: ${directory}`);
}

const gitOpenSsl = join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe');
const openSsl = process.env.OPENSSL_BIN || (process.platform === 'win32' && existsSync(gitOpenSsl) ? gitOpenSsl : 'openssl');
const result = spawnSync(openSsl, [
  'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-noenc', '-sha256', '-days', '365',
  '-subj', '/CN=localhost',
  '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1',
  '-addext', 'basicConstraints=critical,CA:FALSE',
  '-addext', 'keyUsage=critical,digitalSignature',
  '-addext', 'extendedKeyUsage=serverAuth',
  '-out', certificate, '-keyout', key
], { stdio: ['ignore', 'inherit', 'inherit'] });

if (result.status !== 0) {
  rmSync(certificate, { force: true });
  rmSync(key, { force: true });
  rmdirSync(directory);
  throw new Error('Could not generate the local certificate. Install OpenSSL 3 or set OPENSSL_BIN.', { cause: result.error });
}
console.log(`Created local certificate: ${certificate}`);
