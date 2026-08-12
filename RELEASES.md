# Release integrity

## v0.2.1

This patch keeps the CLI, provider transport, and Web PRO cloud runner on the
same portable Agent Core. It fixes the generated ESM module used by isolated
cloud hosts so it carries the function-name helper required after production
bundling; without it, an E2B runner could fail during boot before its first
Agent step. The release gate now executes that generated module after a
keep-names bundle transform, matching the production boundary.

## v0.2.0

This release adds a canonical Project → Session/Thread → Turn → Run/Attempt
conversation model to the terminal and local Web CLI. One workspace can now
hold multiple independent Sessions, while existing `runs/<id>/checkpoint.json`
and `events.jsonl` records remain readable in place through lazy, idempotent
indexing and recovery.

Media input now uses canonical per-item identity: repeated occurrences stay
distinct even when they share one verified attachment blob, text-only models
receive one structured observation per item, and vision-capable providers see
image bytes only in bounded, transient request projections. Provider changes,
failed observations, image limits, host paths, and native reasoning state all
fail closed at their explicit trust boundaries.

The storage-neutral shared agent core now defines canonical lifecycle objects,
preserves complete tool-call batches atomically, keeps semantic compaction
compatible with visual Turn context, and applies the same execution, plan,
finish, and safety contracts across hosts. Orbit CLI persists those contracts
with durable run/turn/attempt and workspace-relocation recovery records.
Managed agent calls retain the full 65,536-token output allowance needed by
reasoning-heavy models, with DeepSeek V4 Pro remaining the truthful default
display and request fallback.

## v0.1.14

This release moves portable Agent policy and provider transport into audited,
independently installable public packages. Orbit CLI consumes the shared
execution budget, plan/finish gates, context compaction, and loop streak state
machine while product integrations remain in host adapters. The default
DeepSeek profile is DeepSeek V4 Pro.

Orbit CLI release tags are public supply-chain identifiers. The repository was rebased at `v0.1.12` to establish a genuinely TypeScript-only maintained source history and retire earlier source refs that still reached obsolete JavaScript or private implementation material. Registry artifacts already published for earlier versions remain governed by the registry and are not reproduced or replaced by this repository.

Starting with `v0.1.12`, every source tag must identify exactly one reviewed version and must not be moved, replaced, or reused.

## Release requirements

Before publishing a new version:

1. Start from a reviewed commit on protected `main` with CI passing.
2. Update the package version once and create one annotated tag after merge.
3. Never force-update or reuse a `v0.1.12` or newer tag, even to repair release notes or artifacts.
4. Run the public audit against the checkout, all reachable Git history, and the exact npm package manifest.
5. Publish checksums for attached artifacts and enable GitHub immutable releases when the repository plan supports them.
6. Pin third-party Actions to full commit SHAs and update them through reviewed dependency pull requests.

If a release exposes a real credential, revoke the credential first, publish a new version, and follow GitHub's sensitive-data removal process. Do not treat history rewriting alone as revocation.
