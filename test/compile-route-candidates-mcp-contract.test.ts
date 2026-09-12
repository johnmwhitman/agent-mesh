/**
 * compile_route_candidates MCP contract — driven over real MCP stdio with
 * the tool's PUBLISHED field names.
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `compile_route_candidates` is the closed
 * offline snapshot compiler (src/index.ts advertised schema at L959-L1113
 * + handler at toolHandlers["compile_route_candidates"] L2133-L2141 on
 * origin/main 8433dcb8). It is published. test/compile-route-candidates-mcp.test.ts
 * already pins the closed schema, the portable corpus, and one malicious-
 * field runtime refusal. A 2026-09-09 worktree (fed9fa0f) existed for an
 * 8-test stdio pin but never landed: it used import.meta-relative repoRoot
 * (fragile under tsconfig.test.json outDir), mixed schema+annotations into
 * one test, used a hard regex of the one-liner handler, and bumped
 * HANDOFF.md published figures. This card is a fresh origin/main pin with
 * the 2026-09-12 honesty pattern:
 *
 *   1. advertised schema pin — required [manifest], additionalProperties:false
 *      (this tool HONESTLY advertises closed input; compiler requireAllowedKeys
 *      is the real gate), annotations {readOnlyHint:true, idempotentHint:true,
 *      destructiveHint:false, openWorldHint:false} plus description phrases
 *      Offline projection / Does not persist, rank, execute, authorize, wake,
 *      or contact providers. Nested objects closed. Observation status enum
 *      omits "unconfigured" (module-level token, never accepted for a
 *      manifest candidate).
 *   2. required-field honesty — absent manifest is isError naming the field
 *      and NEVER a phantom projection:true; SDK does NOT enforce required
 *   3. named coerce-into-hash bug class — 5 non-honest shapes (string
 *      manifest, number version, string candidates, object observations,
 *      nested provider on a candidate) all return isError naming the field
 *      and NEVER stringify into a legitimate-looking projection
 *   4. advertised-vs-handler honesty — additionalProperties:false IS
 *      handler-enforced via compiler allowedKeys (the opposite of
 *      attach_agent / subscribe_events). Phantom top-level keys
 *      force/retry/note/provider_id are jsonError naming the key as not
 *      allowed and NEVER leak into a success envelope
 *   5. happy-path envelope {compiler_version, projection:true, effects
 *      five flags all false, candidates, diagnostics} with candidate_id
 *      sort and OBSERVATION_MISSING+BUDGET_UNMEASURED when no observation
 *   6. unconfigured observation is refused (schema honesty: advertised
 *      enum omits it AND handler still refuses); assumed observation
 *      yields OBSERVATION_ASSUMED+BUDGET_UNMEASURED; measured budget
 *      copies budget.measured=true
 *   7. source-string pin — try/catch jsonError wrap of
 *      compileRouteCandidates(args as unknown as CompileRouteCandidatesInput)
 *      immediately before plan_speculative_backlog + NO spawnFleet/wakeAgent/
 *      sendMessage/fetch + NO requireAllowedKeys + NO requireString in the
 *      handler + handler registered exactly once
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
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-compile-route-mcp-"));
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
    { name: "compile-route-candidates-contract-test", version: "1.0.0" },
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

const COMPILER_VERSION = "meshfleet.route-candidates.v0.1";

const COMPILE_ANNOTATIONS = {
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

function minimalCandidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidate_id: "route-a",
    capabilities: ["ts"],
    privacy: "local_only",
    locality: "same_host",
    ...overrides,
  };
}

function honestArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    manifest: {
      version: COMPILER_VERSION,
      candidates: [minimalCandidate()],
    },
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
    "compiler_version" in body,
    false,
    `${label}: MUST NOT carry a phantom compiler_version; got: ${JSON.stringify(body)}`,
  );
  assert.equal(
    "candidates" in body && Array.isArray(body.candidates) && (body.candidates as unknown[]).length > 0 && body.projection === true,
    false,
    `${label}: MUST NOT carry a success-shaped candidates envelope; got: ${JSON.stringify(body)}`,
  );
}

// ---------------------------------------------------------------------------
// T1 — advertised schema pin
// ---------------------------------------------------------------------------

test("compile_route_candidates advertises closed required manifest, additionalProperties:false, and read-only annotations", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "compile_route_candidates");
    assert.ok(tool, "compile_route_candidates must be advertised");
    assert.match(
      tool.description ?? "",
      /Offline projection of caller-supplied route-candidate snapshots/,
      "description must keep the Offline projection phrase",
    );
    assert.match(
      tool.description ?? "",
      /Does not persist, rank, execute, authorize, wake, or contact providers/,
      "description must keep the six-verb Does-not list",
    );
    const schema = tool.inputSchema as {
      type: string;
      required?: string[];
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["manifest"]);
    assert.equal(
      schema.additionalProperties,
      false,
      "compile_route_candidates schema MUST advertise additionalProperties:false — compiler allowedKeys is the real gate; advertising undefined would be a lie",
    );
    assert.deepEqual(tool.annotations, COMPILE_ANNOTATIONS);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(props).sort(), ["manifest", "observations"]);

    const manifest = props.manifest as {
      additionalProperties?: boolean;
      required?: string[];
      properties?: Record<string, Record<string, unknown>>;
    };
    assert.equal(manifest.additionalProperties, false);
    assert.deepEqual(manifest.required, ["version", "candidates"]);
    assert.deepEqual(manifest.properties?.version.enum, [COMPILER_VERSION]);
    const candidates = manifest.properties?.candidates as {
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
    assert.deepEqual(candidates.items?.properties?.privacy.enum, [
      "local_only",
      "network_ok",
      "unrestricted",
    ]);
    assert.deepEqual(candidates.items?.properties?.locality.enum, [
      "same_host",
      "same_fleet",
      "any",
    ]);

    const observations = props.observations as {
      minItems?: number;
      maxItems?: number;
      items?: {
        additionalProperties?: boolean;
        required?: string[];
        properties?: Record<string, { enum?: string[] }>;
      };
    };
    assert.equal(observations.minItems, 0);
    assert.equal(observations.maxItems, 256);
    assert.equal(observations.items?.additionalProperties, false);
    assert.deepEqual(observations.items?.required, ["candidate_id", "status", "confidence"]);
    assert.deepEqual(observations.items?.properties?.status.enum, [
      "green",
      "degraded",
      "exhausted",
    ]);
    assert.equal(
      observations.items?.properties?.status.enum?.includes("unconfigured"),
      false,
      "advertised observation status MUST omit unconfigured — it is a module-level token never accepted for a manifest candidate",
    );
    assert.deepEqual(observations.items?.properties?.confidence.enum, ["measured", "assumed"]);
  });
});

// ---------------------------------------------------------------------------
// T2 — required-field honesty (SDK does not enforce required)
// ---------------------------------------------------------------------------

test("compile_route_candidates refuses absent manifest as isError naming the field, never a phantom projection", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const cases: ReadonlyArray<{ label: string; args: Record<string, unknown> }> = [
      { label: "empty object", args: {} },
      { label: "missing manifest", args: honestArgs({ manifest: undefined }) },
      { label: "observations only", args: { observations: [] } },
    ];
    for (const { label, args } of cases) {
      const response = await client.callTool({
        name: "compile_route_candidates",
        arguments: args,
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `${label}: absent manifest must be isError; got: ${textOf(response)}`,
      );
      const body = bodyOf(response);
      assert.match(
        String(body.error),
        /manifest/,
        `${label}: error must name manifest; got: ${JSON.stringify(body)}`,
      );
      assert.doesNotMatch(
        String(body.error),
        /is required/i,
        `${label}: compiler validate() names the field path, not an SDK 'is required' string; got: ${String(body.error)}`,
      );
      assertNoPhantomProjection(body, label);
    }
  });
});

// ---------------------------------------------------------------------------
// T3 — named wrong-typed-input bug class
// ---------------------------------------------------------------------------

test("compile_route_candidates refuses 5 wrong-typed shapes before any projection (named coerce-into-hash class)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const cases: ReadonlyArray<{ label: string; args: Record<string, unknown>; field: string }> = [
      { label: "string manifest", args: { manifest: "not-an-object" }, field: "manifest" },
      {
        label: "number version",
        args: honestArgs({
          manifest: { version: 1, candidates: [minimalCandidate()] },
        }),
        field: "manifest.version",
      },
      {
        label: "string candidates",
        args: honestArgs({
          manifest: { version: COMPILER_VERSION, candidates: "not-an-array" },
        }),
        field: "manifest.candidates",
      },
      {
        label: "object observations",
        args: { ...honestArgs(), observations: { not: "array" } },
        field: "observations",
      },
      {
        label: "nested provider on candidate",
        args: honestArgs({
          manifest: {
            version: COMPILER_VERSION,
            candidates: [minimalCandidate({ provider: "smuggled" })],
          },
        }),
        field: "provider",
      },
    ];
    for (const { label, args, field } of cases) {
      const response = await client.callTool({
        name: "compile_route_candidates",
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
        /projection\":true/,
        `${label}: MUST NOT stringify a wrong-typed input into a legitimate-looking projection; got: ${textOf(response)}`,
      );
      assertNoPhantomProjection(body, label);
    }
  });
});

// ---------------------------------------------------------------------------
// T4 — advertised additionalProperties:false IS handler-enforced
// ---------------------------------------------------------------------------

test("compile_route_candidates refuses phantom top-level keys (additionalProperties:false is handler-enforced via allowedKeys)", async () => {
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
        name: "compile_route_candidates",
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
        /compiler_version|projection\":true/,
        `phantom ${label}: MUST NOT leak into a success envelope; got: ${textOf(response)}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// T5 — happy-path envelope
// ---------------------------------------------------------------------------

test("compile_route_candidates happy path returns the documented pure-projection envelope with every effects flag false", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "compile_route_candidates",
      arguments: honestArgs({
        manifest: {
          version: COMPILER_VERSION,
          candidates: [
            minimalCandidate({ candidate_id: "route-z" }),
            minimalCandidate({ candidate_id: "route-a" }),
          ],
        },
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
      ["candidates", "compiler_version", "diagnostics", "effects", "projection"],
      "result top-level keys must be EXACTLY the documented five-key envelope",
    );
    assert.equal(body.compiler_version, COMPILER_VERSION);
    assert.equal(body.projection, true);
    assert.deepEqual(body.effects, EFFECTS_FIVE_FALSE);
    const candidates = body.candidates as Array<Record<string, unknown>>;
    assert.equal(candidates.length, 2);
    assert.equal(candidates[0]!.candidate_id, "route-a", "candidates must sort by candidate_id");
    assert.equal(candidates[1]!.candidate_id, "route-z");
    for (const candidate of candidates) {
      assert.deepEqual(candidate.capabilities, ["ts"]);
      assert.equal(candidate.privacy, "local_only");
      assert.equal(candidate.locality, "same_host");
      assert.deepEqual(candidate.budget, { measured: false });
    }
    const diagnostics = body.diagnostics as Array<Record<string, unknown>>;
    assert.equal(diagnostics.length, 2);
    assert.deepEqual(diagnostics[0], {
      candidate_id: "route-a",
      reason_codes: ["OBSERVATION_MISSING", "BUDGET_UNMEASURED"],
    });
    assert.deepEqual(diagnostics[1], {
      candidate_id: "route-z",
      reason_codes: ["OBSERVATION_MISSING", "BUDGET_UNMEASURED"],
    });
    for (const leaked of ["force", "retry", "note", "provider_id", "manifest", "observations"]) {
      assert.equal(
        leaked in body,
        false,
        `success envelope MUST NOT leak phantom key ${leaked}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// T6 — unconfigured honesty + assumed vs measured observation diagnostics
// ---------------------------------------------------------------------------

test("compile_route_candidates refuses unconfigured observations and distinguishes assumed vs measured budget evidence", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const unconfigured = await client.callTool({
      name: "compile_route_candidates",
      arguments: {
        ...honestArgs(),
        observations: [
          {
            candidate_id: "route-a",
            status: "unconfigured",
            confidence: "assumed",
          },
        ],
      },
    });
    assert.equal(
      (unconfigured as ToolResponse).isError,
      true,
      `unconfigured observation must be isError; advertised enum omits it AND handler still refuses; got: ${textOf(unconfigured)}`,
    );
    const unconfiguredBody = bodyOf(unconfigured);
    assert.match(
      String(unconfiguredBody.error),
      /unconfigured/,
      `unconfigured observation error must name unconfigured; got: ${JSON.stringify(unconfiguredBody)}`,
    );
    assertNoPhantomProjection(unconfiguredBody, "unconfigured observation");

    const assumed = await client.callTool({
      name: "compile_route_candidates",
      arguments: {
        manifest: {
          version: COMPILER_VERSION,
          candidates: [
            minimalCandidate({ candidate_id: "route-assumed" }),
            minimalCandidate({ candidate_id: "route-measured" }),
          ],
        },
        observations: [
          {
            candidate_id: "route-assumed",
            status: "green",
            confidence: "assumed",
          },
          {
            candidate_id: "route-measured",
            status: "green",
            confidence: "measured",
            budget: { used: 1, total: 10 },
          },
        ],
      },
    });
    assert.equal(
      (assumed as ToolResponse).isError,
      undefined,
      `assumed+measured observations must succeed; got: ${textOf(assumed)}`,
    );
    const body = bodyOf(assumed);
    assert.equal(body.projection, true);
    assert.deepEqual(body.effects, EFFECTS_FIVE_FALSE);
    const candidates = body.candidates as Array<Record<string, unknown>>;
    const assumedCandidate = candidates.find((entry) => entry.candidate_id === "route-assumed");
    const measuredCandidate = candidates.find((entry) => entry.candidate_id === "route-measured");
    assert.ok(assumedCandidate, "assumed candidate must be present");
    assert.ok(measuredCandidate, "measured candidate must be present");
    assert.deepEqual(assumedCandidate!.budget, { measured: false });
    assert.deepEqual(measuredCandidate!.budget, { measured: true, used: 1, total: 10 });
    const diagnostics = body.diagnostics as Array<Record<string, unknown>>;
    const assumedDiag = diagnostics.find((entry) => entry.candidate_id === "route-assumed");
    const measuredDiag = diagnostics.find((entry) => entry.candidate_id === "route-measured");
    assert.deepEqual(assumedDiag?.reason_codes, ["OBSERVATION_ASSUMED", "BUDGET_UNMEASURED"]);
    assert.deepEqual(measuredDiag?.reason_codes, []);
  });
});

// ---------------------------------------------------------------------------
// T7 — source-string pin
// ---------------------------------------------------------------------------

test("compile_route_candidates handler source pins try/catch compileRouteCandidates jsonError wrap and closed advertised schema", () => {
  const source = readFileSync(join(repoRoot, "src", "index.ts"), "utf8");
  assert.match(
    source,
    /toolHandlers\["compile_route_candidates"\]/,
    "compile_route_candidates must be a top-level toolHandlers entry",
  );
  assert.ok(
    source.includes("Offline projection of caller-supplied route-candidate snapshots."),
    "compile_route_candidates description must keep the Offline projection phrase",
  );
  assert.ok(
    source.includes(
      "Does not persist, rank, execute, authorize, wake, or contact providers.",
    ),
    "compile_route_candidates description must keep the six-verb Does-not list",
  );
  assert.ok(
    source.includes(
      '"unconfigured" exists as a module-level status token but is',
    ),
    "advertised schema must keep the unconfigured-is-not-published comment",
  );

  const schemaMatch = source.match(
    /name: "compile_route_candidates",[\s\S]*?inputSchema: \{([\s\S]*?)required: \["manifest"\],/,
  );
  assert.ok(schemaMatch, "compile_route_candidates inputSchema block must be found through required [manifest]");
  const schemaHead = schemaMatch[1]!;
  assert.match(
    schemaHead,
    /additionalProperties:\s*false/,
    "advertised schema MUST declare additionalProperties:false — this tool's allowedKeys gate makes the advertisement honest",
  );
  assert.match(
    schemaHead,
    /enum: \["meshfleet\.route-candidates\.v0\.1"\]/,
    "advertised schema must pin version enum meshfleet.route-candidates.v0.1",
  );

  const handlerMatch = source.match(
    /toolHandlers\["compile_route_candidates"\] = async \(args\) => \{([\s\S]*?)\n\};\s*\n\s*toolHandlers\["plan_speculative_backlog"\]/,
  );
  assert.ok(
    handlerMatch,
    "compile_route_candidates handler block must be found immediately before plan_speculative_backlog",
  );
  const handlerBody = handlerMatch[1]!;
  assert.match(
    handlerBody,
    /try \{/,
    "handler must wrap the projection in try",
  );
  assert.match(
    handlerBody,
    /return jsonResult\(\s*compileRouteCandidates\(args as unknown as CompileRouteCandidatesInput\)/,
    "success path must jsonResult(compileRouteCandidates(args as unknown as CompileRouteCandidatesInput))",
  );
  assert.match(
    handlerBody,
    /catch \(error\)/,
    "handler must catch compiler validate() throws",
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
    "handler must NOT call requireAllowedKeys — compiler allowedKeys is the closed-input gate",
  );
  assert.doesNotMatch(
    handlerBody,
    /requireString/,
    "handler must NOT call requireString — compiler validate() is the wire gate",
  );
  const occurrences = source.split('toolHandlers["compile_route_candidates"]').length - 1;
  assert.equal(occurrences, 1, "compile_route_candidates handler must be registered exactly once");
});
