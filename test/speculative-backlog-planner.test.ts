import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  planSpeculativeBacklog,
  SPECULATIVE_BACKLOG_PLANNER_VERSION,
} from "../src/speculative-backlog-planner.js";

const NOW_MS = 1_800_000_000_000;
const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const textOf = (response: unknown): string =>
  (response as { content: Array<{ text: string }> }).content[0]!.text;

async function withServer(fn: (client: Client, dataDir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-speculative-backlog-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(repoRoot, "src", "index.ts")],
    env: {
      ...(process.env as Record<string, string>),
      MESHFLEET_DB_FILE: join(dir, "ledger.db"),
      MESHFLEET_DATA_FILE: join(dir, "ledger.json"),
      MESHFLEET_EVENT_LOG_FILE: join(dir, "events.jsonl"),
      MESHFLEET_RATIFY_SWEEP_MS: "0",
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "speculative-backlog-contract-test", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    await fn(client, dir);
  } finally {
    await client.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

function candidate(candidate_id: string, overrides: Record<string, unknown> = {}) {
  return {
    candidate_id,
    capabilities: ["code"],
    privacy: "network_ok",
    locality: "any",
    budget: { measured: false },
    quality_tags: ["reviewed"],
    ...overrides,
  };
}

function task(task_id: string, overrides: Record<string, unknown> = {}) {
  return {
    task_id,
    kind: "code_review",
    priority: 50,
    speculative_approval: { state: "approved", approval_ref: "john-approval-1" },
    route: {
      required_capabilities: ["code"],
      privacy: "network_ok",
      locality: "any",
    },
    required_quality_tags: ["reviewed"],
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    version: SPECULATIVE_BACKLOG_PLANNER_VERSION,
    candidates: [candidate("candidate-a")],
    tasks: [task("task-a")],
    ...overrides,
  };
}

test("projects only approved tasks with declared quality eligibility and all effects false", () => {
  const source = input();
  const result = planSpeculativeBacklog(source);

  assert.equal(result.planner_version, SPECULATIVE_BACKLOG_PLANNER_VERSION);
  assert.equal(result.projection, true);
  assert.match(result.supplied_input_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.capacity, { mode: "unmodeled", status: "unknown" });
  assert.deepEqual(result.effects, {
    persisted: false,
    executed: false,
    authorized: false,
    woke_agents: false,
    contacted_providers: false,
    polled: false,
    read_credentials: false,
    inferred_provider: false,
    allocated_pool: false,
    reserved_capacity: false,
    scheduled: false,
    spent_budget: false,
    sent: false,
    published: false,
    used_external_identity: false,
  });
  assert.deepEqual(result.proposed.map(({ task_id, queue_index, candidate_ids, reason_codes }) => ({ task_id, queue_index, candidate_ids, reason_codes })), [
    { task_id: "task-a", queue_index: 0, candidate_ids: ["candidate-a"], reason_codes: ["CAPACITY_UNMODELED"] },
  ]);
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(source, input(), "planner must not mutate its input");
});

test("unapproved tasks are hard-blocked and no candidates are proposed", () => {
  const result = planSpeculativeBacklog(input({
    tasks: [task("task-a", { speculative_approval: { state: "not_approved" } })],
  }));

  assert.deepEqual(result.proposed, []);
  assert.deepEqual(result.blocked, [{
    task_id: "task-a",
    queue_index: 0,
    reason_codes: ["SPECULATIVE_APPROVAL_REQUIRED"],
    candidate_exclusions: [],
  }]);
});

test("rejects closed-key, bounds, duplicate, and approval-union violations", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["unknown input field", input({ execute: true }), /execute/],
    ["bad version", input({ version: "v1" }), /version/],
    ["candidate limit", input({ candidate_limit: 9 }), /candidate_limit/],
    ["duplicate candidates", input({ candidates: [candidate("same"), candidate("same")] }), /duplicate candidate_id/],
    ["duplicate tasks", input({ tasks: [task("same"), task("same")] }), /duplicate task_id/],
    ["approval smuggling", input({ tasks: [task("a", { speculative_approval: { state: "not_approved", approval_ref: "no" } })] }), /approval_ref/],
    ["free-form task id", input({ tasks: [task("task one")] }), /task_id/],
    ["free-form approval ref", input({ tasks: [task("a", { speculative_approval: { state: "approved", approval_ref: "approval ref" } })] }), /approval_ref/],
    ["candidate smuggling", input({ candidates: [candidate("a", { provider_id: "no" })] }), /provider_id/],
  ];
  for (const [name, value, expected] of cases) {
    assert.throws(() => planSpeculativeBacklog(value as never), expected, name);
  }
});

test("preserves all recommend_route hard gates and separately gates declared quality", () => {
  const result = planSpeculativeBacklog(input({
    candidates: [
      candidate("quality-mismatch", { quality_tags: [] }),
      candidate("privacy-mismatch", { privacy: "unrestricted" }),
      candidate("exhausted", { budget: { measured: true, used: 100, total: 100 } }),
    ],
  }));
  assert.deepEqual(result.proposed, []);
  assert.deepEqual(result.blocked, [{
    task_id: "task-a",
    queue_index: 0,
    reason_codes: ["NO_ELIGIBLE_CANDIDATES"],
    candidate_exclusions: [
      { candidate_id: "exhausted", reason_codes: ["BUDGET_EXHAUSTED"] },
      { candidate_id: "privacy-mismatch", reason_codes: ["PRIVACY_MISMATCH"] },
      { candidate_id: "quality-mismatch", reason_codes: ["QUALITY_TAG_MISMATCH"] },
    ],
  }]);
});

test("every landed route hard gate remains authoritative before projection", () => {
  const constrainedTask = task("task-a", {
    route: {
      required_capabilities: ["code"],
      privacy: "local_only",
      locality: "same_host",
      coordination: "pair_discussion",
      policy_tags: ["no_train"],
      min_context_tokens: 8_000,
    },
  });
  const result = planSpeculativeBacklog(input({
    tasks: [constrainedTask],
    candidates: [
      candidate("privacy", { privacy: "network_ok", locality: "same_host", coordination_modes: ["pair_discussion"], policy_tags: ["no_train"], context_window: 8_000 }),
      candidate("locality", { privacy: "local_only", locality: "any", coordination_modes: ["pair_discussion"], policy_tags: ["no_train"], context_window: 8_000 }),
      candidate("policy", { privacy: "local_only", locality: "same_host", coordination_modes: ["pair_discussion"], policy_tags: [], context_window: 8_000 }),
      candidate("capability", { capabilities: ["review"], privacy: "local_only", locality: "same_host", coordination_modes: ["pair_discussion"], policy_tags: ["no_train"], context_window: 8_000 }),
      candidate("coordination", { privacy: "local_only", locality: "same_host", coordination_modes: ["solo"], policy_tags: ["no_train"], context_window: 8_000 }),
      candidate("context", { privacy: "local_only", locality: "same_host", coordination_modes: ["pair_discussion"], policy_tags: ["no_train"], context_window: 7_999 }),
    ],
  }));
  assert.deepEqual(result.proposed, []);
  assert.deepEqual(result.blocked[0]?.candidate_exclusions, [
    { candidate_id: "capability", reason_codes: ["CAPABILITY_MISSING"] },
    { candidate_id: "context", reason_codes: ["CONTEXT_INSUFFICIENT"] },
    { candidate_id: "coordination", reason_codes: ["COORDINATION_MISMATCH"] },
    { candidate_id: "locality", reason_codes: ["LOCALITY_MISMATCH"] },
    { candidate_id: "policy", reason_codes: ["POLICY_MISMATCH"] },
    { candidate_id: "privacy", reason_codes: ["PRIVACY_MISMATCH"] },
  ]);
});

test("asset and video candidates require the exact private-review artifact policy", () => {
  for (const kind of ["reusable_asset", "video_candidate"]) {
    assert.throws(
      () => planSpeculativeBacklog(input({ tasks: [task("asset", { kind })] }) as never),
      /artifact/,
    );
    const result = planSpeculativeBacklog(input({
      tasks: [task("asset", {
        kind,
        artifact: {
          source_material: "caller_attested_rights",
          review_scope: "private_review_only",
          human_release_required: true,
        },
      })],
    }) as never);
    assert.equal(result.proposed.length, 1);
  }
  assert.throws(
    () => planSpeculativeBacklog(input({ tasks: [task("asset", {
      kind: "reusable_asset",
      artifact: { source_material: "text_only", review_scope: "private_review_only", human_release_required: true, prompt: "smuggled" },
    })] }) as never),
    /prompt/,
  );
});

test("canonical task and candidate permutations yield byte-equal output and replay hash", () => {
  const common = {
    candidates: [candidate("candidate-z"), candidate("candidate-a")],
    tasks: [task("task-z", { priority: 1 }), task("task-a", { priority: 99 })],
    candidate_limit: 2,
  };
  const first = planSpeculativeBacklog(input(common));
  const second = planSpeculativeBacklog(input({
    ...common,
    candidates: [...common.candidates].reverse(),
    tasks: [...common.tasks].reverse(),
  }));
  assert.equal(JSON.stringify(second), JSON.stringify(first));
  assert.deepEqual(first.proposed.map(({ task_id }) => task_id), ["task-a", "task-z"]);
});

test("near-reset is only a per-task recommend_route tie-break and unknown evidence stays neutral", () => {
  const candidates = [
    candidate("a-far", { budget: { measured: true, used: 10, total: 100, window: { starts_at_ms: NOW_MS - 1, ends_at_ms: NOW_MS + 604_800_000 } } }),
    candidate("z-near", { budget: { measured: true, used: 10, total: 100, window: { starts_at_ms: NOW_MS - 1, ends_at_ms: NOW_MS } } }),
  ];
  const defaultResult = planSpeculativeBacklog(input({ candidates, candidate_limit: 2 }));
  const preferredResult = planSpeculativeBacklog(input({ candidates, candidate_limit: 2, preference: { objective: "prefer_near_reset", now_ms: NOW_MS } }));
  assert.deepEqual(defaultResult.proposed[0]!.candidate_ids, ["a-far", "z-near"]);
  assert.deepEqual(preferredResult.proposed[0]!.candidate_ids, ["z-near", "a-far"]);
  assert.equal("preference" in defaultResult, false);
  assert.deepEqual(preferredResult.preference, { objective: "prefer_near_reset", now_ms: NOW_MS, evidence_only: true });
  const neutral = planSpeculativeBacklog(input({
    candidates: [
      candidate("a-unmeasured", { budget: { measured: false } }),
      candidate("z-stale", { budget: { measured: true, used: 10, total: 100, window: { starts_at_ms: NOW_MS - 4, ends_at_ms: NOW_MS - 1 } } }),
    ],
    candidate_limit: 2,
    preference: { objective: "prefer_near_reset", now_ms: NOW_MS },
  }));
  assert.deepEqual(neutral.proposed[0]!.candidate_ids, ["a-unmeasured", "z-stale"]);
});

test("a shared candidate remains independently proposed without capacity accounting", () => {
  const result = planSpeculativeBacklog(input({ tasks: [task("task-a"), task("task-b")] }));
  assert.deepEqual(result.proposed.map(({ task_id, queue_index, candidate_ids }) => ({ task_id, queue_index, candidate_ids })), [
    { task_id: "task-a", queue_index: 0, candidate_ids: ["candidate-a"] },
    { task_id: "task-b", queue_index: 1, candidate_ids: ["candidate-a"] },
  ]);
});

test("effects are isolated across results", () => {
  const first = planSpeculativeBacklog(input());
  (first.effects as { persisted: boolean }).persisted = true;
  const second = planSpeculativeBacklog(input());
  assert.equal(second.effects.persisted, false);
});

test("MCP exposes the closed projection and does not mutate its ledger", async () => {
  await withServer(async (client, dataDir) => {
    const { tools } = await client.listTools();
    const tool = tools.find((entry) => entry.name === "plan_speculative_backlog");
    assert.ok(tool, "missing MCP tool: plan_speculative_backlog");
    assert.match(tool.description ?? "", /does not persist, execute, authorize/i);
    assert.deepEqual(tool.inputSchema.required, ["version", "candidates", "tasks"]);
    const properties = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
    assert.equal(properties.version?.const, SPECULATIVE_BACKLOG_PLANNER_VERSION);
    assert.equal(properties.candidate_limit?.minimum, 1);
    assert.equal(properties.candidate_limit?.maximum, 8);
    assert.equal(properties.candidates?.maxItems, 256);
    assert.equal(properties.tasks?.maxItems, 64);

    const snapshot = (): Array<[string, string]> => readdirSync(dataDir).sort().map((name) => [name, readFileSync(join(dataDir, name)).toString("base64")]);
    const before = snapshot();
    const response = await client.callTool({ name: "plan_speculative_backlog", arguments: input() });
    assert.equal((response as { isError?: boolean }).isError, undefined);
    const body = JSON.parse(textOf(response));
    assert.deepEqual(body.effects, {
      persisted: false, executed: false, authorized: false, woke_agents: false, contacted_providers: false,
      polled: false, read_credentials: false, inferred_provider: false, allocated_pool: false,
      reserved_capacity: false, scheduled: false, spent_budget: false, sent: false, published: false,
      used_external_identity: false,
    });
    assert.deepEqual(snapshot(), before);

    const rejected = await client.callTool({ name: "plan_speculative_backlog", arguments: input({ provider_id: "smuggled" }) });
    assert.equal((rejected as { isError?: boolean }).isError, true);
    assert.match(textOf(rejected), /provider_id/);
  });
});
