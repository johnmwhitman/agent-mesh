# Executable Fault Suite Handoff

## State

The executable raw-stdio fault extension is implementation-complete,
acceptance-clean, and independently reviewed. It is ready for integrator
review, not implicitly approved for merge, publication, deployment, or
activation.

- Branch: `codex/a2a-blackbox-conformance-v01-20260727`
- Parent wire commit: `5136fab`
- Owned prefix: `blackbox/a2a-conformance-v0.1/**`
- Collision state: isolated from the active routing and delivery-trace lane.

## Result

Nine byte-pinned negative fixtures each produce one exact structured failure
through the real wire witness. Two independent controls prove the harness can
pass and that stderr noise does not enter the protocol stream.

The fault meta-runner, normal wire runner, typecheck, diff check, and `891/891`
full suite passed. Lorentz and Cicero returned `PASS` after the final cleanup
and fixture-binding repairs.

## Boundary

The suite proves bounded local detection for the listed fault classes. It does
not prove arbitrary child behavior, OS sandboxing, full MCP/A2A conformance,
remote transport, provider execution, or named-client compatibility.

See `evidence/acceptance.json` for the machine-readable receipt and
`README.md` for the exact cases and anti-cheating controls.
