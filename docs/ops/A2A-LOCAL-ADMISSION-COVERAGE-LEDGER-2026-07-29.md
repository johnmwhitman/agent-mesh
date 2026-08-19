# A2A Local-Admission Section 9 Coverage Ledger

Status: bounded offline evidence only. This ledger records executable coverage,
not profile conformance, authority, acceptance, persistence, delivery, or
transport capability.

Base reviewed: `2760310` (origin/main). Corpus: 49 mandatory raw-text cases in
`test/fixtures/a2a/local-admission/v0.1/corpus.json`; every case is evaluated by
the TypeScript implementation and mandatory Python witness with exact result
bytes, replay call count, and replay arguments.

| Section 9 family | Existing executable proof | This slice | Remaining exact gap |
| --- | --- | --- | --- |
| request-raw/path | byte 262143/262144/262145; one surrogate, malformed JSON, duplicate key, fraction, depth, and malformed unknown-child representatives | — | BOM, whitespace/comment/trailing variants, literal/escaped duplicates in every request object, and every safe-path class |
| independent-input | raw-text-only inputs and no request `envelope` member; representative request-before-envelope ordering | — | independent depth/byte collision vectors and double-encoding vectors |
| depth/numeric | representative request depth and fraction; 4A retains its own vectors | — | request depth 8/9 and negative, `-0`, exponent, unsafe-integer boundaries |
| precedence | representative request, envelope, denial, replay, and expiry ordering | — | mutation canary for each adjacent A00-A13 pair |
| envelope | malformed and recipient representatives plus audience/self-recipient ordinary tests | — | all 4A invalid families and exact prefixed source paths |
| evidence | one invalid field representative | **CLOSED bounded subfamily:** provenance; issued-at equality; expires-at equality; lifetime 300000/300001 | every remaining field/type/grammar vector |
| binding | one invalid field representative | — | fields, interval edges, duplicate source index, context mismatch, and 0/256/257 rule vectors |
| authorization | valid one type/recipient; one invalid action; generic denial | **CLOSED bounded subfamily:** types 5/6; recipients 128/129; duplicate type and recipient source index; all-recipient denial before replay; session + context (adapter / principal / audience / session_ref / sender) mismatch each deny independently | rule-count edge (262144-byte cap with 216-byte rule lower bound makes 2048 rules unrepresentable; existing test pins this) |
| relativity | plan only reports fixture IDs/versions | — | decision changes caused by changed fixtures |
| oracle/results | all four non-admission verdicts, unavailable, throw, unseen plan, unseen-only expiry, and exact query | **CLOSED bounded subfamily:** rejected-code inventory — the corpus exercises every code in the TypeScript `RejectCode` union and every quoted uppercase literal the mandatory Python witness can emit, with a fail-closed agreement test and a scanner self-test | malformed oracle case |
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

## Rejected-code inventory slice records

| Test | What it proves |
| --- | --- |
| `the corpus exercises every RejectCode the TypeScript implementation can emit` | Every code in the `RejectCode` union in `src/a2a/local-admission.ts` is pinned by at least one corpus case's expected `rejected` result; fails closed naming any uncovered code |
| `the corpus exercises every reject code the mandatory Python witness can emit` | Every quoted uppercase literal in the Python witness is pinned by at least one corpus case; fails closed naming any uncovered code |
| `the TypeScript and Python witness rejected-code inventories agree` | The two witnesses emit the exact same set of reject codes; a drift in either direction fails |
| `rejected-code scanner self-test: multi-line and spacing variants are seen` | The source-scanning regex sees multi-line union members and spaced alternatives, not just single-line declarations |

The inventory is re-derived from source on every test run — a hand-maintained
list is exactly the thing that goes stale, so no such list exists. The scanner
reads the `type RejectCode =\n…;` union body for TypeScript and all quoted
uppercase literals for Python, verified today to agree with zero non-code
literals; the agreement test fails closed if a comment or constant ever slips in.

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
