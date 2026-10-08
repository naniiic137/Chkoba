// Bot strength: whole matches between bot levels, played with the room's own rules.
// Not part of npm test (it takes minutes). Run with:
//   node tests/bot-strength.js                 # every matchup, 200 matches each
//   node tests/bot-strength.js 100 hard-old    # 100 matches of one matchup
// Matchups: hard-old (new hard vs old hard, 1v1), team-old (the same as 2v2 teams),
// seeall-hard (hard that sees all cards vs normal hard, 1v1).
// Every deck order comes from a seeded generator and every seed is played twice with
// the sides swapped, so both sides get the same cards. Moves are checked with
// rules.checkMove, and the game flow follows public/js/room.js (deal order, turn
// order, the dealer's last card, the last taker gets the table, instant diamond win).
'use strict';
const R = require('../public/js/rules.js');

// ---- the hard bot as it was before this change (public/js/rules.js, chooseBotMove) ----
const DIAMONDS = 'diamonds';
function oldChooseBotMove(hand, tableCards, difficulty, forceCapture, rng) {
  const rand = rng || Math.random;
  const ids = (combo) => combo.map((i) => tableCards[i].id);
  let bestMove = null;
  let bestScore = -1;

  if (difficulty === 'easy') {
    const card = hand[Math.floor(rand() * hand.length)];
    const captures = R.legalCaptures(tableCards, card.value);
    if (captures.length > 0) {
      bestMove = { cardId: card.id, captureCardIds: ids(captures[Math.floor(rand() * captures.length)]) };
      bestScore = 1;
    } else {
      bestMove = { cardId: card.id, captureCardIds: [] };
    }
  } else {
    for (const card of hand) {
      for (const combo of R.legalCaptures(tableCards, card.value)) {
        const capturedCards = combo.map((i) => tableCards[i]);
        let score = combo.length;
        if (capturedCards.some((c) => c.suit === DIAMONDS)) score += 3;
        if (capturedCards.some((c) => c.suit === DIAMONDS && c.name === '7')) score += 5;
        if (combo.length === tableCards.length) score += 10;
        if (difficulty === 'hard') {
          if (capturedCards.some((c) => c.name === '7')) score += 4;
          if (capturedCards.length === 1 && capturedCards[0].value === card.value) score += 2;
        }
        if (score > bestScore) { bestScore = score; bestMove = { cardId: card.id, captureCardIds: ids(combo) }; }
      }
    }
    if (!bestMove) {
      const safe = hand.filter((c) => !R.legalCaptures(tableCards, c.value).length);
      if (difficulty === 'hard' && safe.length > 0) {
        const low = safe.slice().sort((a, b) => a.value - b.value);
        bestMove = { cardId: low[0].id, captureCardIds: [] };
      } else {
        const card = safe.length > 0 ? safe[0] : hand[0];
        bestMove = { cardId: card.id, captureCardIds: [] };
      }
    }
  }

  if (forceCapture && bestScore < 0 && R.hasDirectMatch(hand, tableCards)) {
    for (const c of hand) {
      const m = R.matchingIndices(tableCards, c.value);
      if (m.length) { bestMove = { cardId: c.id, captureCardIds: [tableCards[m[0]].id] }; break; }
    }
  }
  return bestMove;
}

// ---- seeded randomness ----
function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const DEFS = [['ace', 'A', 1], ['2', '2', 2], ['3', '3', 3], ['4', '4', 4], ['5', '5', 5], ['6', '6', 6], ['7', '7', 7], ['jack', 'J', 9], ['queen', 'Q', 8], ['king', 'K', 10]];
function shuffledDeck(rand) {
  let id = 0;
  const d = [];
  for (const suit of SUITS) for (const [name, display, value] of DEFS) d.push({ id: id++, suit, name, display, value });
  for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}

// ---- the players ----
const timing = { hard: [], seeall: [] };
function timed(kind, f) {
  const t0 = process.hrtime.bigint();
  const mv = f();
  timing[kind].push(Number(process.hrtime.bigint() - t0) / 1e6);
  return mv;
}
const PLAYERS = {
  hard: (g, p, rand) => timed('hard', () => R.chooseBotMove(g.hands[p], g.table, 'hard', g.force, rand, ctxFor(g, p, false))),
  seeall: (g, p, rand) => timed('seeall', () => R.chooseBotMove(g.hands[p], g.table, 'hard', g.force, rand, ctxFor(g, p, true))),
  oldhard: (g, p, rand) => oldChooseBotMove(g.hands[p], g.table, 'hard', g.force, rand),
};
// what the room hands a bot (public/js/room.js, _botCtx)
function ctxFor(g, p, seeAll) {
  return {
    seat: p, numPlayers: g.n, teams: g.teams, handCounts: g.hands.map((h) => h.length), deckCount: g.deck.length,
    captured: g.captured, dealer: g.dealer, lastCaptureTeam: g.lastCap, chkobbas: g.chk,
    seeAll: seeAll ? { hands: g.hands, deck: g.deck } : undefined,
  };
}

// ---- one match, as public/js/room.js plays it ----
function playMatch(n, seats, seed, winScore) {
  const deckRand = rngFrom(seed * 2 + 1), botRand = rngFrom(seed * 2 + 2);
  const teams = Array.from({ length: n }, (_, i) => i % 2);
  const scores = [0, 0];
  let dealer = 0;
  for (let deckNo = 0; deckNo < 50; deckNo++) {
    const g = { n, teams, force: true, deck: shuffledDeck(deckRand), table: [], hands: [], captured: [[], []], chk: [0, 0], lastCap: -1, dealer };
    for (let i = 0; i < 4; i++) g.table.push(g.deck.pop());
    let turn = (dealer + 1) % n;
    for (;;) {
      for (let i = 0; i < n; i++) { g.hands[i] = []; for (let j = 0; j < 3 && g.deck.length > 0; j++) g.hands[i].push(g.deck.pop()); }
      let last = -1;
      while (g.hands.some((h) => h.length)) {
        const p = turn, hand = g.hands[p];
        const mv = PLAYERS[seats[p]](g, p, botRand);
        const verdict = R.checkMove(hand, g.table, mv.cardId, mv.captureCardIds, g.force);
        if (!verdict.ok) throw new Error(`${seats[p]} made an illegal move: ${verdict.reason}`);
        const card = hand.splice(hand.findIndex((c) => c.id === mv.cardId), 1)[0];
        const team = teams[p];
        if (mv.captureCardIds.length) {
          const taken = g.table.filter((c) => mv.captureCardIds.includes(c.id));
          g.table = g.table.filter((c) => !mv.captureCardIds.includes(c.id));
          g.captured[team].push(...taken, card);
          g.lastCap = team;
          if (g.table.length === 0 && !(p === dealer && hand.length === 0 && g.deck.length === 0)) g.chk[team]++;
          if (g.captured[team].filter((c) => c.suit === 'diamonds').length >= 10) return { winner: team, instant: true };
        } else {
          g.table.push(card);
        }
        last = p;
        turn = (p + 1) % n;
      }
      if (g.deck.length === 0) break;
      turn = (last + 1) % n;
    }
    if (g.table.length && g.lastCap >= 0) g.captured[g.lastCap].push(...g.table);
    const r = R.scoreRound(g.captured, g.chk);
    scores[0] += r.points[0]; scores[1] += r.points[1];
    const w = R.matchWinner(scores, winScore);
    if (w >= 0) return { winner: w, scores };
    dealer = (dealer + 1) % n;
  }
  return { winner: -1, scores };
}

const MATCHUPS = {
  'hard-old': { n: 2, a: 'hard', b: 'oldhard', title: 'new hard vs old hard, 1v1' },
  'team-old': { n: 4, a: 'hard', b: 'oldhard', title: 'new hard team vs old hard team, 2v2' },
  'seeall-hard': { n: 2, a: 'seeall', b: 'hard', title: 'see-all hard vs normal hard, 1v1' },
};

function run(name, matches, winScore) {
  const m = MATCHUPS[name];
  let winsA = 0, played = 0, instant = 0;
  const t0 = Date.now();
  for (let s = 0; played < matches; s++) {
    for (const swap of [false, true]) {
      if (played >= matches) break;
      // side A sits on team 0 (seats 0 and 2), or on team 1 after the swap
      const seats = Array.from({ length: m.n }, (_, i) => ((i % 2 === 0) !== swap ? m.a : m.b));
      const res = playMatch(m.n, seats, 1000 + s, winScore);
      const teamA = swap ? 1 : 0;
      if (res.winner === teamA) winsA++;
      if (res.instant) instant++;
      played++;
    }
  }
  const p = winsA / played;
  const ci = 1.96 * Math.sqrt(p * (1 - p) / played);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`${m.title.padEnd(44)} ${String(winsA).padStart(5)} / ${played} won  ${(100 * p).toFixed(1)}% ± ${(100 * ci).toFixed(1)}%  (instant diamond wins ${instant}, ${secs}s)`);
  return { name, winsA, played, p, ci };
}

function timingLine(kind) {
  const t = timing[kind].slice().sort((a, b) => a - b);
  if (!t.length) return;
  const at = (q) => t[Math.min(t.length - 1, Math.floor(q * t.length))].toFixed(2);
  const mean = (t.reduce((s, x) => s + x, 0) / t.length).toFixed(2);
  console.log(`  ${kind === 'hard' ? 'hard' : 'see-all hard'} move time on this machine: mean ${mean} ms, median ${at(0.5)}, p99 ${at(0.99)}, max ${t[t.length - 1].toFixed(2)} ms over ${t.length} moves`);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const matches = parseInt(args[0], 10) || 200;
  const names = args.slice(1).filter((a) => MATCHUPS[a]);
  const winScore = 21;
  console.log(`Matches to ${winScore} points, force capture on, ${matches} matches per matchup (each deck order played from both sides)`);
  for (const name of names.length ? names : Object.keys(MATCHUPS)) run(name, matches, winScore);
  timingLine('hard');
  timingLine('seeall');
}

module.exports = { oldChooseBotMove, playMatch, ctxFor };
