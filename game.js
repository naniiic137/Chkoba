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
  const results = [];
  const n = tableCards.length;
  for (let mask = 1; mask < (1 << n); mask++) {
    let sum = 0, over = false, indices = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) { sum += tableCards[i].value; if (sum > targetValue) { over = true; break; } indices.push(i); }
    }
    if (!over && sum === targetValue) results.push(indices);
  }
  return results;
}

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ===================== APP =====================
const app = {
  isHost: false,
  myPlayerId: -1,
  roomCode: '',
  roomLink: '',
  playerCount: 4,
  forceCapture: true,
  winScore: 21,
  turnTimerDuration: 30,
  myName: '',
  peer: null,
  connsToMe: [],
  playerList: [],
  myConn: null,
  gameState: null,
  myHand: [],
  selectedCardIndex: -1,
  selectedCaptureIndices: [],
  availableCaptures: [],
  _toastTimer: null,
  _turnTimer: null,
  _turnTimerStart: 0,
  _turnTimerRemaining: 0,
  _timerRAF: null,
  moveLog: [],
  controlsOpen: false,
  controlsTab: 'stats',
  debugTab: 'hands',
  soundsEnabled: true,
  animationsEnabled: true,
  isSubmittingMove: false,
  animateDeal: false,
  _lastCardClickIndex: -1,
  _lastCardClickTime: 0,
  _lastTimerSec: 0,

  // ========== ROOM MANAGEMENT ==========
  init() {
    this.soundsEnabled = localStorage.getItem('chkoba_sounds') !== 'false';
    this.animationsEnabled = localStorage.getItem('chkoba_animations') !== 'false';

    const params = new URLSearchParams(window.location.search);
    const code = params.get('room');
    if (code) {
      this.showJoinView(code.toUpperCase());
    } else {
      this.showLobby();
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === '`' || e.key === '~') {
        e.preventDefault();
        this.toggleDebug();
      }
      if (e.key === 'Escape') {
        if (this.controlsOpen) this.toggleControls();
      }
    });
  },

  showJoinView(roomCode) {
    this.roomCode = roomCode;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('join-view').classList.add('active');
    document.getElementById('join-room-code').textContent = roomCode;
  },

  showLobby() {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('lobby-view').classList.add('active');
  },

  createGame() {
    const name = document.getElementById('player-name').value.trim();
    if (!name) { this.toast('Please enter your name'); return; }
    this.myName = name;
    this.isHost = true;
    this.playerCount = parseInt(document.getElementById('player-count').value);
    this.forceCapture = document.getElementById('force-capture').checked;
    this.winScore = parseInt(document.getElementById('win-score').value);
    this.turnTimerDuration = parseInt(document.getElementById('turn-timer').value);

    // Generate code and show waiting room IMMEDIATELY
    this.roomCode = genRoomCode();
    this.roomLink = window.location.href.split('?')[0] + '?room=' + this.roomCode;
    this.myPlayerId = 0;
    this.playerList = [this.myName];
    this.connsToMe = [];
    this.moveLog = [];
    this.showWaiting();

    // Then connect PeerJS in background
    try {
      this.peer = new Peer(this.roomCode, { debug: 0 });
      this.peer.on('open', () => {
        this.toast('Room ready!');
      });
      this.peer.on('connection', (conn) => this.handleConnection(conn));
      this.peer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
          this.roomCode = genRoomCode();
          this.roomLink = window.location.href.split('?')[0] + '?room=' + this.roomCode;
          document.getElementById('room-link-display').textContent = this.roomLink;
          if (this.peer) { try { this.peer.destroy(); } catch(e) {} }
          this.peer = new Peer(this.roomCode, { debug: 0 });
          this.peer.on('open', () => this.toast('Room ready!'));
          this.peer.on('connection', (conn) => this.handleConnection(conn));
          this.peer.on('error', (e) => this.toast('Peer error: ' + e.message));
        } else if (err.type === 'disconnected') {
          this.toast('Reconnecting...');
          this.peer.reconnect();
        } else {
          this.toast('PeerJS: ' + (err.message || err.type));
        }
      });
    } catch (e) {
      this.toast('Could not connect to signaling server. Share code: ' + this.roomCode);
    }
  },

  joinGame() {
    const name = document.getElementById('join-name').value.trim();
    if (!name) { this.toast('Please enter your name'); return; }
    this.myName = name;
    this.isHost = false;
    this.moveLog = [];

    this.toast('Connecting to room ' + this.roomCode + '...');
    this.peer = new Peer(undefined, { debug: 0 });
    this.peer.on('open', () => {
      const conn = this.peer.connect(this.roomCode, { reliable: true });
      const timeout = setTimeout(() => this.toast('Connection timed out. Check the room code.'), 10000);
      conn.on('open', () => {
        clearTimeout(timeout);
        this.myConn = conn;
        conn.send({ type: 'join', name: this.myName });
        this.setupListeners(conn);
      });
      conn.on('error', (err) => this.toast('Connection error'));
    });
    this.peer.on('error', (err) => {
      if (err.type === 'disconnected') {
        this.peer.reconnect();
      } else {
        this.toast('Could not connect: ' + (err.message || err.type));
      }
    });
  },

  handleConnection(conn) {
    const idx = this.connsToMe.length;
    conn.playerIndex = idx;
    conn.on('data', (data) => {
      if (data.type === 'join') {
        conn.metadata = { name: data.name };
        if (!this.playerList) this.playerList = [this.myName];
        this.playerList[idx + 1] = data.name;
        this.connsToMe[idx] = conn;
        conn.send({ type: 'assign', playerId: idx + 1 });
        this.renderWaiting();
      } else if (data.type === 'play') {
        data.playerId = conn.playerIndex + 1;
        this.handlePlay(data);
      }
    });
    conn.on('close', () => {
      if (this.gameState && this.gameState.phase === 'playing') {
        this.toast('A player disconnected — game ended');
        this.linkDead();
      } else {
        this.toast('A player left');
        this.connsToMe[conn.playerIndex] = null;
        this.renderWaiting();
      }
    });
  },

  setupListeners(conn) {
    conn.on('data', (data) => {
      if (data.type === 'state') {
        this.handleStateUpdate(data);
      } else if (data.type === 'error') {
        this.toast(data.message);
      } else if (data.type === 'assign') {
        this.myPlayerId = data.playerId;
        this.showPlayerConnected();
      } else if (data.type === 'leave') {
        this.toast(data.message);
        this.backToLobby();
      } else if (data.type === 'log') {
        if (data.entries) this.moveLog = data.entries;
      }
    });
    conn.on('close', () => {
      if (this.gameState) {
        this.toast('Disconnected from host');
      } else {
        this.toast('The link is dead');
      }
      this.backToLobby();
    });
  },

  // ========== LOBBY / WAITING ==========
  showWaiting() {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('waiting-view').classList.add('active');
    document.getElementById('room-link-display').textContent = this.roomLink;
    this.renderWaiting();
  },

  showPlayerConnected() {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('connected-view').classList.add('active');
    document.getElementById('connected-room').textContent = this.roomCode;
  },

  renderWaiting() {
    const list = document.getElementById('waiting-players');
    const players = this.getConnectedPlayers();
    if (!players || players.length === 0) return;
    list.innerHTML = players.map((name, i) => {
      const dotClass = this.playerCount === 4 ? (i % 2 === 0 ? 'team1' : 'team2') : '';
      return `<div class="player-chip"><span class="dot ${dotClass}"></span>${escapeHtml(name)} ${i === 0 ? '(Host)' : ''}</div>`;
    }).join('');

    const btn = document.getElementById('start-game-btn');
    if (this.isHost) {
      const ready = players.length >= this.playerCount;
      btn.classList.toggle('hidden', !ready);
      btn.textContent = ready ? 'Start Game' : 'Waiting for players...';
      if (!ready) btn.disabled = true; else btn.disabled = false;
    }
  },

  getConnectedPlayers() {
    if (!this.isHost) return [];
    const names = [this.myName];
    for (let i = 0; i < this.connsToMe.length; i++) {
      if (this.connsToMe[i]) names.push(this.playerList[i + 1] || 'Player ' + (i + 2));
    }
    return names.filter(Boolean);
  },

  copyRoomLink() {
    navigator.clipboard.writeText(this.roomLink).then(() => {
      this.toast('Link copied!');
    }).catch(() => {
      this.toast('Share this link: ' + this.roomLink);
    });
  },

  leaveRoom() {
    // Notify all connected players the link is dead
    for (let i = 0; i < this.connsToMe.length; i++) {
      if (this.connsToMe[i]) {
        try { this.connsToMe[i].send({ type: 'leave', message: 'The link is dead' }); } catch(e) {}
      }
    }
    if (this.peer) { try { this.peer.destroy(); } catch(e) {} this.peer = null; }
    this.connsToMe = [];
    this.myConn = null;
    this.gameState = null;
    this.myHand = [];
    this.stopTurnTimer();
    this.showLobby();
  },

  linkDead() {
    for (let i = 0; i < this.connsToMe.length; i++) {
      if (this.connsToMe[i]) {
        try { this.connsToMe[i].send({ type: 'leave', message: 'The link is dead' }); } catch(e) {}
      }
    }
    this.backToLobby();
  },

  backToLobby() {
    if (this.peer) { try { this.peer.destroy(); } catch(e) {} this.peer = null; }
    this.connsToMe = [];
    this.myConn = null;
    this.gameState = null;
    this.myHand = [];
    this.selectedCardIndex = -1;
    this.selectedCaptureIndices = [];
    this.availableCaptures = [];
    this.moveLog = [];
    this.stopTurnTimer();
    const modal = document.getElementById('score-modal');
    if (modal) modal.classList.add('hidden');
    this.showLobby();
  },

  // ========== START GAME ==========
  startGame() {
    if (!this.isHost) return;

    // Filter active connections to avoid empty slot mismatches
    this.connsToMe = this.connsToMe.filter(Boolean);
    const players = [this.myName];
    this.connsToMe.forEach((conn, idx) => {
      conn.playerIndex = idx;
      conn.send({ type: 'assign', playerId: idx + 1 });
      players.push(conn.metadata?.name || this.playerList[idx + 1] || 'Player ' + (idx + 2));
    });

    const numPlayers = this.playerCount;
    if (players.length < numPlayers) { this.toast('Not enough players'); return; }

    const totalPlayerCards = numPlayers * 3;
    const remainingRounds = Math.ceil((40 - 4 - totalPlayerCards) / totalPlayerCards);
    const totalRounds = 1 + remainingRounds;

    this.moveLog = [];

    this.gameState = {
      phase: 'playing', numPlayers,
      players: players.map((name, i) => ({ id: i, name, team: numPlayers === 4 ? (i % 2) : i })),
      deck: shuffle(createDeck()), tableCards: [], hands: players.map(() => []),
      capturedTeams: [[], []], currentTurn: -1, dealerIndex: 0, roundNum: 0, totalRounds,
      cardsPlayedThisRound: players.map(() => 0), lastCaptureTeam: -1,
      shkobbaCount: [0, 0], scores: [0, 0],
      forceCapture: this.forceCapture, winScore: this.winScore, shkobbaThisTurn: false,
      turnTimerDuration: this.turnTimerDuration,
    };
    this.addLogEntry('🎴 Game started!');
    this.dealRound();
  },

  // ========== DEALING ==========
  dealRound() {
    const gs = this.gameState;
    this.animateDeal = true;
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
    this.addLogEntry('📤 Cards dealt — Round ' + (gs.roundNum + 1));
    this.broadcastGameState();
    this.renderGame();
    this.startTurnTimer();
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
    gs.shkobbaThisTurn = false;
    this.broadcastGameState();
    this.renderGame();
    this.startTurnTimer();
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
  startTurnTimer() {
    this.stopTurnTimer();
    const gs = this.gameState;
    if (!gs || gs.phase !== 'playing' || !gs.turnTimerDuration || gs.turnTimerDuration <= 0) {
      this.updateTimerDisplay(1, gs ? gs.turnTimerDuration : 0);
      return;
    }
    if (gs.currentTurn < 0) return;

    this._lastTimerSec = 0;
    this._turnTimerStart = Date.now();
    this._turnTimerRemaining = gs.turnTimerDuration;

    // Only host runs the actual timeout
    if (this.isHost) {
      this._turnTimer = setTimeout(() => {
        this.autoPlay();
      }, gs.turnTimerDuration * 1000);
    }

    // All clients animate the bar
    this.animateTimerBar();
  },

  stopTurnTimer() {
    if (this._turnTimer) { clearTimeout(this._turnTimer); this._turnTimer = null; }
    if (this._timerRAF) { cancelAnimationFrame(this._timerRAF); this._timerRAF = null; }
  },

  animateTimerBar() {
    const gs = this.gameState;
    if (!gs || !gs.turnTimerDuration || gs.turnTimerDuration <= 0) return;

    const totalMs = gs.turnTimerDuration * 1000;
    const bar = document.getElementById('timer-bar');
    const text = document.getElementById('timer-text');
    if (!bar) return;

    const tick = () => {
      const elapsed = Date.now() - this._turnTimerStart;
      const remaining = Math.max(0, totalMs - elapsed);
      const fraction = remaining / totalMs;

      bar.style.width = (fraction * 100) + '%';

      // Color transitions
      bar.classList.remove('warning', 'danger');
      if (fraction < 0.2) bar.classList.add('danger');
      else if (fraction < 0.45) bar.classList.add('warning');

      if (text) {
        const secs = Math.ceil(remaining / 1000);
        text.textContent = secs > 0 ? secs + 's' : '';

        if (secs <= 5 && secs > 0 && this._lastTimerSec !== secs) {
          this._lastTimerSec = secs;
          this.playSound('warning');

          const container = document.getElementById('timer-bar-container');
          if (container) {
            container.classList.add('pulse-shake');
            setTimeout(() => container.classList.remove('pulse-shake'), 200);
          }
        }
      }

      if (remaining > 0) {
        this._timerRAF = requestAnimationFrame(tick);
      }
    };
    this._timerRAF = requestAnimationFrame(tick);
  },

  updateTimerDisplay(fraction, duration) {
    const bar = document.getElementById('timer-bar');
    const text = document.getElementById('timer-text');
    if (bar) {
      bar.style.width = (!duration || duration <= 0) ? '0%' : (fraction * 100) + '%';
      bar.classList.remove('warning', 'danger');
    }
    if (text) text.textContent = '';
  },

  autoPlay() {
    if (!this.isHost) return;
    const gs = this.gameState;
    if (!gs || gs.phase !== 'playing' || gs.currentTurn < 0) return;

    this.playSound('timeout');

    const playerId = gs.currentTurn;
    const hand = gs.hands[playerId];
    if (!hand || hand.length === 0) return;

    // Pick a random card from hand
    const cardIndex = Math.floor(Math.random() * hand.length);
    const card = hand[cardIndex];

    // Check for valid captures
    const captures = findCaptureCombinations(gs.tableCards, card.value);
    let captureIds = [];

    if (gs.forceCapture && captures.length > 0 && gs.tableCards.length > 0) {
      // Must capture: pick first valid combination
      captureIds = captures[0].map(i => gs.tableCards[i].id);
    }

    const playerName = gs.players[playerId] ? gs.players[playerId].name : 'Player ' + playerId;
    this.addLogEntry(`⏰ Time's up! ${playerName} auto-played ${getCardDisplayName(card)}`);
    this.toast(`⏰ ${playerName} ran out of time!`);

    this.handlePlay({ playerId, cardId: card.id, captureCardIds: captureIds });
  },

  // ========== PLAY LOGIC ==========
  handlePlay(data) {
    if (!this.isHost) return;
    const gs = this.gameState, playerId = data.playerId;
    if (playerId !== gs.currentTurn) { this.sendToPlayer(playerId, { type: 'error', message: 'Not your turn!' }); return; }

    this.stopTurnTimer();

    const hand = gs.hands[playerId];
    const cardIndex = hand.findIndex(c => c.id === data.cardId);
    if (cardIndex === -1) { this.sendToPlayer(playerId, { type: 'error', message: 'Card not found!' }); return; }

    const playedCard = hand[cardIndex];
    const captureIds = data.captureCardIds || [];
    const possibleCaptures = findCaptureCombinations(gs.tableCards, playedCard.value);
    const hasValidCapture = possibleCaptures.length > 0;

    if (captureIds.length > 0) {
      const capIndices = captureIds.map(id => gs.tableCards.findIndex(c => c.id === id));
      if (capIndices.includes(-1)) { this.sendToPlayer(playerId, { type: 'error', message: 'Invalid capture!' }); return; }
      const sum = capIndices.reduce((s, idx) => s + gs.tableCards[idx].value, 0);
      if (sum !== playedCard.value) { this.sendToPlayer(playerId, { type: 'error', message: 'Cards must sum to ' + playedCard.value }); return; }
    } else if (gs.forceCapture && hasValidCapture && gs.tableCards.length > 0) {
      this.sendToPlayer(playerId, { type: 'error', message: 'You must capture when possible!' }); return;
    }

    hand.splice(cardIndex, 1);
    const teamIndex = gs.players[playerId].team;
    const playerName = gs.players[playerId].name;

    if (captureIds.length > 0) {
      const capturedCards = [];
      const sorted = [...captureIds].sort((a, b) => gs.tableCards.findIndex(c => c.id === b) - gs.tableCards.findIndex(c => c.id === a));
      for (const id of sorted) {
        const idx = gs.tableCards.findIndex(c => c.id === id);
        if (idx !== -1) capturedCards.push(...gs.tableCards.splice(idx, 1));
      }
      capturedCards.push(playedCard);
      gs.capturedTeams[teamIndex].push(...capturedCards);
      gs.lastCaptureTeam = teamIndex;

      const capturedNames = capturedCards.filter(c => c.id !== playedCard.id).map(c => getCardDisplayName(c)).join('+');
      let logMsg = `${playerName} captured ${capturedNames} with ${getCardDisplayName(playedCard)}`;

      // Shkobba: clearing the table
      if (gs.tableCards.length === 0) {
        if (playerId === gs.dealerIndex && hand.length === 0) {
          // Last card of dealer, no shkobba
        } else {
          gs.shkobbaCount[teamIndex]++;
          gs.shkobbaThisTurn = true;
          logMsg += ' — SHKOBBA! 🎉';
        }
      }

      this.addLogEntry(logMsg);

      if (gs.shkobbaThisTurn) {
        this.playSound('shkobba');
      } else {
        this.playSound('capture');
      }

      // Instant win: all 10 diamonds captured
      const diaCount = gs.capturedTeams[teamIndex].filter(c => c.suit === DIAMONDS).length;
      if (diaCount >= 10) {
        this.addLogEntry('🏆 All 10 diamonds captured! Instant win!');
        this.toast('All 10 diamonds captured! Instant win!');
        gs.phase = 'finished';
        gs.winner = teamIndex;
        gs.currentTurn = -1;
        this.playSound('win');
        this.broadcastGameState();
        this.renderGame();
        this.showScoreboard();
        return;
      }
    } else {
      gs.tableCards.push(playedCard);
      this.addLogEntry(`${playerName} placed ${getCardDisplayName(playedCard)}`);
      this.playSound('place');
    }

    gs.cardsPlayedThisRound[playerId]++;

    if (gs.hands.every(h => h.length === 0) && gs.deck.length === 0) {
      gs.currentTurn = -1; this.broadcastGameState(); this.renderGame();
      setTimeout(() => this.endRound(), 1000);
    } else if (gs.hands.every(h => h.length === 0)) {
      gs.nextDealerTurn = (playerId + 1) % gs.numPlayers;
      setTimeout(() => this.endRound(), 1000);
    } else {
      this.nextTurn();
    }
  },

  // ========== SCORING ==========
  calculateScores() {
    const gs = this.gameState;
    const teamCount = gs.numPlayers === 4 ? 2 : gs.numPlayers;

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
    else if (diamondSevens[0] && diamondSevens[1]) {
      for (let val = 6; val >= 1; val--) {
        const name = val === 1 ? 'ace' : String(val);
        const t0 = gs.capturedTeams[0].some(c => c.suit === DIAMONDS && c.name === name);
        const t1 = gs.capturedTeams[1].some(c => c.suit === DIAMONDS && c.name === name);
        if (t0 && !t1) { sevenDiamondsPt = 0; break; }
        if (!t0 && t1) { sevenDiamondsPt = 1; break; }
      }
    }

    if (mostCardsPt >= 0) gs.scores[mostCardsPt]++;
    if (mostDiamondsPt >= 0) gs.scores[mostDiamondsPt]++;
    if (sevenDiamondsPt >= 0) gs.scores[sevenDiamondsPt]++;
    gs.scores[0] += gs.shkobbaCount[0];
    gs.scores[1] += gs.shkobbaCount[1];

    gs.lastScore = { mostCardsPt, mostDiamondsPt, sevenDiamondsPt };
    gs.phase = 'round_end';
    this.addLogEntry(`📊 Round scored — Team 1: ${gs.scores[0]}, Team 2: ${gs.scores[1]}`);
    this.broadcastGameState();
    this.renderGame();
    this.showScoreboard();
  },

  checkWinCondition() {
    const gs = this.gameState;
    let winner = -1;
    if (gs.scores[0] >= gs.winScore || gs.scores[1] >= gs.winScore) {
      if (gs.scores[0] > gs.scores[1]) winner = 0;
      else if (gs.scores[1] > gs.scores[0]) winner = 1;
    }
    if (winner >= 0) {
      gs.phase = 'finished'; gs.winner = winner;
      this.addLogEntry(`🏆 Team ${winner + 1} wins the game!`);
      this.playSound('win');
      this.broadcastGameState(); this.renderGame(); this.showScoreboard();
      return;
    }
    if (gs.deck.length > 0) { gs.phase = 'playing'; this.dealRound(); return; }

    // Deck is empty: increment dealer for the new deck!
    gs.dealerIndex = (gs.dealerIndex + 1) % gs.numPlayers;
    gs.totalRounds = 1 + Math.ceil((40 - 4 - gs.numPlayers * 3) / (gs.numPlayers * 3));
    gs.phase = 'playing'; gs.deck = shuffle(createDeck());
    gs.capturedTeams = [[], []]; gs.shkobbaCount = [0, 0]; gs.lastCaptureTeam = -1;
    gs.tableCards = []; gs.roundNum = 0; this.dealRound();
  },

  // ========== NETWORKING ==========
  broadcastGameState() {
    if (!this.isHost || !this.gameState) return;
    for (let i = 0; i < this.gameState.numPlayers; i++) {
      if (i === 0) continue; // Host already has full state, just render
      this.sendToPlayer(i, { type: 'state', ...this.buildPlayerState(i) });
      // Send move log too
      this.sendToPlayer(i, { type: 'log', entries: this.moveLog.slice(-50) });
    }
    this.renderGame();
  },

  buildPlayerState(playerId) {
    const gs = this.gameState;
    return {
      phase: gs.phase, yourId: playerId,
      players: gs.players.map(p => ({ id: p.id, name: p.name, team: p.team })),
      hand: gs.hands[playerId] ? [...gs.hands[playerId]] : [],
      tableCards: [...gs.tableCards], deckCount: gs.deck.length,
      currentTurn: gs.currentTurn, dealerIndex: gs.dealerIndex,
      roundNum: gs.roundNum, totalRounds: gs.totalRounds,
      lastCaptureTeam: gs.lastCaptureTeam, shkobbaCount: [...gs.shkobbaCount],
      capturedCounts: gs.capturedTeams.map(t => t.length),
      scores: [...gs.scores], forceCapture: gs.forceCapture, winScore: gs.winScore,
      cardsPlayedThisRound: [...gs.cardsPlayedThisRound],
      lastScore: gs.lastScore || null, shkobbaThisTurn: gs.shkobbaThisTurn || false,
      winner: gs.winner !== undefined ? gs.winner : -1,
      turnTimerDuration: gs.turnTimerDuration || 0,
      nextDealerTurn: gs.nextDealerTurn !== undefined ? gs.nextDealerTurn : -1,
      // Send diamond ownership info for tracker
      diamondOwnership: this.getDiamondOwnership(),
    };
  },

  getDiamondOwnership() {
    const gs = this.gameState;
    if (!gs) return {};
    const ownership = {};
    for (let t = 0; t < 2; t++) {
      for (const card of (gs.capturedTeams[t] || [])) {
        if (card.suit === DIAMONDS) {
          ownership[card.name] = t;
        }
      }
    }
    return ownership;
  },

  sendToPlayer(playerIndex, message) {
    if (!this.isHost) return;
    if (playerIndex === 0) {
      if (message.type === 'state') {
        this.myPlayerId = 0;
        this.myHand = this.gameState.hands[0] || [];
      }
      return;
    }
    const conn = this.connsToMe[playerIndex - 1];
    if (conn) { try { conn.send(message); } catch(e) {} }
  },

  // ========== PLAYER STATE HANDLER ==========
  handleStateUpdate(data) {
    this.myPlayerId = data.yourId;
    this.myHand = data.hand || [];
    this.playerCount = data.players.length;

    const oldState = this.gameState;
    const oldHandLength = (oldState && oldState.hand) ? oldState.hand.length : 0;

    this.gameState = {
      phase: data.phase, numPlayers: data.players.length,
      players: data.players, tableCards: data.tableCards || [],
      deckCount: data.deckCount, currentTurn: data.currentTurn,
      dealerIndex: data.dealerIndex, roundNum: data.roundNum,
      totalRounds: data.totalRounds, lastCaptureTeam: data.lastCaptureTeam,
      shkobbaCount: data.shkobbaCount, capturedCounts: data.capturedCounts,
      scores: data.scores, forceCapture: data.forceCapture, winScore: data.winScore,
      cardsPlayedThisRound: data.cardsPlayedThisRound,
      lastScore: data.lastScore, shkobbaThisTurn: data.shkobbaThisTurn,
      winner: data.winner,
      turnTimerDuration: data.turnTimerDuration || 0,
      nextDealerTurn: data.nextDealerTurn !== -1 ? data.nextDealerTurn : undefined,
      diamondOwnership: data.diamondOwnership || {},
    };

    this.selectedCardIndex = -1;
    this.selectedCaptureIndices = [];
    this.availableCaptures = [];

    // Trigger deal animation when hand count increases from 0 or round transitions
    if (data.hand && data.hand.length > 0 && (oldHandLength === 0 || (oldState && oldState.roundNum !== data.roundNum))) {
      this.animateDeal = true;
    }

    // Play synthesised sounds based on state transitions on client
    if (oldState && oldState.phase === 'playing') {
      if (data.phase === 'finished') {
        this.playSound('win');
      } else if (data.shkobbaThisTurn) {
        this.playSound('shkobba');
      } else {
        const oldCapSum = (oldState.capturedCounts || [0, 0]).reduce((a, b) => a + b, 0);
        const newCapSum = (data.capturedCounts || [0, 0]).reduce((a, b) => a + b, 0);
        if (newCapSum > oldCapSum) {
          this.playSound('capture');
        } else {
          const oldTableCount = (oldState.tableCards || []).length;
          const newTableCount = (data.tableCards || []).length;
          if (newTableCount !== oldTableCount) {
            this.playSound('place');
          }
        }
      }
    }

    if (data.phase === 'finished' || data.phase === 'round_end') {
      this.renderGame();
      this.showScoreboard();
    } else {
      const modal = document.getElementById('score-modal');
      if (modal) modal.classList.add('hidden');

      this.renderGame();
      // Non-host also shows timer
      if (data.phase === 'playing' && data.currentTurn >= 0) {
        this.startTurnTimer();
      }
    }
  },

  // ========== PLAYER ACTIONS ==========
  onCardClick(index) {
    const gs = this.gameState;
    if (!gs || gs.phase !== 'playing' || gs.currentTurn !== this.myPlayerId || this.isSubmittingMove) return;

    this.playSound('click');

    // Double tap detection (300ms window)
    const now = Date.now();
    const DOUBLE_TAP_DELAY = 300;
    if (this._lastCardClickIndex === index && (now - this._lastCardClickTime) < DOUBLE_TAP_DELAY) {
      this._lastCardClickIndex = -1;
      this._lastCardClickTime = 0;
      this.onCardDblClick(index);
      return;
    }
    this._lastCardClickIndex = index;
    this._lastCardClickTime = now;

    if (this.selectedCardIndex === index) { this.cancelSelection(); return; }
    this.selectedCardIndex = index;
    const card = this.myHand[index];
    if (!card) return;
    this.selectedCaptureIndices = [];
    this.availableCaptures = findCaptureCombinations(gs.tableCards, card.value);
    this.renderGame();
  },

  onCardDblClick(index) {
    const gs = this.gameState;
    if (!gs || gs.phase !== 'playing' || gs.currentTurn !== this.myPlayerId || this.isSubmittingMove) return;
    this.selectedCardIndex = index;
    const card = this.myHand[index];
    if (!card) return;
    this.selectedCaptureIndices = [];
    this.availableCaptures = findCaptureCombinations(gs.tableCards, card.value);
    if (gs.forceCapture && this.availableCaptures.length > 0 && gs.tableCards.length > 0) {
      this.toast('Must capture! Select table cards and click Capture.');
      return;
    }
    this.placeCard();
  },

  onTableCardClick(index) {
    const gs = this.gameState;
    if (!gs || gs.phase !== 'playing' || gs.currentTurn !== this.myPlayerId || this.selectedCardIndex === -1 || this.isSubmittingMove) return;
    this.playSound('click');
    const cardId = gs.tableCards[index].id;
    const idx = this.selectedCaptureIndices.indexOf(cardId);
    if (idx >= 0) this.selectedCaptureIndices.splice(idx, 1);
    else this.selectedCaptureIndices.push(cardId);
    this.renderGame();
  },

  placeCard() {
    const gs = this.gameState;
    if (this.selectedCardIndex === -1) return;
    if (gs.forceCapture && this.availableCaptures.length > 0 && gs.tableCards.length > 0) {
      this.toast('You must capture when possible!'); return;
    }
    const card = this.myHand[this.selectedCardIndex];
    this.sendMove(card.id, []);
  },

  confirmCapture() {
    if (this.selectedCardIndex === -1) return;
    if (this.selectedCaptureIndices.length === 0) { this.toast('Select cards to capture'); return; }
    const card = this.myHand[this.selectedCardIndex];
    const gs = this.gameState;
    const sum = this.selectedCaptureIndices.reduce((s, id) => {
      const c = gs.tableCards.find(tc => tc.id === id);
      return s + (c ? c.value : 0);
    }, 0);
    if (sum !== card.value) { this.toast('Cards must sum to ' + card.value); return; }
    this.sendMove(card.id, this.selectedCaptureIndices);
  },

  cancelSelection() {
    this.selectedCardIndex = -1;
    this.selectedCaptureIndices = [];
    this.availableCaptures = [];
    this.renderGame();
  },

  sendMove(cardId, captureCardIds) {
    if (this.isSubmittingMove) return;
    this.isSubmittingMove = true;

    const executeSend = () => {
      if (this.isHost) {
        this.handlePlay({ playerId: this.myPlayerId, cardId, captureCardIds });
      } else if (this.myConn) {
        this.myConn.send({ type: 'play', cardId, captureCardIds });
        this.cancelSelection();
      }
    };

    if (this.animationsEnabled) {
      const cards = document.querySelectorAll('#hand-cards .card');
      const idx = this.selectedCardIndex;
      if (idx >= 0 && cards[idx]) {
        cards[idx].style.transition = 'all 0.25s var(--ease-out)';
        cards[idx].style.transform = 'translateY(-100px) scale(0.8)';
        cards[idx].style.opacity = '0';
      }
      setTimeout(executeSend, 250);
    } else {
      executeSend();
    }
  },

  // ========== MOVE LOG ==========
  addLogEntry(text) {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    this.moveLog.push({ time, text });
    if (this.moveLog.length > 100) this.moveLog.shift();
  },

  // ========== RENDER ==========
  renderGame() {
    this.isSubmittingMove = false;
    const gs = this.gameState;
    if (!gs) return;
    if (this.isHost && gs.hands) this.myHand = gs.hands[this.myPlayerId] || [];

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('game-view').classList.add('active');

    this.renderHeader();
    this.renderOpponents();
    this.renderTable();
    this.renderHand();
    this.updateDebugPanel();
    if (this.controlsOpen) this.renderControlsContent();

    // Reset animateDeal after rendering
    this.animateDeal = false;
  },

  renderHeader() {
    const gs = this.gameState;
    document.getElementById('game-room-code').textContent = this.roomCode;
    document.getElementById('round-num').textContent = gs.roundNum + 1;
    document.getElementById('round-total').textContent = gs.totalRounds;
    const deckCount = gs.deck ? gs.deck.length : (gs.deckCount || 0);
    document.getElementById('deck-display').textContent = 'Deck: ' + deckCount;

    const turnEl = document.getElementById('turn-display');
    if (gs.phase === 'playing' && gs.currentTurn >= 0) {
      const p = gs.players[gs.currentTurn];
      turnEl.textContent = 'Turn: ' + (p ? p.name : '--');
      if (gs.currentTurn === this.myPlayerId) turnEl.innerHTML = 'Turn: <strong style="color:var(--gold)">Your Turn!</strong>';
    } else if (gs.phase === 'round_end') turnEl.textContent = 'Round End';
    else if (gs.phase === 'finished') turnEl.textContent = 'Game Over';
    else turnEl.textContent = '--';

    document.getElementById('score-t1').textContent = 'Team 1: ' + gs.scores[0];
    document.getElementById('score-t2').textContent = 'Team 2: ' + gs.scores[1];
    document.getElementById('score-t1').className = 'score-badge t1';
    document.getElementById('score-t2').className = 'score-badge t2';
  },

  renderOpponents() {
    const gs = this.gameState;
    if (!gs || !gs.players) return;
    const topEl = document.getElementById('opponents-top');
    const leftEl = document.getElementById('opponent-left');
    const rightEl = document.getElementById('opponent-right');
    topEl.innerHTML = ''; leftEl.innerHTML = ''; rightEl.innerHTML = '';

    if (gs.numPlayers === 2) {
      const opp = gs.players[1 - this.myPlayerId];
      topEl.innerHTML = opp ? this.opponentHtml(opp, gs) : '';
    } else {
      const myPos = this.myPlayerId;
      topEl.innerHTML = this.opponentHtml(gs.players[(myPos + 2) % 4], gs);
      leftEl.innerHTML = this.opponentHtml(gs.players[(myPos + 3) % 4], gs);
      rightEl.innerHTML = this.opponentHtml(gs.players[(myPos + 1) % 4], gs);
    }
  },

  opponentHtml(player, gs) {
    if (!player) return '';
    const isTurn = gs.currentTurn === player.id;
    const capCount = gs.capturedCounts ? gs.capturedCounts[player.team] : (gs.capturedTeams ? gs.capturedTeams[player.team].length : 0);
    const handCards = gs.cardsPlayedThisRound ? 3 - (gs.cardsPlayedThisRound[player.id] || 0) : 3;
    const shkobbaDots = gs.shkobbaCount[player.team] > 0
      ? '<span class="shkobba-marker"></span>'.repeat(gs.shkobbaCount[player.team]) : '';

    let pileHtml = '';
    if (capCount > 0) {
      const stacks = Math.min(capCount, 5);
      for (let i = 0; i < stacks; i++) {
        pileHtml += `<div class="card-back mini" style="margin-left:${i > 0 ? '-30px' : '0'}"></div>`;
      }
    }

    return `<div class="opponent-info ${isTurn ? 'active-turn' : ''} team${player.team + 1}">
      <div class="name">${escapeHtml(player.name)} (T${player.team + 1})</div>
      <div class="card-count">${handCards > 0 ? 'Cards: ' + handCards : '<span style="color:var(--text-dim);">Done</span>'}</div>
      <div class="captured-row">
        <div class="captured-pile">${pileHtml}</div>
        <div class="captured-label">${capCount} ${shkobbaDots}</div>
      </div>
    </div>`;
  },

  renderTable() {
    const gs = this.gameState;
    const tableEl = document.getElementById('table-cards');
    const msgEl = document.getElementById('table-msg');
    const hintEl = document.getElementById('capture-hint');
    const deckEl = document.getElementById('table-deck');

    if (!gs) return;

    const deckCount = gs.deck ? gs.deck.length : (gs.deckCount || 0);
    deckEl.innerHTML = deckCount > 0
      ? `<div class="card-back"></div><span class="deck-count">${deckCount}</span>`
      : '<span class="deck-count" style="color:var(--text-dim);">Empty</span>';

    if (!gs.tableCards || gs.tableCards.length === 0) {
      tableEl.innerHTML = '';
      msgEl.textContent = gs.phase === 'playing' ? 'Table is empty' : '';
      hintEl.classList.add('hidden');
      this.updateShkobbaAnnounce(gs);
      return;
    }

    msgEl.textContent = '';
    tableEl.innerHTML = gs.tableCards.map((card, i) => {
      const isSelected = this.selectedCaptureIndices.includes(card.id);
      let cls = 'card';
      if (gs.currentTurn === this.myPlayerId && this.selectedCardIndex >= 0) cls += ' capture-target selectable';
      if (isSelected) cls += ' selected';
      return `<div class="${cls}" onclick="app.onTableCardClick(${i})"><img src="${getCardImage(card)}" alt="${card.display}"></div>`;
    }).join('');

    const showHint = this.selectedCardIndex >= 0 && gs.currentTurn === this.myPlayerId;
    hintEl.classList.toggle('hidden', !showHint);
    if (showHint) {
      const card = this.myHand[this.selectedCardIndex];
      hintEl.textContent = this.availableCaptures.length > 0
        ? `Select table cards that sum to ${card.display}=${card.value}`
        : 'No capture possible. Click "Place".';
    }

    this.updateShkobbaAnnounce(gs);
  },

  updateShkobbaAnnounce(gs) {
    const el = document.getElementById('shkobba-announce');
    if (gs.shkobbaThisTurn) { el.classList.remove('hidden'); setTimeout(() => el.classList.add('hidden'), 2500); }
    else el.classList.add('hidden');
  },

  renderHand() {
    const gs = this.gameState;
    const handEl = document.getElementById('hand-cards');
    const actionsEl = document.getElementById('hand-actions');
    const labelEl = document.getElementById('player-label');
    const capturedEl = document.getElementById('my-captured');

    if (!gs) return;
    const myPlayer = gs.players ? gs.players.find(p => p.id === this.myPlayerId) : null;
    labelEl.textContent = myPlayer ? `${escapeHtml(myPlayer.name)} (T${myPlayer.team + 1})` : 'Your Hand';

    const myTeam = myPlayer ? myPlayer.team : 0;
    const myCapturedCards = gs.capturedTeams ? gs.capturedTeams[myTeam] : [];
    const capturedCount = gs.capturedCounts ? gs.capturedCounts[myTeam] : myCapturedCards.length;
    const myShkobba = gs.shkobbaCount ? gs.shkobbaCount[myTeam] : 0;

    if (capturedEl) {
      if (capturedCount > 0) {
        let pileEls = '';
        const stacks = Math.min(capturedCount, 5);
        for (let i = 0; i < stacks; i++) {
          pileEls += `<div class="card-back mini" style="margin-left:${i > 0 ? '-30px' : '0'}"></div>`;
        }
        capturedEl.innerHTML = `<span style="color:var(--text-secondary);font-size:0.72rem;font-weight:600;">Captured:</span> ${pileEls} <span style="color:var(--gold);font-size:0.85rem;font-weight:700;">${capturedCount}</span>${myShkobba > 0 ? ' <span class="shkobba-marker"></span>'.repeat(myShkobba) : ''}`;
        capturedEl.classList.remove('hidden');
      } else {
        capturedEl.classList.add('hidden');
      }
    }

    const isMyTurn = gs.currentTurn === this.myPlayerId && gs.phase === 'playing';

    if (!this.myHand || this.myHand.length === 0) {
      handEl.innerHTML = gs.phase === 'playing' ? '<div style="color:var(--text-secondary);padding:1rem;">No cards left this round</div>' : '';
      actionsEl.classList.add('hidden');
      return;
    }

    handEl.innerHTML = this.myHand.map((card, i) => {
      const isSelected = this.selectedCardIndex === i;
      let cls = 'card';
      if (isMyTurn) cls += ' selectable';
      if (isSelected) cls += ' selected';

      const animClass = (this.animationsEnabled && this.animateDeal) ? ' deal-animate' : '';
      const animStyle = (this.animationsEnabled && this.animateDeal) ? ` style="animation-delay: ${i * 0.12}s"` : '';

      return `<div class="${cls}${animClass}"${animStyle} onclick="app.onCardClick(${i})" ondblclick="app.onCardDblClick(${i})"><img src="${getCardImage(card)}" alt="${card.display}"></div>`;
    }).join('');

    actionsEl.classList.toggle('hidden', !isMyTurn);
  },

  showScoreboard() {
    const gs = this.gameState;
    if (!gs) return;

    this.stopTurnTimer();
    const modal = document.getElementById('score-modal');
    const titleEl = document.getElementById('score-title');
    const detailsEl = document.getElementById('score-details');
    const actionsEl = document.getElementById('score-modal-actions');
    if (!modal) return;

    const isGameOver = gs.phase === 'finished';
    titleEl.textContent = isGameOver ? 'Game Over' : `Round ${gs.roundNum + 1} Completed`;

    const cap0 = gs.capturedCounts ? gs.capturedCounts[0] : (gs.capturedTeams ? gs.capturedTeams[0].length : 0);
    const cap1 = gs.capturedCounts ? gs.capturedCounts[1] : (gs.capturedTeams ? gs.capturedTeams[1].length : 0);

    // Diamond count
    const ownership = gs.diamondOwnership || (this.isHost ? this.getDiamondOwnership() : {});
    let dia0 = 0, dia1 = 0;
    Object.values(ownership).forEach(owner => {
      if (owner === 0) dia0++;
      else if (owner === 1) dia1++;
    });

    let detailsHtml = '';

    if (isGameOver && gs.winner >= 0 && (gs.lastScore === null || gs.lastScore === undefined)) {
      const players = gs.players.filter(p => p.team === gs.winner).map(p => p.name).join(' & ');
      detailsHtml = `
        <p style="font-size:1.3rem;color:var(--gold);margin-bottom:0.5rem;">♦ ALL 10 DIAMONDS! ♦</p>
        <p style="font-size:1.1rem;margin-bottom:1rem;">${escapeHtml(players)}</p>
        <p style="color:var(--text-secondary);">Instant win by capturing every diamond in a single round!</p>
        <p style="margin-top:1rem;font-size:1.15rem;color:var(--gold);">Final Score: Team 1 (${gs.scores[0]}) - Team 2 (${gs.scores[1]})</p>
      `;
    } else {
      const ls = gs.lastScore || { mostCardsPt: -1, mostDiamondsPt: -1, sevenDiamondsPt: -1 };

      detailsHtml = `
        <table class="score-table">
          <thead>
            <tr>
              <th>Category</th>
              <th>Team 1</th>
              <th>Team 2</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Captured Cards</td>
              <td>${cap0} cards ${ls.mostCardsPt === 0 ? '<strong style="color:var(--gold)">(+1)</strong>' : ''}</td>
              <td>${cap1} cards ${ls.mostCardsPt === 1 ? '<strong style="color:var(--gold)">(+1)</strong>' : ''}</td>
            </tr>
            <tr>
              <td>Diamonds</td>
              <td>${dia0} diamonds ${ls.mostDiamondsPt === 0 ? '<strong style="color:var(--gold)">(+1)</strong>' : ''}</td>
              <td>${dia1} diamonds ${ls.mostDiamondsPt === 1 ? '<strong style="color:var(--gold)">(+1)</strong>' : ''}</td>
            </tr>
            <tr>
              <td>7 of Diamonds</td>
              <td>${ls.sevenDiamondsPt === 0 ? '<strong style="color:var(--gold)">(+1)</strong>' : '0'}</td>
              <td>${ls.sevenDiamondsPt === 1 ? '<strong style="color:var(--gold)">(+1)</strong>' : '0'}</td>
            </tr>
            <tr>
              <td>Shkobba Count</td>
              <td>+${gs.shkobbaCount[0]}</td>
              <td>+${gs.shkobbaCount[1]}</td>
            </tr>
            <tr class="total">
              <td>Total Score</td>
              <td>${gs.scores[0]}</td>
              <td>${gs.scores[1]}</td>
            </tr>
          </tbody>
        </table>
      `;
    }

    detailsEl.innerHTML = detailsHtml;

    if (isGameOver) {
      actionsEl.innerHTML = `<button class="btn btn-primary" onclick="app.backToLobby()">Back to Menu</button>`;
    } else {
      if (this.isHost) {
        actionsEl.innerHTML = `<button class="btn btn-primary" onclick="app.startNextRound()">Start Next Round</button>`;
      } else {
        actionsEl.innerHTML = `<div style="color:var(--text-secondary);font-size:0.85rem;font-style:italic;margin-top:0.5rem;">Waiting for host to start next round...</div>`;
      }
    }

    modal.classList.remove('hidden');
  },

  startNextRound() {
    if (!this.isHost) return;
    const modal = document.getElementById('score-modal');
    if (modal) modal.classList.add('hidden');
    this.checkWinCondition();
  },

  playSound(type) {
    if (!this.soundsEnabled) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const ctx = new AudioContext();

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
      } else if (type === 'place') {
        const osc = ctx.createOscillator();
        const gainNode = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(150, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(60, ctx.currentTime + 0.15);
        gainNode.gain.setValueAtTime(0.15, ctx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
        osc.connect(gainNode);
        gainNode.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.15);
      } else if (type === 'capture') {
        playTone(523.25, 0.1, 'sine', 0.1, 0); // C5
        playTone(659.25, 0.25, 'sine', 0.1, 0.06); // E5
      } else if (type === 'shkobba') {
        const tempo = 0.08;
        playTone(523.25, 0.15, 'sine', 0.12, 0);       // C5
        playTone(659.25, 0.15, 'sine', 0.12, tempo);     // E5
        playTone(783.99, 0.15, 'sine', 0.12, tempo * 2); // G5
        playTone(1046.50, 0.4, 'sine', 0.15, tempo * 3); // C6
      } else if (type === 'win') {
        const notes = [261.63, 329.63, 392.00, 523.25, 659.25, 783.99, 1046.50];
        notes.forEach((freq, idx) => {
          playTone(freq, 0.4, 'sine', 0.1, idx * 0.12);
        });
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
      console.warn('Web Audio error:', e);
    }
  },

  toggleSounds(checked) {
    this.soundsEnabled = checked;
    localStorage.setItem('chkoba_sounds', checked);
    this.toast('Sound effects ' + (checked ? 'enabled' : 'disabled'));
    if (checked) {
      this.playSound('click');
    }
  },

  toggleAnimations(checked) {
    this.animationsEnabled = checked;
    localStorage.setItem('chkoba_animations', checked);
    this.toast('Animations ' + (checked ? 'enabled' : 'disabled'));
  },

  // ========== TOAST ==========
  toast(message) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
  },

  // ========== CONTROLS PANEL ==========
  toggleControls() {
    this.controlsOpen = !this.controlsOpen;
    const panel = document.getElementById('controls-panel');
    const btn = document.getElementById('btn-controls');
    panel.classList.toggle('open', this.controlsOpen);
    if (btn) btn.classList.toggle('active', this.controlsOpen);
    if (this.controlsOpen) this.renderControlsContent();
  },

  switchControlsTab(tab) {
    this.controlsTab = tab;
    document.querySelectorAll('.controls-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    this.renderControlsContent();
  },

  renderControlsContent() {
    const el = document.getElementById('controls-content');
    if (!el) return;

    switch (this.controlsTab) {
      case 'stats': el.innerHTML = this.renderControlsStats(); break;
      case 'settings': el.innerHTML = this.renderControlsSettings(); break;
      case 'log': el.innerHTML = this.renderControlsLog(); break;
      case 'actions': el.innerHTML = this.renderControlsActions(); break;
    }
  },

  renderControlsStats() {
    const gs = this.gameState;
    if (!gs) return '<div style="color:var(--text-dim);padding:1rem;">No game in progress</div>';

    const deckCount = gs.deck ? gs.deck.length : (gs.deckCount || 0);
    const cap0 = gs.capturedCounts ? gs.capturedCounts[0] : (gs.capturedTeams ? gs.capturedTeams[0].length : 0);
    const cap1 = gs.capturedCounts ? gs.capturedCounts[1] : (gs.capturedTeams ? gs.capturedTeams[1].length : 0);

    // Diamond tracker
    const diamondOwnership = gs.diamondOwnership || (this.isHost ? this.getDiamondOwnership() : {});
    const diamondCards = ['ace', '2', '3', '4', '5', '6', '7', 'jack', 'queen', 'king'];
    const diamondLabels = ['A', '2', '3', '4', '5', '6', '7', 'J', 'Q', 'K'];

    let diamondHtml = '<div class="diamond-tracker">';
    for (let i = 0; i < diamondCards.length; i++) {
      const name = diamondCards[i];
      const label = diamondLabels[i];
      const owner = diamondOwnership[name];
      let cls = 'diamond-cell';
      if (owner === 0) cls += ' team1';
      else if (owner === 1) cls += ' team2';
      else cls += ' uncaptured';
      diamondHtml += `<div class="${cls}">♦${label}</div>`;
    }
    diamondHtml += '</div>';

    return `
      <div class="controls-section">
        <div class="controls-section-title">Game Status</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;">
          <div style="background:rgba(0,0,0,0.2);padding:0.5rem;border-radius:8px;text-align:center;">
            <div style="font-size:0.68rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;">Deck</div>
            <div style="font-size:1.3rem;font-weight:800;color:var(--text-primary);">${deckCount}</div>
          </div>
          <div style="background:rgba(0,0,0,0.2);padding:0.5rem;border-radius:8px;text-align:center;">
            <div style="font-size:0.68rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;">Round</div>
            <div style="font-size:1.3rem;font-weight:800;color:var(--text-primary);">${gs.roundNum + 1}/${gs.totalRounds}</div>
          </div>
        </div>
      </div>

      <div class="controls-section">
        <div class="controls-section-title">Team Scores</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;">
          <div style="background:rgba(79,195,247,0.08);padding:0.6rem;border-radius:8px;text-align:center;border:1px solid rgba(79,195,247,0.2);">
            <div style="font-size:0.68rem;color:var(--team1);text-transform:uppercase;letter-spacing:1px;">Team 1</div>
            <div style="font-size:1.5rem;font-weight:800;color:var(--team1);">${gs.scores[0]}</div>
            <div style="font-size:0.68rem;color:var(--text-dim);">Captured: ${cap0} | Shkobba: ${gs.shkobbaCount[0]}</div>
          </div>
          <div style="background:rgba(255,138,101,0.08);padding:0.6rem;border-radius:8px;text-align:center;border:1px solid rgba(255,138,101,0.2);">
            <div style="font-size:0.68rem;color:var(--team2);text-transform:uppercase;letter-spacing:1px;">Team 2</div>
            <div style="font-size:1.5rem;font-weight:800;color:var(--team2);">${gs.scores[1]}</div>
            <div style="font-size:0.68rem;color:var(--text-dim);">Captured: ${cap1} | Shkobba: ${gs.shkobbaCount[1]}</div>
          </div>
        </div>
      </div>

      <div class="controls-section">
        <div class="controls-section-title">♦ Diamond Tracker</div>
        ${diamondHtml}
        <div style="margin-top:0.4rem;font-size:0.68rem;color:var(--text-dim);display:flex;gap:1rem;justify-content:center;">
          <span><span style="color:var(--team1);">■</span> Team 1</span>
          <span><span style="color:var(--team2);">■</span> Team 2</span>
          <span><span style="opacity:0.5;">■</span> Available</span>
        </div>
      </div>
    `;
  },

  renderControlsSettings() {
    const gs = this.gameState;
    const fc = gs ? gs.forceCapture : this.forceCapture;
    const timer = gs ? (gs.turnTimerDuration || 0) : this.turnTimerDuration;

    return `
      <div class="controls-section">
        <div class="controls-section-title">Game Rules</div>
        <div class="setting-row">
          <label>Force Capture</label>
          <label class="switch">
            <input type="checkbox" ${fc ? 'checked' : ''} onchange="app.toggleForceCapture(this.checked)">
            <span class="slider"></span>
          </label>
        </div>
        <div class="setting-row">
          <label>Sound Effects</label>
          <label class="switch">
            <input type="checkbox" ${this.soundsEnabled ? 'checked' : ''} onchange="app.toggleSounds(this.checked)">
            <span class="slider"></span>
          </label>
        </div>
        <div class="setting-row">
          <label>Card Animations</label>
          <label class="switch">
            <input type="checkbox" ${this.animationsEnabled ? 'checked' : ''} onchange="app.toggleAnimations(this.checked)">
            <span class="slider"></span>
          </label>
        </div>
        <div class="setting-row">
          <label>Turn Timer</label>
          <select onchange="app.changeTurnTimer(parseInt(this.value))" style="padding:0.3rem 0.5rem;border-radius:6px;border:1px solid var(--border-subtle);background:rgba(0,0,0,0.4);color:var(--text-primary);font-family:'Inter',sans-serif;font-size:0.8rem;">
            <option value="0" ${timer === 0 ? 'selected' : ''}>Off</option>
            <option value="15" ${timer === 15 ? 'selected' : ''}>15s</option>
            <option value="30" ${timer === 30 ? 'selected' : ''}>30s</option>
            <option value="45" ${timer === 45 ? 'selected' : ''}>45s</option>
            <option value="60" ${timer === 60 ? 'selected' : ''}>60s</option>
          </select>
        </div>
      </div>

      <div class="controls-section">
        <div class="controls-section-title">Info</div>
        <div style="font-size:0.78rem;color:var(--text-secondary);line-height:1.6;">
          <p>🎴 <strong>Chkoba</strong> is a traditional Tunisian card game.</p>
          <p>🎯 Capture cards from the table whose values sum to your played card.</p>
          <p>⭐ <strong>Shkobba</strong>: Clearing the table earns a bonus point!</p>
          <p>♦ Capturing all 10 diamonds = instant win!</p>
        </div>
      </div>
    `;
  },

  renderControlsLog() {
    if (this.moveLog.length === 0) {
      return '<div style="color:var(--text-dim);padding:1rem;text-align:center;">No moves yet</div>';
    }

    let html = '<div class="move-log">';
    for (let i = this.moveLog.length - 1; i >= 0; i--) {
      const entry = this.moveLog[i];
      html += `<div class="move-log-entry">
        <span class="move-log-time">${entry.time}</span>
        <span class="move-log-text">${escapeHtml(entry.text)}</span>
      </div>`;
    }
    html += '</div>';
    return html;
  },

  renderControlsActions() {
    return `
      <div class="controls-section">
        <div class="controls-section-title">Quick Actions</div>
        <div class="quick-actions">
          <button class="btn btn-secondary" onclick="app.copyRoomLink()">
            <span class="icon">📋</span> Copy Room Link
          </button>
          <button class="btn btn-secondary" onclick="app.toggleControls()">
            <span class="icon">🎮</span> Back to Game
          </button>
          <button class="btn btn-danger" onclick="app.surrenderGame()" style="margin-top:0.5rem;">
            <span class="icon">🏳️</span> Surrender
          </button>
        </div>
      </div>
    `;
  },

  toggleForceCapture(checked) {
    if (!this.isHost || !this.gameState) {
      this.toast('Only the host can change settings');
      return;
    }
    this.gameState.forceCapture = checked;
    this.forceCapture = checked;
    this.toast('Force capture ' + (checked ? 'enabled' : 'disabled'));
    this.broadcastGameState();
  },

  changeTurnTimer(value) {
    if (!this.isHost || !this.gameState) {
      this.toast('Only the host can change settings');
      return;
    }
    this.gameState.turnTimerDuration = value;
    this.turnTimerDuration = value;
    this.toast('Turn timer ' + (value > 0 ? 'set to ' + value + 's' : 'disabled'));
    this.broadcastGameState();
    // Restart timer with new duration
    if (this.gameState.phase === 'playing' && this.gameState.currentTurn >= 0) {
      this.startTurnTimer();
    }
  },

  surrenderGame() {
    if (!this.gameState || this.gameState.phase !== 'playing') {
      this.toast('No active game');
      return;
    }
    const myTeam = this.gameState.players.find(p => p.id === this.myPlayerId)?.team;
    if (myTeam === undefined) return;

    if (confirm('Are you sure you want to surrender?')) {
      if (this.isHost) {
        const gs = this.gameState;
        gs.phase = 'finished';
        gs.winner = myTeam === 0 ? 1 : 0;
        gs.currentTurn = -1;
        gs.lastScore = null;
        this.addLogEntry(`🏳️ Team ${myTeam + 1} surrendered!`);
        this.broadcastGameState();
        this.renderGame();
        this.showScoreboard();
      } else {
        this.toast('Only the host can end the game');
      }
    }
    this.toggleControls();
  },

  // ========== DEBUG MODE ==========
  debugEnabled: false,

  toggleDebug() {
    this.debugEnabled = !this.debugEnabled;
    const panel = document.getElementById('debug-panel');
    const checkbox = document.getElementById('debug-toggle');
    panel.classList.toggle('hidden', !this.debugEnabled);
    if (checkbox) checkbox.checked = this.debugEnabled;
    if (this.debugEnabled) {
      this.updateDebugPanel();
      this.makeDebugDraggable(panel);
    }
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

    return `
      <div class="debug-section">
        <div class="debug-section-title">Turn Control</div>
        <div class="debug-controls">
          <div class="debug-controls-row">
            <select id="debug-set-turn" class="debug-select">${playerOpts}</select>
            <button class="btn-debug" onclick="app.debugSetTurn()">Set Turn</button>
          </div>
          <button class="btn-debug" onclick="app.debugSkipTurn()">⏭ Skip Turn</button>
        </div>
      </div>

      <div class="debug-section">
        <div class="debug-section-title">Score Control</div>
        <div class="debug-controls">
          <div class="debug-controls-row">
            <label style="font-size:0.72rem;color:var(--text-secondary);min-width:50px;">Team 1:</label>
            <input type="number" id="debug-score-t1" class="debug-select" value="${gs.scores[0]}" min="0" style="width:60px;">
            <label style="font-size:0.72rem;color:var(--text-secondary);min-width:50px;">Team 2:</label>
            <input type="number" id="debug-score-t2" class="debug-select" value="${gs.scores[1]}" min="0" style="width:60px;">
          </div>
          <button class="btn-debug" onclick="app.debugSetScores()">Set Scores</button>
        </div>
      </div>

      <div class="debug-section">
        <div class="debug-section-title">Game Actions</div>
        <div class="debug-controls">
          <button class="btn-debug" onclick="app.debugDealRound()">📤 Force Deal Round</button>
          <button class="btn-debug" onclick="app.debugShowWinner()">🏆 Force Win (Team 1)</button>
          <button class="btn-debug danger" onclick="app.debugShowWinner(1)">🏆 Force Win (Team 2)</button>
        </div>
      </div>

      <div class="debug-section">
        <div class="debug-section-title">State Info</div>
        <div style="font-size:0.7rem;color:var(--text-secondary);line-height:1.6;font-family:monospace;">
          <div>Phase: ${gs.phase}</div>
          <div>Current Turn: P${gs.currentTurn}</div>
          <div>Dealer: P${gs.dealerIndex}</div>
          <div>Deck: ${(gs.deck || []).length} cards</div>
          <div>Table: ${(gs.tableCards || []).length} cards</div>
          <div>Last Capture: Team ${gs.lastCaptureTeam + 1}</div>
          <div>Shkobba: [${gs.shkobbaCount.join(', ')}]</div>
          <div>Force Capture: ${gs.forceCapture}</div>
          <div>Timer: ${gs.turnTimerDuration || 'Off'}s</div>
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

  debugAddCard() {
    // Legacy compat: add to my hand
    this.debugAddCardToPlayer(this.myPlayerId);
  },

  debugRemoveCard() {
    // Legacy compat: remove last card from my hand
    const gs = this.gameState;
    if (!gs || gs.phase !== 'playing') { this.toast('No active game'); return; }
    const hand = gs.hands[this.myPlayerId];
    if (!hand || hand.length === 0) { this.toast('No cards to remove'); return; }
    hand.pop();
    this.toast('Removed last card');
    this.broadcastGameState();
    this.updateDebugPanel();
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
};

// Init on page load
document.addEventListener('DOMContentLoaded', () => app.init());
