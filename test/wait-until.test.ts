import { test } from "node:test";
import assert from "node:assert/strict";
import { waitDeadline, waitUntil } from "./helpers/wait-until.js";

test("waitUntil permits an observable that becomes true after virtual 2.5 seconds", async () => {
  let now = 0;
  let pauses = 0;

  await waitUntil(
    () => now >= 2_500,
    "the delayed observable",
    {
      now: () => now,
      pause: async (delayMs) => {
        pauses += 1;
        now += delayMs;
      },
      pollIntervalMs: 500,
    },
  );

  assert.equal(now, 2_500);
  assert.equal(pauses, 5);
});

test("waitUntil returns immediately without pausing when the observable is already true", async () => {
  let pauses = 0;

  await waitUntil(
    () => true,
    "the immediate observable",
    { pause: async () => { pauses += 1; } },
  );

  assert.equal(pauses, 0);
});

test("waitUntil rejects at the absolute deadline with elapsed, polls, and observed state", async () => {
  let now = 100;

  await assert.rejects(
    waitUntil(
      () => false,
      "the never observable",
      {
        deadlineMs: waitDeadline(2_000, () => now),
        now: () => now,
        pause: async (delayMs) => { now += delayMs; },
        pollIntervalMs: 500,
        observed: () => "status=pending",
      },
    ),
    /timed out waiting for the never observable \(elapsed 2000ms, 4 polls\) \| observed: status=pending/,
  );
});
