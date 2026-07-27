# Raw Stdio Wire Witness v0.1

This dependency-free Node runner speaks MCP JSON-RPC directly over stdio. It
does not import the MCP SDK. The wire contract follows the official MCP
2025-11-25 stdio rules: one UTF-8 JSON-RPC object per LF-delimited line,
protocol traffic only on stdout, optional diagnostics on stderr, and the
initialize/initialized lifecycle before normal requests.

```sh
npm run build
node blackbox/a2a-conformance-v0.1/wire/runner.mjs
```

The witness runs two complementary synthetic profiles:

- Fragmented initialize bytes followed by coalesced post-initialize messages.
- Coalesced initialize followed by fragmented post-initialize messages.

Both profiles perform initialize, `notifications/initialized`, ping,
`tools/list`, read-only `get_health`, and an unknown-tool rejection. The
catalog must match the established SHA-256 pin.

## Fail-closed coverage

The fixture suite exercises the same parser, correlator, outbound validator,
and canonical serializer used by the live path. It includes red cases for:

- Stdout pollution, blank lines, CRLF, malformed UTF-8, oversized lines, and
  trailing partial frames.
- Wrong, duplicate, and orphan response IDs.
- Notification IDs and invalid outbound envelope shapes.
- Non-empty ping results and unknown-tool error-shape drift.
- Duplicate/non-ASCII tool names or keys, unsafe numbers, negative zero, lone
  surrogates, catalog-envelope drift, tool-order changes, and schema changes.

## Evidence boundary

- This is a raw local stdio witness, not full MCP or A2A conformance.
- It is not named-client or provider compatibility evidence.
- It does not invoke provider-capable or state-mutating tools.
- Process-local temp isolation is not an OS network/filesystem sandbox.
- The digest is an explicit domain-specific byte contract, not general JSON
  canonicalization.

Protocol basis:
`https://modelcontextprotocol.io/specification/2025-11-25/basic/transports`
and
`https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle`.
