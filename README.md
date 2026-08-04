# Orbit CLI

[简体中文](README.zh-CN.md) | English

<p align="center"><strong>Orbit CLI</strong> is an open-source AI game-development agent that runs locally in your terminal or browser.</p>

<p align="center">
  Create, play, and publish games on <a href="https://orbit-arcade.com">Orbit Arcade</a>.<br />
  For the full desktop experience, get <a href="https://orbit-arcade.com/orbit-engine">Orbit Engine</a> for Windows and macOS.
</p>

---

## Quickstart

### Install Orbit CLI

Orbit CLI requires Node.js 22 or newer.

```sh
git clone https://github.com/soda-game-org/orbit-cli.git
cd orbit-cli
npm ci
npm link
```

Check your setup:

```sh
orbit doctor
```

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

## Choose how models are accessed

Orbit CLI offers two model routes. Sign in with Orbit OAuth to use Orbit Cloud and Orbit billing, or use your own API key for OpenRouter, OpenAI, DeepSeek, Zhipu BigModel (China), Z.AI (Global), Volcengine Ark, Kimi (China), or Kimi (Global). Replicate keys are supported for 3D generation.

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

When your game is ready, publish it to [Orbit Arcade](https://orbit-arcade.com):

```sh
orbit publish <run-id>
```

Publishing is always an explicit step and requires an Orbit login.

## Docs

- Run `orbit --help` for the complete command reference.
- Run `orbit capabilities` to see the features available in your installed version.
- Read the [security policy](SECURITY.md).
- Download a version from [GitHub Releases](https://github.com/soda-game-org/orbit-cli/releases).

Developed by **SODA GAME**. Licensed under the [MIT License](LICENSE).
