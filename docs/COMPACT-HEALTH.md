# Compact health checks

Use summary health for routine checks without returning hundreds of module
hashes to the client. The server still re-hashes every manifest entry on each
call. Full responses remain the default for existing integrations.

## Start from the portable archive

With Node 24 and the `meshfleet-0.21.3.tgz` archive in an empty directory:

```sh
npm install --omit=dev --no-audit --no-fund ./meshfleet-0.21.3.tgz
node -p "require('meshfleet/package.json').version"
```

The version should be `0.21.3`. This installs the local archive; it does not
claim that this version is available from the npm registry.

Configure your MCP client to launch `npx --no-install meshfleet` from that
installation directory. See the [client setup examples](../README.md#wiring-it-into-your-client).
For an isolated rehearsal, set **all three** server environment variables to
files in a fresh directory: `MESHFLEET_DB_FILE`, `MESHFLEET_DATA_FILE`, and
`MESHFLEET_EVENT_LOG_FILE`. Keep those paths identical in clients participating
in the same rehearsal. This separates rehearsal data from existing fleets.

## Ask the running server

Call `get_health` with these MCP arguments:

```json
{"verbosity":"summary"}
```

Require `status: "ok"`, `build_identity.status: "ok"`, and
`build_identity.entrypoints_match_runtime: true`. Read the version and
`source_commit` from that response and compare them to the artifact you installed.
An `absent`, `unreadable`, or `mismatch` identity is not verified installation.

Summary omits only `build_identity.entrypoints`; the entry count, source identity
and integrity verdict remain. Use `get_build_identity({})` to inspect the full
hash map, or `get_health({"verbosity":"full"})` for the full health response.
An unknown verbosity is an error.

This reduces response bytes, not the server's integrity work. A successful health
check proves neither worker quality nor task delivery: verify the actual worker
result and its durable receipt separately.
