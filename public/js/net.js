/* The client's line to a room. Two kinds behind one shape:
 *   Net.socket(url)  a WebSocket to the game server: requests with acks, a heartbeat,
 *                    and reconnecting with backoff after a drop
 *   Net.local(room)  a room running inside this page (the offline bot game)
 * Both give: emit(type, data) -> Promise<ack>, on(type, fn), wake(), close(), status.
 * emit() always settles, with the room's ack or with an error (offline, timeout), so
 * whatever button sent it can always come back.
 * Events: 'open', 'status' (connecting | open | reconnecting | closed), 'fatal' (the
 * room is gone or refused us: not-found, replaced, closed, unreachable), 'timeout',
 * and every message type the room sends ('state', 'notice', 'emote'). */
(function (global) {
  'use strict';

  const ACK_TIMEOUT_MS = 6000;
  const PING_MS = 8000;          // a ping this often keeps the line warm and proves it alive
  const SILENCE_MS = 20000;      // nothing heard for this long: the socket is dead, open a new one
  const FATAL = { 4001: 'replaced', 4004: 'not-found', 4010: 'closed' };

  function events() {
    const fns = {};
    return {
      on(type, fn) { (fns[type] = fns[type] || []).push(fn); },
      fire(type, ...args) {
        (fns[type] || []).forEach((fn) => { try { fn(...args); } catch (e) { console.error('[net]', type, e); } });
      },
    };
  }

  function socket(url) {
    const ev = events();
    const pending = new Map();
    let ws = null, stopped = false, opened = false, attempt = 0, nextId = 1;
    let status = 'connecting', retry = 0, ping = 0, lastSeen = 0;

    const setStatus = (s) => { if (s !== status) { status = s; ev.fire('status', s); } };
    const failAll = (why) => {
      pending.forEach((p) => { clearTimeout(p.timer); p.reject(new Error(why)); });
      pending.clear();
    };

    function open() {
      clearTimeout(retry); retry = 0;
      if (stopped) return;
      setStatus(opened ? 'reconnecting' : 'connecting');
      let me;
      try { me = new WebSocket(url); } catch (e) { later(); return; }
      ws = me;
      me.onopen = () => {
        if (me !== ws) return;
        attempt = 0; opened = true; lastSeen = Date.now();
        startPing();
        setStatus('open');
        ev.fire('open');
      };
      me.onmessage = (e) => {
        if (me !== ws) return;
        lastSeen = Date.now();
        let m;
        try { m = JSON.parse(e.data); } catch (err) { return; }
        if (!m || m.t === 'pong') return;
        if (m.t === 'ack') {
          const p = pending.get(m.id);
          if (p) { pending.delete(m.id); clearTimeout(p.timer); p.resolve(m); }
          return;
        }
        ev.fire(m.t, m);
      };
      me.onclose = (e) => {
        if (me !== ws) return;
        if (FATAL[e.code]) { stop(); ev.fire('fatal', FATAL[e.code]); return; }
        dropped();
      };
      me.onerror = () => { /* onclose follows */ };
    }

    // The socket is gone (or silent): let go of it and try again.
    function dropped() {
      const old = ws;
      ws = null;
      stopPing();
      failAll('offline');
      if (old) { old.onopen = old.onmessage = old.onclose = null; try { old.close(); } catch (e) { /* already closed */ } }
      if (!stopped) later();
    }

    function later() {
      attempt++;
      // never reached the server at all: stop and say so rather than spin forever
      if (!opened && attempt > 5) { stop(); ev.fire('fatal', 'unreachable'); return; }
      setStatus(opened ? 'reconnecting' : 'connecting');
      const delay = Math.min(8000, 300 * Math.pow(2, attempt - 1)) * (0.75 + Math.random() * 0.5);
      retry = setTimeout(open, delay);
    }

    function startPing() {
      stopPing();
      ping = setInterval(() => {
        if (!ws || ws.readyState !== 1) return;
        if (Date.now() - lastSeen > SILENCE_MS) { dropped(); return; }
        try { ws.send('{"t":"ping"}'); } catch (e) { dropped(); }
      }, PING_MS);
    }
    function stopPing() { clearInterval(ping); ping = 0; }

    function stop() {
      stopped = true;
      clearTimeout(retry); retry = 0;
      stopPing();
      failAll('closed');
      if (ws) { const old = ws; ws = null; old.onopen = old.onmessage = old.onclose = null; try { old.close(1000); } catch (e) { /* closed */ } }
      setStatus('closed');
    }

    function emit(type, data, timeoutMs) {
      return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== 1) { reject(new Error('offline')); return; }
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('timeout'));
          ev.fire('timeout', type);
        }, timeoutMs || ACK_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        try { ws.send(JSON.stringify({ ...(data || {}), t: type, id })); }
        catch (e) { pending.delete(id); clearTimeout(timer); reject(new Error('offline')); }
      });
    }

    // A phone waking up, or the network coming back: reconnect now instead of waiting
    // for the backoff, and drop a socket that has gone quiet while the screen was off.
    function wake() {
      if (stopped) return;
      if (!ws) { attempt = 0; open(); return; }
      if (ws.readyState === 1 && Date.now() - lastSeen > PING_MS + 4000) { attempt = 0; dropped(); }
    }

    open();
    return { emit, on: ev.on, wake, close: stop, get status() { return status; } };
  }

  // The offline game: the same messages, handed to an in-page room. Replies are
  // delivered on a later tick, like a real network, never inside the caller's stack.
  function local(room) {
    const ev = events();
    const pending = new Map();
    let stopped = false, nextId = 1;
    const conn = room.connect((text) => {
      if (stopped) return;
      setTimeout(() => {
        if (stopped) return;
        const m = JSON.parse(text);
        if (m.t === 'ack') { const p = pending.get(m.id); if (p) { pending.delete(m.id); p.resolve(m); } return; }
        ev.fire(m.t, m);
      }, 0);
    }, () => {});
    setTimeout(() => { if (!stopped) { ev.fire('status', 'open'); ev.fire('open'); } }, 0);
    return {
      emit(type, data) {
        return new Promise((resolve, reject) => {
          if (stopped) { reject(new Error('closed')); return; }
          const id = nextId++;
          pending.set(id, { resolve, reject });
          room.message(conn, JSON.stringify({ ...(data || {}), t: type, id }));
        });
      },
      on: ev.on,
      wake() {},
      close() {
        if (stopped) return;
        stopped = true;
        pending.forEach((p) => p.reject(new Error('closed')));
        pending.clear();
        room.disconnect(conn);
      },
      get status() { return stopped ? 'closed' : 'open'; },
    };
  }

  global.Net = { socket, local };
})(window);
