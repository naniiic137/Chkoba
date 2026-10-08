/* Pure game rules: capture legality, the bot's move choice and round scoring.
 * No DOM, no network, no app state: every function takes plain card objects
 * ({ id, suit, name, value }) and returns plain data, so the same code runs in the
 * browser (window.ChkobaRules) and under node:test (require('./js/rules.js')). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChkobaRules = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DIAMONDS = 'diamonds';

  // Every subset of the table whose values add up to targetValue, as index arrays.
  // DFS with sum-pruning instead of a 2^n subset scan. Every card value is >= 1, so the
  // recursion depth is bounded by targetValue (<= 10); the result count is capped because
  // callers only need existence + a few examples, never the full enumeration.
  function findCaptureCombinations(tableCards, targetValue) {
    const results = [];
    const n = tableCards.length;
    const CAP = 256;
    const dfs = (start, sum, indices) => {
      if (results.length >= CAP) return;
      if (sum === targetValue) { results.push(indices.slice()); return; }
      if (sum > targetValue) return;
      for (let i = start; i < n; i++) {
        if (sum + tableCards[i].value > targetValue) continue;
        indices.push(i);
        dfs(i + 1, sum + tableCards[i].value, indices);
        indices.pop();
      }
    };
    dfs(0, 0, []);
    return results;
  }

  // Indices of the table cards with exactly this value.
  function matchingIndices(tableCards, value) {
    const out = [];
    tableCards.forEach((c, i) => { if (c.value === value) out.push(i); });
    return out;
  }

  // The captures a card of this value may legally make. Tunisian rule: a single card of
  // equal value has priority over sums, so while one is on the table the only legal
  // captures are those single cards.
  function legalCaptures(tableCards, value) {
    const matches = matchingIndices(tableCards, value);
    if (matches.length) return matches.map((i) => [i]);
    return findCaptureCombinations(tableCards, value);
  }

  function hasDirectMatch(hand, tableCards) {
    return hand.some((c) => tableCards.some((tc) => tc.value === c.value));
  }

  // Validates one move. Returns { ok: true } or { ok: false, reason, mustTake } where
  // mustTake lists the table card ids the player is required to take (for highlighting).
  //   reasons: not-in-hand, not-on-table, duplicate, bad-sum, must-take-match, must-capture
  function checkMove(hand, tableCards, cardId, captureIds, forceCapture) {
    const card = hand.find((c) => c.id === cardId);
    if (!card) return { ok: false, reason: 'not-in-hand', mustTake: [] };
    const ids = captureIds || [];
    const matchIds = (value) => tableCards.filter((c) => c.value === value).map((c) => c.id);

    if (ids.length > 0) {
      if (new Set(ids).size !== ids.length) return { ok: false, reason: 'duplicate', mustTake: [] };
      const taken = ids.map((id) => tableCards.find((c) => c.id === id));
      if (taken.some((c) => !c)) return { ok: false, reason: 'not-on-table', mustTake: [] };
      const sum = taken.reduce((s, c) => s + c.value, 0);
      if (sum !== card.value) return { ok: false, reason: 'bad-sum', mustTake: [] };
      const must = matchIds(card.value);
      if (must.length && !(taken.length === 1 && taken[0].value === card.value)) {
        return { ok: false, reason: 'must-take-match', mustTake: must };
      }
      return { ok: true };
    }

    // placing a card: with force capture on, a direct match anywhere in the hand forbids it
    if (forceCapture && tableCards.length > 0 && hasDirectMatch(hand, tableCards)) {
      let must = matchIds(card.value);
      if (!must.length) {
        for (const c of hand) { must = matchIds(c.value); if (must.length) break; }
      }
      return { ok: false, reason: 'must-capture', mustTake: must };
    }
    return { ok: true };
  }

  // The bot's move. rng() in [0,1) is injectable so tests are deterministic.
  // ctx is optional and only read by the hard bot: what a fair player at the table knows
  // (see hardBotMove). easy and medium play exactly as before and ignore it.
  function chooseBotMove(hand, tableCards, difficulty, forceCapture, rng, ctx) {
    const rand = rng || Math.random;
    if (difficulty === 'hard') return hardBotMove(hand, tableCards, forceCapture, rand, ctx);
    const ids = (combo) => combo.map((i) => tableCards[i].id);
    let bestMove = null;
    let bestScore = -1;

    if (difficulty === 'easy') {
      const card = hand[Math.floor(rand() * hand.length)];
      const captures = legalCaptures(tableCards, card.value);
      if (captures.length > 0) {
        bestMove = { cardId: card.id, captureCardIds: ids(captures[Math.floor(rand() * captures.length)]) };
        bestScore = 1;
      } else {
        bestMove = { cardId: card.id, captureCardIds: [] };
      }
    } else {
      for (const card of hand) {
        for (const combo of legalCaptures(tableCards, card.value)) {
          const capturedCards = combo.map((i) => tableCards[i]);
          let score = combo.length;
          if (capturedCards.some((c) => c.suit === DIAMONDS)) score += 3;
          if (capturedCards.some((c) => c.suit === DIAMONDS && c.name === '7')) score += 5;
          if (combo.length === tableCards.length) score += 10;
          if (score > bestScore) { bestScore = score; bestMove = { cardId: card.id, captureCardIds: ids(combo) }; }
        }
      }
      if (!bestMove) {
        const safe = hand.filter((c) => !legalCaptures(tableCards, c.value).length);
        const card = safe.length > 0 ? safe[0] : hand[0];
        bestMove = { cardId: card.id, captureCardIds: [] };
      }
    }

    // an easy bot that drew a card with no take must still take a direct match when forced
    if (forceCapture && bestScore < 0 && hasDirectMatch(hand, tableCards)) {
      for (const c of hand) {
        const m = matchingIndices(tableCards, c.value);
        if (m.length) { bestMove = { cardId: c.id, captureCardIds: [tableCards[m[0]].id] }; break; }
      }
    }
    return bestMove;
  }

  // ================= THE HARD BOT =================
  // Card counting plus search, on what a fair player knows. ctx:
  //   { seat, numPlayers, teams: [team per seat], handCounts: [cards per seat], deckCount,
  //     captured: [cards[], cards[]] (both teams' piles: every take was played face up),
  //     dealer, lastCaptureTeam, chkobbas: [n, n],
  //     seeAll: { hands, deck } only with the debug switch "Bots see all cards" }
  // Every card that is not in the bot's hand, on the table or in a pile is unseen. The bot
  // deals the unseen cards at random to the other hands (as many as each one holds) and
  // the deck, many times over, and in each of those worlds searches the rest of the deal
  // with alpha-beta: its own team (partner included) maximises, the other team minimises.
  // A move's worth is its average over the worlds, so the unseen cards weigh in by how
  // likely they are. Positions are valued in expected round points, counted the way
  // scoreRound counts them (chkobbas, karta, dinari, haya, barmila), plus what the next
  // player can take from the table, a chkobba above all. With seeAll there is one world,
  // the real one: the real hands and the deck in its real order, searched deeper and
  // across deals. Work is bounded by node counts, not by the clock, so the same position
  // and the same rng always give the same move (in the page, the Worker and node).
  const SUIT_LIST = ['hearts', 'diamonds', 'clubs', 'spades'];
  const NAME_VALUES = [['ace', 1], ['2', 2], ['3', 3], ['4', 4], ['5', 5], ['6', 6], ['7', 7], ['jack', 9], ['queen', 8], ['king', 10]];
  const FULL_DECK = [];
  SUIT_LIST.forEach((suit) => NAME_VALUES.forEach(([name, value]) => FULL_DECK.push({ id: -1 - FULL_DECK.length, suit, name, display: name, value })));
  const cardKey = (c) => c.suit + ':' + c.name;
  const isHaya = (c) => c.suit === DIAMONDS && c.name === '7';
  // cards of one value are interchangeable unless one is a diamond (the 7 of diamonds is the only diamond 7)
  const cardType = (c) => c.value * 2 + (c.suit === DIAMONDS ? 1 : 0);

  const HARD = {
    samples2: 16, samples4: 12,       // worlds per move
    depth2: 6, depth4: 6,             // plies searched in each world (2 players: the whole deal)
    seeAllDepth: 12,                  // the see-all search deepens up to this many plies
    nodeBudget: 6000,                 // per move, over all worlds: the search stops deepening past it
    foe: 0.9, friend: 0.5,            // how much of the next player's best take counts at a leaf
  };
  const INSTANT = 25;                 // all ten diamonds: the match is won on the spot

  // ---- the value of a position, in team 0's round points minus team 1's ----
  function normCdf(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const p = 0.3989422804014327 * Math.exp(-z * z / 2) * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return z > 0 ? 1 - p : p;
  }
  // "most of": a has, b has, r still to be won; P(team 0 ends ahead) - P(team 1 ends ahead).
  // The r cards split about evenly; spread is the spread of the final gap per sqrt(card).
  function majority(a, b, r, spread) {
    if (r <= 0) return a > b ? 1 : a < b ? -1 : 0;
    const mu = a - b, sigma = spread * Math.sqrt(r), th = (a + b + r) % 2 === 0 ? 1 : 0;
    return 1 - normCdf((th - mu) / sigma) - normCdf((-th - mu) / sigma);
  }
  function binom(n, k) { let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return r; }
  // most sevens, a tie goes to most sixes: each card still out goes either way at even odds
  function barmila(s0, s1, x0, x1) {
    const rs = Math.max(0, 4 - s0 - s1), rx = Math.max(0, 4 - x0 - x1);
    let v = 0;
    for (let i = 0; i <= rs; i++) {
      const pi = binom(rs, i) / Math.pow(2, rs), a = s0 + i, b = s1 + rs - i;
      if (a !== b) { v += pi * (a > b ? 1 : -1); continue; }
      for (let j = 0; j <= rx; j++) {
        const c = x0 + j, d = x1 + rx - j;
        if (c !== d) v += pi * binom(rx, j) / Math.pow(2, rx) * (c > d ? 1 : -1);
      }
    }
    return v;
  }
  const KARTA = new Float64Array(41 * 41), DINARI = new Float64Array(11 * 11), BARMILA = new Float64Array(625);
  for (let a = 0; a <= 40; a++) for (let b = 0; b <= 40; b++) KARTA[a * 41 + b] = majority(a, b, Math.max(0, 40 - a - b), 1.7);
  for (let a = 0; a <= 10; a++) for (let b = 0; b <= 10; b++) DINARI[a * 11 + b] = majority(a, b, Math.max(0, 10 - a - b), 1.1);
  for (let i = 0; i < 625; i++) BARMILA[i] = barmila(Math.floor(i / 125), Math.floor(i / 25) % 5, Math.floor(i / 5) % 5, i % 5);
  const cl = (v, m) => (v > m ? m : v);

  // k: [cards0, cards1, diamonds0, diamonds1, sevens0, sevens1, sixes0, sixes1];
  // haya: the team holding the 7 of diamonds or -1; chk: chkobbas of team 0 minus team 1
  function evalCounts(k, haya, chk) {
    if (k[2] >= 10) return INSTANT;
    if (k[3] >= 10) return -INSTANT;
    return chk + KARTA[cl(k[0], 40) * 41 + cl(k[1], 40)] + DINARI[cl(k[2], 10) * 11 + cl(k[3], 10)]
      + BARMILA[((cl(k[4], 4) * 5 + cl(k[5], 4)) * 5 + cl(k[6], 4)) * 5 + cl(k[7], 4)]
      + (haya === 0 ? 1 : haya === 1 ? -1 : 0);
  }
  function addCard(k, team, c) {
    k[team]++;
    if (c.suit === DIAMONDS) k[2 + team]++;
    if (c.name === '7') k[4 + team]++;
    else if (c.name === '6') k[6 + team]++;
  }

  // ---- moves ----
  // Every legal move of a hand, equal ones once, likely-best first (for the pruning).
  function hardMoves(hand, table, force) {
    const out = [];
    const canPlace = !(force && table.length > 0 && hasDirectMatch(hand, table));
    let seenCards = 0;                  // a bit per card type
    for (let ci = 0; ci < hand.length; ci++) {
      const c = hand[ci], bit = 1 << cardType(c);
      if (seenCards & bit) continue;
      seenCards |= bit;
      const caps = legalCaptures(table, c.value);
      const seenCombo = caps.length > 1 ? [] : null;
      for (const combo of caps) {
        let ord = combo.length * 2 + (combo.length === table.length ? 50 : 0);
        if (seenCombo) {
          const key = combo.map((i) => cardType(table[i])).sort((x, y) => x - y).join(',');
          if (seenCombo.includes(key)) continue;
          seenCombo.push(key);
        }
        for (const i of combo) { const t = table[i]; if (t.suit === DIAMONDS) ord += 1; if (t.name === '7') ord += 1; if (isHaya(t)) ord += 5; }
        out.push({ ci, combo, ord });
      }
      if (canPlace) out.push({ ci, combo: null, ord: -c.value / 10 });
    }
    out.sort((a, b) => b.ord - a.ord);
    return out;
  }

  // One move in a search world. S is never changed; the child is a new state.
  //   S: { hands, table, k, haya, chk, last, turn, deck (known order or null), deckCount,
  //        over, value, dealEnd }
  function hardPlay(G, S, p, ci, combo) {
    const hand = S.hands[p], card = hand[ci];
    const hands = S.hands.slice();
    const nh = hand.slice(); nh.splice(ci, 1); hands[p] = nh;
    const C = { hands, table: null, k: S.k, haya: S.haya, chk: S.chk, last: S.last, turn: -1, deck: S.deck, deckCount: S.deckCount, over: false, value: 0, dealEnd: false };
    if (combo) {
      const team = G.teams[p], k = S.k.slice(), table = [];
      for (let i = 0; i < S.table.length; i++) {
        const t = S.table[i];
        if (combo.includes(i)) { addCard(k, team, t); if (isHaya(t)) C.haya = team; } else table.push(t);
      }
      addCard(k, team, card);
      if (isHaya(card)) C.haya = team;
      C.k = k; C.table = table; C.last = team;
      if (table.length === 0 && !(p === G.dealer && nh.length === 0 && S.deckCount === 0)) C.chk += team === 0 ? 1 : -1;
      if (k[2 + team] >= 10) { C.over = true; C.value = evalCounts(k, C.haya, C.chk); return C; }
    } else {
      C.table = S.table.slice();
      C.table.push(card);
    }
    const n = hands.length;
    let left = 0;
    for (let i = 0; i < n; i++) left += hands[i].length;
    if (left === 0) {
      if (S.deckCount > 0) {
        C.turn = (p + 1) % n;
        if (S.deck) {                     // the real deck (see-all): deal it as the room does
          const deck = S.deck.slice();
          for (let i = 0; i < n; i++) { const h = []; for (let x = 0; x < 3 && deck.length > 0; x++) h.push(deck.pop()); hands[i] = h; }
          C.deck = deck; C.deckCount = deck.length;
        } else {
          C.dealEnd = true;               // the next hands are unknown: the search stops here
        }
      } else {                            // the deck is done: the table goes to the last taker
        let k = C.k;
        if (C.last >= 0 && C.table.length) {
          k = k.slice();
          for (const t of C.table) { addCard(k, C.last, t); if (isHaya(t)) C.haya = C.last; }
        }
        C.over = true; C.value = evalCounts(k, C.haya, C.chk);
      }
      return C;
    }
    let next = (p + 1) % n, tries = 0;
    while (hands[next].length === 0 && tries < n) { next = (next + 1) % n; tries++; }
    C.turn = next;
    return C;
  }

  // What player p's team gains (in its own round points) by taking combo with card.
  function takeGain(G, S, p, card, combo, base, handLeft, deckLeft) {
    const team = G.teams[p], k = G.scratch;
    for (let i = 0; i < 8; i++) k[i] = S.k[i];
    let haya = S.haya, chk = S.chk;
    for (const i of combo) { const t = S.table[i]; addCard(k, team, t); if (isHaya(t)) haya = team; }
    addCard(k, team, card);
    if (isHaya(card)) haya = team;
    if (combo.length === S.table.length && !(p === G.dealer && handLeft === 0 && deckLeft === 0)) chk += team === 0 ? 1 : -1;
    return (team === 0 ? 1 : -1) * (evalCounts(k, haya, chk) - base);
  }

  // The best take of player p, whose hand is known (it may be better to take nothing).
  function handThreat(G, S, p, base) {
    const hand = S.hands[p];
    const canPlace = !(G.force && hasDirectMatch(hand, S.table));
    let best = canPlace ? 0 : -Infinity;
    for (const c of hand) {
      for (const combo of legalCaptures(S.table, c.value)) {
        const g = takeGain(G, S, p, c, combo, base, hand.length - 1, S.deckCount);
        if (g > best) best = g;
      }
    }
    return best === -Infinity ? 0 : best;
  }

  // The expected best take of player p, who is about to be dealt h cards from the pool
  // (the unseen cards of this world): the best card of a random hand of h.
  function poolThreat(G, S, p, base) {
    const types = G.poolTypes, D = G.pool.length, h = Math.min(3, D);
    if (!D) return 0;
    // the same table and piles are often reached by different move orders: once per world
    let key = p + '|' + S.chk + '|' + S.haya + '|' + S.k.join(',') + '|';
    for (const t of S.table) key += t.id + ',';
    const memo = G.memo.get(key);
    if (memo !== undefined) return memo;
    const gains = [];
    let combos = null, comboValue = 0;
    for (const t of types) {          // sorted by value: the takes are found once per value
      if (t.card.value !== comboValue) { comboValue = t.card.value; combos = legalCaptures(S.table, comboValue); }
      let g = 0;
      for (const combo of combos) {
        const x = takeGain(G, S, p, t.card, combo, base, h - 1, S.deckCount - D);
        if (x > g) g = x;
      }
      if (g > 0) gains.push({ g, count: t.count });
    }
    gains.sort((a, b) => b.g - a.g);
    // E[best take of a random hand of h]: the best type in hand is the i-th one when the
    // hand has none of the better ones but not none of the i-th too; P(none of c cards) = C(D-c, h)/C(D, h)
    const all = binom(D, h);
    let e = 0, c = 0, noneBefore = 1;
    for (const x of gains) {
      c += x.count;
      const none = binom(D - c, h) / all;
      e += x.g * (noneBefore - none);
      noneBefore = none;
    }
    G.memo.set(key, e);
    return e;
  }

  // A leaf: the counts, and what the next player can take from this table.
  function hardLeaf(G, S) {
    const base = evalCounts(S.k, S.haya, S.chk);
    let v = base;
    const p = S.turn;
    if (p >= 0 && S.table.length) {
      const team = G.teams[p];
      const threat = S.dealEnd ? poolThreat(G, S, p, base) : S.hands[p].length ? handThreat(G, S, p, base) : 0;
      v += (team === 0 ? 1 : -1) * threat * (team === G.myTeam ? HARD.friend : HARD.foe);
    }
    return G.sign * v;
  }

  // Alpha-beta over one world; the value is the bot's team's.
  function hardSearch(G, S, depth, alpha, beta) {
    G.nodes++;
    if (S.over) return G.sign * S.value;
    if (S.dealEnd || depth <= 0 || G.nodes > G.budget) return hardLeaf(G, S);
    const p = S.turn;
    const moves = hardMoves(S.hands[p], S.table, G.force);
    const max = G.teams[p] === G.myTeam;
    let best = max ? -Infinity : Infinity;
    for (const m of moves) {
      const v = hardSearch(G, hardPlay(G, S, p, m.ci, m.combo), depth - 1, alpha, beta);
      if (max) { if (v > best) best = v; if (best > alpha) alpha = best; } else { if (v < best) best = v; if (best < beta) beta = best; }
      if (alpha >= beta) break;
    }
    return best;
  }

  function hardBotMove(hand, tableCards, forceCapture, rand, ctx) {
    const c = ctx || {};
    const n = c.numPlayers === 4 ? 4 : 2;
    const me = Number.isInteger(c.seat) ? c.seat : 0;
    const teams = Array.isArray(c.teams) && c.teams.length === n ? c.teams.map((t) => (t === 1 ? 1 : 0)) : Array.from({ length: n }, (_, i) => i % 2);
    const captured = Array.isArray(c.captured) ? c.captured : [[], []];
    const toMove = (m) => ({ cardId: hand[m.ci].id, captureCardIds: m.combo ? m.combo.map((i) => tableCards[i].id) : [] });
    const moves = hardMoves(hand, tableCards, forceCapture);
    if (moves.length === 1) return toMove(moves[0]);

    const k = [0, 0, 0, 0, 0, 0, 0, 0];
    let haya = -1;
    for (let t = 0; t < 2; t++) for (const x of captured[t] || []) { addCard(k, t, x); if (isHaya(x)) haya = t; }
    const chk = Array.isArray(c.chkobbas) ? (c.chkobbas[0] || 0) - (c.chkobbas[1] || 0) : 0;
    const G = {
      teams, myTeam: teams[me], sign: teams[me] === 0 ? 1 : -1, force: !!forceCapture,
      dealer: Number.isInteger(c.dealer) ? c.dealer : (me + n - 1) % n, pool: [], poolTypes: [], memo: new Map(), scratch: [0, 0, 0, 0, 0, 0, 0, 0],
      nodes: 0, budget: HARD.nodeBudget,
    };
    const last = Number.isInteger(c.lastCaptureTeam) ? c.lastCaptureTeam : -1;
    const root = (hands, deck, deckCount) => ({ hands, table: tableCards, k, haya, chk, last, turn: me, deck, deckCount, over: false, value: 0, dealEnd: false });

    // "Bots see all cards": the real hands and the real deck, one world, searched deeper
    if (c.seeAll && Array.isArray(c.seeAll.hands) && Array.isArray(c.seeAll.deck)) {
      const hands = Array.from({ length: n }, (_, i) => (i === me ? hand : (c.seeAll.hands[i] || []).slice()));
      const S0 = root(hands, c.seeAll.deck.slice(), c.seeAll.deck.length);
      let best = moves[0];
      for (let depth = 2; depth <= HARD.seeAllDepth; depth += 2) {
        G.nodes = 0;
        G.budget = HARD.nodeBudget * 4;
        let bestHere = null, alpha = -Infinity;
        for (const m of moves) {
          const v = hardSearch(G, hardPlay(G, S0, me, m.ci, m.combo), depth - 1, alpha, Infinity);
          if (bestHere === null || v > alpha) { alpha = v; bestHere = m; }
        }
        if (G.nodes > G.budget) break;    // this depth did not finish: keep the last one that did
        best = bestHere;
      }
      return toMove(best);
    }

    // card counting: everything not in my hand, on the table or in a pile
    const seen = new Map();
    const see = (x) => seen.set(cardKey(x), (seen.get(cardKey(x)) || 0) + 1);
    hand.forEach(see); tableCards.forEach(see); captured.forEach((pile) => (pile || []).forEach(see));
    const unseen = [];
    for (const x of FULL_DECK) {
      const s = seen.get(cardKey(x)) || 0;
      if (s > 0) seen.set(cardKey(x), s - 1); else unseen.push(x);
    }
    const handCounts = Array.from({ length: n }, (_, i) => (i === me ? hand.length
      : Array.isArray(c.handCounts) && Number.isInteger(c.handCounts[i]) ? c.handCounts[i] : hand.length));
    const inHands = handCounts.reduce((s, x, i) => s + (i === me ? 0 : x), 0);
    const deckCount = Number.isInteger(c.deckCount) ? c.deckCount : Math.max(0, unseen.length - inHands);

    const samples = n === 4 ? HARD.samples4 : HARD.samples2;
    const depth = n === 4 ? HARD.depth4 : HARD.depth2;
    const perWorld = Math.floor(HARD.nodeBudget / samples);
    const total = new Float64Array(moves.length);
    for (let s = 0; s < samples; s++) {
      const pool = unseen.slice();
      for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
      const hands = [];
      for (let i = 0; i < n; i++) hands.push(i === me ? hand : pool.splice(0, Math.min(handCounts[i], pool.length)));
      G.pool = pool;
      const types = new Map();
      for (const x of pool) { const t = types.get(cardType(x)); if (t) t.count++; else types.set(cardType(x), { card: x, count: 1 }); }
      G.poolTypes = [...types.values()].sort((a, b) => a.card.value - b.card.value);
      G.memo = new Map();
      G.nodes = 0;
      G.budget = perWorld;
      const S0 = root(hands, null, deckCount);
      for (let i = 0; i < moves.length; i++) total[i] += hardSearch(G, hardPlay(G, S0, me, moves[i].ci, moves[i].combo), depth - 1, -Infinity, Infinity);
    }
    let bi = 0;
    for (let i = 1; i < moves.length; i++) if (total[i] > total[bi] + 1e-9) bi = i;
    return toMove(moves[bi]);
  }

  // The move made for a player whose turn timer ran out.
  function autoPlayMove(hand, tableCards, forceCapture, rng) {
    const rand = rng || Math.random;
    if (forceCapture && tableCards.length > 0) {
      for (const c of hand) {
        const m = matchingIndices(tableCards, c.value);
        if (m.length) return { cardId: c.id, captureCardIds: [tableCards[m[0]].id] };
      }
    }
    const card = hand[Math.floor(rand() * hand.length)];
    const captures = legalCaptures(tableCards, card.value);
    return { cardId: card.id, captureCardIds: captures.length ? captures[0].map((i) => tableCards[i].id) : [] };
  }

  // Scores one round (one full deck). capturedTeams: [cards[], cards[]];
  // chkobbas: [n, n]. Each verdict is the winning team index or -1 for a tie.
  function scoreRound(capturedTeams, chkobbas) {
    const cards = [capturedTeams[0].length, capturedTeams[1].length];
    const diamonds = [0, 0], haya = [0, 0], sevens = [0, 0], sixes = [0, 0];
    for (let t = 0; t < 2; t++) {
      for (const c of capturedTeams[t]) {
        if (c.suit === DIAMONDS) { diamonds[t]++; if (c.name === '7') haya[t] = 1; }
        if (c.name === '7') sevens[t]++;
        if (c.name === '6') sixes[t]++;
      }
    }
    const more = (a) => (a[0] === a[1] ? -1 : a[0] > a[1] ? 0 : 1);
    const mostCardsPt = more(cards);
    const mostDiamondsPt = more(diamonds);
    const sevenDiamondsPt = haya[0] ? 0 : haya[1] ? 1 : -1;
    // most sevens; a tie on sevens goes to most sixes; a tie again scores nothing
    const mostSevensPt = sevens[0] !== sevens[1] ? more(sevens) : more(sixes);
    const shk = chkobbas || [0, 0];
    const points = [shk[0], shk[1]];
    [mostCardsPt, mostDiamondsPt, sevenDiamondsPt, mostSevensPt].forEach((w) => { if (w >= 0) points[w]++; });
    return {
      points, mostCardsPt, mostDiamondsPt, sevenDiamondsPt, mostSevensPt,
      counts: { cards, diamonds, haya, sevens, sixes },
    };
  }

  // Number of deals in one deck: the first deal also puts 4 cards on the table.
  function dealsPerDeck(numPlayers) {
    const perDeal = numPlayers * 3;
    return 1 + Math.ceil((40 - 4 - perDeal) / perDeal);
  }

  // The match winner once someone reached winScore, -1 while it goes on (or on a tie).
  function matchWinner(scores, winScore) {
    if (scores[0] < winScore && scores[1] < winScore) return -1;
    if (scores[0] === scores[1]) return -1;
    return scores[0] > scores[1] ? 0 : 1;
  }

  return {
    findCaptureCombinations, matchingIndices, legalCaptures, hasDirectMatch, checkMove,
    chooseBotMove, autoPlayMove, scoreRound, dealsPerDeck, matchWinner,
  };
});
