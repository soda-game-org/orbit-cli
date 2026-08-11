---
name: generic-html-game
description: Public, generic guidance for building an original mobile-first HTML game with the Orbit host lifecycle.
---

# Generic HTML game guidance

Build an original, complete game loop that starts quickly, is replayable, and works with touch and keyboard. Keep the active playfield visually dominant and keep HUD elements compact.

Use one responsive logical stage measured in CSS pixels for world/camera layout, collision, HUD, and input. Device pixel ratio or adaptive render scale may increase only backing-store/GPU resolution; it must never shrink the logical stage, be applied twice, or leave CSS-pixel drawing confined to the upper-left of a higher-resolution canvas. Reapply the chosen Canvas transform and dependent layout after backing-size resets and resize/orientation changes.

Use local project files and relative assets. Do not use external CDNs, provider URLs, network calls, popups, geolocation, direct device-permission APIs, or file pickers inside the generated game.

The game must call `OrbitArcade.startGame()` when play begins, `OrbitArcade.endGame()` with a score/outcome when a run ends, and expose a reachable leaderboard action. Provide a harmless local fallback when the host bridge is not present so local preview remains playable.

Before finishing, validate the project and confirm that Start, input, retry, scoring, end state, resizing, and mobile layout are implemented. This skill intentionally contains no genre template, branded game reference, release packaging standard, private provider routing, or official Orbit game-design skill.
