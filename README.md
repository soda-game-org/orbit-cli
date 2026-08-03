# Orbit CLI

[简体中文](README.zh-CN.md) | English

Build, preview, iterate on, and publish HTML games from your terminal or a local browser UI.

Orbit CLI is the open-source developer tool for the [Orbit Arcade](https://orbit-arcade.com) ecosystem. Describe a game in natural language, let the Orbit Agent work inside a local project folder, preview the result, resume interrupted runs, generate 3D assets, and publish when you are ready.

It is made and maintained by **SODA GAME's Orbit team**, the team behind [Orbit Arcade](https://orbit-arcade.com) and [Orbit Engine](https://orbit-arcade.com/orbit-engine).

## Where Orbit CLI fits

- **[Orbit Arcade](https://orbit-arcade.com)** is where people create, play, share, and publish Orbit games on the web.
- **[Orbit Engine](https://orbit-arcade.com/orbit-engine)** is the full Windows and macOS desktop app for visual, local-project game development.
- **Orbit CLI** is the open-source terminal and local Web CLI for developers who prefer command-line workflows, automation, or a lightweight browser interface.

Orbit CLI uses the same Orbit account and official cloud services as the rest of the Orbit ecosystem. The closed-source Orbit Engine desktop application is distributed separately; this repository contains only the CLI and its local Web UI.

## What you can do

- Create or edit a game in any local workspace with the Orbit Agent.
- Use either official Orbit models through OAuth or your own supported provider API key.
- Attach PNG, JPEG, and WebP reference images.
- Generate GLB 3D assets with Orbit or Replicate.
- Preview games in an isolated local browser sandbox.
- Recover from crashes and resume from durable checkpoints.
- Review runs before publishing a finished game to Orbit Arcade.
- Open a local graphical interface with `orbit web`.

## Quick start

Orbit CLI requires Node.js 22 or newer.

```sh
git clone https://github.com/the-super-engine/orbit-cli.git
cd orbit-cli
npm ci
npm link
orbit doctor
```

Sign in with your Orbit account and create a game:

```sh
orbit auth login
orbit generate \
  --workspace "$PWD/my-game" \
  --prompt "Build a replayable mobile arcade game"
```

Open the graphical Web CLI instead:

```sh
orbit web
```

The Web CLI runs locally on `127.0.0.1`. It uses the same workspace, Agent runs, checkpoints, providers, and publishing flow as the terminal CLI.

## Use your own API key

Official Orbit access uses browser OAuth, so you do not need to copy an Orbit API key onto your machine. You can also connect one of the supported providers with your own key:

| Use case | Providers |
| --- | --- |
| Game generation | OpenRouter, Z.AI, DeepSeek, Volcengine Ark |
| 3D generation | Replicate |

Add a provider interactively:

```sh
orbit providers set openrouter
orbit providers set replicate
orbit providers list
```

Keys are stored in macOS Keychain, Windows Credential Manager, or Linux Secret Service. For automation, pass a key over stdin instead of placing it in shell history:

```sh
orbit providers set openrouter --key-stdin < /secure/path/openrouter-key
```

Generate a game with your provider:

```sh
orbit generate \
  --mode byok \
  --provider openrouter \
  --workspace "$PWD/my-game" \
  --prompt "Build a fast neon racing game"
```

## Images and 3D assets

Attach one or more reference images while generating:

```sh
orbit generate \
  --workspace "$PWD/my-game" \
  --prompt "Use this character and visual direction" \
  --attach /absolute/path/character.png \
  --attach /absolute/path/style.webp
```

Generate a standalone GLB through the official Orbit service:

```sh
orbit 3d \
  --mode orbit \
  --workspace "$PWD/my-game" \
  --prompt "A stylized low-poly spacecraft with PBR materials" \
  --output assets/models/spacecraft.glb
```

Use `--mode byok` after adding a Replicate key to run 3D generation through your own account.

## Resume interrupted work

Orbit records Agent progress locally after model and tool boundaries. List runs and resume one by ID:

```sh
orbit runs
orbit resume run_00000000-0000-4000-8000-000000000000
```

If Orbit cannot safely repeat an interrupted billable or otherwise non-idempotent operation, it pauses and asks for confirmation instead of silently running it again:

```sh
orbit resume run_00000000-0000-4000-8000-000000000000 --retry-unsafe
```

## Publish to Orbit Arcade

Publishing is always a separate, explicit action. It requires an Orbit login and a completed, validated game run. Generating or previewing a game never publishes it automatically.

```sh
orbit publish run_00000000-0000-4000-8000-000000000000
```

Your game will be sent to [Orbit Arcade](https://orbit-arcade.com) only after you confirm the publish step.

## Optional diagnostics

Cloud diagnostics are disabled by default. You can opt in when you want to send structured status and crash metadata to the Orbit service:

```sh
orbit logs enable
orbit logs flush
orbit logs disable
```

The cloud log contract does not accept prompts, workspace paths, model messages, tool arguments, or tool output.

## Current support

| Capability | Terminal CLI | Web CLI |
| --- | --- | --- |
| Local game creation and editing | Yes | Yes |
| PNG/JPEG/WebP references | Yes | Yes |
| GLB 3D generation | Yes | Yes |
| Crash recovery and resume | Yes | Yes |
| Explicit Orbit Arcade publishing | Yes | Yes |
| Document upload | Not yet | Not yet |
| GIS integration | Not yet | Not yet |

Run `orbit capabilities` to see the capabilities available in your installed version.

## Commands

```text
orbit auth login|status|logout
orbit providers list|set|remove|test <provider>
orbit generate --prompt <text> [options]
orbit resume <run-id> [options]
orbit 3d --prompt <text> [options]
orbit runs
orbit capabilities
orbit publish <run-id> [options]
orbit logs enable|disable|flush
orbit web
orbit doctor
```

Use `orbit --help` for the complete option list.

## Development and security

```sh
npm test
npm run audit:public
npm pack --dry-run
```

Orbit CLI is licensed under the MIT License. See [`SECURITY.md`](SECURITY.md) for security boundaries and vulnerability reporting.

Specialized official game templates and model credentials stay in Orbit's cloud services. The repository does not include the Orbit Engine source code or private production infrastructure.
