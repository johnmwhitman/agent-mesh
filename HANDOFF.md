# MeshFleet public handoff

**Source version:** `0.20.0` · **MCP surface:** **36 MCP tools** ·
**clean local baseline:** **1458/1458** tests, plus typecheck and build, measured on
`b7e08e7` plus this change, in a clean worktree

Base `01f0fa0` passed 1416/1416; the parity snapshot that introduced this document
read 1422/1422 with its six contract guards. The current figure supersedes both.
This figure is no longer maintained by hand: `scripts/run-tests.mjs` measures the
suite it just ran and fails if this line disagrees with it, naming the true count.
The document can therefore be stale for at most one run.

The figure is the COLLECTED total, and every platform must collect it with zero
failures. It is not a claim that every test executes everywhere: a platform-skipped
subset does not run on `windows-2022`, so passes there are fewer than the total
while the collected count and the zero-failure requirement are identical.

## Current product boundary

MeshFleet Core is a local-first MCP coordination server. It provides fleet
lifecycle, messaging and receipts, ratification, capability routing, health,
discussions, templates, advisory route projection, and read-only ledger
verification. The default worker runtime is OpenCode. A caller may select another
operator-registered runtime per agent in legacy lifecycle mode; durable mode
currently refuses that selector. The shipped Claude Code adapter is
fixture-verified and disabled unless configured. Runtime and model labels are
evidence, not account, entitlement, billing, availability, or identity proof.

Runtime failover is implemented for bounded provider-refusal cases. The complete
end-to-end proof is fixture-scoped: deterministic stub runtimes show one refusal,
one eligible alternate launch, persisted runtime attempts, and one failover event.
It is not evidence of a live provider outage, future availability, or spend
authority. With no eligible alternate runtime, failover is a no-op. The proof is
also platform-scoped: it does not execute on Windows (see the skip inventory
below), so failover's end-to-end evidence comes from the POSIX legs of the matrix
only. Failover's unit-level spec and registry tests run on every platform.

## Platform-skipped tests (what does not run on Windows)

The suite collects the same total everywhere, but **22 tests skip on
`windows-2022`**, consistent across Node 20, 22, and 24. Every skip is a
deliberate `process.platform === "win32"` (or equivalent) predicate, not flake.
This repository's own rule is that a test that does not run is indistinguishable
from a test that passes, so the subset is published rather than tolerated
silently:

| Count | Subset | Stated reason |
|---|---|---|
| 3 | ledger SIGKILL/checkpoint storm recovery | POSIX signals are required |
| 7 | local process adapter signal semantics (SIGTERM escalation, process-group termination, cancellation races) | Windows `TerminateProcess` cannot deliver a catchable SIGTERM |
| 2 | Kimi adapter descendant process-group kill | Windows does not expose process-group signal semantics |
| 5 | **runtime failover end-to-end** (refusal → hop → receipts, plus three negative controls) | needs an executable stub; `spawn` refuses `.cmd` without a shell and a test cannot author a `.exe` |
| 2 | capability-contradiction refusal through the published tool | same executable-stub limitation |
| 3 | doctor checks (two unwritable-directory cases, one PATH probe) | POSIX permission semantics / platform predicate |

The signal-semantics rows are structural platform differences and are expected to
remain skipped. The executable-stub rows (7 tests, including the failover
end-to-end proof) are a test-harness limitation rather than a product one — a
Windows-launchable stub would let them run, and that remains open work. Windows
coverage for failover currently ends at the unit boundary.

`recommend_route`, `compile_route_candidates`, and
`plan_speculative_backlog` are advisory projections. They do not execute work,
perform runtime failover, contact providers, refresh budgets, reserve capacity, or
authorize spend. Runtime execution and advisory ranking remain separate contracts.

## Current audit evidence

- The ledger fixture corpus contains **79 total** cases: **55 caught**, **14
  anomalies**, and 10 deliberately undetectable. `test/fixtures/corpus/README.md`
  and its generated manifest are the count authorities.
- `test/blackbox-corpus-transcript-integrity.test.ts` independently discovers the
  handoff-quorum and policy-replay witnesses, runs their complete JSON transcripts,
  canonicalizes them, and verifies their published transcript digests. Mutation
  controls prove transcript and pin changes fail.
- `test/wait-until.test.ts` proves the lifecycle test wait uses observable state
  with a monotonic safety ceiling, including completion beyond the former fixed
  two-second budget.
- `test/run-tests-ledger-env-preflight.test.ts` proves the full-suite launcher
  rejects shared ledger-path overrides and imports the preflight through a proper
  file URL on every platform, including Windows path semantics.
- `test/success-carries-no-error.test.ts` proves successful agents do not persist
  raw stderr as `Agent.error`; bounded normalized diagnostics remain available.

## Compatibility boundaries

- The canonical inbound server is the packaged stdio command documented in
  `README.md` and `mcp.json`. Client snippets are documentation examples, not
  generated configuration.
- The canonical A2A codec, local-admission evaluator, delivery-trace witness, and
  two-host coordinator witness are offline conformance evidence. They do not ship
  public authenticated A2A ingress, a network transport, or a production
  multi-host coordinator.
- RoutePlane and caller-supplied budget snapshots can inform advisory candidates.
  MeshFleet does not own provider catalogs, credentials, balances, or execution
  through those projections.

## Next public work

- Keep documentation and contract guards tied to source paths and generated
  evidence, not session history.
- Add compact status output only as an opt-in projection; preserve current output
  bytes by default.
- Treat public authenticated A2A ingress, remote transport, production multi-host
  coordination, and additional vendor runtimes as separate reviewed slices.
