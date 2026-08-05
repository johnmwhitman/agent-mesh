import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  handleCrash,
  buildCrashRecord,
  formatCrashStderr,
  CRASH_EXIT_CODE,
  CRASH_PREFIX,
  type CrashRecord,
  type InFlightAgent,
} from "../src/crash-handler.js";

// The crash path is the one code path that runs when everything else has
// already failed. So every step is tested through INJECTED fakes — nothing here
// registers a real process listener, throws a real uncaught exception, or calls
// a real process.exit. A test that force-exits takes the whole runner with it
// and turns a suite into a green-looking lie; that has happened in this repo's
// history and must not be reintroduced by the very module meant to catch it.

const AGENTS: InFlightAgent[] = [
  { agent_id: "a1", fleet_id: "f1", pid: 4242 },
  { agent_id: "a2", fleet_id: "f1", pid: 4243 },
];

function harness(over: Partial<Parameters<typeof handleCrash>[2]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-crash-"));
  const calls: string[] = [];
  let stderr = "";
  let exitCode: number | undefined;
  const deps = {
    snapshotInFlight: () => { calls.push("snapshot"); return AGENTS; },
    journalPath: join(dir, "crash.jsonl"),
    markOrphaned: () => { calls.push("markOrphaned"); },
    writeStderr: (s: string) => { calls.push("stderr"); stderr += s; },
    exit: (c: number) => { calls.push("exit"); exitCode = c; },
    now: () => 1_700_000_000_000,
    ...over,
  };
  return {
    dir, calls, deps,
    get stderr() { return stderr; },
    get exitCode() { return exitCode; },
    journal: () => existsSync(deps.journalPath) ? readFileSync(deps.journalPath, "utf8") : "",
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("the crash path runs its steps in the order that survives partial failure", () => {
  const h = harness();
  try {
    handleCrash("uncaughtException", new Error("boom"), h.deps);
    // Snapshot from memory FIRST (no I/O), durable journal SECOND (before the
    // native DB, which is a prime suspect in any crash), then the DB mark, then
    // the diagnostic, and the exit last and unconditionally.
    assert.deepEqual(h.calls, ["snapshot", "markOrphaned", "stderr", "exit"]);
    assert.equal(h.exitCode, CRASH_EXIT_CODE);
  } finally { h.cleanup(); }
});

test("the journal line is written BEFORE the ledger mark is attempted", () => {
  // Proven by making the ledger mark throw: the journal must still be on disk.
  const h = harness({ markOrphaned: () => { throw new Error("db is wedged"); } });
  try {
    handleCrash("uncaughtException", new Error("boom"), h.deps);
    const line = JSON.parse(h.journal().trim()) as CrashRecord;
    assert.equal(line.event, "server_crash");
    assert.equal(line.in_flight.length, 2);
    assert.match(h.stderr, /db_mark=skipped/);
    assert.equal(h.exitCode, CRASH_EXIT_CODE, "a wedged DB must not stop the exit");
  } finally { h.cleanup(); }
});

test("NOTHING stops the exit — every dependency failing at once still exits 70", () => {
  // The property that matters most. A crash handler that can itself hang leaves
  // exactly the zombie this module exists to prevent.
  const h = harness({
    snapshotInFlight: () => { throw new Error("heap is bad"); },
    journalPath: "/nonexistent-dir-that-cannot-be-created/crash.jsonl",
    markOrphaned: () => { throw new Error("db gone"); },
    writeStderr: () => { throw new Error("stderr closed"); },
  });
  try {
    handleCrash("unhandledRejection", new Error("boom"), h.deps);
    assert.equal(h.exitCode, CRASH_EXIT_CODE);
  } finally { h.cleanup(); }
});

test("a rejection carrying a non-Error value does not break the handler", () => {
  // unhandledRejection can carry anything: a string, undefined, a cyclic object.
  // Stringifying must never throw inside the crash path.
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const value of ["just a string", undefined, 42, cyclic, null]) {
    const h = harness();
    try {
      handleCrash("unhandledRejection", value, h.deps);
      assert.equal(h.exitCode, CRASH_EXIT_CODE, `failed on ${String(value)}`);
      assert.ok(h.journal().length > 0);
    } finally { h.cleanup(); }
  }
});

test("in-flight agents are named in the record — they are the ones at risk", () => {
  const record = buildCrashRecord("uncaughtException", new Error("x"), AGENTS, 1, 99);
  assert.deepEqual(record.in_flight.map((a) => a.agent_id), ["a1", "a2"]);
  assert.equal(record.pid, 99);
});

test("the diagnostic is greppable and distinguishes a crash from a shutdown", () => {
  const record = buildCrashRecord("uncaughtException", new Error("boom"), AGENTS, 1, 99);
  const out = formatCrashStderr(record, "/tmp/j.jsonl", true);
  assert.ok(out.includes(`${CRASH_PREFIX} kind=uncaughtException exit=70`));
  assert.match(out, /agents=2 pids=4242,4243/);
  assert.match(out, /db_mark=ok/);
});

test("a huge stack and message are truncated, not dumped whole", () => {
  const err = new Error("x".repeat(5000));
  err.stack = "y".repeat(50_000);
  const record = buildCrashRecord("uncaughtException", err, [], 1, 1);
  assert.ok(record.error_message.length <= 512);
  assert.ok(record.stack.length <= 2048);
});

test("the crash path writes NOTHING to stdout — stdout is the MCP transport", async () => {
  // A single non-protocol byte on stdout corrupts the client's session, which
  // would make the crash handler harmful in exactly the moment it matters.
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/crash-handler.ts", import.meta.url), "utf8"),
  );
  assert.ok(!/process\.stdout/.test(src), "crash-handler.ts references process.stdout");
  assert.ok(!/console\.log/.test(src), "crash-handler.ts uses console.log (writes to stdout)");
});

/** Strip comments so a source assertion inspects CODE, not the prose about it. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("the handler does NOT kill surviving children", async () => {
  // A deliberate departure from the design review, pinned so it is a decision
  // rather than an omission: in the incident that motivated this module, five
  // of seven agents survived the crash and delivered their work. Killing them
  // would have destroyed real results to tidy the record.
  //
  // Note the first draft of this test failed against the module's own header,
  // which explains the departure and therefore contains the word it forbids.
  // A source guard that reads documentation as if it were code is a guard that
  // flags its author for describing the rule — hence codeOnly().
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/crash-handler.ts", import.meta.url), "utf8"),
  );
  assert.ok(
    !/process\.kill|SIGKILL/.test(codeOnly(src)),
    "the crash path kills children — see the module header",
  );
});

test("the kill-guard would actually fire — proven, not assumed", () => {
  // A guard nobody has watched fail is decoration. Feed codeOnly() a source
  // that really does kill, and confirm the assertion flips.
  const killing = `/* a comment mentioning SIGKILL harmlessly */\nfunction f(){ process.kill(pid, 'SIGKILL') }`;
  assert.ok(/process\.kill|SIGKILL/.test(codeOnly(killing)), "guard cannot see a real kill");
  const documenting = `/* we deliberately do NOT SIGKILL children */\nfunction f(){ return 1 }`;
  assert.ok(!/process\.kill|SIGKILL/.test(codeOnly(documenting)), "guard still reads comments");
});
