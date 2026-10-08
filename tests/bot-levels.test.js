// The bot levels: easy and medium are pinned move for move, the hard bot only makes
// legal moves, with or without "bots see all cards". Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const R = require('../public/js/rules.js');

const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const DEFS = [['ace', 1], ['2', 2], ['3', 3], ['4', 4], ['5', 5], ['6', 6], ['7', 7], ['jack', 9], ['queen', 8], ['king', 10]];
function deck() {
  let id = 0;
  const d = [];
  for (const suit of SUITS) for (const [name, value] of DEFS) d.push({ id: id++, suit, name, display: name, value });
  return d;
}
// a small seeded generator (mulberry32): the same seed gives the same positions
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
function shuffled(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
// A random position: a hand of 1-3 cards, a table of 0-8 cards, some captured cards,
// and the game context the room hands a bot.
function position(seed) {
  const rand = rngFrom(seed);
  const d = shuffled(deck(), rand);
  const hand = d.splice(0, 1 + Math.floor(rand() * 3));
  const table = d.splice(0, Math.floor(rand() * 9));
  const n = rand() < 0.5 ? 2 : 4;
  const cap = d.splice(0, Math.floor(rand() * Math.min(d.length - 3 * (n - 1), 20)));
  const captured = [[], []];
  cap.forEach((c, i) => captured[i % 2].push(c));
  const seat = Math.floor(rand() * n);
  const handCounts = Array.from({ length: n }, (_, i) => (i === seat ? hand.length : Math.min(3, hand.length + (rand() < 0.5 ? 0 : 1))));
  const others = handCounts.reduce((s, k, i) => s + (i === seat ? 0 : k), 0);
  const ctx = {
    seat, numPlayers: n, teams: Array.from({ length: n }, (_, i) => i % 2), handCounts,
    deckCount: Math.max(0, d.length - others), captured, dealer: Math.floor(rand() * n),
    lastCaptureTeam: cap.length ? Math.floor(rand() * 2) : -1, chkobbas: [0, 0],
  };
  return { hand, table, force: rand() < 0.7, ctx, rand, rest: d };
}

// easy and medium, before the hard bot was rewritten: one line per position, hashed
const PINNED = {
  count: 600,
  sha256: '26d599a85013ccf35deb74f592816d27bbcf40ae4b9822f5ca0faaad85f4c787',
};

function easyMediumTrace(withCtx) {
  const lines = [];
  for (let s = 1; s <= PINNED.count; s++) {
    for (const level of ['easy', 'medium']) {
      const p = position(s * 7919 + (level === 'easy' ? 1 : 2));
      const mv = withCtx
        ? R.chooseBotMove(p.hand, p.table, level, p.force, p.rand, p.ctx)
        : R.chooseBotMove(p.hand, p.table, level, p.force, p.rand);
      lines.push(`${s} ${level} ${mv.cardId}:${mv.captureCardIds.join(',')}`);
    }
  }
  return lines.join('\n');
}

test('easy and medium make exactly the moves they made before the hard bot changed', () => {
  const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
  assert.equal(hash(easyMediumTrace(false)), PINNED.sha256);
  // the game context the room now passes changes nothing for them
  assert.equal(hash(easyMediumTrace(true)), PINNED.sha256);
});


