/**
 * Budget enforcement — callable interface.
 *
 * Covers the four cases the task body explicitly calls out
 * (under_budget allow, at_budget downgrade, over_budget deny, unknown
 * profile fail-closed) plus a few edges an operator will hit on day one:
 * unmeasured provider posture, malformed inputs, and the receipt
 * envelope shape that lands on the MeshFleet event log.
 *
 * Event-log isolation: every test redirects the event log to a temp file
 * via `MESHFLEET_EVENT_LOG_FILE` so parallel test files do not interleave
 * receipts and so we can grep the file to verify the receipt was emitted.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getBudgetEnforcement,
  MODEL_COST_CATALOG_VERSION,
  type BudgetEnforcementReceipt,
  type BudgetEnforcementResult,
} from "../src/budget-enforcement.js";
import {
  setAgentProvider,
  setProviderBudget,
  resetBudgets,
} from "../src/budget-awareness.js";
import { readEventLog } from "../src/core.js";

let tempDir: string;
let eventLog: string;
let prevEnv: string | undefined;

function freshSetup(): void {
  // Reset module-level budget state. resetBudgets() is the canonical
  // teardown for budget-awareness; the enforcement layer holds no state
  // of its own beyond the frozen catalog.
  resetBudgets();
}

function lastReceipts(count: number): BudgetEnforcementReceipt[] {
  const rows = readEventLog(10_000);
  const out: BudgetEnforcementReceipt[] = [];
  for (let i = rows.length - 1; i >= 0 && out.length < count; i--) {
    const r = rows[i] as Record<string, unknown>;
    if (r.event === "budget_enforcement_decided") {
      out.push(r as unknown as BudgetEnforcementReceipt);
    }
  }
  return out.reverse();
}

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), "meshfleet-budget-enforce-"));
  eventLog = join(tempDir, "events.log");
  prevEnv = process.env.MESHFLEET_EVENT_LOG_FILE;
  process.env.MESHFLEET_EVENT_LOG_FILE = eventLog;
});

after(() => {
  if (prevEnv === undefined) delete process.env.MESHFLEET_EVENT_LOG_FILE;
  else process.env.MESHFLEET_EVENT_LOG_FILE = prevEnv;
  if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

// ── 1. Under budget → allow, reason=under_budget ──────────────────────

test("enforcement: under budget allows the requested model", () => {
  freshSetup();
  setProviderBudget({ provider: "grok-build", measured: true, used: 10, total: 1000 });
  setAgentProvider("architect", "grok-build");

  const result = getBudgetEnforcement({
    profileId: "architect",
    requestedModel: "grok-4-fast",
  });

  assert.equal(result.allowed, true, "plenty of headroom must allow");
  assert.equal(result.downgradedModel, undefined, "no downgrade under budget");
  assert.equal(result.reason, "under_budget");
  assert.equal(result.receiptEnvelope.profile_id, "architect");
  assert.equal(result.receiptEnvelope.provider_id, "grok-build");
  assert.equal(result.receiptEnvelope.requested_model, "grok-4-fast");
  assert.equal(result.receiptEnvelope.allowed, true);
  assert.equal(result.receiptEnvelope.downgraded_model, null);
  assert.equal(result.receiptEnvelope.cost_micro_usd, 100);
  assert.ok(
    result.receiptEnvelope.pre_call_utilization! < 0.6,
    `pre-call util should be < HEALTHY (0.6), got ${result.receiptEnvelope.pre_call_utilization}`,
  );
  assert.ok(
    result.receiptEnvelope.post_call_utilization! < 0.6,
    "post-call util must stay under HEALTHY",
  );
  assert.equal(result.receiptEnvelope.catalog_version, MODEL_COST_CATALOG_VERSION);
});

// ── 2. At budget → downgrade to cheaper same-family model ─────────────

test("enforcement: at budget downgrades to the cheaper same-family model", () => {
  freshSetup();
  // used=60, total=100 → pre-call util=0.60 (right at HEALTHY).
  // grok-4-fast catalog cost=100, so post-call requested = 1.6 → overshoots.
  // Downgrade to grok-4-mini (cost=30): post = (60+30)/100 = 0.90 → fits.
  setProviderBudget({ provider: "grok-build", measured: true, used: 60, total: 100 });
  setAgentProvider("architect", "grok-build");

  const result = getBudgetEnforcement({
    profileId: "architect",
    requestedModel: "grok-4-fast",
  });

  assert.equal(result.allowed, true, "downgrade is still allowed");
  assert.equal(result.downgradedModel, "grok-4-mini");
  assert.equal(result.reason, "downgraded");
  assert.equal(result.receiptEnvelope.allowed, true);
  assert.equal(result.receiptEnvelope.downgraded_model, "grok-4-mini");
  assert.equal(
    result.receiptEnvelope.pre_call_utilization,
    0.6,
    "pre-call util pinned at HEALTHY boundary",
  );
  assert.equal(
    result.receiptEnvelope.post_call_utilization,
    0.9,
    "post-call util is what the downgraded model would project, not the requested one",
  );
});

test("enforcement: at budget with no viable downgrade denies over_budget", () => {
  freshSetup();
  // grok-4-mini has NO cheaper_alternatives. At used=78/100 with cost=30
  // the post-call util is 1.08 — overshoots AND no downgrade target, so
  // we deny. The natural reading of "next-cheapest viable" is "the
  // cheapest that still fits"; when nothing fits, we deny.
  setProviderBudget({ provider: "grok-build", measured: true, used: 78, total: 100 });
  setAgentProvider("architect", "grok-build");

  const result = getBudgetEnforcement({
    profileId: "architect",
    requestedModel: "grok-4-mini",
  });

  assert.equal(result.allowed, false);
  assert.equal(result.downgradedModel, undefined);
  assert.equal(result.reason, "over_budget");
  assert.ok(
    result.receiptEnvelope.post_call_utilization! >= 1.0,
    "post-call util must overshoot when even the cheapest model can't fit",
  );
});

test("enforcement: at-budget allow (no downgrade needed) returns at_budget", () => {
  freshSetup();
  // used=70, total=100 → pre-call util=0.70 (in taper zone).
  // grok-4-mini cost=30, so post-call = 1.0. The boundary is `< 1.0`
  // (strict) so this case is allowed... wait, 1.0 exactly is denied.
  // Use used=69 so post = (69+30)/100 = 0.99 → fits, returns at_budget
  // because pre-call util (0.69) is already past HEALTHY (0.60).
  setProviderBudget({ provider: "grok-build", measured: true, used: 69, total: 100 });
  setAgentProvider("architect", "grok-build");

  const result = getBudgetEnforcement({
    profileId: "architect",
    requestedModel: "grok-4-mini",
  });

  assert.equal(result.allowed, true);
  assert.equal(result.downgradedModel, undefined);
  assert.equal(result.reason, "at_budget", "pre-call util past HEALTHY tags at_budget");
  assert.equal(result.receiptEnvelope.pre_call_utilization, 0.69);
  assert.equal(result.receiptEnvelope.post_call_utilization, 0.99);
});

// ── 3. Over budget → deny with reason=over_budget ─────────────────────

test("enforcement: over budget denies when no downgrade target fits", () => {
  freshSetup();
  // codex-mini has NO cheaper_alternatives. used=950/1000 → pre-call 0.95.
  // codex-mini cost=80, so post = (950+80)/1000 = 1.03 → overshoots AND
  // no downgrade path. Deny with reason=over_budget.
  setProviderBudget({ provider: "openai-codex", measured: true, used: 950, total: 1000 });
  setAgentProvider("architect", "openai-codex");

  const result = getBudgetEnforcement({
    profileId: "architect",
    requestedModel: "codex-mini",
  });

  assert.equal(result.allowed, false, "no headroom must deny");
  assert.equal(result.downgradedModel, undefined);
  assert.equal(result.reason, "over_budget");
  assert.ok(
    result.receiptEnvelope.post_call_utilization! >= 1.0,
    `post-call util must be >= 1.0, got ${result.receiptEnvelope.post_call_utilization}`,
  );
  assert.equal(result.receiptEnvelope.allowed, false);
});

test("enforcement: over budget downgrades when a cheaper alternative fits", () => {
  freshSetup();
  // grok-4-fast at used=950/1000 would overshoot (post=1.05), but
  // grok-4-mini (cost=30) at post=0.98 fits. Algorithm should
  // downgrade and allow — this is the "next-cheapest viable" rule.
  setProviderBudget({ provider: "grok-build", measured: true, used: 950, total: 1000 });
  setAgentProvider("architect", "grok-build");

  const result = getBudgetEnforcement({
    profileId: "architect",
    requestedModel: "grok-4-fast",
  });

  assert.equal(result.allowed, true);
  assert.equal(result.downgradedModel, "grok-4-mini");
  assert.equal(result.reason, "downgraded");
  assert.ok(result.receiptEnvelope.post_call_utilization! < 1.0);
});

test("enforcement: over budget denies the cheapest model when nothing fits", () => {
  freshSetup();
  // Tiny budget where even the cheapest catalog model can't fit.
  setProviderBudget({ provider: "openai-codex", measured: true, used: 99, total: 100 });
  setAgentProvider("architect", "openai-codex");

  const result = getBudgetEnforcement({
    profileId: "architect",
    requestedModel: "codex-mini",
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "over_budget");
});

// ── 4. Unknown profile → fail-closed deny ─────────────────────────────

test("enforcement: unknown profile fails closed with reason=unknown_profile", () => {
  freshSetup();
  // No setAgentProvider('ghost', ...) — the lane's spend is invisible.

  const result = getBudgetEnforcement({
    profileId: "ghost",
    requestedModel: "grok-4-fast",
  });

  assert.equal(result.allowed, false, "an unbound profile must fail closed");
  assert.equal(result.reason, "unknown_profile");
  assert.equal(result.downgradedModel, undefined);
  assert.equal(result.receiptEnvelope.provider_id, null);
  assert.equal(result.receiptEnvelope.allowed, false);
});

// ── 5. Receipt envelope is emitted to the MeshFleet observability lane ─

test("enforcement: every call emits exactly one budget_enforcement_decided receipt", () => {
  freshSetup();
  setProviderBudget({ provider: "grok-build", measured: true, used: 10, total: 1000 });
  setAgentProvider("architect", "grok-build");

  // Snapshot receipts before and after.
  const before = lastReceipts(1000).length;
  const result = getBudgetEnforcement({
    profileId: "architect",
    requestedModel: "grok-4-fast",
  });
  const after = lastReceipts(1000).length;

  assert.equal(after - before, 1, "exactly one receipt per call");
  assert.ok(existsSync(eventLog), "the event log file must exist");
  const logContents = readFileSync(eventLog, "utf-8");
  assert.match(
    logContents,
    /"event":"budget_enforcement_decided"/,
    "the event log must contain a budget_enforcement_decided row",
  );
  assert.ok(
    logContents.includes(result.receiptEnvelope.decision_id),
    "the receipt's decision_id must appear in the event log",
  );
  assert.ok(
    logContents.includes(result.receiptEnvelope.event_id),
    "the receipt's event_id must appear in the event log",
  );
});

// ── 6. Unmeasured provider posture (NEUTRAL — no quota API) ──────────

test("enforcement: unmeasured provider allows with reason=no_budget_data", () => {
  freshSetup();
  setProviderBudget({ provider: "codex", measured: false });
  setAgentProvider("lead", "codex");

  const result = getBudgetEnforcement({
    profileId: "lead",
    requestedModel: "codex-mini",
  });

  assert.equal(result.allowed, true);
  assert.equal(result.downgradedModel, undefined);
  assert.equal(result.reason, "no_budget_data");
  assert.equal(result.receiptEnvelope.pre_call_utilization, null);
  assert.equal(result.receiptEnvelope.post_call_utilization, null);
});

test("enforcement: measured provider without a total allows with reason=no_budget_data", () => {
  freshSetup();
  setProviderBudget({ provider: "ollama-cloud", measured: true, used: 12, source: "api/usage" });
  setAgentProvider("ops", "ollama-cloud");

  const result = getBudgetEnforcement({
    profileId: "ops",
    requestedModel: "codex-mini",
  });

  assert.equal(result.allowed, true);
  assert.equal(result.reason, "no_budget_data");
});

// ── 7. Input validation ──────────────────────────────────────────────

test("enforcement: rejects empty profileId / requestedModel", () => {
  freshSetup();
  assert.throws(
    () => getBudgetEnforcement({ profileId: "", requestedModel: "grok-4-fast" }),
    /profileId must be a non-empty string/,
  );
  assert.throws(
    () => getBudgetEnforcement({ profileId: "x", requestedModel: "" }),
    /requestedModel must be a non-empty string/,
  );
});

test("enforcement: rejects non-finite / negative cost estimates", () => {
  freshSetup();
  setProviderBudget({ provider: "grok-build", measured: true, used: 10, total: 1000 });
  setAgentProvider("architect", "grok-build");

  assert.throws(
    () =>
      getBudgetEnforcement({
        profileId: "architect",
        requestedModel: "grok-4-fast",
        estimatedCost: -1,
      }),
    /non-negative finite number/,
  );
  assert.throws(
    () =>
      getBudgetEnforcement({
        profileId: "architect",
        requestedModel: "grok-4-fast",
        estimatedCost: Number.POSITIVE_INFINITY,
      }),
    /non-negative finite number/,
  );
  assert.throws(
    () =>
      getBudgetEnforcement({
        profileId: "architect",
        requestedModel: "grok-4-fast",
        fallbackCost: Number.NaN,
      }),
    /non-negative finite number/,
  );
});

// ── 8. Unknown model → allow with reason=unknown_model so the gap is visible ─

test("enforcement: unknown model allows with reason=unknown_model when no estimate supplied", () => {
  freshSetup();
  setProviderBudget({ provider: "grok-build", measured: true, used: 10, total: 1000 });
  setAgentProvider("architect", "grok-build");

  const result = getBudgetEnforcement({
    profileId: "architect",
    requestedModel: "future-model-9000",
  });

  assert.equal(result.allowed, true);
  assert.equal(result.reason, "unknown_model");
  assert.equal(result.receiptEnvelope.cost_micro_usd, 0);
});

test("enforcement: caller-supplied estimatedCost overrides the catalog", () => {
  freshSetup();
  // used=999, total=1000, estimatedCost=5_000. Post = 5.999 → way
  // over. Downgrade to grok-4-mini: altPost = (999+30)/1000 = 1.029
  // → still overshoots. So deny with over_budget.
  setProviderBudget({ provider: "grok-build", measured: true, used: 999, total: 1000 });
  setAgentProvider("architect", "grok-build");

  const result = getBudgetEnforcement({
    profileId: "architect",
    requestedModel: "grok-4-fast",
    estimatedCost: 5_000,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "over_budget");
  assert.equal(result.receiptEnvelope.cost_micro_usd, 5_000);
});

test("enforcement: caller-supplied estimatedCost lands inside budget when it fits", () => {
  freshSetup();
  // estimatedCost=5 with used=10/1000 → post=0.015. Fits, no downgrade.
  setProviderBudget({ provider: "grok-build", measured: true, used: 10, total: 1000 });
  setAgentProvider("architect", "grok-build");

  const result = getBudgetEnforcement({
    profileId: "architect",
    requestedModel: "unknown-model",
    estimatedCost: 5,
  });

  assert.equal(result.allowed, true);
  assert.equal(result.downgradedModel, undefined);
  assert.equal(result.reason, "under_budget");
  assert.equal(result.receiptEnvelope.cost_micro_usd, 5);
});

// ── 9. budget-adjustment field is propagated into the receipt ────────

test("enforcement: receipt carries the budget-adjustment multiplier the smart-router should fold in", () => {
  freshSetup();
  // 80% util → taper zone (between HEALTHY 0.6 and DEMOTE 0.8 exclusive
  // boundary, but our test pins it exactly at 0.8 which puts us at the
  // FLOOR of the taper window).
  setProviderBudget({ provider: "grok-build", measured: true, used: 80, total: 100 });
  setAgentProvider("architect", "grok-build");

  const result = getBudgetEnforcement({
    profileId: "architect",
    requestedModel: "grok-4-mini",
    estimatedCost: 1,
  });

  // pre-call util = 0.80, post-call = 0.81 → >= DEMOTE, but grok-4-mini
  // has no cheaper alternatives so we allow with reason=at_budget.
  assert.equal(result.allowed, true);
  assert.equal(result.reason, "at_budget");
  assert.ok(
    typeof result.receiptEnvelope.budget_adjustment === "number",
    "budget_adjustment must be a number",
  );
  assert.ok(
    result.receiptEnvelope.budget_adjustment >= 0 &&
      result.receiptEnvelope.budget_adjustment <= 1,
    "budget_adjustment must be in [0, 1.0] (penalty-only)",
  );
});

// ── 10. Idempotency — the function never mutates the budget ledger ────

test("enforcement: getBudgetEnforcement never mutates the budget ledger", () => {
  freshSetup();
  setProviderBudget({ provider: "grok-build", measured: true, used: 10, total: 1000 });
  setAgentProvider("architect", "grok-build");

  const snapshotBefore = readFileSync(eventLog, "utf-8").length;
  getBudgetEnforcement({ profileId: "architect", requestedModel: "grok-4-fast" });
  getBudgetEnforcement({ profileId: "ghost", requestedModel: "grok-4-fast" });
  getBudgetEnforcement({ profileId: "architect", requestedModel: "grok-4-mini", estimatedCost: 9_990 });

  // Sanity: only the event log grew (3 receipt rows), the budget ledger
  // bytes are unchanged because we never call setProviderBudget or
  // setAgentProvider.
  const snapshotAfter = readFileSync(eventLog, "utf-8").length;
  assert.ok(
    snapshotAfter > snapshotBefore,
    "the event log must grow (3 receipts emitted)",
  );

  // The budget is still 10 / 1000 — the third call would have denied but
  // it must NOT have bumped "used".
  const r: BudgetEnforcementResult = getBudgetEnforcement({
    profileId: "architect",
    requestedModel: "grok-4-fast",
  });
  assert.equal(
    r.receiptEnvelope.pre_call_utilization,
    0.01,
    "utilization must remain at 10/1000 — enforcement is read-only",
  );
});
