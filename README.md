# Orbit CLI

Open-source terminal and loopback Web CLI for building Orbit Arcade games in a local workspace.

The coding loop, checkpoints, image boundaries and publish preparation live in this repository. The Orbit Engine desktop application and its source are not included. Official models, specialized game templates and private skills stay behind the authenticated Orbit API; BYOK mode receives only the generic public skill in [`skills/generic-html-game/SKILL.md`](skills/generic-html-game/SKILL.md).

## Capability status

| Capability | Terminal CLI | Web CLI | Access and fallback |
| --- | --- | --- | --- |
| Local game create/edit | Yes | Yes | Official OAuth or user API key |
| Reference images | PNG/JPEG/WebP | PNG/JPEG/WebP | Extension, signature, symlink and workspace boundaries are verified; unsupported input is rejected with a visible error |
| Standalone GLB generation | Yes | Yes | Orbit OAuth Worker, or a user-owned Replicate key |
| Agent-requested 3D | Yes | Yes | Must be explicitly enabled; missing access pauses before generation |
| Crash recovery and resume | Yes | Yes | Atomic local checkpoint after each model/tool boundary; non-idempotent BYOK work requires explicit retry confirmation |
| Cloud diagnostics | Opt-in | Opt-in | Structured event metadata only, marked `cli` or `cli_gui`; disabled by default |
| Publish | Explicit command | Explicit dialog | OAuth required; never runs after generation by default |
| Document upload | No | No | PDF/DOCX/PPTX/XLSX extraction remains a desktop-product capability |
| GIS integration | No | No | Intentionally unsupported in this release; there is no silent GIS claim or hidden fallback |

The Web CLI is not a hosted copy of the online Studio. It is a local UI served only on `127.0.0.1`; the game preview runs on a separate loopback origin in a sandboxed iframe.

## Install and run

Node.js 22 or newer is required.

```sh
npm install
npm link
orbit doctor
```

Official access uses browser OAuth. No long-lived official Orbit API key is copied to the machine:

```sh
orbit auth login
orbit generate --workspace "$PWD/my-game" --prompt "Build a replayable mobile arcade game"
```

BYOK keys are entered without command-line arguments, then stored in macOS Keychain, Windows Credential Manager or Linux Secret Service:

```sh
orbit providers set openrouter
orbit providers set replicate
orbit generate --mode byok --provider openrouter --3d \
  --workspace "$PWD/my-game" --prompt "Build a small 3D arcade game"
```

For automation, send the key over stdin. Do not put it in shell history:

```sh
orbit providers set openrouter --key-stdin < /secure/path/openrouter-key
```

Open the local Web CLI:

```sh
orbit web
```

Generate a standalone GLB with official OAuth or Replicate:

```sh
orbit 3d --mode orbit --workspace "$PWD/my-game" \
  --prompt "A stylized low-poly spacecraft with PBR materials" \
  --output assets/models/spacecraft.glb
```

Attach private reference images. They are copied into `.orbit/references`, analyzed as private context and excluded from publish source:

```sh
orbit generate --workspace "$PWD/my-game" --prompt "Use this visual direction" \
  --attach /absolute/reference.png --attach /absolute/reference.webp
```

## Recovery, logs and publish

List checkpoints and resume a paused process:

```sh
orbit runs
orbit resume run_00000000-0000-4000-8000-000000000000
```

If a process stopped during a billable provider request, shell command or another non-idempotent step, Orbit pauses and asks for a deliberate retry:

```sh
orbit resume run_00000000-0000-4000-8000-000000000000 --retry-unsafe
```

Cloud diagnostics are local-only until explicitly enabled. Prompts, workspace paths, model messages, tool arguments and tool output are not accepted by the cloud log contract.

```sh
orbit logs enable
orbit logs flush
orbit logs disable
```

Publishing requires a completed, validated game run, OAuth and a second confirmation. Generation and preview never publish automatically:

```sh
orbit publish run_00000000-0000-4000-8000-000000000000
```

## Provider plan

- **Official Orbit:** Google OAuth creates a short-lived user session. The Worker selects supported official models, meters the run, provides private server-side skills and handles publish. The CLI never distributes a shared official provider key.
- **User providers:** OpenRouter, Z.AI, DeepSeek and Volcengine Ark are supported for coding; Replicate is supported for BYOK 3D. Keys remain in the operating-system vault and requests go directly to that provider.
- **No automatic credential downgrade:** if OAuth, provider capability, vision or 3D access is missing, the run is checkpointed and reports what must be configured. It does not silently switch accounts, keys or billing paths.

## Development

```sh
npm test
npm run audit:public
npm pack --dry-run
```

See [`SECURITY.md`](SECURITY.md) for the trust boundary and vulnerability reporting.
