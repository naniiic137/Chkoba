// The local server (server.js) over real HTTP and WebSockets. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const R = require('../public/js/rules.js');
const { createServer } = require('../server.js');
const { originAllowed } = require('../src/origin.js');

let srv, base, port;
test.before(async () => {
  srv = createServer({ allowedHosts: 'chkobba.pages.dev' });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  port = srv.server.address().port;
  base = `http://127.0.0.1:${port}`;
});
test.after(() => new Promise((r) => srv.server.close(r)));

async function createRoom(opts, headers) {
  const res = await fetch(base + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: JSON.stringify({ opts: opts || {} }) });
  return { res, body: res.status === 201 ? await res.json() : null };
}

// A socket client: req() resolves with the ack, until() with the first message that matches.
function open(code, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}`, { headers });
    const c = { ws, inbox: [], state: null, nextId: 1, acks: new Map(), waiters: [] };
    c.closed = new Promise((r) => ws.on('close', (closeCode) => r(closeCode)));
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      c.inbox.push(m);
      if (m.t === 'state') c.state = m.s;
      if (m.t === 'ack' && c.acks.has(m.id)) { c.acks.get(m.id)(m); c.acks.delete(m.id); }
      c.waiters = c.waiters.filter((w) => !w(m));
    });
    ws.on('open', () => resolve(c));
    ws.on('unexpected-response', (req, res) => reject(Object.assign(new Error('HTTP ' + res.statusCode), { status: res.statusCode })));
    ws.on('error', reject);
    c.req = (t, data) => new Promise((r) => { const id = c.nextId++; c.acks.set(id, r); ws.send(JSON.stringify({ ...(data || {}), t, id })); });
    c.until = (pred) => new Promise((r, j) => {
      if (c.state && pred({ t: 'state', s: c.state })) { r(c.state); return; }
      const timer = setTimeout(() => j(new Error('timed out waiting')), 4000);
      c.waiters.push((m) => { if (!pred(m)) return false; clearTimeout(timer); r(m.s || m); return true; });
    });
  });
}

test('the origin allowlist', () => {
  const self = 'https://chkobba.example.workers.dev';
  const hosts = 'chkobba.pages.dev';
  for (const ok of [undefined, '', self, 'http://localhost:8795', 'http://127.0.0.1:3110', 'https://chkobba.pages.dev', 'https://abc123.chkobba.pages.dev']) {
    assert.equal(originAllowed(ok, self, hosts), true, String(ok));
  }
  for (const bad of ['https://evil.example', 'http://chkobba.pages.dev', 'https://chkobba.pages.dev.evil.example', 'https://notchkobba.pages.dev', 'null', 'https://pages.dev']) {
    assert.equal(originAllowed(bad, self, hosts), false, bad);
  }
});

test('POST /api/rooms makes a room; a foreign origin gets 403 and an allowed one gets CORS', async () => {
  const { res, body } = await createRoom({ players: 2 });
  assert.equal(res.status, 201);
  assert.match(body.code, /^[A-Z2-9]{8}$/);
  const evil = await createRoom({}, { Origin: 'https://evil.example' });
  assert.equal(evil.res.status, 403);
  const pages = await createRoom({}, { Origin: 'https://chkobba.pages.dev' });
  assert.equal(pages.res.status, 201);
  assert.equal(pages.res.headers.get('access-control-allow-origin'), 'https://chkobba.pages.dev');
  assert.match(pages.res.headers.get('vary'), /Origin/);
  const pre = await fetch(base + '/api/rooms', { method: 'OPTIONS', headers: { Origin: 'https://chkobba.pages.dev', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204);
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Chkobba/);
});

test('an invalid or unknown room code is refused, and so is a foreign origin', async () => {
  await assert.rejects(open('bad'), (e) => e.status === 400);
  await assert.rejects(open('ABCDEFG1'), (e) => e.status === 400);
  const unknown = await open('ABCDEFGH');
  assert.equal(await unknown.closed, 4004);
  assert.equal(unknown.inbox[0].error, 'not-found');
  const { body } = await createRoom();
  await assert.rejects(open(body.code, { Origin: 'https://evil.example' }), (e) => e.status === 403);
  const ok = await open(body.code, { Origin: 'https://x.chkobba.pages.dev' });
  ok.ws.close();
});

test('a full room is refused; a reload with the seat token resumes the same seat and hand', async () => {
  const { body } = await createRoom({ players: 2 });
  const a = await open(body.code), b = await open(body.code), c = await open(body.code);
  const ha = await a.req('hello', { name: 'Ana' });
  assert.equal(ha.seat, 0);
  assert.equal((await b.req('hello', { name: 'Ben' })).seat, 1);
  const full = await c.req('hello', { name: 'Cy' });
  assert.equal(full.ok, false); assert.equal(full.error, 'full');
  c.ws.close();
  assert.equal((await a.req('start')).ok, true);
  const s = await a.until((m) => m.t === 'state' && m.s.game);
  const hand = s.hand.map((x) => x.id);
  // no other hand and no deck order ever reached this socket
  const text = JSON.stringify(a.inbox);
  assert.ok(!text.includes('"deck"') && !text.includes('"hands"'));
  a.ws.terminate();
  await b.until((m) => m.t === 'state' && m.s.seats[0] && !m.s.seats[0].connected);
  const a2 = await open(body.code);
  const back = await a2.req('hello', { token: ha.token });
  assert.equal(back.seat, 0);
  const s2 = await a2.until((m) => m.t === 'state' && m.s.game);
  assert.deepEqual(s2.hand.map((x) => x.id), hand);
  a2.ws.close(); b.ws.close();
});

test('two rooms run independently over the server', async () => {
  const rooms = [];
  for (let k = 0; k < 2; k++) {
    const { body } = await createRoom({ players: 2, speed: 'fast' });
    const c = await open(body.code);
    await c.req('hello', { name: 'P' + k });
    await c.req('addBot', { slot: 1 });
    await c.req('start');
    rooms.push({ code: body.code, c });
  }
  assert.notEqual(rooms[0].code, rooms[1].code);
  // play a few moves in room 0 only
  const c = rooms[0].c;
  for (let i = 0; i < 3; i++) {
    const s = await c.until((m) => m.t === 'state' && m.s.game && m.s.game.currentTurn === m.s.you);
    const g = s.game;
    const mv = R.chooseBotMove(s.hand, g.tableCards, 'medium', g.forceCapture);
    const ack = await c.req('move', { game: g.gameToken, seq: g.moveSeq, cardId: mv.cardId, captureCardIds: mv.captureCardIds });
    assert.equal(ack.ok, true);
    // the same move again is ignored
    assert.equal((await c.req('move', { game: g.gameToken, seq: g.moveSeq, cardId: mv.cardId, captureCardIds: mv.captureCardIds })).error, 'stale');
  }
  const r0 = srv.rooms.get(rooms[0].code), r1 = srv.rooms.get(rooms[1].code);
  assert.ok(r0.gs.moveSeq >= 3);
  assert.ok(r1.gs.moveSeq <= 1, 'room 1 only saw its bot, if anything');
  assert.notEqual(r0.gs, r1.gs);
  rooms.forEach((r) => r.c.ws.close());
});

test('the host disconnecting hands lobby control to the next player', async () => {
  const { body } = await createRoom({ players: 2 });
  const host = await open(body.code), guest = await open(body.code);
  await host.req('hello', { name: 'Host' });
  await guest.req('hello', { name: 'Guest' });
  host.ws.terminate();
  const s = await guest.until((m) => m.t === 'state' && m.s.owner === 1);
  assert.equal(s.owner, 1);
  guest.ws.close();
});

test('heartbeat: a ping is answered with a pong', async () => {
  const { body } = await createRoom();
  const c = await open(body.code);
  c.ws.send(JSON.stringify({ t: 'ping' }));
  await c.until((m) => m.t === 'pong');
  c.ws.close();
});
