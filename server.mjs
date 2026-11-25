import { WebSocketServer } from 'ws';
import { createSignalingServer } from './signaling.mjs';

const app = createSignalingServer(WebSocketServer);
const port = Number(process.env.PORT || 17280);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
app.server.listen(port, '0.0.0.0', () => console.log(`Petalwake signaling listening on 0.0.0.0:${port}`));
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    console.log(`Stopping signaling (${signal})`);
    const force = setTimeout(() => process.exit(1), 5000).unref();
    app.close().then(() => { clearTimeout(force); process.exit(0); });
  });
}
