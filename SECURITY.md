# Security Policy

## Supported versions

| Version  | Supported          |
|----------|--------------------|
| 0.13.x   | :white_check_mark: |
| < 0.13   | :x:                |

Security fixes land on the latest minor version (`meshfleet` on npm). Older versions are not patched.

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email: **security@meshfleet.app** (or `john@meshfleet.app` if the security inbox isn't set up yet)

Include:
- Description of the vulnerability
- Steps to reproduce
- Affected versions
- Your name / handle (optional, for credit)

We aim to acknowledge within 48 hours and ship a fix within 7 days for critical issues.

## What we consider a security issue

- Code execution from untrusted input (e.g., path traversal in the ledger, command injection in spawned agents)
- Privilege escalation via the MCP transport
- Information disclosure in the ledger (the JSON file is plain text and may contain agent output)
- Supply-chain attacks against the dependencies

## What is NOT a security issue

- Local-only code execution (this is an MCP server that spawns `opencode run` — by design it runs code on your machine)
- Lack of authentication by default (the mesh assumes a trusted local environment; the MCP transport is the trust boundary). If the SSE listener must leave `127.0.0.1`, set `MESHFLEET_AUTH_TOKEN` — every endpoint except `/healthz` then requires `Authorization: Bearer <token>` (or `?token=` for EventSource clients, which cannot set headers)

## Out of scope

- Vulnerabilities in OpenCode itself → report to [opencode.ai](https://opencode.ai)
- Vulnerabilities in dependencies (e.g., `@modelcontextprotocol/sdk`) → report upstream
