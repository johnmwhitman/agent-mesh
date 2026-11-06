# Verifier metadata timestamps

Audit clocks and writer clocks may differ, especially for a ledger copied to
another host. Metadata dates alone do not establish tampering. New metadata
time diagnostics therefore warn only when the discrepancy exceeds five minutes
(300,000 milliseconds, or 300 seconds for work receipts). Equality at the
allowance is silent. Larger discrepancies remain warnings: this allowance is
an operational noise budget, not a measured bound on every host's clock error.
It accommodates small clock offsets without suppressing hour-scale anomalies.

These checks do not change writer validation, deadlines, leases, tallying or
which receipts support acknowledgement. An existing structural error retains
its severity. A warning leaves `ok: true` when there are no other errors.

| Code | Comparison | Severity |
| --- | --- | --- |
| `work_receipt.completed_after_recorded` | completed_at minus recorded_at > 300 seconds | warning |
| `work_receipt.recorded_in_future` | recorded_at minus floor(audit now / 1000) > 300 seconds | warning |
| `capability.registered_in_future` | registered_at minus audit now > 300,000 ms | warning |
| `receipt.in_future` | timestamp minus audit now > 300,000 ms | warning |
| `lifecycle.event.occurred_in_future` | occurred_at minus audit now > 300,000 ms | warning |
| `ratification.opened_in_future` | opened_at minus audit now > 300,000 ms | warning |
| `ratification.resolved_in_future` | resolved_at minus audit now > 300,000 ms | warning |
| `ratification.resolved_before_opened` | opened_at minus resolved_at > 300,000 ms | warning |
| `lifecycle.outbox.claimed_before_created` | created_at minus claimed_at > 300,000 ms | warning |
| `lifecycle.outbox.projected_before_claimed` | claimed_at minus projected_at > 300,000 ms | warning |
| `lifecycle.outbox.claimed_by_without_timestamp` | owner set, timestamp absent | error (warning in shadow mode) |
| `lifecycle.outbox.claimed_at_without_claimed_by` | timestamp set, owner absent | error (warning in shadow mode) |
| `lifecycle.outbox.invalid_claim` | populated owner blank/not text, or timestamp not a nonnegative integer | error (warning in shadow mode) |
| `lifecycle.event.creation_timestamp_mismatch` | writer-shaped initial attempt_created has a missing/invalid payload creation timestamp or either copy differs from occurred_at | error (warning in shadow mode) |

The initial `createWork` writer samples one `now` for `occurred_at`,
`payload.work.created_at`, and `payload.attempt.created_at`. Its event encoder
also writes `result_absent` and `error_absent` on both payload snapshots.
An initial event carrying any creation or outcome-presence property on either
snapshot must carry two valid creation timestamps equal to `occurred_at`.
Deleting or invalidating a copy cannot disable the check. Epoch zero is valid.
Disagreement is a structural copy inconsistency, even by one millisecond;
no clock-skew tolerance applies to copies of one value.

Legacy payloads with neither creation property and none of the four
outcome-presence properties remain exempt. This is a payload-shape discriminator,
not an authenticated writer version; storage version cannot establish event
vintage after migration. Removing every identifying property is indistinguishable
from that legacy shape and remains outside this check's detection boundary.
This check does not cover later events or retries. It is independent of the
warning-only five-minute policy for comparisons between clocks, which remains
Fable's decision.

Outbox severity follows the known fleet named by the row's top-level
`payload.fleet_id` only when supplied agent, work, attempt and event references
resolve to that fleet. Attempts resolve through their work; events also reconcile
their attempt/work relationship, and work's populated agent reference must agree.
The outbox's own ID is not a reference: its independent UUID namespace is never
required to match (or differ from) an attempt-event ID.
Fleet-only coordinator events can still select their own mode in mixed ledgers.
If scope is absent, malformed, unknown, conflicting, or cannot be corroborated
because a supplied reference is unresolved, retain the base ledger-wide fallback:
durable if any fleet is durable, otherwise shadow if any fleet is shadow,
otherwise legacy. This does not introduce stronger treatment for old unscoped
rows. This resolution selects severity only; it adds no standalone missing-reference
finding. Clock diagnostics remain warnings in every mode.

Work receipt completion is caller supplied; recording is server supplied.
Neither comparison across those clocks nor a comparison to the auditor's
clock is proof that a row was forged. Inspect clock history and provenance
before deciding whether metadata needs repair.

Outbox IDs are not foreign keys into `attempt_events`. The execution bridge
queues NDJSON projection events with independent UUIDs (including fleet events).
Requiring a matching attempt-event ID would reject healthy writer output. No
`lifecycle.outbox.orphan_event` check is defined.
