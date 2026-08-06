# Release integrity

Orbit CLI release tags are public supply-chain identifiers. The repository was rebased once at `v0.1.10` to establish a TypeScript-only maintained source history and retire inconsistent pre-`v0.1.10` source tags. Registry artifacts already published for earlier versions remain governed by the registry and are not reproduced or replaced by this repository.

Starting with `v0.1.10`, every source tag must identify exactly one reviewed version and must not be moved, replaced, or reused.

## Release requirements

Before publishing a new version:

1. Start from a reviewed commit on protected `main` with CI passing.
2. Update the package version once and create one annotated tag after merge.
3. Never force-update or reuse a `v0.1.10` or newer tag, even to repair release notes or artifacts.
4. Run the public audit against the checkout, all reachable Git history, and the exact npm package manifest.
5. Publish checksums for attached artifacts and enable GitHub immutable releases when the repository plan supports them.
6. Pin third-party Actions to full commit SHAs and update them through reviewed dependency pull requests.

If a release exposes a real credential, revoke the credential first, publish a new version, and follow GitHub's sensitive-data removal process. Do not treat history rewriting alone as revocation.
