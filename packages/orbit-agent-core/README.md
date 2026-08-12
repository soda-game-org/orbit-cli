# `@soda_game/orbit-agent-core`

Portable, dependency-free Agent state and execution policy shared by Orbit
hosts.

This package contains only generic agentic behavior: execution budgets, plan
and finish gates, conversation lifecycle, context compaction, checkpoint
schemas, secret redaction, and target-neutral render-surface coordinate/evidence
contracts. Product integrations, credentials, billing, deployment,
target-specific prompts, and private skills remain outside this package.

The package also owns two portable Arcade delivery contracts:

- the structured Orbit Arcade SDK baseline consumed by Web, CLI, and desktop validators;
- logical `listing_cover` and `app_icon` roles plus their non-blocking state model.

It deliberately does not own R2 keys, local filesystem paths, image providers,
billing, or private target standards. Those remain host adapters.

Version 0.5 adds storage-neutral Project, Thread/Session, Turn, and typed input
item schemas. Canonical turn inputs are `text`, `image`, `localImage`,
`attachment`, and `ref`; legacy `local_image`/`local-image` inputs normalize to
`localImage`. Hosts may persist media observations and provider-ready cache
references, but the core performs no filesystem or network access.

Use `projectAgentTurnForProvider` (or the item-level primitive) before a model
request. It preserves every source identity while projecting supported visual
inputs individually and projecting text-only attachments as separate bounded
structured observations. Check `blocked`, or call
`assertAgentInputProjectionReady`, before sending. Local paths and host
sidecars are never provider fields. In canonical Turn input, `image`
accepts only a bounded base64 raster data URL and `localImage` keeps a local
path. Remote Web media is an `attachment`; a host may validate it into a safe
public HTTPS/data URL or provider file in `MediaCache` for transport.

Hosts that need a standalone ESM policy module, including isolated cloud
runners, must use `buildOrbitAgentCoreModuleSource()`. The generated module is
self-contained even when the host package was transformed with function-name
preservation by a production bundler.
