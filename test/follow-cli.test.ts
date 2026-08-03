/**
 * End-to-end coverage for `agent-mesh inspect --follow`: spawns the real CLI
 * binary as its own process (same pattern as test/db-concurrency.test.ts) and
 * verifies the roadmap-row acceptance criteria directly —
 *
 *   - empty ledger doesn't look broken: an idle banner prints immediately
 *   - a message sent by ANOTHER process after --follow is already watching is
 *     visible on stdout well inside the "<20s to first message" budget
 *   - --fleet filtering happens in the child's poll loop, not post-hoc
 *   - ctrl-c (SIGINT) exits promptly and quietly — code 0 through the handler
 *     on POSIX; on Windows the signal is not deliverable, so only prompt
 *     termination is asserted (see assertCleanSignalExit)
 *
 * This is read-only-forever by construction: the only mutation is done by the
 * TEST process via sendMessage; the spawned --follow child never writes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

// `stdio: ["ignore", "pipe", "pipe"]` gives the child NO stdin pipe, so the previous
// annotation (`PipedChild`) promised a writable `child.stdin` that
// is always null here. Nothing in these files writes to stdin — but the annotation was
// a standing invitation to, and no stage of the verifier could see it.
type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

import Database from "better-sqlite3";
import { setDbPath, closeDb, readLedger } from "../src/db.js";
import { sendMessage } from "../src/core.js";

const here = dirname(fileURLToPath(import.meta.url));
const INSPECT_BIN = join(here, "..", "src", "bin", "inspect.ts");

const FIRST_MESSAGE_BUDGET_MS = 15_000; // roadmap row: "<20s to first message visible"
const POLL_STEP_MS = 100;

function spawnFollow(dbFile: string, extraArgs: string[] = []): PipedChild {
  return spawn(process.execPath, ["--import", "tsx", INSPECT_BIN, "--follow", ...extraArgs], {
    env: { ...process.env, MESHFLEET_DB_FILE: dbFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Poll accumulated output until `predicate` passes or the budget elapses. */
async function waitFor(getOutput: () => string, predicate: (out: string) => boolean, budgetMs: number): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    const out = getOutput();
    if (predicate(out)) return out;
    await new Promise((r) => setTimeout(r, POLL_STEP_MS));
  }
  throw new Error(`timed out after ${budgetMs}ms waiting for output; got:\n${getOutput()}`);
}

function waitExit(
  child: PipedChild,
  budgetMs: number
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process did not exit within ${budgetMs}ms`)), budgetMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

const IS_WINDOWS = process.platform === "win32";

/**
 * Assert a signal shut the child down promptly and without noise.
 *
 * COOPERATIVE SIGNAL SHUTDOWN IS POSIX-ONLY, the same limit already declared for
 * the runtime adapter. Windows has no SIGINT/SIGTERM delivery: `child.kill()`
 * terminates the process outright, so `--follow`'s handler never runs and the
 * child reports `code: null` with a signal instead of exiting 0 through its own
 * cleanup path.
 *
 * The portable half of each test — the idle banner, live message delivery, the
 * `--fleet` filter, malformed-row survival, and the requirement that the process
 * actually DIES within the budget rather than hanging — still runs on Windows.
 * Only the claim that exit ran through the handler is gated, because on Windows
 * it provably cannot. A blanket skip would have hidden the portable half too.
 */
function assertCleanSignalExit(
  res: { code: number | null; signal: NodeJS.Signals | null },
  stderr = ""
): void {
  if (IS_WINDOWS) {
    assert.ok(
      res.code !== null || res.signal !== null,
      "the child must still terminate within the budget on Windows, even though " +
        "the signal is not delivered to its handler"
    );
    return;
  }
  assert.equal(res.code, 0, `expected a clean handler-driven exit; stderr:\n${stderr}`);
}

test("inspect --follow: signal handlers are installed BEFORE the banner promises ctrl-c", () => {
  // A structural guard, deliberately, because the defect it pins is a RACE and
  // a timing test cannot pin a timing fix — the SIGTERM test below passed
  // locally many times while this window was wide open, and only ever failed on
  // CI (ubuntu/Node 24, on a docs-only commit).
  //
  // The invariant: by the time the banner says "ctrl-c to stop", ctrl-c must
  // actually stop. Handlers registered after the banner left a window where the
  // default disposition killed the process outright — no closeFollowDb(), exit
  // by signal instead of through the cleanup path — and the banner is precisely
  // the readiness signal anything watching this process keys off.
  const src = readFileSync(join(here, "..", "src", "bin", "inspect.ts"), "utf8");
  const follow = src.slice(src.indexOf("function runFollow"));
  const sigint = follow.indexOf("process.on('SIGINT'");
  // Anchor on the banner's CODE, not on the phrase "ctrl-c to stop" — the first
  // version of this guard matched that phrase inside its own explanatory comment
  // above the handlers and reported the ordering backwards. A guard that can see
  // prose it wrote about itself is measuring the wrong thing.
  const banner = follow.indexOf("· poll ${intervalMs}ms");
  assert.ok(sigint > 0, "expected a SIGINT registration in the follow path");
  assert.ok(banner > 0, "expected the banner's stdout.write in the follow path");
  assert.ok(
    sigint < banner,
    "the SIGINT/SIGTERM handlers must be registered BEFORE the banner advertises ctrl-c"
  );
});

test("inspect --follow: idle banner on empty ledger, live message within budget, --fleet filters in-loop, clean ctrl-c exit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-follow-"));
  const dbFile = join(dir, "ledger.db");
  let child: PipedChild | undefined;
  try {
    // Pre-initialize the DB in the parent (matches db-concurrency.test.ts) so
    // the child attaches to an existing WAL db instead of racing the cold-file
    // journal-mode conversion.
    setDbPath(dbFile);
    readLedger();
    closeDb();

    child = spawnFollow(dbFile, ["--fleet", "fleet-WATCH"]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));

    // Empty-ledger case must not look broken: an explicit idle banner, fast.
    await waitFor(() => stdout, (out) => /watching/i.test(out), 5_000);
    assert.match(stdout, /ledger:.*poll \d+ms.*ctrl-c/i);

    // A message on a FILTERED-OUT fleet must not appear (and must not be
    // enough to "wake up" the follow loop into producing output).
    setDbPath(dbFile);
    sendMessage("agent-a", "agent-b", "fleet-OTHER", "alert", "should-not-print");
    closeDb();

    // The watched-fleet message, sent after, must appear inside the budget.
    setDbPath(dbFile);
    sendMessage("agent-a", "agent-b", "fleet-WATCH", "alert", "hello-from-watch");
    closeDb();

    const withMessage = await waitFor(
      () => stdout,
      (out) => out.includes("hello-from-watch"),
      FIRST_MESSAGE_BUDGET_MS
    );
    assert.match(withMessage, /hello-from-watch/);
    assert.doesNotMatch(withMessage, /should-not-print/, "--fleet filter must apply inside the poll loop, not post-hoc");

    // Ctrl-c must exit promptly and cleanly — no hang, no stack trace on stderr.
    child.kill("SIGINT");
    const res = await waitExit(child, 5_000);
    assertCleanSignalExit(res, stderr);
    assert.doesNotMatch(stderr, /Error|Traceback|at Object\./, `unexpected stderr on clean exit:\n${stderr}`);
  } finally {
    if (child && child.exitCode === null && !child.killed) child.kill("SIGKILL");
    setDbPath(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inspect --follow: a malformed message row is skipped (logged to stderr), the loop keeps polling, later valid rows still print", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-follow-badjson-"));
  const dbFile = join(dir, "ledger.db");
  let child: PipedChild | undefined;
  try {
    setDbPath(dbFile);
    readLedger();
    closeDb();

    child = spawnFollow(dbFile);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    await waitFor(() => stdout, (out) => /watching/i.test(out), 5_000);

    // Insert a row whose `data` column is simply not valid JSON — a raw SQL
    // write, bypassing the normal Message-shaped withLedger path on purpose,
    // to simulate ledger corruption the follow loop must survive.
    const raw = new Database(dbFile);
    raw.prepare("INSERT INTO messages (id, fleet_id, data) VALUES (?, ?, ?)").run(
      "bad-1",
      "fleet-1",
      "{ this is not valid JSON "
    );
    raw.close();

    await waitFor(() => stderr, (out) => /skipping malformed message row/i.test(out), FIRST_MESSAGE_BUDGET_MS);
    assert.match(stderr, /bad-1/);

    // The loop must still be alive and still polling afterward.
    assert.equal(child.exitCode, null, "follow must not crash/exit on a malformed row");
    sendMessage("agent-a", "agent-b", "fleet-1", "alert", "still-alive-after-corruption");
    await waitFor(() => stdout, (out) => out.includes("still-alive-after-corruption"), FIRST_MESSAGE_BUDGET_MS);

    child.kill("SIGINT");
    const res = await waitExit(child, 5_000);
    assertCleanSignalExit(res);
  } finally {
    if (child && child.exitCode === null && !child.killed) child.kill("SIGKILL");
    setDbPath(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inspect --follow: SIGTERM also exits promptly and cleanly (same cleanup path as SIGINT)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-follow-sigterm-"));
  const dbFile = join(dir, "ledger.db");
  let child: PipedChild | undefined;
  try {
    setDbPath(dbFile);
    readLedger();
    closeDb();

    child = spawnFollow(dbFile);
    let stdout = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    await waitFor(() => stdout, (out) => /watching/i.test(out), 5_000);

    child.kill("SIGTERM");
    const res = await waitExit(child, 5_000);
    assertCleanSignalExit(res);
  } finally {
    if (child && child.exitCode === null && !child.killed) child.kill("SIGKILL");
    setDbPath(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inspect --follow: a genuinely missing ledger file is a hard error (exit 2) — never silently created", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-follow-missing-"));
  const dbFile = join(dir, "does-not-exist.db");
  let child: PipedChild | undefined;
  try {
    assert.equal(existsSync(dbFile), false);
    child = spawnFollow(dbFile);
    let stderr = "";
    child.stdout.on("data", () => {}); // drain, don't care about content
    child.stderr.on("data", (b) => (stderr += b.toString()));

    const { code } = await waitExit(child, 5_000);
    assert.equal(code, 2);
    assert.match(stderr, /not found/i);
    // The whole point of the check: --follow must never invent a ledger by
    // opening a connection to a file that was never there.
    assert.equal(existsSync(dbFile), false, "--follow must not create the ledger file as a side effect");
  } finally {
    if (child && child.exitCode === null && !child.killed) child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
