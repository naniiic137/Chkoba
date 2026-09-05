/* Look and comfort settings.
 *   look   - theme / card style / suit set. Room-wide: the host picks it, it travels
 *            in the public state, every client applies what arrives. The host's last
 *            choice is also kept locally as the default for the next room.
 *   prefs  - labels, sound, screen shake, animations. Personal: never leave the browser.
 * Nothing here knows about Firebase; game.js calls setLook when a state arrives. */
(function (global) {
  'use strict';
  const html = document.documentElement;
  const THEMES = ['a', 'b', 'c'], CARDS = ['svg', 'photo', 'pixel'], SUITS = ['french', 'coin'];
  const HUD = { a: 'rail', b: 'top', c: 'top' };
  const DEFAULT_LOOK = { theme: 'b', cards: 'photo', suits: 'french' };
  const KEY_PREFS = 'chkobba_prefs', KEY_LOOK = 'chkobba_look';

  let look = { ...DEFAULT_LOOK };
  const prefs = { labels: 'latin', sound: true, shake: true, animations: true };

  function read(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }
  function write(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* private mode: settings just do not persist */ } }

  function normalize(l) {
    const o = l || {};
    return {
      theme: THEMES.includes(o.theme) ? o.theme : DEFAULT_LOOK.theme,
      cards: CARDS.includes(o.cards) ? o.cards : DEFAULT_LOOK.cards,
      suits: SUITS.includes(o.suits) ? o.suits : DEFAULT_LOOK.suits,
    };
  }

  function syncShader() { if (global.Shader) Shader.setEnabled(prefs.animations && Shader.wanted); }

  function applyLook() {
    html.dataset.theme = look.theme;
    Cards.setStyle(look.cards);
    Cards.setSuit(look.suits);
    const gv = document.getElementById('game-view');
    if (gv) gv.dataset.hud = HUD[look.theme];
    // the shader reads its colors from the theme tokens, which only exist after the
    // attribute change has been styled
    if (global.Shader) requestAnimationFrame(() => { Shader.retint(); syncShader(); });
  }

  function applyPrefs() {
    I18N.setMode(prefs.labels);
    Juice.setSound(prefs.sound);
    Juice.setShake(prefs.shake);
    Juice.setJuice(prefs.animations ? 1 : 0);
    html.classList.toggle('reduce', !prefs.animations);
    syncShader();
  }

  function init() {
    const saved = read(KEY_PREFS);
    if (saved) {
      Object.assign(prefs, saved);
    } else {
      // first run: honor the previous UI's two switches and the OS motion preference
      if (localStorage.getItem('chkoba_sounds') === 'false') prefs.sound = false;
      if (localStorage.getItem('chkoba_animations') === 'false') prefs.animations = false;
      if (global.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) { prefs.animations = false; prefs.shake = false; }
    }
    look = normalize(read(KEY_LOOK));
    applyPrefs();
    applyLook();
  }

  global.Look = {
    HUD, DEFAULT_LOOK, THEMES, CARDS, SUITS, prefs, normalize,
    get: () => ({ ...look }),
    // persistAsDefault: the host changing the room look also changes their default
    setLook(partial, persistAsDefault) {
      look = normalize({ ...look, ...(partial || {}) });
      applyLook();
      if (persistAsDefault) write(KEY_LOOK, look);
      return { ...look };
    },
    savedLook: () => normalize(read(KEY_LOOK)),
    setPref(key, value) { if (!(key in prefs)) return; prefs[key] = value; write(KEY_PREFS, prefs); applyPrefs(); },
    init,
  };
})(window);
