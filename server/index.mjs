import { once } from 'node:events';
import { createVaultServer, readConfig } from './http.mjs';

const config = readConfig();
const app = await createVaultServer(config);
app.server.listen(config.port, config.listenHost);
await once(app.server, 'listening');
console.log(`Keevault is listening via ${config.tls ? 'HTTPS' : 'HTTP'} on ${config.listenHost}:${config.port}.`);

let closing = false;
async function shutdown() {
    if (closing) return;
    closing = true;
    await app.close();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
