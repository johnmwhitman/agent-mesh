# The tampered-ledger corpus

A published set of deliberately falsified ledgers, and what the verifier does with
each one. This exists because "who saw this, who approved it, prove it" is a claim,
and a claim about detection is only worth what its falsification tests are worth.

Regenerate with `npx tsx scripts/generate-corpus.ts`. Enforced by
[`test/corpus.test.ts`](../../corpus.test.ts).

## How to read it

Every fixture is the clean [`baseline.json`](./baseline.json) plus **one declared
change**, listed as explicit operations in [`manifest.json`](./manifest.json). The
harness proves each file really is baseline-plus-its-declared-ops, so the baseline
is a true near-neighbour control: a fixture and its control share one topology and
differ by one fact. That is what makes a passing vector evidence that the verifier
recognised the violated invariant, rather than evidence that it recognised the
shape of a fixture.

Vectors fall into three buckets. **They are reported separately and never blended
into one "N/N covered" number** — that number would be marketing.

| Bucket | Count | Contract |
|---|---|---|
| `caught` | 64 | An overclaim: the ledger asserts something its own records do not support. Must raise its named check at **error** severity and drive `ok: false`. |
| `anomaly` | 17 | Genuinely surprising, but claims no more than the records support (an orphaned reference, a stale projection). Raises a **warning**; `ok` stays true. A warning-only detection is deliberately *not* counted as "caught". |
| `undetectable` | 10 | The free core structurally cannot see it. Must produce **zero** findings. |

Together the `caught` and `anomaly` vectors name **all 62** checks the verifier can
emit outside the `discussion.*` family, which carries its own corpus
(`tampered-discussion-*.json`). The count is re-derived from `src/verify.ts` on
every run, so adding a check without adding a vector fails the suite.

## The `undetectable` bucket is the point

These are not failures. They are the boundary between the free core and the paid
assurance layer, made executable instead of merely asserted in prose.

The core is an unsigned, local, trusted control plane. It can police **internal
coherence** — that records do not contradict each other. It cannot police
**provenance** (who wrote a row), **content binding** (that an approval still
refers to the text that was approved), **completeness** (that a record which
should exist does), or **absolute time**. So:

- `undetectable-payload-swap-after-ack` — a council approved "ship the migration";
  the ledger now reads "drop the users table". Receipts bind to `message_id`, never
  to payload content, so the approval survives a total rewrite of what was approved.
- `undetectable-vote-injection-by-seated-voter` — a ballot minted for an agent that
  holds a legitimate seat. Ballots are unsigned rows; roster checks pass.
- `undetectable-ghost-agent-full-history` — an "Auditor" agent with a coherent
  history that never existed. Without enrolment proof, a persona is free.
- `undetectable-universal-clock-shift` — the whole incident moved a day earlier.
  Only relative order is checked; there is no external time anchor.
- `undetectable-schema-downgrade-ack-backfill` — deleting an ack receipt **and** the
  ledger's `schema_version` makes the loader's v1→v2 migration backfill the receipt
  from the message's own `acknowledged` flag. The overclaim repairs itself before
  the verifier runs: a ledger that declares an older schema is trusted about its
  own acks.

Each asserts **zero findings**. If one ever goes red because the verifier learned
to catch it, that is good news — reclassify it as `caught` deliberately, rather
than deleting the assertion.

## Scope and honest limits

- **These are JSON ledgers, verified through the library path**
  (`loadDataFromFile` → `verifyMeshData`), which is the path the tests exercise.
  `agent-mesh inspect --verify <file>` audits **SQLite** ledgers and refuses JSON
  with exit 2, so the corpus is not currently runnable through that CLI. Making the
  corpus externally executable that way is follow-up work, not a claim being made
  here.
- `expected_findings` in the manifest is a **regression tripwire** captured from the
  verifier. The *authored* claims — a vector's classification, its primary check,
  and that severity — are what a human asserted and what the harness enforces
  independently of the snapshot.
- The clock is pinned (`manifest.now`). A corpus whose expectations depend on
  `Date.now()` is a time bomb.
- `undetectable` vectors are published because concealing a known boundary is more
  dangerous than demonstrating it. Arbitrary rewriting of an unsigned local database
  is already stated in [the threat model](../../../docs/A2A-THREAT-MODEL.md); this
  makes it reproducible rather than novel.
