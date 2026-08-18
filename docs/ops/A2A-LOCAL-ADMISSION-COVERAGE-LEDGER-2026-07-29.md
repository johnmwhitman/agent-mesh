# A2A Local-Admission Section 9 Coverage Ledger

Status: bounded offline evidence only. This ledger records executable coverage,
not profile conformance, authority, acceptance, persistence, delivery, or
transport capability.

Base reviewed: `4a7eb30` (origin/main, post-merge-tick-94). Corpus: 75 mandatory raw-text cases in
`test/fixtures/a2a/local-admission/v0.1/corpus.json`; every case is evaluated by
the TypeScript implementation and mandatory Python witness with exact result
bytes, replay call count, and replay arguments.

| Section 9 family | Existing executable proof | This slice | Remaining exact gap |
| --- | --- | --- | --- |
| request-raw/path | byte 262143/262144/262145; one surrogate, malformed JSON, duplicate key, fraction, depth, and malformed unknown-child representatives | — | BOM, whitespace/comment/trailing variants, literal/escaped duplicates in every request object, and every safe-path class |
| independent-input | raw-text-only inputs and no request `envelope` member; representative request-before-envelope ordering | — | independent depth/byte collision vectors and double-encoding vectors |
| depth/numeric | representative request depth and fraction; 4A retains its own vectors | — | request depth 8/9 and negative, `-0`, exponent, unsafe-integer boundaries |
| precedence | representative request, envelope, denial, replay, and expiry ordering | **CLOSED bounded subfamily:** 13 adjacent A00-A13 mutation canaries + 13 later-only precedence controls pin the earlier-step-wins contract; COLLAPSED A07-A08/A08-A09 pairs also pin 0 oracle calls | — |
| envelope | malformed and recipient representatives plus audience/self-recipient ordinary tests | — | all 4A invalid families and exact prefixed source paths |
| evidence | one invalid field representative | **CLOSED bounded subfamily:** provenance; issued-at equality; expires-at equality; lifetime 300000/300001 | every remaining field/type/grammar vector |
| binding | one invalid field representative | — | fields, interval edges, duplicate source index, context mismatch, and 0/256/257 rule vectors |
| authorization | valid one type/recipient; one invalid action; generic denial | **CLOSED bounded subfamily:** types 5/6; recipients 128/129; duplicate type and recipient source index; all-recipient denial before replay; session + context (adapter / principal / audience / session_ref / sender) mismatch each deny independently | rule-count edge (262144-byte cap with 216-byte rule lower bound makes 2048 rules unrepresentable; existing test pins this) |
| relativity | plan only reports fixture IDs/versions | — | decision changes caused by changed fixtures |
| oracle/results | all four non-admission verdicts, unavailable, throw, unseen plan, unseen-only expiry, and exact query | — | malformed oracle case and every rejected-code inventory |
| privacy | offline/import-surface checks and closed sidecar fixtures | — | dedicated ignored-input/diagnostic-invariance matrix |

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

## Authorization context-mismatch slice records

| Case IDs | Required outcome | Replay calls |
| --- | --- | --- |
| `authorization.context.adapter-mismatch` | `AUTHORIZATION_DENIED` at `$` | 0 |
| `authorization.context.principal-mismatch` | `AUTHORIZATION_DENIED` at `$` | 0 |
| `authorization.context.audience-mismatch` | `AUTHORIZATION_DENIED` at `$` | 0 |
| `authorization.context.session-mismatch` | `AUTHORIZATION_DENIED` at `$` | 0 |
| `authorization.context.sender-mismatch` | `AUTHORIZATION_DENIED` at `$` | 0 |

## Precedence slice records

| Case IDs | Required outcome | Replay calls |
| --- | --- | --- |
| `precedence.A00-A01` | `rejected:REQUEST_TOO_LARGE@$` | 0 |
| `precedence.A01-A02` | `rejected:UNKNOWN_CORE_FIELD@$` | 0 |
| `precedence.A02-A03` | `rejected:INVALID_REQUEST@$.action` | 0 |
| `precedence.A03-A04` | `rejected:MALFORMED_ENVELOPE@$.envelope` | 0 |
| `precedence.A04-A05` | `rejected:INVALID_AUTHENTICATION_EVIDENCE@$.authentication_evidence.provenance` | 0 |
| `precedence.A05-A06` | `rejected:INVALID_BINDING_SNAPSHOT@$.binding_snapshot.snapshot_version` | 0 |
| `precedence.A06-A07` | `rejected:INVALID_AUTHORIZATION_SNAPSHOT@$.authorization_snapshot.snapshot_version` | 0 |
| `precedence.A07-A08` (COLLAPSED) | `rejected:AUTHORIZATION_DENIED@$` | 0 |
| `precedence.A08-A09` (COLLAPSED) | `rejected:AUTHORIZATION_DENIED@$` | 0 |
| `precedence.A09-A10` | `rejected:AUTHORIZATION_DENIED@$` (denial hides thrown oracle) | 0 |
| `precedence.A10-A11` | `rejected:REPLAY_PROTECTION_UNAVAILABLE@$` | 1 |
| `precedence.A11-A12` | `not_admitted.duplicate` | 1 |
| `precedence.A12-A13` | `not_admitted.expired_at_acceptance` | 0 |

Each canary has a paired later-only control (`control.A00-A01.later` … `control.A12-A13.later`) that proves the predecessor's failure is what fired the canary: the control removes the predecessor's mutation and keeps only the later step's, so the result shifts to the later step's code. The 13 canary + 13 control cases form the bounded precedence subfamily.

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
