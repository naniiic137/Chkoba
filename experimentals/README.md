# Chkoba - experimental UI lab

A sandbox for reworking the game's visual identity before any of it touches the
real game. One board, three swappable skins, tunable juice. Nothing here imports
Firebase or game logic; it renders a frozen mid-game snapshot so it opens
instantly in a browser.

Read [`DESIGN_DIRECTION.md`](DESIGN_DIRECTION.md) for the why (the
Chkobba + Deadlock + Balatro blend, palette, typography, motion grammar).

## Run it

Serve the repo root with any static server and open the lab:

```
python -m http.server 8090
# then open http://localhost:8090/experimentals/
```

The control panel (right side) hot-swaps everything live. Every knob is mirrored
into the URL, so a look is a shareable link.

## URL knobs

`?theme=noir|zellige|balatro` · `&juice=0..100` · `&suit=french|coin`
· `&crt=1` · `&grain=0` · `&reduce=1` · `&kiosk=1` (hide the panel for clean shots)

Examples:
- `?theme=zellige&suit=coin&kiosk=1` - the cultural pick with heritage coin suits
- `?theme=balatro&juice=100&crt=1` - foil cards cranked, CRT on
- `?theme=noir&reduce=1` - reduced-motion (also auto-on if the OS prefers it)

## The three themes

| Theme | Lean | Read |
|-------|------|------|
| **Noir Deco** | Deadlock | near-black, engraved brass-gold plates, art-deco framing, restrained juice |
| **Zellige Midnight** | Tunisia | indigo night-felt, coin-gold + terracotta, Kairouan 8-point-star (khatim) tilework, شكوبة hero |
| **Balatro Max** | feel | holographic foil cards, neon-on-dark, CRT whisper, count-up scoring theater |

## How it is built (so a winner ports cleanly)

- `index.html` - the board. Its DOM mirrors the real game's `#game-view`
  contract: `#table-cards` / `#hand-cards`, and each `.card` keeps
  `role="button" tabindex="0" aria-label`. A chosen theme ports by swapping the
  card-inner render in `game.js` and copying the token block; the outer
  structure already matches.
- `shared/` - the read-only contract: `mock-state.js`, `board.js` (CSS/SVG card
  faces, French + heritage coin suit sets), `juice.js` (tilt, holo, capture
  flight, count-up, shake), `base.css` (layout + the full CSS-variable token
  contract + card component + control panel).
- `themes/<name>.css` - a theme is just a `[data-theme]` block of token values
  plus decorative FX. No theme touches `shared/`.

## Locking a theme

Pick a theme (or a couple) via the panel, then we wire a theme picker into the
real game and port the token set + the juice layer. The suit-style toggle keeps
the French-vs-coin deck decision open until then.
