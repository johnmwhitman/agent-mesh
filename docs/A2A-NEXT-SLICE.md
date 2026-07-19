# A2A Next Slice: Crash-Safe Attempt Lifecycle

Status: **contract only; not implemented**

This document bounds the next distributed-safety slice after the single-host
retry, recovery, event-log, and SQLite work. It is an implementation contract,
not evidence that the package is ready for multi-host execution. Until this
slice and its follow-on coordination work are implemented and verified, Agent
Mesh remains single-host.

## Current limits

The current package has:

- SQLite-backed state with same-host process write exclusion through the existing
  transaction seam.
- Retry behavior with an in-process backoff handle and a bounded attempt count.
- Recovery that identifies interrupted work from persisted running state and PID
  liveness.
- A separate NDJSON event log for observability.

The current package does **not** have:

- A safe multi-host coordinator or cross-host ownership protocol.
- A durable `attempt_id` that identifies one execution independently of a worker
  process.
- A lease owner epoch or fencing token that makes an older owner stale.
- A transactional lifecycle event stream tied atomically to state changes.
- Persisted cancellation state that revokes work and prevents later retry.

SQLite WAL and `BEGIN IMMEDIATE` solve same-host database write exclusion; they do
not establish ownership across hosts. A live PID is evidence about one local
process, not proof that its attempt still owns the right to settle durable state.

## Contract boundary

The slice consumes the existing agent lifecycle and MCP APIs. It may add internal
storage and implementation helpers, but existing MCP tool names, accepted inputs,
and return shapes remain backward-compatible. No caller should need to understand
lease internals to use the current APIs.

The durable lifecycle is modeled per logical work item as attempts:

```text
pending -> running -> {succeeded | failed | cancelled}
             |
             +-> expired -> retryable pending
```

`expired` is a recovery decision, not a terminal public result. A retry creates a
new attempt identity and never reuses the old attempt's authority.

## Durable state

Each attempt must persist these fields before work can be considered owned:

| Field | Contract |
|---|---|
| `attempt_id` | Unique, immutable identity for one execution attempt. A retry gets a new value. |
| `owner_id` | Stable identity of the worker instance that currently owns the attempt. |
| `lease_until` | Durable expiry time. Ownership is valid only while the lease has not expired. |
| `owner_epoch` | Monotonically increasing fencing value for the logical work item. A newer owner invalidates older epochs. |
| `status` | Lifecycle state; terminal states cannot transition back to running. |
| `cancelled_at` | Durable cancellation marker when cancellation has been accepted. |
| `terminal_at` | Time at which a terminal settlement was committed, when applicable. |
| `result` / `error` | Existing outcome data, written only by an accepted terminal settlement. |

The logical work item must also retain enough identity to link retries and
cancellation to the same requested work without treating an OS PID as that
identity.

## Invariants

1. **Single active lease.** At most one `(owner_id, owner_epoch)` may hold the
   active lease for a logical work item at a time.
2. **Fencing.** Every state mutation from a worker, including terminal settlement,
   must match `attempt_id`, `owner_id`, `owner_epoch`, and an unexpired lease. A
   stale attempt is rejected without changing terminal state or emitting a
   successful settlement event.
3. **Monotonic epochs.** Acquiring or replacing ownership increases
   `owner_epoch`; epochs never decrease or repeat for one logical work item.
4. **Terminal immutability.** `succeeded`, `failed`, and `cancelled` are terminal.
   Late completion, retry, lease renewal, or recovery cannot reopen them.
5. **Cancellation wins.** Once cancellation commits, the active lease is revoked,
   no new retry may be scheduled, and a late worker completion cannot settle the
   cancelled work.
6. **Atomic lifecycle recording.** A lifecycle state change and its corresponding
   event are committed in the same SQLite transaction or neither is visible.
7. **Monotonic event sequence.** Each committed lifecycle event has a database-
   allocated sequence that is strictly increasing in replay order. Restart and
   concurrent same-host writers must not create duplicate or skipped committed
   sequence values.
8. **Recovery by lease.** Recovery reclaims only attempts whose durable lease has
   expired (and whose state is non-terminal). PID absence may be diagnostic, but
   PID liveness alone cannot prevent or authorize recovery.
9. **Retry separation.** A retry cannot inherit settlement authority from the
   expired attempt; it receives a new `attempt_id` and fencing epoch.
10. **Backward compatibility.** Existing MCP calls continue to return their
    documented shapes; lifecycle metadata may be additive only where the existing
    compatibility contract permits it.

## Transactional event contract

Lifecycle events are SQLite rows in the same transaction as the state mutation.
The minimum event shape is:

```text
seq, event_id, work_id, attempt_id, owner_epoch, kind, occurred_at, payload
```

Required event kinds are `attempt_created`, `lease_acquired`, `lease_expired`,
`attempt_retried`, `attempt_succeeded`, `attempt_failed`, and
`attempt_cancelled`. Event payloads must be sufficient to replay the lifecycle
without consulting a process or PID. The existing human-facing event log may
remain as a projection, but it is not the source of transactional truth.

## Cancellation and recovery rules

Cancellation is a durable transition, not an in-memory flag. The cancellation
transaction must mark the logical work item cancelled, revoke its active lease,
and append `attempt_cancelled` before returning success.

On restart, recovery scans durable non-terminal attempts and compares
`lease_until` with the current clock. An expired attempt is fenced and moved to
retryable pending or terminal failure according to the caller's existing retry
policy. A non-expired attempt is left owned, regardless of whether its PID can
be inspected from the recovering process.

## Acceptance tests

The implementation is accepted only when focused tests prove all of the
following against a temporary SQLite database:

1. **Stale settlement is fenced.** Owner A's expired or superseded attempt cannot
   settle after owner B acquires a higher epoch; the durable result and event
   stream contain only B's accepted settlement.
2. **Cancellation is final.** Cancellation revokes the active lease, blocks retry,
   and rejects both a late completion and a lease renewal from the old owner.
3. **Retry identities are distinct.** Recovery of an expired attempt creates a
   new `attempt_id` and epoch while preserving the logical work-item identity.
4. **Lifecycle events are atomic.** A forced transaction failure leaves neither
   the state transition nor its lifecycle event visible.
5. **Replay survives restart.** Close and reopen the database, replay events by
   monotonic `seq`, and reconstruct the same lifecycle and terminal result.
6. **Lease-based recovery.** A live local PID does not protect an expired lease,
   and a dead or unavailable PID does not reclaim a non-expired lease.
7. **Terminal immutability.** Duplicate, late, and conflicting terminal writes are
   rejected or idempotently ignored without a second terminal event.
8. **MCP compatibility.** Existing MCP compatibility and stdio tests continue to
   pass with unchanged tool names, input contracts, and return shapes.

## Non-goals

- Implementing a multi-host coordinator, network lease service, or cloud relay.
- Claiming cross-host SQLite safety or multi-host readiness.
- Adding a new transport, worker runtime, or provider-specific coordination API.
- Replacing the existing MCP protocol or changing its public tool contracts.
- Treating PID checks, heartbeats, or process-local timers as durable ownership.
- Building cryptographic message-chain verification or external timestamp anchoring.
- Solving global exactly-once execution. The contract fences stale settlement; it
  does not make external side effects exactly once.
- Publishing, deploying, changing credentials, or activating remote workers.

## Completion bar for this slice

This document is complete when the implementation, focused acceptance tests,
backward-compatibility tests, and a review of the SQLite migration path all agree
with the state fields and invariants above. Until then, roadmap language must
describe this as a planned contract only, never as distributed or multi-host
capability.
