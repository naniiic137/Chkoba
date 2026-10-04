/* Background: a slow liquid swirl in WebGL, colors read from the active direction's
 * CSS tokens so a theme swap retints the shader without touching GLSL. Renders at
 * a third of the viewport and lets the browser scale it up (the softness is the
 * point). Falls back to the CSS gradient in tokens.css when WebGL is missing or
 * the page is in reduced motion. Pauses when the tab is hidden. */
(function (global) {
  'use strict';

  const VERT = 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }';
  const FRAG = `
    precision mediump float;
    uniform vec2 u_res; uniform float u_time; uniform float u_spin; uniform float u_contrast;
    uniform vec3 u_c1; uniform vec3 u_c2; uniform vec3 u_c3;
    // hash + value noise + fbm. Cheap enough for a third-res canvas on integrated GPUs.
    float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
      return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
    float fbm(vec2 p){ float v = 0.0, a = 0.5; for(int i=0;i<5;i++){ v += a*noise(p); p = p*2.03 + 17.0; a *= 0.5; } return v; }
    void main(){
      vec2 uv = (gl_FragCoord.xy - 0.5*u_res) / min(u_res.x, u_res.y);
      float r = length(uv);
      // paint-in-water: rotate by radius and time, then warp the domain twice
      float ang = atan(uv.y, uv.x) + u_spin * (0.6 * r - 0.15 * u_time);
      vec2 sp = vec2(cos(ang), sin(ang)) * r * 2.2;
      vec2 q = vec2(fbm(sp + 0.07*u_time), fbm(sp + vec2(3.1, 1.7) - 0.05*u_time));
      vec2 w = vec2(fbm(sp + 2.4*q + vec2(1.3, 9.2) + 0.03*u_time), fbm(sp + 2.4*q + vec2(8.3, 2.8)));
      float f = fbm(sp + 2.6*w);
      f = pow(clamp(f, 0.0, 1.0), u_contrast);
      vec3 col = mix(u_c1, u_c2, smoothstep(0.25, 0.65, f));
      col = mix(col, u_c3, smoothstep(0.62, 0.95, f) * 0.85);
      col *= 1.0 - 0.55 * smoothstep(0.35, 1.05, r);   // vignette in the shader, not a CSS layer
      gl_FragColor = vec4(col, 1.0);
    }`;

  let gl, canvas, prog, raf = 0, running = false, t0 = performance.now();
  let colors = [[0.1, 0.2, 0.4], [0.7, 0.8, 0.9], [0.8, 0.65, 0.3]];
  let spin = 1.0, contrast = 1.0, speed = 1.0, wanted = true;   // wanted: the direction paints a swirl at all

  function parseColor(str) {
    const c = document.createElement('canvas').getContext('2d');
    c.fillStyle = str.trim(); const hex = c.fillStyle; // normalizes to #rrggbb
    if (hex[0] !== '#') return [0, 0, 0];
    return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  }

  function readTokens() {
    const cs = getComputedStyle(document.documentElement);
    const get = (n, d) => (cs.getPropertyValue(n) || d).trim();
    colors = [parseColor(get('--swirl-1', '#1a2a4a')), parseColor(get('--swirl-2', '#c7d6e8')), parseColor(get('--swirl-3', '#c9a24b'))];
    spin = parseFloat(get('--swirl-spin', '1')) || 0;
    contrast = parseFloat(get('--swirl-contrast', '1')) || 1;
    speed = parseFloat(get('--swirl-speed', '1')) || 0;
    wanted = (parseFloat(get('--swirl-opacity', '1')) || 0) > 0;
  }

  function compile(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function init(el) {
    canvas = el;
    try { gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' }); } catch (e) { gl = null; }
    if (!gl) { document.documentElement.classList.add('no-webgl'); return false; }
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog); gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    resize();
    global.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
    readTokens();
    return true;
  }

  function resize() {
    if (!canvas) return;
    const s = 1 / 3;
    canvas.width = Math.max(64, Math.floor(innerWidth * s));
    canvas.height = Math.max(64, Math.floor(innerHeight * s));
    if (gl) gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function frame(now) {
    raf = 0;
    if (!running || !gl) return;
    const u = (n) => gl.getUniformLocation(prog, n);
    gl.uniform2f(u('u_res'), canvas.width, canvas.height);
    gl.uniform1f(u('u_time'), ((now - t0) / 1000) * speed);
    gl.uniform1f(u('u_spin'), spin);
    gl.uniform1f(u('u_contrast'), contrast);
    gl.uniform3fv(u('u_c1'), colors[0]); gl.uniform3fv(u('u_c2'), colors[1]); gl.uniform3fv(u('u_c3'), colors[2]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    raf = requestAnimationFrame(frame);
  }

  function start() { if (!gl || running) return; running = true; canvas.hidden = false; if (!raf) raf = requestAnimationFrame(frame); }
  function stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
  function setEnabled(on) { if (on) start(); else { stop(); if (canvas) canvas.hidden = true; } }
  function retint() { readTokens(); if (gl && !running) { running = true; frame(performance.now()); running = false; } }

  global.Shader = { init, start, stop, setEnabled, retint, get active() { return running; }, get wanted() { return wanted; } };
})(window);
