# Meshfleet stdio catalog-boundary conformance v0.1

This package is a bounded black-box check of the locally built Meshfleet stdio
catalog. It is not multi-client conformance and it is not full A2A conformance.

`runner.mjs` starts the required local `dist/index.js` once for each of two
opaque synthetic profiles. Each child has a fresh temporary working directory,
home, temporary directories, configuration/cache/data directories, database,
and event log. It receives `AGENT_MESH_CHILD=1` and
`MESHFLEET_RATIFY_SWEEP_MS=0`. It uses the repository's installed official MCP
SDK only; it never installs packages, builds the server, or falls back to npm
or the network.

Run from the repository root:

```sh
node blackbox/a2a-conformance-v0.1/runner.mjs
```

The runner emits exactly one JSON result and exits nonzero if any check fails.
It removes each temporary profile directory in `finally` and closes each client.

## What it checks

- `manifest.json` is fail-closed validated before any child is started.
- Each synthetic profile lists the tool catalog.
- Tool contracts are recursively key-canonicalized, with tools sorted by name
  and all other array order preserved; canonical contracts and SHA-256 digests
  must match the manifest-pinned complete catalog digest.
- The normative family-to-tool map and advertised `inputSchema.properties` are
  present. These are catalog-advertised members, not assertions about a JSON
  Schema `required` array.
- `ping` and `get_health` satisfy the stable, empty-store invariants in the
  manifest. Volatile fields are named there and intentionally ignored whenever
  present; their absence is also permitted.
- An unknown tool is rejected with the same normalized rejection kind.
- In-memory mutation canaries prove object-key and tool-order invariance, and
  prove required-tool removal and schema mutation are detected.

## Deliberate limits

The runner configures no network and does not claim OS-level network blocking.
Child mode prevents the server's recovery, ratification sweeper, and SSE
listener; the runner also invokes no provider-capable tool. It does not write
messages or ratifications and does not spawn agents: black-box setup cannot
create actors without a provider launch. No generated evidence belongs in this
directory yet.
