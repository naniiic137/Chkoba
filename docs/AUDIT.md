# Chkoba — Code & Architecture Audit

A multi-agent deep-dive review of the Chkoba web game (`game.js`, `index.html`, `style.css`, build/config). Findings are grouped by severity. Each item gives a `file:line` reference, what's wrong, the real-world impact, and a concrete fix.

The single most important takeaway: **the game's "private hands" and "host-authoritative" guarantees are intentions, not enforcement.** As deployed (Firebase Realtime Database in test mode + 100% client-side logic), every player can read every other player's hand, and the entire database is world-readable/writable by anyone on the internet. Everything else is secondary to that.

---

## Severity legend

| Level | Meaning |
|-------|---------|
| CRITICAL | Breaks game integrity/security or makes the game unplayable in a common scenario |
| HIGH | Wrong outcome or serious robustness gap under realistic conditions |
| MEDIUM | Bug in an edge case, or significant quality/UX problem |
| LOW | Polish, cleanup, defense-in-depth |

---

## CRITICAL

### 1. Every client receives every player's hand (hidden information is not hidden)
**`game.js:283-289`** (combined with `game.js:755`)

Each player intends to read only their own hand (`game.js:266`, scoped to `child('hand_' + myId)`). But to detect the host leaving, every client *also* subscribes to the entire room node:

```js
this._roomRef.on('value', (snap) => {
  if (!snap.val() && this.gameState) { this.toast('The link is dead'); this.backToLobby(); }
});
```

`.on('value')` on the room root streams the whole subtree — including `hand_0..hand_n` for **all** players and the full deck order — to every client on every update. Any player can read every opponent's hand in real time from devtools. This is a total break of a hidden-information card game.

**Fix:** Detect host departure via a dedicated sentinel child (e.g. a `closed`/`alive` boolean, or treat a null `state` as "room gone") instead of subscribing to the room root. Never subscribe to a node that contains private per-player data.

### 2. Firebase Realtime Database runs in "test mode" — world read + world write
**`README.md:16`** ("Start in test mode"); no `database.rules.json` exists in the repo.

Test-mode rules are effectively `{ ".read": true, ".write": true }`. Combined with the publicly-shipped `databaseURL`, **anyone on the internet** can, without the game client:
- `GET https://<db>.firebasedatabase.app/.json` → dump every room, every private hand, the full deck order, scores, logs.
- `PATCH rooms/<code>/state` → forge scores, flip turns, rewrite the board.
- `DELETE rooms.json` → wipe every active game.
- Write unbounded data → blow the free-tier quota / run up billing.

**Fix:** Replace test-mode with real security rules (`database.rules.json`, committed and deployed) and enable Firebase **Anonymous Auth** so hands can be scoped per-user. Minimum: deny global read, lock `hand_i` to its owner, restrict `state` writes to the host. See the proposed `database.rules.json` shipped with the fixes.

### 3. Host disconnect or refresh permanently bricks the game
**`game.js:765-784`, `134-140`**

Authoritative state (`deck`, `hands`, `capturedTeams`) lives only in the host's browser memory — only *counts* are persisted to Firebase. There is no `onDisconnect` handler and no host migration. If the host closes the tab or drops network mid-round, all clients freeze on the last state forever (only the host runs the turn timer). On a host *refresh*, the `?room=` URL routes the host back in as an ordinary player, so no host logic ever runs again.

**Fix:** Persist full authoritative state to a host-only path on each broadcast; register `onDisconnect`; implement host migration (lowest-id survivor rehydrates and takes over) or, at minimum, detect host-gone and end the game cleanly with a clear message. Restore host identity on reload.

**Status in this PR:** a *graceful* host exit (Leave / Back to Menu) is now handled cleanly — the room is removed and clients are notified via the `host`-child listener instead of freezing. An *ungraceful* host close (tab killed, device sleep) still leaves clients on stale state: this is unchanged from before and is the part that needs presence + a reconnect grace window + host migration. We tried an `onDisconnect().remove()` on the room but reverted it — it deletes a live game on any transient blip and corrupts the room on the host's next write, which is worse than the freeze. Proper handling is the follow-up feature.

### 4. No real server authority — the host (or any writer) is fully trusted
**`game.js:580-673`, `801-858`**

The host validates *opponent* moves (turn, card-in-hand, capture sum — `game.js:580-603`), which is good. But nothing validates the host, and with open rules **any** client can write `state` directly and be believed by all others (no validation, no signatures). Turn *number* is checked; writer *identity* is not, so a client can submit a move as another player.

**Fix:** True cheat-resistance requires authoritative game logic server-side (Cloud Functions or a small backend) with clients submitting intents only. If that's out of scope, document that the game is "friends-only, not cheat-resistant," and at minimum apply rules so only the host uid can write `state` and only a slot's owner can write its identity.

### 5. Game is completely unplayable by keyboard
**`game.js:1101, 1169`**

Hand and table cards render as `<div onclick=...>` with no `tabindex`, no `role`, and no key handler. A keyboard, switch-access, or screen-reader user cannot select a card or play a turn at all. The action buttons are real `<button>`s but do nothing until a card is clicked.

**Fix:** Render cards as `<button type="button">` (or add `role="button" tabindex="0"` + Enter/Space `keydown`). Roving tabindex across the hand for good UX.

---

## HIGH

### 6. Join is a read-then-write race with no transaction
**`game.js:239-254`**

`joinGame` reads all players with `once('value')`, picks the first empty slot, then `set`s it — no atomicity. Two players opening the link near-simultaneously both see the same empty slot, both claim it; the second overwrites the first. Result: duplicate player IDs, a real slot never filled, and a lobby whose Start button never enables.

**Fix:** Claim the slot with a Firebase `transaction()` that aborts if the slot is already taken and retries to the next free one; reject when full inside the transaction.

### 7. Rejoin-after-refresh lockout
**`game.js:337-350`**

A non-host who refreshes never releases `players/<id>` (only the host's `leaveRoom` removes anything; a browser refresh calls nothing). On rejoin: 2-player → "Room is full"; 4-player → a *different* slot, so their hand listener points at someone else's hand and the orphaned slot stalls turn rotation. No state recovery either.

**Fix:** Register `players/<id>.onDisconnect().remove()` at join; persist `{room, myId, isHost}` to `localStorage` and reconnect to the same slot on reload.

### 8. Room codes are short, low-entropy, and enumerable
**`game.js:68-73`**

4 characters from a 31-symbol alphabet via `Math.random()` ≈ 923k keyspace — fully enumerable. With world-read (item 2), an attacker can `GET rooms.json` to list every live room directly, then read all hands or hijack state.

**Fix:** Use `crypto.getRandomValues` and lengthen to 8-10 chars; pair with rules that forbid listing `rooms` so enumeration is blocked.

### 9. `AudioContext` leaked on every sound — all audio eventually dies
**`game.js:1280`**

`playSound` does `new AudioContext()` on every call and never closes it. The per-second timer-warning beeps make this climb fast. Browsers cap concurrent contexts; once hit, `new AudioContext()` throws, the `try/catch` swallows it, and **all** game audio silently stops mid-session.

**Fix:** Create one shared, lazily-initialized context (resumed on first user gesture for autoplay policy) and reuse it for every tone.

### 10. Capture-combination search is exponential
**`game.js:55-66`**

`findCaptureCombinations` enumerates all `2^n` subsets of table cards, recomputed on every card selection, double-click, and move. With force-capture off the table can grow unbounded; at ~20+ table cards this hangs the tab.

**Fix:** Bound table size or switch to subset-sum DP (target ≤ 10, values 1-10 — a tiny memoized search). Short-circuit above a safe threshold.

### 11. Shkobba dealer exception over-suppresses
**`game.js:625`** (and the dealer-last-card check)

The "dealer can't score Shkobba on the last card" rule is gated on `hand.length === 0` only. But within one 40-card cycle there are multiple sub-deals, and the dealer empties their hand at the end of *every* sub-deal — so a legitimate Shkobba on the last card of an intermediate sub-deal is wrongly denied. (Severity depends on whether "round" in the rules means a sub-deal or the full cycle — worth confirming intent.)

**Left unchanged on purpose — needs your call.** Under the README's literal wording (each sub-deal is a "round", and the code logs "Round N"), the current behavior is self-consistent, so this is a rules-interpretation decision, not a clear bug. The "real Chkoba" fix would be to also require the deck to be empty: `if (playerId === gs.dealerIndex && hand.length === 0 && gs.deck.length === 0)`. Note even that may be imperfect, since the dealer isn't necessarily the last player to act. **Tell us which interpretation you want and we'll apply it.**

---

## MEDIUM

### 12. Silent Firebase-init failure → dead Create/Join buttons
**`game.js:127-132`, `181`**

`init()` catches a Firebase init error but only `console.error`s; `_db` stays null. `createGame`/`joinGame` then dereference `this._db.ref(...)` synchronously and throw, with zero user feedback — and this is exactly the documented first-run state (config not yet pasted).

**Fix:** On init failure, disable Create/Join and show a persistent "Firebase not configured / unavailable" banner; null-check `_db` in both handlers.

### 13. Double-click handler is double-bound
**`game.js:870-874`** + inline `ondblclick` in the card render

Cards carry a native `ondblclick` *and* a JS 300ms double-tap detector that also fires `onCardDblClick`. A real double-click triggers both; the duplicate play is only incidentally masked by the submit guard and can slip through for an animations-off host.

**Fix:** Keep one mechanism — the click-based detector (needed for touch) — and drop the inline `ondblclick`.

### 14. Full `innerHTML` board rebuild on every render
**`game.js:985-1003`** (and `renderHand`/`renderTable`/`renderOpponents`)

Every render destroys and recreates every card `<div>`/`<img>`, re-decoding images, thrashing layout, and wiping in-progress animations (the card-fly-out is immediately blown away). Called from many paths.

**Fix:** Reconcile by card `id` (keyed update) or cache image elements; at least skip rebuilding unchanged rows.

### 15. Modals have no focus management, role, or Escape
**`index.html:166-210`, `game.js:146-148`**

The score, controls, and debug overlays don't move/trap/restore focus, lack `role="dialog"`/`aria-modal`, and only the controls drawer closes on Escape. Keyboard focus can land on the obscured board behind a modal.

**Fix:** On open, focus the first control, trap Tab, restore focus on close, add `role="dialog" aria-modal="true" aria-labelledby`; make Escape close the score modal.

### 16. Error toast is invisible to screen readers
**`index.html:176`, `style.css:1065-1085`, `game.js:1368-1373`**

`#toast` is the only channel for errors and invalid-move feedback, but has no `aria-live`, and toggles via `display:none` (which suppresses live-region announcements even if added).

**Fix:** Add `role="status" aria-live="polite"` (`assertive` for errors); toggle with opacity/visibility, not `display`.

### 17. No `<img onerror>` fallback for card images
**`game.js:1101, 1169`**

No resilience if a card file is missing/renamed — the card collapses to bare `alt` text on a white box with no indication it's broken. Relevant since the README invites custom decks. Also, the ace of spades uses the `2` suffix (`ace_of_spades2.png`) but the README only documents that for face cards.

**Fix:** Add `onerror` that draws a CSS rank/suit fallback (the code already has `SUIT_SYMBOLS`/`SUIT_COLORS`). Document the ace-of-spades suffix.

### 18. No CSP / security headers; Firebase CDN scripts have no SRI
**`netlify.toml`, `index.html:212-213`**

No Content-Security-Policy, `X-Frame-Options`, or `X-Content-Type-Options`. The Firebase SDK is loaded from gstatic with a pinned version but no `integrity` hash — a gstatic/DNS compromise would run arbitrary JS with full page access.

**Fix:** Add a Netlify `[[headers]]` CSP block (script-src self + gstatic; connect-src the Firebase endpoints; object-src none) plus the two standard headers; add `integrity`/`crossorigin` to the SDK tags or self-host.

---

## LOW / cleanup

- **19. Single-card capture priority not enforced** (`game.js:596`). Real Chkoba requires taking an exact single match over a multi-card combination of the same value. The README doesn't mandate it — confirm intent.
- **20. 10-diamond instant win missed on end-of-round table sweep** (`game.js:454-459`). The instant-win check runs only in the active-capture branch; if the 10th diamond arrives via the leftover-table sweep it isn't detected.
- **21. XSS sinks are currently safe but fragile** (`game.js:75-79` + every name render). All player-name sinks use `escapeHtml` today, so no live XSS — but there's no CSP backstop, so one missed escape becomes stored XSS hitting every player. Centralize name rendering through one escaped helper.
- **22. Dead code**: `debugAddCard`/`debugRemoveCard` (`game.js:1957`), `.glass-panel` CSS (`style.css:107`), unreachable 7♦ tiebreak branch (`game.js:698`), unused `started` flag (`game.js:189`).
- **23. Non-host `leaveRoom` never frees its slot** (`game.js:337-349`); ghost slot can make a room unstartable.
- **24. `cleanupListeners` only runs on graceful leave** (`game.js:373-377`), not on refresh; re-joining in the same page session can stack duplicate listeners that fire logic twice.
- **25. Captured-pile overlap hardcoded `-30px`** (`game.js:1059, 1143`) collapses on mobile where mini-cards shrink to 26-30px.
- **26. Debug-panel drag is mouse-only and unclamped** (`game.js:1635-1662`); unusable on touch, can be dragged off-screen.
- **27. `alt` text is rank-only** (`game.js:1101, 1169`) — `alt="7"` can't distinguish 7♦ (a scoring card) from 7♣. Use `display of suit`.
- **28. Form labels not associated with inputs** (`index.html:19, 23-44, 74`); placeholder-as-label.
- **29. Low-contrast text on the felt** (`style.css:37-38`) — `--text-dim`/`--text-muted` fail WCAG AA for state-bearing text.
- **30. `!important` overuse** (`style.css:867-895, 1027-1043`) from `:first-child` selectors fighting modifier classes; replace with explicit `.btn-action-place` class.
- **31. Debug cheat panel shipped to production** (host-gated, local-only, but an obvious cheat affordance).
- **32. `firebase-config.js` secrecy is a false sense of security** — the Firebase web config is *designed* to be public; security comes from rules, not from gitignoring the config. Fix the mental model in the README.
- **33. God object / tight coupling** — `app` (~1900 lines) mixes networking, pure rules, DOM, audio, and debug. Extract pure rules (`findCaptureCombinations`, scoring) into a testable, DOM-free module.

---

## Verified correct (so they don't get "fixed" by mistake)

- Card values A=1, 2-7=face, Q=8, J=9, K=10 — consistent everywhere (`game.js:5-16`).
- Deck = 40 cards (A-7, J, Q, K per suit) — correct (`game.js:36-45`).
- Deal math: first sub-deal 4 to table + 3 each; later sub-deals 3 each; totals 40 for both 2p and 4p — correct (`game.js:391-431`).
- Force-capture enforcement, round-end sweep to last capturer, per-round scoring (most cards / most diamonds / 7♦ / shkobba), team attribution (0+2 vs 1+3), win threshold 11/21 — all correct.
- All comparisons use strict `===` — no `==` bugs to "fix."
- Player-name rendering consistently uses `escapeHtml` — XSS is currently mitigated (keep it that way).

---

## Suggested order of work

1. Stop the whole-room subscription + commit `database.rules.json` + scope hands (items 1, 2 — and 4/8 partially).
2. Host persistence + disconnect handling (item 3).
3. Transactional slot claim + `onDisconnect` release + reconnect (items 6, 7).
4. Crypto room codes; shared AudioContext; bounded capture search (items 8, 9, 10).
5. Keyboard-playable cards + modal/toast a11y (items 5, 15, 16).
6. Silent-init handling, Shkobba edge case, render/perf cleanups, and the LOW tier.

Items 1-3 are what decide whether the game is actually playable and fair; the rest is correctness, accessibility, and polish.
