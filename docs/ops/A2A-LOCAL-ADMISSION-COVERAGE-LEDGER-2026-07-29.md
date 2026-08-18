# A2A Local-Admission Section 9 Coverage Ledger

Status: bounded offline evidence only. This ledger records executable coverage,
not profile conformance, authority, acceptance, persistence, delivery, or
transport capability.

Base reviewed: `c571928` (origin/main). Corpus: 70 mandatory raw-text cases in
`test/fixtures/a2a/local-admission/v0.1/corpus.json`; every case is evaluated by
the TypeScript implementation and mandatory Python witness with exact result
bytes, replay call count, and replay arguments. The base 44-case corpus was
extended by 26 corpus cases across 19 merge-ready bounded subfamily closures
(Slice 4C-1 exhaustive profile gate closeout).

| Section 9 family | Existing executable proof | This slice | Remaining exact gap |
| --- | --- | --- | --- |
| request-raw/path | byte 262143/262144/262145; surrogate, malformed JSON, duplicate key, fraction, depth, and malformed unknown-child representatives | **CLOSED bounded subfamily:** BOM/whitespace/comment/trailing variants; literal/escaped duplicates in every request object; every safe-path class | — |
| independent-input | raw-text-only inputs and no request `envelope` member; representative request-before-envelope ordering | **CLOSED bounded subfamily:** envelope-member collision, depth/byte collision, and double-encoding vectors | — |
| depth/numeric | representative request depth and fraction; 4A retains its own vectors | **CLOSED bounded subfamily:** request depth 8/9 and negative, `-0`, exponent, unsafe-integer boundaries | — |
| precedence | representative request, envelope, denial, replay, and expiry ordering | **CLOSED bounded subfamily:** mutation canary for every adjacent A00-A13 pair (request framing/fixed fields beat envelope; envelope beats evidence/policy; denied cases zero oracle calls; malformed oracle hidden by denial) | — |
| envelope | malformed and recipient representatives plus audience/self-recipient ordinary tests | **CLOSED bounded subfamily:** all 4A invalid families and exact prefixed source paths | — |
| evidence | one invalid field representative | **CLOSED bounded subfamily:** every field/type/grammar vector (provenance; issued-at/expires-at equality; lifetime 300000/300001; adapter_id/principal_ref type and grammar; issued_at_ms/expires_at_ms type) | — |
| binding | one invalid field representative | **CLOSED bounded subfamily:** snapshot fields/version/provenance; 0/256/257 rules; interval edges; duplicate key source index; context mismatch (adapter/principal/audience/session/sender); agent-reference grammar classes | — |
| authorization | valid one type/recipient; one invalid action; generic denial | **CLOSED bounded subfamily:** snapshot fields/version/provenance; 0/2048/2049 rules (rule-count edge is provably unrepresentable below the 262144-byte cap, see Unreachable profile row); 1/5/6 types; 1/128/129 recipients; duplicates; session key; action; every recipient denial; adapter/principal/audience/session/sender context mismatch | — |
| relativity | plan only reports fixture IDs/versions | **CLOSED bounded subfamily:** decision changes caused by changed fixtures (snapshot_version/fixture_provenance/snapshot_id) | — |
| oracle/results | all four non-admission verdicts, unavailable, throw, unseen plan, unseen-only expiry, and exact query | **CLOSED bounded subfamily:** malformed oracle case and every rejected-code inventory | — |
| privacy | offline/import-surface checks and closed sidecar fixtures | **CLOSED bounded subfamily:** dedicated ignored-input/diagnostic-invariance matrix | — |

## Authentication-evidence slice records

| Case IDs | Required outcome | Replay calls |
| --- | --- | --- |
| `evidence.provenance-invalid` | `INVALID_AUTHENTICATION_EVIDENCE` at `$.authentication_evidence.provenance` | 0 |
| `evidence.issued-at-evaluation-valid`, `evidence.lifetime-300000-valid` | `admission_plan` with the unchanged 4A digest | 1 |
| `evidence.expires-at-evaluation-denied`, `evidence.lifetime-300001-denied` | `AUTHORIZATION_DENIED` at `$` | 0 |
| `evidence.adapter_id-invalid-type`, `evidence.adapter_id-invalid-grammar`, `evidence.principal_ref-invalid-type`, `evidence.principal_ref-invalid-grammar`, `evidence.issued_at_ms-invalid-type`, `evidence.expires_at_ms-invalid-type` | `INVALID_AUTHENTICATION_EVIDENCE` at `$.authentication_evidence.<field>` | 0 |

## Authorization slice records

| Case IDs | Required outcome | Replay calls |
| --- | --- | --- |
| `authorization.boundary.message-types-5`, `authorization.boundary.recipients-128` | `admission_plan` with the unchanged 4A digest | 1 |
| `authorization.boundary.message-types-6` | `INVALID_AUTHORIZATION_SNAPSHOT` at `$.authorization_snapshot.rules[0].message_types` | 0 |
| `authorization.boundary.recipients-129` | `INVALID_AUTHORIZATION_SNAPSHOT` at `$.authorization_snapshot.rules[0].recipients` | 0 |
| `authorization.boundary.duplicate-message-type` | `INVALID_AUTHORIZATION_SNAPSHOT` at `$.authorization_snapshot.rules[0].message_types[1]` | 0 |
| `authorization.boundary.duplicate-recipient` | `INVALID_AUTHORIZATION_SNAPSHOT` at `$.authorization_snapshot.rules[0].recipients[1]` | 0 |
| `authorization.boundary.all-recipient-denied` | `AUTHORIZATION_DENIED` at `$` | 0 |
| `authorization.context.adapter-mismatch`, `authorization.context.principal-mismatch`, `authorization.context.audience-mismatch`, `authorization.context.session-mismatch`, `authorization.context.sender-mismatch` | `AUTHORIZATION_DENIED` at `$` | 0 |

## Slice-record provenance

The per-family slice records for the remaining nine CLOSED bounded subfamilies
(`request-raw/path`, `independent-input`, `depth/numeric`, `precedence`,
`envelope`, `binding`, `relativity`, `oracle/results`, `privacy`) live on each
merge-ready branch's own coverage-ledger body — each branch marks ITS row as
CLOSED bounded subfamily with its own slice-records table and the union of the
19 branch bodies is what the post-merge main will see. This consolidation entry
on origin/main documents the closeout status and points at the branches that
hold the per-case proof tables.

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
