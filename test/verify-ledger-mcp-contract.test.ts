/**
 * verify_ledger MCP contract — driven over real MCP stdio with the
 * tool's PUBLISHED field names.
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `verify_ledger` is the operator-facing
 * ledger-integrity audit surface (src/index.ts advertised schema at L867-L879 +
 * handler at toolHandlers["verify_ledger"] L2304-L2306 on origin/main
 * 8433dcb8). It is published. This card is a fresh origin/main pin with the
 * 2026-09-12 honesty pattern:
 *
 *   1. advertised schema pin — {type:object, properties:{}} with NO
 *      required array and NO additionalProperties key (advertising false
 *      would be a lie; handler takes no args and has no
 *      requireAllowedKeys) + annotations {readOnlyHint:true,
 *      idempotentHint:true, destructiveHint:false, openWorldHint:false}
 *      + description names "Audit the ledger's internal consistency" and
 *      the SCOPE boundary ("ok=true means CONSISTENT, not AUTHENTIC").
 *   2. empty-ledger call returns the VerifyReport body EXACTLY — {ok,
 *      scope, errors, warnings, counts, findings} with ok:true,
 *      errors:0, warnings:0, all counts 0, findings:[], and the scope
 *      carrying the covers/excludes honesty boundary. No isError/ok
 *      envelope wraps it.
 *   3. seeded-ledger call returns a VerifyReport where counts reflect
 *      the seeded data (fleets:1, agents:1), ok:true, no findings.
 *   4. scope boundary honesty — the scope.covers says "internal
 *      consistency" and scope.excludes says "no hash chain or
 *      signature", pinning the honesty contract that ok=true means
 *      CONSISTENT not AUTHENTIC. The description must also carry this
 *      boundary.
 *   5. two back-to-back calls return identical VerifyReports
 *      (idempotentHint honored).
 *   6. advertised-vs-handler honesty — phantom top-level keys
 *      (phantom_filter/debug_emit/future_field/force/nested/note) are
 *      silently ignored (handler takes NO args) AND no phantom keys
 *      leak into the response. This is HONEST: additionalProperties is
 *      not advertised, handler does not enforce it, and handler does not
 *      even read args.
 *   7. source-string pin — handler is `async () => {
 *      return jsonResult(verifyLedger()); }` with NO args destructure,
 *      NO try/catch (unlike verify_ledger_v2/v3 which deliberately
 *      catch), NO checkRateLimit (unlike fleet_status/list_fleets),
 *      NO requireString/requireAllowedKeys,
 *      NO spawnFleet/wakeAgent/sendMessage/fetch, registered exactly
 *      once. VerifyReport interface at src/verify.ts pins the six
 *      fields (ok, scope, errors, warnings, counts, findings) +
 *      VERIFY_SCOPE constant pins the covers/excludes boundary.
 *
 * Each invariant is independently falsifiable. The SDK enforces neither
 * `required` nor `type`; toolHandlers is typed `(args: any)`.
 *
 * No published-figure bump. HANDOFF.md is not edited.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  createFleet,
  registerAgentInLedger,
  type Agent,
} from "../src/core.js";
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
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-verify-ledger-mcp-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: `meshfleet-verify-ledger-${dir}`,
      private: true,
      version: "1.0.0",
    }) + "\n",
  );
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

const childEnv = (fix: Fixture): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  MESHFLEET_DB_FILE: fix.dbFile,
  MESHFLEET_DATA_FILE: fix.dataFile,
  MESHFLEET_EVENT_LOG_FILE: fix.eventsFile,
  MESHFLEET_RATIFY_SWEEP_MS: "0",
  AGENT_MESH_CHILD: "1",
  HOME: fix.dir,
});

async function connectChild(fix: Fixture): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs"),
      join(repoRoot, "src", "index.ts"),
    ],
    cwd: fix.dir,
    env: childEnv(fix),
    stderr: "ignore",
  });
  const client = new Client(
    { name: "verify-ledger-contract-test", version: "1.0.0" },
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

/** Child-mode: recovery, sweeper, and SSE skipped. HOME+cwd isolated. */
async function withChildServer(
  fix: Fixture,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  applyFixtureEnv(fix);
  const client = await connectChild(fix);
  try {
    await fn(client);
  } finally {
    await client.close().catch(() => {});
    await cleanupFix(fix);
  }
}

const VERIFY_LEDGER_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const fixtureAgent = (id: string, fleetId: string): Agent => ({
  id,
  fleet_id: fleetId,
  role: `${id}-role`,
  prompt: `${id}-prompt`,
  status: "running",
});

function extractHandlerBlock(src: string): string {
  const match = src.match(/toolHandlers\["verify_ledger"\][\s\S]*?^};/m);
  assert.ok(match, "verify_ledger handler block must be extractable");
  return match[0];
}

function extractSchemaBlock(src: string): { schema: string; annotations: string; description: string } {
  const start = src.indexOf('name: "verify_ledger"');
  assert.notEqual(start, -1, "advertised verify_ledger schema block must be extractable");
  // Large window: the description is long (covers the SCOPE boundary).
  const window = src.slice(start, start + 2000);
  const schemaStart = window.indexOf("inputSchema:");
  const annotationsStart = window.indexOf("annotations:");
  assert.ok(schemaStart >= 0 && annotationsStart > schemaStart, "inputSchema + annotations must follow name");
  const schema = window.slice(schemaStart, annotationsStart);
  const descEnd = schemaStart;
  const description = window.slice(start, descEnd);
  const annotations = window.slice(annotationsStart, annotationsStart + 220);
  return { schema, annotations, description };
}

async function callOk(
  client: Client,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await client.callTool({ name: "verify_ledger", arguments: args });
  assert.notEqual(
    (response as ToolResponse).isError,
    true,
    `verify_ledger must succeed; got: ${textOf(response)}`,
  );
  return bodyOf(response);
}

// ─── Test 1: advertised schema + annotations + description honesty ───

test("verify_ledger: advertised schema is empty object with no required/additionalProperties, four annotations, description names Audit + CONSISTENT-not-AUTHENTIC boundary", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "verify_ledger");
    assert.ok(tool, "verify_ledger must be advertised");

    assert.deepEqual(tool!.inputSchema, {
      type: "object",
      properties: {},
    });
    // Honesty: handler takes no args and has no requireAllowedKeys.
    // Advertising additionalProperties:false would be a lie.
    assert.equal(
      "additionalProperties" in tool!.inputSchema,
      false,
      "additionalProperties must be ABSENT — handler never reads args; advertising false would be a lie",
    );
    // No required array: handler takes no args.
    assert.equal(
      "required" in tool!.inputSchema,
      false,
      "required must be ABSENT — handler takes no args",
    );

    assert.deepEqual(tool!.annotations, VERIFY_LEDGER_ANNOTATIONS);

    const desc = tool!.description ?? "";
    assert.match(desc, /Audit the ledger's internal consistency/i);
    assert.match(desc, /CONSISTENT/i, "description must state ok=true means CONSISTENT");
    assert.match(desc, /AUTHENTIC/i, "description must state ok=true does NOT mean AUTHENTIC");
    assert.match(desc, /no hash chain or signature/i, "description must state there is no hash chain or signature");
    // The description uses "rewrites" inside the honesty boundary ("an edit
    // that rewrites the ledger consistently") — that is explaining the
    // LIMITATION, not claiming a write capability. Only flag capability words.
    assert.doesNotMatch(
      desc,
      /\b(mutate|delete|spawn)\b/i,
      "read-only verify description must not claim a write capability",
    );
  });
});

// ─── Test 2: empty-ledger returns the VerifyReport body with ok:true ───

test("verify_ledger: empty ledger returns VerifyReport {ok, scope, errors, warnings, counts, findings} with ok:true, all counts 0, findings []", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const result = await callOk(client, {});

    // VerifyReport six fields present.
    assert.equal(result.ok, true, "empty ledger must verify ok:true");
    assert.equal(result.errors, 0);
    assert.equal(result.warnings, 0);

    const counts = result.counts as Record<string, unknown>;
    assert.equal(counts.fleets, 0);
    assert.equal(counts.agents, 0);
    assert.equal(counts.messages, 0);
    assert.equal(counts.receipts, 0);
    assert.equal(counts.ratifications, 0);

    assert.deepEqual(result.findings, []);

    // scope honesty boundary present.
    const scope = result.scope as Record<string, unknown>;
    assert.ok(typeof scope.covers === "string" && scope.covers.length > 0);
    assert.ok(typeof scope.excludes === "string" && scope.excludes.length > 0);

    // No envelope wrappers — the VerifyReport IS the response.
    assert.equal(result.isError, undefined, "must not carry isError at top level");
    assert.equal((result as Record<string, unknown>).error, undefined, "must not carry error at top level");
    assert.equal((result as Record<string, unknown>).status, undefined, "must not carry status at top level");

    // Exactly the six VerifyReport keys.
    const expectedKeys = ["ok", "scope", "errors", "warnings", "counts", "findings"];
    const actualKeys = Object.keys(result).sort();
    assert.deepEqual(
      actualKeys,
      [...expectedKeys].sort(),
      `response must be exactly the VerifyReport shape; got: ${actualKeys.join(",")}`,
    );
  });
});

// ─── Test 3: seeded ledger returns VerifyReport with populated counts ───

test("verify_ledger: seeded ledger returns VerifyReport with counts reflecting seeded data (fleets:1, agents:1), ok:true, no findings", async () => {
  const fix = makeFixture();
  applyFixtureEnv(fix);
  createFleet("verify-seed-fleet");
  registerAgentInLedger(fixtureAgent("verify-seed-agent", "verify-seed-fleet"));

  await withChildServer(fix, async (client) => {
    const result = await callOk(client, {});

    assert.equal(result.ok, true, "seeded clean ledger must verify ok:true");
    assert.equal(result.errors, 0);
    assert.equal(result.warnings, 0);
    assert.deepEqual(result.findings, []);

    const counts = result.counts as Record<string, unknown>;
    assert.equal(counts.fleets, 1, "one fleet seeded");
    assert.equal(counts.agents, 1, "one agent seeded");
    assert.equal(counts.messages, 0, "no messages seeded");
    assert.equal(counts.receipts, 0, "no receipts seeded");
    assert.equal(counts.ratifications, 0, "no ratifications seeded");
  });
});

// ─── Test 4: scope boundary honesty — CONSISTENT not AUTHENTIC ───

test("verify_ledger: scope.covers says 'internal consistency' and scope.excludes says 'no hash chain or signature', pinning the honesty boundary", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const result = await callOk(client, {});
    const scope = result.scope as Record<string, unknown>;

    assert.match(
      String(scope.covers),
      /internal consistency/i,
      "scope.covers must say 'internal consistency'",
    );
    assert.match(
      String(scope.excludes),
      /no hash chain or signature/i,
      "scope.excludes must say 'no hash chain or signature'",
    );
    assert.match(
      String(scope.excludes),
      /indistinguishable from honest history/i,
      "scope.excludes must say 'indistinguishable from honest history'",
    );

    // Cross-check: the same boundary is in the advertised description.
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "verify_ledger");
    assert.ok(tool, "verify_ledger must be advertised");
    const desc = tool!.description ?? "";
    assert.match(desc, /ok=true means CONSISTENT, not AUTHENTIC/i);
    assert.match(desc, /no hash chain or signature/i);
  });
});

// ─── Test 5: two back-to-back calls are identical (idempotentHint) ───

test("verify_ledger: two back-to-back calls return identical VerifyReports (idempotentHint)", async () => {
  const fix = makeFixture();
  applyFixtureEnv(fix);
  createFleet("idempotent-verify-fleet");
  registerAgentInLedger(fixtureAgent("idempotent-verify-agent", "idempotent-verify-fleet"));

  await withChildServer(fix, async (client) => {
    const first = await callOk(client, {});
    const second = await callOk(client, {});
    assert.deepEqual(
      first,
      second,
      "two quiet verify_ledger calls must return identical reports (idempotentHint)",
    );
    assert.equal(first.ok, true);
    assert.equal((first.counts as Record<string, unknown>).fleets, 1);
    assert.equal((first.counts as Record<string, unknown>).agents, 1);
  });
});

// ─── Test 6: phantom extra keys silently ignored (honesty) ───

test("verify_ledger: phantom extra keys are silently ignored (handler takes no args; additionalProperties not advertised, not enforced)", async () => {
  const fix = makeFixture();
  applyFixtureEnv(fix);
  createFleet("phantom-verify-fleet");

  await withChildServer(fix, async (client) => {
    const result = await callOk(client, {
      phantom_filter: "ignored",
      debug_emit: true,
      future_field: 42,
      force: "yes",
      nested: { a: 1 },
      note: "should be ignored",
    });

    assert.equal(result.ok, true);
    assert.equal(result.phantom_filter, undefined);
    assert.equal(result.debug_emit, undefined);
    assert.equal(result.future_field, undefined);
    assert.equal(result.force, undefined);
    assert.equal(result.nested, undefined);
    assert.equal(result.note, undefined);

    // Exactly the six VerifyReport keys — no phantom leaks.
    const expectedKeys = ["ok", "scope", "errors", "warnings", "counts", "findings"];
    const actualKeys = Object.keys(result).sort();
    assert.deepEqual(
      actualKeys,
      [...expectedKeys].sort(),
      `phantom keys must NOT leak into the response; got: ${actualKeys.join(",")}`,
    );

    assert.equal((result.counts as Record<string, unknown>).fleets, 1, "seeded fleet must be counted");
  });
});

// ─── Test 7: source-string pin ───

test("verify_ledger: source-string pin — async () => jsonResult(verifyLedger()), no args/try-catch/checkRateLimit/requireString/allowedKeys/spawn", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const src = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");

    const registrations = src.match(/toolHandlers\["verify_ledger"\]/g) ?? [];
    assert.equal(
      registrations.length,
      1,
      `handler must be registered exactly once; got ${registrations.length}`,
    );

    const handlerBlock = extractHandlerBlock(src);

    // Handler takes NO args — bare async () =>.
    assert.match(
      handlerBlock,
      /toolHandlers\["verify_ledger"\]\s*=\s*async\s*\(\s*\)\s*=>\s*\{/,
      "handler must be async () => { (no args parameter)",
    );

    // Body is a single return jsonResult(verifyLedger()).
    assert.match(
      handlerBlock,
      /return\s+jsonResult\s*\(\s*verifyLedger\s*\(\s*\)\s*\)\s*;/,
      "handler must return jsonResult(verifyLedger())",
    );

    // NEGATIVE assertions — things this handler must NOT have.
    assert.doesNotMatch(
      handlerBlock,
      /\bargs\b/,
      "handler must NOT reference args (takes none)",
    );
    assert.doesNotMatch(
      handlerBlock,
      /\btry\s*\{/,
      "handler must NOT wrap its body in try/catch (unlike v2/v3 which deliberately catch)",
    );
    assert.doesNotMatch(
      handlerBlock,
      /checkRateLimit/,
      "handler must NOT have a rate-limit gate (unlike fleet_status/list_fleets)",
    );
    assert.doesNotMatch(
      handlerBlock,
      /requireString|requireAllowedKeys|requireNumber|requireBoolean/,
      "handler must NOT validate args (takes none)",
    );
    assert.doesNotMatch(
      handlerBlock,
      /spawnFleet|wakeAgent|sendMessage|fetch\(/,
      "handler must NOT call write/spawn primitives",
    );
    assert.doesNotMatch(
      handlerBlock,
      /verifyLedgerFile|resolveDbFile|buildVerifyEnvelope/,
      "handler must NOT use file-snapshot path (that is v2/v3; verify_ledger uses the live handle)",
    );

    // Advertised schema block.
    const { schema, annotations } = extractSchemaBlock(src);
    assert.match(schema, /type:\s*"object"/);
    assert.match(schema, /properties:\s*\{\s*\}/, "schema properties must be empty object");
    assert.doesNotMatch(
      schema,
      /additionalProperties/,
      "advertised schema must NOT carry additionalProperties (handler does not enforce it)",
    );
    assert.doesNotMatch(
      schema,
      /required/,
      "advertised schema must NOT carry required (handler takes no args)",
    );
    assert.match(annotations, /readOnlyHint:\s*true/);
    assert.match(annotations, /idempotentHint:\s*true/);
    assert.match(annotations, /destructiveHint:\s*false/);
    assert.match(annotations, /openWorldHint:\s*false/);

    // VerifyReport interface at src/verify.ts pins the six fields.
    const verifySrc = readFileSync(join(repoRoot, "src", "verify.ts"), "utf-8");
    const ifaceStart = verifySrc.indexOf("export interface VerifyReport {");
    assert.notEqual(ifaceStart, -1, "src/verify.ts must export interface VerifyReport");
    const window = verifySrc.slice(ifaceStart, ifaceStart + 1200);
    const blockEnd = window.indexOf("\nexport ");
    const block = blockEnd === -1 ? window : window.slice(0, blockEnd);
    for (const field of ["ok", "scope", "errors", "warnings", "counts", "findings"]) {
      const present = block.includes(`${field}:`) || block.includes(`${field}?:`);
      assert.ok(
        present,
        `VerifyReport interface MUST define \`${field}:\`; block:\n${block.slice(0, 400)}`,
      );
    }

    // VERIFY_SCOPE constant pins the covers/excludes boundary.
    assert.match(
      verifySrc,
      /covers:\s*"internal consistency/i,
      "VERIFY_SCOPE.covers must say 'internal consistency'",
    );
    assert.match(
      verifySrc,
      /excludes:\s*"authenticity.*no hash chain or signature/i,
      "VERIFY_SCOPE.excludes must say 'authenticity — no hash chain or signature'",
    );

    // Functional confirmation: the live call still works.
    const response = await client.callTool({ name: "verify_ledger", arguments: {} });
    const body = bodyOf(response);
    assert.equal(body.ok, true);
    assert.deepEqual(body.findings, []);
  });
});