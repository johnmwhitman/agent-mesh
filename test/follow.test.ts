/**
 * `inspect --follow` live-tail data path: pollMessagesSince + maxMessageRowid
 * (src/db.ts), and formatLiveMessage (src/inspector.ts).
 *
 * Covers the exact bug v1's design had: a timestamp-equality cursor
 * (`timestamp > lastSeen`) ties on same-millisecond messages and silently
 * drops one of them. v2 uses the messages table's implicit SQLite rowid,
 * which is strictly increasing per insert and never ties.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { maxMessageRowid, pollMessagesSince, withLedger, setDbPath, closeFollowDb } from "../src/db.js";
import { type Message } from "../src/core.js";
import { formatLiveMessage, dedupeFollowRows } from "../src/inspector.js";
import { withTempDb } from "./helpers/with-temp-db.js";

function makeMessage(over: Partial<Message> & { id: string }): Message {
  return {
    from_agent_id: "agent-a",
    to_agent_id: "agent-b",
    fleet_id: "fleet-1",
    type: "handoff",
    payload: "payload",
    timestamp: Date.now(),
    acknowledged: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Empty ledger
// ---------------------------------------------------------------------------

test("follow: empty (but EXISTING) ledger — maxMessageRowid is 0, poll returns nothing", () => {
  // `{}` forces withTempDb to seed (importSnapshot), which creates the file +
  // schema via getDb() — the follow connection's `fileMustExist: true` needs
  // the file to actually be there, same as a real first-run ledger created by
  // any other inspect subcommand before anyone runs --follow against it.
  const db = withTempDb({});
  try {
    assert.equal(maxMessageRowid(), 0);
    assert.deepEqual(pollMessagesSince(0), []);
    assert.deepEqual(pollMessagesSince(0, "any-fleet"), []);
  } finally {
    db.cleanup();
  }
});

test("follow: a ledger path that has never been opened by anything throws (never silently created)", () => {
  const db = withTempDb(); // path set, but file never created (no seed)
  try {
    assert.throws(() => maxMessageRowid());
    assert.throws(() => pollMessagesSince(0));
  } finally {
    db.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Same-millisecond cursor correctness — the exact v1 bug
// ---------------------------------------------------------------------------

test("follow: two messages with an identical timestamp both surface (rowid, not timestamp, is the cursor)", () => {
  const db = withTempDb();
  try {
    const tiedTs = 1_700_000_000_000;
    withLedger((data) => {
      data.messages["m-a"] = makeMessage({ id: "m-a", timestamp: tiedTs });
      data.messages["m-b"] = makeMessage({ id: "m-b", timestamp: tiedTs });
    });

    const cursor0 = 0;
    const rows = pollMessagesSince(cursor0);
    const ids = rows.map((r) => r.id);

    // A `timestamp > cursor` design tracking "last seen timestamp" would emit
    // one of these, advance its cursor to tiedTs, then find the second row's
    // timestamp is NOT > tiedTs and drop it forever. rowid ties never happen.
    assert.deepEqual(ids.sort(), ["m-a", "m-b"].sort());
    assert.equal(rows.length, 2);

    // rowid is strictly increasing (insertion order), even though timestamps tie.
    assert.ok(rows[0].rowid < rows[1].rowid, "rowid must break the timestamp tie");
  } finally {
    db.cleanup();
  }
});

test("follow: cursor advances past tied-timestamp rows so a later poll doesn't re-emit them", () => {
  const db = withTempDb();
  try {
    const tiedTs = 1_700_000_000_000;
    withLedger((data) => {
      data.messages["m-a"] = makeMessage({ id: "m-a", timestamp: tiedTs });
      data.messages["m-b"] = makeMessage({ id: "m-b", timestamp: tiedTs });
    });

    let cursor = 0;
    const first = pollMessagesSince(cursor);
    cursor = Math.max(...first.map((r) => r.rowid));
    assert.equal(first.length, 2);

    // Nothing new yet.
    assert.deepEqual(pollMessagesSince(cursor), []);

    // A third message (later, distinct ms) must be the only thing returned.
    withLedger((data) => {
      data.messages["m-c"] = makeMessage({ id: "m-c", fleet_id: "fleet-1", timestamp: tiedTs + 50 });
    });
    const second = pollMessagesSince(cursor);
    assert.equal(second.length, 1);
    assert.equal(second[0].id, "m-c");
  } finally {
    db.cleanup();
  }
});

// ---------------------------------------------------------------------------
// --fleet filter applied INSIDE the poll query, not post-hoc
// ---------------------------------------------------------------------------

test("follow: --fleet filter runs in the poll query — a later other-fleet row can't hide an earlier watched-fleet row", () => {
  const db = withTempDb();
  try {
    withLedger((data) => {
      data.messages["other-1"] = makeMessage({ id: "other-1", fleet_id: "fleet-OTHER", timestamp: 1000 });
      data.messages["watched-1"] = makeMessage({ id: "watched-1", fleet_id: "fleet-WATCH", timestamp: 1001 });
      data.messages["other-2"] = makeMessage({ id: "other-2", fleet_id: "fleet-OTHER", timestamp: 1002 });
    });

    const rows = pollMessagesSince(0, "fleet-WATCH");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "watched-1");

    // Cursor advanced from a filtered query must still be a valid rowid to
    // resume from — later inserts to the watched fleet must still appear.
    const cursor = rows[0].rowid;
    withLedger((data) => {
      data.messages["watched-2"] = makeMessage({ id: "watched-2", fleet_id: "fleet-WATCH", timestamp: 1003 });
    });
    const rows2 = pollMessagesSince(cursor, "fleet-WATCH");
    assert.equal(rows2.length, 1);
    assert.equal(rows2[0].id, "watched-2");
  } finally {
    db.cleanup();
  }
});

test("follow: unfiltered poll sees all fleets; filtered poll on an unmatched fleet stays empty (not an error)", () => {
  const db = withTempDb();
  try {
    withLedger((data) => {
      data.messages["m-1"] = makeMessage({ id: "m-1", fleet_id: "fleet-A" });
    });
    assert.equal(pollMessagesSince(0).length, 1);
    assert.deepEqual(pollMessagesSince(0, "fleet-DOES-NOT-EXIST"), []);
  } finally {
    db.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P0 fix regression: the follow connection must NEVER write — not the file,
// not the journal mode, not a WAL sidecar. Built without going through
// getDb() or withTempDb() at all, so nothing but the code under test can
// possibly touch the ledger: schema is created with a raw, non-WAL
// better-sqlite3 connection, closed, then only maxMessageRowid/
// pollMessagesSince ever touch the file again.
// ---------------------------------------------------------------------------

test("follow: the dedicated connection never mutates the ledger — file bytes, journal mode, and sidecars all unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-follow-nowrite-"));
  const dbFile = join(dir, "ledger.db");
  try {
    // Deliberately NOT getDb(): build schema with a plain connection so the
    // journal mode stays SQLite's default (not WAL). If pollMessagesSince/
    // maxMessageRowid silently fell back to getDb() (the P0 bug), opening it
    // would immediately flip journal_mode to WAL and create -wal/-shm — the
    // dedicated readonly connection must not.
    const raw = new Database(dbFile);
    raw.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, fleet_id TEXT, data TEXT NOT NULL)");
    const seedMsg: Message = makeMessage({ id: "m1", fleet_id: "f1" });
    raw.prepare("INSERT INTO messages (id, fleet_id, data) VALUES (?, ?, ?)").run(
      "m1",
      "f1",
      JSON.stringify(seedMsg)
    );
    const journalBefore = raw.pragma("journal_mode", { simple: true });
    raw.close();

    assert.notEqual(journalBefore, "wal", "test setup itself must not be in WAL mode (or this test proves nothing)");
    assert.equal(existsSync(dbFile + "-wal"), false);
    assert.equal(existsSync(dbFile + "-shm"), false);
    const shaBefore = createHash("sha256").update(readFileSync(dbFile)).digest("hex");

    setDbPath(dbFile);
    try {
      assert.equal(maxMessageRowid(), 1);
      assert.equal(pollMessagesSince(0).length, 1);
      assert.equal(pollMessagesSince(0, "f1").length, 1);
      assert.equal(pollMessagesSince(0, "does-not-exist").length, 0);
    } finally {
      closeFollowDb();
      setDbPath(null);
    }

    const shaAfter = createHash("sha256").update(readFileSync(dbFile)).digest("hex");
    assert.equal(shaAfter, shaBefore, "the follow connection mutated the ledger file bytes");
    assert.equal(existsSync(dbFile + "-wal"), false, "the follow connection created a WAL sidecar");
    assert.equal(existsSync(dbFile + "-shm"), false, "the follow connection created a SHM sidecar");

    const rawAfter = new Database(dbFile, { readonly: true });
    const journalAfter = rawAfter.pragma("journal_mode", { simple: true });
    rawAfter.close();
    assert.equal(journalAfter, journalBefore, "the follow connection changed the journal mode");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("follow: against an already-WAL ledger (the realistic case — every other command bootstraps WAL), the main db file bytes are still never mutated", () => {
  // Disclosed, verified residual: SQLite's own WAL-reader protocol may still
  // create/touch `-wal`/`-shm` sidecars for ANY reader of a WAL-mode database
  // (readonly or not) — that's inherent SQLite mechanics, not this feature
  // writing application data. The property that actually matters, and that
  // IS fully within this code's control, is asserted here: the main .db
  // file's bytes never change.
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-follow-wal-nowrite-"));
  const dbFile = join(dir, "ledger.db");
  try {
    const writer = new Database(dbFile);
    writer.pragma("journal_mode = WAL");
    writer.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, fleet_id TEXT, data TEXT NOT NULL)");
    const seedMsg: Message = makeMessage({ id: "m1", fleet_id: "f1" });
    writer.prepare("INSERT INTO messages (id, fleet_id, data) VALUES (?, ?, ?)").run(
      "m1",
      "f1",
      JSON.stringify(seedMsg)
    );
    writer.close(); // checkpoints; a clean WAL-mode ledger at rest, exactly like a real one between commands

    const shaBefore = createHash("sha256").update(readFileSync(dbFile)).digest("hex");

    setDbPath(dbFile);
    try {
      assert.equal(maxMessageRowid(), 1);
      assert.equal(pollMessagesSince(0).length, 1);
    } finally {
      closeFollowDb();
      setDbPath(null);
    }

    const shaAfter = createHash("sha256").update(readFileSync(dbFile)).digest("hex");
    assert.equal(shaAfter, shaBefore, "the follow connection mutated the main ledger file's bytes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P0/§6 regression: dedupeFollowRows (the seenIds gate) must suppress a
// repeat sighting of the same message id at a DIFFERENT rowid.
//
// NOTE ON A REAL UPSTREAM CHANGE (found while rebasing onto main's PR #15):
// the design doc and grk's review assumed LazyColl.persist() used
// `INSERT OR REPLACE`, which SQLite implements as delete-then-insert and so
// reassigns rowid on an update to an existing key. PR #15's durable-lifecycle
// work switched persistence to `INSERT ... ON CONFLICT(pk) DO UPDATE`
// (db.ts's LazyColl.persist/eagerPersist) — verified empirically: an UPDATE
// preserves rowid, it does NOT reassign it. So today, no write path in this
// codebase can actually change an existing message's rowid; the scenario
// dedupeFollowRows was built to guard against currently cannot occur through
// the real persistence layer. It stays anyway as cheap, harmless insurance
// (a future migration, a raw-SQL admin script, or another persistence change
// could reintroduce rowid churn) — tested here directly against the pure
// function with a synthetic same-id/different-rowid pair, decoupled from
// whatever today's real DB does, so this coverage survives regardless of
// which persistence strategy is in effect.
// ---------------------------------------------------------------------------

test("follow: an in-place update to an existing message does NOT change its rowid (verifies the current ON CONFLICT DO UPDATE persistence — not delete+insert)", () => {
  const db = withTempDb();
  try {
    withLedger((data) => {
      data.messages["m1"] = makeMessage({ id: "m1", payload: "v1" });
    });
    const firstRows = pollMessagesSince(0);
    assert.equal(firstRows.length, 1);
    const cursorAfterFirst = firstRows[0]!.rowid;

    // Re-write the SAME message id with different content.
    withLedger((data) => {
      data.messages["m1"] = makeMessage({ id: "m1", payload: "v2 (updated)" });
    });

    // Under ON CONFLICT DO UPDATE this is an UPDATE of the existing row: its
    // rowid does not change, so it never becomes visible to `rowid > cursor`
    // again — the follow feed simply never re-surfaces field-level edits to
    // an already-seen message, by construction of the cursor itself (no
    // dedup logic needed for THIS case).
    assert.deepEqual(pollMessagesSince(cursorAfterFirst), []);
  } finally {
    db.cleanup();
  }
});

test("follow: dedupeFollowRows suppresses a repeat sighting of the same message id at a different rowid (synthetic — the seenIds contract itself, independent of how the DB behaves today)", () => {
  const seenIds = new Set<string>();
  const first = dedupeFollowRows([{ rowid: 1, id: "m1" }], seenIds);
  assert.equal(first.length, 1, "first sighting must be emitted");

  // Simulate the id resurfacing at a NEW rowid (whatever the cause — future
  // migration, admin tooling, a persistence strategy change back to
  // delete+insert). dedupeFollowRows must not care how it got here.
  const second = dedupeFollowRows([{ rowid: 2, id: "m1" }], seenIds);
  assert.equal(second.length, 0, "same message id at a different rowid must not be re-emitted");

  const third = dedupeFollowRows([{ rowid: 3, id: "m2" }], seenIds);
  assert.equal(third.length, 1, "a genuinely different id must still be emitted");
});

test("follow: dedupeFollowRows caps seenIds (FIFO eviction) so a long-running session can't leak memory", () => {
  const seenIds = new Set<string>();
  const cap = 5;
  const rows = Array.from({ length: 8 }, (_, i) => ({ rowid: i + 1, id: `id-${i}` }));
  const fresh = dedupeFollowRows(rows, seenIds, cap);
  assert.equal(fresh.length, 8, "every distinct id is fresh on first sighting regardless of cap");
  assert.ok(seenIds.size <= cap, `seenIds must stay capped at ${cap}, was ${seenIds.size}`);
  // The oldest ids should have been evicted; the most recent ones remain.
  assert.ok(seenIds.has("id-7"));
  assert.ok(!seenIds.has("id-0"), "oldest id should have been evicted once over cap");
});

// ---------------------------------------------------------------------------
// formatLiveMessage — pure formatting
// ---------------------------------------------------------------------------

test("formatLiveMessage: renders type, from/to, message id, and payload", () => {
  const msg = makeMessage({
    id: "msg-1234567890",
    from_agent_id: "agent-alpha",
    to_agent_id: "agent-beta",
    type: "alert",
    payload: "hello world",
    timestamp: 1_700_000_000_000,
  });
  const out = formatLiveMessage(msg);
  assert.match(out, /alert/);
  assert.match(out, /agent-a/); // truncated (max 8 chars incl. ellipsis)
  assert.match(out, /agent-b/); // truncated
  assert.match(out, /hello world/);
  assert.match(out, /msg=/);
});

test("formatLiveMessage: broadcast target renders as * (recipient count)", () => {
  const msg = makeMessage({
    id: "msg-b",
    to_agent_id: "*",
    recipients: ["a1", "a2", "a3"],
  });
  const out = formatLiveMessage(msg);
  assert.match(out, /\*\s*\(3\)/);
});
