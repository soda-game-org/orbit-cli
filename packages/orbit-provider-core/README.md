# `@soda_game/orbit-provider-core`

Runtime-neutral provider request and response normalization for Orbit hosts.

The zero-dependency package contains provider profiles, request and response
conversion, model discovery, retries, reasoning-state replay, normalized token
usage, and resumable media jobs. Credential storage, OAuth, billing, pricing,
prompts, skills, UI, and deployment remain in host adapters.

Provider requests consume the canonical per-item projection produced by
`@soda_game/orbit-agent-core`. Chat Completions and Responses payloads are
rebuilt from protocol allowlists: host paths, Session metadata, local media
references, and internal compaction markers never become wire fields. Image
parts must already be resolved to a provider-supported, bounded transport by
the host; unresolved local paths fail closed.

`maxOutputTokens` is optional. Explicit, capability-checked values are sent to
the selected provider, while an omitted value remains omitted so an unknown
BYOK model can apply its native policy instead of inheriting an incompatible
Orbit product limit.

Successful assistant responses may include normalized prompt, completion,
reasoning, cached, and total token counts. Provider-specific raw cost fields
are intentionally omitted so each host can apply its own trusted billing
policy.
