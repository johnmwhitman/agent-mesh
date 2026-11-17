import { test } from "node:test";
import assert from "node:assert/strict";
import { filterDashboardEvent, parseSseFrames } from "../src/dashboard-sse.js";

// ---------------------------------------------------------------------------
// Unit tests for pure SSE helpers in src/dashboard-sse.ts
// ---------------------------------------------------------------------------

test("parseSseFrames: splits frames on LF (\\n\\n)", () => {
  const input =
    'event: message_sent\ndata: {"id":1}\n\n' +
    'event: agent_spawned\ndata: {"id":2}\n\n';
  const result = parseSseFrames(input);

  assert.equal(result.remainder, "");
  assert.deepEqual(result.frames, [
    { event: "message_sent", data: { id: 1 } },
    { event: "agent_spawned", data: { id: 2 } },
  ]);
});

test("parseSseFrames: splits frames on CRLF (\\r\\n\\r\\n)", () => {
  const input =
    'event: message_sent\r\ndata: {"id":1}\r\n\r\n' +
    'event: agent_spawned\r\ndata: {"id":2}\r\n\r\n';
  const result = parseSseFrames(input);

  assert.equal(result.remainder, "");
  assert.deepEqual(result.frames, [
    { event: "message_sent", data: { id: 1 } },
    { event: "agent_spawned", data: { id: 2 } },
  ]);
});

test("parseSseFrames: splits frames with mixed LF and CRLF boundaries", () => {
  const input =
    'event: ev1\ndata: {"step":1}\n\n' +
    'event: ev2\r\ndata: {"step":2}\r\n\r\n' +
    'event: ev3\r\ndata: {"step":3}\n\n';
  const result = parseSseFrames(input);

  assert.equal(result.remainder, "");
  assert.deepEqual(result.frames, [
    { event: "ev1", data: { step: 1 } },
    { event: "ev2", data: { step: 2 } },
    { event: "ev3", data: { step: 3 } },
  ]);
});

test("parseSseFrames: handles multi-line data fields", () => {
  // SSE specification allows multiple data lines concatenated with newline
  const input =
    "event: multi_line\n" +
    "data: {\n" +
    'data:   "message": "hello\\nworld",\n' +
    'data:   "count": 42\n' +
    "data: }\n\n";
  const result = parseSseFrames(input);

  assert.equal(result.remainder, "");
  assert.deepEqual(result.frames, [
    {
      event: "multi_line",
      data: {
        message: "hello\nworld",
        count: 42,
      },
    },
  ]);
});

test("parseSseFrames: handles multi-line data fields with CRLF line endings", () => {
  const input =
    "event: multi_crlf\r\n" +
    "data: {\r\n" +
    'data: "status": "ok",\r\n' +
    'data: "fleet_id": "f-1"\r\n' +
    "data: }\r\n\r\n";
  const result = parseSseFrames(input);

  assert.equal(result.remainder, "");
  assert.deepEqual(result.frames, [
    {
      event: "multi_crlf",
      data: {
        status: "ok",
        fleet_id: "f-1",
      },
    },
  ]);
});

test("parseSseFrames: returns entire input as remainder when there is no complete frame", () => {
  const input = 'event: unfinished\ndata: {"incomplete": true}';
  const result = parseSseFrames(input);

  assert.deepEqual(result.frames, []);
  assert.equal(result.remainder, input);
});

test("parseSseFrames: defaults event name to 'message' when omitted", () => {
  const input = 'data: {"foo":"bar"}\n\n';
  const result = parseSseFrames(input);

  assert.deepEqual(result.frames, [
    { event: "message", data: { foo: "bar" } },
  ]);
  assert.equal(result.remainder, "");
});

test("parseSseFrames: ignores comments and lines without data", () => {
  const input =
    ": this is a comment\n" +
    ": another comment\n" +
    "event: custom\n" +
    ": comment inside frame\n" +
    'data: {"valid":true}\n\n' +
    ": frame with comments only\n\n";
  const result = parseSseFrames(input);

  assert.deepEqual(result.frames, [
    { event: "custom", data: { valid: true } },
  ]);
  assert.equal(result.remainder, "");
});

test("parseSseFrames: skips frames with non-JSON or non-object data", () => {
  const input =
    "event: bad_json\ndata: not-json\n\n" +
    "event: json_primitive\ndata: 12345\n\n" +
    "event: json_array\ndata: [1, 2, 3]\n\n" +
    "event: json_null\ndata: null\n\n" +
    'event: good\ndata: {"good":true}\n\n';
  const result = parseSseFrames(input);

  assert.deepEqual(result.frames, [
    { event: "good", data: { good: true } },
  ]);
  assert.equal(result.remainder, "");
});

test("parseSseFrames: handles empty input", () => {
  const result = parseSseFrames("");
  assert.deepEqual(result.frames, []);
  assert.equal(result.remainder, "");
});

test("filterDashboardEvent: passes every event when fleetId is undefined", () => {
  // Event with matching or different fleet_id, or missing fleet_id, or empty object
  assert.equal(filterDashboardEvent({}, undefined), true);
  assert.equal(filterDashboardEvent({ event: "server_heartbeat" }, undefined), true);
  assert.equal(filterDashboardEvent({ fleet_id: "fleet-1" }, undefined), true);
  assert.equal(filterDashboardEvent({ fleet_id: "fleet-2", event: "agent_spawned" }, undefined), true);
  assert.equal(filterDashboardEvent({ fleet_id: undefined }, undefined), true);
  assert.equal(filterDashboardEvent({ fleet_id: null }, undefined), true);
});

test("filterDashboardEvent: rejects missing and non-string fleet IDs when a fleet is specified", () => {
  const targetFleet = "fleet-target";

  assert.equal(filterDashboardEvent({}, targetFleet), false);
  assert.equal(filterDashboardEvent({ event: "server_heartbeat" }, targetFleet), false);
  assert.equal(filterDashboardEvent({ fleet_id: undefined }, targetFleet), false);
  assert.equal(filterDashboardEvent({ fleet_id: null }, targetFleet), false);
  assert.equal(filterDashboardEvent({ fleet_id: 123 }, targetFleet), false);
});
