/* Card renderer. Three styles behind one node contract (.card, role=button,
 * tabindex, aria-label, data-suit/rank/id):
 *   svg    - flat vector face, chunky rank, clean pips
 *   photo  - the PNG scans in images/
 *   pixel  - bitmap pips and a pixel face, rendered crisp
 * Suit sets: french (hearts/diamonds/clubs/spades) or coin (the heritage Latin
 * suits: cups/coins/batons/swords) for svg and pixel. Photo has no coin set.
 * Backs never carry a face, an idle phase, or a tilt binding: an opponent's card
 * is an inert rectangle by construction. */
(function (global) {
  'use strict';

  const FRENCH = {
    hearts:   '<path d="M16 28C16 28 3 19.5 3 10.8 3 6.3 6.4 3 10.6 3c2.6 0 4.4 1.5 5.4 3.2C17 4.5 18.8 3 21.4 3 25.6 3 29 6.3 29 10.8 29 19.5 16 28 16 28Z"/>',
    diamonds: '<path d="M16 2 28 16 16 30 4 16Z"/>',
    clubs:    '<circle cx="16" cy="9" r="5.3"/><circle cx="9.6" cy="18" r="5.3"/><circle cx="22.4" cy="18" r="5.3"/><path d="M13.6 18h4.8l2.2 11h-9.2z"/>',
    spades:   '<path d="M16 3C16 3 4 13 4 20.2 4 24 7 26 10 26c2 0 3.4-1 4-2 0 0-.6 3.6-3 5h10c-2.4-1.4-3-5-3-5 .6 1 2 2 4 2 3 0 6-2 6-5.8C28 13 16 3 16 3Z"/>',
  };
  const COIN = {
    diamonds: '<rect x="8.7" y="8.7" width="14.6" height="14.6"/><rect x="8.7" y="8.7" width="14.6" height="14.6" transform="rotate(45 16 16)"/>',
    hearts:   '<path d="M7 5h18a9 9 0 0 1-7 8.8V23h4.2v3H9.8v-3H14v-9.2A9 9 0 0 1 7 5Z"/>',
    spades:   '<path d="M16 2l2.6 4.2V19h-5.2V6.2z"/><rect x="9" y="19" width="14" height="2.3"/><rect x="14.9" y="19" width="2.2" height="8.4"/><rect x="13.4" y="26.6" width="5.2" height="2.3"/>',
    clubs:    '<path d="M10.8 28.4l10-22.2a3 3 0 0 1 4.2 4.1l-10 22.2a3 3 0 0 1-4.2-4.1Z"/><circle cx="22.6" cy="7.6" r="2.1"/><circle cx="9.4" cy="26.4" r="2.1"/>',
  };
  // 7x7 bitmaps for the pixel style. '#' = on.
  const PIX_FRENCH = {
    hearts:   ['.##.##.', '#######', '#######', '#######', '.#####.', '..###..', '...#...'],
    diamonds: ['...#...', '..###..', '.#####.', '#######', '.#####.', '..###..', '...#...'],
    clubs:    ['..###..', '..###..', '##.#.##', '#######', '##.#.##', '...#...', '..###..'],
    spades:   ['...#...', '..###..', '.#####.', '#######', '#######', '..#.#..', '..###..'],
  };
  const PIX_COIN = {
    diamonds: ['..###..', '.#...#.', '#..#..#', '#.###.#', '#..#..#', '.#...#.', '..###..'],
    hearts:   ['#######', '.#####.', '.#####.', '..###..', '...#...', '..###..', '.#####.'],
    spades:   ['...#...', '...#...', '...#...', '.#####.', '...#...', '...#...', '..###..'],
    clubs:    ['.....##', '....###', '...###.', '..###..', '.###...', '###....', '##.....'],
  };

  function bitmapSvg(rows) {
    let rects = '';
    rows.forEach((r, y) => { for (let x = 0; x < r.length; x++) if (r[x] === '#') rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`; });
    return `<svg viewBox="0 0 7 7" shape-rendering="crispEdges">${rects}</svg>`;
  }
  function glyph(suit, suitStyle, cardStyle) {
    if (cardStyle === 'pixel') return bitmapSvg((suitStyle === 'coin' ? PIX_COIN : PIX_FRENCH)[suit]);
    return `<svg viewBox="0 0 32 32">${(suitStyle === 'coin' ? COIN : FRENCH)[suit]}</svg>`;
  }

  const COL = { L: 24, C: 50, R: 76 };
  const ROW = { T: 14, UM: 32, M: 50, LM: 68, B: 86 };
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
  const FACE_NAMES = ['jack', 'queen', 'king'];

  function photoSrc(card) {
    const suffix = (FACE_NAMES.includes(card.name) || (card.name === 'ace' && card.suit === 'spades')) ? '2' : '';
    return `images/${card.name}_of_${card.suit}${suffix}.png`;
  }

  function faceHTML(card, cardStyle, suitStyle) {
    if (cardStyle === 'photo') {
      return `<div class="card__inner"><img class="card__photo" src="${photoSrc(card)}" alt="" draggable="false"><div class="card__holo"></div><div class="card__glare"></div></div>`;
    }
    const g = glyph(card.suit, suitStyle, cardStyle);
    const corner = (cls) => `<div class="card__corner ${cls}"><span class="card__rank">${card.display}</span><span class="pip">${g}</span></div>`;
    let center;
    if (COURT[card.name]) {
      center = `<div class="card__watermark">${g}</div><div class="card__court"><span>${COURT[card.name]}</span><span class="court-suit pip">${g}</span></div>`;
    } else {
      center = `<div class="card__center">${(PIPS[card.value] || PIPS[1]).map((p) => `<span class="pip${p.flip ? ' flip' : ''}" style="left:${p.x}%;top:${p.y}%">${g}</span>`).join('')}</div>`;
    }
    return `<div class="card__inner"><div class="card__face">${corner('card__corner--tl')}${center}${corner('card__corner--br')}</div><div class="card__holo"></div><div class="card__glare"></div></div>`;
  }

  let cardStyle = 'svg';
  let suitStyle = 'french';

  const isHaya = (c) => c.suit === 'diamonds' && c.name === '7';

  function build(card, opts) {
    const o = opts || {};
    const el = document.createElement('div');
    el.className = 'card';
    el.dataset.suit = card.suit; el.dataset.rank = card.display; el.dataset.id = card.id;
    el.setAttribute('role', 'button'); el.setAttribute('tabindex', o.interactive ? '0' : '-1');
    el.setAttribute('aria-label', `${card.display} of ${card.suit}`);
    if (isHaya(card)) el.classList.add('is-haya');
    if (o.interactive) el.classList.add('is-interactive');
    if (o.idle) { el.classList.add('idle'); el.style.setProperty('--phase', ((card.id * 7) % 11) / 11); }
    el.innerHTML = faceHTML(card, cardStyle, suitStyle);
    if (global.Juice && Juice.bindCard) Juice.bindCard(el);
    return el;
  }

  // An opponent's card. No id, no face, no binding, no idle phase: nothing to read.
  function back(mini) {
    const el = document.createElement('div');
    el.className = 'card-back' + (mini ? ' mini' : '');
    el.setAttribute('aria-hidden', 'true');
    return el;
  }

  global.Cards = {
    build, back, isHaya, photoSrc,
    setStyle(s) { cardStyle = ['svg', 'photo', 'pixel'].includes(s) ? s : 'svg'; document.documentElement.dataset.cards = cardStyle; },
    setSuit(s) { suitStyle = s === 'coin' ? 'coin' : 'french'; document.documentElement.dataset.suitstyle = suitStyle; },
    getStyle: () => cardStyle, getSuit: () => suitStyle,
    glyph: (suit) => glyph(suit, suitStyle, cardStyle),
  };
})(window);
