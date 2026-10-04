// The referee (public/js/room.js) driven through in-memory clients. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../public/js/rules.js');
const { Room, isRoomCode, newRoomCode, HOLD_MS } = require('../public/js/room.js');
const { makeRoom, client, playUntil } = require('./helpers.js');

// Every object in a message that looks like a card.
function cardsIn(value, out) {
  out = out || [];
  if (Array.isArray(value)) value.forEach((v) => cardsIn(v, out));
  else if (value && typeof value === 'object') {
    if (typeof value.suit === 'string' && Number.isInteger(value.id)) out.push(value);
    Object.values(value).forEach((v) => cardsIn(v, out));
  }
  return out;
}

// A room of `n` humans, all seated, game started.
function startedRoom(n, opts, audit) {
  const { room, clock } = makeRoom({ players: n, ...opts });
  const clients = [];
  for (let i = 0; i < n; i++) {
    const c = client(room, audit ? (m, text) => audit(room, i, m, text) : null);
    assert.equal(c.hello('P' + i).ok, true);
    clients.push(c);
  }
  assert.equal(clients[0].send('start').ok, true);
  return { room, clock, clients };
}

test('room codes are 8 crypto-random characters and the format is checked', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) { const c = newRoomCode(); assert.ok(isRoomCode(c), c); seen.add(c); }
  assert.equal(seen.size, 200);
  for (const bad of ['', 'ABC', 'abcdefgh', 'ABCDEFG1', 'ABCDEFGHI', 'ABCD EFG', null, 42]) assert.equal(isRoomCode(bad), false, String(bad));
});

test('the deal sends each player only their own hand, never another hand or the deck', () => {
  for (const n of [2, 4]) {
    let checked = 0;
    const audit = (room, seat, msg, text) => {
      assert.ok(!/"deck"|"hands"|"capturedTeams"|"token"/.test(text.replace(/"deckCount"/g, '')) || msg.t === 'ack', 'private key in ' + text.slice(0, 80));
      const gs = room.gs;
      if (!gs) return;
      const hidden = new Set(gs.deck.map((c) => c.id));
      gs.hands.forEach((h, i) => { if (i !== seat) h.forEach((c) => hidden.add(c.id)); });
      for (const c of cardsIn(msg)) assert.ok(!hidden.has(c.id), `seat ${seat} saw hidden card ${c.id} in a ${msg.t}`);
      if (msg.t === 'state') {
        assert.deepEqual(msg.s.hand.map((c) => c.id).sort(), (gs.hands[seat] || []).map((c) => c.id).sort());
        checked++;
      }
    };
    const { clock, clients } = startedRoom(n, {}, audit);
    assert.equal(clients[0].state.hand.length, 3);
    assert.equal(clients[0].state.game.tableCards.length, 4);
    assert.equal(clients[0].state.game.deckCount, 40 - 4 - 3 * n);
    playUntil(clients, clock, () => clients[0].state.game.phase === 'round_end');
    assert.ok(checked > 40, 'audited ' + checked + ' snapshots');
  }
});

test('the deck is shuffled with fresh randomness every game', () => {
  const orders = new Set();
  for (let i = 0; i < 20; i++) {
    const { room } = startedRoom(2);
    orders.add(room.gs.deck.map((c) => c.id).join(','));
  }
  assert.equal(orders.size, 20);
});

test('illegal moves are refused and change nothing', () => {
  const { room, clients } = startedRoom(2);
  const gs = room.gs;
  const card = (id, name, suit, value) => ({ id, name, suit, display: name, value });
  // a known table: 7 hearts, 3 diamonds, 4 clubs; the player to move holds a 7 and a 2
  gs.tableCards = [card(0, '7', 'hearts', 7), card(1, '3', 'diamonds', 3), card(2, '4', 'clubs', 4)];
  const turn = gs.currentTurn, other = 1 - turn;
  gs.hands[turn] = [card(10, '7', 'spades', 7), card(11, '2', 'clubs', 2)];
  gs.hands[other] = [card(20, '5', 'spades', 5)];
  const me = clients[turn], them = clients[other];
  me.send('sync'); them.send('sync');
  const seq = gs.moveSeq, game = gs.gameToken;

  let a = them.send('move', { game, seq, cardId: 20, captureCardIds: [] });
  assert.equal(a.ok, false); assert.equal(a.error, 'turn');
  a = me.send('move', { game, seq, cardId: 20, captureCardIds: [] });
  assert.equal(a.reason, 'not-in-hand');
  a = me.send('move', { game, seq, cardId: 10, captureCardIds: [1, 2] });
  assert.equal(a.reason, 'must-take-match'); assert.deepEqual(a.mustTake, [0]);
  a = me.send('move', { game, seq, cardId: 11, captureCardIds: [1] });
  assert.equal(a.reason, 'bad-sum');
  a = me.send('move', { game, seq, cardId: 11, captureCardIds: [] });   // force capture: the 7 must take
  assert.equal(a.reason, 'must-capture');
  a = me.send('move', { game, seq, cardId: '10', captureCardIds: ['x'] });
  assert.equal(a.ok, false);
  assert.equal(gs.moveSeq, seq);
  assert.equal(gs.tableCards.length, 3);
  assert.equal(gs.hands[turn].length, 2);
  // and the legal one goes through
  a = me.send('move', { game, seq, cardId: 10, captureCardIds: [0] });
  assert.equal(a.ok, true);
  assert.equal(gs.moveSeq, seq + 1);
});

test('a duplicate or stale move is ignored', () => {
  const { room, clients } = startedRoom(2);
  const gs = room.gs;
  const me = clients[gs.currentTurn];
  const g = me.state.game;
  const mv = R.chooseBotMove(me.state.hand, g.tableCards, 'medium', g.forceCapture);
  const payload = { game: g.gameToken, seq: g.moveSeq, cardId: mv.cardId, captureCardIds: mv.captureCardIds };
  assert.equal(me.send('move', payload).ok, true);
  const after = { seq: gs.moveSeq, table: gs.tableCards.length, turn: gs.currentTurn };
  // the same message again (a retry after a lost ack) and one from an older game
  assert.equal(me.send('move', payload).error, 'stale');
  assert.equal(me.send('move', { ...payload, game: g.gameToken - 1, seq: gs.moveSeq }).error, 'stale');
  assert.deepEqual({ seq: gs.moveSeq, table: gs.tableCards.length, turn: gs.currentTurn }, after);
  // snapshots only move forward
  const revs = me.inbox.filter((m) => m.t === 'state').map((m) => m.s.rev);
  assert.deepEqual(revs, revs.slice().sort((a, b) => a - b));
});

test('seats are claimed one at a time; a full or started room refuses newcomers', () => {
  const { room } = makeRoom({ players: 2 });
  const a = client(room), b = client(room), c = client(room);
  assert.equal(a.hello('Ana').seat, 0);
  assert.equal(b.hello('Ben').seat, 1);
  const full = c.hello('Cy');
  assert.equal(full.ok, false); assert.equal(full.error, 'full');
  assert.equal(client(room).hello('').error, 'name');
  assert.equal(a.send('start').ok, true);
  b.drop();
  assert.equal(client(room).hello('Dan').error, 'started');
});

test('a reconnect with the seat token resumes the same seat and hand', () => {
  const { room, clock, clients } = startedRoom(2);
  const [a, b] = clients;
  const hand = a.state.hand.map((c) => c.id);
  a.drop();
  const seen = b.state.seats[0];
  assert.equal(seen.connected, false);
  assert.ok(seen.away.holdLeft > 0 && seen.away.holdLeft <= HOLD_MS);
  clock.tick(5000);
  const a2 = client(room);
  const ack = a2.hello('someone else', a.token);
  assert.equal(ack.ok, true); assert.equal(ack.seat, 0); assert.equal(ack.resumed, true);
  assert.deepEqual(a2.state.hand.map((c) => c.id), hand);
  assert.equal(b.state.seats[0].connected, true);
  assert.ok(b.inbox.some((m) => m.t === 'notice' && /is back/.test(m.text)));
  // the same token from a second tab takes the seat over and closes the first
  const a3 = client(room);
  assert.equal(a3.hello('', a.token).seat, 0);
  assert.equal(a2.closed, 4001);
  // a wrong token is a newcomer, and the game has started
  assert.equal(client(room).hello('Eve', 'not-a-token').error, 'started');
});

test('4-player teams: seats 0+2 against 1+3, scored exactly like scoreRound', () => {
  // all ten diamonds to one team ends the match early (rare): deal again until a full deck is played
  for (let attempt = 0; attempt < 5; attempt++) {
    if (playFourPlayerDeck()) return;
  }
  assert.fail('no full deck in 5 attempts');
});

function playFourPlayerDeck() {
  const { clock, clients } = startedRoom(4, { winScore: 31 });
  const moves = [];
  let lastTable = [];
  const watch = clients[0];
  const seen = new Set();
  const record = () => {
    const g = watch.state.game;
    if (g.lastMove && !seen.has(g.lastMove.seq)) { seen.add(g.lastMove.seq); moves.push(g.lastMove); }
    if (g.phase === 'playing') lastTable = g.tableCards;
  };
  const teams = clients[0].state.game.players.map((p) => p.team);
  assert.deepEqual(teams, [0, 1, 0, 1]);
  for (let step = 0; step < 500 && watch.state.game.phase !== 'round_end'; step++) {
    const c = clients.find((x) => x.myTurn());
    if (c) { assert.equal(c.play().ok, true); record(); } else { clock.tick(2500); record(); }
  }
  const g = watch.state.game;
  if (g.phase === 'finished' && g.endReason === 'diamonds') return false;
  assert.equal(g.phase, 'round_end');
  const piles = [[], []];
  let lastTeam = -1;
  for (const mv of moves) {
    assert.equal(mv.teamIndex, mv.playerId % 2);
    if (mv.taken.length) { piles[mv.teamIndex].push(...mv.taken, mv.card); lastTeam = mv.teamIndex; }
  }
  if (lastTeam >= 0) piles[lastTeam].push(...lastTable);
  assert.equal(piles[0].length + piles[1].length, 40);
  const expected = R.scoreRound(piles, g.shkobbaCount);
  assert.deepEqual(g.scores, expected.points);
  assert.deepEqual(g.lastScore.counts, expected.counts);
  assert.deepEqual(g.capturedCounts, [piles[0].length, piles[1].length]);
  // everyone taps continue and the next deck goes out
  clients.forEach((c) => c.send('continue'));
  assert.equal(watch.state.game.phase, 'playing');
  assert.equal(watch.state.game.roundNum, 0);
  assert.equal(watch.state.game.deckCount, 40 - 4 - 12);
  return true;
}

test('two rooms run independently', () => {
  const one = startedRoom(2);
  const two = startedRoom(2);
  const before = two.room.gs.moveSeq;
  playUntil(one.clients, one.clock, () => one.room.gs.moveSeq >= 6);
  assert.equal(two.room.gs.moveSeq, before);
  assert.notEqual(one.room.gs.gameToken, undefined);
  // a token from one room means nothing in the other
  assert.equal(client(two.room).hello('X', one.clients[0].token).error, 'started');
});

test('bots play their turns with a delay, and a bot game reaches the tally', () => {
  const { room, clock } = makeRoom({ players: 2, speed: 'fast' });
  const me = client(room);
  me.hello('Player');
  assert.equal(me.send('addBot', { slot: 1, level: 'hard' }).ok, true);
  assert.equal(me.state.seats[1].name, 'Bot (hard)');
  assert.equal(me.send('start').ok, true);
  const g0 = room.gs;
  if (g0.currentTurn === 1) {
    const seq = g0.moveSeq;
    clock.tick(100);
    assert.equal(g0.moveSeq, seq, 'the bot waits before it plays');
  }
  assert.ok(playUntil([me], clock, () => me.state.game.phase === 'round_end'));
  assert.equal(me.state.game.capturedCounts[0] + me.state.game.capturedCounts[1], 40);
});

test('the host leaving does not stall the lobby or the game', () => {
  // lobby: control passes to the next player, who can fill the room and start
  let { room, clock } = makeRoom({ players: 4 });
  const host = client(room), guest = client(room);
  host.hello('Host'); guest.hello('Guest');
  assert.equal(guest.state.owner, 0);
  assert.equal(guest.send('addBot', { slot: 2 }).error, 'not-owner');
  host.send('leave');
  assert.equal(guest.state.owner, 1);
  assert.equal(guest.state.seats[0], null);
  guest.send('addBot', { slot: 0 }); guest.send('addBot', { slot: 2 }); guest.send('addBot', { slot: 3 });
  assert.equal(guest.send('start').ok, true);
  assert.ok(playUntil([guest], clock, () => guest.state.game.moveSeq >= 8));

  // game: the host drops; the guest plays on, then gives the seat to a bot after the hold
  ({ room, clock } = makeRoom({ players: 2 }));
  const h = client(room), g = client(room);
  h.hello('Host'); g.hello('Guest'); h.send('start');
  h.drop();
  assert.equal(g.state.owner, 1);
  assert.equal(g.send('away', { seat: 0, action: 'bot' }).error, 'not-away');   // still inside the hold
  playUntil([g], clock, () => g.state.game.currentTurn === 0);
  const seq = g.state.game.moveSeq;
  clock.tick(HOLD_MS + 1000);
  assert.equal(g.state.seats[0].away.expired, true);
  assert.equal(g.state.game.moveSeq, seq, 'the table waits for the seat');
  assert.equal(g.send('away', { seat: 0, action: 'bot' }).ok, true);
  assert.equal(g.state.seats[0].takeover, true);
  assert.ok(playUntil([g], clock, () => g.state.game.phase === 'round_end'));
  g.send('continue');   // the only player here: the next deck goes out at once
  assert.equal(g.state.game.phase, 'playing');
  // the host comes back and gets the seat (and the hand) back from the bot
  const h2 = client(room);
  assert.equal(h2.hello('', h.token).seat, 0);
  assert.equal(g.state.seats[0].takeover, false);
  assert.equal(g.state.game.players[0].isBot, false);
});

test('ending the game for a gone player gives the win to the side still here', () => {
  const { clock, clients } = startedRoom(2);
  const [a, b] = clients;
  a.send('leave');
  assert.equal(b.state.seats[0].away.left, true);
  assert.equal(b.state.seats[0].away.expired, true);
  assert.equal(b.send('away', { seat: 0, action: 'end' }).ok, true);
  assert.equal(b.state.game.phase, 'finished');
  assert.equal(b.state.game.winner, 1);
  assert.equal(b.state.game.endReason, 'forfeit');
  clock.tick(60000);
});

test('the turn timer plays for a player who runs out of time', () => {
  const { room, clock, clients } = startedRoom(2, { timer: 10 });
  const seq = room.gs.moveSeq;
  const turn = room.gs.currentTurn;
  assert.ok(clients[turn].state.game.turnMsLeft > 0);
  clock.tick(5000);
  assert.equal(room.gs.moveSeq, seq);
  clock.tick(10000);
  assert.equal(room.gs.moveSeq, seq + 1);
  assert.ok(clients[0].inbox.some((m) => m.t === 'notice' && /ran out of time/.test(m.text)));
});

test('the tally moves on by itself when someone never taps continue', () => {
  const { room, clock, clients } = startedRoom(2, { winScore: 31 });
  playUntil(clients, clock, () => room.gs.phase === 'round_end');
  clients[0].send('continue');
  assert.equal(room.gs.phase, 'round_end');
  assert.deepEqual(clients[1].state.ready, [0]);
  clock.tick(31000);
  assert.equal(room.gs.phase, 'playing');
});

test('only the owner changes the rules; surrender ends the match', () => {
  const { room, clients } = startedRoom(2);
  assert.equal(clients[1].send('settings', { forceCapture: false }).error, 'not-owner');
  assert.equal(clients[0].send('settings', { forceCapture: false, look: { theme: 'c' } }).ok, true);
  assert.equal(clients[1].state.game.forceCapture, false);
  assert.equal(clients[1].state.game.look.theme, 'c');
  assert.equal(clients[1].send('surrender').ok, true);
  assert.equal(room.gs.phase, 'finished');
  assert.equal(room.gs.winner, 0);
  assert.equal(clients[1].send('rematch').error, 'not-owner');
  assert.equal(clients[0].send('rematch').ok, true);
  assert.equal(room.gs.phase, 'playing');
});

test('a saved room restores with the same hands, and its player can resume', () => {
  const { room, clients } = startedRoom(2);
  const saved = JSON.parse(JSON.stringify(room.serialize()));
  const hand = clients[1].state.hand.map((c) => c.id);
  room.destroy();
  const { clock } = makeRoom({});
  const back = Room.restore(saved, { clock });
  const c = client(back);
  assert.equal(c.hello('', clients[1].token).seat, 1);
  assert.deepEqual(c.state.hand.map((x) => x.id), hand);
  assert.equal(c.state.seats[0].connected, false);
});

test('bad input is ignored without throwing', () => {
  const { room } = makeRoom({ players: 2 });
  const c = client(room);
  room.message(c.conn, 'not json');
  room.message(c.conn, JSON.stringify({ nope: 1 }));
  room.message(c.conn, 'x'.repeat(10000));
  assert.equal(c.send('move', { cardId: 1 }).error, 'not-seated');
  c.hello('A');
  assert.equal(c.send('whatever').error, 'unknown');
  assert.equal(c.send('emote', { key: 'gg' }).ok, true);
  assert.equal(c.send('emote', { key: 'gg' }).error, 'slow-down');
});
