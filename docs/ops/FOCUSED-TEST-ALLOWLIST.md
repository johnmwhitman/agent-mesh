# Focused test safe-class allowlist

The canonical suite (`npm test`, or `node scripts/run-tests.mjs --class=full`) runs every discovered test, performs the HANDOFF baseline measurement, creates a `meshfleet-suite-summary-*` temporary directory, and is the only test class that participates in the host-scoped full-suite lease.

The focused class is opt-in:

    npm run test:focused
    node scripts/run-tests.mjs --class=focused editors/vscode/src/model.test.ts

It runs selected tests directly through Node's test runner. It does not acquire the full-suite lease, create a summary temporary directory, perform the HANDOFF baseline measurement, build the project, or write `dist/`.

## Closed allowlist

- `editors/vscode/src/model.test.ts` — pure model/parser tests; `model.ts` has no `vscode`, filesystem, child-process, or generated-artifact dependency.

The runtime allowlist is `FOCUSED_TEST_ALLOWLIST` in `scripts/lib/focused-test-class.mjs`. A path not listed there fails closed. Do not replace this policy with an import-name heuristic.

Adding a path requires all of the following in one verified change:

1. Audit the test and its complete import graph for filesystem writes, child processes, generated artifacts, shared ledgers, and other host-global state.
2. Add the exact repository-relative path to both this document and `FOCUSED_TEST_ALLOWLIST`.
3. Add or update focused-class tests and run the focused command from the repository root.
4. Verify that the run creates no `meshfleet-suite-summary-*` directory and does not change `dist/`.

If a test is not eligible, run it through the full canonical suite instead of widening the allowlist.
