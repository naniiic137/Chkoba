/* Pure game rules: capture legality, the bot's move choice and round scoring.
 * No DOM, no Firebase, no app state: every function takes plain card objects
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
  function chooseBotMove(hand, tableCards, difficulty, forceCapture, rng) {
    const rand = rng || Math.random;
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
          if (difficulty === 'hard') {
            if (capturedCards.some((c) => c.name === '7')) score += 4;
            if (capturedCards.length === 1 && capturedCards[0].value === card.value) score += 2;
          }
          if (score > bestScore) { bestScore = score; bestMove = { cardId: card.id, captureCardIds: ids(combo) }; }
        }
      }
      if (!bestMove) {
        const safe = hand.filter((c) => !legalCaptures(tableCards, c.value).length);
        if (difficulty === 'hard' && safe.length > 0) {
          const low = safe.slice().sort((a, b) => a.value - b.value);
          bestMove = { cardId: low[0].id, captureCardIds: [] };
        } else {
          const card = safe.length > 0 ? safe[0] : hand[0];
          bestMove = { cardId: card.id, captureCardIds: [] };
        }
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
