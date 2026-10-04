// Local server: the web app from public/ plus the game rooms over WebSockets.
//   npm start            -> http://localhost:3110 (PORT to change it)
// The rooms are public/js/room.js, the same referee the Cloudflare Worker runs in a
// Durable Object (worker/index.js). Rooms live in memory and are dropped once nobody
// has been connected to them for a while.
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Room, newRoomCode, isRoomCode } = require('./public/js/room.js');
const { originAllowed, parseHosts, corsHeaders } = require('./src/origin.js');

const IDLE_MS = 10 * 60 * 1000;   // a room with nobody connected for this long is dropped
const REAP_MS = 45 * 1000;        // a socket silent this long is treated as dropped
const MAX_ROOMS = 2000;

function createServer(options) {
  options = options || {};
  const allowed = parseHosts(options.allowedHosts !== undefined ? options.allowedHosts : process.env.ALLOWED_HOSTS);
  const rooms = new Map();
  const app = express();
  app.disable('x-powered-by');

  const selfOrigin = (req) => 'http://' + req.headers.host;
  const allowedReq = (req) => originAllowed(req.headers.origin, selfOrigin(req), allowed);

  app.use('/api', (req, res, next) => {
    if (!allowedReq(req)) { res.status(403).json({ error: 'forbidden' }); return; }
    res.set(corsHeaders(req.headers.origin));
    if (req.method === 'OPTIONS') {
      res.set({ 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' });
      res.status(204).end();
      return;
    }
    next();
  });

  // A new room. The creator then joins it over the socket like everyone else.
  app.post('/api/rooms', express.json({ limit: '4kb' }), (req, res) => {
    if (rooms.size >= MAX_ROOMS) { res.status(503).json({ error: 'busy' }); return; }
    let code;
    do { code = newRoomCode(); } while (rooms.has(code));
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const room = new Room({ ...(body.opts || {}), code }, { onClose: () => rooms.delete(code) });
    rooms.set(code, room);
    res.status(201).json({ code });
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'not-found' }));

  app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  const refuse = (socket, status, text) => {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  // /ws?room=CODE: the origin and the code are checked before the upgrade
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') { refuse(socket, 404, 'Not Found'); return; }
    if (!allowedReq(req)) { refuse(socket, 403, 'Forbidden'); return; }
    const code = (url.searchParams.get('room') || '').toUpperCase();
    if (!isRoomCode(code)) { refuse(socket, 400, 'Bad Request'); return; }
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, code));
  });

  function attach(ws, code) {
    const room = rooms.get(code);
    if (!room || room.closed) {
      ws.send(JSON.stringify({ t: 'error', error: 'not-found' }));
      ws.close(4004, 'Room not found');
      return;
    }
    const conn = room.connect(
      (text) => { if (ws.readyState === ws.OPEN) ws.send(text); },
      (closeCode, reason) => { try { ws.close(closeCode, reason); } catch (e) { ws.terminate(); } }
    );
    ws.on('message', (data, isBinary) => { if (!isBinary) room.message(conn, data.toString()); });
    ws.on('close', () => room.disconnect(conn));
    ws.on('error', () => { /* the close event follows */ });
  }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      room.reap(REAP_MS);
      if (room.conns.size === 0 && now - room.lastActive > IDLE_MS) { room.destroy(); rooms.delete(code); }
    }
  }, 15000);
  sweep.unref();
  server.on('close', () => { clearInterval(sweep); rooms.forEach((r) => r.destroy()); rooms.clear(); });

  return { server, rooms, app };
}

if (require.main === module) {
  const port = +process.env.PORT || 3110;
  createServer().server.listen(port, () => console.log(`Chkobba on http://localhost:${port}`));
}

module.exports = { createServer };
