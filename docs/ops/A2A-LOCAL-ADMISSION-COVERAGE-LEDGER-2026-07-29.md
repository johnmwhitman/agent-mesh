# A2A Local-Admission Section 9 Coverage Ledger

Status: bounded offline evidence only. This ledger records executable coverage,
not profile conformance, authority, acceptance, persistence, delivery, or
transport capability.

Base reviewed: `c571928` (origin/main). Corpus: 79 mandatory raw-text cases in
`test/fixtures/a2a/local-admission/v0.1/corpus.json`; every case is evaluated by
the TypeScript implementation and mandatory Python witness with exact result
bytes, replay call count, and replay arguments. The base 44-case corpus was
extended by 26 precedence cases (13 adjacent A00-A13 mutation canaries + 13
later-only precedence controls) and 9 privacy-invariance cases (privacy row
migration after merge); the precedence row and the privacy row are now both
CLOSED bounded subfamily on this branch. The
`evidence` and `authorization` families carry base-corpus closures (provenance /
issued-at / expires-at / lifetime boundaries; type 5/6 + recipient 128/129 +
duplicate source index + all-recipient denial) inherited from origin/main's
44-case corpus — these closures also exist on this tree but this branch adds
nothing to them. The other 8 Section 9 families remain at their pre-closeout
representative coverage on this branch; their exhaustive closures live on
separate merge-ready branches off the same origin/main base — see Slice-record
provenance below.

| Section 9 family | Existing executable proof | This slice | Remaining exact gap |
| --- | --- | --- | --- |
| request-raw/path | byte 262143/262144/262145; one surrogate, malformed JSON, duplicate key, fraction, depth, and malformed unknown-child representatives | — | BOM, whitespace/comment/trailing variants, literal/escaped duplicates in every request object, and every safe-path class |
| independent-input | raw-text-only inputs and no request `envelope` member; representative request-before-envelope ordering | — | independent depth/byte collision vectors and double-encoding vectors |
| depth/numeric | representative request depth and fraction; 4A retains its own vectors | — | request depth 8/9 and negative, `-0`, exponent, unsafe-integer boundaries |
| precedence | representative request, envelope, denial, replay, and expiry ordering | **CLOSED bounded subfamily:** mutation canary for every adjacent A00-A13 pair (13 canaries + 13 later-only controls; request framing/fixed fields beat envelope; envelope beats evidence/policy; denied cases zero oracle calls; malformed oracle hidden by denial) | — |
| envelope | malformed and recipient representatives plus audience/self-recipient ordinary tests | — | all 4A invalid families and exact prefixed source paths |
| evidence | one invalid field representative plus 5 base-corpus closure cases (provenance; issued-at equality; expires-at equality; lifetime 300000/300001) inherited from origin/main | — | every remaining field/type/grammar vector |
| binding | one invalid field representative | — | fields, interval edges, duplicate source index, context mismatch, and 0/256/257 rule vectors |
| authorization | valid one type/recipient; one invalid action; generic denial plus 7 base-corpus closure cases (message-types 5/6; recipients 128/129; duplicate message-type/recipient source index; all-recipient denial) inherited from origin/main | — | snapshot fields/provenance, rule-count edge, session key, and other policy contexts |
| relativity | plan only reports fixture IDs/versions | — | decision changes caused by changed fixtures |
| oracle/results | all four non-admission verdicts, unavailable, throw, unseen plan, unseen-only expiry, and exact query | — | malformed oracle case and every rejected-code inventory |
| privacy | offline/import-surface checks and closed sidecar fixtures | **CLOSED bounded subfamily:** foreign capability/profile/proof/model/runtime/receipt/conformance/provider/environment/secret members in every request and envelope surface — top-level request rejects `UNKNOWN_CORE_FIELD` at `$`; nested request objects reject at the nearest known containing-object path with the family code; envelope agent-reference members are dropped by the delegated 4A decoder with the decision byte-identical to the base plan; raw hidden duplicate rejects `DUPLICATE_JSON_KEY` at `$` | dedicated ignored-input/diagnostic-invariance matrix (9 `privacy.*` mandatory cases) |

## Base corpus slice records (inherited from origin/main)

The following two slice-records tables describe closures that exist on this tree
because they were part of origin/main's 44-case corpus. This branch adds no
cases; the case IDs and expected outcomes match the corpus on this tree but
the closures themselves were authored upstream. They are documented here for
completeness so reviewers do not mistake them for this branch's contribution.

### Authentication-evidence (base corpus)

| Case IDs | Required outcome | Replay calls |
| --- | --- | --- |
| `evidence.provenance-invalid` | `INVALID_AUTHENTICATION_EVIDENCE` at `$.authentication_evidence.provenance` | 0 |
| `evidence.issued-at-evaluation-valid`, `evidence.lifetime-300000-valid` | `admission_plan` with the unchanged 4A digest | 1 |
| `evidence.expires-at-evaluation-denied`, `evidence.lifetime-300001-denied` | `AUTHORIZATION_DENIED` at `$` | 0 |

### Authorization (base corpus)

| Case IDs | Required outcome | Replay calls |
| --- | --- | --- |
| `authorization.boundary.message-types-5`, `authorization.boundary.recipients-128` | `admission_plan` with the unchanged 4A digest | 1 |
| `authorization.boundary.message-types-6` | `INVALID_AUTHORIZATION_SNAPSHOT` at `$.authorization_snapshot.rules[0].message_types` | 0 |
| `authorization.boundary.recipients-129` | `INVALID_AUTHORIZATION_SNAPSHOT` at `$.authorization_snapshot.rules[0].recipients` | 0 |
| `authorization.boundary.duplicate-message-type` | `INVALID_AUTHORIZATION_SNAPSHOT` at `$.authorization_snapshot.rules[0].message_types[1]` | 0 |
| `authorization.boundary.duplicate-recipient` | `INVALID_AUTHORIZATION_SNAPSHOT` at `$.authorization_snapshot.rules[0].recipients[1]` | 0 |
| `authorization.boundary.all-recipient-denied` | `AUTHORIZATION_DENIED` at `$` | 0 |

## Precedence slice records

| Case IDs | Required outcome | Replay calls |
| --- | --- | --- |
| `precedence.A00-A01` | `REQUEST_TOO_LARGE` at `$` | 0 |
| `precedence.A01-A02` | `UNKNOWN_CORE_FIELD` at `$` | 0 |
| `precedence.A02-A03` | `INVALID_REQUEST` at `$.action` | 0 |
| `precedence.A03-A04` | `MALFORMED_ENVELOPE` at `$.envelope` | 0 |
| `precedence.A04-A05` | `INVALID_AUTHENTICATION_EVIDENCE` at `$.authentication_evidence.provenance` | 0 |
| `precedence.A05-A06` | `INVALID_BINDING_SNAPSHOT` at `$.binding_snapshot.snapshot_version` | 0 |
| `precedence.A06-A07` | `INVALID_AUTHORIZATION_SNAPSHOT` at `$.authorization_snapshot.snapshot_version` | 0 |
| `precedence.A07-A08` | `AUTHORIZATION_DENIED` at `$` (collapsed: both A07 and A08 produce the same `$`; proof is zero oracle calls) | 0 |
| `precedence.A08-A09` | `AUTHORIZATION_DENIED` at `$` (collapsed: A08 and A09 both deny at `$`; proof is zero oracle calls) | 0 |
| `precedence.A09-A10` | `AUTHORIZATION_DENIED` at `$` (A09 wins; A10 would have called the oracle; the throws oracle is hidden by the denial — meta-property "malformed oracle hidden by denial" is also pinned) | 0 |
| `precedence.A10-A11` | `REPLAY_PROTECTION_UNAVAILABLE` at `$` (A10 wins; A11 would have produced `not_admitted.duplicate` on a non-unseen verdict) | 1 |
| `precedence.A11-A12` | `not_admitted.duplicate` at `$` (A11 wins; A12 would have produced `not_admitted.expired_at_acceptance`) | 1 |
| `precedence.A12-A13` | `not_admitted.expired_at_acceptance` at `$` (A12 wins; A13 would have produced `admission_plan` because the case is otherwise valid except for the past expiry) | 1 |
| `control.A00-A01.later` … `control.A12-A13.later` | the matching later-only control asserts the second failure codepath fires when the first failure is not present | 0 or 1 per case |

## Slice-record provenance

The per-family slice records for the 7 remaining Section 9 families
(`request-raw/path`, `independent-input`, `depth/numeric`, `envelope`,
`binding`, `relativity`, `oracle/results`) — plus the field/type/
grammar extensions of `evidence` and `authorization` that go beyond the
base-corpus closures inherited from origin/main — live on each merge-ready
branch's own coverage-ledger body. Each branch marks ITS row as CLOSED
bounded subfamily with its own slice-records table. The 18 merge-ready
branches (all off origin/main `c571928`) listed below carry the per-case
proof tables; merge will reconcile their coverage-ledger bodies onto
origin/main. This consolidation entry on this branch (`feat/coverage-ledger-
post-merge-consolidation-20260818`, tip pinning with the privacy merge applied) marks the precedence
AND the privacy family as CLOSED bounded subfamily on this tree (with the 26-case precedence
slice records table above AND the new 9-case privacy slice records table below) and points at the branches that hold the
per-case proof tables for the other 8 families. The COMPATIBILITY row
remains `unverified` until those 19 branches merge; the CONFORMANCE-MATRIX
row is `unverified` today.

### Merge-ready branches holding the remaining Section 9 closures

Each branch listed below is `git-contains c571928` and is merge-ready at
tree and canonical-gate level on its own worktree; merge remains John-gated.

| Section 9 family | Merge-ready branch (off `origin/main c571928`) |
| --- | --- |
| `request-raw/path` (BOM/whitespace/comment/trailing; literal/escaped duplicates; safe-path class) | `feat/request-raw-path-gates-20260818`, `feat/request-raw-path-per-object-gates-20260818`, `feat/request-raw-path-cross-object-gates-20260818` |
| `independent-input` (depth/byte collision; double-encoding) | `feat/independent-input-gates-20260818` |
| `depth/numeric` (depth 8/9 + negative, `-0`, exponent, unsafe-integer boundaries) | `feat/depth-numeric-gates-20260818` |
| `envelope` (all 4A invalid families + exact prefixed source paths) | `feat/envelope-member-gates-20260817`, `feat/envelope-path-precision-20260817` |
| `evidence` field/type/grammar extensions (adapter_id / principal_ref / issued_at_ms / expires_at_ms type and grammar) | `feat/evidence-field-gates-20260817`, `feat/evidence-field-grammar-20260818` |
| `binding` (fields, interval edges, duplicate source index, context mismatch, 0/256/257 rule vectors) | `feat/binding-grammar-gaps-20260817`, `feat/binding-interval-edges-20260818`, `feat/binding-rules-count-gates-20260818`, `feat/binding-slice-20260817` |
| `authorization` snapshot fields/provenance, rule-count edge, session key, other policy contexts | `feat/authorization-snapshot-gates-20260817`, `feat/auth-context-gates-20260818` |
| `relativity` (changed fixture metadata decision shifts) | `feat/relativity-changed-fixtures-20260818` |
| `oracle/results` (malformed oracle + rejected-code inventory) | `feat/oracle-malformed-gates-20260818`, `feat/rejected-code-inventory-20260817` |
| `privacy` (ignored-input / diagnostic-invariance matrix) | `feat/privacy-invariance-matrix-20260817` |

The `precedence` family is closed on this branch (see precedence slice records
above); the precedence-canary branch itself (`feat/precedence-canary-20260818`,
tip `f65596b`) is the merge-ready source of the 26 cases, layered on top of
the earlier `feat/precedence-canaries-20260817` which carries the same
mutation canary pattern. Slice 4C-1 exhaustive closeout is held at `feat/
4c1-exhaustive-profile-gates-20260817` (tip `cd3cdc2`), which is the parent
that aggregates the family-closure branches above; the durable-acceptance
seam is at `feat/durable-acceptance-seam-20260817` (tip `7464c90`), the
capability-profile seam at `feat/capability-profile-seam-20260817` (tip
`f5b4ee1`), and the compact fleet-status branch at `feat/compact-fleet-
status-20260817` (tip `9737b1e`).
## Privacy slice records

| Case IDs | Required outcome | Replay calls |
| --- | --- | --- |
| `privacy.unknown-top-level` | `UNKNOWN_CORE_FIELD` at `$` | 0 |
| `privacy.unknown-evidence-member` | `INVALID_AUTHENTICATION_EVIDENCE` at `$.authentication_evidence` | 0 |
| `privacy.unknown-binding-rule-member` | `INVALID_BINDING_SNAPSHOT` at `$.binding_snapshot.rules[0]` | 0 |
| `privacy.unknown-authorization-rule-member` | `INVALID_AUTHORIZATION_SNAPSHOT` at `$.authorization_snapshot.rules[0]` | 0 |
| `privacy.unknown-authorization-recipient-member` | `INVALID_AUTHORIZATION_SNAPSHOT` at `$.authorization_snapshot.rules[0].recipients[0]` | 0 |
| `privacy.unknown-binding-sender-member` | `INVALID_BINDING_SNAPSHOT` at `$.binding_snapshot.rules[0].sender` | 0 |
| `privacy.unknown-envelope-sender-member` | `admission_plan` byte-identical to `valid.admission-plan` (foreign member dropped by delegated 4A decoder) | 1 |
| `privacy.unknown-envelope-recipient-member` | `admission_plan` byte-identical to `valid.admission-plan` (foreign member dropped by delegated 4A decoder) | 1 |
| `privacy.duplicate-key-hidden-foreign-member` | `DUPLICATE_JSON_KEY` at `$` | 0 |
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
