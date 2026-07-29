# Fleetbudget Raw-Report Sanitizer Implementation Plan

**Goal:** Land a strict local bytes-to-snapshot sanitizer and stdin CLI without
making raw budget evidence actionable.

**Architecture:** A new pure package module owns bounded UTF-8 decoding, strict
JSON scanning, exact raw-schema validation, conservative caller-owned
collection timing, discarded-field erasure, and construction of the existing
windowless `FleetBudgetSnapshot`. A thin CLI parses a closed flag grammar,
reads bounded stdin, calls the pure function, and emits one JSON document.

**Boundary:** No Fleetbudget invocation, provider contact, raw free-text
retention, route-command interpretation, candidate binding, quota-window
invention, persistence, scheduling, execution, or drain scoring.

## Task 1: Strict raw bytes and closed schema

**Files:**

- Create `src/fleetbudget-sanitizer.ts`
- Create `test/fleetbudget-sanitizer.test.ts`
- Modify `package.json`

1. Write RED package tests for the exact current raw shape, package subpath,
   sorted windowless output, non-mutation, and deterministic permutations.
2. Write RED strict-input tests for the 1 MiB bound, invalid UTF-8, BOM,
   decoded-equivalent duplicate keys, excessive depth, malformed JSON,
   surrogate failures, the exact existing A2A numeric lexeme vector list, and
   closed root/lane schemas. Copy that full inline vector list into the new
   test or first extract a shared fixture; do not paraphrase it into a smaller
   sample.
3. Implement typed redacted errors, fatal UTF-8 decoding, a bounded strict JSON
   scanner using the already-proven A2A lexical law, a scalar-tree check, and
   exact validation sufficient to turn the RED witnesses GREEN. Keep one
   strict scan-plus-parse acceptance path; do not add a permissive fallback.
   Do not call the A2A envelope parser: its 128 KiB limit and error type are
   wrong for this boundary.
4. Keep parser errors value-free and avoid importing transports, runtimes,
   providers, clocks, filesystem, or child processes.
5. Run the focused test, typecheck, build, and `git diff --check`.
6. Commit only Task 1 after independent review.

## Task 2: Timing, erasure, and diagnostic-only composition

**Files:**

- Modify `src/fleetbudget-sanitizer.ts`
- Modify `test/fleetbudget-sanitizer.test.ts`
- Modify `test/fleetbudget-observations.test.ts`
- Modify `test/routeplane-catalog.test.ts`

1. Write RED tests for caller collection interval, duration bound, default and
   explicit TTL, raw generated-time containment, future/stale reports, and
   half-open expiry. Include the producer's zero/six-digit UTC spellings,
   millisecond truncation, invalid calendar normalization, other offsets,
   leap seconds, and safe expiry-sum overflow.
2. Write RED table tests for measured/unmeasured, complete, ceiling-less,
   unavailable, exhausted, malformed metrics, units, lane bounds, discarded
   field types, and cross-field contradictions. Pin strict Boolean
   `measured`, exact state enum membership, utilization presence and
   non-negative bounds, `null|string<=128` route values, and accepted
   `used > total` overage.
3. Prove routes/free text/state/utilization are erased: secret-looking and
   prompt-like values and unknown/duplicate member names never appear in
   output/errors/paths/hashes and changes to valid discarded values leave the
   snapshot byte-identical. Pin the exact current ten-key route set.
4. Compose complete and exhausted raw ceilings through
   `compileFleetBudgetObservations()` and prove `WINDOW_MISSING`, no
   observation, no `BUDGET_EXHAUSTED`, and all-false effects.
5. Prove provider-shaped raw lane IDs cannot alter RoutePlane policy traits,
   identity, privacy, locality, authentication, health, or execution.
6. Run focused tests, typecheck, build, and `git diff --check`.
7. Commit Task 2 after independent review.

## Task 3: Bounded stdin CLI and package witness

**Files:**

- Create `src/bin/fleetbudget-sanitize.ts`
- Create `test/fleetbudget-sanitizer-cli.test.ts`
- Modify `package.json`

1. Write RED CLI tests for exact required flags, duplicates, unsafe integers,
   leading zeroes, `--flag=value`, `--`, positionals, TTL bounds, empty stdin,
   exit 1/2 mapping, one JSON line on success, and the exact value-free typed
   stderr schema with empty stdout on failure.
2. Prove exactly 1 MiB reaches the decoder while 1 MiB + 1 byte is rejected
   before decoding. Unit-test the bounded reader with an injected stream error
   and pin `input_read_failed` without leaking the underlying error.
3. Implement bounded stdin reading and the thin API call. Do not spawn,
   fetch, read files/configuration, or inspect environment credentials.
4. Add the executable and package subpath; prove both are present in
   `npm pack --dry-run`, then install the packed tarball into a temporary
   consumer and execute its installed binary through stdin.
5. Run focused tests, typecheck, build, package dry-run, and
   `git diff --check`.
6. Commit Task 3 after independent review.

## Task 4: Public truth and release gate

**Files:**

- Modify `README.md`
- Modify `ROADMAP.md`
- Modify `HANDOFF.md`
- Modify `CHANGELOG.md`
- Modify `COMPATIBILITY.md` if its public compatibility boundary requires a note
- Modify `docs/FLEETBUDGET-OBSERVATIONS.md`

1. Document exact usage, explicit collection interval, current unversioned raw
   schema lock, field erasure, diagnostic-only behavior, and collector gaps.
2. State that structured collector version/timing/quota windows are required
   before measured budget can become actionable.
3. State every non-claim: no polling, provider/auth authority, bindings,
   execution, persistence, allocation, reservation, scheduler, unused-quota
   reward, or drain policy.
4. Run design/claims, security, compatibility, and full-diff reviews through
   native, Grok, and MiniMax lanes.
5. Run `npm run release:verify`, package export/executable witnesses,
   `git diff --check`, and integrated-main focused verification.
6. Gate publication steps independently. Push only with separately documented
   human push authority; open a PR only with separately documented authority
   to publish under the user's identity; merge only with separately documented
   merge authority and a green CI matrix. Without the applicable authority,
   stop at the reviewed local branch, pushed branch, or reviewed PR
   respectively. Preserve the reviewed worktree and receipts in every case.
