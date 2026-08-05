# Release integrity

Orbit CLI release tags are public supply-chain identifiers. Once published, a tag or versioned asset must not be moved, replaced, or reused.

## Historical tag notice

The `v0.1.0` through `v0.1.7` source tags all resolve to the same `Orbit CLI v0.1.7` repository snapshot. They are retained to avoid another destructive tag rewrite. The `v0.1.0` through `v0.1.6` source archives therefore do **not** reproduce their displayed CLI versions and must not be used for provenance or rollback. `v0.1.7` identifies that shared snapshot correctly.

`v0.1.8` is the first tag in the current history that points to its own versioned commit. New releases must preserve that one-version/one-commit relationship.

## Release requirements

Before publishing a new version:

1. Start from a reviewed commit on protected `main` with CI passing.
2. Update the package version once and create one annotated tag after merge.
3. Never force-update or reuse the tag, even to repair release notes or artifacts.
4. Run the public audit against the checkout, all reachable Git history, and the exact npm package manifest.
5. Publish checksums for attached artifacts and enable GitHub immutable releases when the repository plan supports them.
6. Pin third-party Actions to full commit SHAs and update them through reviewed dependency pull requests.

If a release exposes a real credential, revoke the credential first, publish a new version, and follow GitHub's sensitive-data removal process. Do not treat history rewriting alone as revocation.
