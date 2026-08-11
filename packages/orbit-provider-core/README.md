# `@soda_game/orbit-provider-core`

Runtime-neutral provider request and response normalization for Orbit hosts.

The zero-dependency package contains provider profiles, request and response
conversion, model discovery, retries, reasoning-state replay, normalized token
usage, and resumable media jobs. Credential storage, OAuth, billing, pricing,
prompts, skills, UI, and deployment remain in host adapters.

Successful assistant responses may include normalized prompt, completion,
reasoning, cached, and total token counts. Provider-specific raw cost fields
are intentionally omitted so each host can apply its own trusted billing
policy.
