# Wrapper usage observation adapter receipt

Date: 2026-07-29

Repository: `johnmwhitman/agent-mesh`

Base: `a9ba59ec4226f4c49af1199ef258f530640d10dd` (`origin/main`)

Branch: `codex/wrapper-usage-observation-adapter-20260729`

## Delivered boundary

- Added the pure package subpath
  `meshfleet/wrapper-usage-observations`.
- Consumes only an already-decoded, exact
  `fleet.wrapper-usage-summary/v1` object.
- Returns a distinct `meshfleet.wrapper-usage-status/v1`
  `accepted`/`groups` envelope, not route-candidate observations or MeshFleet
  health.
- Preserves `routeplane-unattributed` exactly.
- Rejects schema drift, inherited/accessor/non-JSON members, malformed
  invariants, unknown dimension tuples, duplicates, non-canonical ordering,
  unsafe integers, contradictory counts, and over-bound input before returning
  any result.
- Copies fixed rejection counters and aggregate evidence without deriving
  provider identity, quota, balance, health, rates, averages, SLOs, or drain
  priority.

## Effects and authority

The adapter performs no I/O and has no clock, global state, MCP registration,
storage, execution, scheduling, routing, provider contact, or logging
activation. It imports no health, route compiler/recommender, Fleetbudget
snapshot, or drain-planner module. Source SHA-256, bytes, lines, and the
half-open window remain producer-asserted provenance.

No merge, deploy, publish, usage-logging activation, route change, scheduling
change, or provider call was authorized or performed.

## Verification

- TDD red: focused test failed because the adapter module did not exist.
- Focused green before review: 9/9.
- Independent review HOLD:
  - prototype-inherited required fields could pass the exact-object check;
  - unknown attacker-controlled field names could escape through errors.
- Repair red: 2 focused tests failed on those reproductions.
- Repair green: 10/10 focused tests.
- Focused independent re-review: both P2s resolved; `COMMIT PASS`.
- Final `npm run typecheck`: pass.
- Final `npm run release:verify`: pass.
  - build: pass;
  - tests: 1,187/1,187, zero failures;
  - package dry run: 58 files, including
    `dist/wrapper-usage-observations.js`.
- `git diff --check`: pass.
- `git diff | gitleaks stdin --no-banner --redact`: no leaks.
- Live producer compatibility probe using the current empty
  `fleet.wrapper-usage-summary/v1` output: pass.

Two initial external diff-review streams (Grok and MiniMax) did not return
verdicts within the bounded wait and were interrupted, so they received no
review credit. Earlier completed Grok and MiniMax architecture reviews informed
the non-composition and authority boundary only. The final code verdict is the
independent sibling review above.
