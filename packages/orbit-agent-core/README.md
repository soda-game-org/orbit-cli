# `@soda_game/orbit-agent-core`

Portable, dependency-free Agent state and execution policy shared by Orbit
hosts.

This package contains only generic agentic behavior: execution budgets, plan
and finish gates, conversation lifecycle, context compaction, checkpoint
schemas, secret redaction, and target-neutral render-surface coordinate/evidence
contracts. Product integrations, credentials, billing, deployment,
target-specific prompts, and private skills remain outside this package.
