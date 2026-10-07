// ===================== CONSTANTS =====================
const SUIT_SYMBOLS = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };

function getCardDisplayName(card) {
  return `${card.display}${SUIT_SYMBOLS[card.suit]}`;
}

// Capture legality for hints and instant feedback (js/rules.js). The room checks every
// move again: the client only saves a round trip for a move that cannot be right.
const { legalCaptures, hasDirectMatch, checkMove } = ChkobaRules;

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}


// ===================== APP =====================
// The client never deals, scores or plays for a bot. A room does that (js/room.js): on
// the game server for online games, inside this page for an offline bot game. After
// every change the room sends a snapshot of the public state plus this seat's own
// hand; the client paints it through a render queue that derives the choreography
// from (previous, current), and sends back intentions over js/net.js. Wire keys keep
// their old names (shkobbaCount, shkobbaThisTurn).
const ROOM_OPTS_KEY = 'chkobba_room_opts';
const NAME_KEY = 'chkobba_name';
const BOT_SAVE_KEY = 'chkobba_bot_save';   // an offline bot game, so a reload can resume it
const SEAT_KEY = 'chkobba_seat_';          // + room code: { token, name, at } to take the same seat back
const SEAT_KEEP_MS = 2 * 24 * 3600 * 1000; // older seat tokens are thrown away
const ANIM_LIMIT_MS = 6000;                // no animation may hold the board longer than this

const app = {
  isHost: false,            // this seat has lobby control: the room's creator, or the next player
  myPlayerId: -1,
  roomCode: '',
  roomLink: '',
  playerCount: 2,
  forceCapture: true,
  captureAssist: false,
  winScore: 21,
  turnTimerDuration: 30,
  myName: '',
  snap: null,               // the latest snapshot from the room
  gameState: null,
  myHand: [],
  net: null,                // Net.socket (online) or Net.local (bot game)
  localRoom: null,          // the in-page room of an offline bot game
  seatToken: '',
  selectedCardIndex: -1,
  selectedCaptureIndices: [],
  availableCaptures: [],
  _rev: -1,
  _helloDone: null,
  _afterHello: null,
  _wasDropped: false,
  _toastTimer: null,
  _turnTimerStart: 0,
  _turnKey: '',
  _timerRAF: null,
  moveLog: [],
  menuOpen: false,
  menuTab: 'stats',
  isSubmittingMove: false,
  _emoteTimeout: null,
  _lastCardClickIndex: -1,
  _lastCardClickTime: 0,
  _lastTimerSec: 0,
  _verbose: false,
  _audioCtx: null,
  _audioUnlocked: false,
  _isBotGame: false,
  _awayUntil: {},
  _awayDismissed: {},
  _awayTick: null,
  // render pipeline
  _shown: null,
  _renderQueued: false,
  _animating: false,
  _pendingDealTable: false,
  _ceremonyKey: '',
  _matchKey: '',
  _ceremonySkip: false,
  _ceremonyContinue: null,
  _ceremonyDone: false,      // the tally has finished counting (its continue line is up)
  rulesPage: 0,
  // room defaults chosen on the Options screen (persisted)
  opts: { players: 2, winScore: 21, timer: 30, bot: 'medium', speed: 'normal', forceCapture: true, captureAssist: false },

  // ========== LOGGING ==========
  // Leveled logger. error/warn always print; info/debug print only in verbose mode
  // (?debug=1, or localStorage chkoba_debug="true").
  log(level, ...args) {
    if ((level === 'info' || level === 'debug') && !this._verbose) return;
    const fn = level === 'error' ? console.error
      : level === 'warn' ? console.warn
      : level === 'debug' ? console.debug
      : console.log;
    fn('[chkobba]', ...args);
  },

  _installGlobalErrorHandlers() {
    window.addEventListener('error', (e) => {
      this.log('error', 'Uncaught error:', e.message, `${e.filename}:${e.lineno}:${e.colno}`);
    });
    window.addEventListener('unhandledrejection', (e) => {
      const reason = e.reason && e.reason.message ? e.reason.message : e.reason;
      this.log('error', 'Unhandled promise rejection:', reason);
    });
  },

  // ========== BOOT ==========
  init() {
    const params = new URLSearchParams(window.location.search);
    this._verbose = params.get('debug') === '1' || localStorage.getItem('chkoba_debug') === 'true';
    this._installGlobalErrorHandlers();
    this.log('info', 'init: verbose logging', this._verbose ? 'ON' : 'OFF (add ?debug=1 to enable)');

    Look.init();
    this._loadOpts();
    this._pruneSeats();
    Shader.init(document.getElementById('bg-shader'));
    Shader.start();
    Shader.setEnabled(Look.prefs.animations && Shader.wanted);

    this.bindScreens();
    this.renderMenuCards();

    // ?room=CODE: a reload takes the same seat back; a new link asks for a name first
    const code = (params.get('room') || '').replace(/\s+/g, '').toUpperCase();
    const seat = code ? this.readSeat(code) : null;
    if (code && seat) { this.showMenu(); this.enterRoom(code, seat.name, seat.token); }
    else if (code) this.showJoin(code);
    else this.showMenu();
    this.renderResumeOffer();

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (this.menuOpen) { this.toggleMenu(); return; }
      const open = document.querySelector('.overlay.open');
      if (open && open.id !== 'ov-ceremony' && open.id !== 'ov-match') { this.closeOverlay(open.id); return; }
      if (this.gameState && this.gameState.phase === 'playing') this.cancelSelection();
    });
    // audio needs a gesture: the first pointer anywhere unlocks both sound engines
    document.addEventListener('pointerdown', () => { this._audioUnlocked = true; Juice.unlock(); }, { once: true });
    // a phone waking up or a network coming back: reconnect now and catch up
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.wake(); });
    window.addEventListener('online', () => this.wake());
    window.addEventListener('pageshow', (e) => { if (e.persisted) this.wake(); });
  },

  _loadOpts() {
    try {
      const saved = JSON.parse(localStorage.getItem(ROOM_OPTS_KEY) || 'null');
      if (saved) Object.assign(this.opts, saved);
    } catch (e) { /* ignore a corrupt entry */ }
    const name = localStorage.getItem(NAME_KEY) || '';
    document.getElementById('menu-name').value = name;
    document.getElementById('j-name').value = name;
  },
  _saveOpts() {
    try { localStorage.setItem(ROOM_OPTS_KEY, JSON.stringify(this.opts)); } catch (e) { /* private mode */ }
  },
  _rememberName(name) { try { localStorage.setItem(NAME_KEY, name); } catch (e) { /* private mode */ } },

  // ========== SCREENS ==========
  showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
    document.documentElement.dataset.screen = id.replace('screen-', '');
  },
  showMenu() { this.closeAllOverlays(); this.showScreen('screen-menu'); },
  showOptions() { this.renderOptions(); this.showScreen('screen-options'); },
  showJoin(code) {
    this.roomCode = code || '';
    document.getElementById('j-code').value = this.roomCode;
    this.showScreen('screen-join');
    document.getElementById(this.roomCode ? 'j-name' : 'j-code').focus();
  },
  showWaiting() { this.showScreen('screen-waiting'); this.renderWaiting(); },
  openOverlay(id) { document.getElementById(id).classList.add('open'); },
  closeOverlay(id) { document.getElementById(id).classList.remove('open'); },
  closeAllOverlays() { document.querySelectorAll('.overlay.open').forEach((o) => o.classList.remove('open')); this.menuOpen = false; },

  bindScreens() {
    const $ = (id) => document.getElementById(id);
    // menu
    $('m-bot').addEventListener('click', () => this.playVsBot());
    $('m-create').addEventListener('click', () => this.createGame());
    $('m-join').addEventListener('click', () => this.showJoin(''));
    $('m-rules').addEventListener('click', () => this.showRules());
    $('m-options').addEventListener('click', () => this.showOptions());
    $('m-resume').addEventListener('click', () => this.resumeBotGame());
    $('m-discard').addEventListener('click', () => { this.clearBotSave(); this.renderResumeOffer(); });
    $('left-wait').addEventListener('click', () => this.waitForPlayer());
    $('left-claim').addEventListener('click', (e) => this.awayDecision('end', e.currentTarget));
    $('left-bot').addEventListener('click', (e) => this.awayDecision('bot', e.currentTarget));
    $('away-claim').addEventListener('click', (e) => this.awayDecision('end', e.currentTarget));
    $('away-bot').addEventListener('click', (e) => this.awayDecision('bot', e.currentTarget));
    document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => this.showScreen(b.dataset.back)));
    // join
    $('j-go').addEventListener('click', () => this.joinGame());
    $('j-back').addEventListener('click', () => this.showMenu());
    $('j-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.joinGame(); });
    $('menu-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.playVsBot(); });
    // waiting
    $('w-copy').addEventListener('click', () => this.copyRoomLink());
    $('w-leave').addEventListener('click', () => this.leaveRoom());
    $('w-start').addEventListener('click', () => this.startGame());
    $('w-slots').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      this.lobbyAction(b.dataset.act, +b.dataset.slot, b);
    });
    // options: room defaults
    this.bindSeg($('o-players'), () => this.opts.players, (v) => { this.opts.players = v; this._saveOpts(); });
    this.bindSeg($('o-win'), () => this.opts.winScore, (v) => { this.opts.winScore = v; this._saveOpts(); });
    this.bindSeg($('o-timer'), () => this.opts.timer, (v) => { this.opts.timer = v; this._saveOpts(); });
    this.bindSeg($('o-bot'), () => this.opts.bot, (v) => { this.opts.bot = v; this._saveOpts(); });
    this.bindSeg($('o-speed'), () => this.opts.speed, (v) => { this.opts.speed = v; this._saveOpts(); });
    this.bindSeg($('o-force'), () => this.opts.forceCapture, (v) => { this.opts.forceCapture = v; this._saveOpts(); });
    this.bindSeg($('o-assist'), () => this.opts.captureAssist, (v) => { this.opts.captureAssist = v; this._saveOpts(); });
    // options: look (the host's default for the next room, applied right away so it can be seen)
    this.bindSeg($('o-theme'), () => Look.get().theme, (v) => this.setLookLocal({ theme: v }));
    this.bindSeg($('o-cards'), () => Look.get().cards, (v) => this.setLookLocal({ cards: v }));
    this.bindSeg($('o-suits'), () => Look.get().suits, (v) => this.setLookLocal({ suits: v }));
    // options: personal
    this.bindSeg($('o-shake'), () => Look.prefs.shake, (v) => Look.setPref('shake', v));
    this.bindSeg($('o-anim'), () => Look.prefs.animations, (v) => Look.setPref('animations', v));
    this.bindSeg($('o-labels'), () => Look.prefs.labels, (v) => { Look.setPref('labels', v); this.renderMenuCards(); if (this.gameState) this.renderGame(); });
    this.bindSeg($('o-sound'), () => Look.prefs.sound, (v) => { Look.setPref('sound', v); if (v) this.playSound('click'); });
    // game hud + actions
    $('hud-gear').addEventListener('click', () => this.toggleMenu());
    $('btn-capture').addEventListener('click', () => this.confirmCapture());
    $('btn-place').addEventListener('click', () => this.placeCard());
    $('btn-cancel').addEventListener('click', () => this.cancelSelection());
    $('emote-bar').addEventListener('click', (e) => { const b = e.target.closest('[data-emote]'); if (b) this.sendEmote(b.dataset.emote); });
    $('gm-emotes').addEventListener('click', (e) => { const b = e.target.closest('[data-emote]'); if (b) { this.toggleMenu(); this.sendEmote(b.dataset.emote); } });
    // side menu
    document.querySelectorAll('#ov-gamemenu .tabs button').forEach((b) => b.addEventListener('click', () => this.switchMenuTab(b.dataset.t)));
    $('gm-settings').addEventListener('click', (e) => { const b = e.target.closest('button[data-set]'); if (b) this.onMenuSetting(b.dataset.set, b.dataset.v); });
    $('gm-copy').addEventListener('click', () => this.copyRoomLink());
    $('gm-rules').addEventListener('click', () => { this.toggleMenu(); this.showRules(); });
    $('gm-surrender').addEventListener('click', () => this.surrenderGame());
    $('gm-leave').addEventListener('click', () => { this.toggleMenu(); this.backToLobby(); });
    // overlays
    document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { this.closeOverlay(b.dataset.close); if (b.dataset.close === 'ov-gamemenu') this.menuOpen = false; }));
    document.querySelectorAll('.overlay').forEach((o) => o.addEventListener('pointerdown', (e) => {
      if (e.target !== o) return;
      if (o.id === 'ov-ceremony' || o.id === 'ov-match') return;
      this.closeOverlay(o.id); if (o.id === 'ov-gamemenu') this.menuOpen = false;
    }));
    $('rules-prev').addEventListener('click', () => { this.rulesPage = (this.rulesPage + I18N.RULES.length - 1) % I18N.RULES.length; this.renderRules(); Juice.tick(1); });
    $('rules-next').addEventListener('click', () => { this.rulesPage = (this.rulesPage + 1) % I18N.RULES.length; this.renderRules(); Juice.tick(2); });
    $('match-again').addEventListener('click', () => this.rematch());
    $('match-menu').addEventListener('click', () => this.backToLobby());
    // ceremony: a tap skips the count, then continues (host) once the tally is complete
    $('ov-ceremony').addEventListener('pointerdown', () => {
      if (this._ceremonyContinue) { const c = this._ceremonyContinue; this._ceremonyContinue = null; c(); return; }
      this._ceremonySkip = true;
    });
    document.addEventListener('keydown', (e) => {
      if (!$('ov-ceremony').classList.contains('open')) return;
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); $('ov-ceremony').dispatchEvent(new PointerEvent('pointerdown')); }
    });
  },

  // A segmented control: buttons carry data-v; get() supplies the current value,
  // set(v) receives it typed (booleans and numbers come back as such).
  bindSeg(el, get, set) {
    const sync = () => { const cur = String(get()); el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === cur)); };
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b || el.getAttribute('aria-disabled') === 'true') return;
      const raw = b.dataset.v;
      const v = raw === 'true' ? true : raw === 'false' ? false : (raw !== '' && !isNaN(raw)) ? +raw : raw;
      set(v); sync(); Juice.tick(0);
    });
    el._sync = sync;
    sync();
  },
  renderOptions() { document.querySelectorAll('#screen-options .seg').forEach((el) => el._sync && el._sync()); },

  // The Options screen changes the look immediately (so the change can be seen) and
  // stores it as the default for the next room. In a running room only the host's
  // in-game menu changes it, because it has to reach every player.
  setLookLocal(partial) { Look.setLook(partial, true); this.renderMenuCards(); if (this.gameState) this.renderGame(); },

  renderMenuCards() {
    const box = document.getElementById('hero-cards'); box.innerHTML = '';
    [{ id: 16, suit: 'diamonds', name: '7', display: '7', value: 7 }, { id: 30, suit: 'spades', name: 'ace', display: 'A', value: 1 }, { id: 26, suit: 'clubs', name: '7', display: '7', value: 7 }]
      .forEach((c) => box.appendChild(Cards.build(c, { interactive: true, idle: true })));
  },

  // fallback: a name to use when the field is empty (a bot game needs no real name);
  // without one an empty field is refused.
  readName(inputId, fallback) {
    const typed = document.getElementById(inputId).value.trim();
    if (!typed && fallback) return fallback;
    if (!typed) { this.toast('Enter your name first'); document.getElementById(inputId).focus(); return null; }
    this._rememberName(typed);
    return typed;
  },

  // ========== ROOMS ==========
  // The game server is this site, unless server.js points somewhere else (the copy of
  // the page on Cloudflare Pages talks to the Worker).
  wsUrl(code) { return (window.GAME_SERVER || location.origin).replace(/^http/, 'ws') + '/ws?room=' + code; },
  apiUrl(path) { return (window.GAME_SERVER || '') + path; },

  roomOpts() {
    return {
      players: +this.opts.players, winScore: +this.opts.winScore, timer: +this.opts.timer, bot: this.opts.bot, speed: this.opts.speed,
      forceCapture: !!this.opts.forceCapture, captureAssist: !!this.opts.captureAssist, look: Look.savedLook(),
    };
  },

  // A button that waits on the network shows it, and always comes back: on the answer,
  // on an error or after a timeout. The lobby is repainted after, so a button that
  // should stay off (Start in a half-empty room) is off again.
  async busy(btn, work) {
    if (btn && btn.classList.contains('pending')) return;
    if (btn) { btn.disabled = true; btn.classList.add('pending'); }
    try { return await work(); } catch (e) { this.log('error', 'action failed:', e); return null; } finally {
      if (btn) { btn.disabled = false; btn.classList.remove('pending'); }
      if (this.snap && !this.snap.game && !this._isBotGame) this.renderWaiting();
    }
  },

  // A request to the room. A refusal gets a plain-words toast; a drop or a timeout
  // asks the room for a fresh snapshot. Resolves with the ack, or null.
  async ask(type, data) {
    if (!this.net) return null;
    try {
      const ack = await this.net.emit(type, data);
      if (!ack.ok) this.toast(this.errorText(ack));
      return ack;
    } catch (e) {
      this.toast(e.message === 'timeout' ? 'The server is slow to answer, try again' : 'Not connected, try again in a moment');
      this.resync();
      return null;
    }
  },

  errorText(ack) {
    return {
      'not-owner': 'Only the host can do that', 'not-full': 'Not enough players', away: `Waiting for ${ack.name || 'a player'} to come back`,
      taken: 'That seat was just taken', started: 'The game has already started', 'slow-down': 'Slow down a little',
      phase: 'Not right now', 'not-away': 'They are back',
    }[ack.error] || 'That did not work, try again';
  },

  async createGame() {
    const name = this.readName('menu-name'); if (!name) return;
    Juice.unlock();
    await this.busy(document.getElementById('m-create'), async () => {
      let code = '';
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      try {
        const res = await fetch(this.apiUrl('/api/rooms'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ opts: this.roomOpts() }), signal: ctl.signal,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.code) throw new Error(body.error || 'HTTP ' + res.status);
        code = body.code;
      } catch (e) {
        this.log('error', 'room creation failed:', e.message);
        this.toast('Could not create the room. Check your connection and try again.');
        return;
      } finally {
        clearTimeout(timer);
      }
      this.log('info', 'room created', code);
      await this.enterRoom(code, name, '');
    });
  },

  async joinGame() {
    const code = document.getElementById('j-code').value.replace(/\s+/g, '').toUpperCase();
    if (!code) { this.toast('Enter the room code'); return; }
    if (!ChkobaRoom.isRoomCode(code)) { this.toast('A room code is 8 letters and digits'); return; }
    const seat = this.readSeat(code);
    const name = this.readName('j-name', seat ? seat.name : ''); if (!name) return;
    Juice.unlock();
    await this.busy(document.getElementById('j-go'), () => this.enterRoom(code, name, seat ? seat.token : ''));
  },

  // Opens the room's socket and takes a seat, or the same seat again with its token.
  // Resolves once the room has answered (or after a while), so the button that started
  // it comes back either way.
  enterRoom(code, name, token) {
    this.closeRoom();
    this.roomCode = code;
    this.myName = name;
    this.seatToken = token || '';
    this._isBotGame = false;
    this._wasDropped = false;
    this.roomLink = location.origin + '/?room=' + code;
    this._setUrlRoom(code);
    if (!token) this.showWaiting();
    else this.toast('Joining the game');
    const net = Net.socket(this.wsUrl(code));
    this.net = net;
    this.bindNet(net);
    return new Promise((resolve) => {
      this._helloDone = resolve;
      setTimeout(resolve, 12000);
    });
  },

  bindNet(net) {
    const live = (fn) => (...a) => { if (this.net === net) fn(...a); };
    net.on('open', live(() => this.sayHello()));
    net.on('state', live((m) => this.applySnapshot(m.s)));
    net.on('notice', live((m) => { this.toast(m.text); if (/ran out of time/.test(m.text)) this.playSound('timeout'); }));
    net.on('emote', live((m) => this.showEmote(m.name, m.text)));
    net.on('status', live((s) => this.renderNet(s)));
    net.on('timeout', live(() => this.resync()));
    net.on('fatal', live((why) => this.roomLost(why)));
  },

  async sayHello() {
    const net = this.net;
    this._rev = -1;   // a new socket: take whatever the room sends next as current
    let ack;
    try { ack = await net.emit('hello', { name: this.myName, token: this.seatToken }); } catch (e) { return; }   // dropped again: the next 'open' says hello again
    if (this.net !== net) return;
    const done = this._helloDone; this._helloDone = null;
    if (!ack.ok) {
      const why = { full: 'Room is full', started: 'That game has already started', name: 'Enter your name first' }[ack.error] || 'Could not join the room';
      const code = this.roomCode;
      if (this.seatToken) this.forgetSeat(code);
      this.closeRoom();
      this._setUrlRoom('');
      this.toast(why);
      this.showJoin(code);
      if (done) done();
      return;
    }
    const resumed = !!ack.resumed;
    this.seatToken = ack.token;
    this.myPlayerId = ack.seat;
    if (!this._isBotGame) this.rememberSeat(this.roomCode, { token: ack.token, name: this.myName, at: Date.now() });
    if (this._wasDropped) this.toast('Reconnected');
    else if (resumed && !this._isBotGame) this.toast('Back in the game');
    this._wasDropped = false;
    this.log('info', 'seated in', this.roomCode, 'as', ack.seat, resumed ? '(resumed)' : '');
    if (done) done();
    if (this._afterHello) { const next = this._afterHello; this._afterHello = null; next().catch((e) => this.log('error', 'bot game setup failed:', e)); }
  },

  // Asks the room for a full snapshot: after a timeout, a refused move, or waking up.
  resync() {
    if (this.net && this.net.status === 'open') this.net.emit('sync').catch(() => {});
  },

  wake() {
    if (!this.net) return;
    this.net.wake();
    this.resync();
  },

  // The room is gone or refused this browser for good.
  roomLost(why) {
    const text = {
      'not-found': 'That room does not exist anymore', replaced: 'This game is open in another tab',
      closed: 'The room has closed', unreachable: 'Could not reach the game server. Check your connection.',
    }[why] || 'Connection lost';
    const code = this.roomCode;
    if (why === 'not-found' || why === 'closed') this.forgetSeat(code);
    const done = this._helloDone; this._helloDone = null;
    this.closeRoom();
    this._setUrlRoom('');
    this.toast(text);
    if (why === 'unreachable' && code) this.showJoin(code); else this.showMenu();
    this.renderResumeOffer();
    if (done) done();
  },

  // Forgets the room on this side only: closes the socket or stops the in-page room.
  closeRoom() {
    const net = this.net;
    this.net = null;
    if (net) net.close();
    const done = this._helloDone; this._helloDone = null;
    if (done) done();   // the button that opened this room comes back now
    if (this.localRoom) { this.localRoom.destroy(); this.localRoom = null; }
    this.snap = null; this._rev = -1;
    this.gameState = null; this._shown = null; this.myHand = []; this.myPlayerId = -1; this.isHost = false;
    this.selectedCardIndex = -1; this.selectedCaptureIndices = []; this.availableCaptures = [];
    this.isSubmittingMove = false; this._afterHello = null;
    this.moveLog = []; this._awayUntil = {}; this._awayDismissed = {};
    this._ceremonyKey = ''; this._matchKey = ''; this._ceremonyContinue = null; this._ceremonyDone = false;
    this.stopTurnTimer();
    this.closeAllOverlays();
    this.renderAway();
    this.renderNet('');
  },

  // Leaving on purpose: the room is told (a lobby seat is freed; in a game the others
  // are asked what to do), the seat token is forgotten, and a bot game ends for good.
  leaveRoom() {
    const net = this.net;
    if (net) {
      this.net = null;
      const bye = () => net.close();
      net.emit('leave').then(bye, bye);
      setTimeout(bye, 1500);
    }
    if (this.roomCode && !this._isBotGame) this.forgetSeat(this.roomCode);
    if (this._isBotGame) this.clearBotSave();
    this.closeRoom();
    this._isBotGame = false;
    this.roomCode = '';
    this.roomLink = '';
    this._setUrlRoom('');
    this.showMenu();
    this.renderResumeOffer();
  },
  backToLobby() { this.leaveRoom(); },

  // ---- seat tokens: one per room, so a reload resumes the same seat and hand ----
  readSeat(code) {
    try {
      const v = JSON.parse(localStorage.getItem(SEAT_KEY + code) || 'null');
      return v && typeof v.token === 'string' ? v : null;
    } catch (e) { return null; }
  },
  rememberSeat(code, v) { try { localStorage.setItem(SEAT_KEY + code, JSON.stringify(v)); } catch (e) { /* private mode: no resume */ } },
  forgetSeat(code) { try { localStorage.removeItem(SEAT_KEY + code); } catch (e) { /* ignore */ } },
  _pruneSeats() {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(SEAT_KEY)) continue;
        const v = JSON.parse(localStorage.getItem(k) || 'null');
        if (!v || !v.at || Date.now() - v.at > SEAT_KEEP_MS) localStorage.removeItem(k);
      }
    } catch (e) { /* ignore */ }
  },
  _setUrlRoom(code) {
    try {
      const u = new URL(location.href);
      if (code) u.searchParams.set('room', code); else u.searchParams.delete('room');
      history.replaceState(null, '', u.pathname + u.search + u.hash);
    } catch (e) { /* ignore */ }
  },

  // ========== SNAPSHOTS ==========
  // Everything on screen comes from here: the public state, my hand, the seats.
  applySnapshot(s) {
    if (!s || typeof s.rev !== 'number' || s.rev <= this._rev) return;   // older than what is shown
    this._rev = s.rev;
    this.snap = s;
    this.myPlayerId = s.you;
    this.isHost = s.owner === s.you;
    this.playerCount = s.opts.players;
    this.forceCapture = s.opts.forceCapture;
    this.captureAssist = s.opts.captureAssist;
    this.winScore = s.opts.winScore;
    this.turnTimerDuration = s.opts.timer;
    this.moveLog = s.log || [];
    const now = Date.now();
    s.seats.forEach((x) => { if (x && x.away) this._awayUntil[x.id] = now + x.away.holdLeft; else if (x) { delete this._awayUntil[x.id]; delete this._awayDismissed[x.id]; } });
    Look.setLook(s.game ? s.game.look : s.opts.look, false);
    if (!s.game) {
      if (this.gameState) { this.gameState = null; this._shown = null; this.closeAllOverlays(); this.stopTurnTimer(); }
      this.myHand = [];
      if (!this._isBotGame) this.showWaiting();   // a bot game sits in the lobby for one tick only
    } else {
      this.handleStateUpdate(s.game, s.hand);
    }
    if (this.menuOpen) this.renderMenuContent();
    document.getElementById('match-again').hidden = !this.isHost;   // the host may have changed
    // the host may have changed while the tally is up: its continue line follows
    if (this._ceremonyDone && this.gameState && this.gameState.phase === 'round_end' && document.getElementById('ov-ceremony').classList.contains('open')) this.setContinue();
    this.renderAway();
  },

  handleStateUpdate(data, hand) {
    const oldState = this.gameState;
    const turnChanged = !oldState || oldState.currentTurn !== data.currentTurn || oldState.moveSeq !== data.moveSeq || oldState.gameToken !== data.gameToken;
    this.gameState = {
      ...data,
      lastMove: data.lastMove ? { ...data.lastMove, taken: data.lastMove.taken || [] } : null,
      nextDealerTurn: data.nextDealerTurn !== -1 ? data.nextDealerTurn : undefined,
    };
    this.myHand = hand || [];
    if (turnChanged) {
      this.selectedCardIndex = -1;
      this.selectedCaptureIndices = [];
      this.availableCaptures = [];
      // a tap from the previous turn must not pair with this turn's first tap as a double tap
      this._lastCardClickIndex = -1;
    }
    // the turn clock: the room says how much is left, this browser counts it down
    const total = (data.turnTimerDuration || 0) * 1000;
    if (total > 0 && data.turnMsLeft > 0) this._turnTimerStart = Date.now() - (total - data.turnMsLeft);
    else if (turnChanged) this._turnTimerStart = Date.now();
    if (oldState && oldState.phase !== 'finished' && data.phase === 'finished') this.playSound('win');
    this.renderGame();
    if (data.phase === 'playing' && data.currentTurn >= 0) this.startTurnTimer();
    else this.stopTurnTimer();
  },

  // The seat this browser plays.
  activeId() { return this.myPlayerId; },

  // A small banner while the socket is down; the snapshot after the reconnect catches up.
  renderNet(status) {
    const el = document.getElementById('net-banner');
    if (status === 'reconnecting') this._wasDropped = true;
    el.hidden = !(this.snap && (status === 'reconnecting' || status === 'connecting'));
  },

  // ========== WAITING ROOM ==========
  renderWaiting() {
    const $ = (id) => document.getElementById(id);
    const s = this.snap;
    $('w-code').textContent = this.roomCode;
    $('w-link').textContent = this.roomLink;
    const btn = $('w-start');
    if (!s) {
      $('w-sub').textContent = 'share the code or the link';
      $('w-slots').innerHTML = '';
      $('w-note').textContent = 'connecting to the room';
      btn.hidden = true;
      return;
    }
    const me = s.seats[s.you];
    $('w-sub').textContent = this.isHost ? 'share the code or the link' : 'joined as ' + (me ? me.name : this.myName);
    const box = $('w-slots'); box.innerHTML = '';
    const n = s.opts.players;
    const order = n === 4 ? [0, 2, 1, 3] : [0, 1];   // teams read as columns: team 1 left, team 2 right
    order.forEach((slot) => {
      const d = document.createElement('div');
      const team = n === 4 ? (slot % 2) + 1 : slot + 1;
      const who = s.seats[slot];
      d.className = `slot t${team}${who ? '' : ' empty'}`;
      if (who) {
        const btns = [];
        if (this.isHost && who.bot) btns.push(`<button class="pill sm ghost" data-act="removebot" data-slot="${slot}" aria-label="Remove ${escapeHtml(who.name)}">✕</button>`);
        if (this.isHost && n === 4) btns.push(`<button class="pill sm ghost" data-act="swap" data-slot="${slot}" aria-label="Move ${escapeHtml(who.name)} to the other team">⇄</button>`);
        const role = n === 4 ? `Team ${team}` : slot === s.owner ? 'host' : who.bot ? 'bot' : 'guest';
        const extra = (n === 4 && slot === s.owner ? ' · host' : '') + (who.connected ? '' : ' · reconnecting');
        d.innerHTML = `<div class="av">${who.bot ? 'BOT' : escapeHtml(who.name.charAt(0).toUpperCase())}</div>
          <div class="who">${who.bot ? '<span class="bot">bot</span>' : ''}${escapeHtml(who.name)}${slot === s.you ? ' (you)' : ''}<small>${role}${extra}</small></div>
          <div class="btns">${btns.join('')}</div>`;
      } else if (this.isHost) {
        d.innerHTML = `<span>empty</span><div class="btns"><button class="pill sm chip" data-act="addbot" data-slot="${slot}">+ bot</button></div>`;
      } else {
        d.textContent = 'waiting for a player';
      }
      box.appendChild(d);
    });
    const remaining = s.seats.filter((x) => !x).length;
    btn.hidden = !this.isHost;
    if (this.isHost && !btn.classList.contains('pending')) btn.disabled = remaining > 0;
    $('w-note').textContent = remaining > 0
      ? `waiting for ${remaining} more player${remaining !== 1 ? 's' : ''}`
      : this.isHost ? 'everyone is here' : 'the host starts the game';
  },

  lobbyAction(act, slot, btn) {
    const type = { addbot: 'addBot', removebot: 'removeBot', swap: 'swap' }[act];
    if (type) this.busy(btn, () => this.ask(type, { slot }));
  },

  startGame() { this.busy(document.getElementById('w-start'), () => this.ask('start')); },

  copyRoomLink() {
    const link = this.roomLink;
    if (!link) { this.toast('No room link in a bot game'); return; }
    const fallback = () => {
      // no clipboard API (plain http on a LAN): select-and-copy, else show the link
      const ta = document.createElement('textarea');
      ta.value = link; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      this.toast(ok ? 'Link copied' : 'Share this link: ' + link);
    };
    if (!navigator.clipboard || !navigator.clipboard.writeText) { fallback(); return; }
    navigator.clipboard.writeText(link).then(() => this.toast('Link copied'), fallback);
  },

  // ========== A PLAYER AWAY ==========
  // A dropped player keeps their seat for 60 s (a banner counts it down). After that the
  // others choose: wait, let a bot play the seat, or end the game. A player who comes
  // back with the same link always gets the seat, and the hand, back.
  renderAway() {
    const s = this.snap, gs = this.gameState;
    const banner = document.getElementById('away-banner'), ov = document.getElementById('ov-left');
    clearTimeout(this._awayTick); this._awayTick = null;
    const live = !!s && !!gs && (gs.phase === 'playing' || gs.phase === 'round_end') && !this._isBotGame;
    const gone = live ? s.seats.filter((x) => x && x.away && x.id !== s.you && !x.takeover) : [];
    if (!gone.length) { banner.hidden = true; ov.classList.remove('open'); return; }
    const names = (list) => list.map((x) => x.name).join(' and ');
    const expired = gone.filter((x) => x.away.expired);
    const holding = gone.filter((x) => !x.away.expired);
    const botBtn = document.getElementById('away-bot'), claimBtn = document.getElementById('away-claim');
    banner.hidden = false;
    if (expired.length) {
      const me = gs.players[s.you];
      const ownTeam = !!me && expired.every((x) => gs.players[x.id].team === me.team);
      const verb = ownTeam ? 'End the game' : 'Claim the win';
      document.getElementById('away-text').textContent = `${names(expired)} left the game`;
      claimBtn.textContent = verb; claimBtn.hidden = false; botBtn.hidden = false;
      document.getElementById('left-title').textContent = `${names(expired)} left the game`;
      document.getElementById('left-text').textContent = `Let a bot play their cards, or ${verb.toLowerCase()}. If they open the same link again, they get their seat back.`;
      document.getElementById('left-claim').textContent = verb;
      if (expired.some((x) => !this._awayDismissed[x.id])) ov.classList.add('open');
      return;
    }
    ov.classList.remove('open');
    claimBtn.hidden = true; botBtn.hidden = true;
    const until = Math.max(...holding.map((x) => this._awayUntil[x.id] || 0));
    const secs = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    document.getElementById('away-text').textContent = `${names(holding)} lost connection. Keeping the seat for ${secs}s`;
    this._awayTick = setTimeout(() => this.renderAway(), 1000);
  },

  waitForPlayer() {
    if (this.snap) this.snap.seats.forEach((x) => { if (x && x.away && x.away.expired) this._awayDismissed[x.id] = true; });
    this.closeOverlay('ov-left');
    this.toast('Waiting: they can come back with the same link');
  },

  // 'bot': a bot plays the gone seats until their players come back.
  // 'end': the side that is still here wins by forfeit.
  awayDecision(action, btn) {
    const s = this.snap;
    if (!s) return;
    const gone = s.seats.filter((x) => x && x.away && x.away.expired && x.id !== s.you && !x.takeover);
    if (!gone.length) return;
    this.closeOverlay('ov-left');
    const targets = action === 'bot' ? gone : gone.slice(0, 1);
    this.busy(btn, async () => { for (const x of targets) await this.ask('away', { seat: x.id, action }); });
  },

  // ========== PLAY VS BOT (offline) ==========
  // A bot game is a room like any other, run inside this page: the same referee and
  // the same snapshots, no network at all. It is saved after every change so a reload
  // or a closed tab can resume it.
  playVsBot() {
    const name = this.readName('menu-name', 'Player'); if (!name) return;
    Juice.unlock();
    const room = new ChkobaRoom.Room({ ...this.roomOpts(), players: 2, code: 'BOT' }, this.localEnv());
    this.startLocalRoom(room, name, '');
    this._afterHello = async () => {
      const net = this.net;
      if (!net) return;
      await net.emit('addBot', { slot: 1, level: this.opts.bot });
      await net.emit('start');
    };
  },

  localEnv() {
    // alone with a bot, the tally waits for the player's tap instead of moving on after 30 s
    return { autoContinueMs: 0, onChange: (room) => this.saveBotGame(room), log: (level, ...a) => this.log(level, '[room]', ...a) };
  },

  startLocalRoom(room, name, token) {
    this.closeRoom();
    this._isBotGame = true;
    this.localRoom = room;
    this.roomCode = 'BOT';
    this.roomLink = '';
    this.myName = name;
    this.seatToken = token || '';
    this._setUrlRoom('');
    const net = Net.local(room);
    this.net = net;
    this.bindNet(net);
  },

  saveBotGame(room) {
    if (room !== this.localRoom || !room.gs) return;
    if (room.gs.phase === 'finished') { this.clearBotSave(); return; }
    try {
      localStorage.setItem(BOT_SAVE_KEY, JSON.stringify({ v: 2, savedAt: Date.now(), name: this.myName, room: room.serialize() }));
    } catch (e) { /* private mode or full storage: the game just cannot be resumed */ }
  },

  readBotSave() {
    try {
      const save = JSON.parse(localStorage.getItem(BOT_SAVE_KEY) || 'null');
      const gs = save && save.room && save.room.gs;
      if (!save || save.v !== 2 || !gs || !Array.isArray(gs.hands) || !Array.isArray(gs.deck) || !Array.isArray(gs.players)) return null;
      if (gs.phase === 'finished' || !save.room.seats || !save.room.seats[0]) return null;
      return save;
    } catch (e) { return null; }
  },

  clearBotSave() { try { localStorage.removeItem(BOT_SAVE_KEY); } catch (e) { /* ignore */ } },

  renderResumeOffer() {
    const box = document.getElementById('resume-box');
    const save = this.readBotSave();
    box.hidden = !save;
    if (!save) return;
    const gs = save.room.gs;
    const opp = gs.players[1] ? gs.players[1].name : 'the bot';
    document.getElementById('resume-text').textContent =
      `Resume your game vs ${opp}? ${gs.scores[0]} - ${gs.scores[1]}, deal ${Math.min(gs.roundNum + 1, gs.totalRounds)}/${gs.totalRounds}`;
  },

  resumeBotGame() {
    const save = this.readBotSave();
    if (!save) { this.renderResumeOffer(); this.toast('No saved game'); return; }
    Juice.unlock();
    let room;
    try { room = ChkobaRoom.Room.restore(save.room, this.localEnv()); } catch (e) {
      this.log('error', 'saved game unreadable:', e);
      this.clearBotSave(); this.renderResumeOffer(); this.toast('That saved game could not be loaded');
      return;
    }
    const seat = save.room.seats[0];
    document.getElementById('resume-box').hidden = true;
    this.startLocalRoom(room, save.name || seat.name, seat.token);
    this.log('info', 'bot game resumed:', save.room.gs.scores[0], '-', save.room.gs.scores[1]);
  },

  // ========== TURN TIMER (display) ==========
  // The room runs the clock and plays for a player who runs out of time; this only
  // draws it. One anchor per turn, so a setting changed mid-turn does not reset it.
  turnKey(gs) { return gs ? `${gs.gameToken}:${gs.roundNum}:${gs.moveSeq}:${gs.currentTurn}` : ''; },

  startTurnTimer() {
    if (this._timerRAF) { cancelAnimationFrame(this._timerRAF); this._timerRAF = null; }
    const gs = this.gameState;
    if (!gs) return;
    const key = this.turnKey(gs);
    if (key !== this._turnKey) { this._turnKey = key; this._lastTimerSec = 0; }
    if (gs.phase !== 'playing' || gs.currentTurn < 0) { this.renderTurnLabel(gs); return; }
    this.animateTurnFill();
  },

  stopTurnTimer() {
    if (this._timerRAF) { cancelAnimationFrame(this._timerRAF); this._timerRAF = null; }
  },

  // The turn label is its own progress bar: the text drains as the timer runs. With
  // no timer, an opponent's turn breathes slowly and mine sits full.
  animateTurnFill() {
    const el = document.getElementById('turn-fill');
    const tick = () => {
      this._timerRAF = null;
      const gs = this.gameState;
      if (!gs || gs.phase !== 'playing' || gs.currentTurn < 0) return;
      const duration = gs.turnTimerDuration || 0;
      const mine = gs.currentTurn === this.activeId();
      if (duration > 0) {
        const totalMs = duration * 1000;
        const remaining = Math.max(0, totalMs - (Date.now() - this._turnTimerStart));
        Juice.fill(el, remaining / totalMs);
        const secs = Math.ceil(remaining / 1000);
        el.classList.toggle('urgent', secs <= 5 && secs > 0);
        if (mine && secs <= 5 && secs > 0 && this._lastTimerSec !== secs) {
          this._lastTimerSec = secs;
          this.playSound('warning');
        }
        if (remaining <= 0) return;
      } else if (mine) {
        Juice.fill(el, 1);
      } else {
        Juice.fill(el, 0.55 + 0.45 * Math.sin(Date.now() / 600));
      }
      this._timerRAF = requestAnimationFrame(tick);
    };
    this._timerRAF = requestAnimationFrame(tick);
  },

  // ========== PLAYER ACTIONS ==========
  canAct() {
    const gs = this.gameState;
    if (!gs || !this.net || this.net.status !== 'open') return false;
    return gs.phase === 'playing' && gs.currentTurn === this.activeId() && !this.isSubmittingMove && !this._animating;
  },

  onCardClick(index) {
    if (!this.canAct()) return;
    const gs = this.gameState;
    this.playSound('click');

    // double tap places the card
    const now = Date.now();
    if (this._lastCardClickIndex === index && (now - this._lastCardClickTime) < 300) {
      this._lastCardClickIndex = -1;
      this._lastCardClickTime = 0;
      this.onCardDblClick(index);
      return;
    }
    this._lastCardClickIndex = index;
    this._lastCardClickTime = now;

    if (this.selectedCardIndex === index) { this.cancelSelection(); return; }
    const card = this.myHand[index];
    if (!card) return;
    this.selectedCardIndex = index;
    this.selectedCaptureIndices = [];
    this.availableCaptures = legalCaptures(gs.tableCards, card.value);
    // assist: a single possible take is picked for you; without it you pick every card
    if (gs.captureAssist && this.availableCaptures.length === 1) {
      this.selectedCaptureIndices = this.availableCaptures[0].map((i) => gs.tableCards[i].id);
    }
    this.refreshSelection();
  },

  onCardDblClick(index) {
    if (!this.canAct()) return;
    const gs = this.gameState;
    this.selectedCardIndex = index;
    const card = this.myHand[index];
    if (!card) return;
    this.selectedCaptureIndices = [];
    this.availableCaptures = legalCaptures(gs.tableCards, card.value);
    this.refreshSelection();
    this.placeCard();
  },

  onTableCardClick(index) {
    if (!this.canAct() || this.selectedCardIndex === -1) return;
    const gs = this.gameState;
    const card = gs.tableCards[index];
    if (!card) return;
    // with assist only cards that belong to some take are clickable
    if (gs.captureAssist && !this.availableCaptures.some((c) => c.includes(index))) return;
    this.playSound('click');
    const idx = this.selectedCaptureIndices.indexOf(card.id);
    if (idx >= 0) this.selectedCaptureIndices.splice(idx, 1);
    else this.selectedCaptureIndices.push(card.id);
    this.refreshSelection();
  },

  onCardKeydown(event, zone, index) {
    if (event.key === 'i' && zone === 'hand' && this.myHand[index]) { this.showInfo(this.myHand[index], true); return; }
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
    event.preventDefault();
    if (zone === 'hand') this.onCardClick(index);
    else this.onTableCardClick(index);
  },

  placeCard() {
    const gs = this.gameState;
    if (this.selectedCardIndex === -1 || !gs) return;
    const card = this.myHand[this.selectedCardIndex];
    if (!card) return;
    const verdict = checkMove(this.myHand, gs.tableCards, card.id, [], gs.forceCapture);
    if (!verdict.ok) { this.blockedMove(verdict, card); return; }
    this.sendMove(card.id, []);
  },

  confirmCapture() {
    if (this.selectedCardIndex === -1) { this.toast('Pick a card from your hand first'); return; }
    if (this.selectedCaptureIndices.length === 0) { this.toast('Pick the table cards to take'); return; }
    const card = this.myHand[this.selectedCardIndex];
    const gs = this.gameState;
    if (!card || !gs) return;
    const verdict = checkMove(this.myHand, gs.tableCards, card.id, this.selectedCaptureIndices, gs.forceCapture);
    if (!verdict.ok) { this.blockedMove(verdict, card); return; }
    this.sendMove(card.id, this.selectedCaptureIndices.slice());
  },

  // A move the rules refuse: say why and light up the table card(s) that must be taken.
  blockedMove(verdict, card) {
    const gs = this.gameState;
    const must = (verdict.mustTake || []).map((id) => gs.tableCards.find((c) => c.id === id)).filter(Boolean);
    const names = must.map((c) => getCardDisplayName(c)).join(' or ');
    if (verdict.reason === 'must-take-match') {
      this.toast(`${names} is on the table: a ${card.display} must take it`);
      this.selectedCaptureIndices = [];
      this.refreshSelection();
    } else if (verdict.reason === 'must-capture') {
      this.toast(names ? `You must take ${names}` : 'A capture is required');
    } else if (verdict.reason === 'bad-sum') {
      this.toast('Those cards must add up to ' + card.value);
    } else {
      this.toast('That move is not allowed');
    }
    this.flashMustTake(verdict.mustTake || []);
    Juice.tick(0);
  },

  flashMustTake(ids) {
    if (!ids.length) return;
    const gs = this.gameState;
    [...document.getElementById('table-cards').children].forEach((el, i) => {
      const c = gs.tableCards[i];
      if (!c || !ids.includes(c.id)) return;
      el.classList.remove('must-take'); void el.offsetWidth; el.classList.add('must-take');
      clearTimeout(el._mustTimer);
      el._mustTimer = setTimeout(() => el.classList.remove('must-take'), 2400);
    });
  },

  cancelSelection(repaint) {
    this.selectedCardIndex = -1;
    this.selectedCaptureIndices = [];
    this.availableCaptures = [];
    if (repaint !== false) this.refreshSelection();
  },

  // The move goes to the room with the table it was made on (game + seq), so a retry or
  // a move against an older table is ignored there. The buttons show it is on its way
  // and always come back: on the answer, a refusal, a drop or a timeout.
  sendMove(cardId, captureCardIds) {
    const gs = this.gameState;
    if (this.isSubmittingMove || !gs || !this.net) return;
    const card = this.myHand.find((c) => c.id === cardId);
    this.isSubmittingMove = true;
    this.refreshSelection();
    this.log('debug', 'sending move', { cardId, captureCardIds, seq: gs.moveSeq });
    this.net.emit('move', { game: gs.gameToken, seq: gs.moveSeq, cardId, captureCardIds })
      .then((ack) => {
        if (ack.ok) return;
        if (ack.error === 'illegal' && card) this.blockedMove({ reason: ack.reason, mustTake: ack.mustTake || [] }, card);
        else { this.toast('The table changed, try again'); this.resync(); }
      })
      .catch((e) => {
        this.toast(e.message === 'timeout' ? 'The server is slow to answer, try again' : 'Not connected, the move was not sent');
        this.resync();
      })
      .finally(() => { this.isSubmittingMove = false; this.refreshSelection(); });
  },

  // ========== RENDER PIPELINE ==========
  // renderGame() is called from everywhere the state changes, often several times in
  // a row. It only marks the board dirty; the pump diffs what is on screen against the
  // current state, plays the choreography for the difference on the old DOM, then
  // paints. Pending renders collapse to the latest state.
  renderGame() {
    this._renderQueued = true;
    this._pump();
  },

  async _pump() {
    if (this._animating) return;
    this._animating = true;
    try {
      while (this._renderQueued) {
        this._renderQueued = false;
        if (!this.gameState) break;
        try { await this._renderStep(); } catch (e) { this.log('error', 'render step failed:', e); this._paint(); }
      }
    } finally {
      this._animating = false;
      // something may have queued while the resolvers ran
      if (this._renderQueued && this.gameState) this._pump();
    }
  },

  _snapshot(gs) {
    return {
      gameToken: gs.gameToken, phase: gs.phase, roundNum: gs.roundNum, moveSeq: gs.moveSeq || 0,
      currentTurn: gs.currentTurn, tableIds: gs.tableCards.map((c) => c.id), handIds: (this.myHand || []).map((c) => c.id),
      deckCount: gs.deck ? gs.deck.length : (gs.deckCount || 0),
    };
  },

  async _renderStep() {
    const gs = this.gameState;
    this.showScreen('screen-game');
    const prev = this._shown;
    const cur = this._snapshot(gs);
    // a hidden tab gets no animation: it would only queue up behind the timers
    const anim = Look.prefs.animations && !document.hidden && document.documentElement.dataset.screen === 'game';
    const sameGame = prev && prev.gameToken === cur.gameToken;

    const mv = gs.lastMove;
    if (anim && sameGame && mv && prev.moveSeq !== mv.seq) {
      await this._bounded(this._animateMove(prev, gs, mv));
    }

    // a fresh game deals the table too; a new hand deals only hands; a new deck (roundNum
    // back to 0 in the same game) deals both again
    const fresh = !sameGame;
    const newDeck = sameGame && cur.roundNum === 0 && prev.roundNum !== 0;
    const newHand = sameGame && cur.roundNum !== prev.roundNum;
    const handBack = sameGame && prev.handIds.length === 0 && cur.handIds.length > 0;
    if (fresh || newDeck) this._pendingDealTable = true;
    const deal = (fresh || newDeck || newHand || handBack) && cur.phase === 'playing' && cur.handIds.length > 0;
    this._paint();
    this._shown = this._snapshot(this.gameState);
    if (deal) {
      const withTable = this._pendingDealTable;
      this._pendingDealTable = false;
      if (anim) await this._bounded(this._animateDeal(this.gameState, withTable));
    }
    this._afterPaint();
  },

  // An animation that never finishes (a tab put to sleep mid-flight, a lost element)
  // must not hold the board: after ANIM_LIMIT_MS the queue moves on and repaints.
  _bounded(promise) {
    return Promise.race([promise, new Promise((r) => setTimeout(r, ANIM_LIMIT_MS))]);
  },

  _paint() {
    const gs = this.gameState;
    if (!gs) return;
    try { this.renderHud(gs); } catch (e) { this.log('error', 'renderHud:', e.message); }
    try { this.renderOpponents(gs); } catch (e) { this.log('error', 'renderOpponents:', e.message); }
    try { this.renderDeck(gs); } catch (e) { this.log('error', 'renderDeck:', e.message); }
    try { this.renderTable(gs); } catch (e) { this.log('error', 'renderTable:', e.message); }
    try { this.renderHand(gs); } catch (e) { this.log('error', 'renderHand:', e.message); }
    try { this.renderCaptured(gs); } catch (e) { this.log('error', 'renderCaptured:', e.message); }
    try { this.refreshSelection(); } catch (e) { this.log('error', 'refreshSelection:', e.message); }
    try { if (this.menuOpen) this.renderMenuContent(); } catch (e) { /* silent */ }
  },

  // Overlays that depend on the phase, run after the board is painted so the
  // ceremony sits on the final table.
  _afterPaint() {
    const gs = this.gameState;
    if (!gs) return;
    if (gs.phase === 'round_end') this.showRoundEnd(gs);
    else if (gs.phase === 'finished') this.showMatchEnd(gs);
    else {
      if (document.getElementById('ov-ceremony').classList.contains('open')) { this.closeOverlay('ov-ceremony'); this._ceremonyContinue = null; }
      if (document.getElementById('ov-match').classList.contains('open')) this.closeOverlay('ov-match');
    }
  },

  // ---- HUD ----
  renderHud(gs) {
    const $ = (id) => document.getElementById(id);
    const t = (key) => I18N.text(key);
    const teamName = (i) => gs.numPlayers === 4 ? `${t('team')} ${i + 1}` : (gs.players[i] ? gs.players[i].name : `${t('team')} ${i + 1}`);
    $('hud-round').textContent = `${Math.min(gs.roundNum + 1, gs.totalRounds)}/${gs.totalRounds}`;
    $('hud-deck').textContent = gs.deck ? gs.deck.length : (gs.deckCount || 0);
    $('hud-t1').textContent = gs.scores[0]; $('hud-t2').textContent = gs.scores[1];
    $('hud-t1-shk').textContent = gs.shkobbaCount[0] ? `+${gs.shkobbaCount[0]} ${t('chkobba')}` : '';
    $('hud-t2-shk').textContent = gs.shkobbaCount[1] ? `+${gs.shkobbaCount[1]} ${t('chkobba')}` : '';
    $('hud-t1-name').textContent = teamName(0);
    $('hud-t2-name').textContent = teamName(1);
    $('lbl-round').textContent = t('deal'); $('lbl-deck').textContent = t('deck');
    this.renderTurnLabel(gs);
  },

  renderTurnLabel(gs) {
    const el = document.getElementById('turn-fill');
    el.classList.remove('chip', 'green', 'mult', 'text', 'urgent', 'rtl');
    el.classList.toggle('rtl', !!I18N.term('yourTurn').rtl);
    if (gs.phase === 'round_end') { el.textContent = I18N.text('roundEnd'); el.classList.add('text'); Juice.fill(el, 1); return; }
    if (gs.phase === 'finished') { el.textContent = I18N.text('gameOver'); el.classList.add('text'); Juice.fill(el, 1); return; }
    if (gs.phase !== 'playing') { el.textContent = ''; return; }
    if (gs.currentTurn < 0) { el.textContent = I18N.text('dealing'); el.classList.add('text'); Juice.fill(el, 0); return; }
    if (gs.currentTurn === this.activeId()) { el.textContent = I18N.text('yourTurn'); return; }
    const p = gs.players[gs.currentTurn];
    el.textContent = `${p ? p.name.toUpperCase() : '?'} ${I18N.text('thinking')}`;
    el.classList.add('chip');
  },

  // ---- opponents: a count of backs, never a card ----
  opponentNode(player, gs, side) {
    const isTurn = gs.currentTurn === player.id;
    const cap = gs.capturedCounts ? gs.capturedCounts[player.team] : (gs.capturedTeams ? gs.capturedTeams[player.team].length : 0);
    const shk = gs.shkobbaCount[player.team] || 0;
    const played = gs.cardsPlayedThisRound ? (gs.cardsPlayedThisRound[player.id] || 0) : 0;
    const n = gs.phase === 'playing' ? Math.max(0, Math.min(3, 3 - played)) : 0;
    const isBot = !!player.isBot;
    const seat = this.snap && this.snap.seats[player.id];
    const away = !!seat && !!seat.away && !seat.takeover;
    const el = document.createElement('div');
    el.className = `opp t${player.team + 1}${isTurn ? ' active-turn' : ''}${side ? ' side' : ''}${away ? ' away' : ''}`;
    el.dataset.player = player.id;
    el.innerHTML = `<div class="av">${isBot ? 'BOT' : escapeHtml(player.name.charAt(0).toUpperCase())}</div>
      <div class="meta"><div class="name">${escapeHtml(player.name)}${away ? ' <span class="badge mult">offline</span>' : ''}</div>
        <div class="backs" aria-label="${n} cards in hand"></div>
        <div class="cap">${I18N.text('karta')} <b>${cap}</b>${shk ? ` <span class="badge haya">+${shk}</span>` : ''}</div></div>`;
    const backs = el.querySelector('.backs');
    for (let i = 0; i < n; i++) backs.appendChild(Cards.back(true));
    return el;
  },

  renderOpponents(gs) {
    const top = document.getElementById('opponents-top'), left = document.getElementById('opponent-left'), right = document.getElementById('opponent-right');
    top.innerHTML = ''; left.innerHTML = ''; right.innerHTML = '';
    document.getElementById('game-view').dataset.players = gs.numPlayers;   // the phone layout seats 4 players differently
    if (!gs.players || !gs.players.length) return;
    const me = this.myPlayerId;
    if (gs.numPlayers === 2) {
      const opp = gs.players[1 - me];
      if (opp) top.appendChild(this.opponentNode(opp, gs));
      return;
    }
    const at = (k) => gs.players[(me + k) % 4];
    if (at(2)) top.appendChild(this.opponentNode(at(2), gs));
    if (at(3)) left.appendChild(this.opponentNode(at(3), gs, true));
    if (at(1)) right.appendChild(this.opponentNode(at(1), gs, true));
  },

  renderDeck(gs) {
    const el = document.getElementById('table-deck'); el.innerHTML = '';
    const count = gs.deck ? gs.deck.length : (gs.deckCount || 0);
    const n = Math.min(3, Math.ceil(count / 14));
    for (let i = 0; i < Math.max(1, n); i++) el.appendChild(Cards.back());
    if (!count) el.firstChild.style.opacity = '.25';
    const c = document.createElement('span'); c.className = 'deck-count'; c.textContent = `${I18N.text('deck')} ${count}`; el.appendChild(c);
  },

  renderTable(gs) {
    const el = document.getElementById('table-cards'); el.innerHTML = '';
    (gs.tableCards || []).forEach((card, i) => {
      const node = Cards.build(card, { interactive: false, idle: true });
      node.dataset.index = i; node.classList.add('on-table');
      node.addEventListener('click', () => this.onTableCardClick(i));
      node.addEventListener('keydown', (e) => this.onCardKeydown(e, 'table', i));
      this.bindInfo(node, card, false);
      el.appendChild(node);
    });
    document.getElementById('table-msg').textContent = '';
  },

  renderHand(gs) {
    const el = document.getElementById('hand-cards'); el.innerHTML = '';
    const activeId = this.activeId();
    const me = gs.players ? gs.players.find((p) => p.id === activeId) : null;
    const mine = gs.currentTurn === activeId && gs.phase === 'playing';
    (this.myHand || []).forEach((card, i) => {
      const node = Cards.build(card, { interactive: mine, idle: true });
      node.dataset.index = i;
      node.addEventListener('click', () => this.onCardClick(i));
      node.addEventListener('keydown', (e) => this.onCardKeydown(e, 'hand', i));
      this.bindInfo(node, card, true);
      el.appendChild(node);
    });
    const label = document.getElementById('player-label');
    label.innerHTML = me ? `${escapeHtml(me.name)}${gs.numPlayers === 4 ? ` <span class="badge${me.team ? ' mult' : ''}">${I18N.text('team')} ${me.team + 1}</span>` : ''}` : '';
  },

  renderCaptured(gs) {
    const el = document.getElementById('my-captured');
    const me = gs.players ? gs.players.find((p) => p.id === this.activeId()) : null;
    const team = me ? me.team : 0;
    const n = gs.capturedCounts ? gs.capturedCounts[team] : (gs.capturedTeams ? gs.capturedTeams[team].length : 0);
    const shk = gs.shkobbaCount ? gs.shkobbaCount[team] : 0;
    el.innerHTML = `<span>${I18N.text('karta')}</span><span class="backs"></span><b>${n}</b>${shk ? `<span class="badge haya">+${shk} ${I18N.text('chkobba')}</span>` : ''}`;
    const backs = el.querySelector('.backs');
    for (let i = 0; i < Math.min(5, n); i++) backs.appendChild(Cards.back(true));
  },

  // long press / right click / "i" opens the info panel. Only face-up cards get one.
  bindInfo(node, card, inHand) {
    let t = 0;
    node.addEventListener('contextmenu', (e) => { e.preventDefault(); this.showInfo(card, inHand); });
    node.addEventListener('pointerdown', () => { t = setTimeout(() => { t = 0; this.showInfo(card, inHand); }, 480); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => node.addEventListener(ev, () => { if (t) clearTimeout(t); t = 0; }));
  },

  // Selection classes, action buttons and the table hint, without rebuilding the cards.
  refreshSelection() {
    const gs = this.gameState;
    const $ = (id) => document.getElementById(id);
    const cap = $('btn-capture'), place = $('btn-place'), cancel = $('btn-cancel');
    cap.querySelector('.fill').textContent = I18N.text('capture');
    place.querySelector('.fill').textContent = I18N.text('place');
    if (!gs) { cap.hidden = place.hidden = cancel.hidden = true; return; }
    const handEls = [...$('hand-cards').children];
    const tableEls = [...$('table-cards').children];
    const has = this.selectedCardIndex >= 0 && !!this.myHand[this.selectedCardIndex];
    const mine = gs.phase === 'playing' && gs.currentTurn === this.activeId();
    const assist = !!gs.captureAssist && mine;

    handEls.forEach((el, i) => {
      el.classList.toggle('selected', has && i === this.selectedCardIndex);
      // assist: which cards can take something right now
      const can = assist && this.myHand[i] && legalCaptures(gs.tableCards, this.myHand[i].value).length > 0;
      el.classList.toggle('can-capture', !!can);
    });
    const targets = new Set(has && assist ? this.availableCaptures.flat() : []);
    tableEls.forEach((el, i) => {
      const card = gs.tableCards[i];
      const picked = has && card && this.selectedCaptureIndices.includes(card.id);
      el.classList.toggle('capture-picked', !!picked);
      el.classList.toggle('capture-target', has && assist && targets.has(i));
      el.classList.toggle('is-interactive', has && mine && (!assist || targets.has(i)));
      el.setAttribute('tabindex', has && mine ? '0' : '-1');
    });

    const card = has ? this.myHand[this.selectedCardIndex] : null;
    const sum = has ? this.selectedCaptureIndices.reduce((s, id) => { const c = gs.tableCards.find((t) => t.id === id); return s + (c ? c.value : 0); }, 0) : 0;
    const valid = has && this.selectedCaptureIndices.length > 0 && sum === card.value;
    const mustTake = has && gs.forceCapture && gs.tableCards.length > 0 && hasDirectMatch(this.myHand, gs.tableCards);
    // a sum picked while a card of equal value lies on the table: the rules want that card
    const matchFirst = has && this.selectedCaptureIndices.length > 0 && gs.tableCards.some((c) => c.value === card.value)
      && !(this.selectedCaptureIndices.length === 1 && (gs.tableCards.find((c) => c.id === this.selectedCaptureIndices[0]) || {}).value === card.value);
    const busy = this.isSubmittingMove;
    cap.hidden = !has || (assist && this.availableCaptures.length === 0);
    place.hidden = !has || mustTake;
    cancel.hidden = !has;
    cap.disabled = !valid || busy;
    place.disabled = busy;
    cap.classList.toggle('pending', busy);
    place.classList.toggle('pending', busy);
    Juice.fill(cap.querySelector('.fill'), valid ? 1 : (this.selectedCaptureIndices.length ? 0.45 : 0));
    Juice.fill(place.querySelector('.fill'), busy ? 0.4 : 1);

    const msg = $('table-msg');
    if (!has) msg.textContent = '';
    else if (assist) {
      msg.textContent = this.availableCaptures.length === 0
        ? `${card.display} takes nothing`
        : this.availableCaptures.length === 1
          ? `${card.display} takes ${this.availableCaptures[0].map((i) => gs.tableCards[i].display).join(' + ')}`
          : `${this.availableCaptures.length} takes possible, pick the cards`;
    } else {
      msg.textContent = matchFirst
        ? `take the ${card.display} on the table, not a sum`
        : this.selectedCaptureIndices.length
          ? (valid ? `${sum} = ${card.value}` : `${sum} of ${card.value}`)
          : (mustTake ? 'a matching card is on the table: take it' : '');
    }
  },

  // ========== CHOREOGRAPHY (from the difference between two public states) ==========
  rectOfPlayer(playerId) {
    if (playerId === this.activeId()) return document.getElementById('hand-cards').getBoundingClientRect();
    const el = document.querySelector(`.opp[data-player="${playerId}"] .backs`) || document.querySelector(`.opp[data-player="${playerId}"]`);
    return el ? el.getBoundingClientRect() : document.getElementById('table-deck').getBoundingClientRect();
  },
  pileOfTeam(team) {
    const gs = this.gameState;
    const me = gs.players.find((p) => p.id === this.activeId());
    if (me && team === me.team) return document.getElementById('my-captured');
    const p = gs.players.find((x) => x.team === team && x.id !== this.activeId());
    return (p && document.querySelector(`.opp[data-player="${p.id}"] .cap`)) || document.getElementById('opponents-top');
  },

  // A face-up card appears at `from` and travels to the table row; resolves with its node.
  flyPlayedCard(card, fromRect) {
    return new Promise((resolve) => {
      const row = document.getElementById('table-cards');
      const node = Cards.build(card, { interactive: false, idle: false });
      node.classList.add('slot-hidden'); row.appendChild(node);
      const to = node.getBoundingClientRect();
      const ghost = Cards.build(card, { interactive: false, idle: false });
      ghost.classList.add('flying');
      Object.assign(ghost.style, { left: fromRect.left + fromRect.width / 2 - to.width / 2 + 'px', top: fromRect.top + 'px', width: to.width + 'px', height: to.height + 'px', transform: 'scale(.9) rotate(-8deg)' });
      document.body.appendChild(ghost);
      const dx = to.left - parseFloat(ghost.style.left), dy = to.top - fromRect.top;
      const dur = 380;
      requestAnimationFrame(() => {
        ghost.style.transition = `transform ${dur}ms var(--spring)`;
        ghost.style.transform = `translate(${dx}px, ${dy}px) scale(1) rotate(0deg)`;
      });
      setTimeout(() => { ghost.remove(); node.classList.remove('slot-hidden'); node.classList.add('landed'); Juice.thud(0.6); Juice.shake(0.25); resolve(node); }, dur + 40);
    });
  },

  async _animateMove(prev, gs, mv) {
    const wait = (ms) => Juice.wait(ms);
    const me = mv.playerId === this.activeId();
    const handRow = document.getElementById('hand-cards');
    // the row still shows the previous table; a card already gone from it (state and
    // hand arriving in the other order) is simply not animated
    let playedEl;
    if (me) {
      const src = [...handRow.children].find((el) => +el.dataset.id === mv.card.id);
      const r = src ? src.getBoundingClientRect() : handRow.getBoundingClientRect();
      if (src) src.style.visibility = 'hidden';
      playedEl = await this.flyPlayedCard(mv.card, r);
    } else {
      playedEl = await this.flyPlayedCard(mv.card, this.rectOfPlayer(mv.playerId));
      const backs = document.querySelector(`.opp[data-player="${mv.playerId}"] .backs`);
      if (backs && backs.lastChild) backs.lastChild.remove();
    }
    if (!mv.taken.length) { await wait(220); return; }

    // each taken card lifts with a tag, the cadence accelerating
    const rowEls = [...document.getElementById('table-cards').children];
    const takenEls = mv.taken.map((c) => rowEls.find((el) => +el.dataset.id === c.id)).filter(Boolean);
    const seq = [playedEl, ...takenEls];
    let step = 0;
    for (const el of seq) {
      const card = el === playedEl ? mv.card : mv.taken.find((c) => c.id === +el.dataset.id);
      el.classList.add('lifting');
      const kind = Cards.isHaya(card) ? 'haya' : card.suit === 'diamonds' ? 'gold' : card.name === '7' ? 'mult' : 'chip';
      const label = Cards.isHaya(card) ? I18N.text('haya') : card.suit === 'diamonds' ? I18N.text('dinari') : card.name === '7' ? I18N.text('barmila') : `+1 ${I18N.text('karta')}`;
      Juice.tag(el, label, kind);
      Juice.tick(step);
      await wait(Math.max(70, 170 - step * 18));
      step++;
    }
    await wait(160);
    const pile = this.pileOfTeam(mv.teamIndex);
    await Promise.all(seq.map((el, n) => Juice.flyTo(el, pile, n * 90, { scale: 0.32 })));
    if (mv.chkobba) await this.chkobbaMoment(mv.teamIndex);
    else Juice.shake(Math.min(1, 0.3 + seq.length * 0.12));
  },

  async chkobbaMoment(team) {
    const host = document.getElementById('fx-table');
    const t = I18N.term('chkobba');
    const gs = this.gameState;
    const who = gs.numPlayers === 4 ? `${I18N.text('team')} ${team + 1}` : (gs.players[team] ? gs.players[team].name : '');
    const slamEl = Juice.slam(host, t.main, team === 0 ? 'chip' : 'mult', { sub: t.sub ? `${t.sub} · ${who}` : who, life: 1500 });
    if (t.rtl) slamEl.style.fontFamily = 'var(--font-arabic)';
    Juice.shake(1);
    const fh = document.createElement('div'); fh.className = 'fire-host'; host.appendChild(fh);
    const f = Fire.create(fh, team === 0 ? 'chip' : 'mult', { w: 120, h: 44 });
    setTimeout(() => f.stop(), 1200);
    await Juice.wait(1900);
    fh.remove();
  },

  // Deal: cards fly from the deck to the table, then to each seat in turn.
  async _animateDeal(gs, withTable) {
    const deck = document.getElementById('table-deck');
    const tableEls = [...document.getElementById('table-cards').children];
    const handEls = [...document.getElementById('hand-cards').children];
    const fillEl = document.getElementById('turn-fill');
    if (withTable) tableEls.forEach((el) => el.classList.add('slot-hidden'));
    handEls.forEach((el) => el.classList.add('slot-hidden'));
    document.querySelectorAll('.opp .backs').forEach((b) => (b.style.visibility = 'hidden'));
    fillEl.textContent = I18N.text('dealing'); fillEl.classList.add('text'); Juice.fill(fillEl, 0);
    const jobs = [];
    let d = 0;
    const others = gs.players.filter((p) => p.id !== this.activeId()).length;
    const total = (withTable ? tableEls.length : 0) + handEls.length + others * 3;
    let done = 0;
    const tickFill = () => { done++; Juice.fill(fillEl, done / total); };
    if (withTable) tableEls.forEach((el) => { jobs.push(Juice.dealTo(deck, el, d, true).then(tickFill)); d += 90; });
    const order = [];
    for (let k = 1; k <= gs.numPlayers; k++) order.push((gs.dealerIndex + k) % gs.numPlayers);
    for (let r = 0; r < 3; r++) for (const pid of order) {
      if (pid === this.activeId()) { const el = handEls[r]; if (el) jobs.push(Juice.dealTo(deck, el, d, true).then(tickFill)); }
      else {
        const opp = document.querySelector(`.opp[data-player="${pid}"] .backs`);
        if (opp) jobs.push(Juice.dealTo(deck, opp, d, false).then(tickFill));
      }
      d += 90;
    }
    await Promise.all(jobs);
    document.querySelectorAll('.opp .backs').forEach((b) => (b.style.visibility = ''));
    this.renderTurnLabel(this.gameState);
  },

  // ========== ROUND END CEREMONY ==========
  showRoundEnd(gs) {
    const key = `${gs.gameToken}:${gs.roundNum}:${gs.scores.join('-')}`;
    if (this._ceremonyKey === key) return;
    this._ceremonyKey = key;
    this.stopTurnTimer();
    this.ceremony(gs).catch((e) => this.log('error', 'ceremony failed:', e));
  },

  tallyLines(gs) {
    const ls = gs.lastScore || {};
    const c = ls.counts || { cards: gs.capturedCounts || [0, 0], diamonds: [0, 0], haya: [0, 0], sevens: [0, 0], sixes: [0, 0] };
    return [
      { key: 'karta', values: c.cards, winner: ls.mostCardsPt !== undefined ? ls.mostCardsPt : -1 },
      { key: 'dinari', values: c.diamonds, winner: ls.mostDiamondsPt !== undefined ? ls.mostDiamondsPt : -1 },
      { key: 'haya', values: c.haya, winner: ls.sevenDiamondsPt !== undefined ? ls.sevenDiamondsPt : -1 },
      { key: 'barmila', values: c.sevens, winner: ls.mostSevensPt !== undefined ? ls.mostSevensPt : -1 },
      { key: 'chkobba', values: gs.shkobbaCount, each: true },
    ];
  },

  async ceremony(gs) {
    const $ = (id) => document.getElementById(id);
    const J = Juice;
    const lines = this.tallyLines(gs);
    const points = [0, 0];
    lines.forEach((l) => { if (l.each) { points[0] += l.values[0]; points[1] += l.values[1]; } else if (l.winner >= 0) points[l.winner]++; });
    const before = [gs.scores[0] - points[0], gs.scores[1] - points[1]];
    this._ceremonySkip = false; this._ceremonyContinue = null; this._ceremonyDone = false;
    const teamName = (i) => gs.numPlayers === 4 ? `${I18N.text('team')} ${i + 1}` : (gs.players[i] ? gs.players[i].name : `${I18N.text('team')} ${i + 1}`);

    $('cer-round').textContent = I18N.text('roundEnd');
    $('cer-x').textContent = I18N.text('score').toLowerCase();
    $('cer-t1').textContent = teamName(0); $('cer-t2').textContent = teamName(1);
    const box = $('cer-lines'); box.innerHTML = '';
    const rows = lines.map((l) => {
      const row = document.createElement('div'); row.className = 'cer-line';
      const t = I18N.term(l.key);
      row.innerHTML = `<div class="cer-box t1 burnable"><span class="n">0</span><span class="pt">+1</span></div>
        <div class="fill text ${t.rtl ? 'rtl' : ''}">${t.main}</div>
        <div class="cer-box t2 burnable"><span class="n">0</span><span class="pt">+1</span></div>`;
      J.fill(row.querySelector('.fill'), 0);
      box.appendChild(row);
      return row;
    });
    const tot1 = $('cer-tot1'), tot2 = $('cer-tot2');
    tot1.textContent = before[0]; tot2.textContent = before[1];
    tot1.classList.remove('win'); tot2.classList.remove('win');
    $('cer-skip').textContent = 'tap to skip'; $('cer-skip').classList.remove('waiting');
    this.openOverlay('ov-ceremony');

    const finishLine = (row, l) => {
      row.classList.add('on'); J.fill(row.querySelector('.fill'), 1);
      const boxes = row.querySelectorAll('.cer-box');
      boxes[0].querySelector('.n').textContent = l.values[0]; boxes[1].querySelector('.n').textContent = l.values[1];
      if (l.each) { if (l.values[0]) boxes[0].classList.add('win'); if (l.values[1]) boxes[1].classList.add('win'); boxes.forEach((b, i) => (b.querySelector('.pt').textContent = `+${l.values[i]}`)); }
      else if (l.winner >= 0) boxes[l.winner].classList.add('win');
    };
    const cancel = () => this._ceremonySkip;
    // the same tally is still on screen. Compared by key, not by object: every snapshot
    // is a new object, and one arriving mid-count (a player dropping, the host changing)
    // must not stop the count and leave the tally without its "tap to continue".
    const key = this._ceremonyKey;
    const stillOpen = () => this._ceremonyKey === key && $('ov-ceremony').classList.contains('open')
      && !!this.gameState && this.gameState.phase === 'round_end' && this.gameState.gameToken === gs.gameToken;

    if (J.getJuice() <= 0) {
      lines.forEach((l, i) => finishLine(rows[i], l));
    } else {
      for (let i = 0; i < lines.length; i++) {
        if (this._ceremonySkip || !stillOpen()) break;
        const l = lines[i], row = rows[i];
        row.classList.add('on');
        const boxes = row.querySelectorAll('.cer-box');
        await Promise.all([0, 1].map((t) => J.countUp(boxes[t].querySelector('.n'), 0, l.values[t], { base: 120, cancel, delay: t * 40 })));
        J.fill(row.querySelector('.fill'), 1);
        if (this._ceremonySkip) break;
        const winners = l.each ? [0, 1].filter((t) => l.values[t] > 0) : l.winner >= 0 ? [l.winner] : [];
        winners.forEach((t) => {
          boxes[t].classList.add('win');
          boxes[t].querySelector('.pt').textContent = l.each ? `+${l.values[t]}` : '+1';
          const f = Fire.create(boxes[t], t === 0 ? 'chip' : 'mult', { w: 40, h: 22 }); setTimeout(() => f.stop(), 500);
        });
        if (winners.length) { J.thud(0.8); J.shake(0.4, $('ov-ceremony').querySelector('.frame')); } else J.tick(0);
        await J.wait(420);
      }
      lines.forEach((l, i) => finishLine(rows[i], l));
    }
    if (!stillOpen()) return;
    await Promise.all([J.countUp(tot1, before[0], gs.scores[0], { base: 160, cancel, instant: this._ceremonySkip }), J.countUp(tot2, before[1], gs.scores[1], { base: 160, cancel, instant: this._ceremonySkip })]);
    tot1.textContent = gs.scores[0]; tot2.textContent = gs.scores[1];
    const lead = gs.scores[0] === gs.scores[1] ? -1 : gs.scores[0] > gs.scores[1] ? 0 : 1;
    if (lead >= 0 && J.getJuice() > 0) { (lead === 0 ? tot1 : tot2).classList.add('win'); const f = Fire.create(lead === 0 ? tot1 : tot2, lead === 0 ? 'chip' : 'mult', { w: 56, h: 30 }); setTimeout(() => f.stop(), 900); }
    else if (lead >= 0) (lead === 0 ? tot1 : tot2).classList.add('win');
    J.boom(); J.shake(0.8, $('ov-ceremony').querySelector('.frame'));
    if (!stillOpen()) return;
    this.setContinue();
  },

  // As in the first version, the host decides when the next deal goes out: the host
  // gets "tap to continue", everyone else "waiting for the host" (a tap there only
  // skips their own count). If the host drops, control passes on and the new host's
  // tally switches to "tap to continue". Online, the room also moves on by itself
  // after 30 s as a safety net; a bot game waits for the tap.
  setContinue() {
    this._ceremonyDone = true;
    const skip = document.getElementById('cer-skip');
    if (this.isHost) {
      skip.textContent = 'tap to continue'; skip.classList.remove('waiting');
      this._ceremonyContinue = () => this.continueRound();
    } else {
      skip.textContent = 'waiting for the host'; skip.classList.add('waiting');
      this._ceremonyContinue = null;
    }
  },

  // The host's tap closes the tally at once, as before; if the room refuses or does not
  // answer, the tally comes back so the tap can be made again.
  continueRound() {
    this._ceremonyContinue = null;
    this.closeOverlay('ov-ceremony');
    this.ask('continue').then((ack) => {
      if (ack && ack.ok) return;
      const gs = this.gameState;
      if (gs && gs.phase === 'round_end') { this.openOverlay('ov-ceremony'); this.setContinue(); }
    });
  },

  // ========== MATCH END ==========
  showMatchEnd(gs) {
    const key = `${gs.gameToken}:finished:${gs.winner}`;
    if (this._matchKey === key) return;
    this._matchKey = key;
    this.stopTurnTimer();
    // a match that ends straight out of a tally leaves the ceremony open underneath
    this._ceremonyContinue = null; this.closeOverlay('ov-ceremony');
    const $ = (id) => document.getElementById(id);
    const w = gs.winner >= 0 ? gs.winner : (gs.scores[0] > gs.scores[1] ? 0 : 1);
    const name = gs.numPlayers === 4 ? `${I18N.text('team')} ${w + 1}` : (gs.players[w] ? gs.players[w].name : `${I18N.text('team')} ${w + 1}`);
    const me = gs.players ? gs.players.find((p) => p.id === this.myPlayerId) : null;
    const lost = !!me && me.team !== w;
    const ov = $('ov-match');
    ov.classList.toggle('lost', lost);
    ov.setAttribute('aria-label', lost ? 'You lost' : 'Match won');
    $('match-title').innerHTML = lost
      ? `<span class="term"><b>${I18N.text('youLost')}</b></span>`
      : `${escapeHtml(name)} <span class="term"><b>${I18N.text('wins')}</b></span>`;
    const sub = $('match-sub');
    const reason = gs.endReason === 'diamonds' ? 'all ten diamonds in one deal'
      : gs.endReason === 'surrender' ? (lost ? 'your side surrendered' : 'the other side surrendered')
      : gs.endReason === 'forfeit' ? 'the other side left the game' : '';
    const why = lost ? [`${name} wins`, reason].filter(Boolean).join(' · ') : reason;
    sub.textContent = why; sub.hidden = !why;
    $('match-score').innerHTML = `<span style="color:var(--team1)">${gs.scores[0]}</span> <span style="color:var(--text-dim);font-size:.5em">x</span> <span style="color:var(--team2)">${gs.scores[1]}</span>`;
    $('match-again').hidden = !this.isHost;
    this.openOverlay('ov-match');
    const c = $('confetti'); c.innerHTML = '';
    if (lost) return;   // no chime and no confetti for the losing side
    Juice.chime();
    if (Juice.getJuice() > 0) for (let i = 0; i < 70; i++) { const d = document.createElement('i'); d.style.left = Math.random() * 100 + '%'; d.style.background = ['var(--gold)', 'var(--chip)', 'var(--mult)', 'var(--text)'][i % 4]; d.style.animationDelay = Math.random() * .8 + 's'; d.style.animationDuration = 2 + Math.random() * 1.5 + 's'; c.appendChild(d); }
  },


  // ========== CARD INFO + RULES ==========
  showInfo(card, inHand) {
    const $ = (id) => document.getElementById(id);
    const box = $('info-card'); box.innerHTML = '';
    const node = Cards.build(card, { interactive: true, idle: true }); node.classList.add('big'); box.appendChild(node);
    const isHaya = Cards.isHaya(card);
    const suitName = Cards.getSuit() === 'coin' ? { hearts: 'of cups', diamonds: 'of coins', clubs: 'of batons', spades: 'of swords' }[card.suit] : 'of ' + card.suit;
    $('info-title').innerHTML = isHaya ? I18N.html('haya') : `<span class="term"><b>${card.display} ${suitName}</b></span>`;
    const counts = [];
    counts.push(`<li><span class="badge">+1</span> ${I18N.text('karta')}: counts toward most cards</li>`);
    if (card.suit === 'diamonds') counts.push(`<li><span class="badge gold">+1</span> ${I18N.text('dinari')}: counts toward most diamonds</li>`);
    if (card.name === '7') counts.push(`<li><span class="badge mult">7</span> ${I18N.text('barmila')}: counts toward most sevens</li>`);
    if (card.name === '6') counts.push(`<li><span class="badge">6</span> tie-breaker for ${I18N.text('barmila')}</li>`);
    if (isHaya) counts.push(`<li><span class="badge haya">+1</span> a point on its own, for whoever takes it</li>`);
    let combos = '';
    const gs = this.gameState;
    if (inHand && gs && gs.tableCards) {
      const cs = legalCaptures(gs.tableCards, card.value);
      combos = cs.length
        ? `<p style="margin-top:12px"><b>Takes now:</b></p><ul class="info-list">${cs.map((c) => `<li><span class="combo">${c.map((i) => { const t = gs.tableCards[i]; return `<span class="mini-card${['hearts', 'diamonds'].includes(t.suit) ? ' red' : ''}">${t.display}</span>`; }).join('<span>+</span>')}</span>${c.length === gs.tableCards.length ? ` <span class="badge haya">${I18N.text('chkobba')}</span>` : ''}</li>`).join('')}</ul>`
        : `<p style="margin-top:12px;color:var(--text-dim)">Takes nothing on this table. Playing it places it.</p>`;
    }
    const court = card.name === 'king' ? ' (king)' : card.name === 'jack' ? ' (jack)' : card.name === 'queen' ? ' (queen)' : '';
    $('info-body').innerHTML = `<p>Value <b class="num">${card.value}</b>${court}. A take is any set of table cards adding up to it, but a card of equal value on the table must be taken first${card.value <= 7 ? '' : '; courts only take an equal court or a sum'}.</p><ul class="info-list">${counts.join('')}</ul>${combos}`;
    this.openOverlay('ov-info');
  },

  renderRules() {
    const $ = (id) => document.getElementById(id);
    const r = I18N.RULES[this.rulesPage];
    const sample = { karta: { suit: 'clubs', name: '4', display: '4', value: 4 }, dinari: { suit: 'diamonds', name: '3', display: '3', value: 3 }, haya: { suit: 'diamonds', name: '7', display: '7', value: 7 }, barmila: { suit: 'spades', name: '7', display: '7', value: 7 }, chkobba: { suit: 'hearts', name: 'king', display: 'K', value: 10 } }[r.key];
    const box = $('rules-card'); box.innerHTML = '';
    const node = Cards.build({ id: 900 + this.rulesPage, ...sample }, { interactive: true, idle: true }); node.classList.add('big'); box.appendChild(node);
    $('rules-title').innerHTML = I18N.html(r.key);
    $('rules-text').textContent = r.text;
    $('rules-dots').innerHTML = I18N.RULES.map((_, i) => `<i class="${i === this.rulesPage ? 'on' : ''}"></i>`).join('');
  },
  showRules() { this.rulesPage = 0; this.renderRules(); this.openOverlay('ov-rules'); },

  // ========== SOUND (UI cues; the choreography has its own tones in Juice) ==========
  playSound(type) {
    if (!Look.prefs.sound || !this._audioUnlocked) return;
    if (type === 'win' && this.gameState && this.gameState.players) {
      // the fanfare is for the winning side only
      const me = this.gameState.players.find((p) => p.id === this.myPlayerId);
      if (me && this.gameState.winner >= 0 && me.team !== this.gameState.winner) return;
    }
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      if (!this._audioCtx) this._audioCtx = new AudioCtx();
      const ctx = this._audioCtx;
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();

      const playTone = (freq, duration, typeOpt = 'sine', gainStart = 0.1, delay = 0) => {
        const osc = ctx.createOscillator();
        const gainNode = ctx.createGain();
        osc.type = typeOpt;
        osc.frequency.setValueAtTime(freq, ctx.currentTime + delay);
        gainNode.gain.setValueAtTime(gainStart, ctx.currentTime + delay);
        gainNode.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + duration);
        osc.connect(gainNode);
        gainNode.connect(ctx.destination);
        osc.start(ctx.currentTime + delay);
        osc.stop(ctx.currentTime + delay + duration);
      };

      if (type === 'click') {
        playTone(600, 0.05, 'triangle', 0.05);
      } else if (type === 'win') {
        [261.63, 329.63, 392.00, 523.25, 659.25, 783.99, 1046.50].forEach((freq, idx) => playTone(freq, 0.4, 'sine', 0.1, idx * 0.12));
      } else if (type === 'warning') {
        playTone(880, 0.08, 'sine', 0.08);
      } else if (type === 'timeout') {
        const osc = ctx.createOscillator();
        const gainNode = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(120, ctx.currentTime);
        osc.frequency.linearRampToValueAtTime(80, ctx.currentTime + 0.35);
        gainNode.gain.setValueAtTime(0.12, ctx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(400, ctx.currentTime);
        osc.connect(filter);
        filter.connect(gainNode);
        gainNode.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.35);
      }
    } catch (e) {
      this.log('warn', 'Web Audio error:', e.message);
    }
  },

  // ========== TOAST ==========
  // Messages sit just under a top HUD while a game is on screen, so they never cover
  // the score boxes; elsewhere (menus, rail HUD) they keep their place at the top.
  _belowHud(el, gap) {
    const hud = document.getElementById('hud');
    const gv = document.getElementById('game-view');
    const inGame = document.documentElement.dataset.screen === 'game';
    const r = hud ? hud.getBoundingClientRect() : null;
    const top = inGame && r && r.height > 0 && r.height < window.innerHeight * 0.4 && !(gv && gv.dataset.hud === 'rail' && window.innerWidth > 900);
    el.style.top = top ? Math.round(r.bottom + gap) + 'px' : '';
  },

  toast(message) {
    const el = document.getElementById('toast');
    this._belowHud(el, 4);
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  },

  // ========== IN-GAME MENU ==========
  toggleMenu() {
    this.menuOpen = !this.menuOpen;
    if (this.menuOpen) { this.renderMenuContent(); this.openOverlay('ov-gamemenu'); }
    else this.closeOverlay('ov-gamemenu');
  },

  switchMenuTab(tab) {
    this.menuTab = tab;
    document.querySelectorAll('#ov-gamemenu .tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === tab));
    document.querySelectorAll('#ov-gamemenu [data-tab]').forEach((p) => (p.hidden = p.dataset.tab !== tab));
    this.renderMenuContent();
  },

  renderMenuContent() {
    if (this.menuTab === 'stats') document.getElementById('gm-stats').innerHTML = this.renderMenuStats();
    else if (this.menuTab === 'settings') document.getElementById('gm-settings').innerHTML = this.renderMenuSettings();
    else if (this.menuTab === 'log') document.getElementById('gm-log').innerHTML = this.renderMenuLog();
    else if (this.menuTab === 'actions') {
      document.getElementById('gm-copy').hidden = !this.roomLink;
      document.getElementById('gm-surrender').hidden = !(this.gameState && this.gameState.phase === 'playing');
    }
  },

  renderMenuStats() {
    const gs = this.gameState;
    if (!gs) return '<div class="empty-note">No game in progress</div>';
    const t = (k) => I18N.text(k);
    const deckCount = gs.deck ? gs.deck.length : (gs.deckCount || 0);
    const cap = (i) => gs.capturedCounts ? gs.capturedCounts[i] : (gs.capturedTeams ? gs.capturedTeams[i].length : 0);
    const teamName = (i) => gs.numPlayers === 4 ? `${t('team')} ${i + 1}` : (gs.players[i] ? escapeHtml(gs.players[i].name) : `${t('team')} ${i + 1}`);
    const ownership = gs.diamondOwnership || {};
    const names = ['ace', '2', '3', '4', '5', '6', '7', 'jack', 'queen', 'king'];
    const labels = ['A', '2', '3', '4', '5', '6', '7', 'J', 'Q', 'K'];
    const pip = Cards.getSuit() === 'coin' ? '●' : '♦';
    return `<div class="stat-grid">
      <div class="hud-box"><span class="lbl">${t('deal')}</span><span class="val num">${Math.min(gs.roundNum + 1, gs.totalRounds)}/${gs.totalRounds}</span></div>
      <div class="hud-box"><span class="lbl">${t('deck')}</span><span class="val num">${deckCount}</span></div>
      <div class="hud-box" style="background:var(--team1)"><span class="lbl">${teamName(0)}</span><span class="val num">${gs.scores[0]}</span><span class="lbl">${t('karta')} ${cap(0)} · ${t('chkobba')} ${gs.shkobbaCount[0]}</span></div>
      <div class="hud-box" style="background:var(--team2)"><span class="lbl">${teamName(1)}</span><span class="val num">${gs.scores[1]}</span><span class="lbl">${t('karta')} ${cap(1)} · ${t('chkobba')} ${gs.shkobbaCount[1]}</span></div></div>
      <div class="lbl" style="margin-bottom:6px">${t('dinari')} tracker</div>
      <div class="dt">${names.map((n, i) => { const o = ownership[n]; return `<span class="${o === 0 ? 't1' : o === 1 ? 't2' : ''}">${pip}${labels[i]}</span>`; }).join('')}</div>
      <div class="row compact" style="margin-top:10px"><span class="lbl">Win at</span><span class="num">${gs.winScore}</span></div>
      <div class="row compact"><span class="lbl">Force capture</span><span>${gs.forceCapture ? 'on' : 'off'}</span></div>
      <div class="row compact"><span class="lbl">Capture assist</span><span>${gs.captureAssist ? 'on' : 'off'}</span></div>`;
  },

  renderMenuSettings() {
    const gs = this.gameState;
    const host = this.isHost && !!gs;
    const seg = (key, value, options, enabled) => `<div class="seg${key === 'labels' ? ' chipset' : ''}"${enabled ? '' : ' aria-disabled="true"'}>${options.map(([v, label]) => `<button data-set="${key}" data-v="${v}" class="${String(value) === String(v) ? 'on' : ''}">${label}</button>`).join('')}</div>`;
    const row = (label, html) => `<div class="row compact"><span class="lbl">${label}</span>${html}</div>`;
    const look = Look.get();
    const timer = gs ? (gs.turnTimerDuration || 0) : this.turnTimerDuration;
    return `
      <div class="setting-group">
        <div class="gtitle">Rules <small>${host ? 'host controls' : 'the host controls these'}</small></div>
        ${row('Force capture', seg('force', gs ? gs.forceCapture : this.forceCapture, [[true, 'On'], [false, 'Off']], host))}
        ${row('Capture assist', seg('assist', gs ? !!gs.captureAssist : this.captureAssist, [[false, 'Off'], [true, 'On']], host))}
        ${row('Turn timer', seg('timer', timer, [[0, 'Off'], [15, '15s'], [30, '30s'], [45, '45s'], [60, '60s']], host))}
      </div>
      <div class="setting-group">
        <div class="gtitle">Graphics <small>${host ? 'applies to everyone in the room' : 'the host picks the look'}</small></div>
        ${row('Theme', seg('theme', look.theme, [['b', 'Felt'], ['a', 'Balatro'], ['c', 'Noir']], host))}
        ${row('Cards', seg('cards', look.cards, [['photo', 'Photo'], ['svg', 'Flat'], ['pixel', 'Pixel']], host))}
        ${row('Suits', seg('suits', look.suits, [['french', 'French'], ['coin', 'Coins']], host))}
      </div>
      <div class="setting-group">
        <div class="gtitle">Motion <small>yours only</small></div>
        ${row('Screen shake', seg('shake', Look.prefs.shake, [[true, 'On'], [false, 'Off']], true))}
        ${row('Animations', seg('anim', Look.prefs.animations, [[true, 'On'], [false, 'Off']], true))}
      </div>
      <div class="setting-group">
        <div class="gtitle">Labels and sound <small>yours only</small></div>
        ${row('Labels', seg('labels', Look.prefs.labels, [['latin', 'Latin'], ['arabic', 'عربي'], ['english', 'EN']], true))}
        ${row('Sound', seg('sound', Look.prefs.sound, [[true, 'On'], [false, 'Off']], true))}
      </div>`;
  },

  renderMenuLog() {
    if (this.moveLog.length === 0) return '<div class="empty-note">No moves yet</div>';
    let html = '<div class="move-log">';
    for (let i = this.moveLog.length - 1; i >= 0; i--) {
      const entry = this.moveLog[i];
      const time = new Date(entry.ts).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' });
      html += `<div class="entry"><span class="t">${escapeHtml(time)}</span><span>${escapeHtml(entry.text)}</span></div>`;
    }
    return html + '</div>';
  },

  onMenuSetting(key, raw) {
    const v = raw === 'true' ? true : raw === 'false' ? false : (raw !== '' && !isNaN(raw)) ? +raw : raw;
    Juice.tick(0);
    switch (key) {
      case 'force': this.toggleForceCapture(v); break;
      case 'assist': this.toggleCaptureAssist(v); break;
      case 'timer': this.changeTurnTimer(v); break;
      case 'theme': this.changeLook({ theme: v }); break;
      case 'cards': this.changeLook({ cards: v }); break;
      case 'suits': this.changeLook({ suits: v }); break;
      case 'shake': Look.setPref('shake', v); break;
      case 'anim': Look.setPref('animations', v); break;
      case 'labels': Look.setPref('labels', v); this.renderGame(); break;
      case 'sound': Look.setPref('sound', v); if (v) this.playSound('click'); break;
    }
    this.renderMenuContent();
  },

  // Rules and look belong to the room: only its host changes them, and the room
  // sends the change to everyone.
  changeRule(change) {
    if (!this.isHost || !this.gameState) { this.toast('Only the host can change the rules'); return; }
    this.ask('settings', change).then((ack) => {
      if (!ack || !ack.ok) return;
      const [k, v] = Object.entries(change)[0];
      const label = { forceCapture: 'Force capture', captureAssist: 'Capture assist', timer: 'Turn timer' }[k];
      this.toast(`${label} ${k === 'timer' ? (v > 0 ? v + 's' : 'off') : v ? 'on' : 'off'}`);
    });
  },
  toggleForceCapture(checked) { this.changeRule({ forceCapture: checked }); },
  toggleCaptureAssist(checked) { this.changeRule({ captureAssist: checked }); },
  changeTurnTimer(value) { this.changeRule({ timer: value }); },

  // The host's look change is the room's look: it goes out with the state and also
  // becomes the host's default for the next room.
  changeLook(partial) {
    if (!this.isHost || !this.gameState) { this.toast('The host picks the look'); return; }
    Look.setLook(partial, true);
    this.ask('settings', { look: partial });
  },

  surrenderGame() {
    if (!this.gameState || this.gameState.phase !== 'playing') { this.toast('No active game'); return; }
    if (!confirm('Surrender this game?')) return;
    this.toggleMenu();
    this.ask('surrender');
  },

  // ========== EMOTES ==========
  showEmote(name, text) {
    const el = document.getElementById('emote-display');
    if (!el) return;
    el.textContent = `${name}: ${text}`;
    this._belowHud(el, 48);
    el.hidden = false;
    if (this._emoteTimeout) clearTimeout(this._emoteTimeout);
    this._emoteTimeout = setTimeout(() => { el.hidden = true; this._emoteTimeout = null; }, 2000);
  },

  // The room passes it on to the others and answers with the text to show here.
  sendEmote(key) {
    if (!this.net) return;
    this.playSound('click');
    this.net.emit('emote', { key }).then((ack) => { if (ack.ok) this.showEmote(ack.name, ack.text); }, () => {});
  },

  // ========== REMATCH ==========
  // The match screen closes when the new game's first state arrives.
  rematch() {
    if (!this.isHost) { this.toast('Only the host can start a rematch'); return; }
    this.busy(document.getElementById('match-again'), () => this.ask('rematch'));
  },
};

document.addEventListener('DOMContentLoaded', () => app.init());
