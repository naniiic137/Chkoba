/* ============================================================================
   config.js — the live control panel. Themes are token presets, so switching
   one only rewrites the <link id="theme-css"> href and the body[data-theme]
   attribute; nothing re-mounts. Every knob is mirrored into the URL so any look
   is a shareable, screenshot-reproducible link (used by the Playwright review).
   ========================================================================== */
(function (global) {
  'use strict';

  const body = document.body;
  const $ = (id) => document.getElementById(id);
  const themeLink = $('theme-css');

  const THEMES = ['noir', 'zellige', 'balatro'];
  const prefersReduce = global.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // pristine snapshot so "re-deal" restores the moment without a reload
  const PRISTINE = JSON.parse(JSON.stringify(global.MOCK_STATE));

  const params = new URLSearchParams(location.search);
  const cfg = {
    theme: THEMES.includes(params.get('theme')) ? params.get('theme') : 'noir',
    juice: params.has('juice') ? clampInt(params.get('juice'), 0, 100, 70) : 70,
    suit: params.get('suit') === 'coin' ? 'coin' : 'french',
    crt: params.get('crt') === '1',
    grain: params.get('grain') !== '0',
    reduce: params.has('reduce') ? params.get('reduce') === '1' : prefersReduce,
    kiosk: params.get('kiosk') === '1',
  };

  function clampInt(v, lo, hi, dflt) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  }

  /* ---- appliers -------------------------------------------------------- */
  function effectiveK() { return cfg.reduce ? 0 : cfg.juice / 100; }

  function applyTheme() {
    themeLink.setAttribute('href', `themes/${cfg.theme}.css`);
    body.dataset.theme = cfg.theme;
    segSelect('seg-theme', 'theme', cfg.theme);
  }
  function applyJuice() {
    const k = effectiveK();
    body.style.setProperty('--juice-k', k.toFixed(3));
    if (global.Juice) Juice.setJuice(k);
    const out = $('juice-val'); if (out) out.textContent = cfg.juice;
    const slider = $('ctl-juice'); if (slider) slider.value = cfg.juice;
  }
  function applySuit() {
    if (global.Board) Board.setSuitStyle(cfg.suit);
    else body.dataset.suitstyle = cfg.suit;
    segSelect('seg-suit', 'suit', cfg.suit);
  }
  function applyToggles() {
    body.classList.toggle('crt', cfg.crt);
    body.classList.toggle('no-grain', !cfg.grain);
    body.classList.toggle('reduce', cfg.reduce);
    setChecked('ctl-crt', cfg.crt);
    setChecked('ctl-grain', cfg.grain);
    setChecked('ctl-reduce', cfg.reduce);
    applyJuice(); // reduce flips effective juice
  }
  function applyKiosk() { body.classList.toggle('kiosk', cfg.kiosk); }

  function segSelect(groupId, key, val) {
    const g = $(groupId); if (!g) return;
    g.querySelectorAll('[role="radio"]').forEach((b) => {
      const on = b.dataset[key] === val;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.classList.toggle('on', on);
    });
  }
  function setChecked(id, on) { const el = $(id); if (el) el.checked = on; }

  /* ---- url sync -------------------------------------------------------- */
  function persist() {
    const p = new URLSearchParams();
    p.set('theme', cfg.theme);
    p.set('juice', cfg.juice);
    p.set('suit', cfg.suit);
    if (cfg.crt) p.set('crt', '1');
    if (!cfg.grain) p.set('grain', '0');
    if (cfg.reduce) p.set('reduce', '1');
    if (cfg.kiosk) p.set('kiosk', '1');
    history.replaceState(null, '', '?' + p.toString());
  }

  /* ---- wiring ---------------------------------------------------------- */
  function wire() {
    $('seg-theme').addEventListener('click', (e) => {
      const b = e.target.closest('[data-theme]'); if (!b) return;
      cfg.theme = b.dataset.theme; applyTheme(); persist();
    });
    $('seg-suit').addEventListener('click', (e) => {
      const b = e.target.closest('[data-suit]'); if (!b) return;
      cfg.suit = b.dataset.suit; applySuit(); persist();
    });
    $('ctl-juice').addEventListener('input', (e) => {
      cfg.juice = clampInt(e.target.value, 0, 100, 70); applyJuice(); persist();
    });
    $('ctl-crt').addEventListener('change', (e) => { cfg.crt = e.target.checked; applyToggles(); persist(); });
    $('ctl-grain').addEventListener('change', (e) => { cfg.grain = e.target.checked; applyToggles(); persist(); });
    $('ctl-reduce').addEventListener('change', (e) => { cfg.reduce = e.target.checked; applyToggles(); persist(); });

    const replay = () => { if (global.Board) Board.playDemoCapture(); };
    $('ctl-replay').addEventListener('click', replay);
    $('btn-replay').addEventListener('click', replay);
    $('ctl-shuffle').addEventListener('click', reDeal);

    const toggle = $('panel-toggle');
    toggle.addEventListener('click', () => {
      const open = body.classList.toggle('panel-collapsed');
      toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
    });
  }

  function reDeal() {
    const fresh = JSON.parse(JSON.stringify(PRISTINE));
    Object.keys(fresh).forEach((k) => { global.MOCK_STATE[k] = fresh[k]; });
    if (global.Board) { Board.clearSelection(); Board.render(); }
  }

  function init() {
    applyTheme();
    applySuit();   // also triggers a Board.render once Board is ready
    applyToggles();
    applyKiosk();
    wire();
    persist();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
