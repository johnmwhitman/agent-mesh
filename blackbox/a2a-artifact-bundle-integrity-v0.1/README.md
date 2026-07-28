# MeshFleet A2A artifact-bundle integrity v0.1

This package defines one offline, pure operation:

```text
evaluate_artifact_bundle_integrity(raw_utf8_json_bytes) -> canonical UTF-8 JSON bytes
```

It evaluates one caller-supplied, in-memory artifact bundle. It validates exact
metadata-to-octet consistency only. The JavaScript and Python evaluators are
separate implementations with a frozen corpus, self checks, and a deterministic
differential/fuzz harness.

## Input

The root object has exactly `profile` and `artifacts`. Every artifact has exactly
`artifact_id`, `logical_name`, `content_base64`, `decoded_byte_length`, and
`sha256`.

- `artifact_id` is a case-sensitive ASCII identifier matching
  `[A-Za-z][A-Za-z0-9._-]{0,63}`.
- `logical_name` is a lowercase ASCII slash-separated logical namespace. It is
  not a filesystem path and rejects empty, dot, dotdot, backslash, drive,
  Unicode, control, leading, and trailing slash segments.
- `content_base64` uses RFC 4648 standard Base64 exactly. URL-safe alphabet,
  whitespace, absent/excess padding, and nonzero unused pad bits reject.
- `decoded_byte_length` is a canonical non-negative safe integer.
- `sha256` is exactly 64 lowercase hex characters over decoded octets.

Empty payloads are allowed. A verified output omits Base64 content and sorts
artifacts by ASCII `(logical_name, artifact_id)`.

## Limits and precedence

The exact limits and deterministic first-error order are in
[`contract.json`](./contract.json). Parsing occurs before schema validation;
per-artifact validation is source ordered; duplicate IDs precede duplicate
logical names; byte-length mismatch precedes digest mismatch.

## Frozen corpus

[`corpus/v0.1/cases.json`](./corpus/v0.1/cases.json) is a frozen review target.
Do not regenerate or overwrite it. The harnesses add deterministic controls but
do not create replacement expected-output targets.

## Nonclaims

This is not a filesystem safety evaluator. It does not open, write, resolve,
contain, or materialize paths. It does not establish transport, envelope
binding, delivery, receipts, acknowledgment, persistence, replay, lifecycle,
authority, policy, execution, identity, signatures, authentication,
authorization, trust, provenance, malware safety, content semantics, or named
client interoperability. A matching digest proves only that caller-supplied
octets match caller-supplied metadata.

The package is offline, local, unmerged, unpushed, unpublished, and inactive.

## Oracle and boundary evidence

- Mandatory corpus cases assert exact accepted projections or exact rejection codes. Expectations are authored from the contract and raw octets, then encoded by harness-local serializers; evaluator output and the production canonical serializer never generate them. Runtime parity is necessary but never the oracle.
- M03/M23 freeze permutation invariance; M24 freezes raw ASCII ordering; M25 binds supplied binary octets to a known digest.
- The corpus freezes compact structural, parser, Base64-alphabet, and precedence boundaries. Multi-megabyte byte ceilings are generated deterministically by the focused harness rather than checked in as inflated fixtures.
- The evaluator remains pure and in-memory: it does not read paths, fetch URIs, materialize files, or claim storage, delivery, provenance, trust, authorization, or execution.
- Acceptance requires independent implementation and corpus closure plus fresh focused, build, typecheck, and full-suite receipts.
