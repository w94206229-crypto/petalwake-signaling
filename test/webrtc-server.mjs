// Minimal HTTP test page, using the same signaling server as production.
import { createRequire } from 'node:module';
import { createSignalingServer } from '../signaling.mjs';
const WSS = process.env.TEST_WS_BUNDLE
  ? createRequire(import.meta.url)(process.env.TEST_WS_BUNDLE).wsServer
  : (await import('ws')).WebSocketServer;
const app = createSignalingServer(WSS, { html: Buffer.from('<!doctype html><meta charset=utf-8><title>Mesh smoke test</title>') });
app.server.listen(0, '127.0.0.1', () => console.log(app.server.address().port));
process.once('SIGTERM', async () => { await app.close(); process.exit(0); });
