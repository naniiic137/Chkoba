/* ============================================================================
   juice.js — the Balatro layer. Pointer-driven 3D tilt + holographic sheen,
   sequential capture flight, count-up score ramp with a rising-pitch Web Audio
   tick, and a score-scaled screen shake. Everything scales by a single juice
   coefficient (0..1); at 0 (reduced motion) the card still works, it just sits
   still. CSS does the easing — JS only feeds it target values.
   ========================================================================== */
(function (global) {
  'use strict';

  let juiceK = 0.7;          // mirrors --juice-k; updated by config
  let audioCtx = null;
  let soundOn = true;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* ---- per-card tilt + holo ------------------------------------------- */
  function bindCard(el) {
    let raf = 0, tx = 0, ty = 0, cx = 0, cy = 0;

    const apply = () => {
      raf = 0;
      // lerp toward target so the tilt trails the cursor (= weight)
      cx += (tx - cx) * 0.22;
      cy += (ty - cy) * 0.22;
      el.style.setProperty('--ry', (cx * 10 * juiceK).toFixed(2) + 'deg');
      el.style.setProperty('--rx', (-cy * 10 * juiceK).toFixed(2) + 'deg');
      el.style.setProperty('--mx', (50 + cx * 60).toFixed(1) + '%');
      el.style.setProperty('--my', (50 + cy * 60).toFixed(1) + '%');
      if (Math.abs(tx - cx) > 0.002 || Math.abs(ty - cy) > 0.002) raf = requestAnimationFrame(apply);
    };

    el.addEventListener('pointermove', (e) => {
      if (juiceK <= 0) return;
      const r = el.getBoundingClientRect();
      tx = clamp((e.clientX - r.left) / r.width - 0.5, -0.5, 0.5);
      ty = clamp((e.clientY - r.top) / r.height - 0.5, -0.5, 0.5);
      if (!raf) raf = requestAnimationFrame(apply);
    });

    el.addEventListener('pointerleave', () => {
      tx = ty = 0;
      if (!raf) raf = requestAnimationFrame(apply);
    });
  }

  /* ---- audio: short tick, pitch rises with the run ------------------- */
  function ensureAudio() {
    if (!audioCtx) {
      const AC = global.AudioContext || global.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }
  function tick(step) {
    if (!soundOn || juiceK <= 0) return;
    const ac = ensureAudio();
    if (!ac) return;
    const t = ac.currentTime;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(330 + step * 70, t);          // rising pitch
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.09 * juiceK, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    osc.connect(gain).connect(ac.destination);
    osc.start(t); osc.stop(t + 0.16);
  }
  function thud(intensity) {
    if (!soundOn || juiceK <= 0) return;
    const ac = ensureAudio();
    if (!ac) return;
    const t = ac.currentTime;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(48, t + 0.18);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.22 * intensity * juiceK, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc.connect(gain).connect(ac.destination);
    osc.start(t); osc.stop(t + 0.32);
  }

  /* ---- flight: clone a card and send it to the pile ------------------ */
  function flyTo(sourceEl, targetEl, delay) {
    return new Promise((resolve) => {
      const sr = sourceEl.getBoundingClientRect();
      const tr = targetEl.getBoundingClientRect();
      const clone = sourceEl.cloneNode(true);
      clone.classList.add('flying');
      clone.classList.remove('is-interactive', 'selected', 'capture-target');
      clone.style.left = sr.left + 'px';
      clone.style.top = sr.top + 'px';
      clone.style.width = sr.width + 'px';
      clone.style.height = sr.height + 'px';
      clone.style.margin = '0';
      clone.style.transform = 'translate(0,0) scale(1) rotateZ(0deg)';
      document.body.appendChild(clone);
      sourceEl.style.visibility = 'hidden';

      const dx = (tr.left + tr.width / 2) - (sr.left + sr.width / 2);
      const dy = (tr.top + tr.height / 2) - (sr.top + sr.height / 2);

      setTimeout(() => {
        clone.style.transform = `translate(${dx}px, ${dy}px) scale(.28) rotateZ(${(Math.sign(dx) || 1) * 24}deg)`;
        clone.style.opacity = '0.15';
        thud(0.4);
      }, delay + 20);

      setTimeout(() => { clone.remove(); resolve(); }, delay + 600);
    });
  }

  /* ---- count-up score ramp ------------------------------------------- */
  function rampScore(el, from, to) {
    const span = Math.max(1, to - from);
    let i = 0;
    const stepOnce = () => {
      i++;
      el.textContent = from + i;
      el.classList.remove('bumping');
      void el.offsetWidth;                 // restart the bump animation
      el.classList.add('bumping');
      tick(i);
      if (i < span) setTimeout(stepOnce, 120 + i * 30);   // escalating cadence
    };
    if (juiceK <= 0) { el.textContent = to; return; }
    setTimeout(stepOnce, 320);
  }

  function shake(intensity) {
    if (juiceK <= 0) return;
    const board = document.getElementById('game-board');
    if (!board) return;
    board.style.setProperty('--shake', (3 + intensity * 7).toFixed(1) + 'px');
    board.classList.remove('shaking');
    void board.offsetWidth;
    board.classList.add('shaking');
    board.addEventListener('animationend', () => board.classList.remove('shaking'), { once: true });
  }

  /* ---- the orchestrated capture -------------------------------------- */
  function playCapture({ handEl, tableEls, points, fromScore, isHaya, onDone }) {
    ensureAudio();
    const pile = document.getElementById('my-captured');
    const scoreEl = document.getElementById('score-t1-num');
    const cards = [handEl, ...tableEls];

    if (juiceK <= 0) {
      if (scoreEl) scoreEl.textContent = fromScore + points;
      if (onDone) onDone();
      return;
    }

    if (isHaya) {
      const ann = document.getElementById('shkobba-announce');
      if (ann) {
        ann.textContent = 'sabʿa l-ḥayya!';
        ann.classList.remove('hidden');
        setTimeout(() => ann.classList.add('hidden'), 1400);
      }
    }

    Promise.all(cards.map((el, n) => flyTo(el, pile, n * 130))).then(() => {
      if (scoreEl) rampScore(scoreEl, fromScore, fromScore + points);
      shake(clamp(points / 4, 0.2, 1));
      if (onDone) onDone();
    });
  }

  /* ---- FPS meter (review aid) ---------------------------------------- */
  function startFps() {
    const meter = document.getElementById('fps-meter');
    if (!meter) return;
    let last = performance.now(), frames = 0, acc = 0;
    const loop = (now) => {
      frames++; acc += now - last; last = now;
      if (acc >= 500) { meter.textContent = Math.round((frames * 1000) / acc) + ' fps'; frames = 0; acc = 0; }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  document.addEventListener('DOMContentLoaded', startFps);

  global.Juice = {
    bindCard,
    playCapture,
    setJuice(k) { juiceK = clamp(k, 0, 1); },
    setSound(on) { soundOn = !!on; },
    getJuice() { return juiceK; },
  };
})(window);
