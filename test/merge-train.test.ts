// Merge-train selector unit tests.
//
// These tests cover pickCandidates (in scripts/lib/merge-train.mjs) with a
// mock `git` interface, so they don't touch the real repo or spawn subprocesses.
// The full integration is exercised by the merge-train dry-run path and by the
// canonical verifier run on --apply.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { pickCandidates, makeShell } from "../scripts/lib/merge-train.mjs";

// Mock git factories return {stdout, stderr, status}; we hand-make a state
// machine shaped like real git output for a small repo.

interface BranchEntry {
  sha: string;
  subject: string;
  author: string;
  aheadCount: number;
  diffstat: string;
  files: string[];
  ancestorOf?: string[];
}

function buildMockGit(cfg: { origin: string; branches: Record<string, BranchEntry> }) {
  const tipShas: Record<string, string> = Object.fromEntries(
    Object.entries(cfg.branches).map(([n, b]) => [b.sha, n])
  );
  function sh(cmd: string, args: string[]): { stdout: string; stderr: string; status: number } {
    const argList = args.join(" ");
    if (argList === "rev-parse origin/main")
      return { stdout: cfg.origin + "\n", stderr: "", status: 0 };
    if (argList === "for-each-ref --format=%(refname:short) %(objectname) refs/heads") {
      const lines = Object.entries(cfg.branches).map(([n, b]) => `${n} ${b.sha}`).join("\n");
      return { stdout: lines + "\n", stderr: "", status: 0 };
    }
    const m1 = /^log -1 --format=%s ([0-9a-f]+)$/.exec(argList);
    if (m1) {
      const targetSha = m1[1];
      const tName = tipShas[targetSha];
      if (!tName) return { stdout: "unknown\n", stderr: "", status: 0 };
      return { stdout: cfg.branches[tName].subject + "\n", stderr: "", status: 0 };
    }
    const m2 = /^log -1 --format=%an <%ae> ([0-9a-f]+)$/.exec(argList);
    if (m2) {
      const targetSha = m2[1];
      const tName = tipShas[targetSha];
      if (!tName) return { stdout: "unknown\n", stderr: "", status: 0 };
      return { stdout: cfg.branches[tName].author + "\n", stderr: "", status: 0 };
    }
    const m3 = /^merge-base --is-ancestor origin\/main ([0-9a-f]+)$/.exec(argList);
    if (m3) {
      const targetSha = m3[1];
      const tName = tipShas[targetSha];
      if (!tName) return { stdout: "", stderr: "fatal", status: 1 };
      const tBranch = cfg.branches[tName];
      if (cfg.origin === targetSha) return { stdout: "", stderr: "", status: 0 };
      if (tBranch.ancestorOf?.includes(cfg.origin) || cfg.origin === targetSha)
        return { stdout: "", stderr: "", status: 0 };
      if (tBranch.aheadCount > 0) return { stdout: "", stderr: "", status: 0 };
      return { stdout: "", stderr: "", status: 1 };
    }
    const m4 = /^merge-base --is-ancestor ([0-9a-f]+) ([0-9a-f]+)$/.exec(argList);
    if (m4) {
      const a = m4[1], b = m4[2];
      if (a === b) return { stdout: "", stderr: "", status: 0 };
      const aName = tipShas[a];
      if (!aName) return { stdout: "", stderr: "", status: 1 };
      const aBranch = cfg.branches[aName];
      if (aBranch.ancestorOf?.includes(b)) return { stdout: "", stderr: "", status: 0 };
      return { stdout: "", stderr: "", status: 1 };
    }
    const m5 = /^rev-list --count origin\/main\.\.([0-9a-f]+)$/.exec(argList);
    if (m5) {
      const tName = tipShas[m5[1]];
      if (!tName) return { stdout: "0\n", stderr: "", status: 0 };
      return { stdout: `${cfg.branches[tName].aheadCount}\n`, stderr: "", status: 0 };
    }
    const m6 = /^merge-tree origin\/main ([0-9a-f]+)$/.exec(argList);
    if (m6) {
      const tName = tipShas[m6[1]];
      if (!tName) return { stdout: "<<<<<<<\n", stderr: "", status: 0 };
      const tb = cfg.branches[tName];
      if (tb.diffstat === undefined) return { stdout: "", stderr: "", status: 1 };
      if (tb.diffstat.includes("<<<<<<<"))
        return { stdout: "<<<<<<< foo\n=======\n>>>>>>> foo\n", stderr: "", status: 0 };
      return { stdout: "", stderr: "", status: 0 };
    }
    const m7 = /^diff --stat origin\/main ([0-9a-f]+)$/.exec(argList);
    if (m7) {
      const tName = tipShas[m7[1]];
      if (!tName) return { stdout: "\n", stderr: "", status: 0 };
      return { stdout: (cfg.branches[tName].diffstat ?? "") + "\n", stderr: "", status: 0 };
    }
    const m8 = /^diff --name-only origin\/main ([0-9a-f]+)$/.exec(argList);
    if (m8) {
      const tName = tipShas[m8[1]];
      if (!tName) return { stdout: "", stderr: "", status: 0 };
      return { stdout: (cfg.branches[tName].files ?? []).join("\n") + "\n", stderr: "", status: 0 };
    }
    return { stdout: "", stderr: "mock: unrecognized: " + cmd + " " + argList, status: 1 };
  }
  return makeShell(sh);
}

test("pickCandidates: empty branch list returns empty", () => {
  const git = buildMockGit({ origin: "abc0000", branches: {} });
  const out = pickCandidates({ trainBranch: "train/20260818", onlyNames: null, git });
  assert.deepEqual(out, []);
});

test("pickCandidates: branch at origin/main is filtered out", () => {
  const git = buildMockGit({
    origin: "abc0000",
    branches: {
      "feat/x": { sha: "abc0000", subject: "VERIFIED: x", author: "x@x", aheadCount: 0, diffstat: "", files: [] },
    },
  });
  const out = pickCandidates({ trainBranch: "train/20260818", onlyNames: null, git });
  assert.equal(out.length, 0);
});

test("pickCandidates: VERIFIED branch ahead of main is selected", () => {
  const git = buildMockGit({
    origin: "abc0000",
    branches: {
      "feat/x": { sha: "abc1111", subject: "VERIFIED: x does a thing", author: "x@x", aheadCount: 1, diffstat: " 1 file changed, 1 insertion(+)", files: ["x.ts"] },
    },
  });
  const out = pickCandidates({ trainBranch: "train/20260818", onlyNames: null, git });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "feat/x");
  assert.ok(out[0].mergeTree.clean);
});

test("pickCandidates: non-VERIFIED subject goes to leftover with reason", () => {
  const git = buildMockGit({
    origin: "abc0000",
    branches: {
      "feat/x": { sha: "abc1111", subject: "draft: not yet verified", author: "x@x", aheadCount: 1, diffstat: " 1 file changed", files: ["x.ts"] },
    },
  });
  const out = pickCandidates({ trainBranch: "train/20260818", onlyNames: null, git });
  assert.equal(out.length, 1);
  assert.ok(!out[0].mergeTree.clean);
  assert.ok(out[0].mergeTree.reason.includes("spec gate"));
});

test("pickCandidates: branch is strict ancestor of a verified superset → redundant", () => {
  const git = buildMockGit({
    origin: "abc0000",
    branches: {
      "feat/small": {
        sha: "abc1111", subject: "VERIFIED: small", author: "x@x", aheadCount: 1, diffstat: " 1 f", files: [],
        ancestorOf: ["abc2222"],
      },
      "feat/big": {
        sha: "abc2222", subject: "VERIFIED: big superset", author: "x@x", aheadCount: 2, diffstat: " 2 f", files: [],
      },
    },
  });
  const out = pickCandidates({ trainBranch: "train/20260818", onlyNames: null, git });
  assert.equal(out.length, 2);
  const small = out.find((c) => c.name === "feat/small");
  const big = out.find((c) => c.name === "feat/big");
  assert.ok(small && !small.mergeTree.clean, "small should be marked conflict (redundant)");
  assert.ok(small.mergeTree.reason.includes("strict ancestor"));
  assert.ok(big && big.mergeTree.clean, "big should be selected");
});

test("pickCandidates: branch is ancestor of an UNVERIFIED superset → not redundant", () => {
  const git = buildMockGit({
    origin: "abc0000",
    branches: {
      "feat/small": {
        sha: "abc1111", subject: "VERIFIED: small", author: "x@x", aheadCount: 1, diffstat: " 1 f", files: [],
        ancestorOf: ["abc2222"],
      },
      "feat/big-unverified": {
        sha: "abc2222", subject: "draft: maybe later", author: "x@x", aheadCount: 2, diffstat: " 2 f", files: [],
      },
    },
  });
  const out = pickCandidates({ trainBranch: "train/20260818", onlyNames: null, git });
  const small = out.find((c) => c.name === "feat/small");
  const big = out.find((c) => c.name === "feat/big-unverified");
  assert.ok(small && small.mergeTree.clean, "small stays (only unverified superset exists)");
  assert.ok(big && !big.mergeTree.clean && big.mergeTree.reason.includes("spec gate"));
});
