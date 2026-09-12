/**
 * plan_speculative_backlog MCP contract — driven over real MCP stdio with
 * the tool's PUBLISHED field names.
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `plan_speculative_backlog` is the closed
 * caller-approved speculative-backlog projection (src/index.ts advertised
 * schema at L1362-L1435 + handler at
 * toolHandlers["plan_speculative_backlog"] L2143-L2149 on origin/main
 * 8433dcb8). It is published. test/speculative-backlog-planner.test.ts
 * already pins in-process planner semantics + one MCP smoke (description
 * substring, required array, ledger snapshot, provider_id smuggle). A
 * 2026-09-10 worktree (9002bbdd) existed for a 6-test stdio pin but never
 * landed: it used import.meta-relative repoRoot (fragile under
 * tsconfig.test.json outDir), mixed schema+annotations+description into
 * one test, used a hard 500-char slice of src/index.ts:2176-2182, and
 * bumped HANDOFF.md published figures. This card is a fresh origin/main
 * pin with the 2026-09-12 honesty pattern:
 *
 *   1. advertised schema pin — required [version, candidates, tasks],
 *      additionalProperties:false (this tool HONESTLY advertises closed
 *      input; the planner's allowedKeys is the real gate), annotations
 *      {readOnlyHint:true, idempotentHint:true, destructiveHint:false,
 *      openWorldHint:false} plus description phrases Pure /
 *      caller-approved / Does not persist, execute, authorize
 *   2. required-field honesty — absent version / candidates / tasks is
 *      isError naming the field; the SDK does NOT enforce `required`
 *   3. named stringified/wrong-typed-input bug class — 5 non-honest
 *      shapes (number version, string candidates, object tasks, string
 *      candidate_limit, string preference) all return isError and NEVER
 *      a phantom projection:true envelope. validate() must fire BEFORE
 *      recommendRoute / suppliedInputHash
 *   4. advertised-vs-handler honesty — additionalProperties:false IS
 *      handler-enforced via planner allowedKeys (the opposite of
 *      attach_agent / subscribe_events). Phantom top-level keys
 *      force/retry/note/provider_id are jsonError naming the key and
 *      NEVER leak into a success envelope
 *   5. happy-path envelope {planner_version, supplied_input_sha256,
 *      projection:true, proposed, blocked, capacity, effects} with every
 *      effects flag false and capacity unmodeled/unknown
 *   6. not_approved task is blocked with SPECULATIVE_APPROVAL_REQUIRED
 *      and never reaches proposed; quality-mismatch candidate is ranked
 *      out via QUALITY_TAG_MISMATCH
 *   7. source-string pin on the handler body (try/catch jsonError wrap
 *      of planSpeculativeBacklog, no side-effecting primitives)
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
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-plan-speculative-mcp-"));
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
    { name: "plan-speculative-backlog-contract-test", version: "1.0.0" },
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

const BASE_VERSION = "meshfleet.speculative-backlog.v0.1";

const PLAN_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const EFFECTS_ALL_FALSE = {
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
} as const;

function minimalCandidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidate_id: "candidate-alpha",
    capabilities: ["text-generation"],
    privacy: "unrestricted",
    locality: "any",
    quality_tags: ["reliable"],
    ...overrides,
  };
}

function minimalTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_id: "task-alpha",
    kind: "benchmark",
    priority: 50,
    speculative_approval: { state: "approved", approval_ref: "lifecycle-20260912" },
    route: {
      required_capabilities: ["text-generation"],
      privacy: "unrestricted",
      locality: "any",
    },
    required_quality_tags: ["reliable"],
    ...overrides,
  };
}

function honestArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    version: BASE_VERSION,
    candidates: [minimalCandidate()],
    tasks: [minimalTask()],
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

function assertNoPhantomProjection(body: Record<string, unknown>, label: string): void {
  assert.notEqual(
    body.projection,
    true,
    `${label}: MUST NOT carry a phantom projection:true; got: ${JSON.stringify(body)}`,
  );
  assert.equal(
    "supplied_input_sha256" in body,
    false,
    `${label}: MUST NOT carry a phantom supplied_input_sha256; got: ${JSON.stringify(body)}`,
  );
}

// ---------------------------------------------------------------------------
// T1 — advertised schema pin
// ---------------------------------------------------------------------------

test("plan_speculative_backlog advertises closed required version/candidates/tasks, additionalProperties:false, and read-only annotations", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "plan_speculative_backlog");
    assert.ok(tool, "plan_speculative_backlog must be advertised");
    assert.match(
      tool.description ?? "",
      /Pure, caller-approved speculative backlog projection/,
      "description must keep the Pure, caller-approved speculative backlog projection phrase",
    );
    assert.match(
      tool.description ?? "",
      /Does not persist, execute, authorize, wake agents, contact providers, poll, allocate capacity, schedule, spend, send, or publish/,
      "description must keep the twelve-verb Does-not list",
    );
    const schema = tool.inputSchema as {
      type: string;
      required?: string[];
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["version", "candidates", "tasks"]);
    assert.equal(
      schema.additionalProperties,
      false,
      "plan_speculative_backlog schema MUST advertise additionalProperties:false — planner allowedKeys is the real gate; advertising undefined would be a lie",
    );
    assert.deepEqual(tool.annotations, PLAN_ANNOTATIONS);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(props).sort(), [
      "candidate_limit",
      "candidates",
      "preference",
      "tasks",
      "version",
    ]);
    assert.equal(props.version.const, BASE_VERSION);
    assert.equal(props.candidate_limit.type, "integer");
    assert.equal(props.candidate_limit.minimum, 1);
    assert.equal(props.candidate_limit.maximum, 8);
    assert.equal(props.candidate_limit.default, 3);
    const preference = props.preference as {
      additionalProperties?: boolean;
      required?: string[];
      properties?: Record<string, Record<string, unknown>>;
    };
    assert.equal(preference.additionalProperties, false);
    assert.deepEqual(preference.required, ["objective", "now_ms"]);
    assert.equal(preference.properties?.objective.const, "prefer_near_reset");
    const candidates = props.candidates as {
      minItems?: number;
      maxItems?: number;
      items?: { required?: string[] };
    };
    assert.equal(candidates.minItems, 1);
    assert.equal(candidates.maxItems, 256);
    assert.deepEqual(candidates.items?.required, [
      "candidate_id",
      "capabilities",
      "privacy",
      "locality",
      "quality_tags",
    ]);
    const tasks = props.tasks as {
      minItems?: number;
      maxItems?: number;
      items?: { properties?: Record<string, { enum?: string[] }>; required?: string[] };
    };
    assert.equal(tasks.minItems, 1);
    assert.equal(tasks.maxItems, 64);
    assert.deepEqual(tasks.items?.properties?.kind.enum, [
      "benchmark",
      "reusable_asset",
      "code_review",
      "test_generation",
      "video_candidate",
    ]);
    assert.deepEqual(tasks.items?.required, [
      "task_id",
      "kind",
      "priority",
      "speculative_approval",
      "route",
      "required_quality_tags",
    ]);
  });
});

// ---------------------------------------------------------------------------
// T2 — required-field honesty (SDK does not enforce required)
// ---------------------------------------------------------------------------

test("plan_speculative_backlog refuses absent version/candidates/tasks as isError naming the field, never a phantom projection", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const cases: ReadonlyArray<{ label: string; args: Record<string, unknown>; field: string }> = [
      { label: "empty object", args: {}, field: "version" },
      { label: "missing version", args: honestArgs({ version: undefined }), field: "version" },
      { label: "missing candidates", args: honestArgs({ candidates: undefined }), field: "candidates" },
      { label: "missing tasks", args: honestArgs({ tasks: undefined }), field: "tasks" },
    ];
    for (const { label, args, field } of cases) {
      const response = await client.callTool({
        name: "plan_speculative_backlog",
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
        `${label}: planner validate() names the field path, not an SDK 'is required' string; got: ${String(body.error)}`,
      );
      assertNoPhantomProjection(body, label);
    }
  });
});

// ---------------------------------------------------------------------------
// T3 — named wrong-typed-input bug class
// ---------------------------------------------------------------------------

test("plan_speculative_backlog refuses 5 wrong-typed shapes before any projection (named coerce-into-hash class)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const cases: ReadonlyArray<{ label: string; args: Record<string, unknown>; field: string }> = [
      { label: "number version", args: honestArgs({ version: 1 }), field: "version" },
      { label: "string candidates", args: honestArgs({ candidates: "not-an-array" }), field: "candidates" },
      { label: "object tasks", args: honestArgs({ tasks: { not: "array" } }), field: "tasks" },
      { label: "string candidate_limit", args: honestArgs({ candidate_limit: "3" }), field: "candidate_limit" },
      { label: "string preference", args: honestArgs({ preference: "prefer_near_reset" }), field: "preference" },
    ];
    for (const { label, args, field } of cases) {
      const response = await client.callTool({
        name: "plan_speculative_backlog",
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
        new RegExp(field),
        `${label}: error must name ${field}; got: ${JSON.stringify(body)}`,
      );
      assert.doesNotMatch(
        textOf(response),
        /projection":true/,
        `${label}: MUST NOT stringify a wrong-typed input into a legitimate-looking projection; got: ${textOf(response)}`,
      );
      assertNoPhantomProjection(body, label);
    }
  });
});

// ---------------------------------------------------------------------------
// T4 — advertised additionalProperties:false IS handler-enforced
// ---------------------------------------------------------------------------

test("plan_speculative_backlog refuses phantom top-level keys (additionalProperties:false is handler-enforced via allowedKeys)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const phantomCases: ReadonlyArray<{ label: string; extra: Record<string, unknown> }> = [
      { label: "force", extra: { force: true } },
      { label: "retry", extra: { retry: 3 } },
      { label: "note", extra: { note: "for your eyes only" } },
      { label: "provider_id", extra: { provider_id: "smuggled" } },
    ];
    for (const { label, extra } of phantomCases) {
      const response = await client.callTool({
        name: "plan_speculative_backlog",
        arguments: { ...honestArgs(), ...extra },
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `phantom ${label}: MUST be refused; advertising additionalProperties:false would be a lie if the handler accepted it; got: ${textOf(response)}`,
      );
      const body = bodyOf(response);
      assert.match(
        String(body.error),
        new RegExp(`${label}.*is not allowed`),
        `phantom ${label}: error must name the key as not allowed; got: ${JSON.stringify(body)}`,
      );
      assertNoPhantomProjection(body, `phantom ${label}`);
      assert.doesNotMatch(
        textOf(response),
        /planner_version|supplied_input_sha256/,
        `phantom ${label}: MUST NOT leak into a success envelope; got: ${textOf(response)}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// T5 — happy-path envelope
// ---------------------------------------------------------------------------

test("plan_speculative_backlog happy path returns the documented pure-projection envelope with every effects flag false", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "plan_speculative_backlog",
      arguments: honestArgs({
        candidates: [
          minimalCandidate({ candidate_id: "candidate-alpha", quality_tags: ["reliable"] }),
          minimalCandidate({ candidate_id: "candidate-beta", quality_tags: ["reliable"] }),
        ],
        tasks: [
          minimalTask({ task_id: "task-alpha", priority: 75 }),
          minimalTask({ task_id: "task-beta", priority: 25 }),
        ],
      }),
    });
    assert.equal(
      (response as ToolResponse).isError,
      undefined,
      `valid call must not be isError; got: ${textOf(response)}`,
    );
    const body = bodyOf(response);
    assert.equal(body.planner_version, BASE_VERSION);
    assert.match(String(body.supplied_input_sha256), /^[0-9a-f]{64}$/);
    assert.equal(body.projection, true);
    assert.deepEqual(body.effects, EFFECTS_ALL_FALSE);
    assert.deepEqual(body.capacity, { mode: "unmodeled", status: "unknown" });
    assert.equal("preference" in body, false, "preference absent in input => absent in output");
    const proposed = body.proposed as Array<Record<string, unknown>>;
    assert.equal(proposed.length, 2);
    assert.equal(proposed[0]!.task_id, "task-alpha");
    assert.equal(proposed[1]!.task_id, "task-beta");
    for (const entry of proposed) {
      assert.equal(entry.kind, "benchmark");
      assert.equal(entry.approval_ref, "lifecycle-20260912");
      assert.ok(Array.isArray(entry.candidate_ids));
      assert.ok((entry.candidate_ids as unknown[]).length >= 1);
      assert.ok(Array.isArray(entry.rankings));
      assert.deepEqual(entry.reason_codes, ["CAPACITY_UNMODELED"]);
    }
    assert.deepEqual(body.blocked, []);
    for (const leaked of ["force", "retry", "note", "provider_id"]) {
      assert.equal(
        leaked in body,
        false,
        `success envelope MUST NOT leak phantom key ${leaked}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// T6 — speculative_approval + quality_tags
// ---------------------------------------------------------------------------

test("plan_speculative_backlog blocks not_approved tasks and ranks out QUALITY_TAG_MISMATCH candidates", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "plan_speculative_backlog",
      arguments: honestArgs({
        candidates: [
          minimalCandidate({ candidate_id: "candidate-quality-ok", quality_tags: ["reliable"] }),
          minimalCandidate({ candidate_id: "candidate-quality-bad", quality_tags: ["experimental"] }),
        ],
        tasks: [
          minimalTask({
            task_id: "task-not-approved",
            speculative_approval: { state: "not_approved" },
            required_quality_tags: ["reliable"],
          }),
          minimalTask({
            task_id: "task-quality-ok",
            speculative_approval: { state: "approved", approval_ref: "lifecycle-20260912" },
            required_quality_tags: ["reliable"],
          }),
        ],
      }),
    });
    assert.equal((response as ToolResponse).isError, undefined, textOf(response));
    const body = bodyOf(response);
    const proposedIds = (body.proposed as Array<Record<string, unknown>>).map((entry) => entry.task_id);
    assert.equal(proposedIds.includes("task-not-approved"), false);
    const blocked = body.blocked as Array<Record<string, unknown>>;
    const notApproved = blocked.find((entry) => entry.task_id === "task-not-approved");
    assert.ok(notApproved, "not_approved task must appear in blocked");
    assert.deepEqual(notApproved!.reason_codes, ["SPECULATIVE_APPROVAL_REQUIRED"]);
    assert.deepEqual(notApproved!.candidate_exclusions, []);
    const okEntry = (body.proposed as Array<Record<string, unknown>>).find(
      (entry) => entry.task_id === "task-quality-ok",
    );
    assert.ok(okEntry);
    assert.deepEqual(okEntry!.candidate_ids, ["candidate-quality-ok"]);
  });
});

// ---------------------------------------------------------------------------
// T7 — source-string pin
// ---------------------------------------------------------------------------

test("plan_speculative_backlog handler source pins try/catch planSpeculativeBacklog jsonError wrap and closed advertised schema", () => {
  const source = readFileSync(join(repoRoot, "src", "index.ts"), "utf8");
  assert.match(
    source,
    /toolHandlers\["plan_speculative_backlog"\]/,
    "plan_speculative_backlog must be a top-level toolHandlers entry",
  );
  assert.ok(
    source.includes("Pure, caller-approved speculative backlog projection."),
    "plan_speculative_backlog description must keep the Pure, caller-approved phrase",
  );
  assert.ok(
    source.includes(
      "Does not persist, execute, authorize, wake agents, contact providers, poll, allocate capacity, schedule, spend, send, or publish.",
    ),
    "plan_speculative_backlog description must keep the twelve-verb Does-not list",
  );

  const schemaMatch = source.match(
    /name: "plan_speculative_backlog",[\s\S]*?inputSchema: \{([\s\S]*?)required: \["version", "candidates", "tasks"\],/,
  );
  assert.ok(schemaMatch, "plan_speculative_backlog inputSchema block must be found through required [version, candidates, tasks]");
  const schemaHead = schemaMatch[1]!;
  assert.match(
    schemaHead,
    /additionalProperties:\s*false/,
    "advertised schema MUST declare additionalProperties:false — this tool's allowedKeys gate makes the advertisement honest",
  );
  assert.match(
    schemaHead,
    /version: \{ type: "string", const: "meshfleet\.speculative-backlog\.v0\.1" \}/,
    "advertised schema must pin version const meshfleet.speculative-backlog.v0.1",
  );

  const handlerMatch = source.match(
    /toolHandlers\["plan_speculative_backlog"\] = async \(args\) => \{([\s\S]*?)\n\};\s*\n\s*toolHandlers\["recommend_route"\]/,
  );
  assert.ok(
    handlerMatch,
    "plan_speculative_backlog handler block must be found immediately before recommend_route",
  );
  const handlerBody = handlerMatch[1]!;
  assert.match(
    handlerBody,
    /try \{/,
    "handler must wrap the projection in try",
  );
  assert.match(
    handlerBody,
    /return jsonResult\(planSpeculativeBacklog\(args as PlanSpeculativeBacklogInput\)\)/,
    "success path must jsonResult(planSpeculativeBacklog(args as PlanSpeculativeBacklogInput))",
  );
  assert.match(
    handlerBody,
    /catch \(error\)/,
    "handler must catch planner validate() throws",
  );
  assert.match(
    handlerBody,
    /return jsonError\(error instanceof Error \? error\.message : String\(error\)\)/,
    "catch path must jsonError the Error.message (never a raw stack)",
  );
  assert.doesNotMatch(
    handlerBody,
    /spawnFleet\(/,
    "handler must NOT call spawnFleet — published pure-projection promise",
  );
  assert.doesNotMatch(
    handlerBody,
    /wakeAgent\(/,
    "handler must NOT call wakeAgent — published pure-projection promise",
  );
  assert.doesNotMatch(
    handlerBody,
    /sendMessage\(/,
    "handler must NOT call sendMessage — published pure-projection promise",
  );
  assert.doesNotMatch(
    handlerBody,
    /fetch\(/,
    "handler must NOT call fetch — published pure-projection promise",
  );
  assert.doesNotMatch(
    handlerBody,
    /requireAllowedKeys/,
    "handler must NOT call requireAllowedKeys — planner allowedKeys is the closed-input gate",
  );
  assert.doesNotMatch(
    handlerBody,
    /requireString/,
    "handler must NOT call requireString — planner validate() is the wire gate",
  );
  const occurrences = source.split('toolHandlers["plan_speculative_backlog"]').length - 1;
  assert.equal(occurrences, 1, "plan_speculative_backlog handler must be registered exactly once");
});
