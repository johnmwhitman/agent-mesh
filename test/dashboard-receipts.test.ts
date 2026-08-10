import { test } from "node:test";
import assert from "node:assert/strict";

import { renderDashboard, type DashboardReceipt } from "../src/bin/dashboard.js";
import type { DashboardEvent } from "../src/dashboard-sse.js";

// ---------------------------------------------------------------------------
// D2.1: dashboard receipt timeline panel — pure render tests.
// ---------------------------------------------------------------------------

const NO_FLEETS = { fleetCount: 0, agentCount: 0, receiptCount: 0, now: "2026-01-01 00:00:00" };

test("renderDashboard excludes the receipt panel when --receipts is off", () => {
  const out = renderDashboard({
    fleets: [],
    agents: [],
    events: [],
    receipts: [],
    showReceipts: false,
    receiptLimit: 10,
    clock: "2026-01-01 00:00:00",
  }).join("\n");
  assert.doesNotMatch(out, /Recent Receipts/);
});

test("renderDashboard includes the receipt panel when --receipts is on", () => {
  const out = renderDashboard({
    fleets: [],
    agents: [],
    events: [],
    receipts: [],
    showReceipts: true,
    receiptLimit: 10,
    clock: "2026-01-01 00:00:00",
  }).join("\n");
  assert.match(out, /Recent Receipts/);
});

test("renderDashboard formats receipt timeline rows with time, action, agent prefix, message prefix", () => {
  const receipt: DashboardReceipt = {
    agent_id: "agent-abcdef1234567890",
    message_id: "msg-deadbeefcafef00d",
    action: "ack",
    timestamp: Date.UTC(2026, 0, 1, 12, 34, 56),
  };
  const out = renderDashboard({
    fleets: [],
    agents: [],
    events: [],
    receipts: [receipt],
    showReceipts: true,
    receiptLimit: 10,
    clock: "2026-01-01 00:00:00",
  }).join("\n");
  assert.match(out, /12:34:56/);
  assert.match(out, /ack/);
  assert.match(out, /agent-abc/);
  assert.match(out, /msg-dead/);
});

test("renderDashboard caps the receipt timeline at receiptLimit (caller-supplied order)", () => {
  const base = Date.UTC(2026, 0, 1, 12, 0, 0);
  // Caller passes newest-first; renderDashboard is a pure display, not a sorter.
  const receipts: DashboardReceipt[] = [5, 4, 3, 2, 1].map((i) => ({
    agent_id: `a${i}`,
    message_id: `m${i}`,
    action: "ack",
    timestamp: base + i * 1000,
  }));
  const out = renderDashboard({
    fleets: [],
    agents: [],
    events: [],
    receipts,
    showReceipts: true,
    receiptLimit: 2,
    clock: "2026-01-01 00:00:00",
  }).join("\n");
  assert.match(out, /\ba5\b/);
  assert.match(out, /\ba4\b/);
  assert.doesNotMatch(out, /\ba3\b/);
});

test("renderDashboard shows '(none)' when receipts panel is empty but enabled", () => {
  const out = renderDashboard({
    fleets: [],
    agents: [],
    events: [],
    receipts: [],
    showReceipts: true,
    receiptLimit: 10,
    clock: "2026-01-01 00:00:00",
  }).join("\n");
  assert.match(out, /\(none\)/);
});

test("renderDashboard receipt timeline still renders when an event list is given (does not regress)", () => {
  const event: DashboardEvent = { event: "agent_spawned" };
  const out = renderDashboard({
    fleets: [],
    agents: [],
    events: [event],
    receipts: [],
    showReceipts: true,
    receiptLimit: 10,
    clock: "2026-01-01 00:00:00",
  }).join("\n");
  assert.match(out, /Recent Agents/);
  assert.match(out, /Recent Events/);
  assert.match(out, /Recent Receipts/);
});
