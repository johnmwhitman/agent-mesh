# Packaged Boundary Handoff

## State

The packaged-artifact extension is implementation-complete, acceptance-clean,
and independently reviewed. It is ready for integrator review, not implicitly
approved for merge, publication, deployment, or activation.

- Branch: `codex/a2a-blackbox-conformance-v01-20260727`
- Parent slice commit: `7340551`
- Owned prefix: `blackbox/a2a-conformance-v0.1/**`
- Other active routing lane remained outside this prefix.

## Result

A local npm tarball was installed into a fresh offline consumer. The installed
package's published entrypoints stayed inside that consumer, direct dependency
versions matched the trusted lock, the client SDK resolved from the consumer,
and the installed server reproduced catalog digest
`4d0289400e23c57b1e43347eb9d8f9258decf7b824516e0d066380d7e6f88fa8`.

The final package run, parent run, typecheck, diff check, and `891/891` full
suite passed. Curie and Halley returned `PASS` after the final repair round.

## Important evidence boundary

The fresh consumer resolved ten transitive packages differently from the
repository lock while preserving the tested behavior. This is recorded, not
hidden. Direct specs and direct versions are required to match; transitive
resolution remains advisory because the published package uses ranges.

The native `better-sqlite3` binding also requires an explicit offline source
rebuild after the script-free install. Passing therefore requires a local
native toolchain and is not evidence of hermetic or script-free production
readiness.

See `evidence/acceptance.json` for the machine-readable receipt and
`README.md` for execution and nonclaims.
