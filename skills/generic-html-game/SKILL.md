---
name: generic-html-game
description: Public, generic guidance for building an original mobile-first HTML game with the Orbit host lifecycle.
---

# Generic HTML game guidance

Build an original, complete game loop that starts quickly, is replayable, and works with touch and keyboard. Keep the active playfield visually dominant and keep HUD elements compact.

Use local project files and relative assets. Do not use external CDNs, provider URLs, network calls, popups, geolocation, direct device-permission APIs, or file pickers inside the generated game.

The game must call `OrbitArcade.startGame()` when play begins, `OrbitArcade.endGame()` with a score/outcome when a run ends, and expose a reachable leaderboard action. Provide a harmless local fallback when the host bridge is not present so local preview remains playable.

Before finishing, validate the project and confirm that Start, input, retry, scoring, end state, resizing, and mobile layout are implemented. This skill intentionally contains no genre template, branded game reference, release packaging standard, private provider routing, or official Orbit game-design skill.
