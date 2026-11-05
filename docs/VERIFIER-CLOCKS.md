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
| `lifecycle.event.creation_timestamp_mismatch` | initial attempt_created occurred_at differs from either payload creation timestamp | error (warning in shadow mode) |

The initial `createWork` writer samples one `now` for `occurred_at`,
`payload.work.created_at`, and `payload.attempt.created_at`. Where all three
are valid timestamps, disagreement is a structural copy inconsistency, even
by one millisecond. No clock-skew tolerance applies to copies of one value.
This check does not cover later events or retries, and it does not require
creation fields absent from legacy payloads. It is independent of the
warning-only five-minute policy for comparisons between clocks.

Outbox severity follows the known fleet named by the row's top-level
`payload.fleet_id`, including in mixed shadow/durable ledgers. If that scope
is absent, malformed, or unknown, retain the base ledger-wide fallback:
durable if any fleet is durable, otherwise shadow if any fleet is shadow,
otherwise legacy. This does not introduce stronger treatment for old unscoped
rows. Clock diagnostics remain warnings in every mode.

Work receipt completion is caller supplied; recording is server supplied.
Neither comparison across those clocks nor a comparison to the auditor's
clock is proof that a row was forged. Inspect clock history and provenance
before deciding whether metadata needs repair.

Outbox IDs are not foreign keys into `attempt_events`. The execution bridge
queues NDJSON projection events with independent UUIDs (including fleet events).
Requiring a matching attempt-event ID would reject healthy writer output. No
`lifecycle.outbox.orphan_event` check is defined.
