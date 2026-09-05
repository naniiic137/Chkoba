// ===================== CONSTANTS =====================
const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const DIAMONDS = 'diamonds';

const CARD_DEFS = [
  { name: 'ace', display: 'A', value: 1 },
  { name: '2', display: '2', value: 2 },
  { name: '3', display: '3', value: 3 },
  { name: '4', display: '4', value: 4 },
  { name: '5', display: '5', value: 5 },
  { name: '6', display: '6', value: 6 },
  { name: '7', display: '7', value: 7 },
  { name: 'jack', display: 'J', value: 9 },
  { name: 'queen', display: 'Q', value: 8 },
  { name: 'king', display: 'K', value: 10 },
];

const FACE_NAMES = ['jack', 'queen', 'king'];

const SUIT_SYMBOLS = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };
const SUIT_COLORS = { hearts: '#e74c3c', diamonds: '#3498db', clubs: '#2ecc71', spades: '#95a5a6' };

function getCardImage(card) {
  const suffix = (FACE_NAMES.includes(card.name) || (card.name === 'ace' && card.suit === 'spades')) ? '2' : '';
  return `images/${card.name}_of_${card.suit}${suffix}.png`;
}

function getCardDisplayName(card) {
  return `${card.display}${SUIT_SYMBOLS[card.suit]}`;
}

// Spoken/announced card name for alt text and aria-label ("7 of diamonds"), since the
// glyph form ("7♦") does not read well and the bare rank can't distinguish suits.
function getCardAria(card) {
  return `${card.display} of ${card.suit}`;
}

function getCardHtml(card) {
  return `<span class="card-ref ${card.suit}">${getCardDisplayName(card)}</span>`;
}

function createDeck() {
  let id = 0;
  const deck = [];
  for (const suit of SUITS) {
    for (const def of CARD_DEFS) {
      deck.push({ id: id++, suit, name: def.name, display: def.display, value: def.value });
    }
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function findCaptureCombinations(tableCards, targetValue) {
  // DFS with sum-pruning instead of a 2^n subset scan. Every card value is >= 1, so the
  // recursion depth is bounded by targetValue (<= 10); the result count is capped because
  // callers only need existence + one example, never the full enumeration. This cannot
  // hang on a large table (e.g. force-capture off, many low cards) the way 1<<n did.
  const results = [];
  const n = tableCards.length;
  const CAP = 256;
  const dfs = (start, sum, indices) => {
    if (results.length >= CAP) return;
    if (sum === targetValue) { results.push(indices.slice()); return; }
    if (sum > targetValue) return;
    for (let i = start; i < n; i++) {
      if (sum + tableCards[i].value > targetValue) continue;
      indices.push(i);
      dfs(i + 1, sum + tableCards[i].value, indices);
      indices.pop();
    }
  };
  dfs(0, 0, []);
  return results;
}

function hasDirectMatch(hand, tableCards) {
  return hand.some(c => tableCards.some(tc => tc.value === c.value));
}

function genRoomCode() {
  // Crypto-random, 8 chars from a 31-symbol alphabet (~8.5e11 keyspace) so room codes
  // cannot be enumerated. Math.random() at 4 chars was ~923k and brute-forceable.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = new Uint32Array(8);
  crypto.getRandomValues(buf);
  let c = '';
  for (let i = 0; i < 8; i++) c += chars[buf[i] % chars.length];
  return c;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}


// ===================== APP =====================
// Rules, networking and the host's authority are unchanged from the previous UI. What is
// new: every screen is a .screen section, the board is painted through a render queue
// that derives its choreography from (previous, current) public state, the look
// (theme / cards / suits) is a room setting the host owns, and the round-end tally is
// a ceremony instead of a table. Wire keys keep their old names (shkobbaCount,
// shkobbaThisTurn) so a mid-deploy client and host still understand each other.
const ROOM_OPTS_KEY = 'chkobba_room_opts';
const NAME_KEY = 'chkobba_name';

const app = {
  isHost: false,
  myPlayerId: -1,
  roomCode: '',
  roomLink: '',
  playerCount: 2,
  forceCapture: true,
  captureAssist: false,
  winScore: 21,
  turnTimerDuration: 30,
  myName: '',
  playerList: [],
  gameState: null,
  myHand: [],
  selectedCardIndex: -1,
  selectedCaptureIndices: [],
  availableCaptures: [],
  _toastTimer: null,
  _turnTimer: null,
  _turnTimerStart: 0,
  _turnKey: '',
  _timerRAF: null,
  moveLog: [],
  menuOpen: false,
  menuTab: 'stats',
  debugTab: 'hands',
  isSubmittingMove: false,
  _submitGuard: null,
  botDifficulty: 'medium',
  gameSpeed: 'normal',
  _emoteTimeout: null,
  _lastCardClickIndex: -1,
  _lastCardClickTime: 0,
  _lastTimerSec: 0,
  _db: null,
  _dbError: false,
  _verbose: false,
  _audioCtx: null,
  _audioUnlocked: false,
  _roomRef: null,
  _stateRef: null,
  _movesRef: null,
  _playerListeners: [],
  _moveCallback: null,
  _roomStarted: false,
  _botPlayers: {},
  _playerSlots: {},
  _gameFrozen: false,
  _controllingPlayerId: null,
  _spyMode: false,
  _isBotGame: false,
  // render pipeline
  _shown: null,
  _renderQueued: false,
  _animating: false,
  _idleResolvers: [],
  _pendingDealTable: false,
  _ceremonyKey: '',
  _matchKey: '',
  _ceremonySkip: false,
  _ceremonyContinue: null,
  rulesPage: 0,
  // room defaults chosen on the Options screen (persisted)
  opts: { players: 2, winScore: 21, timer: 30, bot: 'medium', speed: 'normal', forceCapture: true, captureAssist: false },

  // ========== LOGGING ==========
  // Leveled logger. error/warn always print; info/debug print only in verbose mode
  // (debug panel open, ?debug=1, or localStorage chkoba_debug="true").
  log(level, ...args) {
    if ((level === 'info' || level === 'debug') && !this._verbose && !this.debugEnabled) return;
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
    Shader.init(document.getElementById('bg-shader'));
    Shader.start();
    Shader.setEnabled(Look.prefs.animations && Shader.wanted);

    try {
      firebase.initializeApp(firebaseConfig);
      this._db = firebase.database();
      // a local firebase-config.js may point at the Realtime Database emulator for testing
      if (firebaseConfig.emulator) this._db.useEmulator(firebaseConfig.emulator.host, firebaseConfig.emulator.port);
      else firebase.auth().signInAnonymously().catch((err) => {
        this.log('error', 'Anonymous auth failed:', err);
      });
      this.log('info', 'Firebase initialized');
    } catch (e) {
      this.log('error', 'Firebase init failed:', e);
      this._db = null;
      this.showConfigError();
    }

    this.bindScreens();
    this.renderMenuCards();

    const code = params.get('room');
    if (code) this.showJoin(code.toUpperCase());
    else this.showMenu();

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (this.debugEnabled) { this.toggleDebug(); return; }
      if (this.menuOpen) { this.toggleMenu(); return; }
      const open = document.querySelector('.overlay.open');
      if (open && open.id !== 'ov-ceremony' && open.id !== 'ov-match') { this.closeOverlay(open.id); return; }
      if (this.gameState && this.gameState.phase === 'playing') this.cancelSelection();
    });
    // audio needs a gesture: the first pointer anywhere unlocks both sound engines
    document.addEventListener('pointerdown', () => { this._audioUnlocked = true; Juice.unlock(); }, { once: true });
    window.debug = () => { this.toggleDebug(); };
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
      const slot = +b.dataset.slot;
      if (b.dataset.act === 'addbot') this.addBotToWaiting(slot);
      else if (b.dataset.act === 'removebot') this.removeBotFromWaiting(slot);
      else if (b.dataset.act === 'swap') this.swapPlayers(slot);
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

  readName(inputId) {
    const name = document.getElementById(inputId).value.trim();
    if (!name) { this.toast('Enter your name first'); document.getElementById(inputId).focus(); return null; }
    this._rememberName(name);
    return name;
  },

  // ========== ROOM MANAGEMENT ==========
  createGame() {
    if (!this._db) { this.showConfigError(); this.toast('Online play is not available'); return; }
    const name = this.readName('menu-name'); if (!name) return;
    Juice.unlock();
    this.myName = name;
    this.isHost = true;
    this._isBotGame = false;
    this.playerCount = +this.opts.players;
    this.forceCapture = !!this.opts.forceCapture;
    this.captureAssist = !!this.opts.captureAssist;
    this.winScore = +this.opts.winScore;
    this.turnTimerDuration = +this.opts.timer;
    this.botDifficulty = this.opts.bot;
    this.gameSpeed = this.opts.speed;
    const look = Look.setLook(Look.savedLook(), false);

    this.roomCode = genRoomCode();
    this.myPlayerId = 0;
    this.playerList = [this.myName];
    this.moveLog = [];
    this._botPlayers = {};
    this._playerSlots = { 0: this.myName };
    this._roomStarted = false;

    this._roomRef = this._db.ref('rooms/' + this.roomCode);
    this._roomRef.set({
      host: this.myName,
      playerCount: this.playerCount,
      forceCapture: this.forceCapture,
      captureAssist: this.captureAssist,
      winScore: this.winScore,
      turnTimerDuration: this.turnTimerDuration,
      look,
      players: { 0: this.myName },
      started: false,
    }).then(() => {
      // NOTE: we deliberately do NOT arm onDisconnect().remove() on the room. onDisconnect
      // fires on any transient drop (mobile blip, tab backgrounding), which would delete a
      // live game on a 2-second hiccup and, since the host's next update() recreates the
      // room without a host child, corrupt it permanently. Robust handling needs presence
      // + a reconnect grace period + host migration (tracked in docs/AUDIT.md item 3).
      const baseUrl = window.location.href.split('?')[0];
      const currentParams = new URLSearchParams(window.location.search);
      currentParams.delete('room');
      currentParams.set('room', this.roomCode);
      this.roomLink = baseUrl + '?' + currentParams.toString();
      this.toast('Room ready');
      this.log('info', 'room created', this.roomCode, '(' + this.playerCount + 'p)');

      const playersRef = this._roomRef.child('players');
      playersRef.on('value', (snap) => {
        const players = snap.val() || {};
        this._playerSlots = players;
        this.playerList = [];
        for (let i = 0; i < this.playerCount; i++) {
          if (players[i]) this.playerList.push(players[i]);
        }
        if (this.playerList.length > 0 && this.playerList[0] !== this.myName) {
          this.playerList.unshift(this.myName);
        }
        this.renderWaiting();
      });
      this._playerListeners.push(playersRef);

      // Moves. Wrap the callback so a malformed payload from a client can't throw and
      // tear down the host's move listener (which would freeze the game).
      this._movesRef = this._roomRef.child('moves');
      this._moveCallback = (snap) => {
        try {
          const move = snap.val();
          if (!move || move.playerId === undefined) return;
          snap.ref.remove().catch(err => this.log('warn', 'failed to clear move node:', err.message));
          if (this._gameFrozen) {
            this.log('debug', 'move rejected (frozen): player', move.playerId);
            return;
          }
          this.log('debug', 'move received from player', move.playerId, move);
          this.handlePlay(move);
        } catch (e) {
          this.log('error', 'move handler threw:', e);
        }
      };
      this._movesRef.orderByChild('ts').on('child_added', this._moveCallback);
      this._playerListeners.push(this._movesRef);

      this.showWaiting();
    }).catch((err) => {
      this.log('error', 'room creation failed:', err);
      this.toast('Could not create the room: ' + err.message);
    });
  },

  joinGame() {
    if (!this._db) { this.showConfigError(); this.toast('Online play is not available'); return; }
    const code = document.getElementById('j-code').value.trim().toUpperCase();
    if (!code) { this.toast('Enter the room code'); return; }
    const name = this.readName('j-name'); if (!name) return;
    Juice.unlock();
    this.roomCode = code;
    this.myName = name;
    this.isHost = false;
    this._isBotGame = false;
    this.moveLog = [];

    this._roomRef = this._db.ref('rooms/' + this.roomCode);

    this._roomRef.once('value').then((snap) => {
      const room = snap.val();
      if (!room || !room.host) { this.toast('Room not found'); return; }
      // a slot freed by a dropped player must not let a newcomer into a running game
      if (room.started) { this.toast('That game has already started'); return; }
      const playerCount = room.playerCount || 2;
      this.playerCount = playerCount;
      this.forceCapture = room.forceCapture !== false;
      this.captureAssist = !!room.captureAssist;
      this.winScore = room.winScore || 21;
      this.turnTimerDuration = room.turnTimerDuration || 0;
      Look.setLook(room.look || Look.DEFAULT_LOOK, false);

      // Claim the first free slot atomically. The transaction callback must be pure and
      // re-entrant (Firebase may run it several times), so it recomputes the slot from
      // the current value each run; claimedSlot holds the slot of the committing run.
      let claimedSlot = -1;
      this._roomRef.child('players').transaction((players) => {
        players = players || {};
        let slot = -1;
        for (let i = 0; i < playerCount; i++) {
          if (!players[i]) { slot = i; break; }
        }
        if (slot < 0) { claimedSlot = -1; return; } // abort: room full
        claimedSlot = slot;
        players[slot] = this.myName;
        return players;
      }, (err, committed) => {
        if (err) { this.log('error', 'slot-claim transaction failed:', err); this.toast('Could not join: ' + err.message); return; }
        if (!committed || claimedSlot < 0) { this.log('info', 'join rejected: room full'); this.toast('Room is full'); return; }

        const myId = claimedSlot;
        this.myPlayerId = myId;
        this.log('info', 'joined room', this.roomCode, 'as player', myId);
        // Free our slot if we disconnect, so a refresh/drop doesn't leave a ghost that
        // blocks rejoining or stalls turn rotation.
        this._roomRef.child('players/' + myId).onDisconnect().remove();
        this.toast('Joined');
        this.roomLink = window.location.href.split('?')[0] + '?room=' + this.roomCode;

        const stateRef = this._roomRef.child('state');
        stateRef.on('value', (s) => {
          try {
            const state = s.val();
            if (state) this.handleStateUpdate(state);
          } catch (e) {
            this.log('error', 'state update handler threw:', e);
          }
        }, (err) => this.log('error', 'state listener cancelled:', err.message));
        this._playerListeners.push(stateRef);

        const handRef = this._roomRef.child('hand_' + myId);
        handRef.on('value', (s) => {
          try {
            this.myHand = s.val() || [];
            this.log('debug', 'hand updated:', this.myHand.length, 'cards');
            if (this.gameState) this.renderGame();
          } catch (e) {
            this.log('error', 'hand update handler threw:', e);
          }
        }, (err) => this.log('error', 'hand listener cancelled:', err.message));
        this._playerListeners.push(handRef);

        const logRef = this._roomRef.child('log');
        logRef.on('value', (s) => {
          const log = s.val();
          if (log) { this.moveLog = log.slice(-50); if (this.menuOpen && this.menuTab === 'log') this.renderMenuContent(); }
        });
        this._playerListeners.push(logRef);

        const emoteRef = this._roomRef.child('emote');
        emoteRef.on('value', (s) => {
          const e = s.val();
          if (e && e.name && e.text) this.showEmote(e.name, e.text);
        });
        this._playerListeners.push(emoteRef);

        // Detect the host leaving WITHOUT subscribing to the whole room node (that streamed
        // every player's private hand_* to every client). The host child is set once at
        // creation and removed when the host leaves.
        const hostRef = this._roomRef.child('host');
        hostRef.on('value', (s) => {
          if (!s.val() && this.gameState) {
            this.log('info', 'host left, returning to the menu');
            this.toast('The host left, the game is over');
            this.backToLobby();
          }
        });
        this._playerListeners.push(hostRef);

        const joinPlayersRef = this._roomRef.child('players');
        joinPlayersRef.on('value', (snap) => {
          const pdata = snap.val() || {};
          this._playerSlots = pdata;
          this.playerList = [];
          for (let i = 0; i < playerCount; i++) if (pdata[i]) this.playerList.push(pdata[i]);
          if (!this.gameState) this.renderWaiting();
        });
        this._playerListeners.push(joinPlayersRef);

        this.showWaiting();
      });
    }).catch((err) => {
      this.log('error', 'join failed (room read):', err);
      this.toast('Could not join: ' + err.message);
    });
  },

  // ========== WAITING ROOM ==========
  renderWaiting() {
    const $ = (id) => document.getElementById(id);
    $('w-code').textContent = this.roomCode;
    $('w-link').textContent = this.roomLink;
    $('w-sub').textContent = this.isHost ? 'share the code or the link' : 'joined as ' + this.myName;
    const slots = this._playerSlots || {};
    const box = $('w-slots'); box.innerHTML = '';
    const n = this.playerCount;
    const order = n === 4 ? [0, 2, 1, 3] : [0, 1];   // teams read as columns: team 1 left, team 2 right
    order.forEach((slot) => {
      const d = document.createElement('div');
      const team = n === 4 ? (slot % 2) + 1 : slot + 1;
      const who = slots[slot];
      d.className = `slot t${team}${who ? '' : ' empty'}`;
      if (who) {
        const isBot = !!this._botPlayers[slot];
        const btns = [];
        if (this.isHost && isBot) btns.push(`<button class="pill sm ghost" data-act="removebot" data-slot="${slot}" title="Remove bot">✕</button>`);
        if (this.isHost && n === 4 && slot !== 0) btns.push(`<button class="pill sm ghost" data-act="swap" data-slot="${slot}" title="Swap team">⇄</button>`);
        d.innerHTML = `<div class="av">${isBot ? 'BOT' : escapeHtml(who.charAt(0).toUpperCase())}</div>
          <div class="who">${isBot ? '<span class="bot">bot</span>' : ''}${escapeHtml(who)}${slot === this.myPlayerId ? ' (you)' : ''}<small>${n === 4 ? `Team ${team}` : slot === 0 ? 'host' : 'guest'}</small></div>
          <div class="btns">${btns.join('')}</div>`;
      } else if (this.isHost) {
        d.innerHTML = `<span>empty</span><div class="btns"><button class="pill sm chip" data-act="addbot" data-slot="${slot}">+ bot</button></div>`;
      } else {
        d.textContent = 'waiting for a player';
      }
      box.appendChild(d);
    });

    const filled = order.filter((s) => slots[s]).length;
    const remaining = n - filled;
    const btn = $('w-start');
    btn.hidden = !this.isHost;
    if (this.isHost) {
      btn.disabled = remaining > 0 || this._roomStarted;
      btn.textContent = this._roomStarted ? 'Starting' : 'Start';
    }
    $('w-note').textContent = this.isHost
      ? (remaining > 0 ? `waiting for ${remaining} more player${remaining !== 1 ? 's' : ''}` : 'everyone is here')
      : 'the host starts the game';
  },

  swapPlayers(slot) {
    if (!this.isHost || this.playerCount !== 4 || slot === 0) return;
    const target = slot === 2 ? 1 : 2;
    this._roomRef.child('players').transaction(current => {
      if (!current) return current;
      const p = {};
      for (let i = 0; i < 4; i++) if (current[i]) p[i] = current[i];
      if (!p[slot] || !p[target]) return;
      const tmp = p[slot];
      p[slot] = p[target];
      p[target] = tmp;
      return p;
    }, (err, committed) => {
      if (!err && committed) {
        const slotBot = this._botPlayers[slot];
        const targetBot = this._botPlayers[target];
        delete this._botPlayers[slot];
        delete this._botPlayers[target];
        if (slotBot) this._botPlayers[target] = slotBot;
        if (targetBot) this._botPlayers[slot] = targetBot;
      }
    });
  },

  copyRoomLink() {
    if (!this.roomLink) { this.toast('No room link in a bot game'); return; }
    navigator.clipboard.writeText(this.roomLink).then(() => {
      this.toast('Link copied');
    }).catch(() => {
      this.toast('Share this link: ' + this.roomLink);
    });
  },

  leaveRoom() {
    this.cleanupListeners();
    this.releaseRoom();
    this._roomRef = null;
    this._stateRef = null;
    this._movesRef = null;
    this.gameState = null;
    this.myHand = [];
    this.playerList = [];
    this._botPlayers = {};
    this._playerSlots = {};
    this._roomStarted = false;
    this.stopTurnTimer();
    this.showMenu();
  },

  backToLobby() {
    this.cleanupListeners();
    this.releaseRoom();
    this._roomRef = null;
    this._stateRef = null;
    this._movesRef = null;
    this.gameState = null;
    this._shown = null;
    this.myHand = [];
    this.selectedCardIndex = -1;
    this.selectedCaptureIndices = [];
    this.availableCaptures = [];
    this.moveLog = [];
    this.playerList = [];
    this._botPlayers = {};
    this._playerSlots = {};
    this._roomStarted = false;
    this._isBotGame = false;
    this._ceremonyKey = ''; this._matchKey = ''; this._ceremonyContinue = null;
    this.stopTurnTimer();
    this.closeAllOverlays();
    this.showMenu();
  },

  cleanupListeners() {
    this._playerListeners.forEach(ref => { if (ref) ref.off(); });
    this._playerListeners = [];
    this._moveCallback = null;
  },

  // Release our presence on a clean exit: the host deletes the room; a player frees its
  // own slot. Cancel the matching onDisconnect first so it can't fire later on a node we
  // already removed.
  releaseRoom() {
    if (!this._roomRef) return;
    if (this.isHost) {
      this._roomRef.remove().catch(() => {});
    } else if (this.myPlayerId >= 0) {
      const slotRef = this._roomRef.child('players/' + this.myPlayerId);
      slotRef.onDisconnect().cancel();
      slotRef.remove().catch(() => {});
    }
  },

  showConfigError() {
    this._dbError = true;
    const banner = document.getElementById('config-error');
    if (banner) banner.hidden = false;
    ['m-create', 'j-go'].forEach(id => { const b = document.getElementById(id); if (b) b.disabled = true; });
  },

  // ========== PLAY VS BOT ==========
  playVsBot() {
    const name = this.readName('menu-name'); if (!name) return;
    Juice.unlock();
    this.myName = name;
    this.isHost = true;
    this._isBotGame = true;
    this.playerCount = 2;
    this.forceCapture = !!this.opts.forceCapture;
    this.captureAssist = !!this.opts.captureAssist;
    this.winScore = +this.opts.winScore;
    this.turnTimerDuration = +this.opts.timer;
    this.botDifficulty = this.opts.bot;
    this.gameSpeed = this.opts.speed;
    Look.setLook(Look.savedLook(), false);

    this.roomCode = 'BOT';
    this.roomLink = '';
    this.myPlayerId = 0;
    const botNames = { easy: 'Bot (easy)', medium: 'Bot', hard: 'Bot (hard)' };
    this.playerList = [this.myName, botNames[this.botDifficulty] || 'Bot'];
    this.moveLog = [];
    this._roomRef = null;
    this._botPlayers = {};
    this._playerSlots = {};
    this.startGame();
  },

  isBotPlayer(playerId) {
    if (this._isBotGame && playerId === 1) return true;
    return !!this._botPlayers[playerId];
  },

  getBotDifficulty(playerId) {
    if (this._isBotGame && playerId === 1) return this.botDifficulty || 'medium';
    return this._botPlayers[playerId] || 'medium';
  },

  triggerBotPlay() {
    if (!this.isHost || !this.gameState) return;
    const gs = this.gameState;
    if (gs.phase !== 'playing' || gs.currentTurn < 0) return;
    if (this._controllingPlayerId === gs.currentTurn) return;
    if (this.isBotPlayer(gs.currentTurn)) {
      this.botPlayForPlayer(gs.currentTurn);
    }
  },

  addBotToWaiting(slot) {
    if (!this.isHost || !this._roomRef) return;
    if (this._playerSlots[slot]) { this.toast('Slot is taken'); return; }

    const diff = this.opts.bot || 'medium';
    const botNames = { easy: 'Bot (easy)', medium: 'Bot', hard: 'Bot (hard)' };
    let name = botNames[diff] || 'Bot';

    const existing = Object.values(this._playerSlots).filter(Boolean);
    let n = 2;
    const base = name;
    while (existing.includes(name)) { name = base + ' ' + n; n++; }

    this._roomRef.child('players/' + slot).transaction(current => {
      if (current) return;
      return name;
    }, (err, committed) => {
      if (err || !committed) { this.toast('Slot was taken'); return; }
      this._botPlayers[slot] = diff;
      this.toast('Added ' + name);
    });
  },

  removeBotFromWaiting(slot) {
    if (!this.isHost || !this._roomRef) return;
    if (!this._botPlayers[slot]) { this.toast('Not a bot'); return; }
    this._roomRef.child('players/' + slot).remove();
    delete this._botPlayers[slot];
    this.toast('Bot removed');
  },

  botPlay() { this.triggerBotPlay(); },

  botPlayForPlayer(playerId) {
    if (!this.isHost) return;
    const gs = this.gameState;
    if (!gs || gs.phase !== 'playing' || gs.currentTurn !== playerId) return;

    const hand = gs.hands[playerId];
    if (!hand || hand.length === 0) return;

    const diff = this.getBotDifficulty(playerId);
    let bestMove = null;
    let bestScore = -1;

    if (diff === 'easy') {
      const card = hand[Math.floor(Math.random() * hand.length)];
      const captures = findCaptureCombinations(gs.tableCards, card.value);
      if (captures.length > 0) {
        const combo = captures[Math.floor(Math.random() * captures.length)];
        bestMove = { cardId: card.id, captureCardIds: combo.map(i => gs.tableCards[i].id) };
        bestScore = 1;
      } else {
        bestMove = { cardId: card.id, captureCardIds: [] };
      }
    } else {
      for (let ci = 0; ci < hand.length; ci++) {
        const card = hand[ci];
        const captures = findCaptureCombinations(gs.tableCards, card.value);
        if (captures.length > 0) {
          for (const combo of captures) {
            let score = combo.length;
            const capturedCards = combo.map(i => gs.tableCards[i]);
            if (capturedCards.some(c => c.suit === 'diamonds')) score += 3;
            if (capturedCards.some(c => c.suit === 'diamonds' && c.name === '7')) score += 5;
            if (combo.length === gs.tableCards.length) score += 10;
            if (diff === 'hard') {
              if (capturedCards.some(c => c.name === '7')) score += 4;
              const directMatch = capturedCards.length === 1 && capturedCards[0].value === card.value;
              if (directMatch) score += 2;
            }
            if (score > bestScore) {
              bestScore = score;
              bestMove = { cardId: card.id, captureCardIds: combo.map(i => gs.tableCards[i].id) };
            }
          }
        }
      }

      if (!bestMove) {
        const safeCards = hand.filter(c => !findCaptureCombinations(gs.tableCards, c.value).length);
        if (diff === 'hard' && safeCards.length > 0) {
          const lowCards = safeCards.sort((a, b) => a.value - b.value);
          bestMove = { cardId: lowCards[0].id, captureCardIds: [] };
        } else {
          const card = safeCards.length > 0 ? safeCards[0] : hand[0];
          bestMove = { cardId: card.id, captureCardIds: [] };
        }
      }
    }

    if (gs.forceCapture && bestScore < 0 && hasDirectMatch(hand, gs.tableCards)) {
      for (const c of hand) {
        const directIdx = gs.tableCards.findIndex(tc => tc.value === c.value);
        if (directIdx >= 0) {
          bestMove = { cardId: c.id, captureCardIds: [gs.tableCards[directIdx].id] };
          break;
        }
      }
    }

    // The delay is a function of the speed setting only, never of the hand (a
    // hand-dependent think time would leak information). The move waits for the
    // board to finish animating the previous one so no two moves overlap.
    const delays = { slow: 1200 + Math.random() * 800, normal: 600 + Math.random() * 800, fast: 200 + Math.random() * 300 };
    const token = gs.gameToken;
    setTimeout(() => {
      this.whenIdle().then(() => {
        const cur = this.gameState;
        if (cur && cur.gameToken === token && cur.phase === 'playing' && cur.currentTurn === playerId) {
          this.handlePlay({ playerId, ...bestMove });
        }
      });
    }, delays[this.gameSpeed] || delays.normal);
  },

  // Resolves once the render queue is idle (no choreography running).
  whenIdle() {
    if (!this._animating) return Promise.resolve();
    return new Promise((r) => this._idleResolvers.push(r));
  },

  // ========== START GAME ==========
  startGame() {
    if (!this.isHost) return;

    const players = this.playerList || [];
    const numPlayers = this.playerCount;
    if (players.length < numPlayers) { this.toast('Not enough players'); return; }

    this._roomStarted = true;
    if (this._roomRef) this._roomRef.update({ started: true }).catch((err) => this.log('warn', 'could not mark the room started:', err.message));

    const totalPlayerCards = numPlayers * 3;
    const remainingRounds = Math.ceil((40 - 4 - totalPlayerCards) / totalPlayerCards);
    const totalRounds = 1 + remainingRounds;

    this.moveLog = [];
    this._ceremonyKey = ''; this._matchKey = ''; this._ceremonyContinue = null;
    this.closeAllOverlays();

    this.gameState = {
      phase: 'playing', numPlayers,
      gameToken: Date.now(),
      players: players.map((name, i) => ({ id: i, name, team: numPlayers === 4 ? (i % 2) : i, isBot: this.isBotPlayer(i) })),
      deck: shuffle(createDeck()), tableCards: [], hands: players.map(() => []),
      capturedTeams: [[], []], currentTurn: -1, dealerIndex: 0, roundNum: 0, totalRounds,
      cardsPlayedThisRound: players.map(() => 0), lastCaptureTeam: -1,
      shkobbaCount: [0, 0], scores: [0, 0],
      forceCapture: this.forceCapture, captureAssist: this.captureAssist, winScore: this.winScore, shkobbaThisTurn: false,
      turnTimerDuration: this.turnTimerDuration, lastMove: null, moveSeq: 0,
      look: Look.get(), endReason: null,
    };
    this.addLogEntry('Game started');
    this.log('info', 'game started:', numPlayers, 'players, win at', this.winScore);
    this.dealRound();
  },

  // ========== DEALING ==========
  dealRound() {
    const gs = this.gameState;
    if (gs.roundNum === 0) {
      for (let i = 0; i < 4 && gs.deck.length > 0; i++) gs.tableCards.push(gs.deck.pop());
      gs.currentTurn = (gs.dealerIndex + 1) % gs.numPlayers;
    } else {
      gs.currentTurn = gs.nextDealerTurn !== undefined ? gs.nextDealerTurn : (gs.dealerIndex + 1) % gs.numPlayers;
    }
    for (let i = 0; i < gs.numPlayers; i++) {
      gs.hands[i] = [];
      for (let j = 0; j < 3 && gs.deck.length > 0; j++) gs.hands[i].push(gs.deck.pop());
    }
    gs.cardsPlayedThisRound = gs.cardsPlayedThisRound.map(() => 0);
    gs.shkobbaThisTurn = false;
    this.addLogEntry('Cards dealt, hand ' + (gs.roundNum + 1));
    this.broadcastGameState();
    this.renderGame();
    this.startTurnTimer();
    this.triggerBotPlay();
  },

  // ========== TURN MANAGEMENT ==========
  nextTurn() {
    const gs = this.gameState;
    let next = (gs.currentTurn + 1) % gs.numPlayers, attempts = 0;
    while (gs.hands[next].length === 0 && attempts < gs.numPlayers) {
      next = (next + 1) % gs.numPlayers; attempts++;
    }
    if (attempts >= gs.numPlayers || gs.hands.every(h => h.length === 0)) {
      this.endRound(); return;
    }
    gs.currentTurn = next;
    this.broadcastGameState();
    this.renderGame();
    this.startTurnTimer();
    this.triggerBotPlay();
  },

  endRound() {
    const gs = this.gameState;
    gs.roundNum++;
    this.stopTurnTimer();
    if (gs.deck.length === 0) {
      if (gs.tableCards.length > 0 && gs.lastCaptureTeam >= 0) {
        gs.capturedTeams[gs.lastCaptureTeam].push(...gs.tableCards);
        gs.tableCards = [];
      }
      this.calculateScores(); return;
    }
    this.dealRound();
  },

  // ========== TURN TIMER ==========
  // One anchor per turn: the clock restarts when the turn changes, not on every
  // broadcast, so a host toggling a setting mid-turn does not reset everyone's timer.
  turnKey(gs) { return gs ? `${gs.gameToken}:${gs.roundNum}:${gs.moveSeq}:${gs.currentTurn}` : ''; },

  startTurnTimer() {
    const gs = this.gameState;
    if (this._timerRAF) { cancelAnimationFrame(this._timerRAF); this._timerRAF = null; }
    if (this._turnTimer) { clearTimeout(this._turnTimer); this._turnTimer = null; }
    if (!gs) return;
    const key = this.turnKey(gs);
    if (key !== this._turnKey) { this._turnKey = key; this._turnTimerStart = Date.now(); this._lastTimerSec = 0; }
    if (this._gameFrozen || gs.frozen) { this.renderTurnLabel(gs); return; }
    if (gs.phase !== 'playing' || gs.currentTurn < 0) { this.renderTurnLabel(gs); return; }

    const duration = gs.turnTimerDuration || 0;
    if (duration > 0 && this.isHost) {
      const remaining = Math.max(0, duration * 1000 - (Date.now() - this._turnTimerStart));
      this._turnTimer = setTimeout(() => this.whenIdle().then(() => this.autoPlay()), remaining);
    }
    this.animateTurnFill();
  },

  stopTurnTimer() {
    if (this._turnTimer) { clearTimeout(this._turnTimer); this._turnTimer = null; }
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

  autoPlay() {
    if (!this.isHost) return;
    const gs = this.gameState;
    if (!gs || gs.phase !== 'playing' || gs.currentTurn < 0) return;
    if (this._gameFrozen) return;

    this.playSound('timeout');

    const playerId = gs.currentTurn;
    const hand = gs.hands[playerId];
    if (!hand || hand.length === 0) return;

    let card = null, captureIds = [];

    if (gs.forceCapture && gs.tableCards.length > 0) {
      for (const c of hand) {
        const directIdx = gs.tableCards.findIndex(tc => tc.value === c.value);
        if (directIdx >= 0) {
          card = c;
          captureIds = [gs.tableCards[directIdx].id];
          break;
        }
      }
    }

    if (!card) {
      const cardIndex = Math.floor(Math.random() * hand.length);
      card = hand[cardIndex];
      const captures = findCaptureCombinations(gs.tableCards, card.value);
      if (captures.length > 0) {
        captureIds = captures[0].map(i => gs.tableCards[i].id);
      }
    }

    const playerName = gs.players[playerId] ? gs.players[playerId].name : 'Player ' + playerId;
    this.addLogEntry(`Time's up: ${playerName} auto-played ${getCardDisplayName(card)}`);
    this.toast(`${playerName} ran out of time`);

    this.handlePlay({ playerId, cardId: card.id, captureCardIds: captureIds });
  },

  // ========== PLAY LOGIC ==========
  handlePlay(data) {
    if (!this.isHost) return;
    const gs = this.gameState, playerId = data.playerId;
    if (!gs) { this.log('warn', 'handlePlay ignored: no game state'); return; }
    if (gs.phase !== 'playing') { this.log('warn', 'move rejected: phase', gs.phase); return; }
    if (playerId !== gs.currentTurn) {
      this.log('warn', 'move rejected: out of turn (player', playerId, 'current', gs.currentTurn + ')');
      return;
    }

    this.stopTurnTimer();
    this._pushHistory();
    gs.shkobbaThisTurn = false;

    const hand = gs.hands[playerId];
    const cardIndex = hand ? hand.findIndex(c => c.id === data.cardId) : -1;
    if (cardIndex === -1) {
      this.log('warn', 'move rejected: card', data.cardId, 'not in player', playerId + "'s hand");
      this.startTurnTimer();
      return;
    }

    const playedCard = hand[cardIndex];
    const captureIds = data.captureCardIds || [];

    if (captureIds.length > 0) {
      const capIndices = captureIds.map(id => gs.tableCards.findIndex(c => c.id === id));
      if (capIndices.includes(-1)) {
        this.log('warn', 'move rejected: a capture card is not on the table');
        this.startTurnTimer();
        return;
      }
      const sum = capIndices.reduce((s, idx) => s + gs.tableCards[idx].value, 0);
      if (sum !== playedCard.value) {
        this.log('warn', 'move rejected: capture sum', sum, '!= card value', playedCard.value);
        this.startTurnTimer();
        return;
      }
    } else if (gs.forceCapture && gs.tableCards.length > 0) {
      if (hasDirectMatch(hand, gs.tableCards)) {
        this.log('debug', 'move rejected: force-capture is on and a direct match exists');
        this.startTurnTimer();
        return;
      }
    }

    this.log('debug', 'processing move: player', playerId, 'plays', getCardDisplayName(playedCard),
      captureIds.length ? '(capture)' : '(place)');

    hand.splice(cardIndex, 1);
    const teamIndex = gs.players[playerId].team;
    const playerName = gs.players[playerId].name;
    const slim = (c) => ({ id: c.id, name: c.name, suit: c.suit, display: c.display, value: c.value });
    gs.moveSeq = (gs.moveSeq || 0) + 1;
    gs.lastMove = { seq: gs.moveSeq, playerId, teamIndex, card: slim(playedCard), taken: [], chkobba: false };

    if (captureIds.length > 0) {
      const capturedCards = [];
      const sorted = [...captureIds].sort((a, b) => gs.tableCards.findIndex(c => c.id === b) - gs.tableCards.findIndex(c => c.id === a));
      for (const id of sorted) {
        const idx = gs.tableCards.findIndex(c => c.id === id);
        if (idx !== -1) capturedCards.push(...gs.tableCards.splice(idx, 1));
      }
      gs.lastMove.taken = capturedCards.map(slim);
      capturedCards.push(playedCard);
      gs.capturedTeams[teamIndex].push(...capturedCards);
      gs.lastCaptureTeam = teamIndex;

      const capturedNames = gs.lastMove.taken.map(c => getCardDisplayName(c)).join('+');
      let logMsg = `${playerName} took ${capturedNames} with ${getCardDisplayName(playedCard)}`;

      // Chkobba: clearing the table. The dealer's very last card of the deal does not count.
      if (gs.tableCards.length === 0) {
        if (playerId === gs.dealerIndex && hand.length === 0 && gs.deck.length === 0) {
          // last card of the dealer, no chkobba
        } else {
          gs.shkobbaCount[teamIndex]++;
          gs.shkobbaThisTurn = true;
          gs.lastMove.chkobba = true;
          logMsg += ', CHKOBBA';
        }
      }

      this.addLogEntry(logMsg);

      // Instant win: all 10 diamonds captured
      const diaCount = gs.capturedTeams[teamIndex].filter(c => c.suit === DIAMONDS).length;
      if (diaCount >= 10) {
        this.addLogEntry('All 10 diamonds captured, instant win');
        gs.phase = 'finished';
        gs.winner = teamIndex;
        gs.endReason = 'diamonds';
        gs.currentTurn = -1;
        this.playSound('win');
        this.broadcastGameState();
        this.renderGame();
        return;
      }
    } else {
      gs.tableCards.push(playedCard);
      this.addLogEntry(`${playerName} placed ${getCardDisplayName(playedCard)}`);
    }

    gs.cardsPlayedThisRound[playerId]++;
    if (playerId === this.activeId()) { this.isSubmittingMove = false; this.cancelSelection(false); }

    if (gs.hands.every(h => h.length === 0) && gs.deck.length === 0) {
      gs.currentTurn = -1;
      setTimeout(() => this.whenIdle().then(() => this.gameState === gs && this.endRound()), 400);
      this.broadcastGameState(); this.renderGame();
    } else if (gs.hands.every(h => h.length === 0)) {
      gs.nextDealerTurn = (playerId + 1) % gs.numPlayers;
      gs.currentTurn = -1;
      setTimeout(() => this.whenIdle().then(() => this.gameState === gs && this.endRound()), 400);
      this.broadcastGameState(); this.renderGame();
    } else {
      this.nextTurn();
    }
  },

  // ========== SCORING ==========
  calculateScores() {
    const gs = this.gameState;
    const teamCount = 2;

    const capturedCounts = [gs.capturedTeams[0].length, gs.capturedTeams[1].length];
    const diamondCounts = [0, 0], diamondSevens = [false, false];

    for (let t = 0; t < teamCount; t++) {
      for (const card of gs.capturedTeams[t]) {
        if (card.suit === DIAMONDS) {
          diamondCounts[t]++;
          if (card.name === '7') diamondSevens[t] = true;
        }
      }
    }

    let mostCardsPt = capturedCounts[0] !== capturedCounts[1] ? (capturedCounts[0] > capturedCounts[1] ? 0 : 1) : -1;
    let mostDiamondsPt = diamondCounts[0] !== diamondCounts[1] ? (diamondCounts[0] > diamondCounts[1] ? 0 : 1) : -1;

    let sevenDiamondsPt = -1;
    if (diamondSevens[0] && !diamondSevens[1]) sevenDiamondsPt = 0;
    else if (!diamondSevens[0] && diamondSevens[1]) sevenDiamondsPt = 1;

    // Most Sevens rule: more 7s gets +1. Tie on 7s: check 6s. Tie on 6s: no point.
    const sevenCounts = [0, 0];
    const sixCounts = [0, 0];
    for (let t = 0; t < teamCount; t++) {
      for (const card of gs.capturedTeams[t]) {
        if (card.name === '7') sevenCounts[t]++;
        if (card.name === '6') sixCounts[t]++;
      }
    }
    let mostSevensPt = -1;
    if (sevenCounts[0] !== sevenCounts[1]) {
      mostSevensPt = sevenCounts[0] > sevenCounts[1] ? 0 : 1;
    } else if (sixCounts[0] !== sixCounts[1]) {
      mostSevensPt = sixCounts[0] > sixCounts[1] ? 0 : 1;
    }

    if (mostCardsPt >= 0) gs.scores[mostCardsPt]++;
    if (mostDiamondsPt >= 0) gs.scores[mostDiamondsPt]++;
    if (sevenDiamondsPt >= 0) gs.scores[sevenDiamondsPt]++;
    if (mostSevensPt >= 0) gs.scores[mostSevensPt]++;
    gs.scores[0] += gs.shkobbaCount[0];
    gs.scores[1] += gs.shkobbaCount[1];

    // counts travel with the verdicts so every client can stage the same tally
    gs.lastScore = {
      mostCardsPt, mostDiamondsPt, sevenDiamondsPt, mostSevensPt,
      counts: { cards: capturedCounts, diamonds: diamondCounts, haya: diamondSevens.map(Number), sevens: sevenCounts, sixes: sixCounts },
    };
    gs.phase = 'round_end';
    this.addLogEntry(`Deal scored: ${gs.scores[0]} - ${gs.scores[1]}`);
    this.log('info', 'round scored:', gs.scores[0], '-', gs.scores[1]);
    this.broadcastGameState();
    this.renderGame();
  },

  checkWinCondition() {
    const gs = this.gameState;
    let winner = -1;
    if (gs.scores[0] >= gs.winScore || gs.scores[1] >= gs.winScore) {
      if (gs.scores[0] > gs.scores[1]) winner = 0;
      else if (gs.scores[1] > gs.scores[0]) winner = 1;
    }
    if (winner >= 0) {
      gs.phase = 'finished'; gs.winner = winner; gs.endReason = 'score';
      this.addLogEntry(`Team ${winner + 1} wins the game`);
      this.log('info', 'game over: Team', winner + 1, 'wins', gs.scores[0], '-', gs.scores[1]);
      this.playSound('win');
      this.broadcastGameState(); this.renderGame();
      return;
    }
    if (gs.deck.length > 0) { gs.phase = 'playing'; this.dealRound(); return; }

    // Deck is empty: the deal passes on and a fresh deck goes out
    gs.dealerIndex = (gs.dealerIndex + 1) % gs.numPlayers;
    gs.totalRounds = 1 + Math.ceil((40 - 4 - gs.numPlayers * 3) / (gs.numPlayers * 3));
    gs.phase = 'playing'; gs.deck = shuffle(createDeck());
    gs.capturedTeams = [[], []]; gs.shkobbaCount = [0, 0]; gs.lastCaptureTeam = -1;
    gs.tableCards = []; gs.roundNum = 0; gs.lastMove = null; gs.lastScore = null; this.dealRound();
  },

  // ========== NETWORKING ==========
  broadcastGameState() {
    if (!this.isHost || !this.gameState) return;
    const gs = this.gameState;

    if (this._roomRef) {
      const updates = {};
      updates['state'] = this.buildPublicState();
      for (let i = 0; i < gs.numPlayers; i++) {
        updates['hand_' + i] = gs.hands[i] || [];
      }
      updates['log'] = this.moveLog.slice(-50);
      this._roomRef.update(updates).catch(err => {
        this.log('error', 'broadcastGameState write failed:', err.message);
        this.toast('Connection issue, the move may not have synced');
      });
    }
    this.log('debug', 'broadcast state: turn', gs.currentTurn, 'phase', gs.phase, 'deck', gs.deck.length);

    this.myHand = gs.hands[this.activeId()] || [];
    this.renderGame();
  },

  buildPublicState() {
    const gs = this.gameState;
    return {
      phase: gs.phase, numPlayers: gs.numPlayers, gameToken: gs.gameToken,
      players: gs.players.map(p => ({ id: p.id, name: p.name, team: p.team, isBot: !!p.isBot })),
      tableCards: [...gs.tableCards], deckCount: gs.deck.length,
      currentTurn: gs.currentTurn, dealerIndex: gs.dealerIndex,
      roundNum: gs.roundNum, totalRounds: gs.totalRounds,
      lastCaptureTeam: gs.lastCaptureTeam, shkobbaCount: [...gs.shkobbaCount],
      capturedCounts: gs.capturedTeams.map(t => t.length),
      scores: [...gs.scores], forceCapture: gs.forceCapture, captureAssist: !!gs.captureAssist, winScore: gs.winScore,
      cardsPlayedThisRound: [...gs.cardsPlayedThisRound],
      lastScore: gs.lastScore || null, shkobbaThisTurn: gs.shkobbaThisTurn || false,
      winner: gs.winner !== undefined ? gs.winner : -1,
      endReason: gs.endReason || null,
      turnTimerDuration: gs.turnTimerDuration || 0,
      nextDealerTurn: gs.nextDealerTurn !== undefined ? gs.nextDealerTurn : -1,
      diamondOwnership: this.getDiamondOwnership(),
      lastMove: gs.lastMove || null, moveSeq: gs.moveSeq || 0,
      look: gs.look || Look.get(),
      frozen: this._gameFrozen || false,
    };
  },

  getDiamondOwnership() {
    const gs = this.gameState;
    if (!gs) return {};
    const ownership = {};
    for (let t = 0; t < 2; t++) {
      for (const card of (gs.capturedTeams[t] || [])) {
        if (card.suit === DIAMONDS) ownership[card.name] = t;
      }
    }
    return ownership;
  },

  // ========== PLAYER STATE HANDLER (guests) ==========
  handleStateUpdate(data) {
    const oldState = this.gameState;
    const turnChanged = !oldState || oldState.currentTurn !== data.currentTurn || (oldState.moveSeq || 0) !== (data.moveSeq || 0) || oldState.gameToken !== data.gameToken;

    this.gameState = {
      phase: data.phase, numPlayers: data.numPlayers || 2, gameToken: data.gameToken || 0,
      players: data.players || [],
      tableCards: data.tableCards || [],
      deckCount: data.deckCount || 0,
      currentTurn: data.currentTurn,
      dealerIndex: data.dealerIndex,
      roundNum: data.roundNum,
      totalRounds: data.totalRounds,
      lastCaptureTeam: data.lastCaptureTeam,
      shkobbaCount: data.shkobbaCount || [0, 0],
      capturedCounts: data.capturedCounts || [0, 0],
      scores: data.scores || [0, 0],
      forceCapture: data.forceCapture !== undefined ? data.forceCapture : true,
      captureAssist: !!data.captureAssist,
      winScore: data.winScore || 21,
      cardsPlayedThisRound: data.cardsPlayedThisRound || [],
      lastScore: data.lastScore || null,
      shkobbaThisTurn: data.shkobbaThisTurn || false,
      winner: data.winner !== undefined ? data.winner : -1,
      endReason: data.endReason || null,
      turnTimerDuration: data.turnTimerDuration || 0,
      nextDealerTurn: data.nextDealerTurn !== -1 ? data.nextDealerTurn : undefined,
      diamondOwnership: data.diamondOwnership || {},
      lastMove: data.lastMove ? { ...data.lastMove, taken: data.lastMove.taken || [] } : null,
      moveSeq: data.moveSeq || 0,
      look: data.look || null,
      frozen: data.frozen || false,
    };
    if (this.gameState.look) Look.setLook(this.gameState.look, false);

    if (turnChanged) {
      this.isSubmittingMove = false;
      this.selectedCardIndex = -1;
      this.selectedCaptureIndices = [];
      this.availableCaptures = [];
    }

    if (oldState && oldState.phase === 'playing' && data.phase === 'finished') this.playSound('win');

    this.renderGame();
    if (data.phase === 'playing' && data.currentTurn >= 0) this.startTurnTimer();
    else this.stopTurnTimer();
  },

  // The seat this browser is playing: normally mine, or the seat the host is
  // possessing from the debug panel.
  activeId() { return this._controllingPlayerId !== null ? this._controllingPlayerId : this.myPlayerId; },

  // ========== PLAYER ACTIONS ==========
  canAct() {
    const gs = this.gameState;
    if (!gs) return false;
    if (gs.frozen && !this.isHost) { this.toast('The host paused the game'); return false; }
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
    this.availableCaptures = findCaptureCombinations(gs.tableCards, card.value);
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
    this.availableCaptures = findCaptureCombinations(gs.tableCards, card.value);
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
    if (gs.forceCapture && gs.tableCards.length > 0 && hasDirectMatch(this.myHand, gs.tableCards)) {
      this.toast('A matching card is on the table: you must take it'); return;
    }
    const card = this.myHand[this.selectedCardIndex];
    if (!card) return;
    this.sendMove(card.id, []);
  },

  confirmCapture() {
    if (this.selectedCardIndex === -1) { this.toast('Pick a card from your hand first'); return; }
    if (this.selectedCaptureIndices.length === 0) { this.toast('Pick the table cards to take'); return; }
    const card = this.myHand[this.selectedCardIndex];
    const gs = this.gameState;
    if (!card || !gs) return;
    const sum = this.selectedCaptureIndices.reduce((s, id) => {
      const c = gs.tableCards.find(tc => tc.id === id);
      return s + (c ? c.value : 0);
    }, 0);
    if (sum !== card.value) { this.toast('Those cards must add up to ' + card.value); return; }
    this.sendMove(card.id, this.selectedCaptureIndices.slice());
  },

  cancelSelection(repaint) {
    this.selectedCardIndex = -1;
    this.selectedCaptureIndices = [];
    this.availableCaptures = [];
    if (repaint !== false) this.refreshSelection();
  },

  sendMove(cardId, captureCardIds) {
    if (this.isSubmittingMove) return;
    this.isSubmittingMove = true;
    this.refreshSelection();
    if (this.isHost) {
      this.log('debug', 'sending move (host, direct)', { playerId: this.activeId(), cardId, captureCardIds });
      this.handlePlay({ playerId: this.activeId(), cardId, captureCardIds });
      // a rejected move leaves the flag set: release it so the player can try again
      this.isSubmittingMove = false;
      this.refreshSelection();
    } else if (this._roomRef) {
      this.log('debug', 'sending move (push to Firebase)', { cardId, captureCardIds });
      this._roomRef.child('moves').push({
        playerId: this.myPlayerId,
        cardId,
        captureCardIds,
        ts: Date.now(),
      }).catch(err => {
        this.log('error', 'move push failed:', err.message);
        this.toast('Could not send the move, check your connection');
        this.isSubmittingMove = false;
        this.refreshSelection();
      });
      // the host answers with a state update; if it rejects silently, unlock after a while
      clearTimeout(this._submitGuard);
      this._submitGuard = setTimeout(() => { if (this.isSubmittingMove) { this.isSubmittingMove = false; this.refreshSelection(); } }, 4000);
    }
  },

  // ========== MOVE LOG ==========
  addLogEntry(text) {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    this.moveLog.push({ time, text });
    if (this.moveLog.length > 100) this.moveLog.shift();
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
      const rs = this._idleResolvers; this._idleResolvers = [];
      rs.forEach((r) => r());
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
    if (this.isHost && gs.hands) this.myHand = gs.hands[this.activeId()] || [];
    this.showScreen('screen-game');
    const prev = this._shown;
    const cur = this._snapshot(gs);
    const anim = Look.prefs.animations && document.documentElement.dataset.screen === 'game';
    const sameGame = prev && prev.gameToken === cur.gameToken;

    const mv = gs.lastMove;
    if (anim && sameGame && mv && prev.moveSeq !== mv.seq) {
      await this._animateMove(prev, gs, mv);
    }

    // a fresh game deals the table too; a new hand deals only hands; a new deck (roundNum
    // back to 0 in the same game) deals both again
    const fresh = !sameGame;
    const newDeck = sameGame && cur.roundNum === 0 && prev.roundNum !== 0;
    const newHand = sameGame && cur.roundNum !== prev.roundNum;
    const handBack = sameGame && prev.handIds.length === 0 && cur.handIds.length > 0;
    if (fresh || newDeck) this._pendingDealTable = true;
    let deal = false;
    if ((fresh || newDeck || newHand || handBack) && cur.phase === 'playing') {
      if (cur.handIds.length > 0) deal = true;
      // the guest's hand arrives as a separate event: keep the intent until it lands
    }
    this._paint();
    this._shown = this._snapshot(this.gameState);
    if (deal) {
      const withTable = this._pendingDealTable;
      this._pendingDealTable = false;
      if (anim) await this._animateDeal(this.gameState, withTable);
    }
    this._afterPaint();
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
    try { this.renderBanners(gs); } catch (e) { this.log('error', 'renderBanners:', e.message); }
    try { this.updateDebugPanel(); } catch (e) { /* silent */ }
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
    $('hud-round').textContent = `${gs.roundNum + 1}/${gs.totalRounds}`;
    $('hud-deck').textContent = gs.deck ? gs.deck.length : (gs.deckCount || 0);
    $('hud-t1').textContent = gs.scores[0]; $('hud-t2').textContent = gs.scores[1];
    $('hud-t1-shk').textContent = gs.shkobbaCount[0] ? `+${gs.shkobbaCount[0]} ${t('chkobba')}` : '';
    $('hud-t2-shk').textContent = gs.shkobbaCount[1] ? `+${gs.shkobbaCount[1]} ${t('chkobba')}` : '';
    $('hud-t1-name').textContent = teamName(0);
    $('hud-t2-name').textContent = teamName(1);
    $('lbl-round').textContent = t('round'); $('lbl-deck').textContent = t('deck');
    this.renderTurnLabel(gs);
  },

  renderTurnLabel(gs) {
    const el = document.getElementById('turn-fill');
    el.classList.remove('chip', 'green', 'mult', 'text', 'urgent', 'rtl');
    el.classList.toggle('rtl', !!I18N.term('yourTurn').rtl);
    if (this.isHost && this._gameFrozen || gs.frozen) { el.textContent = I18N.text('paused'); el.classList.add('mult'); Juice.fill(el, 1); return; }
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
    const isBot = !!player.isBot || (this.isHost && this.isBotPlayer(player.id));
    const isControlled = this.isHost && this._controllingPlayerId === player.id;
    const el = document.createElement('div');
    el.className = `opp t${player.team + 1}${isTurn ? ' active-turn' : ''}${side ? ' side' : ''}${isControlled ? ' controlled' : ''}`;
    el.dataset.player = player.id;
    el.innerHTML = `<div class="av">${isBot ? 'BOT' : escapeHtml(player.name.charAt(0).toUpperCase())}</div>
      <div class="meta"><div class="name">${escapeHtml(player.name)}${isControlled ? ' <span class="ctrl">CTRL</span>' : ''}</div>
        <div class="backs" aria-label="${n} cards in hand"></div>
        <div class="cap">${I18N.text('karta')} <b>${cap}</b>${shk ? ` <span class="badge haya">+${shk}</span>` : ''}</div></div>`;
    const backs = el.querySelector('.backs');
    for (let i = 0; i < n; i++) backs.appendChild(Cards.back(true));
    // spy mode is a host-only debug tool; it reads the host's own authoritative state
    if (this._spyMode && this.isHost && gs.hands && gs.hands[player.id] && gs.hands[player.id].length) {
      const spy = document.createElement('div'); spy.className = 'spy';
      spy.innerHTML = gs.hands[player.id].map((c) => `<span>${c.display}${SUIT_SYMBOLS[c.suit] || ''}</span>`).join('');
      el.querySelector('.meta').appendChild(spy);
    }
    return el;
  },

  renderOpponents(gs) {
    const top = document.getElementById('opponents-top'), left = document.getElementById('opponent-left'), right = document.getElementById('opponent-right');
    top.innerHTML = ''; left.innerHTML = ''; right.innerHTML = '';
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
    const mine = gs.currentTurn === activeId && gs.phase === 'playing' && !(gs.frozen && !this.isHost);
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
      const can = assist && this.myHand[i] && findCaptureCombinations(gs.tableCards, this.myHand[i].value).length > 0;
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
    const busy = this.isSubmittingMove;
    cap.hidden = !has || (assist && this.availableCaptures.length === 0);
    place.hidden = !has || mustTake;
    cancel.hidden = !has;
    cap.disabled = !valid || busy;
    place.disabled = busy;
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
      msg.textContent = this.selectedCaptureIndices.length
        ? (valid ? `${sum} = ${card.value}` : `${sum} of ${card.value}`)
        : (mustTake ? 'a matching card is on the table' : '');
    }
  },

  renderBanners(gs) {
    let freezeBanner = document.getElementById('freeze-banner');
    if (!freezeBanner) {
      freezeBanner = document.createElement('div');
      freezeBanner.id = 'freeze-banner';
      freezeBanner.className = 'freeze-banner hidden';
      freezeBanner.innerHTML = '<span class="freeze-icon-inline">&#10074;&#10074;</span> Game paused by the host';
      document.getElementById('screen-game').prepend(freezeBanner);
    }
    freezeBanner.classList.toggle('hidden', !(gs.frozen && !this.isHost));

    let possessBanner = document.getElementById('possess-banner');
    if (!possessBanner) {
      possessBanner = document.createElement('div');
      possessBanner.id = 'possess-banner';
      possessBanner.className = 'hidden';
      document.getElementById('hand-area').prepend(possessBanner);
    }
    if (this.isHost && this._controllingPlayerId !== null && gs.players) {
      const cp = gs.players[this._controllingPlayerId];
      possessBanner.innerHTML = `<span class="possess-label">CONTROLLING: P${this._controllingPlayerId} ${escapeHtml(cp ? cp.name : '?')} (T${cp ? cp.team + 1 : '?'})</span><button class="btn-debug" onclick="app.debugReleasePossess()" style="padding:0.2rem 0.6rem;font-size:0.68rem;">Release</button>`;
      possessBanner.classList.remove('hidden');
    } else {
      possessBanner.classList.add('hidden');
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
    this._ceremonySkip = false; this._ceremonyContinue = null;
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
    const stillOpen = () => this._ceremonyKey && $('ov-ceremony').classList.contains('open') && this.gameState === gs;

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
    if (this.isHost) {
      $('cer-skip').textContent = 'tap to continue';
      this._ceremonyContinue = () => this.startNextRound();
    } else {
      $('cer-skip').textContent = 'waiting for the host'; $('cer-skip').classList.add('waiting');
    }
  },

  startNextRound() {
    if (!this.isHost) return;
    this._ceremonyContinue = null;
    this.closeOverlay('ov-ceremony');
    this.checkWinCondition();
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
    $('match-title').innerHTML = `${escapeHtml(name)} <span class="term"><b>${I18N.text('wins')}</b></span>`;
    const sub = $('match-sub');
    if (gs.endReason === 'diamonds') { sub.textContent = 'all ten diamonds in one deal'; sub.hidden = false; }
    else if (gs.endReason === 'surrender') { sub.textContent = 'the other side surrendered'; sub.hidden = false; }
    else sub.hidden = true;
    $('match-score').innerHTML = `<span style="color:var(--team1)">${gs.scores[0]}</span> <span style="color:var(--text-dim);font-size:.5em">x</span> <span style="color:var(--team2)">${gs.scores[1]}</span>`;
    $('match-again').hidden = !this.isHost;
    this.openOverlay('ov-match');
    Juice.chime();
    const c = $('confetti'); c.innerHTML = '';
    if (Juice.getJuice() > 0) for (let i = 0; i < 70; i++) { const d = document.createElement('i'); d.style.left = Math.random() * 100 + '%'; d.style.background = ['var(--gold)', 'var(--chip)', 'var(--mult)', 'var(--text)'][i % 4]; d.style.animationDelay = Math.random() * .8 + 's'; d.style.animationDuration = 2 + Math.random() * 1.5 + 's'; c.appendChild(d); }
  },

  // kept for the debug panel, which still calls it after forcing a winner
  showScoreboard() { this._ceremonyKey = ''; this._matchKey = ''; this._afterPaint(); },
  _closeEndOverlays() { this._ceremonyContinue = null; this.closeOverlay('ov-ceremony'); this.closeOverlay('ov-match'); },

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
      const cs = findCaptureCombinations(gs.tableCards, card.value);
      combos = cs.length
        ? `<p style="margin-top:12px"><b>Takes now:</b></p><ul class="info-list">${cs.map((c) => `<li><span class="combo">${c.map((i) => { const t = gs.tableCards[i]; return `<span class="mini-card${['hearts', 'diamonds'].includes(t.suit) ? ' red' : ''}">${t.display}</span>`; }).join('<span>+</span>')}</span>${c.length === gs.tableCards.length ? ` <span class="badge haya">${I18N.text('chkobba')}</span>` : ''}</li>`).join('')}</ul>`
        : `<p style="margin-top:12px;color:var(--text-dim)">Takes nothing on this table. Playing it places it.</p>`;
    }
    const court = card.name === 'king' ? ' (king)' : card.name === 'jack' ? ' (jack)' : card.name === 'queen' ? ' (queen)' : '';
    $('info-body').innerHTML = `<p>Value <b class="num">${card.value}</b>${court}. A take is any set of table cards adding up to it${card.value <= 7 ? '' : '; courts only take an equal court or a sum'}.</p><ul class="info-list">${counts.join('')}</ul>${combos}`;
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
  toast(message) {
    const el = document.getElementById('toast');
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
    const ownership = gs.diamondOwnership || (this.isHost ? this.getDiamondOwnership() : {});
    const names = ['ace', '2', '3', '4', '5', '6', '7', 'jack', 'queen', 'king'];
    const labels = ['A', '2', '3', '4', '5', '6', '7', 'J', 'Q', 'K'];
    const pip = Cards.getSuit() === 'coin' ? '●' : '♦';
    return `<div class="stat-grid">
      <div class="hud-box"><span class="lbl">${t('round')}</span><span class="val num">${gs.roundNum + 1}/${gs.totalRounds}</span></div>
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
      html += `<div class="entry"><span class="t">${escapeHtml(entry.time)}</span><span>${escapeHtml(entry.text)}</span></div>`;
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

  toggleForceCapture(checked) {
    if (!this.isHost || !this.gameState) { this.toast('Only the host can change the rules'); return; }
    this.gameState.forceCapture = checked;
    this.forceCapture = checked;
    this.toast('Force capture ' + (checked ? 'on' : 'off'));
    this.broadcastGameState();
  },

  toggleCaptureAssist(checked) {
    if (!this.isHost || !this.gameState) { this.toast('Only the host can change the rules'); return; }
    this.gameState.captureAssist = checked;
    this.captureAssist = checked;
    this.toast('Capture assist ' + (checked ? 'on' : 'off'));
    this.broadcastGameState();
  },

  changeTurnTimer(value) {
    if (!this.isHost || !this.gameState) { this.toast('Only the host can change the rules'); return; }
    this.gameState.turnTimerDuration = value;
    this.turnTimerDuration = value;
    this.toast('Turn timer ' + (value > 0 ? value + 's' : 'off'));
    this.broadcastGameState();
    if (this.gameState.phase === 'playing' && this.gameState.currentTurn >= 0) this.startTurnTimer();
  },

  // The host's look change is the room's look: it goes out with the state and also
  // becomes the host's default for the next room.
  changeLook(partial) {
    if (!this.isHost || !this.gameState) { this.toast('The host picks the look'); return; }
    const look = Look.setLook(partial, true);
    this.gameState.look = look;
    this.broadcastGameState();
  },

  surrenderGame() {
    if (!this.gameState || this.gameState.phase !== 'playing') { this.toast('No active game'); return; }
    const me = this.gameState.players.find(p => p.id === this.myPlayerId);
    if (!me) return;
    if (!confirm('Surrender this game?')) return;
    if (!this.isHost) { this.toast('Only the host can end the game'); return; }
    const gs = this.gameState;
    gs.phase = 'finished';
    gs.winner = me.team === 0 ? 1 : 0;
    gs.endReason = 'surrender';
    gs.currentTurn = -1;
    gs.lastScore = null;
    this.addLogEntry(`Team ${me.team + 1} surrendered`);
    this.toggleMenu();
    this.broadcastGameState();
    this.renderGame();
  },

  // ========== EMOTES ==========
  showEmote(name, text) {
    const el = document.getElementById('emote-display');
    if (!el) return;
    el.textContent = `${name}: ${text}`;
    el.hidden = false;
    if (this._emoteTimeout) clearTimeout(this._emoteTimeout);
    this._emoteTimeout = setTimeout(() => { el.hidden = true; this._emoteTimeout = null; }, 2000);
  },

  sendEmote(emote) {
    const emotes = { gg: 'GG! \u{1F44F}', nice: 'Nice! \u{1F525}', wow: 'Wow! \u{1F632}', oops: 'Oops! \u{1F605}', hurry: 'Hurry up! ⏰' };
    const text = emotes[emote] || emote;
    const myPlayer = this.gameState && this.gameState.players ? this.gameState.players.find(p => p.id === this.myPlayerId) : null;
    const name = myPlayer ? myPlayer.name : this.myName;
    this.showEmote(name, text);
    this.playSound('click');
    if (this._roomRef) this._roomRef.child('emote').set({ name, text, ts: Date.now() });
  },

  // ========== REMATCH ==========
  rematch() {
    if (!this.isHost) { this.toast('Only the host can start a rematch'); return; }
    this._closeEndOverlays();
    this.startGame();
    this.toast('Rematch');
  },

  // ========== DEBUG MODE ==========
  debugEnabled: false,
  _debugMinimized: false,

  toggleDebug() {
    if (!this.isHost) { this.toast('Debug is host-only'); return; }
    this.debugEnabled = !this.debugEnabled;
    this._debugMinimized = false;
    this.log('info', 'debug mode', this.debugEnabled ? 'ON (verbose logging enabled)' : 'OFF');
    const panel = document.getElementById('debug-panel');
    const checkbox = document.getElementById('debug-toggle');
    const pill = document.getElementById('debug-restore-pill');
    if (panel) { panel.classList.toggle('hidden', !this.debugEnabled); panel.classList.remove('minimized'); }
    if (checkbox) checkbox.checked = this.debugEnabled;
    if (pill) pill.classList.add('hidden');
    if (this.debugEnabled && panel) {
      this.updateDebugPanel();
      this.makeDebugDraggable(panel);
    }
  },

  minimizeDebug() {
    this._debugMinimized = true;
    const panel = document.getElementById('debug-panel');
    if (panel) panel.classList.add('hidden');
    let pill = document.getElementById('debug-restore-pill');
    if (!pill) {
      pill = document.createElement('button');
      pill.id = 'debug-restore-pill';
      pill.className = 'debug-restore-pill';
      pill.textContent = '🔧 Debug';
      pill.onclick = () => this.restoreDebug();
      document.body.appendChild(pill);
    }
    pill.classList.remove('hidden');
  },

  restoreDebug() {
    this._debugMinimized = false;
    const panel = document.getElementById('debug-panel');
    const pill = document.getElementById('debug-restore-pill');
    if (panel) { panel.classList.remove('hidden'); this.updateDebugPanel(); }
    if (pill) pill.classList.add('hidden');
  },

  makeDebugDraggable(panel) {
    const header = panel.querySelector('.debug-header');
    if (header._dragInit) return;
    header._dragInit = true;
    let isDragging = false, startX, startY, origLeft, origTop;

    const onMouseDown = (e) => {
      if (e.target.tagName === 'BUTTON') return;
      isDragging = true;
      const rect = panel.getBoundingClientRect();
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';
      panel.style.transform = 'none';
      startX = e.clientX;
      startY = e.clientY;
      origLeft = rect.left;
      origTop = rect.top;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    };

    const onMouseMove = (e) => {
      if (!isDragging) return;
      panel.style.left = (origLeft + e.clientX - startX) + 'px';
      panel.style.top = (origTop + e.clientY - startY) + 'px';
    };

    const onMouseUp = () => {
      isDragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    header.addEventListener('mousedown', onMouseDown);
  },

  switchDebugTab(tab) {
    this.debugTab = tab;
    document.querySelectorAll('.debug-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    this.updateDebugPanel();
  },

  updateDebugPanel() {
    if (!this.debugEnabled) return;
    const gs = this.gameState;
    const body = document.getElementById('debug-body');
    if (!body) return;

    if (!gs) {
      body.innerHTML = '<div style="color:var(--text-dim);padding:1rem;">No game in progress</div>';
      return;
    }

    switch (this.debugTab) {
      case 'hands': body.innerHTML = this.renderDebugHands(); break;
      case 'table': body.innerHTML = this.renderDebugTable(); break;
      case 'deck': body.innerHTML = this.renderDebugDeck(); break;
      case 'controls': body.innerHTML = this.renderDebugControls(); break;
    }
  },

  renderDebugHands() {
    const gs = this.gameState;
    if (!gs || !gs.players) return '<div style="color:var(--text-dim);">No game data</div>';

    let html = '';
    for (let i = 0; i < gs.players.length; i++) {
      const p = gs.players[i];
      const hand = gs.hands ? gs.hands[i] : [];
      const turnMark = gs.currentTurn === i ? '<span class="debug-turn-indicator"> ▶</span>' : '';
      const isMe = i === this.myPlayerId;

      html += `<div class="debug-player-hand">
        <div class="debug-player-label">
          <span style="color:${isMe ? 'var(--gold)' : 'var(--text-secondary)'}">P${i} ${escapeHtml(p.name)}${turnMark}</span>
        </div>
        <div>`;

      if (hand && hand.length > 0) {
        hand.forEach((c, ci) => {
          const sym = SUIT_SYMBOLS[c.suit] || '';
          html += `<span class="debug-card removable" onclick="app.debugRemoveCardFromPlayer(${i}, ${ci})" title="Click to remove">${c.display}${sym}</span>`;
        });
      } else {
        html += '<span style="color:var(--text-dim);font-size:0.72rem;">empty</span>';
      }

      html += `</div>
        <div class="debug-controls-row" style="margin-top:0.35rem; display:flex; gap:0.3rem;">
          <select id="debug-card-select-${i}" class="debug-select" style="font-size:0.68rem;padding:0.2rem;max-width:130px;">
            ${this.getCardOptionsHtml()}
          </select>
          <button class="btn-debug" onclick="app.debugAddCardToPlayer(${i})" style="font-size:0.68rem;padding:0.2rem 0.4rem;">+ Add</button>
        </div>
      </div>`;
    }

    return `<div class="debug-section">${html}</div>`;
  },

  renderDebugTable() {
    const gs = this.gameState;
    if (!gs) return '<div style="color:var(--text-dim);">No game data</div>';

    let tableHtml = '';
    if (gs.tableCards && gs.tableCards.length > 0) {
      gs.tableCards.forEach((c, i) => {
        const sym = SUIT_SYMBOLS[c.suit] || '';
        tableHtml += `<span class="debug-card removable" onclick="app.debugRemoveTableCard(${i})" title="Click to remove">${c.display}${sym}</span>`;
      });
    } else {
      tableHtml = '<span style="color:var(--text-dim);font-size:0.72rem;">Table is empty</span>';
    }

    return `
      <div class="debug-section">
        <div class="debug-section-title">Table Cards (click to remove)</div>
        <div>${tableHtml}</div>
        <div style="margin-top:0.5rem;">
          <div class="debug-controls-row">
            <select id="debug-table-card-select" class="debug-select">
              ${this.getCardOptionsHtml()}
            </select>
            <button class="btn-debug" onclick="app.debugAddTableCard()">Add to Table</button>
          </div>
        </div>
      </div>
    `;
  },

  renderDebugDeck() {
    const gs = this.gameState;
    if (!gs) return '<div style="color:var(--text-dim);">No game data</div>';

    const deck = gs.deck || [];
    const top20 = deck.slice(-20).reverse();

    let deckHtml = '';
    if (top20.length > 0) {
      top20.forEach(c => {
        const sym = SUIT_SYMBOLS[c.suit] || '';
        deckHtml += `<span class="debug-card">${c.display}${sym}</span>`;
      });
    } else {
      deckHtml = '<span style="color:var(--text-dim);font-size:0.72rem;">Deck is empty</span>';
    }

    return `
      <div class="debug-section">
        <div class="debug-section-title">Deck (top ${Math.min(20, deck.length)} of ${deck.length})</div>
        <div>${deckHtml}</div>
        <div style="margin-top:0.5rem;display:flex;gap:0.3rem;">
          <button class="btn-debug" onclick="app.debugShuffleDeck()">🔀 Shuffle</button>
          <button class="btn-debug" onclick="app.debugRefillDeck()">♻ Refill Deck</button>
        </div>
      </div>
    `;
  },

  renderDebugControls() {
    const gs = this.gameState;
    if (!gs) return '<div style="color:var(--text-dim);">No game data</div>';

    let playerOpts = '';
    gs.players.forEach(p => {
      playerOpts += `<option value="${p.id}">P${p.id} ${escapeHtml(p.name)}</option>`;
    });

    const capT1 = gs.capturedTeams[0] ? gs.capturedTeams[0].length : 0;
    const capT2 = gs.capturedTeams[1] ? gs.capturedTeams[1].length : 0;

    return `
      <div class="debug-section">
        <div class="debug-section-title">Undo / History</div>
        <div class="debug-controls">
          <button class="btn-debug" onclick="app.debugUndo()">↩ Undo Last Move</button>
          <button class="btn-debug" onclick="app.debugRerunRound()">🔄 Rerun This Round</button>
          <button class="btn-debug" onclick="app.debugSaveState()">💾 Save Snapshot</button>
          <button class="btn-debug" onclick="app.debugLoadState()">📂 Load Snapshot</button>
        </div>
      </div>

      <div class="debug-section">
        <div class="debug-section-title">Turn Control</div>
        <div class="debug-controls">
          <div class="debug-controls-row">
            <select id="debug-set-turn" class="debug-select">${playerOpts}</select>
            <button class="btn-debug" onclick="app.debugSetTurn()">Set Turn</button>
          </div>
          <button class="btn-debug" onclick="app.debugSkipTurn()">⏭ Skip Turn</button>
          <button class="btn-debug" onclick="app.debugPauseTurn()">⏸ Pause Timer</button>
        </div>
      </div>

      <div class="debug-section">
        <div class="debug-section-title">Score & Chkobba</div>
        <div class="debug-controls">
          <div class="debug-controls-row">
            <label style="font-size:0.72rem;color:var(--team1);min-width:30px;">T1:</label>
            <input type="number" id="debug-score-t1" class="debug-select" value="${gs.scores[0]}" min="0" style="width:50px;">
            <label style="font-size:0.72rem;color:var(--team2);min-width:30px;">T2:</label>
            <input type="number" id="debug-score-t2" class="debug-select" value="${gs.scores[1]}" min="0" style="width:50px;">
            <button class="btn-debug" onclick="app.debugSetScores()">Set</button>
          </div>
          <div class="debug-controls-row">
            <label style="font-size:0.72rem;color:var(--text-secondary);min-width:65px;">Chkobba T1:</label>
            <input type="number" id="debug-shk-t1" class="debug-select" value="${gs.shkobbaCount[0]}" min="0" style="width:50px;">
            <label style="font-size:0.72rem;color:var(--text-secondary);min-width:65px;">Chkobba T2:</label>
            <input type="number" id="debug-shk-t2" class="debug-select" value="${gs.shkobbaCount[1]}" min="0" style="width:50px;">
            <button class="btn-debug" onclick="app.debugSetShkobba()">Set</button>
          </div>
        </div>
      </div>

      <div class="debug-section">
        <div class="debug-section-title">Move Cards Between Zones</div>
        <div class="debug-controls">
          <div class="debug-controls-row">
            <button class="btn-debug" onclick="app.debugTableToHand()">Table → Hand</button>
            <button class="btn-debug" onclick="app.debugHandToTable()">Hand → Table</button>
          </div>
          <div class="debug-controls-row">
            <button class="btn-debug" onclick="app.debugSwapHands()">🔄 Swap Hands</button>
            <button class="btn-debug" onclick="app.debugClearTable()">🗑 Clear Table</button>
          </div>
          <div class="debug-controls-row">
            <button class="btn-debug" onclick="app.debugReturnCaptures(0)">Return T1 Captures</button>
            <button class="btn-debug" onclick="app.debugReturnCaptures(1)">Return T2 Captures</button>
          </div>
        </div>
      </div>

      <div class="debug-section">
        <div class="debug-section-title">Game Actions</div>
        <div class="debug-controls">
          <button class="btn-debug" onclick="app.debugDealRound()">📤 Force Deal Round</button>
          <button class="btn-debug" onclick="app.debugForceScoring()">📊 Force Score Now</button>
          <div class="debug-controls-row" style="margin-top:0.3rem;">
            <button class="btn-debug" onclick="app.debugShowWinner()">🏆 Win T1</button>
            <button class="btn-debug danger" onclick="app.debugShowWinner(1)">🏆 Win T2</button>
          </div>
          <div class="debug-controls-row" style="margin-top:0.3rem;">
            <button class="btn-debug" onclick="app.debugToggleForceCapture()">⚡ Toggle Force Capture (${gs.forceCapture ? 'ON' : 'OFF'})</button>
          </div>
          <div class="debug-controls-row" style="margin-top:0.3rem;">
            <button class="btn-debug" onclick="app.debugResetGame()">🔥 Full Reset (Keep Players)</button>
          </div>
        </div>
      </div>

      <div class="debug-section">
        <div class="debug-section-title">Bot Management</div>
        <div class="debug-controls">
          ${gs.players.map(p => {
            if (p.id === 0) return '';
            const isBot = this.isBotPlayer(p.id);
            if (isBot) {
              return `<div class="debug-controls-row" style="align-items:center;">
                <span style="font-size:0.72rem;color:var(--text-secondary);">P${p.id} ${escapeHtml(p.name)}</span>
                <span class="bot-badge" style="margin-left:0.3rem;">BOT</span>
                <button class="btn-debug danger" onclick="app.debugRemoveBot(${p.id})" style="margin-left:auto;">Remove Bot</button>
              </div>`;
            }
            return `<div class="debug-controls-row" style="align-items:center;">
              <span style="font-size:0.72rem;color:var(--text-secondary);">P${p.id} ${escapeHtml(p.name)}</span>
              <select id="debug-bot-diff-${p.id}" class="debug-select" style="font-size:0.68rem;padding:0.2rem;width:70px;margin-left:auto;">
                <option value="easy">Easy</option>
                <option value="medium" selected>Medium</option>
                <option value="hard">Hard</option>
              </select>
              <button class="btn-debug" onclick="app.debugAddBot(${p.id})">+ Bot</button>
            </div>`;
          }).join('')}
        </div>
      </div>

      <div class="debug-section">
        <div class="debug-section-title">Team Control</div>
        <div class="debug-controls">
          ${gs.players.map(p => {
            const otherTeam = p.team === 0 ? 1 : 0;
            return `<div class="debug-controls-row" style="align-items:center;">
              <span style="font-size:0.72rem;color:var(--team${p.team + 1});">P${p.id} ${escapeHtml(p.name)} — T${p.team + 1}</span>
              <button class="btn-debug" onclick="app.debugSwapTeam(${p.id})" style="margin-left:auto;font-size:0.68rem;">Move to T${otherTeam + 1}</button>
            </div>`;
          }).join('')}
        </div>
      </div>

      <div class="debug-section">
        <div class="debug-section-title">Player Control</div>
        <div class="debug-controls">
          ${this._controllingPlayerId !== null
            ? `<div class="debug-controls-row" style="align-items:center;">
                <span style="font-size:0.72rem;color:var(--gold);">Controlling P${this._controllingPlayerId} ${escapeHtml(gs.players[this._controllingPlayerId]?.name || '?')}</span>
                <button class="btn-debug danger" onclick="app.debugReleasePossess()" style="margin-left:auto;">Release</button>
              </div>`
            : gs.players.filter(p => p.id !== this.myPlayerId).map(p => {
                return `<div class="debug-controls-row" style="align-items:center;">
                  <span style="font-size:0.72rem;color:var(--text-secondary);">P${p.id} ${escapeHtml(p.name)}</span>
                  <button class="btn-debug" onclick="app.debugPossessPlayer(${p.id})" style="margin-left:auto;font-size:0.68rem;">Play As</button>
                </div>`;
              }).join('')
          }
        </div>
      </div>

      <div class="debug-section">
        <div class="debug-section-title">Host Powers</div>
        <div class="debug-controls">
          <button class="btn-debug ${this._gameFrozen ? 'danger' : ''}" onclick="app.debugToggleFreeze()">
            ${this._gameFrozen ? '▶ Unfreeze Game' : '❄ Freeze Game'}
          </button>
          <button class="btn-debug ${this._spyMode ? 'danger' : ''}" onclick="app.debugToggleSpy()">
            ${this._spyMode ? '🔒 Hide Hands' : '👁 Spy Mode (See All Hands)'}
          </button>
          <div class="debug-controls-row">
            <label style="font-size:0.72rem;color:var(--text-secondary);min-width:70px;">Win Score:</label>
            <input type="number" id="debug-win-score" class="debug-select" value="${gs.winScore}" min="1" style="width:60px;">
            <button class="btn-debug" onclick="app.debugSetWinScore()">Set</button>
          </div>
        </div>
      </div>

      <div class="debug-section">
        <div class="debug-section-title">State Info</div>
        <div style="font-size:0.7rem;color:var(--text-secondary);line-height:1.6;font-family:monospace;">
          <div>Phase: ${gs.phase} | Turn: P${gs.currentTurn} | Dealer: P${gs.dealerIndex}</div>
          <div>Deck: ${(gs.deck || []).length} | Table: ${(gs.tableCards || []).length} | Round: ${gs.roundNum + 1}/${gs.totalRounds}</div>
          <div>Captured: T1=${capT1} T2=${capT2} | Last Cap: T${gs.lastCaptureTeam + 1}</div>
          <div>Shkobba: T1=${gs.shkobbaCount[0]} T2=${gs.shkobbaCount[1]} | Scores: ${gs.scores[0]}-${gs.scores[1]}</div>
          <div>Force: ${gs.forceCapture ? 'ON' : 'OFF'} | Timer: ${gs.turnTimerDuration || 'Off'}s | Win: ${gs.winScore}</div>
          <div>Frozen: ${this._gameFrozen ? 'YES' : 'no'} | Ctrl: ${this._controllingPlayerId !== null ? 'P' + this._controllingPlayerId : 'none'} | Spy: ${this._spyMode ? 'ON' : 'off'}</div>
        </div>
      </div>
    `;
  },

  getCardOptionsHtml() {
    const allCards = createDeck();
    return allCards.map((c, i) => {
      const sym = SUIT_SYMBOLS[c.suit] || '';
      return `<option value="${i}">${c.display}${sym} of ${c.suit}</option>`;
    }).join('');
  },

  // ========== DEBUG ACTIONS ==========
  _makeDebugCard(deckIndex) {
    const card = createDeck()[deckIndex];
    card.id = 1000 + Date.now() % 10000 + Math.floor(Math.random() * 1000);
    return card;
  },

  debugAddCardToPlayer(playerIndex) {
    const gs = this.gameState;
    if (!gs || !this.isHost) { this.toast('Debug: Host only'); return; }

    const sel = document.getElementById(`debug-card-select-${playerIndex}`);
    if (!sel) return;
    const idx = parseInt(sel.value);
    if (isNaN(idx) || idx < 0 || idx >= 40) { this.toast('Invalid card index'); return; }

    const card = this._makeDebugCard(idx);
    if (!gs.hands[playerIndex]) gs.hands[playerIndex] = [];
    gs.hands[playerIndex].push(card);
    this.toast(`Added ${card.display} of ${card.suit} to P${playerIndex}`);
    this.broadcastGameState();
    this.updateDebugPanel();
  },

  debugRemoveCardFromPlayer(playerIndex, cardIndex) {
    const gs = this.gameState;
    if (!gs || !this.isHost) { this.toast('Debug: Host only'); return; }
    const hand = gs.hands[playerIndex];
    if (!hand || cardIndex >= hand.length) return;
    const removed = hand.splice(cardIndex, 1)[0];
    this.toast(`Removed ${removed.display} of ${removed.suit} from P${playerIndex}`);
    this.broadcastGameState();
    this.updateDebugPanel();
  },

  debugAddTableCard() {
    const gs = this.gameState;
    if (!gs || !this.isHost) { this.toast('Debug: Host only'); return; }
    const sel = document.getElementById('debug-table-card-select');
    if (!sel) return;
    const idx = parseInt(sel.value);
    const card = this._makeDebugCard(idx);
    gs.tableCards.push(card);
    this.toast(`Added ${card.display} of ${card.suit} to table`);
    this.broadcastGameState();
    this.updateDebugPanel();
  },

  debugRemoveTableCard(index) {
    const gs = this.gameState;
    if (!gs || !this.isHost) { this.toast('Debug: Host only'); return; }
    if (index >= gs.tableCards.length) return;
    const removed = gs.tableCards.splice(index, 1)[0];
    this.toast(`Removed ${removed.display} of ${removed.suit} from table`);
    this.broadcastGameState();
    this.updateDebugPanel();
  },

  debugShuffleDeck() {
    const gs = this.gameState;
    if (!gs || !this.isHost) { this.toast('Debug: Host only'); return; }
    shuffle(gs.deck);
    this.toast('Deck shuffled!');
    this.broadcastGameState();
    this.updateDebugPanel();
  },

  debugRefillDeck() {
    const gs = this.gameState;
    if (!gs || !this.isHost) { this.toast('Debug: Host only'); return; }
    gs.deck = shuffle(createDeck());
    this.toast('Deck refilled with 40 cards!');
    this.broadcastGameState();
    this.updateDebugPanel();
  },

  debugSetTurn() {
    const gs = this.gameState;
    if (!gs || !this.isHost) { this.toast('Debug: Host only'); return; }
    const sel = document.getElementById('debug-set-turn');
    if (!sel) return;
    gs.currentTurn = parseInt(sel.value);
    gs.shkobbaThisTurn = false;
    this.toast('Turn set to P' + gs.currentTurn);
    this.broadcastGameState();
    this.renderGame();
    this.startTurnTimer();
    this.triggerBotPlay();
  },

  debugSetScores() {
    const gs = this.gameState;
    if (!gs || !this.isHost) { this.toast('Debug: Host only'); return; }
    const s1 = parseInt(document.getElementById('debug-score-t1')?.value || 0);
    const s2 = parseInt(document.getElementById('debug-score-t2')?.value || 0);
    gs.scores[0] = isNaN(s1) ? 0 : s1;
    gs.scores[1] = isNaN(s2) ? 0 : s2;
    this.toast(`Scores set: Team 1 = ${gs.scores[0]}, Team 2 = ${gs.scores[1]}`);
    this.broadcastGameState();
    this.renderGame();
  },

  debugSkipTurn() {
    const gs = this.gameState;
    if (!gs || gs.phase !== 'playing') { this.toast('No active game'); return; }
    this.nextTurn();
    this.updateDebugPanel();
  },

  debugDealRound() {
    const gs = this.gameState;
    if (!gs) { this.toast('No active game'); return; }
    gs.deck = shuffle(createDeck());
    gs.tableCards = [];
    gs.roundNum = 0;
    this.dealRound();
    this.updateDebugPanel();
  },

  debugShowWinner(team = 0) {
    const gs = this.gameState;
    if (!gs) { this.toast('No active game'); return; }
    gs.scores[team] = gs.winScore;
    gs.winner = team;
    gs.phase = 'finished';
    gs.currentTurn = -1;
    gs.lastScore = null;
    this.broadcastGameState();
    this.renderGame();
    this.showScoreboard();
    this.updateDebugPanel();
  },

  _stateHistory: [],
  _savedSnapshot: null,

  _pushHistory() {
    const gs = this.gameState;
    if (!gs) return;
    const snap = JSON.stringify({
      hands: gs.hands, tableCards: gs.tableCards, deck: gs.deck,
      capturedTeams: gs.capturedTeams, currentTurn: gs.currentTurn,
      dealerIndex: gs.dealerIndex, roundNum: gs.roundNum,
      shkobbaCount: gs.shkobbaCount, scores: gs.scores,
      lastCaptureTeam: gs.lastCaptureTeam, phase: gs.phase,
      cardsPlayedThisRound: gs.cardsPlayedThisRound,
      shkobbaThisTurn: gs.shkobbaThisTurn, lastMove: gs.lastMove,
      forceCapture: gs.forceCapture,
    });
    this._stateHistory.push(snap);
    if (this._stateHistory.length > 50) this._stateHistory.shift();
  },

  debugUndo() {
    if (!this.isHost || !this.gameState) { this.toast('No game'); return; }
    if (this._stateHistory.length === 0) { this.toast('Nothing to undo'); return; }
    const snap = JSON.parse(this._stateHistory.pop());
    Object.assign(this.gameState, snap);
    this.toast('Undid last move');
    this.broadcastGameState();
    this.renderGame();
    this.updateDebugPanel();
    this.startTurnTimer();
    this.triggerBotPlay();
  },

  debugRerunRound() {
    if (!this.isHost || !this.gameState) { this.toast('No game'); return; }
    const gs = this.gameState;
    gs.capturedTeams = [[], []];
    gs.shkobbaCount = [0, 0];
    gs.lastCaptureTeam = -1;
    gs.lastMove = null;
    gs.tableCards = [];
    gs.roundNum = 0;
    gs.deck = shuffle(createDeck());
    gs.phase = 'playing';
    this._closeEndOverlays();
    this.dealRound();
    this.toast('Round restarted!');
    this.updateDebugPanel();
  },

  debugSaveState() {
    if (!this.isHost || !this.gameState) { this.toast('No game'); return; }
    this._savedSnapshot = JSON.stringify(this.gameState);
    this.toast('Snapshot saved!');
  },

  debugLoadState() {
    if (!this.isHost) { this.toast('Host only'); return; }
    if (!this._savedSnapshot) { this.toast('No snapshot saved'); return; }
    const snap = JSON.parse(this._savedSnapshot);
    this.gameState = snap;
    this._closeEndOverlays();
    this.broadcastGameState();
    this.renderGame();
    this.startTurnTimer();
    this.toast('Snapshot loaded!');
    this.updateDebugPanel();
    this.triggerBotPlay();
  },

  debugPauseTurn() {
    this.stopTurnTimer();
    this.toast('Timer paused');
  },

  debugSetShkobba() {
    const gs = this.gameState;
    if (!gs || !this.isHost) { this.toast('Host only'); return; }
    const s1 = parseInt(document.getElementById('debug-shk-t1')?.value || 0);
    const s2 = parseInt(document.getElementById('debug-shk-t2')?.value || 0);
    gs.shkobbaCount[0] = isNaN(s1) ? 0 : s1;
    gs.shkobbaCount[1] = isNaN(s2) ? 0 : s2;
    this.toast(`Shkobba set: T1=${gs.shkobbaCount[0]}, T2=${gs.shkobbaCount[1]}`);
    this.broadcastGameState();
    this.renderGame();
    this.updateDebugPanel();
  },

  debugTableToHand() {
    const gs = this.gameState;
    if (!gs || !this.isHost) { this.toast('Host only'); return; }
    if (gs.tableCards.length === 0) { this.toast('Table is empty'); return; }
    const card = gs.tableCards.pop();
    const pid = gs.currentTurn >= 0 ? gs.currentTurn : 0;
    gs.hands[pid].push(card);
    this.toast(`Moved ${card.display} from table to P${pid}'s hand`);
    this.broadcastGameState();
    this.renderGame();
    this.updateDebugPanel();
  },

  debugHandToTable() {
    const gs = this.gameState;
    if (!gs || !this.isHost) { this.toast('Host only'); return; }
    const pid = gs.currentTurn >= 0 ? gs.currentTurn : 0;
    const hand = gs.hands[pid];
    if (!hand || hand.length === 0) { this.toast('Hand is empty'); return; }
    const card = hand.pop();
    gs.tableCards.push(card);
    this.toast(`Moved ${card.display} from P${pid}'s hand to table`);
    this.broadcastGameState();
    this.renderGame();
    this.updateDebugPanel();
  },

  debugSwapHands() {
    const gs = this.gameState;
    if (!gs || !this.isHost || gs.numPlayers < 2) return;
    [gs.hands[0], gs.hands[1]] = [gs.hands[1], gs.hands[0]];
    this.toast('Hands swapped between P0 and P1');
    this.broadcastGameState();
    this.renderGame();
    this.updateDebugPanel();
  },

  debugClearTable() {
    const gs = this.gameState;
    if (!gs || !this.isHost) return;
    const count = gs.tableCards.length;
    gs.tableCards = [];
    this.toast(`Cleared ${count} cards from table`);
    this.broadcastGameState();
    this.renderGame();
    this.updateDebugPanel();
  },

  debugReturnCaptures(teamIndex) {
    const gs = this.gameState;
    if (!gs || !this.isHost) return;
    const cards = gs.capturedTeams[teamIndex];
    if (!cards || cards.length === 0) { this.toast('No captures to return'); return; }
    gs.deck.push(...cards);
    shuffle(gs.deck);
    const count = cards.length;
    gs.capturedTeams[teamIndex] = [];
    this.toast(`Returned ${count} cards from T${teamIndex + 1} captures to deck`);
    this.broadcastGameState();
    this.renderGame();
    this.updateDebugPanel();
  },

  debugForceScoring() {
    const gs = this.gameState;
    if (!gs || !this.isHost) return;
    if (gs.tableCards.length > 0 && gs.lastCaptureTeam >= 0) {
      gs.capturedTeams[gs.lastCaptureTeam].push(...gs.tableCards);
      gs.tableCards = [];
    }
    this.calculateScores();
    this.toast('Forced scoring!');
    this.updateDebugPanel();
  },

  debugToggleForceCapture() {
    const gs = this.gameState;
    if (!gs || !this.isHost) return;
    gs.forceCapture = !gs.forceCapture;
    this.forceCapture = gs.forceCapture;
    this.toast('Force capture ' + (gs.forceCapture ? 'ON' : 'OFF'));
    this.broadcastGameState();
    this.renderGame();
    this.updateDebugPanel();
  },

  debugAddBot(playerId) {
    const gs = this.gameState;
    if (!gs || !this.isHost) { this.toast('Host only'); return; }
    if (playerId === 0) { this.toast("Can't replace the host"); return; }
    if (this.isBotPlayer(playerId)) { this.toast('Already a bot'); return; }

    const sel = document.getElementById('debug-bot-diff-' + playerId);
    const diff = sel ? sel.value : 'medium';
    this._botPlayers[playerId] = diff;

    const botNames = { easy: 'Bot (Easy)', medium: 'Bot', hard: 'Bot (Hard)' };
    gs.players[playerId].name = botNames[diff] || 'Bot';

    if (this._roomRef) {
      this._roomRef.child('players/' + playerId).set(gs.players[playerId].name);
    }

    this.toast('P' + playerId + ' replaced with bot');
    this.broadcastGameState();
    this.renderGame();
    if (gs.currentTurn === playerId) this.triggerBotPlay();
  },

  debugRemoveBot(playerId) {
    const gs = this.gameState;
    if (!gs || !this.isHost) { this.toast('Host only'); return; }
    if (!this._botPlayers[playerId]) { this.toast('Not a bot'); return; }

    delete this._botPlayers[playerId];
    this.toast('P' + playerId + ' is no longer a bot (timer will auto-play)');
    this.updateDebugPanel();
  },

  debugResetGame() {
    if (!this.isHost) return;
    this._closeEndOverlays();
    this._stateHistory = [];
    this._controllingPlayerId = null;
    this._gameFrozen = false;
    this._spyMode = false;
    this.startGame();
    this.toast('Game fully reset!');
    this.updateDebugPanel();
  },

  debugSwapTeam(playerId) {
    const gs = this.gameState;
    if (!gs || !this.isHost) { this.toast('Host only'); return; }
    const p = gs.players[playerId];
    if (!p) return;
    const oldTeam = p.team;
    p.team = oldTeam === 0 ? 1 : 0;
    this.toast(`${p.name} moved from T${oldTeam + 1} to T${p.team + 1}`);
    this.broadcastGameState();
    this.renderGame();
    this.updateDebugPanel();
  },

  debugPossessPlayer(playerId) {
    const gs = this.gameState;
    if (!gs || !this.isHost) { this.toast('Host only'); return; }
    if (playerId === this.myPlayerId) { this.toast('Already your hand'); return; }
    this._controllingPlayerId = playerId;
    this.myHand = gs.hands[playerId] || [];
    this.cancelSelection();
    this.toast(`Now controlling P${playerId} ${gs.players[playerId]?.name || ''}`);
    this.renderGame();
    this.updateDebugPanel();
  },

  debugReleasePossess() {
    if (!this.isHost) return;
    const wasControlling = this._controllingPlayerId;
    this._controllingPlayerId = null;
    const gs = this.gameState;
    if (gs && gs.hands) this.myHand = gs.hands[this.myPlayerId] || [];
    this.cancelSelection();
    this.toast('Released control');
    this.renderGame();
    this.updateDebugPanel();
    if (wasControlling !== null && gs && this.isBotPlayer(gs.currentTurn)) {
      this.triggerBotPlay();
    }
  },

  debugToggleFreeze() {
    if (!this.isHost) { this.toast('Host only'); return; }
    this._gameFrozen = !this._gameFrozen;
    if (this._gameFrozen) {
      this.stopTurnTimer();
    } else {
      this.startTurnTimer();
    }
    this.toast(this._gameFrozen ? 'Game FROZEN — all players paused' : 'Game UNFROZEN — resuming');
    this.broadcastGameState();
    this.renderGame();
    this.updateDebugPanel();
  },

  debugToggleSpy() {
    if (!this.isHost) { this.toast('Host only'); return; }
    this._spyMode = !this._spyMode;
    this.toast(this._spyMode ? 'Spy Mode ON — seeing all hands' : 'Spy Mode OFF');
    this.renderGame();
    this.updateDebugPanel();
  },

  debugSetWinScore() {
    const gs = this.gameState;
    if (!gs || !this.isHost) { this.toast('Host only'); return; }
    const val = parseInt(document.getElementById('debug-win-score')?.value || 21);
    if (isNaN(val) || val < 1) { this.toast('Invalid score'); return; }
    gs.winScore = val;
    this.winScore = val;
    this.toast(`Win score set to ${val}`);
    this.broadcastGameState();
    this.renderGame();
    this.updateDebugPanel();
  },
};

document.addEventListener('DOMContentLoaded', () => app.init());
