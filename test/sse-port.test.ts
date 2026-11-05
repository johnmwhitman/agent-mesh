import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ssePort,
  subscribeEventsUrl,
  subscribeInboxUrl,
} from "../src/sse-server.js";

const cases: Array<{ name: string; value?: string; expected: number }> = [
  { name: "unset", expected: 13579 },
  { name: "empty", value: "", expected: 13579 },
  { name: "port 1", value: "1", expected: 1 },
  { name: "ordinary port", value: "8080", expected: 8080 },
  { name: "port 65535", value: "65535", expected: 65535 },
  { name: "zero", value: "0", expected: 13579 },
  { name: "negative", value: "-1", expected: 13579 },
  { name: "fractional", value: "13579.5", expected: 13579 },
  { name: "overflow", value: "65536", expected: 13579 },
  { name: "NaN", value: "not-a-number", expected: 13579 },
  { name: "Infinity", value: "Infinity", expected: 13579 },
  // Preserve Number() compatibility for already accepted numeric spellings.
  { name: "surrounding whitespace", value: " 8080 ", expected: 8080 },
  { name: "hexadecimal spelling", value: "0x1f90", expected: 8080 },
  { name: "exponential spelling", value: "1e3", expected: 1000 },
];

test("SSE port selection and subscription URLs use a valid TCP port", () => {
  for (const entry of cases) {
    const hadValue = Object.hasOwn(process.env, "MESHFLEET_SSE_PORT");
    const previousValue = process.env.MESHFLEET_SSE_PORT;
    try {
      if (entry.value === undefined) delete process.env.MESHFLEET_SSE_PORT;
      else process.env.MESHFLEET_SSE_PORT = entry.value;

      assert.equal(ssePort(), entry.expected, `${entry.name}: selected port`);
      assert.equal(
        subscribeInboxUrl("agent-1"),
        `http://127.0.0.1:${entry.expected}/inbox/agent-1/stream`,
        `${entry.name}: inbox URL`,
      );
      assert.equal(
        subscribeEventsUrl("fleet 1"),
        `http://127.0.0.1:${entry.expected}/events/stream?fleet_id=fleet%201`,
        `${entry.name}: events URL`,
      );
    } finally {
      if (hadValue) process.env.MESHFLEET_SSE_PORT = previousValue!;
      else delete process.env.MESHFLEET_SSE_PORT;
    }
  }
});
