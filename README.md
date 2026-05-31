# Chkoba / شكوبة

A multiplayer browser implementation of **Chkoba** (شكوبة), the popular Tunisian card game. Built with PeerJS for peer-to-peer multiplayer — no server required. Deployable to any static host (Netlify, Vercel, GitHub Pages).

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

## Setup

### Play Immediately

This is a static web app. Deploy it anywhere:

1. Push to a GitHub repo
2. Connect to **Netlify** (or Vercel, GitHub Pages) — no build step needed
3. Open the URL and share the room link with friends

### Run Locally

Just open `index.html` in your browser:

```
open index.html
```

No build tools, no server, no dependencies.

## Architecture

```
chkoba/
├── index.html       # Single-page app: lobby, game board, modals
├── style.css        # All styling (responsive, card game layout)
├── game.js          # Game logic + P2P networking (PeerJS)
├── images/          # 40 PNG card images
│   ├── ace_of_hearts.png
│   ├── 2_of_diamonds.png
│   ├── jack_of_spades2.png     # Face cards use "2" suffix
│   └── ...
├── .gitignore
└── README.md
```

### Key Design Decisions

- **PeerJS** over Socket.IO — the app is deployed to static hosting (no Node server). PeerJS handles P2P signaling via a shared broker server.
- **Link-based joining** — no room code input on the page. The host shares a URL with `?room=XXXX`, players open it and click "Join Game".
- **Personalized state** — each player only receives their own hand in the state packet. The host has full state locally.
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
| Networking | [PeerJS 1.5](https://peerjs.com/) |
| Hosting | Any static host (Netlify, Vercel, etc.) |

## License

MIT
