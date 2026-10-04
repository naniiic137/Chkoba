/* The feel layer. Everything scales with one coefficient k (0..1); at 0 the game
 * still works, it just sits still. CSS eases, JS feeds targets and timing.
 *   bindCard   pointer tilt + sheen position on a face-up card
 *   tag        floating label above a card (+1 card, DINARI, HAYA ...)
 *   slam       big rough text that lands rotated and settles, glyph jitter
 *   flyTo      clone a card and send it to a pile
 *   countUp    count a number with a bump and a rising tick
 *   shake      score-scaled board shake
 *   fill       Deadlock-style text fill, driven by a fraction
 *   tick/thud/boom  Web Audio, one shared context */
(function (global) {
  'use strict';

  let k = 1;
  let soundOn = true;
  let shakeOn = true;        // screen shake is its own switch: some people get motion sick from it alone
  let timeScale = 1;          // lab slow-motion: every duration and delay is multiplied by it
  let ac = null;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms * timeScale));

  /* ---- tilt + sheen ----------------------------------------------------- */
  function bindCard(el) {
    let raf = 0, tx = 0, ty = 0, cx = 0, cy = 0;
    const apply = () => {
      raf = 0;
      cx += (tx - cx) * 0.22; cy += (ty - cy) * 0.22;
      el.style.setProperty('--ry', (cx * 12 * k).toFixed(2) + 'deg');
      el.style.setProperty('--rx', (-cy * 12 * k).toFixed(2) + 'deg');
      el.style.setProperty('--mx', (50 + cx * 70).toFixed(1) + '%');
      el.style.setProperty('--my', (50 + cy * 70).toFixed(1) + '%');
      if (Math.abs(tx - cx) > 0.002 || Math.abs(ty - cy) > 0.002) raf = requestAnimationFrame(apply);
    };
    el.addEventListener('pointermove', (e) => {
      if (k <= 0) return;
      const r = el.getBoundingClientRect();
      tx = clamp((e.clientX - r.left) / r.width - 0.5, -0.5, 0.5);
      ty = clamp((e.clientY - r.top) / r.height - 0.5, -0.5, 0.5);
      if (!raf) raf = requestAnimationFrame(apply);
    });
    el.addEventListener('pointerleave', () => { tx = ty = 0; if (!raf) raf = requestAnimationFrame(apply); });
  }

  /* ---- audio ------------------------------------------------------------ */
  // The context is only created after a user gesture (unlock); before that every
  // sound call is a silent no-op instead of a console warning.
  let unlocked = false;
  function ctx() {
    if (!unlocked) return null;
    if (!ac) { const AC = global.AudioContext || global.webkitAudioContext; if (AC) ac = new AC(); }
    if (ac && ac.state === 'suspended') ac.resume();
    return ac;
  }
  function tone(type, f0, f1, dur, gain) {
    if (!soundOn || k <= 0) return;
    const a = ctx(); if (!a) return;
    const t = a.currentTime, o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.7);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain * k, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
  }
  const tick = (step) => tone('triangle', 330 + step * 55, 0, 0.14, 0.08);
  const thud = (i) => tone('sine', 150, 46, 0.3, 0.2 * (i || 1));
  const boom = () => { tone('sine', 90, 30, 0.6, 0.35); tone('square', 60, 20, 0.25, 0.08); };
  const chime = () => { tone('triangle', 660, 990, 0.35, 0.09); setTimeout(() => tone('triangle', 880, 1320, 0.4, 0.08), 90); };

  /* ---- floating tag ----------------------------------------------------- */
  function tag(anchor, text, kind, opts) {
    const o = opts || {};
    const r = anchor.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = `fx-tag ${kind || 'chip'}`;
    el.textContent = text;
    el.style.left = (r.left + r.width / 2) + 'px';
    el.style.top = (o.below ? r.bottom + 6 : r.top - 8) + 'px';
    if (o.below) el.classList.add('below');
    document.body.appendChild(el);
    if (k <= 0) el.classList.add('still');
    el.style.animationDuration = (1.1 * timeScale) + 's';
    setTimeout(() => el.remove(), 1100 * timeScale);
    return el;
  }

  /* ---- slam text -------------------------------------------------------- */
  function slam(host, text, kind, opts) {
    const o = opts || {};
    const el = document.createElement('div');
    el.className = `fx-slam ${kind || 'mult'}`;
    if (o.sub) el.dataset.sub = o.sub;
    // per-glyph spans so each letter can jitter independently, like the trailer's numbers;
    // they sit in a row wrapper because the slam itself stacks word over subtitle
    const word = document.createElement('div'); word.className = 'word';
    [...text].forEach((ch, i) => {
      const s = document.createElement('span');
      s.textContent = ch === ' ' ? String.fromCharCode(160) : ch;
      s.style.setProperty('--j', ((i * 37) % 7 - 3).toFixed(0));
      s.style.animationDelay = (i * 18) + 'ms';
      word.appendChild(s);
    });
    el.appendChild(word);
    if (o.sub) { const sub = document.createElement('small'); sub.textContent = o.sub; el.appendChild(sub); }
    host.appendChild(el);
    if (k <= 0) el.classList.add('still');
    boom();
    const life = (o.life || 1500) * timeScale;
    el.style.animationDuration = (0.55 * timeScale) + 's';
    setTimeout(() => el.classList.add('out'), life);
    setTimeout(() => el.remove(), life + 400 * timeScale);
    return el;
  }

  /* ---- flight ----------------------------------------------------------- */
  function flyTo(sourceEl, targetEl, delay, opts) {
    const o = opts || {};
    return new Promise((resolve) => {
      const sr = sourceEl.getBoundingClientRect();
      const tr = targetEl.getBoundingClientRect();
      const clone = sourceEl.cloneNode(true);
      clone.classList.add('flying');
      clone.classList.remove('is-interactive', 'selected', 'capture-target', 'idle');
      clone.removeAttribute('tabindex');
      Object.assign(clone.style, { left: sr.left + 'px', top: sr.top + 'px', width: sr.width + 'px', height: sr.height + 'px', margin: 0, transform: 'translate(0,0) scale(1) rotate(0deg)' });
      document.body.appendChild(clone);
      sourceEl.style.visibility = 'hidden';
      const dx = (tr.left + tr.width / 2) - (sr.left + sr.width / 2);
      const dy = (tr.top + tr.height / 2) - (sr.top + sr.height / 2);
      const dur = k <= 0 ? 0 : (o.dur || 520) * timeScale;
      setTimeout(() => {
        clone.style.transition = dur ? `transform ${dur}ms var(--spring), opacity ${dur}ms var(--ease-out)` : 'none';
        clone.style.transform = `translate(${dx}px, ${dy}px) scale(${o.scale != null ? o.scale : 0.3}) rotate(${(Math.sign(dx) || 1) * (o.rot != null ? o.rot : 22)}deg)`;
        if (o.fade !== false) clone.style.opacity = '0.2';
        thud(0.35);
      }, delay * timeScale + 16);
      setTimeout(() => { clone.remove(); resolve(); }, delay * timeScale + dur + 60);
    });
  }

  /* ---- deal flight: from the deck to a slot, landing face up or down ------ */
  function dealTo(deckEl, slotEl, delay, faceUp) {
    return new Promise((resolve) => {
      const dr = deckEl.getBoundingClientRect();
      const tr = slotEl.getBoundingClientRect();
      const ghost = document.createElement('div');
      ghost.className = 'card-back flying deal-ghost';
      Object.assign(ghost.style, { left: dr.left + 'px', top: dr.top + 'px', width: tr.width + 'px', height: tr.height + 'px', transform: 'translate(0,0) rotate(0deg)' });
      document.body.appendChild(ghost);
      const dx = tr.left - dr.left, dy = tr.top - dr.top;
      const dur = k <= 0 ? 0 : 420 * timeScale;
      const rot = ((delay / 60) % 5 - 2) * 4;
      setTimeout(() => {
        ghost.style.transition = dur ? `transform ${dur}ms var(--spring)` : 'none';
        ghost.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;
        tone('triangle', 520, 0, 0.06, 0.05);
      }, delay * timeScale + 10);
      setTimeout(() => {
        ghost.remove();
        slotEl.classList.remove('slot-hidden');
        slotEl.classList.add(faceUp ? 'landed' : 'landed-back');
        resolve();
      }, delay * timeScale + dur + 30);
    });
  }

  /* ---- count-up --------------------------------------------------------- */
  function countUp(el, from, to, opts) {
    const o = opts || {};
    return new Promise((resolve) => {
      const span = to - from;
      if (k <= 0 || span <= 0 || o.instant) { el.textContent = to; resolve(); return; }
      let i = 0;
      const step = () => {
        i++;
        el.textContent = from + i;
        el.classList.remove('bumping'); void el.offsetWidth; el.classList.add('bumping');
        tick(i);
        if (i < span && !o.cancel?.()) setTimeout(step, Math.max(45, (o.base || 130) - i * 9) * timeScale);
        else { el.textContent = to; resolve(); }
      };
      setTimeout(step, (o.delay || 0) * timeScale);
    });
  }

  function shake(intensity, hostEl) {
    if (k <= 0 || !shakeOn) return;
    const host = hostEl || document.getElementById('game-board');
    if (!host) return;
    host.style.setProperty('--shake', (2 + intensity * 9 * k).toFixed(1) + 'px');
    host.classList.remove('shaking'); void host.offsetWidth; host.classList.add('shaking');
    host.addEventListener('animationend', () => host.classList.remove('shaking'), { once: true });
  }

  /* ---- text fill ---------------------------------------------------------- */
  // p in 0..1. The element's text is the mask; --p is the gradient stop.
  function fill(el, p) { if (el) el.style.setProperty('--p', (clamp(p, 0, 1) * 100).toFixed(2) + '%'); }

  global.Juice = {
    bindCard, tag, slam, flyTo, dealTo, countUp, shake, fill, tick, thud, boom, chime, wait,
    setJuice(v) { k = clamp(v, 0, 1); document.documentElement.style.setProperty('--juice-k', k.toFixed(3)); },
    getJuice: () => k,
    setTimeScale(v) { timeScale = Math.max(0.1, v || 1); document.documentElement.style.setProperty('--time-scale', timeScale); },
    getTimeScale: () => timeScale,
    setSound(on) { soundOn = !!on; },
    setShake(on) { shakeOn = !!on; },
    unlock() { unlocked = true; ctx(); },
  };
})(window);
