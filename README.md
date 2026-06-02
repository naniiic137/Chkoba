# Chkoba / شكوبة

A multiplayer browser implementation of **Chkoba** (شكوبة), the popular Tunisian card game. Built with Firebase Realtime Database for real-time multiplayer across any network. Deployable to any static host (Netlify, Vercel, GitHub Pages).

## Quick Start

### 1. Deploy to Netlify

1. Push this repo to GitHub
2. Go to [Netlify](https://app.netlify.com/) → **Add new site** → **Import an existing project**
3. Connect your GitHub repo — **no build step required**

### 2. Set up Firebase

1. Go to [Firebase Console](https://console.firebase.google.com/) and create a new project
2. Add a **Realtime Database**. Do **not** leave it in "test mode" (test mode is world read/write — anyone on the internet can read every hand and overwrite any game). Publish the rules from `database.rules.json` instead: **Realtime Database → Rules → paste the file contents → Publish**.
3. Go to **Project Settings** → **General** → **Your apps** → **Add app** → **Web**
4. Copy the `firebaseConfig` object
5. Open `firebase-config.js` in this project and paste your config

> **Note on the config:** the Firebase web config (`apiKey`, `databaseURL`, etc.) is shipped to every browser and is *not* a secret — it identifies the project, it does not authorize access. Security comes from the database rules above, not from hiding the config. See `docs/AUDIT.md` for the full security picture (and the remaining follow-ups: anonymous auth for true at-rest hand privacy, and server-side authority for cheat resistance).

### 3. Play

1. Open your Netlify URL
2. Click **Create Game**
3. Share the generated link with friends — they open it and click **Join Game**
4. That's it — works across any network, no extra setup needed

## How to Play

### Rules

- **Players:** 2 or 4 players. In 4-player mode, players 0+2 form **Team 1**, players 1+3 form **Team 2**.
- **Deck:** 40 cards (Ace through 7 plus Jack, Queen, King in each suit — no 8, 9, 10).
- **Deal:** First round deals 4 cards face-up on the table, then 3 cards to each player. Each subsequent round deals only 3 cards per player.
- **Play:** On your turn, play a card from your hand. You can either **place** it on the table or **capture** table cards whose values sum to your played card's value.
  - Aces = 1, 2-7 = face value, Queen = 8, Jack = 9, King = 10.
- **Force Capture:** When enabled, you must capture if any combination of table cards matches your played card's value.
- **Shkobba:** If you clear all cards from the table, your team scores +1 point (the dealer cannot score Shkobba on the last card of a round).
- **Round End:** When all hands are empty and the deck runs out, remaining table cards go to the last team that captured.
- **Scoring per round:**
  - Most captured cards: **+1 point**
  - Most diamonds captured: **+1 point**
  - 7 of diamonds (tiebreak: highest diamond in descending order): **+1 point**
  - Each Shkobba: **+1 point**
- **Instant Win:** Capture all 10 diamonds in a single round to win immediately.
- **Win Condition:** First team to reach 11 (short game) or 21 (long game) points wins.

### Tips

- Table cards **carry over** between rounds — they are not cleared until the deck is empty.
- When placing a card, you can double-click it to auto-place (if no capture is required).
- Use the **Debug Mode** (toggle in main menu or press backtick `` ` ``) to see all players' hands, inspect the deck, and manipulate the game for testing.

### Run Locally

Just open `index.html` in your browser. No build tools, no server, no dependencies.

## Architecture

```
chkoba/
├── index.html          # Single-page app: lobby, game board, modals
├── style.css           # All styling (responsive, card game layout)
├── game.js             # Game logic + Firebase real-time networking
├── firebase-config.js  # Your Firebase project configuration
├── images/             # 40 PNG card images
│   ├── ace_of_hearts.png
│   ├── 2_of_diamonds.png
│   ├── jack_of_spades2.png     # Face cards use "2" suffix
│   └── ...
├── .gitignore
└── README.md
```

### Key Design Decisions

- **Firebase Realtime Database** over WebRTC/PeerJS — no NAT issues, no signaling servers to deploy, works across any network. Firebase handles real-time sync via WebSockets with automatic reconnection.
- **Link-based joining** — no room code input on the page. The host shares a URL with `?room=XXXX`, players open it and click "Join Game".
- **Host-authoritative state** — the host runs the game logic (deal, turns, capture validation, scoring). Player moves are written to Firebase, the host processes them and writes the updated state back.
- **Private hands** — each player's hand is stored in a separate Firebase path (`hand_0`, `hand_1`, etc.), and each client subscribes only to its own hand path. Note: with the current rules any client that knows the room code can still *read* another `hand_i` directly; enforcing true at-rest privacy requires anonymous auth + per-user rules (tracked in `docs/AUDIT.md`).
- **40-card rounds, cumulative scoring** — multiple 40-card rounds are played until a team reaches the win threshold. The deck is reshuffled each full cycle.

### Card Images

Card images follow the naming convention `{name}_of_{suit}[2].png`. Face cards (jack, queen, king) append `2` (e.g., `queen_of_hearts2.png`). Place your own card images in the `images/` folder following this pattern.

## Debug Mode

Toggle **Debug Mode** in the main menu or press the backtick key (`` ` ``) during a game. The debug panel lets you:

- See all players' hands
- Inspect the top 10 cards of the deck
- Add any card to your hand
- Remove your last card
- Force the next turn
- Force a full deck redeal
- Force a win for Team 1

The debug panel is draggable — grab the gold header bar to move it.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| UI | Vanilla HTML + CSS |
| Logic | Vanilla JavaScript |
| Database | [Firebase Realtime Database](https://firebase.google.com/products/realtime-database) |
| Hosting | Any static host (Netlify, Vercel, etc.) |

## License

MIT
