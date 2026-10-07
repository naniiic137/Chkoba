/* The debug panel: type debug() in the browser console to open or close it.
 * Brought back from the first version (the host's debug panel), adapted to a game
 * whose referee is a room:
 *   - an offline bot game runs its room inside this page, so the panel sees and
 *     changes everything, as before: every hand, the deck, the table, scores, turns,
 *     bots, teams, undo, snapshots, "play as", freeze and spy mode.
 *   - an online game's room is on the server and this browser only ever receives its
 *     own hand. The panel shows what this browser has (own hand, table, scores, the
 *     room and seats, the connection and the last messages) and says so for the rest.
 *     Nothing here asks the server for anything the game itself does not.
 * Loaded after game.js; it adds its methods to `app`. */
(function () {
  'use strict';

  const HIDDEN = 'hidden in online games: the server holds it';
  const OFFLINE_ONLY = 'offline bot games only: online, the server is the referee';
  const dim = (text) => `<div style="color:var(--text-dim);padding:1rem;">${text}</div>`;
  const note = (text) => `<div class="debug-hidden-note">${escapeHtml(text)}</div>`;
  const cardTxt = (c) => `${c.display}${SUIT_SYMBOLS[c.suit] || ''}`;

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr;
  }

  Object.assign(app, {
    debugEnabled: false,
    debugTab: 'hands',
    _debugMinimized: false,
    _debugMsgs: [],            // the last messages to and from the room
    _stateHistory: [],         // offline: the room's state before each move, for undo
    _savedSnapshot: null,
    _dbgSeqKey: '',
    _dbgLastGs: null,
    _debugJump: false,         // the next repaint jumps without animating (a debug change)
    _gameFrozen: false,
    _controllingPlayerId: null,
    _spyMode: false,

    // The room behind an offline bot game, or null online.
    _dbgRoom() { return this._isBotGame && this.localRoom && this.localRoom.gs ? this.localRoom : null; },

    toggleDebug() {
      this.debugEnabled = !this.debugEnabled;
      this._debugMinimized = false;
      this.log('info', 'debug mode', this.debugEnabled ? 'ON (verbose logging enabled)' : 'OFF');
      const panel = document.getElementById('debug-panel');
      const pill = document.getElementById('debug-restore-pill');
      if (panel) { panel.classList.toggle('hidden', !this.debugEnabled); panel.classList.remove('minimized'); }
      if (pill) pill.classList.add('hidden');
      if (this.debugEnabled && panel) {
        this.updateDebugPanel();
        this.makeDebugDraggable(panel);
      }
      return this.debugEnabled ? 'debug panel open' : 'debug panel closed';
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
      const onMove = (e) => {
        if (!isDragging) return;
        panel.style.left = (origLeft + e.clientX - startX) + 'px';
        panel.style.top = (origTop + e.clientY - startY) + 'px';
      };
      const onUp = () => {
        isDragging = false;
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
      };
      header.addEventListener('pointerdown', (e) => {
        if (e.target.tagName === 'BUTTON') return;
        isDragging = true;
        const rect = panel.getBoundingClientRect();
        panel.style.left = rect.left + 'px';
        panel.style.top = rect.top + 'px';
        panel.style.transform = 'none';
        startX = e.clientX; startY = e.clientY; origLeft = rect.left; origTop = rect.top;
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
      });
    },

    switchDebugTab(tab) {
      this.debugTab = tab;
      document.querySelectorAll('.debug-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
      this.updateDebugPanel();
    },

    updateDebugPanel() {
      if (!this.debugEnabled) return;
      const body = document.getElementById('debug-body');
      if (!body) return;
      const mode = document.getElementById('debug-mode');
      if (mode) mode.textContent = this._dbgRoom() ? 'OFFLINE · FULL' : this.net ? 'ONLINE · THIS SEAT ONLY' : '';
      if (this.debugTab === 'net') { body.innerHTML = this.renderDebugNet(); return; }
      if (!this.gameState) { body.innerHTML = dim('No game in progress'); return; }
      switch (this.debugTab) {
        case 'hands': body.innerHTML = this.renderDebugHands(); break;
        case 'table': body.innerHTML = this.renderDebugTable(); break;
        case 'deck': body.innerHTML = this.renderDebugDeck(); break;
        case 'controls': body.innerHTML = this.renderDebugControls(); break;
      }
    },

    // ---------- tabs ----------
    renderDebugHands() {
      const gs = this.gameState;
      const room = this._dbgRoom();
      let html = '';
      for (const p of gs.players) {
        const i = p.id;
        const turnMark = gs.currentTurn === i ? '<span class="debug-turn-indicator"> ▶</span>' : '';
        const isMe = i === this.myPlayerId;
        const hand = room ? room.gs.hands[i] : isMe ? this.snap.hand : null;
        html += `<div class="debug-player-hand"><div class="debug-player-label">
          <span style="color:${isMe ? 'var(--gold)' : 'var(--text-secondary)'}">P${i} ${escapeHtml(p.name)}${isMe ? ' (you)' : ''}${turnMark}</span></div><div>`;
        if (hand) {
          html += hand.length
            ? hand.map((c, ci) => room
              ? `<span class="debug-card removable" onclick="app.debugRemoveCardFromPlayer(${i}, ${ci})" title="Click to remove">${cardTxt(c)}</span>`
              : `<span class="debug-card">${cardTxt(c)}</span>`).join('')
            : '<span style="color:var(--text-dim);font-size:0.72rem;">empty</span>';
        } else {
          const played = gs.cardsPlayedThisRound ? (gs.cardsPlayedThisRound[i] || 0) : 0;
          const n = gs.phase === 'playing' ? Math.max(0, 3 - played) : 0;
          html += `<span style="font-size:0.72rem;color:var(--text-secondary);">${n} card${n === 1 ? '' : 's'}</span> ${note(HIDDEN)}`;
        }
        html += '</div>';
        if (room) {
          html += `<div class="debug-controls-row" style="margin-top:0.35rem; display:flex; gap:0.3rem;">
            <select id="debug-card-select-${i}" class="debug-select" style="font-size:0.68rem;padding:0.2rem;max-width:130px;">${this.getCardOptionsHtml()}</select>
            <button class="btn-debug" onclick="app.debugAddCardToPlayer(${i})" style="font-size:0.68rem;padding:0.2rem 0.4rem;">+ Add</button></div>`;
        }
        html += '</div>';
      }
      return `<div class="debug-section">${html}</div>`;
    },

    renderDebugTable() {
      const gs = this.gameState;
      const room = this._dbgRoom();
      const cards = gs.tableCards || [];
      const tableHtml = cards.length
        ? cards.map((c, i) => room
          ? `<span class="debug-card removable" onclick="app.debugRemoveTableCard(${i})" title="Click to remove">${cardTxt(c)}</span>`
          : `<span class="debug-card">${cardTxt(c)}</span>`).join('')
        : '<span style="color:var(--text-dim);font-size:0.72rem;">Table is empty</span>';
      return `<div class="debug-section">
        <div class="debug-section-title">Table Cards${room ? ' (click to remove)' : ''}</div>
        <div>${tableHtml}</div>
        <div style="margin-top:0.5rem;">${room ? `<div class="debug-controls-row">
          <select id="debug-table-card-select" class="debug-select">${this.getCardOptionsHtml()}</select>
          <button class="btn-debug" onclick="app.debugAddTableCard()">Add to Table</button></div>` : note('Editing the table: ' + OFFLINE_ONLY)}</div>
      </div>`;
    },

    renderDebugDeck() {
      const gs = this.gameState;
      const room = this._dbgRoom();
      if (!room) {
        return `<div class="debug-section"><div class="debug-section-title">Deck (${gs.deckCount || 0} cards)</div>
          ${note('Deck order: ' + HIDDEN)}</div>`;
      }
      const deck = room.gs.deck || [];
      const top20 = deck.slice(-20).reverse();
      const deckHtml = top20.length ? top20.map((c) => `<span class="debug-card">${cardTxt(c)}</span>`).join('')
        : '<span style="color:var(--text-dim);font-size:0.72rem;">Deck is empty</span>';
      return `<div class="debug-section">
        <div class="debug-section-title">Deck (top ${Math.min(20, deck.length)} of ${deck.length})</div>
        <div>${deckHtml}</div>
        <div style="margin-top:0.5rem;display:flex;gap:0.3rem;">
          <button class="btn-debug" onclick="app.debugShuffleDeck()">🔀 Shuffle</button>
          <button class="btn-debug" onclick="app.debugRefillDeck()">♻ Refill Deck</button>
        </div></div>`;
    },

    stateInfoHtml() {
      const gs = this.gameState;
      const room = this._dbgRoom();
      const cap = (t) => gs.capturedCounts ? gs.capturedCounts[t] : 0;
      return `<div class="debug-section"><div class="debug-section-title">State Info</div>
        <div style="font-size:0.7rem;color:var(--text-secondary);line-height:1.6;font-family:monospace;">
          <div>Phase: ${gs.phase} | Turn: P${gs.currentTurn} | Dealer: P${gs.dealerIndex}</div>
          <div>Deck: ${gs.deckCount || 0} | Table: ${(gs.tableCards || []).length} | Round: ${gs.roundNum + 1}/${gs.totalRounds}</div>
          <div>Captured: T1=${cap(0)} T2=${cap(1)} | Last Cap: T${gs.lastCaptureTeam + 1}</div>
          <div>Shkobba: T1=${gs.shkobbaCount[0]} T2=${gs.shkobbaCount[1]} | Scores: ${gs.scores[0]}-${gs.scores[1]}</div>
          <div>Force: ${gs.forceCapture ? 'ON' : 'OFF'} | Assist: ${gs.captureAssist ? 'ON' : 'OFF'} | Timer: ${gs.turnTimerDuration || 'Off'}s | Win: ${gs.winScore}</div>
          <div>Move seq: ${gs.moveSeq} | Game: ${gs.gameToken}</div>
          ${room ? `<div>Frozen: ${this._gameFrozen ? 'YES' : 'no'} | Ctrl: ${this._controllingPlayerId !== null ? 'P' + this._controllingPlayerId : 'none'} | Spy: ${this._spyMode ? 'ON' : 'off'} | Undo: ${this._stateHistory.length}</div>` : ''}
        </div></div>`;
    },

    renderDebugControls() {
      const gs = this.gameState;
      if (!this._dbgRoom()) {
        return `${this.stateInfoHtml()}
          <div class="debug-section"><div class="debug-section-title">Host Powers</div><div class="debug-controls">
            ${this.isHost ? `<button class="btn-debug" onclick="app.toggleForceCapture(${!gs.forceCapture})">⚡ Toggle Force Capture (${gs.forceCapture ? 'ON' : 'OFF'})</button>
              <button class="btn-debug" onclick="app.toggleCaptureAssist(${!gs.captureAssist})">Toggle Capture Assist (${gs.captureAssist ? 'ON' : 'OFF'})</button>`
              : note('Only the host changes the room\'s rules (in-game menu, Settings).')}
          </div></div>
          <div class="debug-section"><div class="debug-section-title">Undo / Turn / Score / Cards / Bots / Teams / Play As / Freeze / Spy</div>
            ${note(OFFLINE_ONLY + '. Other hands and the deck: ' + HIDDEN + '.')}</div>`;
      }
      const playerOpts = gs.players.map((p) => `<option value="${p.id}">P${p.id} ${escapeHtml(p.name)}</option>`).join('');
      const room = this._dbgRoom();
      return `
      <div class="debug-section"><div class="debug-section-title">Undo / History</div><div class="debug-controls">
        <button class="btn-debug" onclick="app.debugUndo()">↩ Undo Last Move</button>
        <button class="btn-debug" onclick="app.debugRerunRound()">🔄 Rerun This Round</button>
        <button class="btn-debug" onclick="app.debugSaveState()">💾 Save Snapshot</button>
        <button class="btn-debug" onclick="app.debugLoadState()">📂 Load Snapshot</button>
      </div></div>

      <div class="debug-section"><div class="debug-section-title">Turn Control</div><div class="debug-controls">
        <div class="debug-controls-row"><select id="debug-set-turn" class="debug-select">${playerOpts}</select>
          <button class="btn-debug" onclick="app.debugSetTurn()">Set Turn</button></div>
        <button class="btn-debug" onclick="app.debugSkipTurn()">⏭ Skip Turn</button>
        <button class="btn-debug" onclick="app.debugPauseTurn()">⏸ Pause Timer</button>
      </div></div>

      <div class="debug-section"><div class="debug-section-title">Score & Chkobba</div><div class="debug-controls">
        <div class="debug-controls-row">
          <label style="font-size:0.72rem;color:var(--team1);min-width:30px;">T1:</label>
          <input type="number" id="debug-score-t1" class="debug-select" value="${gs.scores[0]}" min="0" style="width:50px;">
          <label style="font-size:0.72rem;color:var(--team2);min-width:30px;">T2:</label>
          <input type="number" id="debug-score-t2" class="debug-select" value="${gs.scores[1]}" min="0" style="width:50px;">
          <button class="btn-debug" onclick="app.debugSetScores()">Set</button></div>
        <div class="debug-controls-row">
          <label style="font-size:0.72rem;color:var(--text-secondary);min-width:65px;">Chkobba T1:</label>
          <input type="number" id="debug-shk-t1" class="debug-select" value="${gs.shkobbaCount[0]}" min="0" style="width:50px;">
          <label style="font-size:0.72rem;color:var(--text-secondary);min-width:65px;">Chkobba T2:</label>
          <input type="number" id="debug-shk-t2" class="debug-select" value="${gs.shkobbaCount[1]}" min="0" style="width:50px;">
          <button class="btn-debug" onclick="app.debugSetShkobba()">Set</button></div>
      </div></div>

      <div class="debug-section"><div class="debug-section-title">Move Cards Between Zones</div><div class="debug-controls">
        <div class="debug-controls-row"><button class="btn-debug" onclick="app.debugTableToHand()">Table → Hand</button>
          <button class="btn-debug" onclick="app.debugHandToTable()">Hand → Table</button></div>
        <div class="debug-controls-row"><button class="btn-debug" onclick="app.debugSwapHands()">🔄 Swap Hands</button>
          <button class="btn-debug" onclick="app.debugClearTable()">🗑 Clear Table</button></div>
        <div class="debug-controls-row"><button class="btn-debug" onclick="app.debugReturnCaptures(0)">Return T1 Captures</button>
          <button class="btn-debug" onclick="app.debugReturnCaptures(1)">Return T2 Captures</button></div>
      </div></div>

      <div class="debug-section"><div class="debug-section-title">Game Actions</div><div class="debug-controls">
        <button class="btn-debug" onclick="app.debugDealRound()">📤 Force Deal Round</button>
        <button class="btn-debug" onclick="app.debugForceScoring()">📊 Force Score Now</button>
        <div class="debug-controls-row" style="margin-top:0.3rem;"><button class="btn-debug" onclick="app.debugShowWinner()">🏆 Win T1</button>
          <button class="btn-debug danger" onclick="app.debugShowWinner(1)">🏆 Win T2</button></div>
        <div class="debug-controls-row" style="margin-top:0.3rem;"><button class="btn-debug" onclick="app.debugToggleForceCapture()">⚡ Toggle Force Capture (${gs.forceCapture ? 'ON' : 'OFF'})</button></div>
        <div class="debug-controls-row" style="margin-top:0.3rem;"><button class="btn-debug" onclick="app.debugResetGame()">🔥 Full Reset (Keep Players)</button></div>
      </div></div>

      <div class="debug-section"><div class="debug-section-title">Bot Management</div><div class="debug-controls">
        ${gs.players.map((p) => {
          if (p.id === this.myPlayerId) return '';
          if (room.seats[p.id] && room.seats[p.id].bot) {
            return `<div class="debug-controls-row" style="align-items:center;">
              <span style="font-size:0.72rem;color:var(--text-secondary);">P${p.id} ${escapeHtml(p.name)}</span>
              <span class="bot-badge" style="margin-left:0.3rem;">BOT</span>
              <button class="btn-debug danger" onclick="app.debugRemoveBot(${p.id})" style="margin-left:auto;">Remove Bot</button></div>`;
          }
          return `<div class="debug-controls-row" style="align-items:center;">
            <span style="font-size:0.72rem;color:var(--text-secondary);">P${p.id} ${escapeHtml(p.name)}</span>
            <select id="debug-bot-diff-${p.id}" class="debug-select" style="font-size:0.68rem;padding:0.2rem;width:70px;margin-left:auto;">
              <option value="easy">Easy</option><option value="medium" selected>Medium</option><option value="hard">Hard</option></select>
            <button class="btn-debug" onclick="app.debugAddBot(${p.id})">+ Bot</button></div>`;
        }).join('')}
      </div></div>

      <div class="debug-section"><div class="debug-section-title">Team Control</div><div class="debug-controls">
        ${gs.players.map((p) => `<div class="debug-controls-row" style="align-items:center;">
          <span style="font-size:0.72rem;color:var(--team${p.team + 1});">P${p.id} ${escapeHtml(p.name)} — T${p.team + 1}</span>
          <button class="btn-debug" onclick="app.debugSwapTeam(${p.id})" style="margin-left:auto;font-size:0.68rem;">Move to T${(p.team === 0 ? 1 : 0) + 1}</button></div>`).join('')}
      </div></div>

      <div class="debug-section"><div class="debug-section-title">Player Control</div><div class="debug-controls">
        ${this._controllingPlayerId !== null
          ? `<div class="debug-controls-row" style="align-items:center;">
              <span style="font-size:0.72rem;color:var(--gold);">Controlling P${this._controllingPlayerId} ${escapeHtml((gs.players[this._controllingPlayerId] || {}).name || '?')}</span>
              <button class="btn-debug danger" onclick="app.debugReleasePossess()" style="margin-left:auto;">Release</button></div>`
          : gs.players.filter((p) => p.id !== this.myPlayerId).map((p) => `<div class="debug-controls-row" style="align-items:center;">
              <span style="font-size:0.72rem;color:var(--text-secondary);">P${p.id} ${escapeHtml(p.name)}</span>
              <button class="btn-debug" onclick="app.debugPossessPlayer(${p.id})" style="margin-left:auto;font-size:0.68rem;">Play As</button></div>`).join('')}
      </div></div>

      <div class="debug-section"><div class="debug-section-title">Host Powers</div><div class="debug-controls">
        <button class="btn-debug ${this._gameFrozen ? 'danger' : ''}" onclick="app.debugToggleFreeze()">${this._gameFrozen ? '▶ Unfreeze Game' : '❄ Freeze Game'}</button>
        <button class="btn-debug ${this._spyMode ? 'danger' : ''}" onclick="app.debugToggleSpy()">${this._spyMode ? '🔒 Hide Hands' : '👁 Spy Mode (See All Hands)'}</button>
        <div class="debug-controls-row">
          <label style="font-size:0.72rem;color:var(--text-secondary);min-width:70px;">Win Score:</label>
          <input type="number" id="debug-win-score" class="debug-select" value="${gs.winScore}" min="1" style="width:60px;">
          <button class="btn-debug" onclick="app.debugSetWinScore()">Set</button></div>
      </div></div>

      ${this.stateInfoHtml()}`;
    },

    // Room, seats, connection and the last messages: everything this browser knows.
    renderDebugNet() {
      const s = this.snap;
      const rows = [];
      const row = (k, v) => rows.push(`<div>${k}: ${v}</div>`);
      row('Mode', this._isBotGame ? 'offline bot game (the room runs in this page)' : this.net ? 'online (the room runs on the server)' : 'no room');
      row('Room', escapeHtml(this.roomCode || '-'));
      row('You', s ? `P${s.you} ${escapeHtml(this.myName)}` : '-');
      row('Host', s ? `P${s.owner}${this.isHost ? ' (you)' : ''}` : '-');
      row('Connection', this.net ? this.net.status : 'none');
      if (this.net && !this._isBotGame) row('Server', escapeHtml(this.wsUrl(this.roomCode)));
      row('Snapshot rev', s ? s.rev : '-');
      if (this.gameState) row('Game / move seq', `${this.gameState.gameToken} / ${this.gameState.moveSeq}`);
      row('Seat token', this.seatToken ? this.seatToken.slice(0, 6) + '… (this seat only)' : '-');
      const seats = s ? s.seats.map((x, i) => {
        if (!x) return `<div>P${i}: empty</div>`;
        const st = x.bot ? 'bot' : x.takeover ? 'bot plays for them' : x.connected ? 'connected' : x.away ? (x.away.left ? 'left' : x.away.expired ? 'gone (hold over)' : `reconnecting, ${Math.ceil(x.away.holdLeft / 1000)}s hold`) : 'away';
        return `<div>P${i} ${escapeHtml(x.name)}: ${st}</div>`;
      }).join('') : '';
      const msgs = this._debugMsgs.slice(-30).reverse().map((m) => {
        const t = new Date(m.ts).toLocaleTimeString([], { hour12: false });
        return `<div class="${m.dir === '←' ? 'in' : ''}">${t} ${m.dir} ${escapeHtml(m.text)}</div>`;
      }).join('') || '<div>none yet</div>';
      return `<div class="debug-section"><div class="debug-section-title">Room / Seat / Connection</div>
          <div style="font-size:0.7rem;color:var(--text-secondary);line-height:1.6;font-family:monospace;">${rows.join('')}</div></div>
        <div class="debug-section"><div class="debug-section-title">Seats</div>
          <div style="font-size:0.7rem;color:var(--text-secondary);line-height:1.6;font-family:monospace;">${seats || 'none'}</div></div>
        <div class="debug-section"><div class="debug-section-title">Recent Messages (→ sent, ← received)</div>
          <div class="debug-log">${msgs}</div></div>`;
    },

    getCardOptionsHtml() {
      return ChkobaRoom.createDeck().map((c, i) => `<option value="${i}">${cardTxt(c)} of ${c.suit}</option>`).join('');
    },

    // ---------- the message log (both modes) ----------
    _debugNote(dir, text) {
      this._debugMsgs.push({ ts: Date.now(), dir, text });
      if (this._debugMsgs.length > 60) this._debugMsgs.shift();
      if (this.debugEnabled && this.debugTab === 'net') this.updateDebugPanel();
    },

    // Called by bindNet: notes every message to and from the room.
    debugWatchNet(net) {
      ['state', 'notice', 'emote', 'status', 'timeout', 'fatal'].forEach((t) => net.on(t, (m) => {
        if (this.net !== net) return;
        let text = t;
        if (t === 'state' && m && m.s) text += ` rev ${m.s.rev}${m.s.game ? ` ${m.s.game.phase} seq ${m.s.game.moveSeq} turn P${m.s.game.currentTurn}` : ' lobby'}`;
        else if (t === 'notice' || t === 'emote') text += ': ' + (m.text || '');
        else if (typeof m === 'string') text += ': ' + m;
        this._debugNote('←', text);
      }));
      const emit = net.emit;
      net.emit = (type, data, ...rest) => {
        this._debugNote('→', type + (type === 'move' && data ? ` card ${data.cardId} take [${(data.captureCardIds || []).join(',')}] seq ${data.seq}` : ''));
        return emit(type, data, ...rest).then((ack) => {
          this._debugNote('←', `ack ${type}: ${ack.ok ? 'ok' : ack.error + (ack.reason ? ' ' + ack.reason : '')}`);
          return ack;
        }, (e) => { this._debugNote('←', `${type} failed: ${e.message}`); throw e; });
      };
    },

    // ---------- offline: hooks into the in-page room ----------
    // Freeze stops the bots and the turn timer; "play as" keeps the bot off the seat
    // being played. Only ever applied to the room of an offline game.
    debugWrapRoom(room) {
      const orig = room._arm;
      room._arm = function (delay) {
        if (app.localRoom !== this) return orig.call(this, delay);
        const gs = this.gs;
        if (app._gameFrozen) { this._clearTimer('turn'); return; }
        const ctl = app._controllingPlayerId;
        if (ctl !== null && gs && gs.phase === 'playing' && gs.currentTurn === ctl) {
          this._clearTimer('turn');
          this.turnStartedAt = this.now() + (delay || 0);
          const seq = gs.moveSeq;
          if (gs.turnTimerDuration > 0) this._setTimer('turn', (delay || 0) + gs.turnTimerDuration * 1000, () => { if (this.gs === gs && gs.moveSeq === seq && gs.currentTurn === ctl) this._autoPlay(ctl); });
          return;
        }
        return orig.call(this, delay);
      };
    },

    // Every change of an offline room: keep the state before each move for undo.
    debugRecord(room) {
      if (room !== this.localRoom || !room.gs) return;
      const key = room.gs.gameToken + ':' + room.gs.moveSeq;
      if (key !== this._dbgSeqKey) {
        const sameGame = this._dbgSeqKey.split(':')[0] === String(room.gs.gameToken);
        if (this._dbgLastGs && sameGame && room.gs.moveSeq > +this._dbgSeqKey.split(':')[1]) {
          this._stateHistory.push(this._dbgLastGs);
          if (this._stateHistory.length > 50) this._stateHistory.shift();
        }
        this._dbgSeqKey = key;
      }
      this._dbgLastGs = JSON.stringify(room.gs);
    },

    debugReset() {
      this._stateHistory = []; this._dbgSeqKey = ''; this._dbgLastGs = null;
      this._controllingPlayerId = null; this._gameFrozen = false; this._spyMode = false;
    },

    // The hand shown at the bottom: my own, or the seat being played from the panel.
    debugHand(hand) {
      const room = this._dbgRoom();
      if (room && this._controllingPlayerId !== null) return (room.gs.hands[this._controllingPlayerId] || []).map((c) => ({ ...c }));
      return hand;
    },

    // A move made while playing as another seat goes straight to the in-page room.
    debugPlayAs(cardId, captureIds) {
      const room = this._dbgRoom();
      if (!room) return { ok: false, error: 'phase' };
      const r = room._play(this._controllingPlayerId, cardId, captureIds) || {};
      return r.error ? { ok: false, ...r } : { ok: true };
    },

    // Applies a change to the offline room: everyone (this page) gets a fresh snapshot.
    _dbgCommit(room, rearm) {
      this._debugJump = true;
      if (rearm) room._arm(0);
      room._commit();
      this.updateDebugPanel();
    },
    _dbgGuard() {
      const room = this._dbgRoom();
      if (!room) { this.toast('Debug: ' + OFFLINE_ONLY); return null; }
      return room;
    },

    // ---------- offline actions (the first version's panel) ----------
    _makeDebugCard(deckIndex) {
      const card = ChkobaRoom.createDeck()[deckIndex];
      card.id = 1000 + Date.now() % 10000 + Math.floor(Math.random() * 1000);
      return card;
    },

    debugAddCardToPlayer(playerIndex) {
      const room = this._dbgGuard(); if (!room) return;
      const sel = document.getElementById(`debug-card-select-${playerIndex}`);
      if (!sel) return;
      const idx = parseInt(sel.value, 10);
      if (isNaN(idx) || idx < 0 || idx >= 40) { this.toast('Invalid card index'); return; }
      const card = this._makeDebugCard(idx);
      room.gs.hands[playerIndex].push(card);
      this.toast(`Added ${card.display} of ${card.suit} to P${playerIndex}`);
      this._dbgCommit(room);
    },

    debugRemoveCardFromPlayer(playerIndex, cardIndex) {
      const room = this._dbgGuard(); if (!room) return;
      const hand = room.gs.hands[playerIndex];
      if (!hand || cardIndex >= hand.length) return;
      const removed = hand.splice(cardIndex, 1)[0];
      this.toast(`Removed ${removed.display} of ${removed.suit} from P${playerIndex}`);
      this._dbgCommit(room);
    },

    debugAddTableCard() {
      const room = this._dbgGuard(); if (!room) return;
      const sel = document.getElementById('debug-table-card-select');
      if (!sel) return;
      const card = this._makeDebugCard(parseInt(sel.value, 10));
      room.gs.tableCards.push(card);
      this.toast(`Added ${card.display} of ${card.suit} to table`);
      this._dbgCommit(room);
    },

    debugRemoveTableCard(index) {
      const room = this._dbgGuard(); if (!room) return;
      if (index >= room.gs.tableCards.length) return;
      const removed = room.gs.tableCards.splice(index, 1)[0];
      this.toast(`Removed ${removed.display} of ${removed.suit} from table`);
      this._dbgCommit(room);
    },

    debugShuffleDeck() {
      const room = this._dbgGuard(); if (!room) return;
      shuffle(room.gs.deck);
      this.toast('Deck shuffled!');
      this._dbgCommit(room);
    },

    debugRefillDeck() {
      const room = this._dbgGuard(); if (!room) return;
      room.gs.deck = shuffle(ChkobaRoom.createDeck());
      this.toast('Deck refilled with 40 cards!');
      this._dbgCommit(room);
    },

    debugSetTurn() {
      const room = this._dbgGuard(); if (!room) return;
      const sel = document.getElementById('debug-set-turn');
      if (!sel) return;
      room.gs.currentTurn = parseInt(sel.value, 10);
      room.gs.shkobbaThisTurn = false;
      this.toast('Turn set to P' + room.gs.currentTurn);
      this._dbgCommit(room, true);
    },

    debugSetScores() {
      const room = this._dbgGuard(); if (!room) return;
      const s1 = parseInt(document.getElementById('debug-score-t1')?.value || 0, 10);
      const s2 = parseInt(document.getElementById('debug-score-t2')?.value || 0, 10);
      room.gs.scores[0] = isNaN(s1) ? 0 : s1;
      room.gs.scores[1] = isNaN(s2) ? 0 : s2;
      this.toast(`Scores set: Team 1 = ${room.gs.scores[0]}, Team 2 = ${room.gs.scores[1]}`);
      this._dbgCommit(room);
    },

    debugSkipTurn() {
      const room = this._dbgGuard(); if (!room) return;
      if (room.gs.phase !== 'playing') { this.toast('No active game'); return; }
      this._debugJump = true;
      room._nextTurn(0);
      this.updateDebugPanel();
    },

    debugDealRound() {
      const room = this._dbgGuard(); if (!room) return;
      const gs = room.gs;
      gs.deck = shuffle(ChkobaRoom.createDeck());
      gs.tableCards = [];
      gs.roundNum = 0;
      gs.phase = 'playing';
      this._debugJump = true;
      room._dealRound();
      this.updateDebugPanel();
    },

    debugShowWinner(team = 0) {
      const room = this._dbgGuard(); if (!room) return;
      const gs = room.gs;
      gs.scores[team] = gs.winScore;
      gs.winner = team;
      gs.phase = 'finished';
      gs.endReason = 'score';
      gs.currentTurn = -1;
      gs.lastScore = null;
      room._clearTimer('turn');
      this._dbgCommit(room);
    },

    debugUndo() {
      const room = this._dbgGuard(); if (!room) return;
      if (this._stateHistory.length === 0) { this.toast('Nothing to undo'); return; }
      const prev = this._stateHistory.pop();
      room.gs = JSON.parse(prev);
      this._dbgSeqKey = room.gs.gameToken + ':' + room.gs.moveSeq;
      this._dbgLastGs = prev;
      this.toast('Undid last move');
      this._dbgCommit(room, true);
    },

    debugRerunRound() {
      const room = this._dbgGuard(); if (!room) return;
      const gs = room.gs;
      gs.capturedTeams = [[], []];
      gs.shkobbaCount = [0, 0];
      gs.lastCaptureTeam = -1;
      gs.lastMove = null;
      gs.lastScore = null;
      gs.tableCards = [];
      gs.roundNum = 0;
      gs.deck = shuffle(ChkobaRoom.createDeck());
      gs.phase = 'playing';
      gs.winner = -1; gs.endReason = null;
      delete gs.nextDealerTurn;
      this._debugJump = true;
      room._dealRound();
      this.toast('Round restarted!');
      this.updateDebugPanel();
    },

    debugSaveState() {
      const room = this._dbgGuard(); if (!room) return;
      this._savedSnapshot = JSON.stringify(room.gs);
      this.toast('Snapshot saved!');
    },

    debugLoadState() {
      const room = this._dbgGuard(); if (!room) return;
      if (!this._savedSnapshot) { this.toast('No snapshot saved'); return; }
      room.gs = JSON.parse(this._savedSnapshot);
      this._dbgSeqKey = room.gs.gameToken + ':' + room.gs.moveSeq;
      this._dbgLastGs = this._savedSnapshot;
      this._ceremonyKey = ''; this._matchKey = '';
      this.toast('Snapshot loaded!');
      this._dbgCommit(room, true);
    },

    debugPauseTurn() {
      const room = this._dbgGuard(); if (!room) return;
      room._clearTimer('turn');
      this.stopTurnTimer();
      this.toast('Timer paused');
    },

    debugSetShkobba() {
      const room = this._dbgGuard(); if (!room) return;
      const s1 = parseInt(document.getElementById('debug-shk-t1')?.value || 0, 10);
      const s2 = parseInt(document.getElementById('debug-shk-t2')?.value || 0, 10);
      room.gs.shkobbaCount[0] = isNaN(s1) ? 0 : s1;
      room.gs.shkobbaCount[1] = isNaN(s2) ? 0 : s2;
      this.toast(`Shkobba set: T1=${room.gs.shkobbaCount[0]}, T2=${room.gs.shkobbaCount[1]}`);
      this._dbgCommit(room);
    },

    debugTableToHand() {
      const room = this._dbgGuard(); if (!room) return;
      const gs = room.gs;
      if (gs.tableCards.length === 0) { this.toast('Table is empty'); return; }
      const card = gs.tableCards.pop();
      const pid = gs.currentTurn >= 0 ? gs.currentTurn : 0;
      gs.hands[pid].push(card);
      this.toast(`Moved ${card.display} from table to P${pid}'s hand`);
      this._dbgCommit(room);
    },

    debugHandToTable() {
      const room = this._dbgGuard(); if (!room) return;
      const gs = room.gs;
      const pid = gs.currentTurn >= 0 ? gs.currentTurn : 0;
      const hand = gs.hands[pid];
      if (!hand || hand.length === 0) { this.toast('Hand is empty'); return; }
      const card = hand.pop();
      gs.tableCards.push(card);
      this.toast(`Moved ${card.display} from P${pid}'s hand to table`);
      this._dbgCommit(room);
    },

    debugSwapHands() {
      const room = this._dbgGuard(); if (!room) return;
      const gs = room.gs;
      if (gs.numPlayers < 2) return;
      [gs.hands[0], gs.hands[1]] = [gs.hands[1], gs.hands[0]];
      this.toast('Hands swapped between P0 and P1');
      this._dbgCommit(room);
    },

    debugClearTable() {
      const room = this._dbgGuard(); if (!room) return;
      const count = room.gs.tableCards.length;
      room.gs.tableCards = [];
      this.toast(`Cleared ${count} cards from table`);
      this._dbgCommit(room);
    },

    debugReturnCaptures(teamIndex) {
      const room = this._dbgGuard(); if (!room) return;
      const gs = room.gs;
      const cards = gs.capturedTeams[teamIndex];
      if (!cards || cards.length === 0) { this.toast('No captures to return'); return; }
      gs.deck.push(...cards);
      shuffle(gs.deck);
      gs.capturedTeams[teamIndex] = [];
      this.toast(`Returned ${cards.length} cards from T${teamIndex + 1} captures to deck`);
      this._dbgCommit(room);
    },

    debugForceScoring() {
      const room = this._dbgGuard(); if (!room) return;
      const gs = room.gs;
      if (gs.tableCards.length > 0 && gs.lastCaptureTeam >= 0) {
        gs.capturedTeams[gs.lastCaptureTeam].push(...gs.tableCards);
        gs.tableCards = [];
      }
      this._debugJump = true;
      room._clearTimer('turn');
      room._scoreRound();
      this.toast('Forced scoring!');
      this.updateDebugPanel();
    },

    debugToggleForceCapture() {
      const room = this._dbgGuard(); if (!room) return;
      room.gs.forceCapture = !room.gs.forceCapture;
      room.opts.forceCapture = room.gs.forceCapture;
      this.toast('Force capture ' + (room.gs.forceCapture ? 'ON' : 'OFF'));
      this._dbgCommit(room);
    },

    debugAddBot(playerId) {
      const room = this._dbgGuard(); if (!room) return;
      if (playerId === this.myPlayerId) { this.toast("Can't replace the host"); return; }
      const seat = room.seats[playerId];
      if (!seat || seat.bot) { this.toast('Already a bot'); return; }
      const sel = document.getElementById('debug-bot-diff-' + playerId);
      const diff = sel ? sel.value : 'medium';
      seat.bot = diff;
      seat.name = ChkobaRoom.BOT_NAMES[diff] || 'Bot';
      room.gs.players[playerId].name = seat.name;
      this.toast('P' + playerId + ' replaced with bot');
      this._dbgCommit(room, room.gs.currentTurn === playerId);
    },

    debugRemoveBot(playerId) {
      const room = this._dbgGuard(); if (!room) return;
      const seat = room.seats[playerId];
      if (!seat || !seat.bot) { this.toast('Not a bot'); return; }
      seat.bot = null;
      this.toast('P' + playerId + ' is no longer a bot (timer will auto-play)');
      this._dbgCommit(room, true);
    },

    debugResetGame() {
      const room = this._dbgGuard(); if (!room) return;
      this._stateHistory = []; this._dbgSeqKey = ''; this._dbgLastGs = null;
      this._controllingPlayerId = null;
      this._gameFrozen = false;
      this._spyMode = false;
      room._startGame();
      this.toast('Game fully reset!');
      this.updateDebugPanel();
    },

    debugSwapTeam(playerId) {
      const room = this._dbgGuard(); if (!room) return;
      const p = room.gs.players[playerId];
      if (!p) return;
      const oldTeam = p.team;
      p.team = oldTeam === 0 ? 1 : 0;
      this.toast(`${p.name} moved from T${oldTeam + 1} to T${p.team + 1}`);
      this._dbgCommit(room);
    },

    debugPossessPlayer(playerId) {
      const room = this._dbgGuard(); if (!room) return;
      if (playerId === this.myPlayerId) { this.toast('Already your hand'); return; }
      this._controllingPlayerId = playerId;
      this.cancelSelection(false);
      this.toast(`Now controlling P${playerId} ${(room.gs.players[playerId] || {}).name || ''}`);
      this._dbgCommit(room, true);
    },

    debugReleasePossess() {
      const room = this._dbgGuard(); if (!room) return;
      this._controllingPlayerId = null;
      this.cancelSelection(false);
      this.toast('Released control');
      this._dbgCommit(room, true);
    },

    debugToggleFreeze() {
      const room = this._dbgGuard(); if (!room) return;
      this._gameFrozen = !this._gameFrozen;
      if (this._gameFrozen) { room._clearTimer('turn'); this.stopTurnTimer(); }
      this.toast(this._gameFrozen ? 'Game FROZEN — all players paused' : 'Game UNFROZEN — resuming');
      this._dbgCommit(room, !this._gameFrozen);
    },

    debugToggleSpy() {
      const room = this._dbgGuard(); if (!room) return;
      this._spyMode = !this._spyMode;
      this.toast(this._spyMode ? 'Spy Mode ON — seeing all hands' : 'Spy Mode OFF');
      this.renderGame();
      this.updateDebugPanel();
    },

    debugSetWinScore() {
      const room = this._dbgGuard(); if (!room) return;
      const val = parseInt(document.getElementById('debug-win-score')?.value || 21, 10);
      if (isNaN(val) || val < 1) { this.toast('Invalid score'); return; }
      room.gs.winScore = val;
      room.opts.winScore = val;
      this.toast(`Win score set to ${val}`);
      this._dbgCommit(room);
    },

    // The banner above the hand while playing as another seat.
    renderBanners(gs) {
      let banner = document.getElementById('possess-banner');
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'possess-banner';
        banner.style.display = 'none';
        document.getElementById('hand-area').prepend(banner);
      }
      if (this._dbgRoom() && this._controllingPlayerId !== null && gs.players) {
        const cp = gs.players[this._controllingPlayerId];
        banner.innerHTML = `<span class="possess-label">CONTROLLING: P${this._controllingPlayerId} ${escapeHtml(cp ? cp.name : '?')} (T${cp ? cp.team + 1 : '?'})</span><button class="btn-debug" onclick="app.debugReleasePossess()" style="padding:0.2rem 0.6rem;font-size:0.68rem;">Release</button>`;
        banner.style.display = '';
      } else {
        banner.style.display = 'none';
      }
    },

    // Spy mode: another seat's hand under its name. Offline only: online this browser
    // does not have it.
    debugSpyHand(playerId) {
      const room = this._dbgRoom();
      if (!this._spyMode || !room) return null;
      const hand = room.gs.hands[playerId];
      return hand && hand.length ? hand : null;
    },
  });

  // typed in the console
  window.debug = () => app.toggleDebug();
})();
