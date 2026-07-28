# Stdio Catalog-Boundary Conformance v0.1 Handoff

## State

This isolated slice is implementation-complete and independently reviewed. It
is ready for human or integrator review, not implicitly approved for merge,
release, or activation.

- Branch: `codex/a2a-blackbox-conformance-v01-20260727`
- Base: `041500fd9aec6e482875f6339236ffdcc46fc7ed`
- Owned prefix: `blackbox/a2a-conformance-v0.1/**`
- Collision check: clean against `codex-meshfleet-routing-a2a-20260727`

## What it proves

The runner exercises the built Meshfleet MCP server over stdio through the
official MCP SDK client. Two opaque synthetic profiles must observe the same
catalog, stable `ping` and `health` invariants, exact unknown-tool rejection,
and all declared schema members. A pinned full-catalog digest and comprehensive
mutation canaries prevent a shared catalog regression from passing silently.

## What it does not prove

- Full A2A protocol conformance.
- Compatibility with any named agent client or provider.
- Remote delivery, authentication, provider execution, or production safety.
- Operating-system-level network isolation.

## Acceptance

```text
node blackbox/a2a-conformance-v0.1/runner.mjs
PASS, 16 checks

npm run typecheck
PASS

git diff --check
PASS

MESHFLEET_EVENT_LOG_FILE=/tmp/meshfleet-a2a-conformance-suite-events-20260727.log npm test
PASS, 891/891
```

The initial sandboxed full-suite run reached `879/891`; its failures were
eleven localhost bind `EPERM` errors and one default-home event-log `EPERM`
error. The unrestricted loopback rerun with an explicit temporary event-log
path passed all tests.

## Review

Hume and Jason independently re-reviewed the repaired files and returned
`PASS` with no important findings. Jason noted that `--capture-baseline`
intentionally bypasses digest enforcement; that mode is not documented or
accepted as a conformance run.

## Operator notes

- `evidence/acceptance.json` is the machine-readable receipt.
- `/tmp/meshfleet-a2a-conformance-suite-events-20260727.log` is generated test
  residue and was not deleted.
- Do not infer merge, release, deployment, or activation authority from this
  handoff.
