import { test } from "node:test";
import assert from "node:assert/strict";
import { LifecycleExecutionCoordinator } from "../src/lifecycle-execution.js";
import { readLifecycleSnapshot } from "../src/lifecycle-visibility.js";
import type { RuntimeAdapter } from "../src/runtime/types.js";
import { audit, withHealthyLedger } from "./verifier-metadata-helpers.js";

test("gap217: real outbox producer uses independent event IDs and must remain healthy", () => {
  withHealthyLedger((file) => {
    const runtime: RuntimeAdapter = {
      id: "unused", describe: () => ({ id: "unused", displayName: "unused", defaultTimeoutMs: 1 }),
      validate: () => ({ ok: true, errors: [] }),
      start: async () => { throw new Error("no runtime starts allowed"); },
      wait: async () => { throw new Error("no runtime waits allowed"); },
      cancel: async () => ({ accepted: true }),
    };
    const coordinator = new LifecycleExecutionCoordinator(runtime);
    try {
      coordinator.createFleet("outbox", []);
      const snapshot = readLifecycleSnapshot(file);
      const eventIds = new Set(snapshot.events.map((e) => e.event_id));
      assert.ok(snapshot.outbox.length >= 2);
      assert.ok(snapshot.outbox.every((row) => !eventIds.has(row.event_id)));
      assert.deepEqual(audit(file, Date.now()), []);
      console.log("healthy writer outbox without attempt_events matches:", snapshot.outbox.length);
    } finally { coordinator.stop(); }
  });
});
