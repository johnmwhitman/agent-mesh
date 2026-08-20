# MeshFleet public handoff

**Source version:** `0.21.1` · **MCP surface:** **37 MCP tools** ·
**current suite contract:** **1746/1746** tests collected, plus typecheck and build

The latest completed cross-platform proof is GitHub Actions run `31315444631`
at `e14bd8f` (9/9 jobs across Node 20/22/24 on Ubuntu, macOS, and Windows;
1617/1617 collected, plus typecheck, build, and CLI smoke). It proves that prior
revision, not the newer runtime and test bytes that establish the 1645-test
contract; those require their own fresh 9/9 run before merge.

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
currently refuses that selector. The shipped Claude Code and direct MiniMax
adapters are fixture-verified and disabled unless configured; MiniMax is an
explicit-only text lane with no workspace authority. Runtime and model labels are
evidence, not account, entitlement, billing, availability, or identity proof.

**What `complete` means, and what it will mean.** An agentic runtime is handed a `RESULT_PATH`
and asked to write one JSON envelope declaring `done`, `refused` or `blocked` before it stops.
A restricted text runtime receives the same outcome contract as a structured final-text envelope,
with no impossible file instruction. What the runtime declared is recorded on the agent row and
returned by `collect_results` as `result_contract`
(`ok` | `refused` | `blocked` | `artifact_missing` | `invalid` | `absent`). **This release records
that value and nothing more** — `status` is banked exactly as it was before — so callers can
measure adoption before behaviour moves. A following release makes `ok` the only value that may
bank `complete`, with an absent or invalid envelope banking `failed`. Callers wanting the stronger
guarantee today should read `status === "complete" && result_contract === "ok"`. Rows written
before this release carry no value and are never backfilled. The contract is a **declared**
outcome plus optional path existence: it is not a fabrication, effort, or quality check, and it is
not evidence that the work is correct. A caller may additionally declare `expects_artifact` on a
spawned agent: the agent is told artifacts are required, and a `done` envelope naming no produced
files is recorded `artifact_missing` instead of `ok` — a declared-output check with the same
scope limits as the rest of the contract.

**What a crash leaves behind.** A crashing server writes one journal line naming its in-flight
agents (never SQLite — the native binding is a prime suspect in any crash). The next healthy
parent start consumes that journal: rows it flips or finds `interrupted` gain a nullable
`stopped_reason` — `server_crash` when a journal record names the agent, `process_lost` when the
liveness sweep found a dead process and no record explains why. It is a FIELD, not a new status:
exhaustive status switches are untouched. An `abandoned` fleet whose every interrupted member is
`server_crash` carries the same provenance. Rows older than the field keep a null reason — honest
ignorance, never backfilled — and the applied journal is retired by rename, never deleted. A
journal-named agent still running with a live pid is left alone: in the incident that motivated
the crash handler, five of seven agents survived and delivered.

Runtime failover is implemented for bounded provider-refusal cases. The complete
end-to-end proof is fixture-scoped: deterministic stub runtimes show one refusal,
one eligible alternate launch, persisted runtime attempts, and one failover event.
It is not evidence of a live provider outage, future availability, or spend
authority. With no eligible alternate runtime, failover is a no-op. The proof is
also platform-scoped: it does not execute on Windows (see the skip inventory
below), so failover's end-to-end evidence comes from the POSIX legs of the matrix
only. Failover's unit-level spec and registry tests run on every platform.

## Platform-skipped tests (what does not run on Windows)

The suite collects the same total everywhere, but **21 tests skip on
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
| 5 | **runtime failover end-to-end** (refusal → hop → receipts, plus three negative controls) | the backup-runtime leg cannot be stubbed: the Kimi adapter scrubs its child environment by design, so the `process.execPath`+`NODE_OPTIONS` stub that serves the default runtime has no channel to the Kimi child |
| 1 | MiniMax `spawn_fleet` wiring | POSIX shell/chmod fixture; adapter behavior is covered cross-platform with `process.execPath` |
| 3 | doctor checks (two unwritable-directory cases, one PATH probe) | POSIX permission semantics / platform predicate |

The signal-semantics rows are structural platform differences and are expected to
remain skipped. The capability-contradiction tests formerly in this table now run
on every platform: their stub is `process.execPath` plus a
`NODE_OPTIONS`-required module, which reaches the default runtime's child because
that adapter inherits its environment. The failover end-to-end rows remain: their
backup-runtime leg spawns under the Kimi adapter, which deliberately scrubs its
child environment, so the same mechanism has no channel there and no
test-authorable Windows executable exists. Un-skipping them requires an
operator-facing child-environment admission feature — a product decision.
Windows coverage for failover currently ends at the unit boundary.

One prior Windows skip was a **witness defect, not a platform difference**: the
effect-key-collapse differential passed each case's raw document as a single
argv argument, and its `M51-document-too-large` case is an 87,383-character
argument — over the 32,767-character Windows `CreateProcess` command-line limit.
Both of its runners now accept a `--raw-stdin` transport and the differential
uses it automatically for payloads over 30,000 characters, so the witness
executes on every platform and the skip is retired. Transport equivalence is
proven byte-for-byte: both transports, both runners, identical output on the
offending case.

`recommend_route`, `compile_route_candidates`, and
`plan_speculative_backlog` are advisory projections. They do not execute work,
perform runtime failover, contact providers, refresh budgets, reserve capacity, or
authorize spend. Runtime execution and advisory ranking remain separate contracts.

## Current audit evidence

- The ledger fixture corpus contains **83 total** cases: **59 caught**, **14
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
  rejects shared ledger-path overrides, stale `python3` PATH resolution, and
  `better-sqlite3` native-addon load failures before any suite scan executes;
  it also imports the preflight through a proper file URL on every platform,
  including Windows path semantics.
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
- `fleet_status` now offers compact status output only as an opt-in projection;
  omitted or false preserves the prior full response bytes. The compact response
  retains fleet/agent identity, status, result-contract and crash-stop provenance,
  but deliberately omits prompts, outputs, errors, diagnostics, pids and timestamps.
  Acceptance: real MCP tests prove omitted and `compact: false` are byte-identical,
  `compact: true` is smaller, and wrong-typed opt-in values are refused. Last
  implementation SHA: `57f6d4b`. Blocker: the full verifier reached 1746/1746;
  its sole failure was a pre-existing tracked fixture in
  `test/worktree-dog.test.ts`, outside this item's file envelope. Focused MCP
  contract tests pass 21/21 after typecheck and build.
- Public authenticated A2A ingress, remote transport, and production multi-host
  coordination are out of scope for this project (scope ruling, 2026-08-02 —
  `docs/A2A-PROGRAM.md`). Additional vendor runtimes remain separate reviewed
  slices.
