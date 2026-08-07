# Contributing

Thanks for improving Orbit CLI.

## Development

Use Node.js 22 or newer, then install and validate the checkout:

```sh
npm ci --ignore-scripts
npm run check
npm audit --omit=dev
npm pack --dry-run
```

Keep changes focused, add tests for behavior changes, and do not commit generated credentials, private prompts, internal deployment details, local paths, or unrelated product source.

## Pull requests

- Explain the user-facing outcome and security impact.
- Keep operational deployment notes out of public PR descriptions.
- Do not move or reuse existing release tags.
- Report vulnerabilities through a private GitHub Security Advisory, not a public issue or pull request.
