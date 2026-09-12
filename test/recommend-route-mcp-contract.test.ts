/**
 * recommend_route MCP contract — driven over real MCP stdio with
 * the tool's PUBLISHED field names.
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `recommend_route` is the advisory ranking
 * surface over caller-supplied sanitized task traits and candidate snapshots
 * (src/index.ts advertised schema at L1115-L1359 + handler at
 * toolHandlers["recommend_route"] L2151-L2224 on origin/main 8433dcb8).
 * It is published. test/recommend-route-mcp.test.ts already pins a schema
 * subset, opt-in reset urgency, and corpus cases. 2026-09-09 / 2026-09-11
 * worktrees (c29af3da / 73c4ce95) existed for a 7-test stdio pin but never
 * landed: they used import.meta-relative repoRoot (fragile under
 * tsconfig.test.json outDir) and bumped HANDOFF.md published figures.
 * This card is a fresh origin/main pin with the 2026-09-12 honesty pattern:
 *
 *   1. advertised schema pin — required [task, candidates],
 *      additionalProperties:false (this tool HONESTLY advertises closed
 *      input; handler firstUnexpected + recommendRoute requireAllowedKeys
 *      are the real gates), annotations {readOnlyHint:true,
 *      idempotentHint:true, destructiveHint:false, openWorldHint:false}
 *      plus description phrases Advisory-only ranking / Does not persist,
 *      execute, authorize, wake agents, or contact providers. Nested
 *      objects (task, candidates.items, preference, budget,
 *      observed_outcomes, requested_identity, observed_identity) closed.
 *   2. required-field honesty — absent task / candidates is isError
 *      naming the field and NEVER a phantom advisory:true; SDK does NOT
 *      enforce required
 *   3. named coerce-into-rank bug class — 5 non-honest shapes (string
 *      task, number candidates, string top_n, string preference, nested
 *      execute on a candidate) all return isError naming the field and
 *      NEVER stringify into a legitimate-looking ranked envelope
 *   4. advertised-vs-handler honesty — additionalProperties:false IS
 *      handler-enforced via firstUnexpected allowlists (the opposite of
 *      attach_agent / subscribe_events / route_work). Phantom top-level
 *      keys force/retry/note/provider_id are jsonError naming the key as
 *      not allowed and NEVER leak into a success envelope. Preference
 *      phantoms skip the handler allowlist and are still refused by
 *      core requireAllowedKeys — advertising preference closed remains
 *      honest.
 *   5. happy-path envelope {advisory:true, effects five flags all false,
 *      ranked, excluded} with identity.evidence_only:true on every ranked
 *      row
 *   6. hard-gate vs evidence-only honesty — PRIVACY_MISMATCH excludes;
 *      identity claim_mismatch RANKS with status=claim_mismatch and
 *      evidence_only:true (identity never becomes a hard gate)
 *   7. source-string pin — handler firstUnexpected allowlists for
 *      top-level / task / candidates, try/catch jsonError wrap of
 *      recommendRoute(args as RecommendRouteInput), NO spawnFleet /
 *      wakeAgent / sendMessage / fetch, registered exactly once
 *
 * Each invariant is independently falsifiable. The SDK enforces neither
 * `required` nor `type`; toolHandlers is typed `(args: any)`.
 *
 * No published-figure bump. HANDOFF.md is not edited.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { closeDb } from "../src/db.js";

// process.cwd(), not import.meta-relative: tsconfig.test.json compiles into
// dist/, where node_modules/tsx does not exist and the stdio child dies
// with "Cannot find module .../dist/node_modules/tsx/dist/loader.mjs".
const repoRoot = process.cwd();

type ToolResponse = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
};

const textOf = (response: unknown): string =>
  (response as ToolResponse).content[0]!.text;
const bodyOf = (response: unknown): Record<string, unknown> =>
  JSON.parse(textOf(response)) as Record<string, unknown>;

type Fixture = {
  dir: string;
  dataFile: string;
  dbFile: string;
  eventsFile: string;
};

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-recommend-route-mcp-"));
  return {
    dir,
    dataFile: join(dir, "ledger.json"),
    dbFile: join(dir, "ledger.db"),
    eventsFile: join(dir, "events.jsonl"),
  };
}

function applyFixtureEnv(fix: Fixture): void {
  process.env.MESHFLEET_DB_FILE = fix.dbFile;
  process.env.MESHFLEET_DATA_FILE = fix.dataFile;
  process.env.MESHFLEET_EVENT_LOG_FILE = fix.eventsFile;
  process.env.HOME = fix.dir;
}

function clearFixtureEnv(): void {
  delete process.env.MESHFLEET_DB_FILE;
  delete process.env.MESHFLEET_DATA_FILE;
  delete process.env.MESHFLEET_EVENT_LOG_FILE;
  delete process.env.HOME;
}

const childEnv = (
  fix: Fixture,
  extra: Record<string, string> = {},
): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  MESHFLEET_DB_FILE: fix.dbFile,
  MESHFLEET_DATA_FILE: fix.dataFile,
  MESHFLEET_EVENT_LOG_FILE: fix.eventsFile,
  MESHFLEET_RATIFY_SWEEP_MS: "0",
  AGENT_MESH_CHILD: "1",
  HOME: fix.dir,
  ...extra,
});

async function connectChild(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(repoRoot, "src", "index.ts")],
    env,
    stderr: "ignore",
  });
  const client = new Client(
    { name: "recommend-route-contract-test", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

async function cleanupFix(fix: Fixture): Promise<void> {
  closeDb();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(fix.dir, { recursive: true, force: true });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt === 4) {
        rmSync(fix.dir, { recursive: true, force: true });
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  clearFixtureEnv();
}

/** Child-mode: recovery, sweeper, and SSE skipped. */
async function withChildServer(
  fix: Fixture,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  applyFixtureEnv(fix);
  const client = await connectChild(childEnv(fix));
  try {
    await fn(client);
  } finally {
    await client.close().catch(() => {});
    await cleanupFix(fix);
  }
}

const RECOMMEND_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const EFFECTS_FIVE_FALSE = {
  persisted: false,
  executed: false,
  authorized: false,
  woke_agents: false,
  contacted_providers: false,
} as const;

function minimalTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    required_capabilities: ["code"],
    privacy: "local_only",
    locality: "same_host",
    ...overrides,
  };
}

function minimalCandidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidate_id: "route-a",
    capabilities: ["code"],
    privacy: "local_only",
    locality: "same_host",
    ...overrides,
  };
}

function honestArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    task: minimalTask(),
    candidates: [minimalCandidate()],
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete base[key];
    } else {
      base[key] = value;
    }
  }
  return base;
}

function assertNoPhantomAdvisory(body: Record<string, unknown>, label: string): void {
  assert.notEqual(
    body.advisory,
    true,
    `${label}: MUST NOT carry a phantom advisory:true; got: ${JSON.stringify(body)}`,
  );
  assert.equal(
    "ranked" in body && Array.isArray(body.ranked) && (body.ranked as unknown[]).length > 0 && body.advisory === true,
    false,
    `${label}: MUST NOT carry a success-shaped ranked envelope; got: ${JSON.stringify(body)}`,
  );
}

// ---------------------------------------------------------------------------
// T1 — advertised schema pin
// ---------------------------------------------------------------------------

test("recommend_route advertises closed required task+candidates, additionalProperties:false, and read-only annotations", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "recommend_route");
    assert.ok(tool, "recommend_route must be advertised");
    assert.match(
      tool.description ?? "",
      /Advisory-only ranking over caller-supplied sanitized task traits/,
      "description must keep the Advisory-only ranking phrase",
    );
    assert.match(
      tool.description ?? "",
      /Does not persist, execute, authorize, wake agents, or contact providers/,
      "description must keep the six-verb Does-not list",
    );
    const schema = tool.inputSchema as {
      type: string;
      required?: string[];
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["task", "candidates"]);
    assert.equal(
      schema.additionalProperties,
      false,
      "recommend_route schema MUST advertise additionalProperties:false — handler firstUnexpected + core requireAllowedKeys are the real gates; advertising undefined would be a lie",
    );
    assert.deepEqual(tool.annotations, RECOMMEND_ANNOTATIONS);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(props).sort(), ["candidates", "preference", "task", "top_n"]);

    const task = props.task as {
      additionalProperties?: boolean;
      required?: string[];
      properties?: Record<string, Record<string, unknown>>;
    };
    assert.equal(task.additionalProperties, false);
    assert.deepEqual(task.required, ["required_capabilities", "privacy", "locality"]);
    assert.deepEqual(task.properties?.privacy.enum, ["local_only", "network_ok", "unrestricted"]);
    assert.deepEqual(task.properties?.locality.enum, ["same_host", "same_fleet", "any"]);
    assert.deepEqual(task.properties?.coordination.enum, ["solo", "pair_discussion"]);

    const candidates = props.candidates as {
      minItems?: number;
      maxItems?: number;
      items?: {
        additionalProperties?: boolean;
        required?: string[];
        properties?: Record<string, Record<string, unknown>>;
      };
    };
    assert.equal(candidates.minItems, 1);
    assert.equal(candidates.maxItems, 256);
    assert.equal(candidates.items?.additionalProperties, false);
    assert.deepEqual(candidates.items?.required, [
      "candidate_id",
      "capabilities",
      "privacy",
      "locality",
    ]);
    const candidateProps = candidates.items?.properties as Record<string, Record<string, unknown>>;
    assert.equal((candidateProps.budget as { additionalProperties?: boolean }).additionalProperties, false);
    assert.equal(
      (candidateProps.observed_outcomes as { additionalProperties?: boolean }).additionalProperties,
      false,
    );
    assert.deepEqual(
      (candidateProps.observed_outcomes as { required?: string[] }).required,
      ["successes", "failures"],
    );
    assert.ok(
      (candidateProps.requested_identity as { anyOf?: unknown }).anyOf,
      "requested_identity must advertise anyOf runtime-or-model",
    );
    assert.ok(
      (candidateProps.observed_identity as { anyOf?: unknown }).anyOf,
      "observed_identity must advertise anyOf runtime-or-model",
    );

    const preference = props.preference as {
      additionalProperties?: boolean;
      required?: string[];
      properties?: Record<string, Record<string, unknown>>;
    };
    assert.equal(preference.additionalProperties, false);
    assert.deepEqual(preference.required, ["objective", "now_ms"]);
    assert.deepEqual(preference.properties?.objective.enum, [
      "prefer_near_reset",
      "exhaust_before_reset",
    ]);

    const topN = props.top_n as { type?: string; minimum?: number; maximum?: number };
    assert.equal(topN.type, "integer");
    assert.equal(topN.minimum, 1);
    assert.equal(topN.maximum, 256);
  });
});

// ---------------------------------------------------------------------------
// T2 — required-field honesty (SDK does not enforce required)
// ---------------------------------------------------------------------------

test("recommend_route refuses absent task/candidates as isError naming the field, never a phantom advisory", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const cases: ReadonlyArray<{ label: string; args: Record<string, unknown>; field: string }> = [
      { label: "empty object", args: {}, field: "task" },
      { label: "missing task", args: honestArgs({ task: undefined }), field: "task" },
      { label: "candidates only", args: { candidates: [minimalCandidate()] }, field: "task" },
      { label: "missing candidates", args: honestArgs({ candidates: undefined }), field: "candidates" },
      { label: "task only", args: { task: minimalTask() }, field: "candidates" },
    ];
    for (const { label, args, field } of cases) {
      const response = await client.callTool({
        name: "recommend_route",
        arguments: args,
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `${label}: absent ${field} must be isError; got: ${textOf(response)}`,
      );
      const body = bodyOf(response);
      assert.match(
        String(body.error),
        new RegExp(field),
        `${label}: error must name ${field}; got: ${JSON.stringify(body)}`,
      );
      assert.doesNotMatch(
        String(body.error),
        /is required/i,
        `${label}: recommendRoute validate() names the field path, not an SDK 'is required' string; got: ${String(body.error)}`,
      );
      assertNoPhantomAdvisory(body, label);
    }
  });
});

// ---------------------------------------------------------------------------
// T3 — named wrong-typed-input bug class
// ---------------------------------------------------------------------------

test("recommend_route refuses 5 wrong-typed shapes before any ranking (named coerce-into-rank class)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const cases: ReadonlyArray<{ label: string; args: Record<string, unknown>; field: string }> = [
      { label: "string task", args: { task: "not-an-object", candidates: [minimalCandidate()] }, field: "task" },
      {
        label: "number candidates",
        args: honestArgs({ candidates: 3 as unknown as never }),
        field: "candidates",
      },
      {
        label: "string top_n",
        args: honestArgs({ top_n: "three" }),
        field: "top_n",
      },
      {
        label: "string preference",
        args: honestArgs({ preference: "prefer_near_reset" }),
        field: "preference",
      },
      {
        label: "nested execute on candidate",
        args: honestArgs({
          candidates: [minimalCandidate({ execute: true })],
        }),
        field: "execute",
      },
    ];
    for (const { label, args, field } of cases) {
      const response = await client.callTool({
        name: "recommend_route",
        arguments: args,
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `${label}: wrong-typed ${field} must be isError; got: ${textOf(response)}`,
      );
      const body = bodyOf(response);
      assert.match(
        String(body.error),
        new RegExp(field.replace(".", "\\.")),
        `${label}: error must name ${field}; got: ${JSON.stringify(body)}`,
      );
      assert.doesNotMatch(
        textOf(response),
        /advisory\":true/,
        `${label}: MUST NOT stringify a wrong-typed input into a legitimate-looking ranking; got: ${textOf(response)}`,
      );
      assertNoPhantomAdvisory(body, label);
    }
  });
});

// ---------------------------------------------------------------------------
// T4 — advertised additionalProperties:false IS handler-enforced
// ---------------------------------------------------------------------------

test("recommend_route refuses phantom keys (additionalProperties:false is handler-enforced via firstUnexpected + core allowlists)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const phantomCases: ReadonlyArray<{
      label: string;
      args: Record<string, unknown>;
      key: string;
      suffix: RegExp;
    }> = [
      {
        label: "force",
        args: { ...honestArgs(), force: true },
        key: "force",
        suffix: /is not allowed; supply sanitized traits only/,
      },
      {
        label: "retry",
        args: { ...honestArgs(), retry: 3 },
        key: "retry",
        suffix: /is not allowed; supply sanitized traits only/,
      },
      {
        label: "note",
        args: { ...honestArgs(), note: "for your eyes only" },
        key: "note",
        suffix: /is not allowed; supply sanitized traits only/,
      },
      {
        label: "provider_id",
        args: { ...honestArgs(), provider_id: "smuggled" },
        key: "provider_id",
        suffix: /is not allowed; supply sanitized traits only/,
      },
      {
        label: "task.spend",
        args: honestArgs({ task: minimalTask({ spend: true }) }),
        key: "task.spend",
        suffix: /is not allowed; supply sanitized traits only/,
      },
      {
        label: "candidates[0].wake",
        args: honestArgs({ candidates: [minimalCandidate({ wake: true })] }),
        key: "candidates\\[0\\]\\.wake",
        suffix: /is not allowed; recommendation never executes or wakes agents/,
      },
      {
        label: "preference.spend",
        args: honestArgs({
          preference: { objective: "prefer_near_reset", now_ms: 1, spend: true },
        }),
        key: "preference.spend",
        suffix: /is not allowed/,
      },
    ];
    for (const { label, args, key, suffix } of phantomCases) {
      const response = await client.callTool({
        name: "recommend_route",
        arguments: args,
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `phantom ${label}: MUST be refused; advertising additionalProperties:false would be a lie if the handler accepted it; got: ${textOf(response)}`,
      );
      const body = bodyOf(response);
      assert.match(
        String(body.error),
        new RegExp(key),
        `phantom ${label}: error must name the key; got: ${JSON.stringify(body)}`,
      );
      assert.match(
        String(body.error),
        suffix,
        `phantom ${label}: error must keep the closed-input refusal suffix; got: ${JSON.stringify(body)}`,
      );
      assertNoPhantomAdvisory(body, `phantom ${label}`);
      assert.doesNotMatch(
        textOf(response),
        /advisory\":true/,
        `phantom ${label}: MUST NOT leak into a success envelope; got: ${textOf(response)}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// T5 — happy-path envelope
// ---------------------------------------------------------------------------

test("recommend_route happy path returns the documented advisory envelope with every effects flag false", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "recommend_route",
      arguments: honestArgs({
        candidates: [
          minimalCandidate({ candidate_id: "route-z" }),
          minimalCandidate({ candidate_id: "route-a" }),
        ],
        top_n: 2,
      }),
    });
    assert.equal(
      (response as ToolResponse).isError,
      undefined,
      `valid call must not be isError; got: ${textOf(response)}`,
    );
    const body = bodyOf(response);
    assert.deepEqual(
      Object.keys(body).sort(),
      ["advisory", "effects", "excluded", "ranked"],
      "result top-level keys must be EXACTLY the documented four-key envelope when preference is omitted",
    );
    assert.equal(body.advisory, true);
    assert.deepEqual(body.effects, EFFECTS_FIVE_FALSE);
    const ranked = body.ranked as Array<Record<string, unknown>>;
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0]!.candidate_id, "route-a", "equal scores must sort by candidate_id");
    assert.equal(ranked[1]!.candidate_id, "route-z");
    assert.equal(ranked[0]!.rank, 1);
    assert.equal(ranked[1]!.rank, 2);
    for (const row of ranked) {
      const identity = row.identity as Record<string, unknown>;
      assert.equal(identity.evidence_only, true, "identity is evidence-only on every ranked row");
      assert.equal(identity.status, "not_requested");
      const budget = row.budget as Record<string, unknown>;
      assert.equal(budget.measured, false);
      assert.equal(budget.status, "unmeasured");
      const components = row.components as Record<string, unknown>;
      assert.equal(typeof components.final_score, "number");
      assert.equal("reset_urgency" in components, false, "reset_urgency is omitted when preference is absent");
    }
    assert.deepEqual(body.excluded, []);
    for (const leaked of ["force", "retry", "note", "provider_id", "task", "candidates", "preference"]) {
      assert.equal(
        leaked in body,
        false,
        `success envelope MUST NOT leak phantom key ${leaked}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// T6 — hard-gate vs evidence-only honesty
// ---------------------------------------------------------------------------

test("recommend_route excludes PRIVACY_MISMATCH but ranks identity claim_mismatch as evidence-only", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "recommend_route",
      arguments: honestArgs({
        task: minimalTask({ privacy: "local_only" }),
        candidates: [
          minimalCandidate({
            candidate_id: "too-public",
            privacy: "network_ok",
          }),
          minimalCandidate({
            candidate_id: "identity-mismatch",
            requested_identity: { runtime: "opencode-cli" },
            observed_identity: { runtime: "claude-cli", source: "probe" },
          }),
        ],
        top_n: 2,
      }),
    });
    assert.equal(
      (response as ToolResponse).isError,
      undefined,
      `privacy+identity mix must succeed; got: ${textOf(response)}`,
    );
    const body = bodyOf(response);
    assert.equal(body.advisory, true);
    assert.deepEqual(body.effects, EFFECTS_FIVE_FALSE);

    const excluded = body.excluded as Array<Record<string, unknown>>;
    assert.equal(excluded.length, 1);
    assert.equal(excluded[0]!.candidate_id, "too-public");
    assert.deepEqual(excluded[0]!.reason_codes, ["PRIVACY_MISMATCH"]);

    const ranked = body.ranked as Array<Record<string, unknown>>;
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0]!.candidate_id, "identity-mismatch");
    const identity = ranked[0]!.identity as Record<string, unknown>;
    assert.equal(identity.evidence_only, true);
    assert.equal(
      identity.status,
      "claim_mismatch",
      "identity mismatch is evidence, never a hard-gate exclusion",
    );
    assert.deepEqual(identity.requested, { runtime: "opencode-cli" });
    assert.deepEqual(identity.observed, { runtime: "claude-cli", source: "probe" });
    const rankedIds = ranked.map((row) => row.candidate_id);
    assert.equal(rankedIds.includes("too-public"), false, "privacy mismatch must not rank");
  });
});

// ---------------------------------------------------------------------------
// T7 — source-string pin
// ---------------------------------------------------------------------------

test("recommend_route handler source pins firstUnexpected allowlists, recommendRoute jsonError wrap, and closed advertised schema", () => {
  const source = readFileSync(join(repoRoot, "src", "index.ts"), "utf8");
  assert.match(
    source,
    /toolHandlers\["recommend_route"\]/,
    "recommend_route must be a top-level toolHandlers entry",
  );
  assert.ok(
    source.includes("Advisory-only ranking over caller-supplied sanitized task traits and candidate snapshots."),
    "recommend_route description must keep the Advisory-only ranking phrase",
  );
  assert.ok(
    source.includes("Does not persist, execute, authorize, wake agents, or contact providers."),
    "recommend_route description must keep the six-verb Does-not list",
  );

  const schemaMatch = source.match(
    /name: "recommend_route",[\s\S]*?inputSchema: \{([\s\S]*?)required: \["task", "candidates"\],/,
  );
  assert.ok(schemaMatch, "recommend_route inputSchema block must be found through required [task, candidates]");
  const schemaHead = schemaMatch[1]!;
  assert.match(
    schemaHead,
    /additionalProperties:\s*false/,
    "advertised schema MUST declare additionalProperties:false — this tool's firstUnexpected + requireAllowedKeys gates make the advertisement honest",
  );
  assert.match(
    schemaHead,
    /enum: \["prefer_near_reset", "exhaust_before_reset"\]/,
    "advertised schema must pin preference.objective enum prefer_near_reset | exhaust_before_reset",
  );

  const handlerMatch = source.match(
    /toolHandlers\["recommend_route"\] = async \(args\) => \{([\s\S]*?)\n\};\s*\n\s*toolHandlers\["ack_message"\]/,
  );
  assert.ok(
    handlerMatch,
    "recommend_route handler block must be found immediately before ack_message",
  );
  const handlerBody = handlerMatch[1]!;
  assert.match(
    handlerBody,
    /firstUnexpected/,
    "handler must scan unexpected keys before ranking",
  );
  assert.match(
    handlerBody,
    /new Set\(\["task", "candidates", "top_n", "preference"\]\)/,
    "handler top-level allowlist must be exactly task/candidates/top_n/preference",
  );
  assert.match(
    handlerBody,
    /supply sanitized traits only/,
    "handler top-level/task refusal must keep the sanitized-traits suffix",
  );
  assert.match(
    handlerBody,
    /recommendation never executes or wakes agents/,
    "handler candidate refusal must keep the never-executes-or-wakes suffix",
  );
  assert.match(
    handlerBody,
    /try \{/,
    "handler must wrap the ranking in try",
  );
  assert.match(
    handlerBody,
    /return jsonResult\(recommendRoute\(args as RecommendRouteInput\)\)/,
    "success path must jsonResult(recommendRoute(args as RecommendRouteInput))",
  );
  assert.match(
    handlerBody,
    /catch \(error\)/,
    "handler must catch recommendRoute validate() throws",
  );
  assert.match(
    handlerBody,
    /return jsonError\(error instanceof Error \? error\.message : String\(error\)\)/,
    "catch path must jsonError the Error.message (never a raw stack)",
  );
  assert.doesNotMatch(
    handlerBody,
    /spawnFleet\(/,
    "handler must NOT call spawnFleet — published advisory-only promise",
  );
  assert.doesNotMatch(
    handlerBody,
    /wakeAgent\(/,
    "handler must NOT call wakeAgent — published advisory-only promise",
  );
  assert.doesNotMatch(
    handlerBody,
    /sendMessage\(/,
    "handler must NOT call sendMessage — published advisory-only promise",
  );
  assert.doesNotMatch(
    handlerBody,
    /fetch\(/,
    "handler must NOT call fetch — published advisory-only promise",
  );
  assert.doesNotMatch(
    handlerBody,
    /requireAllowedKeys/,
    "handler must NOT call requireAllowedKeys — firstUnexpected + core requireAllowedKeys are the closed-input gates",
  );
  assert.doesNotMatch(
    handlerBody,
    /requireString/,
    "handler must NOT call requireString — recommendRoute validate() is the wire gate",
  );
  const occurrences = source.split('toolHandlers["recommend_route"]').length - 1;
  assert.equal(occurrences, 1, "recommend_route handler must be registered exactly once");

  const core = readFileSync(join(repoRoot, "src", "recommend-route.ts"), "utf8");
  assert.match(
    core,
    /advisory:\s*true/,
    "core projection must hard-code advisory:true",
  );
  assert.match(
    core,
    /persisted:\s*false/,
    "core effects.persisted must hard-code false",
  );
  assert.match(
    core,
    /executed:\s*false/,
    "core effects.executed must hard-code false",
  );
  assert.match(
    core,
    /authorized:\s*false/,
    "core effects.authorized must hard-code false",
  );
  assert.match(
    core,
    /woke_agents:\s*false/,
    "core effects.woke_agents must hard-code false",
  );
  assert.match(
    core,
    /contacted_providers:\s*false/,
    "core effects.contacted_providers must hard-code false",
  );
});
