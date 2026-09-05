/* Labels. Three modes ship as a game setting (default latin):
 *   latin   - CHKOBBA / HAYA / DINARI / BARMILA / KARTA
 *   arabic  - Arabic first, Latin subtitle
 *   english - plain English, matches the current game
 * A term renders as {main, sub}; sub is empty in latin and english. */
(function (global) {
  'use strict';

  const TERMS = {
    chkobba: { ar: 'شكوبة',        latin: 'CHKOBBA',  en: 'Chkobba' },
    haya:    { ar: 'سبعة الحيّة',   latin: 'HAYA',     en: '7 of diamonds' },
    dinari:  { ar: 'ديناري',        latin: 'DINARI',   en: 'Diamonds' },
    barmila: { ar: 'برميلة',        latin: 'BARMILA',  en: 'Sevens' },
    karta:   { ar: 'كارطة',         latin: 'KARTA',    en: 'Cards' },
    capture: { ar: 'خذ',            latin: 'CAPTURE',  en: 'Capture' },
    place:   { ar: 'حطّ',           latin: 'PLACE',    en: 'Place' },
    yourTurn:{ ar: 'دورك',          latin: 'YOUR TURN',en: 'Your turn' },
    dealing: { ar: 'توزيع',         latin: 'DEALING',  en: 'Dealing' },
    thinking:{ ar: 'يفكّر',         latin: 'THINKING', en: 'Thinking' },
    round:   { ar: 'جولة',          latin: 'ROUND',    en: 'Round' },
    deck:    { ar: 'الورق',         latin: 'DECK',     en: 'Deck' },
    score:   { ar: 'النقاط',        latin: 'SCORE',    en: 'Score' },
    wins:    { ar: 'ربح',           latin: 'WIN',      en: 'wins' },
    team:    { ar: 'فريق',          latin: 'TEAM',     en: 'Team' },
    roundEnd:{ ar: 'نهاية الجولة',  latin: 'ROUND END',en: 'Round end' },
    gameOver:{ ar: 'انتهت اللعبة',  latin: 'GAME OVER',en: 'Game over' },
    waiting: { ar: 'انتظار',        latin: 'WAITING',  en: 'Waiting' },
    paused:  { ar: 'توقّف',         latin: 'PAUSED',   en: 'Paused' },
  };

  // Rule copy for the info panel and the rules carousel. Kept in one place so the
  // label mode only swaps the term, never the explanation.
  const RULES = [
    { key: 'karta',   text: 'Most cards captured at the end of the round. Tie: no point.' },
    { key: 'dinari',  text: 'Most diamonds captured. Tie: no point.' },
    { key: 'haya',    text: 'Whoever captures the 7 of diamonds. The only card worth a point on its own.' },
    { key: 'barmila', text: 'Most sevens captured. Tie on sevens goes to most sixes. Tie again: no point.' },
    { key: 'chkobba', text: 'Clear the table with a capture: one point, right away. The dealer cannot score it on the last card of a round.' },
  ];

  let mode = 'latin';

  function term(key) {
    const t = TERMS[key];
    if (!t) return { main: key, sub: '' };
    if (mode === 'arabic') return { main: t.ar, sub: t.latin, rtl: true };
    if (mode === 'english') return { main: t.en, sub: '' };
    return { main: t.latin, sub: '' };
  }

  function html(key, cls) {
    const t = term(key);
    return `<span class="term ${cls || ''}${t.rtl ? ' rtl' : ''}"><b>${t.main}</b>${t.sub ? `<small>${t.sub}</small>` : ''}</span>`;
  }

  // Plain text for elements that cannot hold markup (the text-fill uses one text node).
  function text(key) {
    const t = term(key);
    return t.main;
  }

  global.I18N = {
    TERMS, RULES,
    setMode(m) { mode = ['latin', 'arabic', 'english'].includes(m) ? m : 'latin'; document.documentElement.dataset.labels = mode; },
    getMode() { return mode; },
    term, html, text,
  };
})(window);
