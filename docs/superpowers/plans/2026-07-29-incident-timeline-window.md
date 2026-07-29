# Incident Timeline Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, half-open incident window to the existing read-only timeline CLI while keeping every unbounded output byte-identical and stating the local-record evidence ceiling.

**Architecture:** Keep `buildTimeline()` and its legacy serializers unchanged. Add pure window selection and additive bounded serializers in `src/inspector.ts`, then add a strict timeline-only argument parser in `src/bin/inspect.ts` that chooses the legacy path when no bound was supplied. Exercise the real CLI against isolated SQLite ledgers and prove bounded reads do not alter ledger bytes.

**Tech Stack:** TypeScript, Node.js 20+, `node:test`, `tsx`, SQLite through the existing MeshFleet test seams.

## Global Constraints

- The interval is half-open on stored row timestamps: `from_ms <= row.ts < to_ms`.
- Each bound is a digits-only epoch-millisecond value or an ISO-8601 value accepted by `Date.parse`, and must decode to a finite safe integer.
- Existing unbounded timeline text and `meshfleet.inspect/v1` `kind: "timeline"` JSON remain byte-for-byte unchanged.
- Bounded JSON uses only additive `kind: "timeline_window"` and the exact closed shape in the design spec.
- Bounded text states that local timestamps do not establish authenticity, completeness, tamper evidence, authenticated provenance, or external time.
- No MCP, verifier, dashboard, VS Code, A2A auth, provider routing, drain/wrapper, Discussion, lifecycle-execution, network, background process, deploy, or publish changes.

---

### Task 1: Pure incident-window contract

**Files:**
- Modify: `src/inspector.ts`
- Test: `test/timeline.test.ts`

**Interfaces:**
- Consumes: `TimelineRow[]` from the unchanged `buildTimeline(data, { fleetId? })`.
- Produces: `filterTimelineWindow(rows, { fromMs?, toMs? }): TimelineRow[]`.
- Produces: `buildTimelineWindowJson(rows, { fromMs?, toMs?, fleetId? }): InspectJsonEnvelope<"timeline_window", TimelineWindowData>`.
- Produces: `formatTimelineWindow(rows, { fromMs?, toMs? }): string`.

- [ ] **Step 1: Write failing pure-contract tests**

Add literal tests that require:

```ts
assert.deepEqual(
  filterTimelineWindow(rows, { fromMs: 1_000, toMs: 2_000 }).map((row) => row.ts),
  [1_000, 1_999],
)
```

Also pin lower-only, upper-only, and fleet-pre-filtered inputs; the exact
`timeline_window` envelope with nullable bounds and fleet ID; the fixed evidence
label/nonclaims; and the text preamble followed by the existing table or empty
message.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --import tsx --test test/timeline.test.ts
```

Expected: FAIL because the three new exports do not exist.

- [ ] **Step 3: Implement the minimal pure functions**

Add closed types:

```ts
export interface TimelineWindow {
  fromMs?: number
  toMs?: number
}

export interface TimelineWindowData {
  window: {
    from_ms: number | null
    to_ms: number | null
    interval: 'half_open'
  }
  fleet_id: string | null
  rows: TimelineRow[]
  evidence: {
    label: 'local_ledger_timestamps'
    nonclaims: [
      'authenticity',
      'completeness',
      'tamper_evidence',
      'authenticated_provenance',
      'external_time',
    ]
  }
}
```

Filter without mutating the input. Build a new fixed evidence object for the
bounded envelope. Format the preamble with the actual nullable bound values so
an operator can see the selected interval, then append `formatTimeline(rows)`.
Do not modify `buildTimeline`, `buildTimelineJson`, `formatTimeline`, or
`TimelineRow`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
node --import tsx --test test/timeline.test.ts
```

Expected: PASS.

### Task 2: Strict additive CLI

**Files:**
- Modify: `src/bin/inspect.ts`
- Create: `test/incident-timeline-window.test.ts`

**Interfaces:**
- Consumes: timeline-only argv after the `timeline` token.
- Produces: a parsed `{ fleetId?, fromMs?, toMs?, bounded, json }` command or a stable exit-2 diagnostic.
- Uses: Task 1 pure window helpers.

- [ ] **Step 1: Write failing real-CLI tests**

Seed an isolated SQLite ledger through `importSnapshot`, close the shared test
handle, and invoke the real `src/bin/inspect.ts` with `node --import tsx`.
Require:

- `timeline --from 1000 --to 2000 --json` selects `1000` and excludes `2000`;
- `timeline f1 --from <ISO> --json` intersects fleet and lower bound;
- `timeline --to 2000` prints the evidence preamble and existing table;
- an empty bounded result exits 0;
- unknown/repeated/missing/invalid/equal/reversed bounds and extra positionals
  exit 2 with empty stdout;
- unbounded text and JSON equal literal legacy outputs;
- bounded CLI execution leaves the SQLite file bytes unchanged.

- [ ] **Step 2: Run the CLI tests and verify RED**

Run:

```bash
node --import tsx --test test/incident-timeline-window.test.ts
```

Expected: FAIL because the timeline parser ignores bounds or treats their values
as a fleet ID.

- [ ] **Step 3: Implement strict parsing and bounded dispatch**

Parse only the tokens after `timeline`. Accept one optional positional fleet,
`--json`, one `--from` value, and one `--to` value. Reject all other grammar
before calling `loadData()`. Parse digits-only bounds with `Number`, otherwise
use `Date.parse`; require `Number.isSafeInteger`. Reject equal or reversed
closed windows.

When no bound flag exists, call the exact legacy `printTimeline(fleetId,
jsonMode)` path. When a bound exists, load once, call the unchanged
`buildTimeline` with only the fleet filter, filter with
`filterTimelineWindow`, and emit the additive JSON or text formatter.

- [ ] **Step 4: Run focused CLI and timeline tests**

Run:

```bash
node --import tsx --test test/timeline.test.ts test/incident-timeline-window.test.ts test/inspector-json.test.ts
```

Expected: PASS.

### Task 3: Operator documentation and compatibility receipt

**Files:**
- Modify: `README.md`
- Modify: `ROADMAP.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: the verified CLI contract from Tasks 1 and 2.
- Produces: one honest operator example, the exact half-open boundary, and the explicit evidence nonclaims.

- [ ] **Step 1: Document only implemented behavior**

Add a concise README example for bounded text and JSON. Move
“Incident-window timeline reconstruction from the ledger” from Later/exploring
to the recently shipped record without claiming release or publication. Add an
Unreleased changelog entry. Keep provenance confidence bands, external
fingerprints, and timestamp anchoring future.

- [ ] **Step 2: Run focused and compatibility checks**

Run:

```bash
npm run typecheck
node --import tsx --test test/timeline.test.ts test/incident-timeline-window.test.ts test/inspector-json.test.ts
git diff --check
```

Expected: all commands exit 0.

### Task 4: Full verification, independent review, and local commit

**Files:**
- Review all changes from `origin/main...HEAD` plus the working tree.

**Interfaces:**
- Consumes: completed implementation and docs.
- Produces: release verification evidence, independent review dispositions, repaired findings, and one clean local commit.

- [ ] **Step 1: Run full release verification**

Run:

```bash
npm run release:verify
```

Expected: build, all tests, and package dry-run pass.

- [ ] **Step 2: Dispatch independent reviews**

Send the exact diff to Grok and MiniMax or Ollama with a clean-room prompt.
Require introduced P0-P3 findings only, focused on parser ambiguity, time-bound
semantics, legacy output compatibility, read-only behavior, JSON shape,
evidence overclaim, and scope violations.

- [ ] **Step 3: Repair valid findings red-first**

For every valid finding, add a failing regression test, verify RED, implement
the smallest repair, and verify focused GREEN. Record technical evidence for
any rejected finding.

- [ ] **Step 4: Re-run final verification**

Run:

```bash
npm run release:verify
git diff --check
git status --short
```

Expected: release verification and diff check exit 0; status lists only the
intended files before commit.

- [ ] **Step 5: Commit the implementation**

```bash
git add src/inspector.ts src/bin/inspect.ts test/timeline.test.ts test/incident-timeline-window.test.ts README.md ROADMAP.md CHANGELOG.md docs/superpowers/plans/2026-07-29-incident-timeline-window.md
git commit -m "feat: add bounded incident timelines"
```

- [ ] **Step 6: Verify the committed tree**

Run:

```bash
git status --short
git log --oneline -2
git diff --check origin/main...HEAD
```

Expected: clean status, design and implementation commits visible, no
whitespace errors. Do not push, merge, deploy, or publish.

