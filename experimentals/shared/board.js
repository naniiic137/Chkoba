/* ============================================================================
   board.js — renders MOCK_STATE into the real game's DOM contract.
   Cards are CSS/SVG (face + pips + holo layers), not <img>, so suits recolor,
   the French↔coin swap works, and the holographic sheen has a surface to live
   on. The OUTER .card keeps the contract: role="button" tabindex="0" aria-label,
   inside #hand-cards / #table-cards — so a chosen theme ports to game.js by
   swapping the inner render, nothing else.
   ========================================================================== */
(function (global) {
  'use strict';

  const S = global.MOCK_STATE;
  const $ = (id) => document.getElementById(id);

  /* ---- suit artwork ---------------------------------------------------- */
  // French pips and the heritage Latin suits (coins/cups/swords/batons), the
  // pair the suit-style toggle flips between. fill="currentColor" → recolored
  // by --suit-color per theme/suit.
  const SVG = {
    french: {
      hearts:   '<svg viewBox="0 0 32 32"><path d="M16 28C16 28 3 19.5 3 10.8 3 6.3 6.4 3 10.6 3c2.6 0 4.4 1.5 5.4 3.2C17 4.5 18.8 3 21.4 3 25.6 3 29 6.3 29 10.8 29 19.5 16 28 16 28Z"/></svg>',
      diamonds: '<svg viewBox="0 0 32 32"><path d="M16 2 28 16 16 30 4 16Z"/></svg>',
      clubs:    '<svg viewBox="0 0 32 32"><circle cx="16" cy="9" r="5.3"/><circle cx="9.6" cy="18" r="5.3"/><circle cx="22.4" cy="18" r="5.3"/><path d="M13.6 18h4.8l2.2 11h-9.2z"/></svg>',
      spades:   '<svg viewBox="0 0 32 32"><path d="M16 3C16 3 4 13 4 20.2 4 24 7 26 10 26c2 0 3.4-1 4-2 0 0-.6 3.6-3 5h10c-2.4-1.4-3-5-3-5 .6 1 2 2 4 2 3 0 6-2 6-5.8C28 13 16 3 16 3Z"/></svg>',
    },
    coin: {
      // diamonds → coins (dīnārī): Kairouan 8-point khatim star (two squares).
      diamonds: '<svg viewBox="0 0 32 32"><rect x="8.7" y="8.7" width="14.6" height="14.6"/><rect x="8.7" y="8.7" width="14.6" height="14.6" transform="rotate(45 16 16)"/></svg>',
      // hearts → cups (kʾūs): a goblet.
      hearts:   '<svg viewBox="0 0 32 32"><path d="M7 5h18a9 9 0 0 1-7 8.8V23h4.2v3H9.8v-3H14v-9.2A9 9 0 0 1 7 5Z"/></svg>',
      // spades → swords (syūf): blade, guard, hilt, pommel.
      spades:   '<svg viewBox="0 0 32 32"><path d="M16 2l2.6 4.2V19h-5.2V6.2z"/><rect x="9" y="19" width="14" height="2.3"/><rect x="14.9" y="19" width="2.2" height="8.4"/><rect x="13.4" y="26.6" width="5.2" height="2.3"/></svg>',
      // clubs → batons (ʿaṣā): a knotted cudgel.
      clubs:    '<svg viewBox="0 0 32 32"><path d="M10.8 28.4l10-22.2a3 3 0 0 1 4.2 4.1l-10 22.2a3 3 0 0 1-4.2-4.1Z"/><circle cx="22.6" cy="7.6" r="2.1"/><circle cx="9.4" cy="26.4" r="2.1"/></svg>',
    },
  };
  const suitGlyph = (suit, style) => (SVG[style] && SVG[style][suit]) || SVG.french[suit];

  /* ---- pip layouts (values 1..7); courts get an emblem ----------------- */
  const COL = { L: 22, C: 50, R: 78 };
  const ROW = { T: 13, UM: 32, M: 50, LM: 68, B: 87 };
  const P = (c, r, flip) => ({ x: COL[c], y: ROW[r], flip: !!flip });
  const PIPS = {
    1: [P('C', 'M')],
    2: [P('C', 'T'), P('C', 'B', 1)],
    3: [P('C', 'T'), P('C', 'M'), P('C', 'B', 1)],
    4: [P('L', 'T'), P('R', 'T'), P('L', 'B', 1), P('R', 'B', 1)],
    5: [P('L', 'T'), P('R', 'T'), P('C', 'M'), P('L', 'B', 1), P('R', 'B', 1)],
    6: [P('L', 'T'), P('R', 'T'), P('L', 'M'), P('R', 'M'), P('L', 'B', 1), P('R', 'B', 1)],
    7: [P('L', 'T'), P('R', 'T'), P('C', 'UM'), P('L', 'M'), P('R', 'M'), P('L', 'B', 1), P('R', 'B', 1)],
  };
  const COURT = { jack: 'J', queen: 'Q', king: 'K' };

  function faceHTML(card, style) {
    const glyph = suitGlyph(card.suit, style);
    const cornerPip = `<span class="pip">${glyph}</span>`;
    const corner = (cls) => `<div class="card__corner ${cls}"><span class="card__rank">${card.display}</span>${cornerPip}</div>`;

    let center;
    if (COURT[card.name]) {
      center = `<div class="card__watermark">${glyph}</div>
        <div class="card__court"><span>${COURT[card.name]}</span><span class="court-suit pip">${glyph}</span></div>`;
    } else {
      const pips = (PIPS[card.value] || PIPS[1]).map((p) =>
        `<span class="pip${p.flip ? ' flip' : ''}" style="left:${p.x}%;top:${p.y}%">${glyph}</span>`
      ).join('');
      center = `<div class="card__center">${pips}</div>`;
    }

    return `<div class="card__inner">
      <div class="card__face">
        ${corner('card__corner--tl')}
        ${center}
        ${corner('card__corner--br')}
      </div>
      <div class="card__holo"></div>
      <div class="card__glare"></div>
    </div>`;
  }

  /* ---- card node (the contract) ---------------------------------------- */
  function buildCard(card, opts) {
    const o = opts || {};
    const el = document.createElement('div');
    el.className = 'card';
    el.dataset.suit = card.suit;
    el.dataset.rank = card.display;
    el.dataset.id = card.id;
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', `${card.display} of ${card.suit}`);
    if (card.id === S.hayaId) el.classList.add('is-haya');
    if (o.interactive) el.classList.add('is-interactive');
    if (o.idle) { el.classList.add('idle'); el.style.setProperty('--phase', (card.id % 7) / 7); }
    el.innerHTML = faceHTML(card, currentSuitStyle());
    if (global.Juice && Juice.bindCard) Juice.bindCard(el);
    return el;
  }

  const currentSuitStyle = () => document.body.dataset.suitstyle || 'french';

  /* ---- piles / opponents ----------------------------------------------- */
  function miniPile(count) {
    const n = Math.min(count, 5);
    let html = '';
    for (let i = 0; i < n; i++) html += `<div class="card-back mini" style="margin-left:${i ? -14 : 0}px"></div>`;
    return html;
  }

  function renderOpponents() {
    const wrap = $('opponents-top');
    wrap.innerHTML = '';
    S.players.filter((p) => !p.isLocal).forEach((p) => {
      const cap = S.captured[p.team] || { count: 0, shkobba: 0 };
      const isTurn = S.currentTurn === p.id;
      const node = document.createElement('div');
      node.className = `opponent-info team${p.team + 1}${isTurn ? ' active-turn' : ''}`;
      node.innerHTML = `
        <div class="name">${p.name}</div>
        <div class="card-count">Cards: ${p.handCount}</div>
        <div class="captured-row">
          <div class="captured-pile">${miniPile(cap.count)}</div>
          <div class="captured-label">${cap.count}${cap.shkobba ? ' · ' + '★'.repeat(cap.shkobba) : ''}</div>
        </div>`;
      wrap.appendChild(node);
    });
  }

  function renderDeck() {
    const el = $('table-deck');
    el.innerHTML = `<div class="card-back"></div><span class="deck-count">Deck ${S.deckCount}</span>`;
  }

  function renderCaptured() {
    const el = $('my-captured');
    const cap = S.captured[0] || { count: 0, shkobba: 0 };
    el.innerHTML = `<span>Captured</span> <span class="captured-pile">${miniPile(cap.count)}</span>
      <strong style="color:var(--gold)">${cap.count}</strong>${cap.shkobba ? ' <span style="color:var(--haya)">★ shkobba</span>' : ''}`;
  }

  /* ---- table + hand ----------------------------------------------------- */
  let selectedIndex = -1;

  function renderTable() {
    const el = $('table-cards');
    el.innerHTML = '';
    S.tableCards.forEach((card, i) => {
      const node = buildCard(card, { interactive: false, idle: true });
      node.dataset.index = i;
      node.classList.add('on-table');
      node.addEventListener('click', () => onTableClick(i));
      el.appendChild(node);
    });
    $('table-msg').textContent = '';
  }

  function renderHand() {
    const el = $('hand-cards');
    el.innerHTML = '';
    const myTurn = S.currentTurn === S.myPlayerId;
    S.hand.forEach((card, i) => {
      const node = buildCard(card, { interactive: myTurn, idle: true });
      node.dataset.index = i;
      node.addEventListener('click', () => onHandClick(i));
      node.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onHandClick(i); }
      });
      el.appendChild(node);
    });
  }

  /* ---- interaction (demo selection + capture highlight) ---------------- */
  function captureTargetsFor(handCard) {
    // existence-level: any single table card of equal value, plus the canonical
    // pending capture (7♣ → haya). Good enough to light the board for review.
    const idxs = [];
    S.tableCards.forEach((t, i) => { if (t.value === handCard.value) idxs.push(i); });
    return idxs;
  }

  function clearSelection() {
    selectedIndex = -1;
    document.querySelectorAll('#hand-cards .card.selected').forEach((c) => c.classList.remove('selected'));
    document.querySelectorAll('#table-cards .card.capture-target').forEach((c) => c.classList.remove('capture-target', 'is-interactive'));
    $('table-msg').textContent = '';
  }

  function onHandClick(i) {
    if (S.currentTurn !== S.myPlayerId) return;
    const handEls = $('hand-cards').children;
    if (selectedIndex === i) { clearSelection(); return; }
    clearSelection();
    selectedIndex = i;
    handEls[i].classList.add('selected');
    const targets = captureTargetsFor(S.hand[i]);
    const tableEls = $('table-cards').children;
    targets.forEach((t) => tableEls[t].classList.add('capture-target', 'is-interactive'));
    $('table-msg').textContent = targets.length
      ? `Capture ${S.hand[i].display} → ${targets.length} match${targets.length > 1 ? 'es' : ''}`
      : `No capture — ${S.hand[i].display} would be placed`;
  }

  function onTableClick(i) {
    const tableEl = $('table-cards').children[i];
    if (selectedIndex < 0 || !tableEl.classList.contains('capture-target')) return;
    doCapture(selectedIndex, [i]);
  }

  /* ---- capture: hand off the choreography to the juice layer ----------- */
  function doCapture(handIndex, tableIndexes) {
    const handEl = $('hand-cards').children[handIndex];
    const tableEls = tableIndexes.map((i) => $('table-cards').children[i]);
    const captured = [S.hand[handIndex], ...tableIndexes.map((i) => S.tableCards[i])];
    const isHaya = tableIndexes.some((i) => S.tableCards[i].id === S.hayaId);
    const points = isHaya ? S.pendingCapture.points : 1;

    clearSelection();

    const finish = () => {
      // mutate the snapshot so the pile/score reflect the take
      S.captured[0].count += captured.length;
      S.scores[0] += points;
      renderCaptured();
      // rebuild hand/table minus the taken cards
      S.hand.splice(handIndex, 1);
      const drop = new Set(tableIndexes);
      S.tableCards = S.tableCards.filter((_, i) => !drop.has(i));
      renderHand(); renderTable();
    };

    if (global.Juice && Juice.playCapture) {
      Juice.playCapture({ handEl, tableEls, points, fromScore: S.scores[0], isHaya, onDone: finish });
    } else {
      finish();
    }
  }

  /* canonical demo capture (7♣ takes the haya) — used by Replay buttons */
  function playDemoCapture() {
    if (S.currentTurn !== S.myPlayerId) return;
    const handIndex = S.hand.findIndex((c) => c.value === 7);
    const tableIndex = S.tableCards.findIndex((c) => c.id === S.hayaId);
    if (handIndex < 0 || tableIndex < 0) return;
    doCapture(handIndex, [tableIndex]);
  }

  /* ---- full render + public API ---------------------------------------- */
  function render() {
    renderOpponents();
    renderDeck();
    renderCaptured();
    renderTable();
    renderHand();
    $('score-t1-num').textContent = S.scores[0];
    $('score-t2-num').textContent = S.scores[1];
  }

  function setSuitStyle(style) {
    document.body.dataset.suitstyle = style;
    render(); // re-render faces with the other glyph set
  }

  global.Board = {
    render,
    setSuitStyle,
    playDemoCapture,
    clearSelection,
    get state() { return S; },
  };

  document.addEventListener('DOMContentLoaded', render);
})(window);
