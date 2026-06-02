# Chkoba — Visual Direction (experimental north star)

The concept in one line: **a Tunisian café table at midnight** — dark felt, warm aged-paper cards with coin-gold suits, lit warm-on-dark like a noir film, moving like Balatro.

This doc is the contract for the `experimentals/` lab. Every theme is a re-skin of the *same* board and the *same* motion grammar; only the tokens change. When we lock a theme, porting it into the real game = copying its token set into `style.css` and wiring the juice layer.

## Three influences → three layers

| Layer | Source | What it contributes |
|-------|--------|---------------------|
| **Soul** | Tunisian Chkobba | the deck, the Arabic vocabulary (sabʿa l-ḥayya, dīnārī, barmīla, kārṭa), Kairouan 8-point-star geometry, Sidi Bou Saïd color |
| **Skin** | Deadlock | warm-gold-on-near-black noir; incised art-deco display type, uppercase + tracked; ornament in the *frame*, never the reading text; layered material depth (inner-shadow + bevel + grain + vignette) |
| **Feel** | Balatro | springy hover-lift + cursor-lean tilt; holographic sheen that tracks the pointer; count-up scoring that bounces and escalates; sequential capture resolution; score-scaled screen shake; a table that's never fully still |

The reconciliation (Deadlock noir vs bright Tunisian blue-white): **take the dark noir base, make the accents Tunisian.** "Sidi Bou Saïd at midnight."

## Palette (base direction — themes vary the accents)

```
--ink-900    #0E1418   near-black felt base (slightly cool-green, like dark table baize)
--ink-800    #141C1E
--ink-700    #1C2A2C
--paper      #F2E8CF   card stock / ivory whitewash (warm, aged)
--paper-dim  #D8C9A6
--gold       #C9A24B   coin-gold — primary accent, the "Deadlock gold" pushed Tunisian
--gold-lo    #8A6D2C
--gold-hi    #EAD08A
--indigo     #1E5A8A   Sidi Bou Saïd blue — the cool counter-tone (replaces Deadlock teal)
--indigo-dim #123A5C
--terracotta #C8642D   Kairouan/Nabeul clay — warm secondary accent
--haya-red   #C8102E   flag-red — RESERVED. Only the sabʿa l-ḥayya (7 of coins/diamonds) and win states.
--ash        rgba(242,232,207,.62)  muted body text on dark
```

Rule: dark stage, two-to-three accents, **flag-red used exactly once** as the prestige signal. Keep generous paper/light areas so the dark reads *moody*, not bleak.

## Typography

- **Display (titles, card names, scores):** an incised art-deco/classical face — **Cinzel** or **Colus** (both free; Deadlock's real face is OH no's *Forevs*). Uppercase, letter-spaced, gold-on-dark.
- **Wordmark شكوبة:** Maghribi / Kairouani-Kufic character — NOT generic Naskh, NOT faux-Kufic Latin. Use a real Arabic display face (e.g. Aref Ruqaa, Lateef, or a Kufi) for the logo only.
- **Body / UI:** a quiet humanist sans (**Alegreya Sans**, **Exo**, or system humanist) for anything you actually read.
- **Numbers / HUD:** condensed grotesque (**Oswald** / **Saira Condensed**), tabular, prominent.

## Motion grammar (the juice — shared across all themes, intensity configurable)

1. **Springy hover-lift + snap** — hovered card `translateY(-12px) scale(1.04)`, selected lifts higher; driven by a spring (overshoot + settle), never linear ease.
2. **Cursor-lean 3D tilt** — pointer offset → `rotateX/Y ±10deg`, `perspective`, rotation lerps toward target (trails the cursor = weight).
3. **Holographic / coin sheen** — gradient layer blended `color-dodge`/`screen`, position + hue driven by the same pointer offset + slow time term; a moving specular glare follows the cursor. Prestige cards (sabʿa l-ḥayya) always shimmer.
4. **Idle breath** — low-amplitude looping wobble with per-card random phase so a fanned hand is never frozen.
5. **Count-up score ramp** — don't set the score, *count* it; each tick a quick `scale 1→1.25→1` bounce + color flash, staggered, escalating, with a rising-pitch tick (Web Audio).
6. **Sequential capture choreography** — captures resolve one card at a time, each bounces as it flies to the pile.
7. **Commit slam + score-scaled shake** — played card drives in with overshoot; root wrapper shakes, amplitude ∝ score; decays to zero. Gated by reduced-motion.
8. **Living backdrop** — slow animated gradient/zellige shimmer so the table breathes at rest.

All motion respects a **reduced-motion** toggle and `prefers-reduced-motion`.

## The three starting themes

- **v1 — Noir Deco** (Deadlock-dominant): near-black, brass-gold framing, Cinzel uppercase, engraved card plates, heavy vignette + grain, restrained juice. Premium, cinematic, moody.
- **v2 — Zellige Midnight** (Tunisia-forward): dark indigo felt, coin-gold + terracotta, a real Kairouan 8-point-star tile pattern in the backdrop and card backs, the شكوبة wordmark prominent, warmer and more ornamental. The "cultural" pick.
- **v3 — Balatro Max** (feel-dominant): juice cranked — strong holographic cards, CRT-lite scanline whisper, count-up scoring theater, springier everything, bolder neon-on-dark contrast. The "fun" pick.

## Configurable knobs (every version + the gallery harness)

`palette variant · juice intensity (0–100) · suit style (French ♦ vs coin dīnārī) · CRT overlay on/off · reduced-motion · card-back pattern · font pairing`

The **suit-style toggle defers the deck decision** — French pips vs coin/cup/sword/baton, viewable side by side.

## Authenticity guardrails

- Anchor to **named Tunisian sources**: Kairouan (8-point star, c. 836 CE), Nabeul ceramics, Sidi Bou Saïd blue-white, Maghribi/Kairouani script.
- The deck: French suits are authentic to how Chkobba is played *today*; the heritage underneath is the Latin **coins/cups/swords/clubs** (Scopa). "dīnārī" literally means *coins*. Bridge them — diamonds → gold coins is the high-impact move.
- **Avoid:** "Arabian Nights" Vegas-gold, genie lamps, faux-Kufic Latin, one flat saturated blue, and **Moroccan** substitutes (Majorelle blue, Moroccan zellige) passed off as Tunisian.

## References

Balatro: wavebeem.com/toybox/2025/balatro (CSS holo), Mix-and-Jam game-feel, SunsetSamu/balatro-cards-effect-css, font m6x11.
Deadlock: playdeadlock.com, OH no *Forevs* (free alts Cinzel/Colus), palette `#1A1A1A`/`#212020` + `#efdfbf`.
Tunisia: Neapolitan deck photos (seedsofitaly), Kairouani calligraphy, Sidi Bou Saïd doors (mosaicnorthafrica), pagat Chkobba rules/terms.
