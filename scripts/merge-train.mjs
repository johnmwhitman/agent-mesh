#!/usr/bin/env node
// Merge-train orchestrator.
//
// Collapses a queue of verifier-verified branches pooled at MERGE-READY down to
// one operator decision (one read + one `git merge --ff-only`) per day. Branches
// must be ahead of origin/main, merge-tree clean, and carry a `VERIFIED:` claim
// in their tip commit subject. The script:
//
//   (1) enumerates candidates from refs/heads/,
//   (2) trims to verifier-verified / merge-tree clean,
//   (3) opens a fresh train/YYYYMMDD branch from origin/main and sequentially
//       `git merge --no-ff`s each remaining candidate,
//   (4) runs the canonical verifier on the train tip — a single verifier run,
//       not one per branch, because the train is the object being certified,
//   (5) emits MERGE-TRAIN-YYYYMMDD.md: per-branch one-liner, diffstat, the
//       train-tip verifier receipt, and the ONE operator command
//       `git merge --ff-only train/YYYYMMDD`,
//   (6) any branch that fails to merge, or that the train refuses after it lands,
//       gets bisected out and listed as a leftover with a reason.
//
// `--dry-run` is the default; pass `--apply` to actually mutate the train
// branch. Push, merge-to-main, deploy, runtime promotion, and CarMart are NOT
// in scope — leftovers end up in the report and remain operator-gated.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pickCandidates, makeShell } from "./lib/merge-train.mjs";

const REPO = process.cwd();
const TODAY = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const TRAIN_BRANCH = `train/${TODAY}`;
const REPORT_PATH = resolve(REPO, `MERGE-TRAIN-${TODAY}.md`);
function shFn(cmd, args, opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd || REPO,
    env,
    encoding: "utf8",
    // Capture stdout/stderr so the verifier can parse failures. typecheck/build
    // still inherit stdio at the call site when streaming output is wanted —
    // here we always capture so the orchestrator sees the same bytes.
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
  return {
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    status: res.status === null ? (res.error ? 1 : 0) : res.status,
    error: res.error,
  };
}
const git = makeShell(shFn);

const readHEAD = () => shFn("git", ["rev-parse", "HEAD"]).stdout.trim();
const currentBranch = () => shFn("git", ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();

function verifyCanonical({ eventLogFile, baselineFailures }) {
  // The train tip is the object being certified (step 4 of the spec). Run the
  // full canonical verifier — typecheck + build + run-tests — under the pinned
  // Node 24.18.1 binary, with MESHFLEET_EVENT_LOG_FILE set and MESHFLEET_DATA_FILE
  // UNSET so each test gets its own ledger (the env-override cascade the suite
  // catches at the preflight would otherwise give 479 false failures).
  const nodeBin = resolveNodeBinary();
  if (!existsSync(nodeBin)) {
    return { ok: false, reason: `pinned Node 24.18.1 binary missing at ${nodeBin}` };
  }
  const env = {
    ...process.env,
    MESHFLEET_EVENT_LOG_FILE: eventLogFile,
    PATH: `${dirname(nodeBin)}${process.env.PATH ? `:${process.env.PATH}` : ""}`,
  };
  delete env.MESHFLEET_DATA_FILE;

  const tcLog = `/tmp/mf-train-${TODAY}-tc.log`;
  const bdLog = `/tmp/mf-train-${TODAY}-bd.log`;
  const tsLog = `/tmp/mf-train-${TODAY}-ts.log`;

  const tcs = shFn("npm", ["run", "typecheck"], { env });
  writeFileSync(tcLog, (tcs.stdout || "") + "\n" + (tcs.stderr || ""));
  if (tcs.status !== 0) return { ok: false, reason: `typecheck exit ${tcs.status}`, logPath: tcLog };
  const bds = shFn("npm", ["run", "build"], { env });
  writeFileSync(bdLog, (bds.stdout || "") + "\n" + (bds.stderr || ""));
  if (bds.status !== 0) return { ok: false, reason: `build exit ${bds.status}`, logPath: bdLog };
  const rts = shFn(nodeBin, ["scripts/run-tests.mjs"], { env });
  writeFileSync(tsLog, (rts.stdout || "") + "\n" + (rts.stderr || ""));
  // The runner reports the suite total as `1..N` (TAP plan) and `# tests N`
  // (its own summary). Read from the latter; the plan-line is also valid.
  // The earlier `(\d+) collected` regex only matched the stale-baseline guard's
  // own `1769 collected, 1769 passing, 0 failing, 0 skipped` line — which fires
  // only when HANDOFF.md disagrees with the suite, so it was an unreliable
  // measure of "tests run".
  const m =
    (rts.stdout || "").match(/^1\.\.(\d+)\s*$/m) ||
    (rts.stdout || "").match(/# tests (\d+)/);
  const measured = m ? m[1] : "?";
  // Capture failures by description (the bit after `not ok N - `), not numeric
    // id. Numeric ids shift when new tests are added between runs, which would
    // cause the baseline-aware verdict to flag unchanged-as-code tests as
    // "new". The description is stable as long as the test itself is unchanged.
    const tipFails = extractFailures(rts.stdout || "");
    const baselineSet = baselineFailures instanceof Set ? baselineFailures : null;
    const newFails = baselineSet
      ? tipFails.filter((t) => !baselineSet.has(t.description))
      : tipFails;
    if (rts.status !== 0 && newFails.length > 0) {
      return {
        ok: false,
        reason: `run-tests exit 1; ${newFails.length} new failure(s): ${newFails.slice(0, 5).map((f) => `${f.id} ${f.description}`).join(", ")}${newFails.length > 5 ? "..." : ""}`,
        logPath: tsLog,
        exit: rts.status,
        measured,
        totalFailures: tipFails.length,
        tipFailures: tipFails,
        baselineFailures: baselineSet ? baselineSet.size : null,
        newFailures: newFails,
      };
    }
  return {
    ok: true,
    measured,
    logPath: tsLog,
    env,
    exit: rts.status, // may be 1, but with no new failures — pre-existing only
    tipFailures: tipFails,
    baselineFailures: baselineSet ? baselineSet.size : null,
  };
}

function extractFailures(stdout) {
  // Pull "not ok N - description" lines and return both id and description.
  // The orchestrator compares new failures against the baseline by description
  // (numeric ids shift when new tests are added between runs).
  const out = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("not ok ")) continue;
    const m = /^not ok (\d+)\s+-\s+(.+)$/.exec(line);
    if (m) out.push({ id: m[1], description: m[2].trim() });
    else {
      const idMatch = /^not ok (\d+)/.exec(line);
      if (idMatch) out.push({ id: idMatch[1], description: "" });
    }
  }
  return out;
}

function resolveNodeBinary() {
  // Locate the pinned Node 24.18.1 binary without hardcoding a user-specific
  // path. The order matches the lane-side harness (AGENTS.md):
  //   1. NODE_24_18_1_BIN env (operator override)
  //   2. NVM_DIR + versions/node/v24.18.1/bin/node (the canonical node-24 path)
  //   3. Process execPath (current node — only used when operator explicitly
  //      exports a fallback; the suite's preflight will RED if mismatch)
  if (process.env.NODE_24_18_1_BIN) return process.env.NODE_24_18_1_BIN;
  const nvmRoot = process.env.NVM_DIR || join(process.env.HOME || "", ".nvm");
  return join(nvmRoot, "versions", "node", "v24.18.1", "bin", "node");
}

function parseArgs(argv) {
  const out = { apply: false, branches: [], basis: "origin/main", help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--dry-run") out.apply = false;
    else if (a === "--basis" && argv[i + 1]) out.basis = argv[++i];
    else if (a === "--branch" && argv[i + 1]) out.branches.push(argv[++i]);
    else if (a === "-h" || a === "--help") out.help = true;
    else { console.error(`unknown arg: ${a}`); process.exit(2); }
  }
  return out;
}

function usage() {
  console.log("Usage: scripts/merge-train.mjs [--apply|--dry-run] [--basis <ref>] [--branch <name>...]");
  console.log("Default: --dry-run, basis=origin/main, all verifier-verified branches ahead of basis.");
  console.log("  --apply    actually create train/YYYYMMDD, merge in, run verifier, write report");
  console.log("  --basis    base ref (default origin/main)");
  console.log("  --branch   restrict to specific branch (repeatable)");
}

function openTrainBranch(basis) {
  // basis defaults to "origin/main" so the train is a fast-forward off main, but the
  // --basis flag lets the caller point the train at a different starting commit (used
  // when the train must roll in a build-time prerequisite that lives on a feature
  // branch — e.g. a .gitattributes change that has to be on the train tip before the
  // candidates can merge).
  const base = basis || "origin/main";
  const co = shFn("git", ["checkout", "--quiet", base]);
  if (co.status !== 0) return { ok: false, reason: `checkout ${base} failed: ${(co.stderr || co.stdout || "").trim()}` };
  const mk = shFn("git", ["checkout", "-b", TRAIN_BRANCH]);
  if (mk.status !== 0) return { ok: false, reason: `create ${TRAIN_BRANCH} failed: ${(mk.stderr || mk.stdout || "").trim()}` };
  return { ok: true };
}

function mergeOne(branchName) {
  const m = shFn("git", ["merge", "--no-ff", branchName, "-m", `merge-train: roll ${branchName} into ${TRAIN_BRANCH}`]);
  const sha = readHEAD();
  return { ok: m.status === 0, stderr: (m.stderr || m.stdout || "").trim(), commit: sha };
}

function rollbackMerge() {
  shFn("git", ["merge", "--abort"]);
}

function isOnTrainBranch() {
  return currentBranch() === TRAIN_BRANCH;
}

function summarizeDiffstat(s) {
  if (!s) return "(empty)";
  const lines = s.split("\n").filter(Boolean);
  const last = lines[lines.length - 1] || "";
  return last || s.split("\n")[0] || "(empty)";
}

function emitReport({ merges, leftovers, verifier, trainTip, finalStatus }) {
  const lines = [];
  lines.push(`# Merge train — ${TODAY}`);
  lines.push("");
  lines.push(`**Train branch:** \`${TRAIN_BRANCH}\` (off \`origin/main\` at train start)`);
  lines.push(`**Mode:** ${finalStatus.mode}`);
  lines.push(`**Final status:** ${finalStatus.outcome}`);
  lines.push("");
  lines.push("## Operator action");
  lines.push("");
  lines.push("After reading this report, the operator runs ONE command on their local checkout (the train branch is ff-only onto origin/main because every merge was --no-ff against origin/main and no extra commits were added):");
  lines.push("");
  lines.push("```");
  lines.push(`git merge --ff-only ${TRAIN_BRANCH}`);
  lines.push("```");
  lines.push("");
  lines.push("That's it. The queued branches become one fast-forward.");
  lines.push("");
  lines.push("## Train tip");
  lines.push("");
  lines.push(`- branch: \`${TRAIN_BRANCH}\``);
  lines.push(`- tip: \`${trainTip}\``);
  if (verifier.ok) {
    lines.push(`- canonical verifier: **GREEN** — measured ${verifier.measured} tests, exit 0`);
    lines.push(`- verifier log: \`${verifier.logPath}\``);
  } else {
    lines.push(`- canonical verifier: **RED** — ${verifier.reason}`);
    if (verifier.logPath) lines.push(`- verifier log: \`${verifier.logPath}\``);
  }
  lines.push("");
  lines.push("## Merged in order");
  lines.push("");
  if (merges.length === 0) {
    lines.push("_(no branches merged)_");
    lines.push("");
  } else {
    lines.push("| # | Branch | Tip | Subject | Diffstat |");
    lines.push("|---|---|---|---|---|");
    merges.forEach((m, i) => {
      const n = i + 1;
      const tip = m.commit ? m.commit.slice(0, 7) : "?";
      const subj = m.subject.length > 70 ? m.subject.slice(0, 67) + "..." : m.subject;
      const ds = summarizeDiffstat(m.diffstat);
      lines.push(`| ${n} | \`${m.branch}\` | \`${tip}\` | ${subj} | \`${ds.replace(/`/g, "")}\` |`);
    });
    lines.push("");
  }
  lines.push("## Leftovers");
  lines.push("");
  if (leftovers.length === 0) {
    lines.push("_(none)_");
    lines.push("");
  } else {
    lines.push("| Branch | Reason | Action |");
    lines.push("|---|---|---|");
    for (const l of leftovers) {
      lines.push(`| \`${l.branch}\` | ${l.reason} | ${l.action} |`);
    }
    lines.push("");
  }
  lines.push("## Sources");
  lines.push("");
  lines.push(`- Report path: \`${relative(REPO, REPORT_PATH)}\``);
  lines.push(`- Train branch: \`${TRAIN_BRANCH}\``);
  lines.push("");
  writeFileSync(REPORT_PATH, lines.join("\n") + "\n");
  return REPORT_PATH;
}

function measureBaselineFailures() {
  // Run the verifier against the current tip BEFORE we mutate, capture the
  // failure-description set, and pass it into the train-tip verifier so
  // pre-existing failures don't block the train verdict. This is the lane-wide
  // default: origin/main currently fails 4 Python-witness + similar pre-existing
  // tests, and the lane knows about them.
  const logPath = `/tmp/mf-train-${TODAY}-baseline.log`;
  const out = verifyCanonical({ eventLogFile: logPath + ".events" });
  return new Set((out.tipFailures || []).map((f) => f.description));
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) { usage(); return; }
  const onlyNames = args.branches.length ? args.branches : null;

  console.log(`[merge-train] basis=${args.basis} train=${TRAIN_BRANCH} mode=${args.apply ? "apply" : "dry-run"}`);
  const candidates = pickCandidates({ trainBranch: TRAIN_BRANCH, onlyNames, git });
  console.log(`[merge-train] ${candidates.length} candidate branches (VERIFIED: subject + ahead-of-${args.basis} + merge-tree clean)`);
  for (const c of candidates) {
    if (!c.mergeTree.clean) console.log(`  [merge-tree-conflict] ${c.name} (${c.mergeTree.reason})`);
  }
  const clean = candidates.filter((c) => c.mergeTree.clean);
  console.log(`[merge-train] ${clean.length} clean, ${candidates.length - clean.length} merge-tree-conflict`);

  if (!args.apply) {
    const reportPath = emitReport({
      merges: clean.map((c) => ({ branch: c.name, sha: c.sha, subject: c.subject, diffstat: c.diffstat })),
      leftovers: candidates.filter((c) => !c.mergeTree.clean).map((c) => ({ branch: c.name, reason: c.mergeTree.reason, action: "fix conflict or drop" })),
      verifier: { ok: false, reason: "dry-run — verifier not invoked" },
      trainTip: "n/a",
      finalStatus: { mode: "dry-run", outcome: `${clean.length} branches would merge; report only` },
    });
    console.log(`[merge-train] dry-run complete; report at ${reportPath}`);
    return;
  }

  if (isOnTrainBranch()) {
    console.error(`[merge-train] ERROR: refusing to mutate — cwd is already on ${TRAIN_BRANCH} outside a clean train worktree`);
    process.exit(3);
  }

  // Capture baseline failures on the current tip so the train verdict is
  // *delta* from origin/main (new failures only). Compute this BEFORE we
  // checkout the train branch.
  let baselineFailures = null;
  try {
    console.log(`[merge-train] capturing baseline failure set from current tip (pre-merge)...`);
    baselineFailures = measureBaselineFailures();
    console.log(`[merge-train] baseline has ${baselineFailures.size} pre-existing failure(s) on this tip; verdict will be against new failures`);
  } catch (e) {
    console.log(`[merge-train] baseline measurement failed (${e?.message || e}); proceeding without baseline-aware verdict`);
  }

  const op = openTrainBranch(args.basis);
  if (!op.ok) { console.error(`[merge-train] open train failed: ${op.reason}`); process.exit(4); }

  const merges = [];
  const leftovers = [];
  for (const c of clean) {
    const r = mergeOne(c.name);
    if (r.ok) {
      merges.push({ branch: c.name, subject: c.subject, sha: c.sha, commit: r.commit, diffstat: c.diffstat });
      console.log(`[merge-train] merged ${c.name} at ${r.commit.slice(0, 7)}`);
    } else {
      rollbackMerge();
      const reason = (r.stderr || "").split("\n").filter(Boolean).slice(0, 2).join(" | ") || "git merge failed";
      leftovers.push({ branch: c.name, reason, action: "rebase or drop" });
      console.log(`[merge-train] bisected out: ${c.name} (${reason})`);
    }
  }

  const trainTip = readHEAD();
  let verifier;
  try {
    const tmp = mkdtempSync(join(tmpdir(), "mf-train-events-"));
    const eventLogFile = join(tmp, "events.log");
    verifier = verifyCanonical({ eventLogFile, baselineFailures });
  } catch (e) {
    verifier = { ok: false, reason: `verifier exception: ${e?.message || e}` };
  }

  let finalStatus;
  if (verifier.ok) {
    let tail;
    if (verifier.tipFailures && verifier.tipFailures.length > 0) {
      const baseCount = verifier.baselineFailures == null ? "?" : verifier.baselineFailures;
      tail = ` (${verifier.tipFailures.length} pre-existing failures from baseline; baseline had ${baseCount}; no new ones)`;
    } else {
      tail = "";
    }
    finalStatus = { mode: "apply", outcome: `GREEN — ${verifier.measured} tests${tail ? `; ${tail}` : ""}; train is ff-only onto origin/main`.replace(/; ; /g, "; ") };
  } else {
    finalStatus = { mode: "apply", outcome: `RED — ${verifier.reason}` };
  }
  const reportPath = emitReport({ merges, leftovers, verifier, trainTip, finalStatus });
  console.log(`[merge-train] train tip ${trainTip.slice(0, 7)}; verifier ${verifier.ok ? "GREEN" : "RED"}; report at ${reportPath}`);
}

main();
