# What changed since the Netlify version

A player's-eye comparison of the last Firebase/Netlify version (commit `4a5972f`, 23 Sep 2026) and the current Cloudflare version (`chkooba.pages.dev`, the game server on a Cloudflare Worker). Both versions' code was read side by side: `game.js`, `index.html`, `css/`, `js/` then and `public/` plus `public/js/room.js`, `public/js/net.js` now.

**In short:** the rules, scoring, bots, cards, themes, sounds, labels, animations, tally, menus and options are the same code as before. What changed is who referees an online game: the server instead of the host's browser. That brought reconnects, seat holds and private hands, and it took away the host-only debug panel and the "host decides" tally flow. Both are now back, and so are the four small confirmations that went missing.

Unchanged, checked file by file: `rules.js` (rules, scoring, bot moves), `i18n.js` (Latin / Arabic / English labels and rule texts), `juice.js` (animations and sound effects), `cards.js` (Photo / Flat / Pixel cards, French / Coins suits), `fire.js`, `shader.js`, `look.js` (themes Felt / Balatro / Noir, personal settings). The menu, the Options screen (players, win score, turn timer, bot level, game speed, force capture, capture assist, look, shake, animations, labels, sound), the rules carousel, the card info panel, the in-game menu (Stats, Settings, Log, Actions), the emote bar, the round-end tally and the match-end screen have the same content and markup.

## Removed

| What | Why | Now |
|---|---|---|
| **The debug panel, opened by typing `debug()` in the console** (host only) | Deleted on purpose in the rebuild: it could show every player's hand. | **Restored**, with the old styling (`css/debug.css`) and wording. All of the old panel (every hand, table, deck, add/remove cards, undo, snapshots, set turn, scores and chkobbas, move cards between zones, force deal / score / win, bots, teams, "play as", freeze, spy mode) is now done by the referee through one `debug` message, the same code offline and online. Offline vs the bot it is all yours. Online it is the host's, as in the first version: the server sends the host's connection every hand and the deck. A guest's panel shows only what their browser has and marks the rest "hidden in online games: the server holds it"; a guest's browser never receives hidden cards. |
| **"Only the host continues" on the round-end tally** | The rebuild made the next deal wait until every player had tapped continue. | **Restored.** The host taps to deal the next round; the others see "waiting for the host" and a tap only skips their own count, as before. The bot game continues on your one tap. |
| Small confirmations: "Room ready" when a room is created, "Added Bot" / "Bot removed" in the lobby, "Rematch" when a rematch starts, and "Game resumed" in the move log after resuming a bot game | Lost when the lobby and game logic moved into the room. | **Restored.** |
| The "Online play is unavailable: the server connection is not configured" banner on the menu | It was about a missing Firebase config. There is no config any more. | Not needed. If the server cannot be reached, the game says "Could not reach the game server. Check your connection." |
| Firebase (the SDK, `firebase-config.js`, `database.rules.json`, the Netlify build script) | Replaced by the game server. | Not restored, by design. |
| The host seeing all hands through the debug panel / spy mode in an online game | Online hands now exist only on the server. | Not restored, by design: spy mode and the other cheats work in offline bot games only. |
| Rejoining a running game by typing the same name and room code | Replaced by a seat token kept in the browser (see Changed). | Not restored: the new way is safer (nobody can take your seat by typing your name). |
| The 3-second "blip" grace before a guest counted as gone | Replaced by the 60 s seat hold. | Not restored (the hold is longer and does the same job). |

## Changed

**Online play and rooms**
- **The server referees online games.** It shuffles, deals, checks every move, scores and plays bot seats. Each browser receives only its own hand; before, every browser could read every hand from the database.
- **The host leaving no longer ends the game.** Before: "The host left, the game is over". Now lobby and tally control passes to the next player and the game goes on.
- **Dropped players:** before, only the host saw "X left the game" and could Wait or Claim the win. Now everyone sees "X lost connection. Keeping the seat for 60s"; after 60 s anyone still there can Wait, **Let a bot play**, or Claim the win / End the game. Guests used to see "The host (name) lost connection, waiting for them"; that is now the same banner for any player.
- **Rejoining:** a reload or the same invite link takes your seat and hand back (seat token in this browser). The host can now reload too, which used to break the game. Opening the game in a second tab says "This game is open in another tab".
- **Surrender:** any player can surrender for their side; before, only the host could ("Only the host can end the game").
- **The round-end tally** (now host-controlled again, see Removed) also moves on by itself after 30 s in online games, as a safety net in case the host has walked away. The first version had no timeout. Offline vs the bot it waits for your tap, as before.
- **Invite link:** `https://<site>/?room=CODE` (any other URL parameters, such as `?debug=1`, are no longer copied into it). Room codes are still 8 characters.
- **Lobby:** in a 4-player room the host can move any seat to the other team, including their own. Seats show "reconnecting". Guests also see how many players are still missing. The Start button shows a spinner instead of "Starting".
- **Turn timer, bot speed, bot level, win score, force capture, capture assist, look:** same options and the same values; the server runs the timer and the bots instead of the host's browser.

**Where the game lives**
- The game moved from Netlify to `https://chkooba.pages.dev` (the old Netlify address forwards there). Browsers keep settings per site, so on the new address your name, options, look, personal settings and any saved bot game from the Netlify site start fresh. A bot game saved by the old version cannot be resumed (the save format changed).

**Layout (phones)**
- Portrait 4-player: the three opponents sit side by side above the table instead of on top of it.
- Narrow portrait screens: the HUD fits on one row; the deck box is hidden (the pile on the table shows the count), the wordmark and the HUD's "+N chkobba" tag make room (the chkobba count stays on the player panels).
- Landscape phones: one HUD row with the turn in it, smaller cards, the action buttons beside the hand, the menu in two columns, tighter lobby and tally frames. The emote bar moves into the game menu there.
- Tap targets are at least 44 px; screens keep clear of the notch and the home bar; overlays scroll when they do not fit.

**Smaller**
- The match-end line for the losing side says "your side surrendered" instead of "you surrendered" (in 4 players it may have been your partner).
- The move log shows times from the server and holds the last 50 entries; it also notes "X lost connection", "X is back", "X left the game" and "A bot plays for X".
- Buttons that wait on the server show a spinner and always come back; a move made against an old table gets "The table changed, try again" instead of being played twice.
- An animation can no longer hold the board (cut after 6 s), and a hidden tab skips animations so it catches up at once.
- A double tap can no longer pair with the last tap of the previous turn and place a card by itself.
- `debug()` online: the full panel is still the host's; a guest can now open a read-only view of their own data. The host's debug view comes from the server, so it stays with host control (if control passes on, the old host's view is turned off). The verbose console logging switch (`?debug=1` or `localStorage.chkoba_debug = "true"`) is unchanged.

## Added

- **Reconnecting banner** ("Reconnecting…") while the connection is down, then "Reconnected"; the game catches up from a fresh snapshot after any drop, a phone waking up, or the network coming back.
- **Let a bot play** for a player who has been gone for 60 s; the player gets their seat and hand back if they return.
- **Emotes in the in-game menu** (and on landscape phones, only there).
- **Debug panel "Net" tab** (new): the room, your seat, the host, the connection, whether this is a debug connection, the snapshot number and the last messages to and from the server.
- "A room code is 8 letters and digits" when a typed code is malformed. (A missing room now says "That room does not exist anymore" instead of "Room not found".)
