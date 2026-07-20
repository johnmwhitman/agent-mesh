# Seamless A2A Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the inherited verifier changes honest and prove that the existing MCP stdio server is a portable inbound coordination port for Claude Code, Codex, OpenCode, and generic MCP clients.

**Architecture:** Preserve `agent-mesh` as the durable coordination core. Harden receipt and runtime-identity verification without claiming an unimplemented cryptographic chain, then test the packaged MCP stdio boundary end to end. This slice does not add multi-host execution, a new transport, or a worker-runtime abstraction.

**Tech Stack:** TypeScript, Node.js test runner, `@modelcontextprotocol/sdk`, SQLite-backed Meshfleet ledger, MCP JSON-RPC over stdio.

## Global Constraints

- Preserve every existing MCP tool name and return shape.
- Keep stdout protocol-only; diagnostics belong on stderr.
- A receipt may contribute to derived acknowledgement only after its key, message reference, action, recipient, and timestamp are valid.
- Capability advertisement is not authority and runtime model strings must use the same provider-prefix normalization as spawn-result classification.
- Do not claim cryptographic message-chain verification until the write path creates a typed, anchored chain.
- This release remains single-host; SQLite files must not be shared across hosts.
- No publish, deploy, credential changes, external messaging, or remote activation.

---

### Task 1: Make inherited verifier checks fail closed without overclaiming

**Files:**
- Modify: `src/verify.ts`
- Modify: `src/spawn-result.ts`
- Modify: `src/core.ts`
- Modify: `src/index.ts`
- Modify: `src/inspector.ts`
- Modify: `test/tampered-fixtures.test.ts`
- Modify: `test/spawn-result.test.ts`
- Delete: `test/fixtures/tampered-crypto.json`
- Modify: `ROADMAP.md`

**Interfaces:**
- Consumes: `Message`, `Receipt`, `MeshData`, and runtime banners already produced by `classifySpawnResult()`.
- Produces: `runtimeModelsMatch(expected?: string, observed?: string): boolean` and acknowledgement derivation based only on structurally valid receipts.

- [ ] **Step 1: Write failing verifier tests**

Add tests proving that a receipt timestamped before its message cannot support `acknowledged=true`, provider-qualified and unqualified forms of the same model do not mismatch, timestamp `0` is validated, and the verifier no longer advertises an unimplemented crypto-chain check.

```ts
test("an invalid early ack cannot prove acknowledgement", () => {
  const report = verifyMeshData(fixtureWithEarlyAckAndAcknowledgedFlag())
  assert.ok(report.findings.some((f) => f.check === "message.ack_flag_mismatch"))
})

test("provider prefixes do not create a runtime identity mismatch", () => {
  assert.equal(runtimeModelsMatch("claude-sonnet-4", "anthropic/claude-sonnet-4"), true)
})
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test --import tsx test/tampered-fixtures.test.ts test/spawn-result.test.ts`

Expected: at least the early-ack and exported-normalizer tests fail before implementation.

- [ ] **Step 3: Implement validated receipt derivation and shared model normalization**

Build a `Set<string>` of validated ack receipt keys during the receipt pass. A receipt enters the set only when its dictionary key matches its fields, its message exists, its action is `ack`, the actor is an addressed recipient (or the legacy `*` migration placeholder), and its timestamp is not before the message. Make `derivedAcknowledged()` consult this set.

Export one model comparison helper from `spawn-result.ts`:

```ts
export function runtimeModelsMatch(expected?: string, observed?: string): boolean {
  if (!expected || !observed) return false
  const leaf = (value: string) => value.toLowerCase().split("/").at(-1)
  return leaf(expected) === leaf(observed)
}
```

Use explicit `!== undefined` timestamp checks. Remove `createHash`, `message.broken_crypto_chain`, its explanation, its fixture, and its test. Keep runtime metadata capture and honest mismatch detection.

- [ ] **Step 4: Correct roadmap status**

Leave the requested/resolved runtime-identity item unchecked until requested model identity is represented separately. Describe the inherited work as resolved runtime identity capture only.

- [ ] **Step 5: Run focused and full tests**

Run: `node --test --import tsx test/tampered-fixtures.test.ts test/spawn-result.test.ts test/verify.test.ts test/inspector-verify.test.ts`

Expected: all focused tests pass.

Run: `npm test`

Expected: `408` or more tests pass with zero failures outside sandbox restrictions.

- [ ] **Step 6: Commit**

```bash
git add src/verify.ts src/spawn-result.ts src/core.ts src/index.ts src/inspector.ts test/tampered-fixtures.test.ts test/spawn-result.test.ts test/fixtures/tampered-identities.json test/fixtures/tampered-timestamps.json ROADMAP.md
git commit -m "fix: harden runtime and receipt verification"
```

### Task 2: Prove the universal MCP stdio inbound port

**Files:**
- Create: `test/mcp-stdio.test.ts`
- Create: `test/mcp-config.test.ts`
- Modify: `mcp.json`
- Modify: `README.md`
- Modify: `COMPATIBILITY.md`
- Modify: `AGENT-MESH-SPEC.md`

**Interfaces:**
- Consumes: the packaged `meshfleet` executable and existing MCP tool registry in `src/index.ts`.
- Produces: a process-level MCP handshake test and documented host-neutral configuration using `npx -y meshfleet`.

- [ ] **Step 1: Write failing config and stdio tests**

The config test parses `mcp.json` and requires:

```ts
assert.equal(config.command, "npx")
assert.deepEqual(config.args, ["-y", "meshfleet"])
```

The stdio test spawns the package entrypoint, creates an MCP `Client` with `StdioClientTransport`, calls `initialize` through `connect()`, lists tools, and requires at least `spawn_fleet`, `route_work`, `send_message`, and `get_health`. Close the client in `finally` and fail if stdout contains non-protocol output.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test --import tsx test/mcp-config.test.ts test/mcp-stdio.test.ts`

Expected: config assertion fails until `mcp.json` uses `-y`; handshake failures identify any stdio contamination.

- [ ] **Step 3: Standardize configuration and documentation**

Set the reusable host-neutral launch form:

```json
{
  "command": "npx",
  "args": ["-y", "meshfleet"]
}
```

Document Claude Code, Codex, OpenCode, and generic MCP clients as callers of the same stdio server. State clearly that this proves inbound client interoperability only; spawned workers still use OpenCode. Clarify that SSE inbox subscription is optional acceleration and not required for compatibility. Correct stale version, JSON-storage, and OpenCode-only statements in the specification.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test --import tsx test/mcp-config.test.ts test/mcp-stdio.test.ts test/dispatch-registry.test.ts test/compat-fixtures.test.ts`

Expected: all focused tests pass.

Run: `npm test`

Expected: all tests pass with zero failures outside sandbox restrictions.

- [ ] **Step 5: Commit**

```bash
git add test/mcp-stdio.test.ts test/mcp-config.test.ts mcp.json README.md COMPATIBILITY.md AGENT-MESH-SPEC.md
git commit -m "test: prove host-neutral MCP stdio port"
```

### Task 3: Record the next distributed-safety slice

**Files:**
- Modify: `ROADMAP.md`
- Create: `docs/A2A-NEXT-SLICE.md`

**Interfaces:**
- Consumes: current single-host retry, recovery, event-log, and SQLite behavior.
- Produces: the bounded contract for durable attempts, leases, fencing, transactional events, and cancellation.

- [ ] **Step 1: Document current limits**

State that the current package has no safe multi-host coordinator, lease owner epoch, durable attempt identity, transactional event stream, or cancellation state.

- [ ] **Step 2: Define the next state-machine slice**

Specify durable `attempt_id`, `owner_id`, `lease_until`, `owner_epoch`, and terminal settlement checks; transactional SQLite lifecycle events with monotonic sequence; cancellation that revokes the active lease; and recovery based on expired leases rather than PIDs alone.

- [ ] **Step 3: Add acceptance criteria**

Require tests proving stale attempts cannot settle, cancellation blocks retry and late completion, lifecycle replay survives restart, and current MCP APIs remain backward-compatible.

- [ ] **Step 4: Commit**

```bash
git add ROADMAP.md docs/A2A-NEXT-SLICE.md
git commit -m "docs: bound the crash-safe attempt lifecycle"
```

### Task 4: Reconcile inherited inspector JSON and package metadata

**Files:**
- Modify: `src/bin/inspect.ts`
- Modify: `test/inspector-json.test.ts`
- Modify: `package-lock.json`
- Commit: `docs/superpowers/plans/2026-07-19-seamless-a2a-foundation.md`

**Interfaces:**
- Consumes: existing `--json` mode, `getReceipts()`, `getFleetMetrics()`, and `readEventLog()`.
- Produces: parseable JSON for fleet detail, receipts, metrics, and events without changing text output.

- [x] **Step 1: Add focused JSON contract tests**

Test that each inherited mode emits exactly one parseable JSON document with a stable top-level shape and no provisional prose mixed into stdout. Test the not-found fleet path returns exit code `1` and a parseable JSON error.

- [x] **Step 2: Run focused tests and confirm behavior**

Run: `node --test --import tsx test/inspector-json.test.ts`

Expected: tests expose any unstable or prose-contaminated inherited output.

- [x] **Step 3: Complete the minimal implementation**

Keep text mode byte-compatible. Use named schema envelopes for every JSON surface rather than exposing an unversioned raw object where practical. Keep errors on a single JSON stdout document when `--json` is active.

- [x] **Step 4: Reconcile package metadata**

Keep the root `package-lock.json` package version equal to `package.json` (`0.14.0`). Do not change dependencies.

- [x] **Step 5: Run focused and full tests**

Run: `node --test --import tsx test/inspector-json.test.ts`

Expected: all focused tests pass.

Run: `npm test`

Expected: all tests pass with zero failures outside sandbox restrictions.

- [x] **Step 6: Commit**

```bash
git add src/bin/inspect.ts test/inspector-json.test.ts package-lock.json docs/superpowers/plans/2026-07-19-seamless-a2a-foundation.md
git commit -m "feat: complete machine-readable inspector output"
```
