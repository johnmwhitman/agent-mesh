# MCP Registry — claiming the meshfleet namespace

Runbook for listing this server on the **official MCP registry** (registry.modelcontextprotocol.io).
Steps marked **[HUMAN]** are identity-bound — they require John's GitHub login or DNS control and
cannot be done by an agent. Registry mechanics move fast: re-check the current docs at
[github.com/modelcontextprotocol/registry](https://github.com/modelcontextprotocol/registry) before executing.

## What to register

- **Namespace**: `io.github.johnmwhitman` (reverse-DNS). GitHub-based namespaces are verified by
  authenticating the publisher CLI with the matching GitHub account; custom domains (e.g.
  `app.meshfleet/*`) verify via DNS or HTTP challenge instead. GitHub is the low-friction path here.
- **Server name**: `io.github.johnmwhitman/meshfleet`
- **Package**: npm `meshfleet` (the registry cross-checks that the npm package references the
  registry name — current mechanism is an `mcpName` field in `package.json`; **verify the exact
  requirement against current registry docs**, and note `package.json` edits are outside a
  docs-only lane).

## Metadata to submit

- One-liner: **"Your agents did the work. Prove it."**
- Description: local-first MCP server for multi-agent coordination — parallel fleets, P2P
  messaging, witnessed receipts, quorum councils, and ledger consistency checking. (Do **not**
  claim tamper-evidence or attestation — the free core does unsigned consistency checking only.)
- Repository: https://github.com/johnmwhitman/agent-mesh · Homepage: https://meshfleet.app
- Transport: stdio · Invocation: `npx -y meshfleet`

## Checklist

- [ ] Read current publishing guide in the registry repo (process has changed before; expect drift)
- [ ] Install the registry publisher CLI (`mcp-publisher` at last check — verify current name)
- [ ] **[HUMAN]** Authenticate the publisher CLI via GitHub as `johnmwhitman`
- [ ] Draft `server.json` (name, description, package, transport) per the current schema
- [ ] If npm-side proof (e.g. `mcpName`) is required: stage the `package.json` change for a
      normal code-lane release — **not** this docs branch — then publish to npm first
- [ ] **[HUMAN]** Run the publish command; confirm the entry appears in the registry API
- [ ] Add a registry badge/link to README only after the listing is live and verified

## Other directories (secondary; verify current submission process — landscape moves fast)

- **Smithery** (smithery.ai) — verify current submission process
- **PulseMCP** (pulsemcp.com) — verify current submission process
- **Glama MCP directory** (glama.ai/mcp/servers) — verify current submission process

Uncertainty note: everything above about *mechanics* (CLI name, `mcpName`, challenge types) was
accurate as of writing but is the least stable part of this doc. The identity facts (GitHub org,
npm package name, one-liner) are the stable part. When in doubt, the registry repo's docs win.

## Alternate-namespace and name-squat audit (checked 2026-09-05)

Before submitting under the canonical `io.github.johnmwhitman/meshfleet` namespace, the
operator should verify that no name conflict has appeared on the npm side or under a
near-miss registry handle. The following was observed today; re-run before each publish:

| npm name | status | note |
|---|---|---|
| `meshfleet` | live, `meshfleet@0.20.0` published 2026-07-31 | candidate package; 0.20.0 currently lacks `mcpName`, which must be added only in a deliberately reviewed future npm artifact |
| `agent-mesh` | unrelated reserved placeholder, `agent-mesh@0.0.1` description `Agent Mesh - Reserved` | not the MeshFleet distribution; do NOT bind the registry to this name |
| `mesh-fleet`, `meshfleet-mcp`, `meshfleet-core`, `meshfleet-server`, `@meshfleet/server`, `agent-mesh-core` | unclaimed (404 from `npm view`) | free for an emergency fallback; not selected for the canonical binding |

Official MCP Registry search for `meshfleet` (2026-09-05): zero entries.
Namespacing remains under operator control; no auth/identity step performed by this audit.
Submitting the canonical `io.github.johnmwhitman/meshfleet` listing is a separate
**HUMAN** step — see checklist above. The current packet does NOT register or authenticate;
it documents the binding decision so the operator can publish without re-deriving it.
