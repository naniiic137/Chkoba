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

test('the hard bot only makes legal moves, with and without "bots see all cards", and repeats itself on the same rng', () => {
  for (let s = 1; s <= 150; s++) {
    const p = position(s);
    for (const seeAll of [false, true]) {
      const ctx = { ...p.ctx };
      if (seeAll) {
        // the other hands and the deck, from the cards nobody has seen
        const rest = p.rest.slice();
        ctx.seeAll = { hands: ctx.handCounts.map((k, i) => (i === ctx.seat ? p.hand : rest.splice(0, k))), deck: rest.slice(0, ctx.deckCount) };
      }
      const mv = R.chooseBotMove(p.hand, p.table, 'hard', p.force, rngFrom(s), ctx);
      const verdict = R.checkMove(p.hand, p.table, mv.cardId, mv.captureCardIds, p.force);
      assert.equal(verdict.ok, true, `seed ${s} seeAll ${seeAll}: ${verdict.reason}`);
      assert.deepEqual(R.chooseBotMove(p.hand, p.table, 'hard', p.force, rngFrom(s), ctx), mv);
    }
  }
});

test('the win rate slider: 100% is always the see-all best move, any share stays legal', () => {
  assert.equal(R.winRateToBestShare(100), 1);
  assert.equal(R.winRateToBestShare(0), 0);
  for (let r = 0; r < 100; r += 10) assert.ok(R.winRateToBestShare(r) <= R.winRateToBestShare(r + 10));
  for (let s = 1; s <= 60; s++) {
    const p = position(s);
    const rest = p.rest.slice();
    const seeAll = { hands: p.ctx.handCounts.map((k, i) => (i === p.ctx.seat ? p.hand : rest.splice(0, k))), deck: rest.slice(0, p.ctx.deckCount) };
    const best = R.chooseBotMove(p.hand, p.table, 'hard', p.force, rngFrom(s), { ...p.ctx, seeAll });
    assert.deepEqual(R.chooseBotMove(p.hand, p.table, 'hard', p.force, rngFrom(s), { ...p.ctx, seeAll, bestShare: 1 }), best);
    for (const bestShare of [0, 0.5]) {
      const mv = R.chooseBotMove(p.hand, p.table, 'hard', p.force, rngFrom(s), { ...p.ctx, seeAll, bestShare });
      assert.equal(R.checkMove(p.hand, p.table, mv.cardId, mv.captureCardIds, p.force).ok, true);
    }
  }
});

test('the deal control keeps the 40 cards and the hand sizes; Good seats share the strong cards by seat order', () => {
  const { stackDeal } = require('../public/js/room.js');
  for (let s = 1; s <= 40; s++) {
    const rand = rngFrom(s);
    const d = shuffled(deck(), rand);
    // 2v2, first deal: seats 0 and 2 Good, seat 1 Bad, seat 3 normal
    stackDeal(d, [], 4, ['good', 'bad', 'good', null], true);
    assert.equal(d.length, 40);
    assert.equal(new Set(d.map((c) => c.id)).size, 40);
    const table = [d.pop(), d.pop(), d.pop(), d.pop()];
    const hands = [0, 1, 2, 3].map(() => [d.pop(), d.pop(), d.pop()]);
    const strong = (c) => c.name === '7' || c.suit === 'diamonds';
    assert.ok(hands[0].concat(hands[2]).some((c) => c.suit === 'diamonds' && c.name === '7'), 'a Good seat has the 7 of diamonds');
    assert.ok(hands[0].filter(strong).length >= 2 && hands[2].filter(strong).length >= 2, 'both Good seats get strong cards');
    assert.ok(hands[1].every((c) => !strong(c) && c.name !== '6' && R.legalCaptures(table, c.value).length === 0), 'the Bad seat takes nothing');
  }
  // nobody set: the deck is left as shuffled
  const d = shuffled(deck(), rngFrom(9));
  const before = d.map((c) => c.id).join();
  stackDeal(d, [], 2, [null, 'normal'], true);
  assert.equal(d.map((c) => c.id).join(), before);
});

test('the hard bot does not leave a table the next player can sweep, and takes the 7 of diamonds', () => {
  const c = (id, name, suit, value) => ({ id, name, suit, display: name, value });
  // nothing to take: the 5 would leave 2+5 = 7 for the opponent's chkobba, the king leaves 12
  const table = [c(1, '2', 'clubs', 2)];
  const hand = [c(10, '5', 'hearts', 5), c(11, 'king', 'spades', 10)];
  const ctx = { seat: 0, numPlayers: 2, teams: [0, 1], handCounts: [2, 2], deckCount: 12, captured: [[], []], dealer: 1, lastCaptureTeam: -1, chkobbas: [0, 0] };
  assert.deepEqual(R.chooseBotMove(hand, table, 'hard', true, rngFrom(1), ctx), { cardId: 11, captureCardIds: [] });
  // the same in 2v2 late in a deck: the four 7s are among the 12 cards still out, the
  // other 25 are in the piles (counted by the bot)
  const out = (x) => x.name === '7' || (x.value <= 4 && (x.suit === 'hearts' || x.suit === 'clubs')) || (x.name === '3' && x.suit === 'spades');
  const piles = deck().filter((x) => !out(x) && !(x.name === '2' && x.suit === 'clubs') && !(x.name === '5' && x.suit === 'hearts') && !(x.name === 'king' && x.suit === 'spades'));
  assert.equal(piles.length, 25);
  const ctx4 = { ...ctx, numPlayers: 4, teams: [0, 1, 0, 1], handCounts: [2, 2, 2, 2], deckCount: 6, captured: [piles.filter((x, i) => i % 2 === 0), piles.filter((x, i) => i % 2 === 1)], lastCaptureTeam: 0 };
  for (let s = 1; s <= 5; s++) assert.deepEqual(R.chooseBotMove(hand, table, 'hard', true, rngFrom(s), ctx4), { cardId: 11, captureCardIds: [] });
  const t2 = [c(2, '7', 'diamonds', 7), c(3, '2', 'clubs', 2)];
  const h2 = [c(12, '7', 'clubs', 7), c(13, '2', 'hearts', 2), c(14, 'king', 'spades', 10)];
  assert.deepEqual(R.chooseBotMove(h2, t2, 'hard', true, rngFrom(2), ctx).cardId, 12);
});


