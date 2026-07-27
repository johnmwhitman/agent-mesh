# Raw Stdio Wire Handoff

## State

The SDK-independent raw stdio witness is implementation-complete,
acceptance-clean, and independently reviewed. It is ready for integrator
review, not implicitly approved for merge, publication, deployment, or
activation.

- Branch: `codex/a2a-blackbox-conformance-v01-20260727`
- Parent slice commit: `182a2ad`
- Owned prefix: `blackbox/a2a-conformance-v0.1/**`
- Collision state: isolated from the active routing lane.

## Result

Two complementary raw stdio profiles completed the official MCP
initialize/initialized lifecycle, ping, catalog listing, read-only health
probe, and exact unknown-tool rejection without importing the MCP SDK. Both
observed catalog digest
`4d0289400e23c57b1e43347eb9d8f9258decf7b824516e0d066380d7e6f88fa8`.

The final wire run, typecheck, diff check, and `891/891` full suite passed.
Twenty-four fail-closed mutation cases exercise the same parser, correlator,
outbound validator, and byte serializer used by the live path. Aristotle and
Ptolemy returned `PASS` after final repair.

## Boundaries

This evidence supports the local raw stdio framing and catalog/read-only
boundary only. It does not prove full MCP/A2A conformance, named-client
compatibility, provider execution, remote transport, authentication, or
OS-level sandboxing.

See `evidence/acceptance.json` for the machine-readable receipt and
`README.md` for execution and protocol basis.
