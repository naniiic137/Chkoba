// Test helpers: a fake clock for the room's timers and in-memory clients.
const R = require('../public/js/rules.js');
const { Room } = require('../public/js/room.js');

// Timers run only when the test moves time on with tick(ms).
function fakeClock() {
  let t = 1000000, nextId = 1, timers = [];
  return {
    now: () => t,
    setTimeout(fn, ms) { const id = nextId++; timers.push({ id, at: t + ms, fn }); return id; },
    clearTimeout(id) { timers = timers.filter((x) => x.id !== id); },
    tick(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    },
    pending: () => timers.length,
  };
}

function makeRoom(opts, env) {
  const clock = fakeClock();
  const room = new Room({ code: 'TESTROOM', ...opts }, { clock, ...env });
  return { room, clock };
}

// A client wired straight into the room. The room is synchronous, so send() returns
// the ack. onMessage(msg) sees every message the moment the room sends it.
function client(room, onMessage) {
  const c = { inbox: [], acks: {}, nextId: 1, state: null, token: '', closed: 0 };
  c.conn = room.connect((text) => {
    const m = JSON.parse(text);
    c.inbox.push(m);
    if (m.t === 'state') c.state = m.s;
    if (m.t === 'ack') c.acks[m.id] = m;
    if (onMessage) onMessage(m, text);
  }, (code) => { c.closed = code; });
  c.send = (t, data) => {
    const id = c.nextId++;
    room.message(c.conn, JSON.stringify({ ...(data || {}), t, id }));
    return c.acks[id];
  };
  c.hello = (name, token) => { const a = c.send('hello', { name, token }); if (a && a.ok) c.token = a.token; return a; };
  c.drop = () => room.disconnect(c.conn);
  // a legal move for this client's hand, sent with the seq it saw
  c.play = () => {
    const g = c.state.game;
    const mv = R.chooseBotMove(c.state.hand, g.tableCards, 'medium', g.forceCapture);
    return c.send('move', { game: g.gameToken, seq: g.moveSeq, cardId: mv.cardId, captureCardIds: mv.captureCardIds });
  };
  c.myTurn = () => !!c.state && !!c.state.game && c.state.game.phase === 'playing' && c.state.game.currentTurn === c.state.you;
  return c;
}

// Plays every human turn (and lets bots and deals run) until the predicate holds.
function playUntil(clients, clock, done, maxSteps) {
  for (let step = 0; step < (maxSteps || 2000); step++) {
    if (done()) return true;
    const c = clients.find((x) => x.myTurn());
    if (c) { const a = c.play(); if (!a.ok) throw new Error('move refused: ' + JSON.stringify(a)); }
    else clock.tick(2500);
  }
  return done();
}

module.exports = { fakeClock, makeRoom, client, playUntil };
