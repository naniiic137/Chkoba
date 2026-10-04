/* The referee: one room of Chkobba, from the lobby to the final score.
 * Transport-free: no socket, no DOM, no database. A transport hands it connections
 * (room.connect(send, close)), raw messages (room.message(conn, text)) and drops
 * (room.disconnect(conn)); the room answers through each connection's send().
 * The same file runs in the Cloudflare Durable Object, in the local Node server and
 * in the browser for an offline game against the bot.
 *
 * The room owns the deck and every hand. A player only ever receives a snapshot
 * of the public state plus their own hand: never another hand, never the deck order.
 * Clients send intentions (play this card, take these cards); the room checks the
 * turn, the card's owner and the capture with js/rules.js before anything changes. */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./rules.js') : root.ChkobaRules);
  if (isNode) module.exports = api;
  else root.ChkobaRoom = api;
})(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';

  const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
  const DIAMONDS = 'diamonds';
  const CARD_DEFS = [
    { name: 'ace', display: 'A', value: 1 },
    { name: '2', display: '2', value: 2 },
    { name: '3', display: '3', value: 3 },
    { name: '4', display: '4', value: 4 },
    { name: '5', display: '5', value: 5 },
    { name: '6', display: '6', value: 6 },
    { name: '7', display: '7', value: 7 },
    { name: 'jack', display: 'J', value: 9 },
    { name: 'queen', display: 'Q', value: 8 },
    { name: 'king', display: 'K', value: 10 },
  ];
  const SUIT_SYMBOLS = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };

  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const CODE_LEN = 8;
  const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

  const HOLD_MS = 60000;            // a dropped player's seat is kept this long before others may act
  const ROUND_END_AUTO_MS = 30000;  // the tally moves on by itself if someone never taps continue
  const MAX_MESSAGE = 4096;         // bytes; every real message is far smaller
  const RATE_WINDOW_MS = 5000, RATE_MAX = 40;
  const EMOTE_GAP_MS = 800;

  const BOT_NAMES = { easy: 'Bot (easy)', medium: 'Bot', hard: 'Bot (hard)' };
  const EMOTES = { gg: 'GG! \u{1F44F}', nice: 'Nice! \u{1F525}', wow: 'Wow! \u{1F632}', oops: 'Oops! \u{1F605}', hurry: 'Hurry up! ⏰' };
  // a bot's think time depends on the speed setting only, never on its hand
  const BOT_DELAY = { slow: [1200, 800], normal: [600, 800], fast: [200, 300] };

  const THEMES = ['a', 'b', 'c'], CARD_STYLES = ['svg', 'photo', 'pixel'], SUIT_STYLES = ['french', 'coin'];
  const DEFAULT_LOOK = { theme: 'b', cards: 'photo', suits: 'french' };

  // ---- randomness: crypto for the deck, the codes and the seat tokens ----
  function randomInt(n) {
    const buf = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / n) * n;   // rejection sampling keeps it unbiased
    do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
    return buf[0] % n;
  }
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  function newRoomCode() {
    let c = '';
    for (let i = 0; i < CODE_LEN; i++) c += CODE_CHARS[randomInt(CODE_CHARS.length)];
    return c;
  }
  function isRoomCode(code) { return typeof code === 'string' && CODE_RE.test(code); }
  function newToken() {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  function createDeck() {
    let id = 0;
    const deck = [];
    for (const suit of SUITS) for (const def of CARD_DEFS) deck.push({ id: id++, suit, name: def.name, display: def.display, value: def.value });
    return deck;
  }
  const slim = (c) => ({ id: c.id, suit: c.suit, name: c.name, display: c.display, value: c.value });
  const cardName = (c) => `${c.display}${SUIT_SYMBOLS[c.suit]}`;

  function cleanName(v) {
    if (typeof v !== 'string') return '';
    return v.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
  }
  function normalizeLook(l) {
    const o = l || {};
    return {
      theme: THEMES.includes(o.theme) ? o.theme : DEFAULT_LOOK.theme,
      cards: CARD_STYLES.includes(o.cards) ? o.cards : DEFAULT_LOOK.cards,
      suits: SUIT_STYLES.includes(o.suits) ? o.suits : DEFAULT_LOOK.suits,
    };
  }
  // Room options as the creator chose them on the Options screen; anything odd falls back.
  function normalizeOpts(o) {
    o = o || {};
    return {
      players: +o.players === 4 ? 4 : 2,
      winScore: [5, 11, 21, 31].includes(+o.winScore) ? +o.winScore : 21,
      timer: [0, 10, 15, 30, 45, 60].includes(+o.timer) ? +o.timer : 0,
      bot: BOT_NAMES[o.bot] ? o.bot : 'medium',
      speed: BOT_DELAY[o.speed] ? o.speed : 'normal',
      forceCapture: o.forceCapture !== false,
      captureAssist: !!o.captureAssist,
      look: normalizeLook(o.look),
    };
  }

  // How long the clients need to animate a move or a deal. The room waits this long
  // before a bot plays or a timer starts, so the table never runs ahead of the screen.
  function moveAnimMs(mv) {
    if (!mv) return 0;
    if (!mv.taken || !mv.taken.length) return 700;
    return 1000 + (mv.taken.length + 1) * 150 + (mv.chkobba ? 1900 : 0);
  }
  function dealAnimMs(numPlayers, withTable) { return ((withTable ? 4 : 0) + 3 * numPlayers) * 90 + 600; }

  const realClock = {
    now: () => Date.now(),
    setTimeout: (f, ms) => setTimeout(f, ms),
    clearTimeout: (t) => clearTimeout(t),
  };

  class Room {
    // opts: room options (see normalizeOpts) plus code.
    // env:  { clock, holdMs, onChange(room), onClose(room), log(level, ...args) }
    constructor(opts, env) {
      env = env || {};
      this.code = (opts && opts.code) || '';
      this.clock = env.clock || realClock;
      this.holdMs = env.holdMs !== undefined ? env.holdMs : HOLD_MS;
      this.onChange = env.onChange || null;
      this.onClose = env.onClose || null;
      this.log = env.log || (() => {});
      this.opts = normalizeOpts(opts);
      this.seats = new Array(this.opts.players).fill(null);
      this.owner = -1;          // the seat with lobby control: the creator, then the next player
      this.gs = null;           // the authoritative game (null in the lobby)
      this.moveLog = [];
      this.ready = {};          // seats that tapped continue on the round-end tally
      this.rev = 0;             // snapshot counter: clients drop anything older than what they have
      this.turnStartedAt = 0;
      this.conns = new Set();
      this.timers = {};
      this.closed = false;
      this.lastActive = this.clock.now();
    }

    now() { return this.clock.now(); }

    // ================= TRANSPORT SIDE =================
    connect(send, close) {
      const conn = { send, close: close || (() => {}), seat: -1, hits: [], lastEmote: 0 };
      this.conns.add(conn);
      this.lastActive = this.now();
      return conn;
    }

    disconnect(conn) {
      if (!this.conns.delete(conn)) return;
      this.lastActive = this.now();
      const i = conn.seat;
      conn.seat = -1;
      const s = i >= 0 ? this.seats[i] : null;
      if (!s || s.conn !== conn) return;
      s.conn = null;
      s.connected = false;
      s.awaySince = this.now();
      this._setTimer('hold' + i, this.holdMs, () => this._holdExpired(i));
      this._passOwner();
      if (this.gs) this._log(`${s.name} lost connection`);
      this._commit();
      if (!this._humansHere()) this._clearTimer('turn');   // nobody watching: the table waits
    }

    message(conn, raw) {
      if (this.closed || !this.conns.has(conn)) return;
      let msg = raw;
      if (typeof raw === 'string') {
        if (raw.length > MAX_MESSAGE) return;
        try { msg = JSON.parse(raw); } catch (e) { return; }
      }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
      const id = Number.isInteger(msg.id) ? msg.id : undefined;
      const reply = (ok, extra) => { if (id !== undefined) this._send(conn, { t: 'ack', id, ok, ...(extra || {}) }); };
      if (msg.t === 'ping') { this._send(conn, { t: 'pong' }); return; }
      const now = this.now();
      conn.hits = conn.hits.filter((t) => now - t < RATE_WINDOW_MS);
      if (conn.hits.length >= RATE_MAX) { reply(false, { error: 'slow-down' }); return; }
      conn.hits.push(now);
      this.lastActive = now;

      if (msg.t === 'hello') { this._hello(conn, msg, reply); return; }
      if (conn.seat < 0) { reply(false, { error: 'not-seated' }); return; }
      if (msg.t === 'sync') { this._sendState(conn); reply(true); return; }
      const handler = HANDLERS[msg.t];
      if (!handler) { reply(false, { error: 'unknown' }); return; }
      let res;
      try { res = handler.call(this, conn.seat, msg, conn); } catch (e) { this.log('error', 'handler', msg.t, e); res = { error: 'server' }; }
      if (res && res.error) reply(false, res);
      else reply(true, res || {});
    }

    // Seated, and the socket is there.
    _humansHere() { return this.seats.some((s) => s && s.human && s.connected); }
    _isBotSeat(i) { const s = this.seats[i]; return !!s && (!!s.bot || !!s.takeover); }
    _botLevel(i) { const s = this.seats[i]; return (s && (s.bot || s.takeover)) || 'medium'; }

    _send(conn, obj) {
      try { conn.send(JSON.stringify(obj)); } catch (e) { /* a dead socket: its close event cleans up */ }
    }
    _sendState(conn) { if (conn.seat >= 0) this._send(conn, { t: 'state', s: this.snapshotFor(conn.seat) }); }
    _notice(text, except) {
      for (const c of this.conns) if (c.seat >= 0 && c.seat !== except) this._send(c, { t: 'notice', text });
    }
    // Every change ends here: a new revision goes to every seated connection.
    _commit() {
      this.rev++;
      for (const c of this.conns) this._sendState(c);
      if (this.onChange) { try { this.onChange(this); } catch (e) { this.log('warn', 'onChange failed', e); } }
    }

    _setTimer(name, ms, fn) {
      this._clearTimer(name);
      this.timers[name] = this.clock.setTimeout(() => {
        delete this.timers[name];
        if (this.closed) return;
        try { fn(); } catch (e) { this.log('error', 'timer', name, e); }
      }, Math.max(0, ms));
    }
    _clearTimer(name) {
      if (this.timers[name] !== undefined) { this.clock.clearTimeout(this.timers[name]); delete this.timers[name]; }
    }

    destroy() {
      Object.keys(this.timers).forEach((k) => this._clearTimer(k));
      this.closed = true;
    }
    _close() {
      if (this.closed) return;
      this.destroy();
      for (const c of this.conns) { this._send(c, { t: 'error', error: 'closed' }); try { c.close(4010, 'Room closed'); } catch (e) { /* gone */ } }
      this.conns.clear();
      if (this.onClose) this.onClose(this);
    }

    // ================= SEATS =================
    _hello(conn, msg, reply) {
      if (conn.seat >= 0) { reply(true, { seat: conn.seat, token: this.seats[conn.seat].token }); return; }
      const token = typeof msg.token === 'string' ? msg.token.slice(0, 64) : '';
      const mine = token ? this.seats.findIndex((s) => s && s.human && s.token === token) : -1;
      if (mine >= 0) { this._resume(conn, mine, reply); return; }
      const name = cleanName(msg.name);
      if (!name) { reply(false, { error: 'name' }); return; }
      if (this.gs) { reply(false, { error: 'started' }); return; }
      // claiming is atomic: the room handles one message at a time
      const i = this.seats.findIndex((s) => !s);
      if (i < 0) { reply(false, { error: 'full' }); return; }
      this.seats[i] = { name, token: newToken(), human: true, bot: null, takeover: null, conn, connected: true, awaySince: 0, holdExpired: false, left: false };
      conn.seat = i;
      if (this.owner < 0) this.owner = i;
      this._passOwner();
      reply(true, { seat: i, token: this.seats[i].token });
      this._commit();
    }

    // The same seat, the same hand: a reload, a new socket after a drop, or a bot handing back.
    _resume(conn, i, reply) {
      const s = this.seats[i];
      if (s.conn && s.conn !== conn) {
        const old = s.conn;
        old.seat = -1;
        this._send(old, { t: 'error', error: 'replaced' });
        try { old.close(4001, 'Opened somewhere else'); } catch (e) { /* gone */ }
      }
      const wasGone = !s.connected || s.left;
      const hadBot = !!s.takeover;
      s.conn = conn; s.connected = true; s.awaySince = 0; s.holdExpired = false; s.left = false; s.takeover = null;
      conn.seat = i;
      this._clearTimer('hold' + i);
      this._passOwner();
      reply(true, { seat: i, token: s.token, resumed: true });
      if (this.gs && wasGone) { this._log(`${s.name} is back`); this._notice(`${s.name} is back`, i); }
      // a bot was playing this seat, or the table was waiting for someone to come back
      if (this.gs && (hadBot || this.timers.turn === undefined)) this._arm(0);
      this._commit();
    }

    _holdExpired(i) {
      const s = this.seats[i];
      if (!s || s.connected) return;
      if (!this.gs) {
        this.seats[i] = null;          // the lobby frees the seat for someone else
        this._passOwner();
        if (!this.seats.some((x) => x && x.human)) { this._close(); return; }
      } else {
        s.holdExpired = true;          // the others may now give the seat to a bot or end the game
      }
      this._commit();
    }

    // Lobby control passes to the next player when its holder is gone, so nothing stalls.
    _passOwner() {
      const here = (i) => { const s = this.seats[i]; return !!s && s.human && s.connected; };
      if (this.owner >= 0 && here(this.owner)) return;
      for (let k = 1; k <= this.seats.length; k++) {
        const i = ((this.owner < 0 ? 0 : this.owner) + k) % this.seats.length;
        if (here(i)) { this.owner = i; return; }
      }
    }

    _botName(level) {
      const base = BOT_NAMES[level] || 'Bot';
      const taken = this.seats.filter(Boolean).map((s) => s.name);
      let name = base, n = 2;
      while (taken.includes(name)) name = base + ' ' + n++;
      return name;
    }

    // ================= GAME =================
    _log(text) {
      this.moveLog.push({ ts: this.now(), text });
      if (this.moveLog.length > 100) this.moveLog.shift();
    }

    _startGame() {
      const n = this.opts.players;
      const prev = this.gs ? this.gs.gameToken : 0;
      this.ready = {};
      this.moveLog = [];
      this.gs = {
        phase: 'playing', numPlayers: n,
        gameToken: Math.max(this.now(), prev + 1),
        players: this.seats.map((s, i) => ({ id: i, name: s.name, team: n === 4 ? i % 2 : i })),
        deck: shuffle(createDeck()), tableCards: [], hands: this.seats.map(() => []),
        capturedTeams: [[], []], currentTurn: -1, dealerIndex: 0, roundNum: 0, totalRounds: R.dealsPerDeck(n),
        cardsPlayedThisRound: this.seats.map(() => 0), lastCaptureTeam: -1,
        shkobbaCount: [0, 0], scores: [0, 0],
        forceCapture: this.opts.forceCapture, captureAssist: this.opts.captureAssist, winScore: this.opts.winScore,
        shkobbaThisTurn: false, turnTimerDuration: this.opts.timer, lastMove: null, moveSeq: 0,
        endReason: null, winner: -1,
      };
      this._log('Game started');
      this._dealRound();
    }

    _dealRound() {
      const gs = this.gs;
      const withTable = gs.roundNum === 0;
      if (withTable) {
        for (let i = 0; i < 4 && gs.deck.length > 0; i++) gs.tableCards.push(gs.deck.pop());
        gs.currentTurn = (gs.dealerIndex + 1) % gs.numPlayers;
      } else {
        gs.currentTurn = gs.nextDealerTurn !== undefined ? gs.nextDealerTurn : (gs.dealerIndex + 1) % gs.numPlayers;
      }
      for (let i = 0; i < gs.numPlayers; i++) {
        gs.hands[i] = [];
        for (let j = 0; j < 3 && gs.deck.length > 0; j++) gs.hands[i].push(gs.deck.pop());
      }
      gs.cardsPlayedThisRound = gs.cardsPlayedThisRound.map(() => 0);
      gs.shkobbaThisTurn = false;
      this._log('Cards dealt, hand ' + (gs.roundNum + 1));
      this._arm(dealAnimMs(gs.numPlayers, withTable));
      this._commit();
    }

    // Schedules whatever the table waits for next: a bot's move, the turn timer, the
    // end of a deal or the tally moving on. One slot, so a state change can never leave
    // two of them running. Everything is derived from the state, so a restored room
    // just calls this again.
    _arm(delay) {
      this._clearTimer('turn');
      const gs = this.gs;
      if (!gs || this.closed || !this._humansHere()) return;
      delay = delay || 0;
      const token = gs.gameToken, seq = gs.moveSeq;
      const same = () => this.gs === gs && gs.gameToken === token && gs.moveSeq === seq;
      if (gs.phase === 'round_end') { this._setTimer('turn', delay + ROUND_END_AUTO_MS, () => { if (same()) this._nextRound(); }); return; }
      if (gs.phase !== 'playing') return;
      if (gs.currentTurn < 0) {
        if (gs.hands.every((h) => h.length === 0)) this._setTimer('turn', delay + 400, () => { if (same()) this._endRound(); });
        return;
      }
      const pid = gs.currentTurn;
      this.turnStartedAt = this.now() + delay;
      if (this._isBotSeat(pid)) {
        const [base, spread] = BOT_DELAY[this.opts.speed] || BOT_DELAY.normal;
        this._setTimer('turn', delay + base + Math.random() * spread, () => { if (same() && gs.currentTurn === pid) this._botPlay(pid); });
      } else if (gs.turnTimerDuration > 0) {
        this._setTimer('turn', delay + gs.turnTimerDuration * 1000, () => { if (same() && gs.currentTurn === pid) this._autoPlay(pid); });
      }
    }

    _botPlay(pid) {
      const gs = this.gs;
      const hand = gs.hands[pid];
      if (!hand || !hand.length) return;
      // legal captures only: a card of equal value on the table is taken before any sum
      const mv = R.chooseBotMove(hand, gs.tableCards, this._botLevel(pid), gs.forceCapture);
      this._play(pid, mv.cardId, mv.captureCardIds);
    }

    _autoPlay(pid) {
      const gs = this.gs;
      const hand = gs.hands[pid];
      if (!hand || !hand.length) return;
      const mv = R.autoPlayMove(hand, gs.tableCards, gs.forceCapture);
      const card = hand.find((c) => c.id === mv.cardId);
      const name = gs.players[pid].name;
      this._log(`Time's up: ${name} auto-played ${cardName(card)}`);
      this._notice(`${name} ran out of time`);
      this._play(pid, mv.cardId, mv.captureCardIds);
    }

    // One rule check for every source of moves: players, bots and the turn timer.
    _play(playerId, cardId, captureIds) {
      const gs = this.gs;
      if (!gs || gs.phase !== 'playing') return { error: 'phase' };
      if (playerId !== gs.currentTurn) return { error: 'turn' };
      const hand = gs.hands[playerId];
      const cardIndex = hand ? hand.findIndex((c) => c.id === cardId) : -1;
      if (cardIndex === -1) return { error: 'illegal', reason: 'not-in-hand', mustTake: [] };
      const verdict = R.checkMove(hand, gs.tableCards, cardId, captureIds, gs.forceCapture);
      if (!verdict.ok) return { error: 'illegal', reason: verdict.reason, mustTake: verdict.mustTake || [] };

      this._clearTimer('turn');
      gs.shkobbaThisTurn = false;
      const playedCard = hand.splice(cardIndex, 1)[0];
      const teamIndex = gs.players[playerId].team;
      const playerName = gs.players[playerId].name;
      gs.moveSeq++;
      gs.lastMove = { seq: gs.moveSeq, playerId, teamIndex, card: slim(playedCard), taken: [], chkobba: false };

      if (captureIds.length > 0) {
        const captured = [];
        const sorted = [...captureIds].sort((a, b) => gs.tableCards.findIndex((c) => c.id === b) - gs.tableCards.findIndex((c) => c.id === a));
        for (const id of sorted) {
          const idx = gs.tableCards.findIndex((c) => c.id === id);
          if (idx !== -1) captured.push(...gs.tableCards.splice(idx, 1));
        }
        gs.lastMove.taken = captured.map(slim);
        captured.push(playedCard);
        gs.capturedTeams[teamIndex].push(...captured);
        gs.lastCaptureTeam = teamIndex;
        let logMsg = `${playerName} took ${gs.lastMove.taken.map(cardName).join('+')} with ${cardName(playedCard)}`;
        // Chkobba: clearing the table. The dealer's very last card of the deck does not count.
        if (gs.tableCards.length === 0 && !(playerId === gs.dealerIndex && hand.length === 0 && gs.deck.length === 0)) {
          gs.shkobbaCount[teamIndex]++;
          gs.shkobbaThisTurn = true;
          gs.lastMove.chkobba = true;
          logMsg += ', CHKOBBA';
        }
        this._log(logMsg);
        // instant win: all 10 diamonds captured
        if (gs.capturedTeams[teamIndex].filter((c) => c.suit === DIAMONDS).length >= 10) {
          this._log('All 10 diamonds captured, instant win');
          gs.phase = 'finished'; gs.winner = teamIndex; gs.endReason = 'diamonds'; gs.currentTurn = -1;
          this._commit();
          return {};
        }
      } else {
        gs.tableCards.push(playedCard);
        this._log(`${playerName} placed ${cardName(playedCard)}`);
      }

      gs.cardsPlayedThisRound[playerId]++;
      const wait = moveAnimMs(gs.lastMove);
      if (gs.hands.every((h) => h.length === 0)) {
        if (gs.deck.length > 0) gs.nextDealerTurn = (playerId + 1) % gs.numPlayers;
        gs.currentTurn = -1;
        this._arm(wait);
        this._commit();
      } else {
        this._nextTurn(wait);
      }
      return {};
    }

    _nextTurn(wait) {
      const gs = this.gs;
      let next = (gs.currentTurn + 1) % gs.numPlayers, attempts = 0;
      while (gs.hands[next].length === 0 && attempts < gs.numPlayers) { next = (next + 1) % gs.numPlayers; attempts++; }
      if (attempts >= gs.numPlayers || gs.hands.every((h) => h.length === 0)) { this._endRound(); return; }
      gs.currentTurn = next;
      this._arm(wait);
      this._commit();
    }

    // roundNum counts the deals of the current deck (0-based). It only moves on when
    // another deal actually goes out, so the last deal of a deck still reads n/n.
    _endRound() {
      const gs = this.gs;
      if (gs.deck.length === 0) {
        if (gs.tableCards.length > 0 && gs.lastCaptureTeam >= 0) {
          gs.capturedTeams[gs.lastCaptureTeam].push(...gs.tableCards);
          gs.tableCards = [];
        }
        this._scoreRound();
        return;
      }
      gs.roundNum++;
      this._dealRound();
    }

    _scoreRound() {
      const gs = this.gs;
      const r = R.scoreRound(gs.capturedTeams, gs.shkobbaCount);
      gs.scores[0] += r.points[0];
      gs.scores[1] += r.points[1];
      // counts travel with the verdicts so every client can stage the same tally
      gs.lastScore = { mostCardsPt: r.mostCardsPt, mostDiamondsPt: r.mostDiamondsPt, sevenDiamondsPt: r.sevenDiamondsPt, mostSevensPt: r.mostSevensPt, counts: r.counts };
      gs.phase = 'round_end';
      gs.currentTurn = -1;
      this.ready = {};
      this._log(`Deal scored: ${gs.scores[0]} - ${gs.scores[1]}`);
      this._arm(0);
      this._commit();
    }

    _nextRound() {
      const gs = this.gs;
      if (!gs || gs.phase !== 'round_end') return;
      this.ready = {};
      const winner = R.matchWinner(gs.scores, gs.winScore);
      if (winner >= 0) {
        gs.phase = 'finished'; gs.winner = winner; gs.endReason = 'score';
        this._log(`Team ${winner + 1} wins the game`);
        this._clearTimer('turn');
        this._commit();
        return;
      }
      if (gs.deck.length > 0) { gs.phase = 'playing'; gs.roundNum++; this._dealRound(); return; }
      // the deck is empty: the deal passes on and a fresh deck goes out
      gs.dealerIndex = (gs.dealerIndex + 1) % gs.numPlayers;
      gs.totalRounds = R.dealsPerDeck(gs.numPlayers);
      gs.phase = 'playing'; gs.deck = shuffle(createDeck());
      gs.capturedTeams = [[], []]; gs.shkobbaCount = [0, 0]; gs.lastCaptureTeam = -1;
      gs.tableCards = []; gs.roundNum = 0; gs.lastMove = null; gs.lastScore = null;
      delete gs.nextDealerTurn;
      this._dealRound();
    }

    _finish(winner, reason, logText) {
      const gs = this.gs;
      gs.phase = 'finished'; gs.winner = winner; gs.endReason = reason; gs.currentTurn = -1;
      this._clearTimer('turn');
      this._log(logText);
      this._commit();
    }

    // ================= SNAPSHOTS =================
    _publicState() {
      const gs = this.gs;
      const ownership = {};
      for (let t = 0; t < 2; t++) for (const c of gs.capturedTeams[t]) if (c.suit === DIAMONDS) ownership[c.name] = t;
      const human = gs.currentTurn >= 0 && !this._isBotSeat(gs.currentTurn);
      const total = (gs.turnTimerDuration || 0) * 1000;
      const left = gs.phase === 'playing' && human && total > 0 && this.timers.turn !== undefined
        ? Math.max(0, Math.min(total, this.turnStartedAt + total - this.now())) : 0;
      return {
        phase: gs.phase, numPlayers: gs.numPlayers, gameToken: gs.gameToken,
        players: gs.players.map((p) => ({ id: p.id, name: p.name, team: p.team, isBot: this._isBotSeat(p.id) })),
        tableCards: gs.tableCards.map(slim), deckCount: gs.deck.length,
        currentTurn: gs.currentTurn, dealerIndex: gs.dealerIndex,
        roundNum: gs.roundNum, totalRounds: gs.totalRounds,
        lastCaptureTeam: gs.lastCaptureTeam, shkobbaCount: [...gs.shkobbaCount],
        capturedCounts: gs.capturedTeams.map((t) => t.length),
        scores: [...gs.scores], forceCapture: gs.forceCapture, captureAssist: !!gs.captureAssist, winScore: gs.winScore,
        cardsPlayedThisRound: [...gs.cardsPlayedThisRound],
        lastScore: gs.lastScore || null, shkobbaThisTurn: !!gs.shkobbaThisTurn,
        winner: gs.winner, endReason: gs.endReason || null,
        turnTimerDuration: gs.turnTimerDuration || 0, turnMsLeft: left,
        nextDealerTurn: gs.nextDealerTurn !== undefined ? gs.nextDealerTurn : -1,
        diamondOwnership: ownership,
        lastMove: gs.lastMove || null, moveSeq: gs.moveSeq,
        look: this.opts.look,
      };
    }

    // What one seat may see: the public state and its own hand, nothing else.
    snapshotFor(i) {
      const now = this.now();
      const gs = this.gs;
      return {
        rev: this.rev, code: this.code, you: i, owner: this.owner,
        opts: { ...this.opts, look: { ...this.opts.look } },
        seats: this.seats.map((s, k) => (s ? {
          id: k, name: s.name, bot: !!s.bot, takeover: !!s.takeover,
          connected: s.human ? s.connected : true,
          away: s.human && !s.connected ? { holdLeft: Math.max(0, s.awaySince + this.holdMs - now), expired: !!s.holdExpired, left: !!s.left } : null,
        } : null)),
        game: gs ? this._publicState() : null,
        hand: gs && gs.hands[i] ? gs.hands[i].map(slim) : [],
        log: this.moveLog.slice(-50),
        ready: Object.keys(this.ready).map(Number),
      };
    }

    // ================= PERSISTENCE =================
    // The whole room, hands and deck included. Only for the room's own storage (the
    // Durable Object, or the browser's save of an offline bot game), never for a client.
    serialize() {
      return {
        v: 1, code: this.code, opts: this.opts, owner: this.owner, rev: this.rev,
        seats: this.seats.map((s) => (s ? { name: s.name, token: s.token || '', human: !!s.human, bot: s.bot || null, takeover: s.takeover || null, left: !!s.left, holdExpired: !!s.holdExpired } : null)),
        gs: this.gs, moveLog: this.moveLog, ready: this.ready, savedAt: this.now(),
      };
    }

    static restore(data, env) {
      const room = new Room({ ...data.opts, code: data.code }, env);
      const now = room.now();
      room.owner = data.owner;
      room.rev = data.rev || 0;
      room.gs = data.gs || null;
      room.moveLog = data.moveLog || [];
      room.ready = data.ready || {};
      room.seats = (data.seats || []).map((s) => (s ? { ...s, conn: null, connected: !s.human, awaySince: now } : null));
      // every human is away until their socket comes back: the hold starts again
      room.seats.forEach((s, i) => { if (s && s.human && !s.holdExpired) room._setTimer('hold' + i, room.holdMs, () => room._holdExpired(i)); });
      return room;
    }
  }

  // ================= MESSAGES (seat, msg) =================
  const isOwner = (room, seat) => room.owner === seat;
  const HANDLERS = {
    // ---- lobby ----
    start(seat) {
      if (!isOwner(this, seat)) return { error: 'not-owner' };
      if (this.gs) return { error: 'started' };
      if (this.seats.some((s) => !s)) return { error: 'not-full' };
      const away = this.seats.find((s) => s.human && !s.connected);
      if (away) return { error: 'away', name: away.name };
      this._startGame();
      return {};
    },
    addBot(seat, msg) {
      if (!isOwner(this, seat)) return { error: 'not-owner' };
      if (this.gs) return { error: 'started' };
      const slot = msg.slot;
      if (!Number.isInteger(slot) || slot < 0 || slot >= this.seats.length) return { error: 'bad-slot' };
      if (this.seats[slot]) return { error: 'taken' };
      const level = BOT_NAMES[msg.level] ? msg.level : this.opts.bot;
      this.seats[slot] = { name: this._botName(level), human: false, bot: level, takeover: null, token: '', conn: null, connected: true, awaySince: 0, holdExpired: false, left: false };
      this._commit();
      return {};
    },
    removeBot(seat, msg) {
      if (!isOwner(this, seat)) return { error: 'not-owner' };
      if (this.gs) return { error: 'started' };
      const s = this.seats[msg.slot];
      if (!s || !s.bot) return { error: 'not-bot' };
      this.seats[msg.slot] = null;
      this._commit();
      return {};
    },
    // 4 players: move a seat to the other team (0+2 against 1+3)
    swap(seat, msg) {
      if (!isOwner(this, seat)) return { error: 'not-owner' };
      if (this.gs) return { error: 'started' };
      if (this.seats.length !== 4) return { error: 'not-teams' };
      const a = msg.slot;
      if (!Number.isInteger(a) || a < 0 || a > 3 || !this.seats[a]) return { error: 'bad-slot' };
      const b = (a + 1) % 4;
      [this.seats[a], this.seats[b]] = [this.seats[b], this.seats[a]];
      [a, b].forEach((i) => { const s = this.seats[i]; if (s && s.conn) s.conn.seat = i; });
      if (this.owner === a) this.owner = b; else if (this.owner === b) this.owner = a;
      // the hold timers are keyed by seat: move them along with their players
      [a, b].forEach((i) => this._clearTimer('hold' + i));
      [a, b].forEach((i) => { const s = this.seats[i]; if (s && s.human && !s.connected) this._setTimer('hold' + i, Math.max(0, s.awaySince + this.holdMs - this.now()), () => this._holdExpired(i)); });
      this._commit();
      return {};
    },
    leave(seat, msg, conn) {
      const s = this.seats[seat];
      conn.seat = -1;
      this._clearTimer('hold' + seat);
      if (!this.gs) {
        this.seats[seat] = null;
      } else {
        s.conn = null; s.connected = false; s.left = true; s.holdExpired = true; s.awaySince = this.now();
        this._log(`${s.name} left the game`);
      }
      this._passOwner();
      // nobody human is left in the room: it closes
      if (!this.seats.some((x) => x && x.human && !x.left)) { this._close(); return {}; }
      this._commit();
      if (this.gs && !this._humansHere()) this._clearTimer('turn');
      return {};
    },

    // ---- game ----
    move(seat, msg) {
      const gs = this.gs;
      if (!gs) return { error: 'phase' };
      // a duplicate, or a move made against an older table, is ignored
      if (msg.game !== gs.gameToken || msg.seq !== gs.moveSeq) return { error: 'stale' };
      const cardId = msg.cardId;
      const ids = Array.isArray(msg.captureCardIds) ? msg.captureCardIds : [];
      if (!Number.isInteger(cardId) || ids.length > 10 || !ids.every(Number.isInteger)) return { error: 'illegal', reason: 'bad-input', mustTake: [] };
      return this._play(seat, cardId, ids);
    },
    // the round-end tally: the next deal goes out once every connected player tapped
    continue(seat) {
      const gs = this.gs;
      if (!gs || gs.phase !== 'round_end') return {};
      this.ready[seat] = true;
      const waiting = this.seats.some((s, i) => s && s.human && s.connected && !this.ready[i]);
      if (!waiting) this._nextRound();
      else this._commit();
      return {};
    },
    rematch(seat) {
      if (!isOwner(this, seat)) return { error: 'not-owner' };
      if (!this.gs || this.gs.phase !== 'finished') return { error: 'phase' };
      this._startGame();
      return {};
    },
    surrender(seat) {
      const gs = this.gs;
      if (!gs || gs.phase !== 'playing') return { error: 'phase' };
      const me = gs.players[seat];
      gs.lastScore = null;
      this._finish(me.team === 0 ? 1 : 0, 'surrender', `Team ${me.team + 1} surrendered`);
      return {};
    },
    // after the 60 s hold: give a gone player's seat to a bot, or end the game
    away(seat, msg) {
      const gs = this.gs;
      const target = msg.seat;
      const s = this.seats[target];
      if (!gs || (gs.phase !== 'playing' && gs.phase !== 'round_end')) return { error: 'phase' };
      if (!s || !s.human || s.connected || !s.holdExpired || target === seat) return { error: 'not-away' };
      if (msg.action === 'bot') {
        if (s.takeover) return {};
        s.takeover = this.opts.bot;
        this._log(`A bot plays for ${s.name}`);
        this._notice(`A bot plays for ${s.name}`);
        this._commit();
        if (gs.currentTurn === target) this._arm(0);
        return {};
      }
      if (msg.action === 'end') {
        const leaver = gs.players[target];
        this._finish(leaver.team === 0 ? 1 : 0, 'forfeit', `${leaver.name} left, Team ${(leaver.team === 0 ? 1 : 0) + 1} wins by forfeit`);
        return {};
      }
      return { error: 'bad-action' };
    },
    // rules and look, owned by the room's owner
    settings(seat, msg) {
      if (!isOwner(this, seat)) return { error: 'not-owner' };
      const gs = this.gs;
      const changes = [];
      if (typeof msg.forceCapture === 'boolean') { this.opts.forceCapture = msg.forceCapture; if (gs) gs.forceCapture = msg.forceCapture; changes.push('Force capture ' + (msg.forceCapture ? 'on' : 'off')); }
      if (typeof msg.captureAssist === 'boolean') { this.opts.captureAssist = msg.captureAssist; if (gs) gs.captureAssist = msg.captureAssist; changes.push('Capture assist ' + (msg.captureAssist ? 'on' : 'off')); }
      if (msg.timer !== undefined && [0, 10, 15, 30, 45, 60].includes(msg.timer)) {
        this.opts.timer = msg.timer;
        if (gs) gs.turnTimerDuration = msg.timer;
        changes.push('Turn timer ' + (msg.timer > 0 ? msg.timer + 's' : 'off'));
      }
      if (msg.look && typeof msg.look === 'object') this.opts.look = normalizeLook({ ...this.opts.look, ...msg.look });
      if (changes.length) this._notice(changes.join(', '), seat);
      // a new timer keeps the turn's start: the clock does not reset for everyone
      if (msg.timer !== undefined && gs && gs.phase === 'playing' && gs.currentTurn >= 0 && !this._isBotSeat(gs.currentTurn) && this._humansHere()) {
        const pid = gs.currentTurn, seq = gs.moveSeq;
        this._clearTimer('turn');
        if (gs.turnTimerDuration > 0) {
          const left = Math.max(3000, this.turnStartedAt + gs.turnTimerDuration * 1000 - this.now());
          this._setTimer('turn', left, () => { if (this.gs === gs && gs.moveSeq === seq && gs.currentTurn === pid) this._autoPlay(pid); });
        }
      }
      this._commit();
      return {};
    },
    emote(seat, msg, conn) {
      const text = EMOTES[msg.key];
      if (!text) return { error: 'bad-emote' };
      const now = this.now();
      if (now - conn.lastEmote < EMOTE_GAP_MS) return { error: 'slow-down' };
      conn.lastEmote = now;
      const name = this.seats[seat].name;
      for (const c of this.conns) if (c.seat >= 0 && c !== conn) this._send(c, { t: 'emote', name, text });
      return { name, text };
    },
  };

  return {
    Room, HANDLERS, normalizeOpts, normalizeLook, newRoomCode, isRoomCode, newToken, createDeck, cardName,
    HOLD_MS, ROUND_END_AUTO_MS, BOT_NAMES, EMOTES, moveAnimMs, dealAnimMs,
  };
});
