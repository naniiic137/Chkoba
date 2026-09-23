// Unit tests for the pure rules module. Run with: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../js/rules.js');

const VALUES = { ace: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, queen: 8, jack: 9, king: 10 };
const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
let nextId = 0;
// card('7', 'hearts') -> { id, suit, name, value }
const card = (name, suit) => ({ id: nextId++, suit, name, display: name, value: VALUES[name] });
const ids = (cards) => cards.map((c) => c.id);

test('findCaptureCombinations lists every subset that adds up', () => {
  const t = [card('3', 'diamonds'), card('4', 'clubs'), card('2', 'hearts'), card('5', 'spades')];
  const combos = R.findCaptureCombinations(t, 7).map((c) => c.map((i) => t[i].value).sort().join('+'));
  assert.deepEqual(combos.sort(), ['2+5', '3+4']);
  assert.deepEqual(R.findCaptureCombinations(t, 1), []);
});

test('a single card of equal value has priority over sums', () => {
  const t = [card('7', 'hearts'), card('3', 'diamonds'), card('4', 'clubs')];
  assert.deepEqual(R.legalCaptures(t, 7), [[0]]);
  // with no equal card, sums are legal
  assert.deepEqual(R.legalCaptures(t.slice(1), 7), [[0, 1]]);
  // two equal cards: either one, never both
  const t2 = [card('5', 'hearts'), card('5', 'clubs'), card('2', 'spades'), card('3', 'hearts')];
  assert.deepEqual(R.legalCaptures(t2, 5), [[0], [1]]);
});

test('checkMove refuses a sum while an equal card is on the table and names it', () => {
  const t = [card('7', 'hearts'), card('3', 'diamonds'), card('4', 'clubs')];
  const hand = [card('7', 'spades'), card('2', 'clubs')];
  const sum = R.checkMove(hand, t, hand[0].id, [t[1].id, t[2].id], true);
  assert.equal(sum.ok, false);
  assert.equal(sum.reason, 'must-take-match');
  assert.deepEqual(sum.mustTake, [t[0].id]);
  // the same refusal with force capture off: the priority is a capture rule, not an option
  assert.equal(R.checkMove(hand, t, hand[0].id, [t[1].id, t[2].id], false).reason, 'must-take-match');
  assert.deepEqual(R.checkMove(hand, t, hand[0].id, [t[0].id], true), { ok: true });
});

test('checkMove validates sums, ownership and duplicates', () => {
  const t = [card('3', 'diamonds'), card('4', 'clubs'), card('ace', 'hearts')];
  const hand = [card('7', 'spades'), card('queen', 'clubs')];
  assert.deepEqual(R.checkMove(hand, t, hand[0].id, ids(t.slice(0, 2)), true), { ok: true });
  assert.equal(R.checkMove(hand, t, hand[0].id, [t[0].id, t[2].id], true).reason, 'bad-sum');
  assert.equal(R.checkMove(hand, t, 999, [], true).reason, 'not-in-hand');
  assert.equal(R.checkMove(hand, t, hand[0].id, [t[0].id, 999], true).reason, 'not-on-table');
  assert.equal(R.checkMove(hand, t, hand[0].id, [t[0].id, t[0].id], true).reason, 'duplicate');
  // queen (8) = 4 + 3 + ace
  assert.deepEqual(R.checkMove(hand, t, hand[1].id, ids(t), true), { ok: true });
});

test('force capture forbids placing while any hand card has an equal card on the table', () => {
  const t = [card('5', 'hearts'), card('king', 'clubs')];
  const hand = [card('2', 'spades'), card('5', 'clubs')];
  const placed = R.checkMove(hand, t, hand[0].id, [], true);
  assert.equal(placed.reason, 'must-capture');
  assert.deepEqual(placed.mustTake, [t[0].id]);
  assert.deepEqual(R.checkMove(hand, t, hand[0].id, [], false), { ok: true });
  // no equal card anywhere: placing is fine even with force capture on
  const h2 = [card('2', 'spades')];
  assert.deepEqual(R.checkMove(h2, t, h2[0].id, [], true), { ok: true });
});

test('the bot never takes a sum when an equal card is on the table', () => {
  const t = [card('7', 'hearts'), card('3', 'diamonds'), card('4', 'diamonds')];
  const hand = [card('7', 'spades')];
  for (const d of ['easy', 'medium', 'hard']) {
    for (const r of [0, 0.5, 0.99]) {
      const mv = R.chooseBotMove(hand, t, d, true, () => r);
      assert.deepEqual(mv, { cardId: hand[0].id, captureCardIds: [t[0].id] }, `${d} rng ${r}`);
    }
  }
});

test('the bot prefers valuable captures and places its lowest safe card on hard', () => {
  const t = [card('7', 'diamonds'), card('2', 'clubs')];
  const hand = [card('7', 'clubs'), card('2', 'hearts'), card('king', 'spades')];
  assert.deepEqual(R.chooseBotMove(hand, t, 'hard', true), { cardId: hand[0].id, captureCardIds: [t[0].id] });
  const t2 = [card('king', 'hearts')];
  const hand2 = [card('6', 'clubs'), card('ace', 'hearts'), card('3', 'spades')];
  assert.deepEqual(R.chooseBotMove(hand2, t2, 'hard', true), { cardId: hand2[1].id, captureCardIds: [] });
});

test('an easy bot that drew a non-capturing card still takes a forced match', () => {
  const t = [card('5', 'hearts')];
  const hand = [card('2', 'spades'), card('5', 'clubs')];
  const mv = R.chooseBotMove(hand, t, 'easy', true, () => 0); // rng picks the 2
  assert.deepEqual(mv, { cardId: hand[1].id, captureCardIds: [t[0].id] });
  const free = R.chooseBotMove(hand, t, 'easy', false, () => 0);
  assert.deepEqual(free, { cardId: hand[0].id, captureCardIds: [] });
});

test('autoPlayMove only makes legal moves', () => {
  const t = [card('7', 'hearts'), card('3', 'diamonds'), card('4', 'clubs')];
  const hand = [card('7', 'spades')];
  const mv = R.autoPlayMove(hand, t, false, () => 0);
  assert.equal(R.checkMove(hand, t, mv.cardId, mv.captureCardIds, false).ok, true);
  assert.deepEqual(mv.captureCardIds, [t[0].id]);
});

test('scoreRound awards karta, dinari, haya, barmila and chkobbas', () => {
  const a = [card('7', 'diamonds'), card('2', 'diamonds'), card('3', 'diamonds'), card('7', 'clubs'), card('ace', 'spades')];
  const b = [card('7', 'hearts'), card('4', 'diamonds'), card('king', 'clubs')];
  const r = R.scoreRound([a, b], [1, 2]);
  assert.equal(r.mostCardsPt, 0);
  assert.equal(r.mostDiamondsPt, 0);
  assert.equal(r.sevenDiamondsPt, 0);
  assert.equal(r.mostSevensPt, 0); // two sevens against one
  assert.deepEqual(r.points, [5, 2]);
  assert.deepEqual(r.counts.cards, [5, 3]);
  assert.deepEqual(r.counts.haya, [1, 0]);
});

test('scoreRound: ties score nothing and a tie on sevens goes to sixes', () => {
  const a = [card('7', 'clubs'), card('6', 'clubs'), card('6', 'hearts')];
  const b = [card('7', 'spades'), card('6', 'spades'), card('7', 'diamonds')];
  let r = R.scoreRound([a, b], [0, 0]);
  assert.equal(r.mostCardsPt, -1);
  assert.equal(r.mostSevensPt, 1); // 2 sevens against 1
  const c = [card('7', 'hearts'), card('6', 'diamonds'), card('6', 'clubs')];
  const d = [card('7', 'spades'), card('6', 'spades'), card('5', 'clubs')];
  r = R.scoreRound([c, d], [0, 0]);
  assert.equal(r.mostSevensPt, 0); // sevens tie, more sixes
  assert.equal(r.mostDiamondsPt, 0);
  assert.equal(r.sevenDiamondsPt, -1);
  const e = [card('7', 'hearts'), card('6', 'clubs')];
  const f = [card('7', 'spades'), card('6', 'spades')];
  assert.equal(R.scoreRound([e, f], [0, 0]).mostSevensPt, -1);
});

test('a round hands out between 1 and 4 points before chkobbas', () => {
  // karta + dinari + haya + barmila; haya always goes to someone
  const deck = [];
  for (const s of SUITS) for (const n of Object.keys(VALUES)) deck.push(card(n, s));
  for (let k = 0; k < 20; k++) {
    const shuffled = deck.slice().sort(() => Math.random() - 0.5);
    const cut = 10 + Math.floor(Math.random() * 20);
    const r = R.scoreRound([shuffled.slice(0, cut), shuffled.slice(cut)], [0, 0]);
    const total = r.points[0] + r.points[1];
    assert.ok(total >= 1 && total <= 4, `total ${total}`);
  }
});

test('dealsPerDeck and matchWinner', () => {
  assert.equal(R.dealsPerDeck(2), 6);
  assert.equal(R.dealsPerDeck(4), 3);
  assert.equal(R.matchWinner([20, 10], 21), -1);
  assert.equal(R.matchWinner([21, 10], 21), 0);
  assert.equal(R.matchWinner([22, 23], 21), 1);
  assert.equal(R.matchWinner([21, 21], 21), -1); // a tie at the line plays on
});
