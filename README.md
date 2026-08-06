<h1 align="center">Orbit CLI</h1>

<p align="center"><strong>A local game-building agent that turns prompts into playable browser games.</strong></p>

<p align="center">
  <img src="assets/readme/orbit-cli-hero.jpg" alt="The real Orbit CLI welcome menu beside five Orbit Arcade game covers" width="100%" />
</p>

<p align="center">
  Open source and local first. Build, validate, resume, and publish from your terminal.
</p>

<p align="center">
  <a href="README.md"><strong>English</strong></a> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@soda_game/orbit-cli"><img src="https://img.shields.io/npm/v/%40soda_game%2Forbit-cli?style=flat-square&amp;logo=npm&amp;label=npm" alt="npm version" /></a>
  <a href="https://github.com/soda-game-org/orbit-cli/actions/workflows/ci.yml"><img src="https://github.com/soda-game-org/orbit-cli/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/soda-game-org/orbit-cli?style=flat-square" alt="MIT License" /></a>
  <a href="https://www.npmjs.com/package/@soda_game/orbit-cli"><img src="https://img.shields.io/node/v/%40soda_game%2Forbit-cli?style=flat-square&amp;logo=node.js" alt="Node.js version" /></a>
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="https://orbit-arcade.com">Play on Orbit Arcade</a> ·
  <a href="https://github.com/soda-game-org/orbit-cli/releases">Releases</a> ·
  <a href="https://orbit-arcade.com/orbit-engine">Orbit Engine</a>
</p>

---

## What Orbit CLI does

Orbit CLI runs the game-building loop on your machine while you choose how models and generated assets are accessed.

| Capability | What it means |
| --- | --- |
| Agentic game building | Plans the loop, writes the project, validates the playable, and keeps working through tool calls. |
| Terminal or local Web CLI | Use the command line for speed or open `orbit web` for a graphical workflow. |
| Orbit Cloud or BYOK | Sign in with Orbit OAuth, or bring supported provider keys stored in your operating-system vault. |
| Images and 3D in the same run | Attach references and let the agent produce selected image or GLB assets alongside the game code. |
| Checkpointed and explicit | Resume interrupted work safely; publishing only happens when you run `orbit publish`. |

## Quickstart

### Install Orbit CLI

Orbit CLI requires Node.js 22 or newer.

```sh
npm install --global @soda_game/orbit-cli
```

To work from source instead:

```sh
git clone https://github.com/soda-game-org/orbit-cli.git
cd orbit-cli
npm ci --ignore-scripts
npm link
```

Check your setup:

```sh
orbit doctor
```

Or run `orbit` with no arguments to open the keyboard-driven launcher:

```sh
orbit
```

Choose **Create a game** to enter a prompt and workspace, or jump directly to the Web CLI, local runs, account login, provider list, diagnostics, and command reference.

### Create your first game

Sign in with your Orbit account:

```sh
orbit auth login
```

Then describe the game you want to build:

```sh
orbit generate \
  --workspace "$PWD/my-game" \
  --prompt "Build a replayable mobile arcade game"
```

Prefer a graphical interface? Open the local Web CLI:

```sh
orbit web
```

### Build-command safety

Orbit does not run project code by default. Some generated projects need a local dependency install or build; enable that only after reviewing the workspace:

```sh
orbit resume <run-id> --allow-shell
```

The command boundary is intentionally narrow and uses an isolated HOME and npm cache, but the project's own `build` script still runs with your operating-system user's filesystem permissions. Treat `--allow-shell` as permission to execute the generated project, not as a sandbox.

## Choose how models are accessed

Orbit CLI offers two model routes. Sign in with Orbit OAuth to use Orbit Cloud and Orbit billing, or use your own API key for OpenRouter, OpenAI, DeepSeek, Zhipu BigModel (China), Z.AI (Global), Volcengine Ark, Kimi (China), or Kimi (Global). A Replicate key gives the game-development agent access to image and 3D asset generation in BYOK runs.

```sh
orbit providers set openrouter
orbit providers list
orbit providers models openrouter

orbit generate \
  --mode byok \
  --provider openrouter \
  --workspace "$PWD/my-game" \
  --prompt "Build a fast neon racing game"
```

OpenRouter models are selected by model ID rather than a hard-coded list; the catalog command shows models that advertise tool support. You can still enter another model ID directly. Regional Zhipu and Kimi services use separate endpoints and separate stored keys.

Provider keys are stored in your operating system's credential vault. For automation, use `--key-stdin` instead of putting a key in shell history.

## Images and 3D

Add PNG, JPEG, or WebP references to a game:

```sh
orbit generate \
  --workspace "$PWD/my-game" \
  --prompt "Use this character and visual direction" \
  --attach /absolute/path/character.png
```

Let the game-development agent plan and generate image assets alongside the game code:

```sh
orbit generate \
  --mode byok \
  --provider openrouter \
  --workspace "$PWD/my-game" \
  --prompt "Build a polished neon racing game" \
  --images
```

With Orbit OAuth, the same tool uses the authenticated Orbit Worker and Orbit billing. In BYOK mode, it uses the Replicate key stored in the operating-system vault and the user's Replicate billing. The agent decides whether a small number of high-impact images will improve the game, writes verified PNG files into the workspace, references them from the final build, and checkpoints paid work for recovery. The two billing routes never silently fall back to one another.

`orbit image` remains available as a small convenience command, but Orbit CLI's primary workflow is the coding agent run above: game code, images, 3D models, and other assets are produced together for the requested game.

Generate a GLB asset with Orbit or your Replicate account:

```sh
orbit 3d \
  --mode orbit \
  --workspace "$PWD/my-game" \
  --prompt "A stylized low-poly spacecraft" \
  --output assets/models/spacecraft.glb
```

## Resume and publish

Orbit saves local checkpoints so interrupted work can continue:

```sh
orbit runs
orbit resume <run-id>
```

If the project folder moved, explicitly rebind every checkpoint for that workspace instead of editing local JSON by hand:

```sh
orbit runs relocate <run-id> --workspace /absolute/path/to/moved-game
```

The Web CLI exposes the same operation as **Relocate folder** on each run. The replacement must be an existing real directory. Orbit updates local checkpoint references only; it never moves project files or publishes anything.

When your game is ready, publish it to [Orbit Arcade](https://orbit-arcade.com):

```sh
orbit publish <run-id>
```

Publishing is always an explicit step and requires an Orbit login.

## Docs

- Run `orbit` for the interactive launcher, or `orbit --help` for the complete command reference.
- Run `orbit capabilities` to see the features available in your installed version.
- Read the [security policy](SECURITY.md).
- Review the [release-integrity policy and historical tag notice](RELEASES.md).
- Browse source tags and release notes on [GitHub Releases](https://github.com/soda-game-org/orbit-cli/releases).

## TypeScript development

Orbit CLI keeps its maintained source, tests, build tooling, and release audit in TypeScript. Compiled ESM is created in the ignored `dist/` directory only during build and packaging, so the repository remains source-first while npm installs run without a TypeScript runtime.

```sh
npm run dev -- --help
npm run typecheck
npm test
npm run build
npm run check
```

`npm run typecheck` applies the strict product-code configuration. `npm test` executes the TypeScript test suite directly with `tsx`, while `npm run check` also builds the distributable and audits the exact npm package contents.

Developed by **SODA GAME**. Licensed under the [MIT License](LICENSE).
