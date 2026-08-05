# Orbit Provider Core

The zero-dependency provider transport shared by Orbit CLI and Orbit Engine.

It contains fixed provider profiles, request and response conversion, model discovery, retries, reasoning-state replay, normalized token usage, and resumable Replicate image/3D predictions. Credentials, OAuth, billing, pricing, UI, tools, and skills are supplied by the host application and are not part of this package.

Successful assistant responses may include `usage` with `promptTokens`, `completionTokens`, `reasoningTokens`, `cachedTokens`, and `totalTokens`. The same normalization is also exported as `normalizeProviderUsage(raw)`. Provider-specific raw usage and cost fields are intentionally omitted so each host can apply its own trusted billing policy.

See the [Orbit CLI repository](https://github.com/the-super-engine/orbit-cli) for the public source and security policy.
