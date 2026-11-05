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
| `lifecycle.outbox.claimed_before_created` | created_at minus claimed_at > 300,000 ms | warning |
| `lifecycle.outbox.projected_before_claimed` | claimed_at minus projected_at > 300,000 ms | warning |
| `lifecycle.outbox.claimed_by_without_timestamp` | owner set, timestamp absent | error (warning in shadow mode) |
| `lifecycle.outbox.claimed_at_without_claimed_by` | timestamp set, owner absent | error (warning in shadow mode) |
| `lifecycle.outbox.invalid_claim` | populated owner blank/not text, or timestamp not a nonnegative integer | error (warning in shadow mode) |

Work receipt completion is caller supplied; recording is server supplied.
Neither comparison across those clocks nor a comparison to the auditor's
clock is proof that a row was forged. Inspect clock history and provenance
before deciding whether metadata needs repair.
