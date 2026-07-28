# Agent Completion Timestamp Integrity Design

**Priority:** 2 — ensure audits and public claims are true.

## Problem

The verifier rejects an agent that starts before its fleet is created and an
agent that completes before it starts. It does not compare `completed_at` with
the owning fleet's `created_at`.

A terminal agent with no `started_at` and a completion timestamp before fleet
creation therefore passes verification with zero findings. Normal writers use
the current clock when they finish an agent, so this state is an internal
timestamp contradiction rather than a supported legacy projection.

## Invariant

When the referenced fleet exists and an agent carries `completed_at`, that
timestamp must be greater than or equal to the fleet's `created_at`.

Violations are errors under the existing `agent.tampered_timestamp` check:

`agent completed before fleet was created`

The check applies regardless of agent status. A non-terminal row that also
carries `completed_at` remains independently subject to
`agent.completed_while_live`.

## Compatibility and ordering

- Do not require `started_at` or `completed_at`; legacy rows may omit either.
- A completion exactly at fleet creation is valid.
- An orphan agent retains its existing warning and cannot be compared to an
  absent fleet.
- Keep each timestamp contradiction independent. When a row violates more than
  one relation, the verifier reports each fact in deterministic source order:
  started before fleet, completed before fleet, completed before start, then
  completed while live.
- Reuse the existing check ID, severity, report format, and evidence scope.

## Proof surface

Add three layers of proof:

1. A raw `verifyMeshData` regression constructs a terminal agent with no
   `started_at` and `completed_at` before its fleet's `created_at`. It must
   produce exactly one `agent.tampered_timestamp` error with the new detail and
   make `ok` false.
2. Controls prove that an absent `started_at` remains valid when completion is
   at or after fleet creation, and that orphan agents do not acquire a
   fabricated timestamp error.
3. A generated corpus vector deletes the baseline agent's `started_at`, moves
   its `completed_at` before fleet creation, and expects the same check. This
   keeps the public tamper corpus independently sensitive to regression.

Update the inspector explanation so it accurately names all three timestamp
relations covered by `agent.tampered_timestamp`, and pin that wording in the
explanation test.

## Non-goals

- Requiring completion timestamps for terminal agents.
- Comparing agent timestamps with fleet completion timestamps.
- Changing wall-clock policy, lifecycle writers, or evidence-scope claims.
- Expanding the slice to other timestamp fields or new check IDs.
