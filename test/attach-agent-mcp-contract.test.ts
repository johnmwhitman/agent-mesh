/**
 * attach_agent MCP contract — driven over real MCP stdio with the tool's
 * PUBLISHED field names.
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `attach_agent` is the ONLY in-place path
 * into an existing fleet (src/index.ts advertised schema at L1493-L1523 +
 * handler at toolHandlers["attach_agent"] L2498-L2607 on origin/main
 * 8433dcb8). It is published, yet origin/main has no dedicated stdio
 * contract pinning the 2026-09-12 honesty pattern:
 *
 *   1. the advertised schema (required fleet_id/role/prompt, optional
 *      agent/model/expects_artifact, NO additionalProperties key,
 *      annotations including openWorldHint=true + readOnlyHint=false +
 *      idempotentHint=false) plus description phrases "running fleet" and
 *      "banks complete only when result_contract is ok"
 *   2. required-field absence refused as isError naming tool + field —
 *      NEVER a phantom agent_id and NEVER the fleet-lookup "not found"
 *   3. named bug class: a wrong-typed required string used to stringify
 *      into a lookup / spawn identity. requireString must fire BEFORE
 *      lifecycleCoordinator.modeForFleet / withLedger
 *   4. unknown-fleet jsonError `Fleet ${id} not found` after the wire
 *      gate (honest-shape call for a missing fleet)
 *   5. sealed-status refuse: complete/failed stay sealed (`is ${status},
 *      not running`); abandoned is accepted and reopened to running
 *      (the ONLY in-place remedy a truthful terminal status leaves)
 *   6. advertised-vs-handler drift honesty — schema does NOT advertise
 *      additionalProperties:false, and phantom top-level keys still
 *      reach the handler (no requireAllowedKeys). Happy-path envelope
 *      is {agent_id, fleet_id, role, agent_file, message}
 *   7. source-string pin on the handler body + named-bug comments
 *      (unenforced-contract hole, ONLY in-place path, abandoned reopen)
 *
 * Each invariant is independently falsifiable. The SDK enforces neither
 * `required` nor `type`; toolHandlers is typed `(args: any)`.
 *
 * test/attach-abandoned-fleet.test.ts already pins the status gate over
 * stdio. A 2026-09-08 worktree (234cb805) existed for attach_agent but
 * never landed and mixed auto-register / expects_artifact persistence
 * into the same file without the 2026-09-12 honesty pattern (no
 * advertised-vs-handler additionalProperties pin, no named stringified-
 * lookup-key class, no schema-annotation pin). A 2026-09-09 worktree
 * (7bc39b93) was a 26-line source-string-only pin that asserted a
 * minLength:1 schema the origin/main advertisement does not have. This
 * card is a fresh origin/main pin with the 2026-09-12 honesty pattern.
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

import { createFleet } from "../src/core.js";
import { closeDb, withLedger } from "../src/db.js";

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
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-attach-agent-mcp-"));
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
    { name: "attach-agent-contract-test", version: "1.0.0" },
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

/** Child-mode: recovery, sweeper, and SSE skipped (src/index.ts L3058). */
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

const honestArgs = (fleetId: string): Record<string, unknown> => ({
  fleet_id: fleetId,
  role: "replacement",
  prompt: "take over",
});

const ATTACH_AGENT_ANNOTATIONS = {
  openWorldHint: true,
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
} as const;

const EXPECTS_ARTIFACT_DESCRIPTION =
  "Declare that this agent's result envelope must name at least one produced file: " +
  "a 'done' declaration with no artifacts is recorded as result_contract " +
  "'artifact_missing' instead of 'ok' and banks failed; the agent is told so in its prompt. " +
  "Named paths are existence-checked only — a declared-output check, never a " +
  "content or quality guarantee.";

function seedFleetStatus(
  fleetId: string,
  status: "running" | "abandoned" | "complete" | "failed",
): void {
  createFleet(fleetId);
  if (status === "running") return;
  withLedger((data) => {
    const fleet = data.fleets[fleetId];
    if (!fleet) throw new Error(`seedFleetStatus: ${fleetId} missing after createFleet`);
    fleet.status = status;
    if (status === "complete" || status === "failed" || status === "abandoned") {
      fleet.completed_at = Date.now();
    }
  });
}

function assertNoPhantomAgentId(body: Record<string, unknown>, label: string): void {
  assert.equal(
    "agent_id" in body,
    false,
    `${label}: MUST NOT carry a phantom agent_id; got: ${JSON.stringify(body)}`,
  );
}

// ---------------------------------------------------------------------------
// T1 — advertised schema pin
// ---------------------------------------------------------------------------

test("attach_agent advertises required fleet_id/role/prompt, no additionalProperties, and open-world/mutating annotations", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "attach_agent");
    assert.ok(tool, "attach_agent must be advertised");
    const schema = tool.inputSchema as {
      type: string;
      required?: string[];
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["fleet_id", "role", "prompt"]);
    assert.equal(
      schema.additionalProperties,
      undefined,
      "attach_agent schema MUST NOT advertise additionalProperties (handler has no requireAllowedKeys; advertising false would be a lie)",
    );
    const props = schema.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(props).sort(), [
      "agent",
      "expects_artifact",
      "fleet_id",
      "model",
      "prompt",
      "role",
    ]);
    assert.deepEqual(props.fleet_id, { type: "string" });
    assert.deepEqual(props.role, { type: "string" });
    assert.deepEqual(props.prompt, { type: "string" });
    assert.deepEqual(props.agent, {
      type: "string",
      description: "Premade agent filename stem (e.g. 'frontend-developer').",
    });
    assert.deepEqual(props.model, {
      type: "string",
      description:
        "Optional OpenCode model selector as provider/model (e.g. 'opencode-go/minimax-m3').",
    });
    assert.deepEqual(props.expects_artifact, {
      type: "boolean",
      description: EXPECTS_ARTIFACT_DESCRIPTION,
    });
    assert.ok(
      !schema.required!.includes("agent"),
      "agent is optional — must NOT appear in required[]",
    );
    assert.ok(
      !schema.required!.includes("model"),
      "model is optional — must NOT appear in required[]",
    );
    assert.ok(
      !schema.required!.includes("expects_artifact"),
      "expects_artifact is optional — must NOT appear in required[]",
    );
    assert.deepEqual(tool.annotations, ATTACH_AGENT_ANNOTATIONS);
    assert.ok(
      typeof tool.description === "string" &&
        tool.description.includes("running fleet"),
      `description must keep the running-fleet phrase; got: ${tool.description}`,
    );
    assert.ok(
      typeof tool.description === "string" &&
        tool.description.includes("banks complete only when result_contract is ok"),
      `description must keep the result-contract banking phrase; got: ${tool.description}`,
    );
  });
});

// ---------------------------------------------------------------------------
// T2 — required-field absence refused as tool+field, NEVER "not found"
// ---------------------------------------------------------------------------

test("attach_agent refuses absent fleet_id/role/prompt as isError naming tool+field", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const cases: ReadonlyArray<{ label: string; args: Record<string, unknown>; field: string }> = [
      { label: "absent fleet_id", args: { role: "r", prompt: "p" }, field: "fleet_id" },
      { label: "absent role", args: { fleet_id: "f", prompt: "p" }, field: "role" },
      { label: "absent prompt", args: { fleet_id: "f", role: "r" }, field: "prompt" },
      { label: "empty arguments", args: {}, field: "fleet_id" },
    ];
    for (const { label, args, field } of cases) {
      const response = await client.callTool({
        name: "attach_agent",
        arguments: args,
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `${label}: must be a tool error; got: ${textOf(response)}`,
      );
      const text = textOf(response);
      assert.match(text, /attach_agent/, `${label}: must name the tool; got: ${text}`);
      assert.match(
        text,
        new RegExp(`'${field}'`),
        `${label}: must name the field; got: ${text}`,
      );
      assert.match(
        text,
        /is required and must be a non-empty string/,
        `${label}: must use the requireString envelope; got: ${text}`,
      );
      const body = bodyOf(response);
      assertNoPhantomAgentId(body, label);
      assert.equal(
        typeof body.error === "string" && /not found/i.test(body.error),
        false,
        `${label}: must die at requireString, never the fleet-lookup "not found"; got: ${JSON.stringify(body)}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// T3 — named bug class: wrong-typed required strings must NEVER stringify
// ---------------------------------------------------------------------------

test("attach_agent refuses non-string shapes on fleet_id/role/prompt (stringified-lookup-key bug class)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const nonStringShapes: Array<{ label: string; v: unknown }> = [
      { label: "null", v: null },
      { label: "empty", v: "" },
      { label: "whitespace", v: "   " },
      { label: "number", v: 42 },
      { label: "boolean", v: false },
      { label: "array", v: ["x"] },
      { label: "object", v: { x: 1 } },
    ];
    const fields: Array<{ field: "fleet_id" | "role" | "prompt"; base: Record<string, unknown> }> = [
      { field: "fleet_id", base: { role: "r", prompt: "p" } },
      { field: "role", base: { fleet_id: "fleet-x", prompt: "p" } },
      { field: "prompt", base: { fleet_id: "fleet-x", role: "r" } },
    ];
    for (const { field, base } of fields) {
      for (const { label, v } of nonStringShapes) {
        const response = await client.callTool({
          name: "attach_agent",
          arguments: { ...base, [field]: v },
        });
        const caseLabel = `${field}=${label}`;
        assert.equal(
          (response as ToolResponse).isError,
          true,
          `${caseLabel}: must be isError; got: ${textOf(response)}`,
        );
        const text = textOf(response);
        assert.match(
          text,
          /attach_agent/,
          `${caseLabel}: must name the tool; got: ${text}`,
        );
        assert.match(
          text,
          new RegExp(`'${field}'`),
          `${caseLabel}: must name the field; got: ${text}`,
        );
        assert.doesNotMatch(
          text,
          /not found/i,
          `${caseLabel}: MUST NOT stringify into a legitimate-looking not-found (named bug class: requireString before modeForFleet/withLedger); got: ${text}`,
        );
        const body = bodyOf(response);
        assertNoPhantomAgentId(body, caseLabel);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// T4 — unknown fleet surfaces as jsonError "not found" AFTER the wire gate
// ---------------------------------------------------------------------------

test("attach_agent unknown fleet returns isError naming the fleet, never a phantom agent_id", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "attach_agent",
      arguments: honestArgs("fleet-that-does-not-exist-xyzzy"),
    });
    assert.equal(
      (response as ToolResponse).isError,
      true,
      `unknown fleet MUST return isError; got: ${textOf(response)}`,
    );
    const text = textOf(response);
    assert.match(
      text,
      /fleet-that-does-not-exist-xyzzy/,
      `error must name the fleet id; got: ${text}`,
    );
    assert.match(
      text,
      /not found/i,
      `error must use the "not found" class; got: ${text}`,
    );
    const body = bodyOf(response);
    assertNoPhantomAgentId(body, "unknown fleet");
  });
});

// ---------------------------------------------------------------------------
// T5 — sealed complete/failed refuse; abandoned reopens to running
// ---------------------------------------------------------------------------

test("attach_agent refuses complete/failed fleets and reopens abandoned to running", async () => {
  const fix = makeFixture();
  applyFixtureEnv(fix);
  seedFleetStatus("fleet-complete", "complete");
  seedFleetStatus("fleet-failed", "failed");
  seedFleetStatus("fleet-abandoned", "abandoned");
  seedFleetStatus("fleet-running", "running");
  await withChildServer(fix, async (client) => {
    for (const sealed of ["complete", "failed"] as const) {
      const fleetId = `fleet-${sealed}`;
      const response = await client.callTool({
        name: "attach_agent",
        arguments: honestArgs(fleetId),
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `${sealed}: must be isError; got: ${textOf(response)}`,
      );
      const text = textOf(response);
      assert.match(
        text,
        new RegExp(`Fleet ${fleetId} is ${sealed}, not running`),
        `${sealed}: sealed fleets must keep the "is \${status}, not running" envelope; got: ${text}`,
      );
      assertNoPhantomAgentId(bodyOf(response), sealed);
    }

    const abandoned = await client.callTool({
      name: "attach_agent",
      arguments: honestArgs("fleet-abandoned"),
    });
    assert.notEqual(
      (abandoned as ToolResponse).isError,
      true,
      `abandoned MUST succeed (ONLY in-place remedy); got: ${textOf(abandoned)}`,
    );
    const abandonedBody = bodyOf(abandoned);
    assert.equal(typeof abandonedBody.agent_id, "string");
    assert.equal(abandonedBody.fleet_id, "fleet-abandoned");
    assert.equal(abandonedBody.role, "replacement");
    assert.equal(abandonedBody.agent_file, null);
    assert.equal(
      abandonedBody.message,
      "Agent replacement attached to fleet fleet-abandoned",
    );
    const abandonedStatus = await client.callTool({
      name: "fleet_status",
      arguments: { fleet_id: "fleet-abandoned" },
    });
    assert.match(
      textOf(abandonedStatus),
      /"status":\s*"running"/,
      "abandoned fleet must be reopened to running",
    );

    const running = await client.callTool({
      name: "attach_agent",
      arguments: honestArgs("fleet-running"),
    });
    assert.notEqual(
      (running as ToolResponse).isError,
      true,
      `running MUST succeed; got: ${textOf(running)}`,
    );
    const runningBody = bodyOf(running);
    assert.equal(typeof runningBody.agent_id, "string");
    assert.equal(runningBody.fleet_id, "fleet-running");
    assert.equal(runningBody.role, "replacement");
    assert.equal(runningBody.agent_file, null);
    assert.equal(
      runningBody.message,
      "Agent replacement attached to fleet fleet-running",
    );
  });
});

// ---------------------------------------------------------------------------
// T6 — happy-path envelope + advertised-vs-handler phantom-key honesty
// ---------------------------------------------------------------------------

test("attach_agent happy path returns five-key envelope; phantom keys still reach the handler", async () => {
  const fix = makeFixture();
  applyFixtureEnv(fix);
  seedFleetStatus("fleet-happy", "running");
  await withChildServer(fix, async (client) => {
    const honest = await client.callTool({
      name: "attach_agent",
      arguments: honestArgs("fleet-happy"),
    });
    assert.notEqual(
      (honest as ToolResponse).isError,
      true,
      `honest attach MUST succeed; got: ${textOf(honest)}`,
    );
    const honestBody = bodyOf(honest);
    assert.deepEqual(
      Object.keys(honestBody).sort(),
      ["agent_file", "agent_id", "fleet_id", "message", "role"],
      `happy-path envelope must be exactly the five published keys; got: ${JSON.stringify(honestBody)}`,
    );
    assert.equal(typeof honestBody.agent_id, "string");
    assert.equal(honestBody.fleet_id, "fleet-happy");
    assert.equal(honestBody.role, "replacement");
    assert.equal(honestBody.agent_file, null);
    assert.equal(
      honestBody.message,
      "Agent replacement attached to fleet fleet-happy",
    );

    const phantom = await client.callTool({
      name: "attach_agent",
      arguments: {
        ...honestArgs("fleet-happy"),
        force: true,
        retry: 3,
        note: "for your eyes only",
      },
    });
    assert.notEqual(
      (phantom as ToolResponse).isError,
      true,
      `phantom keys must still reach the handler (additionalProperties is not advertised and not handler-enforced via requireAllowedKeys); got: ${textOf(phantom)}`,
    );
    const phantomBody = bodyOf(phantom);
    assert.equal(typeof phantomBody.agent_id, "string");
    assert.equal(phantomBody.fleet_id, "fleet-happy");
    assert.equal(phantomBody.role, "replacement");
    assert.equal(phantomBody.agent_file, null);
    for (const k of ["force", "retry", "note"]) {
      assert.equal(
        k in phantomBody,
        false,
        `phantom arg "${k}" MUST NOT leak into the response`,
      );
    }
    const phantomText = textOf(phantom);
    assert.doesNotMatch(
      phantomText,
      /additionalProperties|unknown (key|field|property)|not allowed/i,
      `phantom keys must NOT be refused as an additional-properties schema error; got: ${phantomText}`,
    );
  });
});

// ---------------------------------------------------------------------------
// T7 — source-string pin
// ---------------------------------------------------------------------------

test("attach_agent handler source pins requireString triad, abandoned reopen, five-key jsonResult, no requireAllowedKeys", () => {
  const source = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");
  assert.match(
    source,
    /toolHandlers\["attach_agent"\]/,
    "attach_agent must be a top-level toolHandlers entry",
  );
  assert.ok(
    source.includes("Attach an agent to a running fleet."),
    "attach_agent description must keep the running-fleet phrase",
  );
  assert.ok(
    source.includes("banks complete only when result_contract is ok"),
    "attach_agent description must keep the result-contract banking phrase",
  );

  const schemaMatch = source.match(
    /name: "attach_agent",[\s\S]*?inputSchema: \{([\s\S]*?)\},\s*annotations:/,
  );
  assert.ok(schemaMatch, "attach_agent inputSchema block must be found");
  const schemaBody = schemaMatch[1]!;
  assert.doesNotMatch(
    schemaBody,
    /additionalProperties/,
    "advertised schema must NOT declare additionalProperties — advertising false would be a lie (handler has no requireAllowedKeys)",
  );
  assert.match(
    schemaBody,
    /required: \["fleet_id", "role", "prompt"\]/,
    "advertised schema must require fleet_id, role, prompt",
  );

  const handlerMatch = source.match(
    /toolHandlers\["attach_agent"\] = async \(args\) => \{([\s\S]*?)\n\};\s*\n\s*toolHandlers\["ping"\]/,
  );
  assert.ok(
    handlerMatch,
    "attach_agent handler block must be found immediately before ping",
  );
  const handlerBody = handlerMatch[1]!;
  assert.match(
    handlerBody,
    /requireString\(\s*"attach_agent"\s*,\s*"fleet_id"/,
    "handler must requireString fleet_id",
  );
  assert.match(
    handlerBody,
    /requireString\(\s*"attach_agent"\s*,\s*"role"/,
    "handler must requireString role",
  );
  assert.match(
    handlerBody,
    /requireString\(\s*"attach_agent"\s*,\s*"prompt"/,
    "handler must requireString prompt",
  );
  assert.match(
    handlerBody,
    /agent === undefined \? null : requireString\(\s*"attach_agent"\s*,\s*"agent"/,
    "handler must requireString agent only when present (undefined is valid absence)",
  );
  assert.match(
    handlerBody,
    /optionalModelSelector\(\s*"attach_agent"\s*,\s*"model"/,
    "handler must optionalModelSelector model",
  );
  assert.match(
    handlerBody,
    /optionalBoolean\(\s*"attach_agent"\s*,\s*"expects_artifact"/,
    "handler must optionalBoolean expects_artifact",
  );
  assert.match(
    handlerBody,
    /trySpawn` is shared between spawn_fleet and attach_agent/,
    "handler comment must keep the shared-trySpawn / result-contract-flip rationale",
  );
  assert.match(
    handlerBody,
    /ONLY in-place path that reopens an `abandoned` fleet/,
    "handler comment must keep the ONLY-in-place-path rationale",
  );
  assert.match(
    handlerBody,
    /if \(badAttach\) return jsonError\(badAttach\)/,
    "handler must return jsonError on the first wire-boundary failure",
  );
  assert.match(
    handlerBody,
    /lifecycleCoordinator\.modeForFleet\(fleet_id\)/,
    "handler must consult lifecycleCoordinator.modeForFleet AFTER the wire gate",
  );
  assert.match(
    handlerBody,
    /if \(!fleet\) return \{ error: `Fleet \$\{fleet_id\} not found` \}/,
    "unknown-fleet jsonError must use the Fleet ${id} not found envelope",
  );
  assert.match(
    handlerBody,
    /if \(fleet\.status !== "running" && fleet\.status !== "abandoned"\)/,
    "handler must accept running OR abandoned and seal everything else",
  );
  assert.match(
    handlerBody,
    /Fleet \$\{fleet_id\} is \$\{fleet\.status\}, not running/,
    "sealed-status jsonError must keep the is ${status}, not running envelope",
  );
  assert.match(
    handlerBody,
    /const reopened = fleet\.status === "abandoned"/,
    "handler must detect abandoned reopen",
  );
  assert.match(
    handlerBody,
    /fleet\.status = "running"/,
    "reopen path must set fleet.status = running",
  );
  assert.match(
    handlerBody,
    /via: "attach_agent"/,
    "reopen event must name via: attach_agent",
  );
  assert.match(
    handlerBody,
    /trySpawn\(\{/,
    "legacy success path must call trySpawn after commit",
  );
  assert.match(
    handlerBody,
    /return jsonResult\(\{/,
    "success path must return jsonResult({...})",
  );
  for (const key of ["agent_id", "fleet_id", "role", "agent_file", "message"]) {
    assert.ok(
      handlerBody.includes(key),
      `attach_agent handler MUST include response key "${key}" in its jsonResult`,
    );
  }
  assert.doesNotMatch(
    handlerBody,
    /requireAllowedKeys/,
    "handler must NOT call requireAllowedKeys — additionalProperties is not advertised and not handler-enforced",
  );
  assert.doesNotMatch(
    handlerBody,
    /String\s*\(\s*fleet_id\s*\)/,
    "handler must NOT coerce fleet_id via String() — that is the stringified-lookup-key defect",
  );
});
