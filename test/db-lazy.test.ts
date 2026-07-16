import { test } from "node:test";
import assert from "node:assert/strict";

import { withLedger, readLedger, lastTxnStats } from "../src/db.js";
import { sendMessage, type MeshData, type Message } from "../src/core.js";
import { withTempDb } from "./helpers/with-temp-db.js";

// The v0.9 perf item: a mutator that touches one entity must not pay to parse
// the whole ledger. These tests pin BOTH the surgical-read property (via
// lastTxnStats) and the exact eager semantics the lazy views must preserve.

function msg(id: string, over: Partial<Message> = {}): Message {
  return {
    id,
    from_agent_id: "a1",
    to_agent_id: "a2",
    fleet_id: "f1",
    type: "handoff",
    payload: "x",
    timestamp: 1_000,
    acknowledged: false,
    ...over,
  };
}

function bigSeed(n: number): Partial<MeshData> {
  return {
    fleets: { f1: { id: "f1", status: "running", created_at: 1 } },
    agents: {
      a1: { id: "a1", fleet_id: "f1", role: "r", prompt: "p", status: "running" },
      a2: { id: "a2", fleet_id: "f1", role: "r", prompt: "p", status: "running" },
    },
    messages: Object.fromEntries(Array.from({ length: n }, (_, i) => [`m${i}`, msg(`m${i}`)])),
    inboxes: { a1: [], a2: Array.from({ length: n }, (_, i) => `m${i}`) },
  };
}

test("a single-entity write parses only the rows it touches, not the whole ledger", () => {
  const l = withTempDb(bigSeed(500));
  try {
    sendMessage("a1", "a2", "f1", "result", "hot path");
    const stats = lastTxnStats();
    assert.ok(
      stats.rowsParsed < 20,
      `sendMessage against a 500-message ledger parsed ${stats.rowsParsed} rows — the O(N) per-txn load is back`,
    );
  } finally {
    l.cleanup();
  }
});

test("lazy views preserve write semantics: the sent message and inbox update persist", () => {
  const l = withTempDb(bigSeed(50));
  try {
    const { messageId } = sendMessage("a1", "a2", "f1", "result", "persisted?");
    const data = readLedger();
    assert.equal(Object.keys(data.messages).length, 51);
    assert.equal(data.messages[messageId]?.payload, "persisted?");
    assert.equal(data.inboxes.a2?.length, 51);
    assert.ok(data.inboxes.a2?.includes(messageId));
  } finally {
    l.cleanup();
  }
});

test("enumerating a collection inside a txn sees every row (hydration)", () => {
  const l = withTempDb(bigSeed(120));
  try {
    const count = withLedger((d) => Object.keys(d.messages).length);
    assert.equal(count, 120);
  } finally {
    l.cleanup();
  }
});

test("deleting a row inside a txn removes it from storage", () => {
  const l = withTempDb(bigSeed(10));
  try {
    withLedger((d) => {
      delete d.messages.m3;
    });
    const data = readLedger();
    assert.equal(data.messages.m3, undefined);
    assert.equal(Object.keys(data.messages).length, 9);
  } finally {
    l.cleanup();
  }
});

test("mutating a row read through the view persists (no set-trap required)", () => {
  const l = withTempDb(bigSeed(10));
  try {
    withLedger((d) => {
      d.messages.m2!.payload = "edited-in-place";
    });
    assert.equal(readLedger().messages.m2?.payload, "edited-in-place");
  } finally {
    l.cleanup();
  }
});

test("reading a missing key returns undefined and a guarded init works", () => {
  const l = withTempDb(bigSeed(5));
  try {
    withLedger((d) => {
      assert.equal(d.messages.ghost, undefined);
      if (!d.inboxes.newcomer) d.inboxes.newcomer = [];
      d.inboxes.newcomer.push("m1");
    });
    assert.deepEqual(readLedger().inboxes.newcomer, ["m1"]);
  } finally {
    l.cleanup();
  }
});

test("'in' and Object.entries work against the view", () => {
  const l = withTempDb(bigSeed(8));
  try {
    withLedger((d) => {
      assert.ok("m4" in d.messages);
      assert.ok(!("nope" in d.messages));
      const entries = Object.entries(d.messages);
      assert.equal(entries.length, 8);
      assert.ok(entries.every(([k, v]) => (v as Message).id === k));
    });
  } finally {
    l.cleanup();
  }
});

test("wholesale collection replacement keeps eager semantics (rows not in the new object are deleted)", () => {
  const l = withTempDb(bigSeed(6));
  try {
    withLedger((d) => {
      d.inboxes = { solo: ["m0"] };
    });
    assert.deepEqual(readLedger().inboxes, { solo: ["m0"] });
  } finally {
    l.cleanup();
  }
});

test("Object.defineProperty with a data descriptor persists like a plain set", () => {
  const l = withTempDb(bigSeed(3));
  try {
    withLedger((d) => {
      Object.defineProperty(d.messages, "defined", {
        value: msg("defined"),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    });
    assert.equal(readLedger().messages.defined?.id, "defined");
  } finally {
    l.cleanup();
  }
});

test("a row keyed '__proto__' round-trips as an own property without polluting prototypes", () => {
  const l = withTempDb(bigSeed(2));
  try {
    withLedger((d) => {
      d.messages["__proto__"] = msg("__proto__");
    });
    const data = readLedger();
    assert.equal(Object.keys(data.messages).length, 3);
    const row = Object.getOwnPropertyDescriptor(data.messages, "__proto__")?.value as Message | undefined;
    assert.equal(row?.id, "__proto__");
    assert.equal(({} as Record<string, unknown>).id, undefined, "Object.prototype must not be polluted");
  } finally {
    l.cleanup();
  }
});

test("a key set to undefined is consistently visible to 'in', keys, and descriptors", () => {
  const l = withTempDb(bigSeed(2));
  try {
    withLedger((d) => {
      (d.messages as Record<string, unknown>).x = undefined;
      assert.ok("x" in d.messages, "'in' must agree with Object.keys");
      assert.ok(Object.keys(d.messages).includes("x"));
      delete (d.messages as Record<string, unknown>).x; // clean up so commit succeeds
    });
  } finally {
    l.cleanup();
  }
});

test("a throwing mutator rolls back lazily-written rows", () => {
  const l = withTempDb(bigSeed(4));
  try {
    assert.throws(() =>
      withLedger((d) => {
        d.messages.doomed = msg("doomed");
        throw new Error("abort");
      }),
    );
    assert.equal(readLedger().messages.doomed, undefined);
    assert.equal(Object.keys(readLedger().messages).length, 4);
  } finally {
    l.cleanup();
  }
});
