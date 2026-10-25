/* The debug panel: type debug() in the browser console to open or close it.
 * Brought back from the first version (the host's debug panel). The referee does the
 * work: every button sends one 'debug' message to the room (js/room.js, DEBUG_OPS),
 * so the offline game and an online game run the very same code.
 *   - offline (bot game): the room runs in this page and opens the panel to its
 *     player: every hand, the deck and every control.
 *   - online: the host gets the full panel, as in the first version (the server
 *     sends the host's connection every hand and the deck). Anyone else sees what
 *     their browser has: their own hand, the table, the state, room, seats,
 *     connection, messages; they never receive another hand or the deck.
 * Loaded after game.js; it adds its methods to `app`. */
(function () {
  'use strict';

  const HIDDEN = 'hidden in online games: the server holds it';
  const dim = (text) => `<div style="color:var(--text-dim);padding:1rem;">${text}</div>`;
  const note = (text) => `<div class="debug-hidden-note">${escapeHtml(text)}</div>`;
  const cardTxt = (c) => `${c.display}${SUIT_SYMBOLS[c.suit] || ''}`;
  const chip = (c) => `${c.display}<span class="suit ${c.suit}">${SUIT_SYMBOLS[c.suit] || ''}</span>`;
  const val = (id, d) => { const el = document.getElementById(id); return el ? el.value : d; };

  Object.assign(app, {
    debugEnabled: false,
    debugTab: 'hands',
    _debugMinimized: false,
    _debugMsgs: [],            // the last messages to and from the room
    _debugUnlocked: false,     // this connection is a debug connection (sent again on reconnect)
    _spyMode: false,
    _lastDebugRev: 0,

    // The full view the room sends a debug connection, or null.
    _dbg() { return this.snap && this.snap.debug ? this.snap.debug : null; },
    // The seat played with "Play As", or null.
    debugCtl() { const d = this._dbg(); return d && d.ctl !== null && d.ctl !== undefined ? d.ctl : null; },

    // debug() toggles the panel.
    toggleDebug() {
      // Only the host gets the debug menu (or the player in a bot game), on any device, any time.
      if (!this.debugEnabled && !this.mayDebug()) { this.log('info', 'debug menu: host only'); return 'only the host can use the debug menu'; }
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
        // the full view: offline, or online for the host
        if (!this._dbg() && (this._isBotGame || this.isHost)) this.debugUnlock(true);
      }
      return this.debugEnabled ? 'debug panel open' : 'debug panel closed';
    },

    // Who may open the menu: the host of an online room, or anyone in a bot game or on the menu.
    mayDebug() {
      const online = !!this.roomCode && !this._isBotGame;
      return !online || !!this.isHost;
    },

    // Makes this connection a debug connection (the room allows the host only).
    async debugUnlock(quiet) {
      if (!this.net) { if (!quiet) this.toast('No game'); return false; }
      let ack;
      try { ack = await this.net.emit('debug', { op: 'unlock' }); } catch (e) { if (!quiet) this.toast('Not connected, try again in a moment'); return false; }
      if (ack.ok) this._debugUnlocked = true;
      else if (!quiet) this.toast('Debug is host-only');
      this.updateDebugPanel();
      return !!ack.ok;
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
      if (mode) mode.textContent = !this.net ? '' : this._isBotGame ? 'OFFLINE · FULL' : this._dbg() ? 'ONLINE · HOST · FULL' : 'ONLINE · THIS SEAT ONLY';
      if (this.debugTab === 'net') { body.innerHTML = this.renderDebugNet(); return; }
      if (!this.gameState) { body.innerHTML = dim('No game in progress'); return; }
      const html = { hands: () => this.renderDebugHands(), table: () => this.renderDebugTable(), deck: () => this.renderDebugDeck(), controls: () => this.renderDebugControls() }[this.debugTab];
      body.innerHTML = html ? html() : '';
    },

    // ---------- tabs ----------
    renderDebugHands() {
      const gs = this.gameState;
      const D = this._dbg();
      let html = '';
      for (const p of gs.players) {
        const i = p.id;
        const turnMark = gs.currentTurn === i ? '<span class="debug-turn-indicator"> ▶</span>' : '';
        const isMe = i === this.myPlayerId;
        const hand = D ? D.hands[i] : isMe ? this.snap.hand : null;
        html += `<div class="debug-player-hand"><div class="debug-player-label">
          <span style="color:${isMe ? 'var(--gold)' : 'var(--text-secondary)'}">P${i} ${escapeHtml(p.name)}${isMe ? ' (you)' : ''}${turnMark}</span></div><div>`;
        if (hand) {
          html += hand.length
            ? hand.map((c, ci) => D
              ? `<span class="debug-card removable" onclick="app.debugRemoveCardFromPlayer(${i}, ${ci})" title="Click to remove">${chip(c)}</span>`
              : `<span class="debug-card">${chip(c)}</span>`).join('')
            : '<span style="color:var(--text-dim);">empty</span>';
        } else {
          const played = gs.cardsPlayedThisRound ? (gs.cardsPlayedThisRound[i] || 0) : 0;
          const n = gs.phase === 'playing' ? Math.max(0, 3 - played) : 0;
          html += `<span style="color:var(--text-secondary);">${n} card${n === 1 ? '' : 's'}</span> ${note(HIDDEN)}`;
        }
        html += '</div>';
        if (D) {
          html += `<div class="debug-controls-row" style="margin-top:0.35rem; display:flex; gap:0.3rem;">
            <select id="debug-card-select-${i}" class="debug-select" style="max-width:130px;">${this.getCardOptionsHtml()}</select>
            <button class="btn-debug" onclick="app.debugAddCardToPlayer(${i})">+ Add</button></div>`;
        }
        html += '</div>';
      }
      return `<div class="debug-section">${html}</div>`;
    },

    renderDebugTable() {
      const gs = this.gameState;
      const D = this._dbg();
      const cards = gs.tableCards || [];
      const tableHtml = cards.length
        ? cards.map((c, i) => D
          ? `<span class="debug-card removable" onclick="app.debugRemoveTableCard(${i})" title="Click to remove">${chip(c)}</span>`
          : `<span class="debug-card">${chip(c)}</span>`).join('')
        : '<span style="color:var(--text-dim);">Table is empty</span>';
      return `<div class="debug-section">
        <div class="debug-section-title">Table Cards${D ? ' (click to remove)' : ''}</div>
        <div>${tableHtml}</div>
        <div style="margin-top:0.5rem;">${D ? `<div class="debug-controls-row">
          <select id="debug-table-card-select" class="debug-select">${this.getCardOptionsHtml()}</select>
          <button class="btn-debug" onclick="app.debugAddTableCard()">Add to Table</button></div>` : note('Editing the table: host only.')}</div>
      </div>`;
    },

    renderDebugDeck() {
      const gs = this.gameState;
      const D = this._dbg();
      if (!D) {
        return `<div class="debug-section"><div class="debug-section-title">Deck (${gs.deckCount || 0} cards)</div>
          ${note('Deck order: ' + HIDDEN)}</div>`;
      }
      const deck = D.deck || [];
      const top20 = deck.slice(-20).reverse();
      const deckHtml = top20.length ? top20.map((c) => `<span class="debug-card">${chip(c)}</span>`).join('')
        : '<span style="color:var(--text-dim);">Deck is empty</span>';
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
      const D = this._dbg();
      const cap = (t) => gs.capturedCounts ? gs.capturedCounts[t] : 0;
      const ctl = this.debugCtl();
      return `<div class="debug-section"><div class="debug-section-title">State Info</div>
        <div style="color:var(--text-secondary);line-height:1.6;font-family:monospace;">
          <div>Phase: ${gs.phase} | Turn: P${gs.currentTurn} | Dealer: P${gs.dealerIndex}</div>
          <div>Deck: ${gs.deckCount || 0} | Table: ${(gs.tableCards || []).length} | Round: ${gs.roundNum + 1}/${gs.totalRounds}</div>
          <div>Captured: T1=${cap(0)} T2=${cap(1)} | Last Cap: T${gs.lastCaptureTeam + 1}</div>
          <div>Shkobba: T1=${gs.shkobbaCount[0]} T2=${gs.shkobbaCount[1]} | Scores: ${gs.scores[0]}-${gs.scores[1]}</div>
          <div>Force: ${gs.forceCapture ? 'ON' : 'OFF'} | Assist: ${gs.captureAssist ? 'ON' : 'OFF'} | Timer: ${gs.turnTimerDuration || 'Off'}s | Win: ${gs.winScore}</div>
          <div>Move seq: ${gs.moveSeq} | Game: ${gs.gameToken}</div>
          <div>Frozen: ${gs.frozen ? 'YES' : 'no'}${D ? ` | Ctrl: ${ctl !== null ? 'P' + ctl : 'none'} | Spy: ${this._spyMode ? 'ON' : 'off'} | Undo: ${D.history}` : ''}</div>
        </div></div>`;
    },

    renderDebugControls() {
      const gs = this.gameState;
      const D = this._dbg();
      if (!D) {
        return `${this.stateInfoHtml()}
          <div class="debug-section"><div class="debug-section-title">Undo / Turn / Score / Cards / Bots / Teams / Play As / Freeze / Spy</div>
            ${note('Host only. Other hands and the deck: ' + HIDDEN + '.')}</div>`;
      }
      const playerOpts = gs.players.map((p) => `<option value="${p.id}">P${p.id} ${escapeHtml(p.name)}</option>`).join('');
      const ctl = this.debugCtl();
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
          <label style="color:var(--team1);min-width:30px;">T1:</label>
          <input type="number" id="debug-score-t1" class="debug-select" value="${gs.scores[0]}" min="0" style="width:50px;">
          <label style="color:var(--team2);min-width:30px;">T2:</label>
          <input type="number" id="debug-score-t2" class="debug-select" value="${gs.scores[1]}" min="0" style="width:50px;">
          <button class="btn-debug" onclick="app.debugSetScores()">Set</button></div>
        <div class="debug-controls-row">
          <label style="color:var(--text-secondary);min-width:65px;">Chkobba T1:</label>
          <input type="number" id="debug-shk-t1" class="debug-select" value="${gs.shkobbaCount[0]}" min="0" style="width:50px;">
          <label style="color:var(--text-secondary);min-width:65px;">Chkobba T2:</label>
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
          if (D.bots[p.id]) {
            return `<div class="debug-controls-row" style="align-items:center;">
              <span style="color:var(--text-secondary);">P${p.id} ${escapeHtml(p.name)}</span>
              <span class="bot-badge" style="margin-left:0.3rem;">BOT</span>
              <button class="btn-debug danger" onclick="app.debugRemoveBot(${p.id})" style="margin-left:auto;">Remove Bot</button></div>
            <label class="debug-controls-row debug-check" style="align-items:center;gap:0.3rem;color:var(--text-secondary);">
              <input type="checkbox" id="debug-see-all-${p.id}" ${D.seeAll && D.seeAll[p.id] ? 'checked' : ''} onchange="app.debugSetSeeAll(${p.id}, this.checked)"> Sees all cards</label>
            ${this.botRateRowHtml(p.id, D.botRates ? D.botRates[p.id] : null)}`;
          }
          return `<div class="debug-controls-row" style="align-items:center;">
            <span style="color:var(--text-secondary);">P${p.id} ${escapeHtml(p.name)}</span>
            <select id="debug-bot-diff-${p.id}" class="debug-select" style="width:70px;margin-left:auto;">
              <option value="easy">Easy</option><option value="medium" selected>Medium</option><option value="hard">Hard</option></select>
            <button class="btn-debug" onclick="app.debugAddBot(${p.id})">+ Bot</button></div>`;
        }).join('')}
        <div class="debug-controls-row" style="align-items:center;">
          <span style="color:var(--text-secondary);">👁 All bots see all cards</span>
          <button id="debug-see-all-on" class="btn-debug" onclick="app.debugSeeAllBots(true)" style="margin-left:auto;">On</button>
          <button id="debug-see-all-off" class="btn-debug" onclick="app.debugSeeAllBots(false)">Off</button></div>
      </div></div>

      <div class="debug-section"><div class="debug-section-title">Deal Control (from the next deal)</div><div class="debug-controls">
        ${gs.players.map((p) => {
          const mode = (D.dealModes && D.dealModes[p.id]) || 'normal';
          return `<div class="debug-controls-row" style="align-items:center;">
            <span style="color:var(--text-secondary);">P${p.id} ${escapeHtml(p.name)}${p.id === this.myPlayerId ? ' (you)' : ''}</span>
            <select id="debug-deal-${p.id}" class="debug-select" style="width:110px;margin-left:auto;" onchange="app.debugSetDealMode(${p.id}, this.value)">
              ${['normal', 'good', 'bad'].map((m) => `<option value="${m}"${m === mode ? ' selected' : ''}>${{ normal: 'Normal', good: 'Good cards', bad: 'Bad cards' }[m]}</option>`).join('')}</select></div>`;
        }).join('')}
        <button id="debug-deal-normal" class="btn-debug" onclick="app.debugDealAllNormal()">All normal</button>
      </div></div>

      <div class="debug-section"><div class="debug-section-title">Team Control</div><div class="debug-controls">
        ${gs.players.map((p) => `<div class="debug-controls-row" style="align-items:center;">
          <span style="color:var(--team${p.team + 1});">P${p.id} ${escapeHtml(p.name)} — T${p.team + 1}</span>
          <button class="btn-debug" onclick="app.debugSwapTeam(${p.id})" style="margin-left:auto;">Move to T${(p.team === 0 ? 1 : 0) + 1}</button></div>`).join('')}
      </div></div>

      <div class="debug-section"><div class="debug-section-title">Player Control</div><div class="debug-controls">
        ${ctl !== null
          ? `<div class="debug-controls-row" style="align-items:center;">
              <span style="color:var(--gold);">Controlling P${ctl} ${escapeHtml((gs.players[ctl] || {}).name || '?')}</span>
              <button class="btn-debug danger" onclick="app.debugReleasePossess()" style="margin-left:auto;">Release</button></div>`
          : gs.players.filter((p) => p.id !== this.myPlayerId).map((p) => `<div class="debug-controls-row" style="align-items:center;">
              <span style="color:var(--text-secondary);">P${p.id} ${escapeHtml(p.name)}</span>
              <button class="btn-debug" onclick="app.debugPossessPlayer(${p.id})" style="margin-left:auto;">Play As</button></div>`).join('')}
      </div></div>

      <div class="debug-section"><div class="debug-section-title">Host Powers</div><div class="debug-controls">
        <button class="btn-debug ${gs.frozen ? 'danger' : ''}" onclick="app.debugToggleFreeze()">${gs.frozen ? '▶ Unfreeze Game' : '❄ Freeze Game'}</button>
        <button class="btn-debug ${this._spyMode ? 'danger' : ''}" onclick="app.debugToggleSpy()">${this._spyMode ? '🔒 Hide Hands' : '👁 Spy Mode (See All Hands)'}</button>
        <div class="debug-controls-row">
          <label style="color:var(--text-secondary);min-width:70px;">Win Score:</label>
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
      row('Debug connection', this._dbg() ? 'yes (full view)' : 'no');
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
          <div style="color:var(--text-secondary);line-height:1.6;font-family:monospace;">${rows.join('')}</div></div>
        <div class="debug-section"><div class="debug-section-title">Seats</div>
          <div style="color:var(--text-secondary);line-height:1.6;font-family:monospace;">${seats || 'none'}</div></div>
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
        if (t === 'state' && m && m.s) text += ` rev ${m.s.rev}${m.s.game ? ` ${m.s.game.phase} seq ${m.s.game.moveSeq} turn P${m.s.game.currentTurn}` : ' lobby'}${m.s.debug ? ' +debug' : ''}`;
        else if (t === 'notice' || t === 'emote') text += ': ' + (m.text || '');
        else if (typeof m === 'string') text += ': ' + m;
        this._debugNote('←', text);
      }));
      const emit = net.emit;
      net.emit = (type, data, ...rest) => {
        const what = type === 'move' && data ? ` card ${data.cardId} take [${(data.captureCardIds || []).join(',')}] seq ${data.seq}`
          : type === 'debug' && data ? ' ' + data.op : '';
        this._debugNote('→', type + what);
        return emit(type, data, ...rest).then((ack) => {
          this._debugNote('←', `ack ${type}: ${ack.ok ? 'ok' : ack.error + (ack.reason ? ' ' + ack.reason : '')}`);
          return ack;
        }, (e) => { this._debugNote('←', `${type} failed: ${e.message}`); throw e; });
      };
    },

    debugReset() { this._debugUnlocked = false; this._spyMode = false; },

    // After a hello (a new socket after a drop, or a new room): debug again if it was on.
    debugAfterHello() {
      if (this._debugUnlocked || this.debugEnabled) this.debugUnlock(true);
    },

    // The hand shown at the bottom: my own, or the seat played with "Play As".
    debugHand(hand) {
      const D = this._dbg(), ctl = this.debugCtl();
      return D && ctl !== null ? (D.hands[ctl] || []) : hand;
    },

    // A move made while playing as another seat: the room checks it like any move.
    debugMove(cardId, captureCardIds) {
      const gs = this.gameState;
      return this.net.emit('debug', { op: 'move', seat: this.debugCtl(), game: gs.gameToken, seq: gs.moveSeq, cardId, captureCardIds });
    },

    // Spy mode: another seat's hand under its name, from the debug view.
    debugSpyHand(playerId) {
      const D = this._dbg();
      if (!this._spyMode || !D) return null;
      const hand = D.hands[playerId];
      return hand && hand.length ? hand : null;
    },

    // ---------- the panel's buttons: one 'debug' message each ----------
    async _dbgOp(op, args) {
      if (!this.net) { this.toast('No game'); return null; }
      if (!this._dbg()) { this.toast('Debug is host-only'); return null; }
      let ack;
      try { ack = await this.net.emit('debug', { ...(args || {}), op }); } catch (e) { this.toast('Not connected, try again in a moment'); return null; }
      if (ack.text) this.toast(ack.text);
      else if (!ack.ok) this.toast('Debug: ' + ack.error);
      this.updateDebugPanel();
      return ack;
    },
    _cardIndex(id) { const v = parseInt(val(id, ''), 10); return isNaN(v) ? -1 : v; },

    debugAddCardToPlayer(seat) { return this._dbgOp('addCard', { seat, index: this._cardIndex(`debug-card-select-${seat}`) }); },
    debugRemoveCardFromPlayer(seat, index) { return this._dbgOp('removeCard', { seat, index }); },
    debugAddTableCard() { return this._dbgOp('addTable', { index: this._cardIndex('debug-table-card-select') }); },
    debugRemoveTableCard(index) { return this._dbgOp('removeTable', { index }); },
    debugShuffleDeck() { return this._dbgOp('shuffleDeck'); },
    debugRefillDeck() { return this._dbgOp('refillDeck'); },
    debugSetTurn() { return this._dbgOp('setTurn', { seat: parseInt(val('debug-set-turn', '0'), 10) }); },
    debugSkipTurn() { return this._dbgOp('skipTurn'); },
    debugPauseTurn() { this.stopTurnTimer(); return this._dbgOp('pauseTimer'); },
    debugSetScores() { return this._dbgOp('setScores', { s1: val('debug-score-t1', 0), s2: val('debug-score-t2', 0) }); },
    debugSetShkobba() { return this._dbgOp('setShkobba', { s1: val('debug-shk-t1', 0), s2: val('debug-shk-t2', 0) }); },
    debugTableToHand() { return this._dbgOp('tableToHand'); },
    debugHandToTable() { return this._dbgOp('handToTable'); },
    debugSwapHands() { return this._dbgOp('swapHands'); },
    debugClearTable() { return this._dbgOp('clearTable'); },
    debugReturnCaptures(team) { return this._dbgOp('returnCaptures', { team }); },
    debugDealRound() { return this._dbgOp('dealRound'); },
    debugForceScoring() { return this._dbgOp('forceScore'); },
    debugShowWinner(team = 0) { return this._dbgOp('win', { team }); },
    debugToggleForceCapture() { return this._dbgOp('toggleForce'); },
    debugSetWinScore() { return this._dbgOp('setWinScore', { value: val('debug-win-score', 21) }); },
    debugAddBot(seat) { return this._dbgOp('addBot', { seat, level: val('debug-bot-diff-' + seat, 'medium') }); },
    debugRemoveBot(seat) { return this._dbgOp('removeBot', { seat }); },
    debugSwapTeam(seat) { return this._dbgOp('swapTeam', { seat }); },
    debugResetGame() { return this._dbgOp('reset'); },
    debugUndo() { return this._dbgOp('undo'); },
    debugRerunRound() { return this._dbgOp('rerun'); },
    debugSaveState() { return this._dbgOp('save'); },
    debugLoadState() { return this._dbgOp('load'); },
    debugPossessPlayer(seat) { this.cancelSelection(false); return this._dbgOp('possess', { seat }); },
    debugReleasePossess() { this.cancelSelection(false); return this._dbgOp('release'); },
    debugToggleFreeze() { return this._dbgOp('freeze'); },
    // "Sees all cards": one bot, or every bot at once
    debugSetSeeAll(seat, on) { return this._dbgOp('seeAll', { seat, on: !!on }); },
    debugSeeAllBots(on) { return this._dbgOp('seeAll', { on: !!on }); },
    // a bot's win rate: 0-100, or null for off (the bot plays its own level)
    debugSetBotRate(seat, value) { return this._dbgOp('botRate', { seat, value: value === null ? null : parseInt(value, 10) }); },
    debugSetDealMode(seat, mode) { return this._dbgOp('dealMode', { seat, mode }); },
    debugDealAllNormal() { return this._dbgOp('dealNormal'); },

    // the win rate slider under a bot in Bot Management
    botRateRowHtml(seat, rate) {
      const on = rate !== null && rate !== undefined;
      return `<div class="debug-controls-row" style="align-items:center;gap:0.3rem;">
        <span style="color:var(--text-secondary);">Win rate</span>
        <input type="range" id="debug-rate-${seat}" class="gold-range${on ? '' : ' is-off'}" min="0" max="100" step="5" value="${on ? rate : 50}" style="flex:1;min-width:60px;--fill:${on ? rate / 100 : 0};"
          onchange="app.debugSetBotRate(${seat}, this.value)">
        <span id="debug-rate-label-${seat}" style="min-width:2.4rem;text-align:right;color:${on ? 'var(--gold)' : 'var(--text-dim)'};">${on ? rate + '%' : 'off'}</span>
        <button class="btn-debug" onclick="app.debugSetBotRate(${seat}, null)">Off</button></div>`;
    },

    debugToggleSpy() {
      if (!this._dbg()) { this.toast('Debug is host-only'); return; }
      this._spyMode = !this._spyMode;
      this.toast(this._spyMode ? 'Spy Mode ON — seeing all hands' : 'Spy Mode OFF');
      this.renderGame();
      this.updateDebugPanel();
    },

    // The banner above the hand while playing as another seat, and the freeze banner
    // the other players see.
    renderBanners(gs) {
      let banner = document.getElementById('possess-banner');
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'possess-banner';
        banner.style.display = 'none';
        document.getElementById('hand-area').prepend(banner);
      }
      const ctl = this.debugCtl();
      if (ctl !== null && gs.players) {
        const cp = gs.players[ctl];
        banner.innerHTML = `<span class="possess-label">CONTROLLING: P${ctl} ${escapeHtml(cp ? cp.name : '?')} (T${cp ? cp.team + 1 : '?'})</span><button class="btn-debug" onclick="app.debugReleasePossess()">Release</button>`;
        banner.style.display = '';
      } else {
        banner.style.display = 'none';
      }
      let freeze = document.getElementById('freeze-banner');
      if (!freeze) {
        freeze = document.createElement('div');
        freeze.id = 'freeze-banner';
        freeze.className = 'freeze-banner';
        freeze.innerHTML = '<span class="freeze-icon-inline">&#10074;&#10074;</span> Game paused by the host';
        document.getElementById('screen-game').prepend(freeze);
      }
      freeze.style.display = gs.frozen && !this._dbg() ? '' : 'none';
    },
  });

  // typed in the console
  window.debug = () => app.toggleDebug();
})();
