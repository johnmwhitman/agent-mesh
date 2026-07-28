# Agent Lifecycle Timestamp Validity Design

**Priority:** 2 — ensure audits and public claims are true.

## Problem

`Agent.started_at` and `Agent.completed_at` are optional finite-number epoch
milliseconds by type and by every ordinary writer. The JSON and SQLite ledger
paths preserve parsed JSON values without runtime field validation.

The verifier currently applies JavaScript `<` directly to present values. A
JSON-persistable string such as `"bad"` can therefore evade every timestamp
check and leave a terminal row audit-clean. Values such as `null` or coercible
numeric strings can instead manufacture misleading `agent.tampered_timestamp`
findings. Missing timestamps are supported legacy state and must remain valid.

## Contract

Add `agent.invalid_timestamp` as an error for each present `started_at` or
`completed_at` value that does not satisfy `Number.isFinite`.

- `undefined` means absent and remains valid.
- Finite numbers, including zero, are valid operands.
- Strings, `null`, `NaN`, and infinities are invalid. Do not coerce them.
- Validate `started_at` before `completed_at`.
- When both are invalid, emit two findings in that order. Both use the agent ID
  as subject; the field name is explicit in each detail.
- Invalid timestamp values cannot participate in start-before-fleet,
  completion-before-fleet, or completion-before-start comparisons.

The exact details are:

- `agent <id> has a present but non-finite started_at timestamp`
- `agent <id> has a present but non-finite completed_at timestamp`

Keep `agent.completed_while_live` independent. A present invalid completion
field still blocks the ordinary completion writer and leaves a live row
claiming a completion marker, so that existing contradiction remains useful.
An orphan agent receives its existing warning in addition to any
fleet-independent invalid-timestamp error.

## Ordering

Within one agent row, findings remain deterministic:

1. key mismatch;
2. invalid `started_at`;
3. invalid `completed_at`;
4. orphan-fleet warning or known-fleet ordering checks;
5. completion-before-start;
6. completion-while-live.

Valid operands retain the existing relative-order checks and their exact
details. An absent start plus a valid completion before fleet creation must
still emit `agent.tampered_timestamp`.

## Proof

Unit tests cover each optional field with absent, zero, finite, `null`, numeric
string, nonnumeric string, `NaN`, and infinities. They also pin:

- two invalid fields produce two ordered invalid findings;
- invalid operands produce no coercion-derived tampered finding;
- an orphan still receives invalid plus orphan findings;
- the prior absent-start/valid-early-completion rule remains active.

The generated corpus gains two caught vectors, one setting `started_at` to
`null` and one setting `completed_at` to `null`. Each must produce only
`agent.invalid_timestamp`, proving null coercion cannot masquerade as an
ordering contradiction. The inspector gains a dedicated explanation.

The public root README and corpus README already carry stale literal counts
that the current lower-bound tests do not catch. This slice updates both to
generated/source truth and adds a mechanical documentation-parity assertion:
after the two vectors the corpus has 62 total / 40 caught / 12 anomaly / 10
undetectable vectors, and the verifier emits 46 non-discussion check IDs.
Future drift in either README must fail the corpus suite.

## Non-goals

- Requiring either optional timestamp.
- Validating fleet timestamps in the same slice.
- Adding safe-integer, nonnegative, precision, clock-skew, or external-time
  guarantees.
- Normalizing or repairing persisted rows.
- Changing writers, imports, storage schemas, evidence scope, or legacy report
  shapes.
