# MeshFleet A2A proposal base-match v0.1

This package defines one offline, pure operation:

```text
evaluate_proposal_base_match(raw_utf8_json_bytes)
```

It classifies only equality relationships between one caller-supplied comparison
revision and an unordered caller-supplied proposal set. `match` is exact decoded
ASCII string equality in this one input. It is not freshness, object existence,
identity, authority, or a current-state claim.

## Contract

The root has exactly `profile`, `comparison_revision`, and `proposals`. Every
proposal has exactly `proposal_id` and `base_revision`. Both are opaque ASCII
tokens matching `^[A-Za-z][A-Za-z0-9._:-]{0,127}$`; no normalization, trimming,
coercion, numeric interpretation, or ordering applies.

The evaluator returns only one of `empty`, `single_match`, `multiple_match`,
`no_match`, or `mixed_match`, along with ASCII-sorted matching and nonmatching
proposal IDs. It never selects a proposal or changes a revision.

`contract.json` freezes limits, validation precedence, and the complete error
vocabulary. `corpus/v0.1/cases.json` is an exact-output review target. The JS
and Python evaluators are independent; runners, differential, and fuzz code
are harness-local and do not provide production serialization.

## Nonclaims

No object existence or identity; actual freshness or current state; authority,
authentication, authorization, or policy; operation payload or digest; apply,
acceptance, winner, merge, CRDT, OT, or revision advancement; lifecycle,
clocks, transport, delivery, routing, replay, deduplication, persistence,
filesystem, artifacts, execution, runtime, provider, credentials, spend,
integration, publication, deployment, or interoperability is modeled.

Named client labels, if used in a fixture, are opaque strings only and do not
make a product or participation claim.
