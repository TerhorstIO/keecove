import { argon2d, argon2id } from 'hash-wasm';
import { argon2d as legacyD, argon2id as legacyId } from '@noble/hashes/argon2.js';

export async function deriveArgon2({ password, salt, memory, iterations, length, parallelism, type, version }) {
  try {
    if (version === 0x10) {
      const derive = type === 0 ? legacyD : legacyId;
      return derive(new Uint8Array(password), new Uint8Array(salt), {
        m: memory, t: iterations, dkLen: length, p: parallelism, version
      }).buffer;
    }
    const derive = type === 0 ? argon2d : argon2id;
    return (await derive({
      password: new Uint8Array(password),
      salt: new Uint8Array(salt),
      memorySize: memory,
      iterations,
      hashLength: length,
      parallelism,
      outputType: 'binary'
    })).buffer;
  } finally {
    new Uint8Array(password).fill(0);
  }
}
