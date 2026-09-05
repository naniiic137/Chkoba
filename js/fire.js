/* Pixel fire (the classic cellular propagation) on a tiny canvas scaled up with
 * image-rendering: pixelated. Two palettes: mult (red to yellow to white) and
 * chip (blue to cyan to white). One instance per burning element; stop() lets the
 * flames die down instead of cutting them. */
(function (global) {
  'use strict';

  function palette(kind) {
    const stops = kind === 'chip'
      ? [[0, 0, 0, 0], [20, 60, 160, 255], [40, 120, 220, 255], [90, 200, 240, 255], [200, 245, 255, 255], [255, 255, 255, 255]]
      : [[0, 0, 0, 0], [120, 10, 10, 255], [220, 50, 20, 255], [250, 140, 30, 255], [255, 220, 90, 255], [255, 255, 240, 255]];
    const out = [];
    for (let i = 0; i < 36; i++) {
      const t = i / 35 * (stops.length - 1);
      const a = stops[Math.floor(t)], b = stops[Math.min(stops.length - 1, Math.floor(t) + 1)], f = t - Math.floor(t);
      out.push(a.map((v, k) => Math.round(v + (b[k] - v) * f)));
    }
    return out;
  }

  class Fire {
    constructor(host, kind, opts) {
      const o = opts || {};
      this.w = o.w || 48; this.h = o.h || 28;
      this.pal = palette(kind);
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'fire';
      this.canvas.width = this.w; this.canvas.height = this.h;
      this.ctx = this.canvas.getContext('2d');
      this.img = this.ctx.createImageData(this.w, this.h);
      this.cells = new Uint8Array(this.w * this.h);
      this.alive = true; this.fed = true; this.raf = 0; this.last = 0;
      host.appendChild(this.canvas);
      this.tick = this.tick.bind(this);
      this.raf = requestAnimationFrame(this.tick);
    }
    tick(now) {
      this.raf = 0;
      if (!this.alive) return;
      if (now - this.last > 40) {          // ~25 steps a second reads as pixel fire, 60 reads as noise
        this.last = now;
        const { w, h, cells } = this;
        // seed the bottom row while fed
        for (let x = 0; x < w; x++) cells[(h - 1) * w + x] = this.fed ? (Math.random() < 0.75 ? 35 : 28) : 0;
        for (let y = 0; y < h - 1; y++) for (let x = 0; x < w; x++) {
          const src = (y + 1) * w + x;
          const r = Math.random(); const decay = r < 0.5 ? 0 : r < 0.86 ? 1 : 2;   // mostly carries, so flames climb, but unevenly
          const dst = src - w - (Math.random() * 3 | 0) + 1;
          if (dst >= 0 && dst < cells.length) cells[dst] = Math.max(0, cells[src] - decay);
        }
        const d = this.img.data;
        for (let i = 0; i < cells.length; i++) { const c = this.pal[cells[i]]; d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = c[3]; }
        this.ctx.putImageData(this.img, 0, 0);
        if (!this.fed && !cells.some((v) => v > 0)) { this.destroy(); return; }
      }
      this.raf = requestAnimationFrame(this.tick);
    }
    stop() { this.fed = false; }
    destroy() { this.alive = false; if (this.raf) cancelAnimationFrame(this.raf); this.canvas.remove(); }
  }

  global.Fire = { create: (host, kind, opts) => new Fire(host, kind, opts) };
})(window);
