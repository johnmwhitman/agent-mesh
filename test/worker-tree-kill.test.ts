/**
 * Tree-kill semantics for recorded processes — acceptance gate #3 of
 * `t_db8af59c` (2026-08-26).
 *
 * The negative-pid group kill (`process.kill(-pgid)`) handles a child that
 * stayed in the parent's process group. It does NOT handle a child that
 * called `setsid(2)` and detached, which is a long-lived tool wrapper's
 * natural defence against its parent's premature death. Without the second
 * pass, the wrapper survives the timeout reap and keeps holding its SQLite
 * lease.
 *
 * These tests exercise the pure walker (no real children) and the contained
 * function with a mock kill so the second-pass behavior is observable
 * without depending on a particular platform's `ps` output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  containRecordedProcess,
  walkAndKillDescendants,
} from "../src/runtime/process.js";

test("walkAndKillDescendants recurses through grandchildren, sending SIGTERM at each level", () => {
  // Synthetic process tree:
  //   100 (root)
  //   ├── 101
  //   │   ├── 103
  //   │   └── 104
  //   └── 102
  const tree: Record<number, number[]> = {
    100: [101, 102],
    101: [103, 104],
    102: [],
    103: [],
    104: [],
  };
  const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const result = walkAndKillDescendants(
    100,
    { platform: "linux", listDescendants: (pid) => tree[pid] ?? [] },
    (pid, signal) => {
      killed.push({ pid, signal });
    },
    "SIGTERM",
  );
  assert.equal(result, 4, "all four descendants receive SIGTERM");
  const killedSet = new Set(killed.map((k) => k.pid));
  assert.deepEqual(killedSet, new Set([101, 102, 103, 104]));
  for (const call of killed) {
    assert.equal(call.signal, "SIGTERM");
  }
});

test("walkAndKillDescendants returns 0 for a leaf node", () => {
  const tree: Record<number, number[]> = { 200: [] };
  const killed: number[] = [];
  const result = walkAndKillDescendants(
    200,
    { platform: "linux", listDescendants: (pid) => tree[pid] ?? [] },
    (pid) => {
      killed.push(pid);
    },
  );
  assert.equal(result, 0);
  assert.deepEqual(killed, []);
});

test("walkAndKillDescendants is a no-op on Windows (no process-group semantics there)", () => {
  const killed: number[] = [];
  // Even with descendants, Windows short-circuits — the platform path is the
  // primary signal, not the walker.
  const result = walkAndKillDescendants(300, { platform: "win32" }, (pid) => {
    killed.push(pid);
  });
  assert.equal(result, 0);
  assert.deepEqual(killed, []);
});

test("walkAndKillDescendants refuses non-positive pids", () => {
  const killed: number[] = [];
  assert.equal(
    walkAndKillDescendants(0, { platform: "linux" }, (pid) => killed.push(pid)),
    0,
  );
  assert.equal(
    walkAndKillDescendants(-1, { platform: "linux" }, (pid) => killed.push(pid)),
    0,
  );
  assert.deepEqual(killed, []);
});

test("walkAndKillDescendants survives a kill failure on a single descendant and continues", () => {
  // 400 -> [401, 402]. 401 throws on kill, 402 succeeds. The walker must
  // not bail out after the throw; it must keep going and reap 402.
  const tree: Record<number, number[]> = { 400: [401, 402], 401: [], 402: [] };
  const killed: number[] = [];
  const result = walkAndKillDescendants(
    400,
    { platform: "linux", listDescendants: (pid) => tree[pid] ?? [] },
    (pid) => {
      if (pid === 401) throw new Error("EPERM");
      killed.push(pid);
    },
  );
  assert.equal(result, 1, "the surviving child is still counted");
  assert.deepEqual(killed, [402]);
});

test("containRecordedProcess calls the leader's negative-pid kill AND walks descendants", () => {
  // Tree: 500 -> [501, 502]. Watch every signal sent so we can prove both
  // the group kill AND the descendant walk ran on the first call.
  const tree: Record<number, number[]> = { 500: [501, 502], 501: [], 502: [] };
  const signals: Array<{ target: number; signal: NodeJS.Signals }> = [];
  const kill = (target: number, signal: NodeJS.Signals): void => {
    signals.push({ target, signal });
  };
  let scheduledCount = 0;
  const schedule = (_cb: () => void, _delayMs: number): unknown => {
    scheduledCount += 1;
    return undefined;
  };
  const accepted = containRecordedProcess(500, {
    kill,
    schedule,
    graceMs: 10,
    platform: "linux",
    listDescendants: (pid) => tree[pid] ?? [],
  });
  assert.equal(accepted, true);
  // First three signals: leader's negative-pid kill (process group), then
  // each descendant's SIGTERM. Order is deterministic because the walker
  // iterates in tree order.
  assert.equal(signals.length, 3);
  assert.deepEqual(signals[0], { target: -500, signal: "SIGTERM" }, "leader's process group receives SIGTERM first");
  // The walker hits 501 first (it's listed first in the tree); 501 has no
  // children, then 502. Order matters for the kill-call sequence but the
  // set of targets is what we assert here.
  const descendantTargets = new Set(signals.slice(1).map((s) => s.target));
  assert.deepEqual(descendantTargets, new Set([501, 502]));
  for (const s of signals.slice(1)) {
    assert.equal(s.signal, "SIGTERM");
  }
  assert.equal(scheduledCount, 1, "exactly one grace timer armed");
});
