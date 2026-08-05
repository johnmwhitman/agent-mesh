import { test } from "node:test";
import assert from "node:assert/strict";

import { SweepHealth } from "../src/sweep-health.js";

// The defect this replaces: `catch { /* sweep must never take the server down */ }`
// — a comment and nothing else, on a 60s interval. A permanently failing sweep
// meant votes silently stopped being tallied.
//
// The naive fix (log every tick) reproduces the silence by a different route:
// 1,440 identical lines a day teaches an operator to filter the channel. So
// these tests pin BOTH properties — it must be loud enough to notice, and quiet
// enough to keep being noticed.

test("the first failure is loud, immediately", () => {
  const h = new SweepHealth();
  const r = h.failure(new Error("db is locked"));
  assert.equal(r.log, true);
  assert.match(r.message, /db is locked/);
  assert.equal(r.consecutiveFailures, 1);
});

test("identical repeats are COUNTED, not printed", () => {
  const h = new SweepHealth({ repeatEvery: 10 });
  h.failure(new Error("db is locked"));
  for (let i = 2; i <= 9; i++) {
    const r = h.failure(new Error("db is locked"));
    assert.equal(r.log, false, `repeat ${i} should be silent`);
    assert.equal(r.consecutiveFailures, i);
  }
});

test("a persistent failure re-surfaces periodically, carrying its count", () => {
  // A long outage must not scroll out of history entirely.
  const h = new SweepHealth({ repeatEvery: 10 });
  for (let i = 1; i < 10; i++) h.failure(new Error("db is locked"));
  const tenth = h.failure(new Error("db is locked"));
  assert.equal(tenth.log, true, "the 10th identical failure must re-surface");
  assert.match(tenth.message, /consecutive failures: 10/);
});

test("a CHANGED error is loud again — it is new information", () => {
  const h = new SweepHealth({ repeatEvery: 100 });
  h.failure(new Error("db is locked"));
  h.failure(new Error("db is locked"));
  const changed = h.failure(new Error("schema mismatch"));
  assert.equal(changed.log, true);
  assert.match(changed.message, /schema mismatch/);
  assert.match(changed.message, /error changed/);
});

test("RECOVERY is announced — it sizes the damage window", () => {
  // "It started working again, after N failures" is precisely what a reader
  // needs to know how long votes went untallied.
  const h = new SweepHealth();
  for (let i = 0; i < 3; i++) h.failure(new Error("boom"));
  const rec = h.success();
  assert.equal(rec.log, true);
  assert.equal(rec.recovered, true);
  assert.match(rec.message, /recovered after 3 consecutive failures/);
  assert.equal(rec.consecutiveFailures, 0);
});

test("a healthy sweep stays SILENT — success is not an event", () => {
  const h = new SweepHealth();
  for (let i = 0; i < 100; i++) {
    const r = h.success();
    assert.equal(r.log, false, "a healthy sweep must not narrate itself");
  }
});

test("the streak resets after recovery, so the next outage is loud again", () => {
  const h = new SweepHealth();
  h.failure(new Error("boom"));
  h.success();
  const next = h.failure(new Error("boom"));
  assert.equal(next.log, true, "a new outage must not be suppressed by history");
  assert.equal(next.consecutiveFailures, 1);
});

test("singular/plural is correct in the recovery line", () => {
  const h = new SweepHealth();
  h.failure(new Error("x"));
  assert.match(h.success().message, /after 1 consecutive failure$/);
});

test("non-Error throws are handled — a sweep can reject with anything", () => {
  const h = new SweepHealth();
  for (const value of ["a string", undefined, 42, null]) {
    const r = h.failure(value);
    assert.equal(r.log, true);
    assert.ok(r.message.length > 0);
    h.success();
  }
});

test("a nonsense repeatEvery is clamped, not trusted", () => {
  // `% 0` and negatives would either throw or spam every tick — the exact
  // failure this module exists to prevent, introduced by its own config.
  for (const bad of [0, -5, NaN, Infinity]) {
    const h = new SweepHealth({ repeatEvery: bad as number });
    h.failure(new Error("boom"));
    let logged = 0;
    for (let i = 0; i < 30; i++) if (h.failure(new Error("boom")).log) logged++;
    assert.ok(logged > 0 && logged < 30, `repeatEvery=${bad} produced ${logged}/30 logs`);
  }
});

// ---- runSweepTick: the wiring, with its failure path actually watched -------
// These exist because the original inline version could not be observed failing
// without breaking a live SQLite database — which is impossible from outside the
// process, since the open file descriptor survives the path being overwritten.
// Untestable code is how the empty catch survived for so long.

import { runSweepTick } from "../src/sweep-health.js";

function tickHarness(sweep: () => void, health = new SweepHealth()) {
  const warned: string[] = [];
  const events: Array<[string, Record<string, unknown>]> = [];
  return {
    warned, events, health,
    run: () => runSweepTick({
      sweep,
      health,
      warn: (m) => warned.push(m),
      emit: (e, p) => events.push([e, p]),
    }),
  };
}

test("a THROWING sweep is logged and leaves a durable event — watched failing", () => {
  const h = tickHarness(() => { throw new Error("SQLITE_BUSY: database is locked"); });
  h.run();
  assert.equal(h.warned.length, 1, "the failure must be audible");
  assert.match(h.warned[0]!, /SQLITE_BUSY/);
  assert.equal(h.events.length, 1, "the failure must leave a row");
  assert.equal(h.events[0]![0], "sweep_failed");
  assert.equal(h.events[0]![1].consecutive_failures, 1);
});

test("runSweepTick NEVER throws — the server must survive a broken sweep", () => {
  // The original catch existed for this reason and the reason was right.
  const h = tickHarness(() => { throw new Error("boom"); });
  assert.doesNotThrow(() => h.run());
  // ...even when the reporting machinery itself fails.
  assert.doesNotThrow(() => runSweepTick({
    sweep: () => { throw new Error("boom"); },
    health: new SweepHealth(),
    warn: () => { throw new Error("stderr gone"); },
    emit: () => { throw new Error("event log gone"); },
  }));
});

test("a failing event log does not suppress the stderr warning", () => {
  const warned: string[] = [];
  runSweepTick({
    sweep: () => { throw new Error("boom"); },
    health: new SweepHealth(),
    warn: (m) => warned.push(m),
    emit: () => { throw new Error("event log gone"); },
  });
  assert.equal(warned.length, 1, "stderr must still carry the story");
});

test("a healthy tick is silent, and recovery after failure is announced once", () => {
  let fail = true;
  const health = new SweepHealth();
  const h = tickHarness(() => { if (fail) throw new Error("boom"); }, health);
  h.run(); h.run(); h.run();          // 3 failures (1 logged, 2 counted)
  fail = false;
  h.run();                            // recovery
  h.run(); h.run();                   // healthy: silent
  const recovery = h.warned.filter((m) => /recovered after 3/.test(m));
  assert.equal(recovery.length, 1, "recovery announced exactly once");
  assert.ok(h.events.some(([e]) => e === "sweep_recovered"));
  assert.equal(h.warned.length, 2, "1 failure + 1 recovery, nothing else");
});
