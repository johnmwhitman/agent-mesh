// land-one selector unit tests.
//
// These tests cover pickOldestVerified, oldestByDate, buildFixCardBody,
// buildLandCommand, and detectVerifierCommand from scripts/lib/land-one.mjs.
// They use the same mock git interface pattern as test/merge-train.test.ts
// so no real git or worktree is spawned.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { pickOldestVerified, oldestByDate, buildFixCardBody, buildLandCommand, detectVerifierCommand } from "../scripts/lib/land-one.mjs";
import { makeShell } from "../scripts/lib/merge-train.mjs";

// Reuse the mock git builder from merge-train tests (same shape).
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
    Object.entries(cfg.branches).map(([n, b]) => [b.sha, n]),
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
      const tName = tipShas[m1[1]];
      if (!tName) return { stdout: "unknown\n", stderr: "", status: 0 };
      return { stdout: cfg.branches[tName].subject + "\n", stderr: "", status: 0 };
    }
    const m2 = /^log -1 --format=%an <%ae> ([0-9a-f]+)$/.exec(argList);
    if (m2) {
      const tName = tipShas[m2[1]];
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
      const [a, b] = [m4[1], m4[2]];
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

test("pickOldestVerified: empty branch list returns null candidate", () => {
  const git = buildMockGit({ origin: "abc0000", branches: {} });
  const out = pickOldestVerified({ git, trainBranch: "land-one/20260819" });
  assert.equal(out.candidate, null);
  assert.equal(out.allCandidates.length, 0);
});

test("pickOldestVerified: single VERIFIED clean branch is picked", () => {
  const git = buildMockGit({
    origin: "abc0000",
    branches: {
      "feat/x": { sha: "abc1111", subject: "VERIFIED: x does a thing", author: "x@x", aheadCount: 1, diffstat: " 1 file changed, 1 insertion(+)", files: ["x.ts"] },
    },
  });
  const out = pickOldestVerified({ git, trainBranch: "land-one/20260819" });
  assert.ok(out.candidate, "should have a candidate");
  assert.equal(out.candidate!.name, "feat/x");
});

test("pickOldestVerified: picks smallest aheadCount when multiple clean branches exist", () => {
  const git = buildMockGit({
    origin: "abc0000",
    branches: {
      "feat/big": { sha: "abc2222", subject: "VERIFIED: big feature", author: "x@x", aheadCount: 5, diffstat: " 5 files", files: [] },
      "feat/small": { sha: "abc1111", subject: "VERIFIED: small fix", author: "x@x", aheadCount: 1, diffstat: " 1 file", files: ["a.ts"] },
    },
  });
  const out = pickOldestVerified({ git, trainBranch: "land-one/20260819" });
  assert.ok(out.candidate);
  assert.equal(out.candidate!.name, "feat/small", "smallest aheadCount should be picked first");
});

test("pickOldestVerified: non-VERIFIED branch returns null with reason", () => {
  const git = buildMockGit({
    origin: "abc0000",
    branches: {
      "feat/draft": { sha: "abc1111", subject: "draft: not yet verified", author: "x@x", aheadCount: 1, diffstat: " 1 file", files: ["x.ts"] },
    },
  });
  const out = pickOldestVerified({ git, trainBranch: "land-one/20260819" });
  assert.equal(out.candidate, null);
  assert.ok(out.reason!.includes("none clean") || out.reason!.includes("no VERIFIED"));
});

test("oldestByDate: sorts by ISO date ascending (oldest first)", () => {
  const candidates = [
    { name: "feat/newer", sha: "aaa1111", subject: "VERIFIED: newer", aheadCount: 1, kind: "verified" as const, mergeTree: { clean: true as const } },
    { name: "feat/older", sha: "bbb2222", subject: "VERIFIED: older", aheadCount: 1, kind: "verified" as const, mergeTree: { clean: true as const } },
  ];
  const tipDate = (sha: string) => {
    if (sha === "aaa1111") return "2026-08-19T12:00:00+00:00";
    if (sha === "bbb2222") return "2026-08-15T08:00:00+00:00";
    return "";
  };
  const oldest = oldestByDate(candidates, tipDate);
  assert.equal(oldest.name, "feat/older");
});

test("oldestByDate: unparseable date falls back to subject sort", () => {
  const candidates = [
    { name: "feat/z", sha: "aaa1111", subject: "VERIFIED: zzz", aheadCount: 1, kind: "verified" as const, mergeTree: { clean: true as const } },
    { name: "feat/a", sha: "bbb2222", subject: "VERIFIED: aaa", aheadCount: 1, kind: "verified" as const, mergeTree: { clean: true as const } },
  ];
  const tipDate = () => "unparseable";
  const oldest = oldestByDate(candidates, tipDate);
  assert.equal(oldest.name, "feat/a", "subject-alpha fallback when dates unparseable");
});

test("buildFixCardBody: includes branch name and reason", () => {
  const body = buildFixCardBody({
    branch: "feat/broken",
    sha: "abc1234567",
    repo: "/path/to/repo",
    reason: "run-tests RED: 3 failures",
    logPath: "/tmp/test.log",
  });
  assert.ok(body.includes("feat/broken"));
  assert.ok(body.includes("run-tests RED: 3 failures"));
  assert.ok(body.includes("/tmp/test.log"));
  assert.ok(body.includes("Fix card"));
});

test("buildLandCommand: produces ff-only merge command", () => {
  const cmd = buildLandCommand({ branch: "feat/green", repo: "/path/to/repo" });
  assert.ok(cmd.includes("git -C /path/to/repo"));
  assert.ok(cmd.includes("merge --ff-only"));
  assert.ok(cmd.includes("feat/green"));
});

test("detectVerifierCommand: all three scripts present", () => {
  const cmd = detectVerifierCommand({ repo: "/x", hasTypecheck: true, hasBuild: true, hasTest: true });
  assert.ok(cmd!.includes("npm run typecheck"));
  assert.ok(cmd!.includes("npm run build"));
  assert.ok(cmd!.includes("npm test"));
});

test("detectVerifierCommand: no scripts returns null", () => {
  const cmd = detectVerifierCommand({ repo: "/x", hasTypecheck: false, hasBuild: false, hasTest: false });
  assert.equal(cmd, null);
});

test("detectVerifierCommand: only test script", () => {
  const cmd = detectVerifierCommand({ repo: "/x", hasTypecheck: false, hasBuild: false, hasTest: true });
  assert.equal(cmd, "npm test");
});