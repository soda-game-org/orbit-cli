# Security policy

## Supported versions

Only the latest published minor version receives security fixes while the project is pre-1.0.

## Report a vulnerability

Use the repository's private GitHub Security Advisory form. Do not put tokens, OAuth codes, private prompts, local paths or exploit details in a public issue.

## Trust boundary

- OAuth sessions and provider keys are stored only through the operating-system credential vault. There is no plaintext fallback.
- The Web CLI binds to `127.0.0.1` on random ports. Its management API requires an unguessable bearer token, a separate CSRF token, an exact loopback `Host` and an exact `Origin`.
- Preview content is served from a separate random loopback origin, sandboxed, and cannot call the management API.
- Reference images must be absolute regular files with a supported extension and matching magic signature. Symbolic links, directory escapes, oversized input and files that change during reading are rejected.
- Published source rejects symbolic links, secret-looking filenames, high-confidence credentials embedded in ordinary text files, oversized files and private `.orbit` state. The scanner reports only the file and credential category, never the matched value.
- Cloud diagnostics are disabled by default and accept a narrow structured schema. They never include prompt text, file content, paths, model messages or tool input/output.

The open client is not a sandbox for arbitrary untrusted code. Project-code execution is disabled by default. `--allow-shell` permits only dependency installation without lifecycle scripts, the project's `build` script, and JavaScript syntax checks; it also uses an isolated HOME and npm cache instead of forwarding the parent environment. These controls reduce accidental credential exposure, but a project-defined build script still executes with the current operating-system user's filesystem permissions. Review the generated workspace before enabling it.
