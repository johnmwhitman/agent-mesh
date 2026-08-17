# A2A Local-Admission Section 9 Coverage Ledger

Status: bounded offline evidence only. This ledger records executable coverage,
not profile conformance, authority, acceptance, persistence, delivery, or
transport capability.

Base reviewed: `2760310` (origin/main). Corpus: 112 mandatory raw-text cases in
`test/fixtures/a2a/local-admission/v0.1/corpus.json`; every case is evaluated by
the TypeScript implementation and mandatory Python witness with exact result
bytes, replay call count, and replay arguments.

| Section 9 family | Existing executable proof | This slice | Remaining exact gap |
| --- | --- | --- | --- |
| request-raw/path | byte 262143/262144/262145; surrogate, malformed JSON, duplicate key, fraction, depth, malformed unknown-child; BOM, whitespace, comment/trailing, escaped/nested duplicates, number lexemes, raw control byte, bad escape | **CLOSED bounded subfamily:** literal/escaped/nested duplicate keys; BOM/whitespace/comment/trailing; bad escape and raw control byte; `-0`, exponent, unsafe, leading-zero, fraction, negative | duplicates in binding/authorization/sender objects and every safe-path class |
| independent-input | raw-text-only inputs; no request `envelope` member; representative request-before-envelope ordering | **CLOSED bounded subfamily:** request `envelope` member rejected; double-encoded envelope rejected; independent byte-limit | independent depth/byte collision vectors and every double-encoding variant |
| depth/numeric | representative request depth and fraction; 4A retains its own vectors | **CLOSED bounded subfamily:** depth 8 acceptance and depth 9 rejection; `-0`, exponent, unsafe-integer, leading-zero, negative, fraction | all remaining number lexeme classes |
| precedence | representative request, envelope, denial, replay, and expiry ordering | **CLOSED bounded subfamily:** request-wins-envelope; envelope-wins-evidence; denial hides malformed oracle and throw | mutation canary for each adjacent A00-A13 pair |
| envelope | malformed and recipient representatives plus audience/self-recipient ordinary tests | **CLOSED bounded subfamily:** duplicate key; type/sender/recipient-element/payload-body/expiry/message-id/audience/number invalids; duplicate/self/empty/wildcard recipients | all 4A invalid families and exact prefixed source paths |
| evidence | one invalid field representative | **CLOSED bounded subfamily:** provenance; issued-at equality; expires-at equality; lifetime 300000/300001; adapter/audience/session/principal invalids; missing/unknown field; lifetime overlong | every remaining field/type/grammar vector |
| binding | one invalid field representative | **CLOSED bounded subfamily:** empty rules; 256 rules admit; 257 rules reject; duplicate key; empty/future/expired intervals | fields, context mismatch, and source-indexed duplicate in every object |
| authorization | valid one type/recipient; one invalid action; generic denial | **CLOSED bounded subfamily:** types 5/6; recipients 128/129; duplicate type and recipient source index; all-recipient denial before replay; empty rules; invalid type value; six types; duplicate key; session denial | snapshot fields/provenance, rule-count edge, and other policy contexts |
| relativity | plan only reports fixture IDs/versions | **CLOSED bounded subfamily:** fixture change flips the decision; plan IDs/versions only | every fixture-sensitivity class |
| oracle/results | all four non-admission verdicts, unavailable, throw, unseen plan, unseen-only expiry, and exact query | **CLOSED bounded subfamily:** malformed oracle; denial hides malformed oracle and throw | every rejected-code inventory |
| privacy | offline/import-surface checks and closed sidecar fixtures | **CLOSED bounded subfamily:** capability/profile/proof input ignored (fail-closed unknown-core rejection) | model/runtime/receipt/conformance/provider/environment/secret and diagnostic invariance |

## Authentication-evidence slice records

| Case IDs | Required outcome | Replay calls |
| --- | --- | --- |
| `evidence.provenance-invalid` | `INVALID_AUTHENTICATION_EVIDENCE` at `$.authentication_evidence.provenance` | 0 |
| `evidence.issued-at-evaluation-valid`, `evidence.lifetime-300000-valid` | `admission_plan` with the unchanged 4A digest | 1 |
| `evidence.expires-at-evaluation-denied`, `evidence.lifetime-300001-denied` | `AUTHORIZATION_DENIED` at `$` | 0 |

## Authorization slice records

| Case IDs | Required outcome | Replay calls |
| --- | --- | --- |
| `authorization.boundary.message-types-5`, `authorization.boundary.recipients-128` | `admission_plan` with the unchanged 4A digest | 1 |
| `authorization.boundary.message-types-6` | `INVALID_AUTHORIZATION_SNAPSHOT` at `$.authorization_snapshot.rules[0].message_types` | 0 |
| `authorization.boundary.recipients-129` | `INVALID_AUTHORIZATION_SNAPSHOT` at `$.authorization_snapshot.rules[0].recipients` | 0 |
| `authorization.boundary.duplicate-message-type` | `INVALID_AUTHORIZATION_SNAPSHOT` at `$.authorization_snapshot.rules[0].message_types[1]` | 0 |
| `authorization.boundary.duplicate-recipient` | `INVALID_AUTHORIZATION_SNAPSHOT` at `$.authorization_snapshot.rules[0].recipients[1]` | 0 |
| `authorization.boundary.all-recipient-denied` | `AUTHORIZATION_DENIED` at `$` | 0 |

## Unreachable profile row

The declared authorization `rules` maximum of 2048 and its 2049 rejection
boundary cannot be represented below the independent 262144-byte request cap:
every valid authorization rule has a 216-byte lexical lower bound before array
punctuation. Thus 2048 rules alone require at least 442368 bytes, before
commas, brackets, or any other request fields. This is a conservative lower
bound, not an assertion of the exact maximum representable rule count. The
row is a contract/cardinality tension to resolve in a later approved profile
revision, not a reason to bypass the raw byte ceiling or claim it as covered.

No authentication provider, credential, trust root, current policy, replay
store, persistence, durable acceptance, public MCP/CLI/package export,
transport, network, delivery, execution, or remote/multi-host behavior is
implemented or evidenced by this slice.
