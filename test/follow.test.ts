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

import { maxMessageRowid, pollMessagesSince, withLedger } from "../src/db.js";
import { type Message } from "../src/core.js";
import { formatLiveMessage } from "../src/inspector.js";
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

test("follow: empty ledger — maxMessageRowid is 0, poll returns nothing", () => {
  const db = withTempDb();
  try {
    assert.equal(maxMessageRowid(), 0);
    assert.deepEqual(pollMessagesSince(0), []);
    assert.deepEqual(pollMessagesSince(0, "any-fleet"), []);
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
