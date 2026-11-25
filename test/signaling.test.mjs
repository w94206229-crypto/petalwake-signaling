import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createSignalingServer } from '../signaling.mjs';

// Production uses npm ws. TEST_WS_BUNDLE is solely an offline test adapter for
// an installed Playwright bundle of the same ws library; not a runtime fallback.
const require = createRequire(import.meta.url);
const { WebSocketServer, WebSocket } = process.env.TEST_WS_BUNDLE
  ? (() => { const m = require(process.env.TEST_WS_BUNDLE); return { WebSocketServer: m.wsServer, WebSocket: m.ws }; })()
  : await import('ws');
const delay = ms => new Promise(r => setTimeout(r, ms));
const SDP = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=sctp-port:5000\r\n';
const ICE = { candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 12345 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'test' };

async function fixture(t, options = {}) {
  const app = createSignalingServer(WebSocketServer, { html: Buffer.from('<h1>test</h1>'), ...options });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const wsURL = base.replace('http:', 'ws:') + '/signal';
  const sockets = [];
  t.after(async () => { for (const ws of sockets) ws.terminate(); await app.close(); });
  async function client(code, opts = {}) {
    const ws = new WebSocket(wsURL, { origin: base, ...opts }); sockets.push(ws);
    const inbox = []; const c = { ws, inbox, send: m => ws.send(JSON.stringify(m)) };
    ws.on('message', d => inbox.push(JSON.parse(d.toString())));
    ws.on('error', () => {});
    await once(ws, 'open');
    c.wait = async (pred, from = 0) => {
      for (let i = 0; i < 200; i++) {
        const m = inbox.slice(from).find(pred);
        if (m) return m;
        await delay(5);
      }
      assert.fail(`Message not received: ${inbox.map(m => m.type).join(',')}`);
    };
    c.roster = () => inbox.filter(m => m.type === 'roster').at(-1)?.list;
    if (code !== undefined) c.send({ type: 'join', code });
    return c;
  }
  async function joined(code) {
    const c = await client(code); const w = await c.wait(m => m.type === 'welcome');
    Object.assign(c, { id: w.id, code: w.code, slot: w.slot, age: w.age });
    await c.wait(m => m.type === 'roster'); return c;
  }
  async function link(a, b, oneSided = false) {
    const n = a.inbox.length, k = b.inbox.length;
    // b is later in roster. Candidate can precede offer (trickle ICE).
    b.send({ type: 'signal', to: a.id, candidate: ICE });
    b.send({ type: 'signal', to: a.id, description: { type: 'offer', sdp: SDP } });
    const cand = await a.wait(m => m.type === 'signal' && m.from === b.id && m.candidate, n);
    assert.deepEqual(cand.candidate, ICE);
    const offer = await a.wait(m => m.type === 'signal' && m.from === b.id && m.description?.type === 'offer', n);
    assert.equal(offer.description.sdp, SDP);
    a.send({ type: 'signal', to: b.id, description: { type: 'answer', sdp: SDP } });
    await b.wait(m => m.type === 'signal' && m.from === a.id && m.description?.type === 'answer', k);
    b.send({ type: 'link', to: a.id }); if (!oneSided) a.send({ type: 'link', to: b.id });
  }
  const active = (c, n) => c.wait(m => m.type === 'roster' && m.list.filter(p => p.active).length === n && m.list.length === n);
  return { base, wsURL, client, joined, link, active };
}

test('HTTP game, health, and upgrade routes', async t => {
  const f = await fixture(t);
  assert.match(await (await fetch(f.base)).text(), /<h1>test/);
  assert.equal((await fetch(f.base + '/healthz')).status, 200);
  assert.deepEqual(await (await fetch(f.base + '/healthz')).json(), { ok: true, service: 'petalwake-signaling' });
  assert.equal((await fetch(f.base + '/signal')).status, 426);
  assert.equal((await fetch(f.base + '/package.json')).status, 404);
});

test('4 peers, 6 bilateral edges, stable roster, 5th denied, no host dependency', async t => {
  const f = await fixture(t);
  const a = await f.joined(''); assert.match(a.code, /^[A-F0-9]{6}$/); await f.active(a, 1);
  const b = await f.joined(a.code); assert.equal(b.slot, 1); assert.equal(b.roster()[1].active, false);
  // One-sided report cannot admit.
  b.send({ type: 'link', to: a.id });
  await delay(20); assert.equal(b.roster()[1].active, false);
  await f.link(a, b, true); await delay(20); assert.equal(b.roster()[1].active, false);
  a.send({ type: 'link', to: b.id }); await f.active(b, 2);
  const c = await f.joined(a.code); await f.link(a, c); await delay(20);
  assert.equal(c.roster().find(p => p.id === c.id).active, false);
  await f.link(b, c); await f.active(c, 3);
  const d = await f.joined(a.code); await f.link(a, d); await f.link(b, d); await f.link(c, d);
  const list = (await f.active(d, 4)).list;
  assert.deepEqual(list.map(p => p.id), [a.id, b.id, c.id, d.id]); assert.deepEqual(list.map(p => p.slot), [0, 1, 2, 3]);
  for (const p of [a, b, c]) await f.active(p, 4);
  const fifth = await f.client(a.code); assert.equal((await fifth.wait(m => m.type === 'error')).reason, 'Room is full');
  a.send({ type: 'clock', echo: 123.456 });
  const clock = await a.wait(m => m.type === 'clock'); assert.equal(clock.echo, 123.456); assert.ok(clock.age >= d.age);
  a.ws.close(); await b.wait(m => m.type === 'roster' && m.list.length === 3 && !m.list.some(p => p.id === a.id));
  const e = await f.joined(a.code); assert.equal(e.slot, 0); assert.ok(e.age > d.age);
  await f.link(b, e); await f.link(c, e); await f.link(d, e);
  assert.deepEqual((await f.active(e, 4)).list.map(p => p.id), [b.id, c.id, d.id, e.id]);
});

test('concurrent pending members activate only as a full mesh', async t => {
  const f = await fixture(t); const a = await f.joined('');
  const b = await f.joined(a.code), c = await f.joined(a.code);
  await f.link(a, b); await f.link(a, c); await delay(20);
  assert.equal(c.roster().filter(p => p.active).length, 2);
  await f.link(b, c); await f.active(c, 3);
});

test('room isolation, forged sender, relay ICE, unknown game packets and binary are blocked', async t => {
  const f = await fixture(t); const a = await f.joined(''), b = await f.joined(a.code), other = await f.joined('');
  const n = a.inbox.length, o = other.inbox.length;
  b.send({ type: 'signal', to: other.id, candidate: ICE });
  b.send({ type: 'signal', to: a.id, from: other.id, candidate: ICE });
  b.send({ type: 'signal', to: a.id, candidate: { ...ICE, candidate: ICE.candidate.replace('typ host', 'typ relay') } });
  b.send({ type: 'signal', to: a.id, description: { type: 'offer', sdp: SDP + 'a=candidate:1 1 udp 1 192.0.2.2 9 typ relay\r\n' } });
  b.send({ type: 'signal', to: a.id, description: { type: 'offer', sdp: 'game message' } });
  b.send({ type: 'signal', to: a.id, candidate: ICE, magic: 'payload' });
  await delay(50); assert.equal(a.inbox.length, n); assert.equal(other.inbox.length, o);
  await f.link(a, b); await f.active(b, 2);
  b.send({ type: 'magic-field', entry: { ops: [] } }); await b.wait(m => m.type === 'error');
  await a.wait(m => m.type === 'roster' && m.list.length === 1);
  assert.equal(a.inbox.some(m => m.type === 'magic-field'), false);
  other.ws.send(Buffer.from([1, 2, 3])); await other.wait(m => m.type === 'error');
});

test('failed pending join leaves active players untouched; active failure removes reporter', async t => {
  const f = await fixture(t); const a = await f.joined(''), b = await f.joined(a.code);
  a.send({ type: 'failed', to: b.id }); await b.wait(m => m.type === 'error');
  await a.wait(m => m.type === 'roster' && m.list.length === 1);
  const c = await f.joined(a.code); await f.link(a, c); await f.active(c, 2);
  c.send({ type: 'failed', to: a.id }); await c.wait(m => m.type === 'error');
  const n = await a.wait(m => m.type === 'roster' && m.list.length === 1 && m.list[0].id === a.id);
  assert.equal(n.list[0].active, true);
});

test('invalid room, nonexistent room, timeouts, empty room deletion', async t => {
  const f = await fixture(t, { joinMs: 120, meshMs: 200 });
  const invalid = await f.client('xyz'); assert.equal((await invalid.wait(m => m.type === 'error')).reason, 'Invalid room code');
  const missing = await f.client('ABCDEF'); assert.equal((await missing.wait(m => m.type === 'error')).reason, 'Room not found');
  const idle = await f.client(); assert.equal((await idle.wait(m => m.type === 'error')).reason, 'Signaling service timed out');
  const a = await f.joined(''), b = await f.joined(a.code);
  assert.equal((await b.wait(m => m.type === 'error')).reason, 'Signaling service timed out');
  a.ws.close(); await once(a.ws, 'close'); await delay(20);
  const gone = await f.client(a.code); assert.equal((await gone.wait(m => m.type === 'error')).reason, 'Room not found');
});

test('cross-origin upgrade rejected; heartbeat removes unresponsive socket', async t => {
  const f = await fixture(t, { heartbeatMs: 40 });
  const ws = new WebSocket(f.wsURL, { origin: 'https://wrong.invalid' });
  ws.on('error', () => {}); const [req, res] = await once(ws, 'unexpected-response'); assert.equal(res.statusCode, 403); req.destroy();
  // autoPong is supported by ws 8.x; disable it to exercise ping timeout.
  const a = await f.joined(''); const b = await f.client(a.code, { autoPong: false });
  await b.wait(m => m.type === 'welcome'); await once(b.ws, 'close');
  await a.wait(m => m.type === 'roster' && m.list.length === 1);
});
