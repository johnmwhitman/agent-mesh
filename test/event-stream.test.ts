import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addEventSubscriber,
  removeEventSubscriber,
  notifyEventSubscribers,
  getEventStreamSubscriberCount,
  shutdownEventStream,
  setMaxEventStreamConnections,
  MAX_EVENT_STREAM_CONNECTIONS_DEFAULT,
} from "../src/event-stream.js";

function makeFakeRes() {
  const writes: string[] = [];
  let closed = false;
  const res: any = {
    writes,
    get closed() {
      return closed;
    },
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
    end() {
      closed = true;
    },
  };
  return res;
}

function clear() {
  shutdownEventStream();
}

test("addEventSubscriber: registers a connection", () => {
  clear();
  const res = makeFakeRes();
  const ok = addEventSubscriber(res);
  assert.ok(ok);
  assert.equal(getEventStreamSubscriberCount(), 1);
  clear();
});

test("addEventSubscriber: multiple connections are tracked", () => {
  clear();
  const r1 = makeFakeRes();
  const r2 = makeFakeRes();
  addEventSubscriber(r1);
  addEventSubscriber(r2);
  assert.equal(getEventStreamSubscriberCount(), 2);
  clear();
});

test("addEventSubscriber: enforces max connections", () => {
  clear();
  setMaxEventStreamConnections(2);
  const r1 = makeFakeRes();
  const r2 = makeFakeRes();
  const r3 = makeFakeRes();
  assert.ok(addEventSubscriber(r1));
  assert.ok(addEventSubscriber(r2));
  assert.ok(!addEventSubscriber(r3));
  assert.equal(getEventStreamSubscriberCount(), 2);
  assert.ok(r3.closed);
  setMaxEventStreamConnections(MAX_EVENT_STREAM_CONNECTIONS_DEFAULT);
  clear();
});

test("removeEventSubscriber: removes a connection", () => {
  clear();
  const r1 = makeFakeRes();
  const r2 = makeFakeRes();
  addEventSubscriber(r1);
  addEventSubscriber(r2);
  removeEventSubscriber(r1);
  assert.equal(getEventStreamSubscriberCount(), 1);
  clear();
});

test("removeEventSubscriber: no-op for unknown subscriber", () => {
  clear();
  const r1 = makeFakeRes();
  addEventSubscriber(r1);
  removeEventSubscriber(makeFakeRes());
  assert.equal(getEventStreamSubscriberCount(), 1);
  clear();
});

test("notifyEventSubscribers: pushes SSE-formatted frames to all subscribers", () => {
  clear();
  const r1 = makeFakeRes();
  const r2 = makeFakeRes();
  addEventSubscriber(r1);
  addEventSubscriber(r2);
  const count = notifyEventSubscribers("message_sent", { fleet_id: "f1", timestamp: 1000 });
  assert.equal(count, 2);
  assert.equal(r1.writes.length, 1);
  assert.equal(r2.writes.length, 1);
  clear();
});

test("notifyEventSubscribers: SSE frame has correct format", () => {
  clear();
  const r1 = makeFakeRes();
  addEventSubscriber(r1);
  notifyEventSubscribers("agent_spawned", { fleet_id: "f1", agent_id: "a1", timestamp: 42 });
  const frame = r1.writes[0];
  assert.match(frame, /^event: agent_spawned\n/);
  assert.match(frame, /\ndata: /);
  assert.match(frame, /\n\n$/);
  const dataLine = frame.split("\ndata: ")[1].split("\n")[0];
  const parsed = JSON.parse(dataLine);
  assert.equal(parsed.fleet_id, "f1");
  assert.equal(parsed.agent_id, "a1");
  assert.equal(parsed.timestamp, 42);
  clear();
});

test("notifyEventSubscribers: fleet_id filter — subscriber only gets matching events", () => {
  clear();
  const all = makeFakeRes();
  const filtered = makeFakeRes();
  const other = makeFakeRes();
  addEventSubscriber(all);
  addEventSubscriber(filtered, "fleet-A");
  addEventSubscriber(other, "fleet-B");

  notifyEventSubscribers("message_sent", { fleet_id: "fleet-A", timestamp: 1 });
  assert.equal(all.writes.length, 1, "unfiltered subscriber gets all events");
  assert.equal(filtered.writes.length, 1, "fleet-A subscriber gets fleet-A event");
  assert.equal(other.writes.length, 0, "fleet-B subscriber skips fleet-A event");

  notifyEventSubscribers("message_sent", { fleet_id: "fleet-B", timestamp: 2 });
  assert.equal(all.writes.length, 2);
  assert.equal(filtered.writes.length, 1);
  assert.equal(other.writes.length, 1);
  clear();
});

test("notifyEventSubscribers: events with no fleet_id go only to unfiltered subscribers", () => {
  clear();
  const all = makeFakeRes();
  const filtered = makeFakeRes();
  addEventSubscriber(all);
  addEventSubscriber(filtered, "fleet-A");
  notifyEventSubscribers("server_heartbeat", { timestamp: 99 });
  assert.equal(all.writes.length, 1);
  assert.equal(filtered.writes.length, 0);
  clear();
});

test("notifyEventSubscribers: removes subscriber when write fails", () => {
  clear();
  const bad = {
    writes: [],
    closed: false,
    write() {
      return false;
    },
    end() {
      this.closed = true;
    },
  };
  addEventSubscriber(bad as any);
  notifyEventSubscribers("msg", { timestamp: 1 });
  assert.equal(getEventStreamSubscriberCount(), 0);
  clear();
});

test("notifyEventSubscribers: returns 0 when no subscribers", () => {
  clear();
  assert.equal(notifyEventSubscribers("msg", { timestamp: 1 }), 0);
  clear();
});

test("getEventStreamSubscriberCount: fleet_id filter counts only matching subscribers", () => {
  clear();
  addEventSubscriber(makeFakeRes());
  addEventSubscriber(makeFakeRes(), "fleet-X");
  addEventSubscriber(makeFakeRes(), "fleet-Y");
  assert.equal(getEventStreamSubscriberCount(), 3);
  assert.equal(getEventStreamSubscriberCount("fleet-X"), 2);
  assert.equal(getEventStreamSubscriberCount("fleet-Y"), 2);
  assert.equal(getEventStreamSubscriberCount("fleet-Z"), 1);
  clear();
});

test("shutdownEventStream: closes all connections", () => {
  clear();
  const r1 = makeFakeRes();
  const r2 = makeFakeRes();
  addEventSubscriber(r1);
  addEventSubscriber(r2);
  shutdownEventStream();
  assert.ok(r1.closed);
  assert.ok(r2.closed);
  assert.equal(getEventStreamSubscriberCount(), 0);
});
