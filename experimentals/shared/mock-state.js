/* Frozen mid-game state for the UI lab. No Firebase, no game logic — just a
 * believable snapshot so every theme renders the same dramatic moment:
 * it is the local player's turn, the sabʿa l-ḥayya (7 of diamonds) sits on the
 * table glowing, and the player holds a 7 that can capture it for the prestige.
 *
 * Card shape mirrors the real game exactly: { id, suit, name, display, value }.
 */
(function (global) {
  'use strict';

  const card = (id, suit, name, display, value) => ({ id, suit, name, display, value });

  // The prestige card. The real game calls a 7 of diamonds the sabʿa l-ḥayya.
  const HAYA = card(106, 'diamonds', '7', '7', 7);

  const MOCK_STATE = {
    roomCode: 'CAFE',
    round: 2,
    roundTotal: 3,
    deckCount: 18,
    winScore: 21,
    currentTurn: 0,            // local player — hand is interactive
    myPlayerId: 0,
    forceCapture: true,

    players: [
      { id: 0, name: 'You',   team: 0, handCount: 3, isLocal: true },
      { id: 1, name: 'Najib', team: 1, handCount: 3, isLocal: false },
    ],

    // Local player's hand. The 7 of clubs captures the haya outright.
    hand: [
      card(206, 'clubs', '7', '7', 7),
      card(309, 'spades', 'king', 'K', 10),
      card(4, 'hearts', '4', '4', 4),
    ],

    // Table. The haya leads; the rest give the capture engine real choices
    // (7♣ takes 7♦; 4♥ takes 4♦, or 3♣+A♠ = 4).
    tableCards: [
      HAYA,
      card(102, 'diamonds', '3', '3', 3),
      card(103, 'diamonds', '4', '4', 4),
      card(300, 'spades', 'ace', 'A', 1),
      card(5, 'hearts', '6', '6', 6),
    ],

    // Capture piles drive the count-up + pile visuals.
    captured: {
      0: { count: 8, shkobba: 1 },   // team 0 (you)
      1: { count: 6, shkobba: 0 },   // team 1 (Najib)
    },

    scores: { 0: 5, 1: 3 },

    // What a successful capture of the haya would look like — consumed by the
    // juice layer to choreograph the demo (capture -> fly to pile -> score ramp).
    pendingCapture: {
      handCard: card(206, 'clubs', '7', '7', 7),
      tableCards: [HAYA],
      points: 4,                     // dīnārī + sabʿa + … theatrical, not rules-accurate
      shkobba: false,
    },
  };

  // The id of the prestige card so themes/juice can target it for the idle shimmer.
  MOCK_STATE.hayaId = HAYA.id;

  global.MOCK_STATE = MOCK_STATE;
})(window);
