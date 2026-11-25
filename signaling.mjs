import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const MAX_MEMBERS = 4;
const MAX_PAYLOAD = 128 * 1024;
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const keysOnly = (v, allowed) => Object.keys(v).every(k => allowed.includes(k));
const relay = /\btyp\s+relay\b/i;
const iceLine = /^(?:a=)?candidate:/i;
const validId = v => typeof v === 'string' && v.length <= 128;

function description(v) {
  if (!isObject(v) || !keysOnly(v, ['type', 'sdp']) || !['offer', 'answer'].includes(v.type) ||
      typeof v.sdp !== 'string' || v.sdp.length > 65536 || relay.test(v.sdp)) return null;
  // DataChannel-only negotiation. Reject audio/video or arbitrary non-SDP payloads.
  const lines = v.sdp.split(/\r?\n/);
  const media = lines.filter(l => l.startsWith('m='));
  if (lines[0] !== 'v=0' || media.length !== 1 || !/^m=application\s+\d+\s+(?:UDP|TCP)\/DTLS\/SCTP\s+webrtc-datachannel\s*$/i.test(media[0])) return null;
  return { type: v.type, sdp: v.sdp };
}
function candidate(v) {
  if (!isObject(v) || !keysOnly(v, ['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment']) ||
      typeof v.candidate !== 'string' || v.candidate.length > 2048 || !iceLine.test(v.candidate) || relay.test(v.candidate) ||
      /[\r\n]/.test(v.candidate) || !/\btyp\s+(?:host|srflx|prflx)\b/i.test(v.candidate)) return null;
  if (v.sdpMid != null && (typeof v.sdpMid !== 'string' || v.sdpMid.length > 128)) return null;
  if (v.sdpMLineIndex != null && (!Number.isInteger(v.sdpMLineIndex) || v.sdpMLineIndex !== 0)) return null;
  if (v.usernameFragment != null && (typeof v.usernameFragment !== 'string' || v.usernameFragment.length > 256)) return null;
  return { candidate: v.candidate, sdpMid: v.sdpMid ?? null, sdpMLineIndex: v.sdpMLineIndex ?? null, ...(v.usernameFragment != null ? { usernameFragment: v.usernameFragment } : {}) };
}

export function createSignalingServer(WebSocketServer, options = {}) {
  const html = options.html ?? readFileSync(new URL('./public/index.html', import.meta.url));
  const limits = {
    maxRooms: options.maxRooms ?? 256,
    maxConnections: options.maxConnections ?? 1024,
    joinMs: options.joinMs ?? 10000,
    meshMs: options.meshMs ?? 55000,
    heartbeatMs: options.heartbeatMs ?? 25000,
  };
  const origins = new Set((options.allowedOrigins ?? process.env.ALLOWED_ORIGINS ?? '').split(',').map(x => x.trim()).filter(Boolean));
  const rooms = new Map();
  const clients = new Set();
  let closing = false;
  const server = createServer((req, res) => {
    const path = req.url?.split('?')[0];
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return;
    }
    if (path === '/healthz') {
      const body = JSON.stringify({ ok: !closing, service: 'petalwake-signaling' });
      res.writeHead(closing ? 503 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body); return;
    }
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : html); return;
    }
    res.writeHead(path === '/signal' ? 426 : 404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(path === '/signal' ? 'WebSocket upgrade required' : 'Not found');
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });

  function rejectUpgrade(socket, code, message) {
    socket.end(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  function originOK(req) {
    const origin = req.headers.origin;
    // Non-browser tools can omit Origin; room codes are capability-like, not authentication.
    if (!origin) return true;
    if (origins.has(origin)) return true;
    try {
      const u = new URL(origin);
      return ['http:', 'https:'].includes(u.protocol) && u.host === req.headers.host;
    } catch { return false; }
  }
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    if (req.url?.split('?')[0] !== '/signal') return rejectUpgrade(socket, 404, 'Not Found');
    if (closing || clients.size >= limits.maxConnections) return rejectUpgrade(socket, 503, 'Service Unavailable');
    if (!originOK(req)) return rejectUpgrade(socket, 403, 'Forbidden');
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  const age = room => Math.max(0, performance.now() - room.created);
  function send(c, m) {
    if (c.ws.readyState !== 1) return false;
    if (c.ws.bufferedAmount > 256 * 1024) { c.ws.terminate(); return false; }
    c.ws.send(JSON.stringify(m), err => { if (err) c.ws.terminate(); });
    return true;
  }
  function roster(room) {
    const list = [...room.members.values()].map(({ id, slot, active }) => ({ id, slot, active }));
    for (const c of room.members.values()) send(c, { type: 'roster', list });
  }
  // Activate a new member only when both sides of every edge to the current
  // active set have reported that BOTH DataChannels are open. Existing members
  // never wait for pending members. Admission is not gameplay authority.
  function admit(room) {
    const active = [...room.members.values()].filter(c => c.active);
    for (const c of room.members.values()) {
      if (c.active) continue;
      if (!active.every(p => c.links.has(p.id) && p.links.has(c.id))) continue;
      c.active = true;
      clearTimeout(c.timer); c.timer = null;
      active.push(c);
    }
  }
  function remove(c) {
    clearTimeout(c.timer); c.timer = null;
    const room = c.room;
    c.room = null;
    if (!room || !room.members.delete(c.id)) return;
    for (const p of room.members.values()) {
      p.links.delete(c.id); p.negotiations.delete(c.id);
    }
    c.links.clear(); c.negotiations.clear();
    if (!room.members.size) { rooms.delete(room.code); return; }
    admit(room); roster(room);
  }
  function fail(c, reason, code = 1008) {
    if (c.ending) return;
    c.ending = true;
    send(c, { type: 'error', reason });
    remove(c);
    c.ws.close(code, 'Signaling ended');
  }
  function join(c, rawCode) {
    if (c.room || typeof rawCode !== 'string') return fail(c, 'Invalid room code');
    const code = rawCode.trim().toUpperCase();
    let room;
    if (code === '') {
      if (rooms.size >= limits.maxRooms) return fail(c, 'Signaling service unavailable');
      let fresh;
      do { fresh = randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(fresh));
      room = { code: fresh, created: performance.now(), members: new Map() };
      rooms.set(fresh, room);
    } else {
      if (!/^[A-F0-9]{6}$/.test(code)) return fail(c, 'Invalid room code');
      room = rooms.get(code);
      if (!room) return fail(c, 'Room not found');
      if (room.members.size >= MAX_MEMBERS) return fail(c, 'Room is full');
    }
    clearTimeout(c.timer);
    c.room = room;
    c.slot = [0, 1, 2, 3].find(s => ![...room.members.values()].some(p => p.slot === s));
    room.members.set(c.id, c);
    // Timer is shorter than V4 client's 60s deadline.
    c.timer = setTimeout(() => fail(c, 'Signaling service timed out'), limits.meshMs);
    send(c, { type: 'welcome', id: c.id, slot: c.slot, code: room.code, age: age(room) });
    admit(room); roster(room);
  }
  function receive(c, data, isBinary) {
    if (closing || c.ending) return;
    const now = performance.now();
    c.tokens = Math.min(200, c.tokens + (now - c.tokenAt) * .04); c.tokenAt = now;
    if (--c.tokens < 0) return fail(c, 'Multiplayer connection failed. Check the room code or network.');
    if (isBinary || data.length > MAX_PAYLOAD) return fail(c, 'Multiplayer connection failed. Check the room code or network.');
    let m;
    try { m = JSON.parse(data.toString()); } catch { return fail(c, 'Multiplayer connection failed. Check the room code or network.'); }
    if (!isObject(m)) return fail(c, 'Multiplayer connection failed. Check the room code or network.');
    if (m.type === 'join') {
      if (!keysOnly(m, ['type', 'code'])) return fail(c, 'Invalid room code');
      return join(c, m.code);
    }
    const room = c.room;
    if (!room) return fail(c, 'Invalid room code');
    if (m.type === 'clock') {
      if (keysOnly(m, ['type', 'echo']) && Number.isFinite(m.echo)) send(c, { type: 'clock', echo: m.echo, age: age(room) });
      return;
    }
    // Strict application protocol allowlist. There is deliberately no generic
    // broadcast, pose, magic, event, snapshot, tile, or game-data route.
    if (!['signal', 'link', 'failed'].includes(m.type)) return fail(c, 'Multiplayer connection failed. Check the room code or network.');
    if (!validId(m.to) || m.to === c.id) return;
    const p = room.members.get(m.to);
    if (!p) return; // stale or cross-room destination
    if (m.type === 'link') {
      if (!keysOnly(m, ['type', 'to']) || c.negotiations.get(p.id) !== 2) return;
      // Both peers must report after SDP exchange; duplicates are harmless.
      if (c.links.has(p.id)) return;
      c.links.add(p.id);
      const before = [...room.members.values()].filter(q => q.active).length;
      admit(room);
      if ([...room.members.values()].filter(q => q.active).length !== before) roster(room);
      return;
    }
    if (m.type === 'failed') {
      if (!keysOnly(m, ['type', 'to'])) return;
      // Preserve the active clique: reject a pending entrant if the new link
      // fails. If both already active, remove the reporter, not an arbitrary
      // other player. No host is privileged and slots can always be reused.
      let victim = c;
      if (c.active && !p.active) victim = p;
      fail(victim, 'Multiplayer connection failed. Check the room code or network.');
      return;
    }
    if (!keysOnly(m, ['type', 'to', 'description', 'candidate']) || ('description' in m) === ('candidate' in m)) return;
    if ('description' in m) {
      const d = description(m.description);
      if (!d) return;
      // V4 initiates the offer from the later member in roster order.
      const ids = [...room.members.keys()];
      const newer = ids.indexOf(c.id) > ids.indexOf(p.id);
      const phase = c.negotiations.get(p.id) ?? 0;
      if ((d.type === 'offer' && (!newer || phase !== 0)) || (d.type === 'answer' && (newer || phase !== 1))) return;
      const next = d.type === 'offer' ? 1 : 2;
      c.negotiations.set(p.id, next); p.negotiations.set(c.id, next);
      send(p, { type: 'signal', from: c.id, description: d });
    } else {
      const ice = candidate(m.candidate);
      if (ice) send(p, { type: 'signal', from: c.id, candidate: ice });
    }
  }
  wss.on('connection', ws => {
    const c = { ws, id: randomUUID(), room: null, active: false, links: new Set(), negotiations: new Map(), tokens: 200, tokenAt: performance.now(), alive: true, ending: false };
    clients.add(c);
    c.timer = setTimeout(() => fail(c, 'Signaling service timed out'), limits.joinMs);
    ws.on('pong', () => { c.alive = true; });
    ws.on('message', (data, binary) => receive(c, data, binary));
    ws.on('error', () => ws.terminate());
    ws.on('close', () => { remove(c); clients.delete(c); });
  });
  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (c.ws.readyState !== 1) continue;
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false; c.ws.ping();
    }
  }, limits.heartbeatMs).unref();
  return {
    server,
    close: async () => {
      if (closing) return;
      closing = true; clearInterval(heartbeat);
      const done = new Promise(resolve => server.close(resolve));
      for (const c of clients) { c.ending = true; remove(c); c.ws.terminate(); }
      wss.close();
      server.closeIdleConnections?.();
      await done;
    },
  };
}
