// Cloudflare Worker: serves public/ and runs each game room in a Durable Object.
//   POST /api/rooms     -> { code }   a new room, in its own Durable Object
//   GET  /ws?room=CODE  -> WebSocket to that room
// Everything else is a static file from public/ (the ASSETS binding).
// The referee is public/js/room.js: the same file the local server (server.js) and
// the offline bot game use.
import RoomLib from '../public/js/room.js';
import OriginLib from '../src/origin.js';

const { Room: GameRoom, newRoomCode, isRoomCode } = RoomLib;
const { originAllowed, corsHeaders } = OriginLib;

const REAP_MS = 45 * 1000;               // a socket silent this long is treated as dropped
const IDLE_MS = 6 * 60 * 60 * 1000;      // a room nobody used for this long is deleted

const json = (body, status, headers) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...(headers || {}) },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith('/api/');
    if (!isApi && url.pathname !== '/ws') return env.ASSETS.fetch(request);

    const origin = request.headers.get('Origin');
    if (!originAllowed(origin, url.origin, env.ALLOWED_HOSTS)) {
      return new Response('Forbidden', { status: 403, headers: { Vary: 'Origin' } });
    }

    if (url.pathname === '/ws') {
      const code = (url.searchParams.get('room') || '').toUpperCase();
      if (!isRoomCode(code)) return new Response('Bad room code', { status: 400 });
      if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
    }

    const cors = corsHeaders(origin);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } });
    }
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      let opts = {};
      try {
        const text = await request.text();
        if (text.length > 4096) return json({ error: 'too-big' }, 413, cors);
        const body = text ? JSON.parse(text) : {};
        opts = (body && typeof body.opts === 'object' && body.opts) || {};
      } catch (e) {
        return json({ error: 'bad-json' }, 400, cors);
      }
      // a fresh code; on the (very rare) clash with a live room, draw again
      for (let i = 0; i < 5; i++) {
        const code = newRoomCode();
        const res = await env.ROOMS.get(env.ROOMS.idFromName(code)).fetch('https://room/init', { method: 'POST', body: JSON.stringify({ code, opts }) });
        if (res.status === 201) return json({ code }, 201, cors);
      }
      return json({ error: 'busy' }, 503, cors);
    }
    return json({ error: 'not-found' }, 404, cors);
  },
};

// One room per Durable Object, named by its code. Sockets use ws.accept() (no
// hibernation) so the room's timers (bot turns, the turn timer, the 60 s seat hold)
// keep running. The room is also saved to the object's storage, so a deploy or an
// eviction while everyone's phone sleeps does not lose the game.
export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.room = null;
    this.saveTimer = 0;
    this.reapTimer = 0;
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get('room');
      if (saved) this.room = GameRoom.restore(saved, this.roomEnv());
    });
  }

  roomEnv() {
    return {
      onChange: () => this.scheduleSave(),
      onClose: () => this.drop(),
      log: (level, ...args) => console.log('[room]', level, ...args),
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/init') {
      if (this.room) return new Response('exists', { status: 409 });
      const { code, opts } = await request.json();
      this.room = new GameRoom({ ...opts, code }, this.roomEnv());
      await this.save();
      await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
      return new Response('created', { status: 201 });
    }

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.accept();
    const room = this.room;
    if (!room || room.closed) {
      server.send(JSON.stringify({ t: 'error', error: 'not-found' }));
      server.close(4004, 'Room not found');
      return new Response(null, { status: 101, webSocket: client });
    }
    const conn = room.connect(
      (text) => { try { server.send(text); } catch (e) { /* closing */ } },
      (code, reason) => { try { server.close(code, reason); } catch (e) { /* closed */ } }
    );
    server.addEventListener('message', (e) => { if (typeof e.data === 'string') room.message(conn, e.data); });
    const gone = () => room.disconnect(conn);
    server.addEventListener('close', gone);
    server.addEventListener('error', gone);
    this.startReaper();
    return new Response(null, { status: 101, webSocket: client });
  }

  startReaper() {
    if (this.reapTimer) return;
    this.reapTimer = setInterval(() => {
      if (this.room) this.room.reap(REAP_MS);
      if (!this.room || this.room.conns.size === 0) { clearInterval(this.reapTimer); this.reapTimer = 0; }
    }, 15000);
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = 0; this.save().catch((e) => console.log('[room] save failed', e)); }, 500);
  }

  async save() {
    if (this.room && !this.room.closed) await this.ctx.storage.put('room', this.room.serialize());
  }

  // everyone left: the room and its storage go
  async drop() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = 0; }
    this.room = null;
    await this.ctx.storage.deleteAll();
  }

  async alarm() {
    const r = this.room;
    if (r && (r.conns.size > 0 || Date.now() - r.lastActive < IDLE_MS)) {
      await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
      return;
    }
    if (r) r.destroy();
    await this.drop();
  }
}
