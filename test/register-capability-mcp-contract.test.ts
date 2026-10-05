/**
 * register_capability MCP stdio contract — driven over real MCP stdio with the
 * tool's PUBLISHED field names.
 *
 * Why this test exists: rotating-lens #1 (GOAL-PROMPT.md L123-126;
 * ROADMAP-90D.md:20 Capability routing, advisory). `register_capability` is the
 * upstream WRITE surface every other capability-routing tool reads from — the
 * table `route_work` / `recommend_route` / `compile_route_candidates` /
 * `plan_speculative_backlog` / `record_routing_outcome` all consume. The
 * capability-routing group has only `recommend_route` (ep17 link 3) and
 * `compile_route_candidates` (ep17 link 4) stdio-pinned; `register_capability`,
 * `route_work` (DONE as t_f225b88e), `plan_speculative_backlog` (DONE as
 * t_4f0e6b65), `record_routing_outcome` (DONE as t_1da1685c) are the rest.
 *
 * Freshness: a `test/register-capability-mcp-contract.test.ts` is ABSENT from
 * the primary tree (git ls-files = none; working tree = none). The 2026-09-09
 * `feat/register-capability-mcp-contract` (345e9ee), its 2026-09-12 refresh
 * (4e96363), and the 2026-09-15 closed-input pin (603aec7) all exist only in
 * git history / side branches — every one of them is absent from the primary
 * tree. This card is the fresh single-tool pin.
 *
 * THE WRITE/MUTATION BOUNDARY (HANDOFF.md:111-114 vs the contrast in test 3):
 * `register_capability` is NOT a pure advisory projection. It mutates the
 * capability ledger (`data.capabilities[agentId] = {...}`, src/core.ts:1488-1497).
 * The advertised annotation set is therefore required to claim readOnlyHint:
 * false — advertising readOnlyHint:true would be a published lie. The test
 * pins the WRITE side directly: a successful call increments
 * `get_health.capabilities` from 0 to 1 (the observable the router consumes),
 * while the same call leaves `events`, `messages`, `fleets`, and `agents`
 * unchanged (no event log append — `registerCapability` does not call
 * `appendEvent`, src/core.ts:1423-1505). Contrast `recommend_route` (ep17 link
 * 3): must leave the ledger empty AND advertise readOnlyHint:true — different
 * tool, different boundary, both pinned here against `register_capability`.
 *
 * What is pinned (each invariant independently falsifiable, none redundant
 * with the other stdio contract files on HEAD):
 *
 *   1. advertised inputSchema VERBATIM — the full closed object: 5 properties
 *      exactly {agent_id, fleet_id, role, skills, model, context_window}
 *      (declared order: agent_id, fleet_id, role, skills, model, context_window);
 *      each id/role string carries `minLength: 1`; skills is array of string;
 *      model and context_window have NO `minLength` (they are optional);
 *      required exactly [agent_id, fleet_id, role, skills]; NO
 *      `additionalProperties` key (the schema is open on extras — see test 6
 *      for what that means in practice). Plus the four annotations by value
 *      and the EXACT description text.
 *   2. declared annotation ORDER against source — MEASURED: the SDK NORMALIZES
 *      the annotation key order on the wire to
 *      [readOnlyHint, destructiveHint, idempotentHint, openWorldHint], so the
 *      DECLARED order is pinned against the source, where it is meaningful
 *      (readOnlyHint:false must be the WRITE side's signature).
 *   3. WRITE/MUTATION boundary — a successful call returns
 *      `{ok:true, agent_id, fleet_id}` AND increments `get_health.capabilities`
 *      from 0 to 1 (the row register_capability really wrote). NO event log
 *      append (events count stays 0; events_log_bytes stays 0 — the tool does
 *      not call `appendEvent`). NO fleet/agent/message side effects. Contrast
 *      `recommend_route` (must leave ledger unchanged AND advertise
 *      readOnlyHint:true).
 *   4. refuse/wrong-type surface as MEASURED — the handler ONLY validates the two
 * optional fields (model: optionalNonBlankString, context_window: optionalNumber)
 * at the tool boundary; the four required fields are validated INSIDE
 * `_registerCapability` (src/core.ts:1423-1505) and any thrown Error becomes a
 * jsonError envelope at the handler. DEFECT NOTE: the card hypothesized
 * `requireString` / `requireFiniteInteger` / `requireStringArray` at the
 * handler, but MEASURED the handler calls ONLY `optionalNonBlankString` and
 * `optionalNumber` — every refusal message for the four required fields comes
 * from `_registerCapability`'s literal "register_capability: <field> is
 * required and must be ... (got <value>)" strings, NOT from
 * `requireString`/`requireStringArray`. The card hypothesis is wrong, not the
 * source.
 *   5. STRICT required + minLength enforcement — omitted `skills` (or any of
 *      the four required) returns a require-missing error, NOT a silent
 *      default; empty-string agent_id / fleet_id / role strings are refused
 *      at the validator, not silently accepted (the schema's `minLength: 1`
 *      and the validator's `isUsableAgentId` are the contract); the UNUSABLE
 *      id set {"", "null", "undefined", whitespace-only} is also refused.
 *      MEASURED: an empty `skills:[]` array IS accepted (the validator's
 *      `Array.isArray && every(typeof === "string")` is vacuously true for
 *      `[]`, and the schema has no `minItems`), so that case is NOT pinned as
 *      a refusal.
 *   6. DEFECT-DOCUMENTED phantom keys — the schema declares NO
 *      `additionalProperties:false`, and the handler's `firstError` check only
 *      covers `model` and `context_window`. So a phantom key at the top level
 *      is ACCEPTED and reaches the ledger untouched — pinned as measured
 *      (contrast `recommend_route`'s strict mode). The schema is honest about
 *      this by being silent, but a drift that adds `additionalProperties:
 *      false` without an enforcement path would be a real defect; this test
 *      pins the current tolerance.
 *   7. source-string pin — the advertised block at src/index.ts:919-937
 *      (the four-annotation literal `{ idempotentHint: true, readOnlyHint:
 *      false, destructiveHint: false, openWorldHint: false }` in DECLARED
 *      order, with the next tool `route_work` as the unique anchor) + the
 *      handler at src/index.ts:2383-2424 (the only handler-level validators
 *      are `optionalNonBlankString("register_capability", "model", model)`
 *      and `optionalNumber("register_capability", "context_window",
 *      context_window)`, then a try/catch around `registerCapability(...)`
 *      that maps any thrown Error to `jsonError(err.message)`).
 *
 * The SDK enforces neither `required` nor `type`; `toolHandlers` is typed
 * `(args: any)` (GOAL-PROMPT.md L123-126). Validation is the handler/validator's
 * job, which is exactly what tests 4–6 witness.
 *
 * No HANDOFF.md bump (focused-only, per the lane's cycle-4x precedent).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const srcIndexPath = join(repoRoot, "src", "index.ts");
const srcIndexSource = readFileSync(srcIndexPath, "utf8");

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
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-register-capability-contract-"));
  return {
    dir,
    dataFile: join(dir, "ledger.json"),
    dbFile: join(dir, "ledger.db"),
    eventsFile: join(dir, "events.jsonl"),
  };
}

const childEnv = (fix: Fixture): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  MESHFLEET_DB_FILE: fix.dbFile,
  MESHFLEET_DATA_FILE: fix.dataFile,
  MESHFLEET_EVENT_LOG_FILE: fix.eventsFile,
  MESHFLEET_RATIFY_SWEEP_MS: "0",
  AGENT_MESH_CHILD: "1",
});

async function connectChild(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(repoRoot, "src", "index.ts")],
    env,
    stderr: "ignore",
  });
  const client = new Client(
    { name: "register-capability-contract-test", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

async function withServer(
  fix: Fixture,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  process.env.MESHFLEET_DB_FILE = fix.dbFile;
  process.env.MESHFLEET_DATA_FILE = fix.dataFile;
  process.env.MESHFLEET_EVENT_LOG_FILE = fix.eventsFile;

  const client = await connectChild(childEnv(fix));
  try {
    await fn(client);
  } finally {
    await client.close().catch(() => {});
    rmSync(fix.dir, { recursive: true, force: true });
    delete process.env.MESHFLEET_DB_FILE;
    delete process.env.MESHFLEET_DATA_FILE;
    delete process.env.MESHFLEET_EVENT_LOG_FILE;
  }
}

/** The four annotations as declared at src/index.ts:936 — DECLARED ORDER. */
const REGISTER_CAPABILITY_ANNOTATIONS = {
  idempotentHint: true,
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

/** The verbatim published description at src/index.ts:920-921. */
const REGISTER_CAPABILITY_DESCRIPTION =
  "Register an agent's capabilities (role, skills, model) for routing.";

/** A minimal valid input for a fresh agent that has no prior agent row. */
const VALID_INPUT = () => ({
  agent_id: "fresh-agent-1",
  fleet_id: "fresh-fleet-1",
  role: "implementer",
  skills: ["reasoning", "summarization"],
});

async function callRegisterCapability(
  client: Client,
  args: unknown,
): Promise<ToolResponse> {
  return (await client.callTool({
    name: "register_capability",
    arguments: args as Record<string, unknown>,
  })) as unknown as ToolResponse;
}

// ============================================================
// 1. Advertised schema verbatim + four annotations by value + exact description.
// ============================================================

test("register_capability: advertised inputSchema is the closed required-shape with 6 properties + minLength on ids/role, four annotations by value, exact description", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "register_capability");
    assert.ok(tool, "register_capability must be advertised");

    const schema = tool!.inputSchema as Record<string, any>;

    // --- Top level shape (src/index.ts:922-935). ---
    assert.equal(schema.type, "object");
    // The schema does NOT advertise `additionalProperties: false` — phantom
    // top-level keys reach the handler untouched. Pinned honestly here; test 6
    // pins the runtime consequence.
    assert.equal(
      "additionalProperties" in schema,
      false,
      "register_capability schema must NOT advertise additionalProperties:false " +
        "(the handler does not enforce it — see test 6)",
    );
    assert.deepEqual(schema.required, ["agent_id", "fleet_id", "role", "skills"]);
    const properties = schema.properties as Record<string, any>;
    assert.deepEqual(
      Object.keys(properties),
      ["agent_id", "fleet_id", "role", "skills", "model", "context_window"],
      "top-level properties must be exactly {agent_id, fleet_id, role, skills, model, context_window} in declared order",
    );

    // --- The four required id/role fields all carry minLength: 1. ---
    for (const field of ["agent_id", "fleet_id", "role"]) {
      assert.equal(properties[field].type, "string", `${field} must be type:string`);
      assert.equal(
        properties[field].minLength,
        1,
        `${field} must advertise minLength:1 (the schema mirrors the validator's blank-rejection contract)`,
      );
    }

    // --- skills is array of string (no items-level minLength: the validator
    //     requires non-blank items via every(s => typeof s === "string" &&
    //     s.trim().length > 0), but the schema advertises only `items.type`).
    assert.equal(properties.skills.type, "array");
    assert.deepEqual(properties.skills.items, { type: "string" });

    // --- Optional fields: type declared, NO minLength. ---
    assert.equal(properties.model.type, "string");
    assert.ok(
      !("minLength" in properties.model),
      "model is optional — schema must NOT advertise minLength (the optional validator permits absence)",
    );
    assert.equal(properties.context_window.type, "number");
    assert.ok(
      !("minLength" in properties.context_window),
      "context_window is optional — schema must NOT advertise minLength",
    );

    // --- Four annotations by value; exactly four, no more. ---
    assert.deepEqual(tool!.annotations, REGISTER_CAPABILITY_ANNOTATIONS);
    assert.deepEqual(
      Object.keys(tool!.annotations ?? {}).sort(),
      ["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint"],
      "exactly the four annotations, no more and no fewer",
    );

    // --- The description is the published contract; a drift must be loud. ---
    assert.equal(
      tool!.description,
      REGISTER_CAPABILITY_DESCRIPTION,
      "the description is the published contract; a drift here must be loud",
    );
  });
});

// ============================================================
// 2. Declared annotation ORDER against source (wire order is normalized).
// ============================================================

test("register_capability: declared annotation order at src/index.ts:936 is idempotent/readOnly/destructive/openWorld (wire order is SDK-normalized)", async () => {
  // MEASURED: the client receives
  // [readOnlyHint, destructiveHint, idempotentHint, openWorldHint] regardless of
  // the declared order — the SDK normalizes annotation key order on the wire. So
  // the DECLARED order is pinned against the source, where it is load-bearing.
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "register_capability")!;
    assert.deepEqual(
      Object.keys(tool.annotations ?? {}),
      ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"],
      "MEASURED wire order is SDK-normalized — do not read intent from it",
    );
  });

  // The declared literal, in order, in the register_capability block of source.
  // Unique anchor: the annotation literal followed by the next tool entry's
  // `name: "route_work"` (the immediate next tool in the array — only one
  // literal of this exact shape is followed by `name: "route_work"`).
  const declared = srcIndexSource.match(
    /annotations: \{ idempotentHint: true, readOnlyHint: false, destructiveHint: false, openWorldHint: false \},\n    \},\n    \{\n      name: "route_work"/,
  );
  assert.ok(
    declared,
    "register_capability's annotation literal must precede route_work's tool entry (declared-order anchor)",
  );
  const declaredAnnotations = srcIndexSource.match(
    /name: "register_capability",[\s\S]*?annotations: \{[^}]*\},/,
  );
  assert.ok(declaredAnnotations, "register_capability block must carry an annotations literal");
  assert.match(
    declaredAnnotations[0]!,
    /annotations: \{ idempotentHint: true, readOnlyHint: false, destructiveHint: false, openWorldHint: false \},/,
    "declared annotation order must be idempotentHint, readOnlyHint, destructiveHint, openWorldHint",
  );
});

// ============================================================
// 3. WRITE/MUTATION boundary — capability row written; events/fleets/agents/messages unchanged.
// ============================================================

test("register_capability: successful call writes one capability row (capabilities count 0->1) and leaves events/fleets/agents/messages untouched", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    // --- Pre-call: ledger is empty. ---
    const preHealth = bodyOf(
      await client.callTool({ name: "get_health", arguments: {} }),
    );
    assert.equal(preHealth.capabilities, 0, "pre-call: capabilities must be 0");
    assert.equal(preHealth.events, 0, "pre-call: events must be 0");
    assert.equal(preHealth.messages, 0, "pre-call: messages must be 0");
    assert.equal(preHealth.fleets, 0, "pre-call: fleets must be 0");
    assert.equal(preHealth.agents, 0, "pre-call: agents must be 0");
    const preEventsBytes = existsSync(fix.eventsFile) ? statSync(fix.eventsFile).size : 0;
    assert.equal(preEventsBytes, 0, "pre-call: events log bytes must be 0");

    // --- The WRITE call. ---
    const response = await callRegisterCapability(client, VALID_INPUT());
    assert.notEqual(
      response.isError,
      true,
      `a well-formed call must succeed; got: ${textOf(response)}`,
    );
    const body = bodyOf(response);
    // The success envelope is exactly {ok:true, agent_id, fleet_id}
    // (src/index.ts:2423); no other top-level keys leak through.
    assert.equal(body.ok, true, "success envelope must carry ok:true");
    assert.equal(body.agent_id, "fresh-agent-1");
    assert.equal(body.fleet_id, "fresh-fleet-1");
    assert.deepEqual(
      Object.keys(body).sort(),
      ["agent_id", "fleet_id", "ok"],
      "success envelope must be EXACTLY {ok, agent_id, fleet_id} — no leakage from the stored row",
    );

    // --- Post-call: capabilities count is 1 (the row register_capability wrote).
    //     events/fleets/agents/messages counts unchanged. ---
    const postHealth = bodyOf(
      await client.callTool({ name: "get_health", arguments: {} }),
    );
    assert.equal(postHealth.capabilities, 1, "post-call: capabilities must be 1");
    assert.equal(postHealth.events, 0, "post-call: events must remain 0 (no event emission)");
    assert.equal(postHealth.messages, 0, "post-call: messages must remain 0");
    assert.equal(postHealth.fleets, 0, "post-call: fleets must remain 0");
    assert.equal(postHealth.agents, 0, "post-call: agents must remain 0");

    // --- No durable append to the event log. ---
    const postEventsBytes = existsSync(fix.eventsFile) ? statSync(fix.eventsFile).size : 0;
    assert.equal(postEventsBytes, 0, "register_capability must not append to the event log");
  });
});

// ============================================================
// 4. Refusal surface as MEASURED — handler calls ONLY optionalNonBlankString +
// optionalNumber; required-field errors come from _registerCapability's literals.
// ============================================================

test("register_capability: omitted-required and wrong-type inputs refuse with isError {error} envelopes (validators are NOT requireString/requireStringArray at the handler)", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const cases: ReadonlyArray<readonly [string, unknown, RegExp]> = [
      // ---- Required-field omissions (the validator lives inside
      //      _registerCapability; messages are literal "register_capability:
      //      <field> is required and must be ..."). ----
      [
        "omitted agent_id",
        { fleet_id: "f", role: "r", skills: ["s"] },
        /register_capability: agentId is required and must be a usable non-empty string/,
      ],
      [
        "omitted fleet_id",
        { agent_id: "a", role: "r", skills: ["s"] },
        /register_capability: fleetId is required and must be a non-empty string/,
      ],
      [
        "omitted role",
        { agent_id: "a", fleet_id: "f", skills: ["s"] },
        /register_capability: role is required and must be a non-empty string/,
      ],
      [
        "omitted skills",
        { agent_id: "a", fleet_id: "f", role: "r" },
        /register_capability: skills is required and must be an array of strings/,
      ],
      // ---- Required-field wrong types. ----
      [
        "agent_id wrong type (number)",
        { agent_id: 1, fleet_id: "f", role: "r", skills: ["s"] },
        /register_capability: agentId is required and must be a usable non-empty string/,
      ],
      [
        "fleet_id wrong type (number)",
        { agent_id: "a", fleet_id: 1, role: "r", skills: ["s"] },
        /register_capability: fleetId is required and must be a non-empty string/,
      ],
      [
        "role wrong type (number)",
        { agent_id: "a", fleet_id: "f", role: 1, skills: ["s"] },
        /register_capability: role is required and must be a non-empty string/,
      ],
      [
        "skills wrong type (string)",
        { agent_id: "a", fleet_id: "f", role: "r", skills: "summarization" },
        /register_capability: skills is required and must be an array of strings/,
      ],
      [
        "skills wrong element type (number)",
        { agent_id: "a", fleet_id: "f", role: "r", skills: [1, 2] },
        /register_capability: skills is required and must be an array of strings/,
      ],
      // ---- Optional wrong types (validators at the handler). ----
      [
        "model wrong type (number)",
        { ...VALID_INPUT(), model: 5 },
        /register_capability: 'model' must be a non-empty string when provided/,
      ],
      [
        "context_window wrong type (string)",
        { ...VALID_INPUT(), context_window: "big" },
        /register_capability: 'context_window' must be a finite number when provided/,
      ],
    ];

    for (const [label, args, expected] of cases) {
      const response = await callRegisterCapability(client, args);
      assert.equal(
        response.isError,
        true,
        `${label}: expected an isError envelope; got: ${textOf(response)}`,
      );
      const body = bodyOf(response);
      assert.equal(
        typeof body.error,
        "string",
        `${label}: the isError body must be a {"error": string} envelope`,
      );
      assert.match(
        body.error as string,
        expected,
        `${label}: refusal message must name the offending field`,
      );
    }

    // DEFECT NOTE: NO refusal message here originates from the validator named
    // `requireString` (which emits "is required and must be a non-empty
    // string") — those are owned by the handler's optional-validators only.
    // The required-field messages are literal "register_capability: <field> is
    // required and must be ..." strings from _registerCapability itself, not
    // the tool-args.ts requireString. The card hypothesis (requireString at
    // the handler) is wrong; this assertion documents the measured truth.
    const omittedSkills = await callRegisterCapability(client, {
      agent_id: "a",
      fleet_id: "f",
      role: "r",
    });
    const omittedSkillsBody = bodyOf(omittedSkills);
    assert.doesNotMatch(
      omittedSkillsBody.error as string,
      /^register_capability: 'skills' is required and must be a non-empty string/m,
      `MEASURED: required-field validator is _registerCapability, not requireString — the "is required and must be a non-empty string" phrase names a string field, but skills is an array`,
    );
  });
});

// ============================================================
// 5. STRICT required + minLength enforcement.
// ============================================================

test("register_capability: STRICT required + minLength:1 — empty strings, whitespace, and 'undefined'/'null' string ids refused at the validator", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const cases: ReadonlyArray<readonly [string, unknown, RegExp]> = [
      // --- agent_id: isUsableAgentId refuses "", "null", "undefined", and any
      //     whitespace-only / non-string shape. ---
      [
        "agent_id empty string",
        { agent_id: "", fleet_id: "f", role: "r", skills: ["s"] },
        /register_capability: agentId is required and must be a usable non-empty string/,
      ],
      [
        "agent_id whitespace only",
        { agent_id: "   ", fleet_id: "f", role: "r", skills: ["s"] },
        /register_capability: agentId is required and must be a usable non-empty string/,
      ],
      [
        "agent_id 'undefined' string (isUsableAgentId UNUSABLE_AGENT_IDS)",
        {
          agent_id: "undefined",
          fleet_id: "f",
          role: "r",
          skills: ["s"],
        },
        /register_capability: agentId is required and must be a usable non-empty string/,
      ],
      [
        "agent_id 'null' string (isUsableAgentId UNUSABLE_AGENT_IDS)",
        {
          agent_id: "null",
          fleet_id: "f",
          role: "r",
          skills: ["s"],
        },
        /register_capability: agentId is required and must be a usable non-empty string/,
      ],
      // --- fleet_id: trimmed-empty refused. ---
      [
        "fleet_id empty string",
        { agent_id: "a", fleet_id: "", role: "r", skills: ["s"] },
        /register_capability: fleetId is required and must be a non-empty string/,
      ],
      [
        "fleet_id whitespace only",
        { agent_id: "a", fleet_id: "   ", role: "r", skills: ["s"] },
        /register_capability: fleetId is required and must be a non-empty string/,
      ],
      // --- role: trimmed-empty refused. ---
      [
        "role empty string",
        { agent_id: "a", fleet_id: "f", role: "", skills: ["s"] },
        /register_capability: role is required and must be a non-empty string/,
      ],
      [
        "role whitespace only",
        { agent_id: "a", fleet_id: "f", role: "   ", skills: ["s"] },
        /register_capability: role is required and must be a non-empty string/,
      ],
      // --- skills: every element must be a string (the array-of-string check
      //     requires `typeof s === "string"`; an empty array passes vacuously,
      //     and a non-string element fails). ---
      [
        "skills with non-string element",
        { agent_id: "a", fleet_id: "f", role: "r", skills: ["ok", null] },
        /register_capability: skills is required and must be an array of strings/,
      ],
      // --- Optional fields: absent is fine; whitespace-only optionalNonBlankString refused. ---
      [
        "model whitespace only",
        { ...VALID_INPUT(), model: "   " },
        /register_capability: 'model' must be a non-empty string when provided/,
      ],
    ];

    for (const [label, args, expected] of cases) {
      const response = await callRegisterCapability(client, args);
      assert.equal(
        response.isError,
        true,
        `${label}: expected an isError envelope; got: ${textOf(response)}`,
      );
      const body = bodyOf(response);
      assert.match(
        body.error as string,
        expected,
        `${label}: refusal message must name the offending field and the trimmed-empty / UNUSABLE reason`,
      );
    }

    // Sanity: a well-formed call with required-only fields (no optional)
    // succeeds — proves the refusals above are field-targeted, not blanket.
    const okResponse = await callRegisterCapability(client, VALID_INPUT());
    assert.notEqual(okResponse.isError, true, "minimal valid input must succeed");
    assert.equal(bodyOf(okResponse).ok, true);
  });
});

// ============================================================
// 6. DEFECT-DOCUMENTED phantom keys — schema has no additionalProperties; the
// handler's firstError only checks model + context_window, so a phantom
// top-level key is ACCEPTED and reaches the ledger untouched.
// ============================================================

test("register_capability: TOLERANCE as MEASURED — schema has no additionalProperties and the handler's firstError only covers model + context_window, so phantom top-level keys are accepted (DEFECT-DOCUMENTED, NOT a defect here)", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    // --- A phantom top-level key alongside a valid payload is accepted —
    //     the schema's silence on additionalProperties is the published
    //     contract, and the handler does not enforce strict mode. The row
    //     still writes; the phantom key just doesn't reach the ledger. ---
    const phantomArgs = {
      ...VALID_INPUT(),
      unexpected_field: "should-be-ignored-by-handler-but-accepted-on-input",
    };
    const phantomResponse = await callRegisterCapability(client, phantomArgs);
    assert.notEqual(
      phantomResponse.isError,
      true,
      `MEASURED: a phantom top-level key is ACCEPTED (the schema is silent on additionalProperties); got: ${textOf(phantomResponse)}`,
    );
    assert.equal(bodyOf(phantomResponse).ok, true);

    // The row really did write — capabilities count is now 1, not 0. A
    // tightening of the schema (additionalProperties:false) without a handler
    // update would still pass this count, which is why test 1's schema pin and
    // test 7's source-string pin are what catch that drift.
    const health = bodyOf(
      await client.callTool({ name: "get_health", arguments: {} }),
    );
    assert.equal(health.capabilities, 1, "phantom-keyed call must still write the row");

    // --- Contrast with `model`/`context_window`: those are validated at the
    //     handler and a wrong type IS refused even though the schema is silent
    //     on additionalProperties. The validator lives in tool-args.ts, not in
    //     the schema, so the wire field names + value types matter. ---
    const wrongModel = await callRegisterCapability(client, {
      ...VALID_INPUT(),
      model: 5,
    });
    assert.equal(wrongModel.isError, true, "model wrong type IS refused (handler-level validator)");
    assert.match(
      bodyOf(wrongModel).error as string,
      /register_capability: 'model' must be a non-empty string when provided/,
    );
  });
});

// ============================================================
// 7. source-string pin — handler validates only model + context_window, then
// try/catch maps registerCapability Errors to jsonError envelopes.
// ============================================================

test("register_capability: source-string pin — handler calls ONLY optionalNonBlankString(model) + optionalNumber(context_window), then try/catch maps thrown Errors to jsonError", async () => {
  const handlerMatch = srcIndexSource.match(
    /toolHandlers\["register_capability"\][\s\S]*?\n\};/,
  );
  assert.ok(handlerMatch, "register_capability handler block must be present");
  const block = handlerMatch[0];

  // --- The two and ONLY two validators at the handler boundary. ---
  assert.match(
    block,
    /optionalNonBlankString\(\s*"register_capability",\s*"model",\s*model\s*\)/,
    "handler must call optionalNonBlankString on model",
  );
  assert.match(
    block,
    /optionalNumber\(\s*"register_capability",\s*"context_window",\s*context_window\s*\)/,
    "handler must call optionalNumber on context_window",
  );

  // --- The four required fields are validated in closeDb's neighbour:
  //     registerCapability -> withLedger -> _registerCapability, which throws
  //     Error objects the try/catch turns into jsonError(err.message). ---
  assert.match(
    block,
    /catch\s*\(\s*err\s*\)\s*\{\s*return jsonError\(err instanceof Error \? err\.message : String\(err\)\);?\s*\}/,
    "handler must catch thrown Errors and map them to jsonError",
  );

  // --- The success envelope is exactly {ok:true, agent_id, fleet_id}. ---
  assert.match(
    block,
    /return jsonResult\(\{\s*ok:\s*true,\s*agent_id,\s*fleet_id\s*\}\);/,
    "success envelope must be exactly {ok:true, agent_id, fleet_id}",
  );

  // --- The handler MUST NOT call requireString / requireStringArray /
  //     requireFiniteInteger on any required field — those would shadow the
  //     validator in _registerCapability and change the wire refusal shape.
  //     (The card hypothesis names those three validators at the handler;
  //     measured truth: only optionalNonBlankString + optionalNumber are
  //     called at the handler boundary.) ---
  assert.doesNotMatch(
    block,
    /requireString\(\s*"register_capability"\s*,/,
    "MEASURED: register_capability handler does NOT call requireString (the required-field validator lives in _registerCapability)",
  );
  assert.doesNotMatch(
    block,
    /requireStringArray\(\s*"register_capability"\s*,/,
    "MEASURED: register_capability handler does NOT call requireStringArray (the required-field validator lives in _registerCapability)",
  );
  assert.doesNotMatch(
    block,
    /requireFiniteInteger\(\s*"register_capability"\s*,/,
    "MEASURED: register_capability handler does NOT call requireFiniteInteger",
  );

  // --- The handler MUST NOT advertise a checkRateLimit call: register_capability
  //     shares the global:write bucket if any (MEASURED: it does not — the
  //     routing/registration surface is unbounded; the assertion documents the
  //     shape, not a defect). ---
  assert.ok(
    !block.includes("checkRateLimit"),
    "register_capability must not consume the shared global:write rate-limit bucket (MEASURED absence)",
  );

  // --- The advertised block pin (src/index.ts:919-937). ---
  const advertisedMatch = srcIndexSource.match(
    /name: "register_capability",[\s\S]*?annotations: \{[^}]*\},\n    \},/,
  );
  assert.ok(advertisedMatch, "register_capability advertised block must be present");
  const advertised = advertisedMatch[0];
  assert.match(
    advertised,
    /name: "register_capability",/,
    "advertised block must name register_capability",
  );
  assert.match(
    advertised,
    /description:\s*\n\s*"Register an agent's capabilities \(role, skills, model\) for routing\."/,
    "advertised block must carry the verbatim description literal",
  );
  assert.match(
    advertised,
    /required:\s*\[\s*"agent_id",\s*"fleet_id",\s*"role",\s*"skills"\s*\]/,
    "advertised block must declare required exactly [agent_id, fleet_id, role, skills]",
  );
  assert.match(
    advertised,
    /minLength:\s*1/,
    "advertised block must advertise minLength:1 on id/role fields",
  );
  assert.match(
    advertised,
    /context_window:\s*\{\s*type:\s*"number"\s*\}/,
    "advertised block must declare context_window as type:number",
  );

  // --- The four-annotation literal, in DECLARED order. ---
  assert.match(
    advertised,
    /annotations: \{ idempotentHint: true, readOnlyHint: false, destructiveHint: false, openWorldHint: false \},/,
    "declared annotation literal must be idempotent/readOnly/destructive/openWorld (declared order)",
  );
});