import { deriveArgon2 } from './argon2.js';

self.onmessage = async ({ data }) => {
  try {
    const key = await deriveArgon2(data);
    self.postMessage({ key }, [key]);
  } catch {
    self.postMessage({ failed: true });
  }
};
