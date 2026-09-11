/**
 * The record_routing_outcome contract over real MCP stdio.
 *
 * This is the routing-feedback surface: an in-process Wilson-style adjustment
 * map that biases future route_work scores toward agents that have succeeded
 * (and away from agents that have not). It is NOT in the ledger — verify_ledger
 * cannot see it — so a wrong value here is invisible AND persistent for the
 * lifetime of the server process.
 *
 * Every guard here pins one behavior that a contract drift would break:
 *   1. advertised inputSchema is closed + required [agent_id, capability_key,
 *      success] + four annotations (idempotentHint:true, readOnlyHint:false,
 *      destructiveHint:false, openWorldHint:false); description pins the
 *      "in-process and resets when the server restarts" promise
 *   2. valid input returns the documented {ok:true, agent_id, capability_key,
 *      success} envelope — proves the handler records the outcome AND echoes
 *      every field that was admitted (no silent drops, no field reordering)
 *   3. required-field refusal (missing agent_id / capability_key / success)
 *      returns isError envelopes naming the offending field — proves the SDK
 *      does NOT enforce required so the gate is the handler's firstError +
 *      requireString + requireBoolean chain only
 *   4. agent_id and capability_key stringiness (empty / whitespace-only /
 *      numeric / null / array / object / boolean) all return isError envelopes
 *      naming the offending field — proves the cast_vote "blank name accepted
 *      because it was technically a string" hole does NOT apply here (the
 *      trim().length===0 guard in requireString closes it)
 *   5. success boolean-ness (numeric 0/1 / string "false"/"true" / null /
 *      object) all return isError envelopes with the explicit "Refusing to
 *      infer intent — a truthiness reading would treat 'false' as true and
 *      an omitted value as false" anti-footgun message — proves the exact
 *      cast_vote failure mode (which silently inverted "false" into a
 *      recorded approval) is NOT present here, because requireBoolean uses
 *      typeof === 'boolean' with NO truthiness fallback
 *   6. source-string pin: toolHandlers["record_routing_outcome"] at
 *      src/index.ts:2473-2491 (the handler body) EXACTLY requires all three
 *      fields, calls the recordRoutingOutcome feedback sink, and returns
 *      jsonResult. The advertised tool block is at src/index.ts:1471-1484
 *      recordRoutingOutcome, and returns jsonResult. A regression that
 *      bypassed the validator (e.g. dropping the requireBoolean call) would
 *      silently reintroduce the cast_vote footgun; a regression that
 *      omitted recordRoutingOutcome would lose the feedback signal AND
 *      return the success envelope anyway (silent green — exactly the class
 *      of failure mode this lane exists to prevent)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const textOf = (response: unknown): string =>
  (response as { content: Array<{ text: string }> }).content[0]!.text;
const parse = (response: unknown): Record<string, unknown> =>
  JSON.parse(textOf(response));

async function withServer(
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-record-routing-outcome-"));
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
  const client = new Client(
    { name: "record-routing-outcome-contract-test", version: "1.0.0" },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
    await fn(client);
  } finally {
    await client.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

// Tools-list helper — used by Test 1.
async function listTools(client: Client): Promise<
  Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  }>
> {
  const res = await client.listTools();
  return res.tools as Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  }>;
}

test("record_routing_outcome: advertised schema is closed + required [agent_id, capability_key, success] + four annotations + description pins the in-process promise", async () => {
  await withServer(async (client) => {
    const tools = await listTools(client);
    const tool = tools.find((t) => t.name === "record_routing_outcome");
    assert.ok(tool, "record_routing_outcome must be advertised by listTools");
    const schema = tool.inputSchema as {
      type: string;
      properties: Record<string, { type: string }>;
      required: string[];
    };
    assert.equal(schema.type, "object", "inputSchema root must be 'object'");
    assert.deepEqual(
      Object.keys(schema.properties).sort(),
      ["agent_id", "capability_key", "success"],
      "inputSchema must declare exactly [agent_id, capability_key, success]",
    );
    assert.equal(schema.properties.agent_id.type, "string", "agent_id must be string");
    assert.equal(
      schema.properties.capability_key.type,
      "string",
      "capability_key must be string",
    );
    assert.equal(schema.properties.success.type, "boolean", "success must be boolean");
    assert.deepEqual(
      schema.required,
      ["agent_id", "capability_key", "success"],
      "all three fields must be required",
    );
    assert.equal(
      tool.annotations?.idempotentHint,
      true,
      "idempotentHint must be true",
    );
    assert.equal(
      tool.annotations?.readOnlyHint,
      false,
      "readOnlyHint must be false (this side-effects the in-process adjustment)",
    );
    assert.equal(
      tool.annotations?.destructiveHint,
      false,
      "destructiveHint must be false (no ledger write)",
    );
    assert.equal(
      tool.annotations?.openWorldHint,
      false,
      "openWorldHint must be false (no external network)",
    );
    assert.match(
      tool.description ?? "",
      /in-process/i,
      "description must pin the in-process promise so a future port to a persistent store is a documented contract change",
    );
    assert.match(
      tool.description ?? "",
      /resets when the server restarts/i,
      "description must pin the resets-on-restart promise — that is the exact class of failure mode the lane exists to prevent (invisible, in-process state)",
    );
  });
});

test("record_routing_outcome: valid input returns the documented {ok:true, agent_id, capability_key, success} envelope", async () => {
  await withServer(async (client) => {
    const res = await client.callTool({
      name: "record_routing_outcome",
      arguments: {
        agent_id: "grk",
        capability_key: "adversarial-review",
        success: true,
      },
    });
    const envelope = parse(res);
    assert.equal(envelope.ok, true, "happy path must return ok:true");
    assert.equal(envelope.agent_id, "grk", "agent_id must echo back exactly");
    assert.equal(
      envelope.capability_key,
      "adversarial-review",
      "capability_key must echo back exactly",
    );
    assert.equal(envelope.success, true, "success must echo back exactly as a real boolean");

    // A second call with success=false must also be admitted and echoed —
    // proves the in-process map is the only signal, not the response shape.
    const res2 = await client.callTool({
      name: "record_routing_outcome",
      arguments: {
        agent_id: "grk",
        capability_key: "adversarial-review",
        success: false,
      },
    });
    const envelope2 = parse(res2);
    assert.equal(envelope2.ok, true);
    assert.equal(envelope2.success, false, "success=false must round-trip as a real boolean false");
    assert.equal(typeof envelope2.success, "boolean", "success must be JSON-boolean, not string 'false'");
  });
});

test("record_routing_outcome: missing required field returns isError envelope naming the offending field", async () => {
  await withServer(async (client) => {
    const cases = [
      { args: { capability_key: "review", success: true }, missing: "agent_id" },
      { args: { agent_id: "grk", success: true }, missing: "capability_key" },
      { args: { agent_id: "grk", capability_key: "review" }, missing: "success" },
    ];
    for (const { args, missing } of cases) {
      const res = await client.callTool({
        name: "record_routing_outcome",
        arguments: args,
      });
      const text = textOf(res);
      assert.ok(
        res.isError === true || /is required/i.test(text),
        `missing '${missing}' must produce an isError envelope (got isError=${res.isError}, text=${JSON.stringify(text)})`,
      );
      assert.match(
        text,
        new RegExp(`'${missing}'`),
        `error text must name the missing field '${missing}' (got ${JSON.stringify(text)})`,
      );
      assert.match(
        text,
        /record_routing_outcome/,
        "error text must name the offending tool so the caller can route the message",
      );
    }
  });
});

test("record_routing_outcome: agent_id and capability_key stringiness refusal — empty / whitespace / numeric / null / array / object / boolean all rejected", async () => {
  await withServer(async (client) => {
    const badValues: Array<{ value: unknown; label: string }> = [
      { value: "", label: "empty-string" },
      { value: "   ", label: "whitespace-only" },
      { value: 42, label: "numeric" },
      { value: null, label: "null" },
      { value: ["grk"], label: "array" },
      { value: { id: "grk" }, label: "object" },
      { value: true, label: "boolean" },
    ];
    for (const field of ["agent_id", "capability_key"] as const) {
      for (const { value, label } of badValues) {
        const args: Record<string, unknown> = {
          agent_id: "grk",
          capability_key: "review",
          success: true,
          [field]: value,
        };
        const res = await client.callTool({
          name: "record_routing_outcome",
          arguments: args,
        });
        const text = textOf(res);
        assert.ok(
          res.isError === true || /is required and must be a non-empty string/i.test(text),
          `${field}=${label} (${JSON.stringify(value)}) must produce an isError envelope (got isError=${res.isError}, text=${JSON.stringify(text)})`,
        );
        assert.match(
          text,
          new RegExp(`'${field}'`),
          `${field}=${label} error text must name the offending field (got ${JSON.stringify(text)})`,
        );
        assert.match(
          text,
          /non-empty string/i,
          `${field}=${label} error text must explain the expected type (got ${JSON.stringify(text)})`,
        );
      }
    }
  });
});

test("record_routing_outcome: success boolean-ness refusal — numeric / string / null / object rejected with the cast_vote anti-footgun message", async () => {
  await withServer(async (client) => {
    const badValues: Array<{ value: unknown; label: string }> = [
      { value: 0, label: "numeric-0" },
      { value: 1, label: "numeric-1" },
      { value: "true", label: "string-true" },
      { value: "false", label: "string-false" },
      { value: null, label: "null" },
      { value: {}, label: "object" },
      { value: [], label: "array" },
    ];
    for (const { value, label } of badValues) {
      const res = await client.callTool({
        name: "record_routing_outcome",
        arguments: {
          agent_id: "grk",
          capability_key: "review",
          success: value,
        },
      });
      const text = textOf(res);
      assert.ok(
        res.isError === true || /is required and must be a boolean/i.test(text),
        `success=${label} (${JSON.stringify(value)}) must produce an isError envelope (got isError=${res.isError}, text=${JSON.stringify(text)})`,
      );
      assert.match(
        text,
        /'success'/,
        `success=${label} error text must name the offending field (got ${JSON.stringify(text)})`,
      );
      assert.match(
        text,
        /Refusing to infer intent/i,
        `success=${label} error text must carry the explicit anti-footgun message — that is the exact wording that proves the cast_vote failure mode is NOT present here (got ${JSON.stringify(text)})`,
      );
      assert.match(
        text,
        /truthiness/i,
        `success=${label} error text must mention truthiness by name — proves the validator refuses the truthiness fallback (got ${JSON.stringify(text)})`,
      );
    }
  });
});

test("record_routing_outcome: source-string pin — toolHandlers['record_routing_outcome'] at src/index.ts:2473-2491 requires all three fields, calls recordRoutingOutcome, and returns jsonResult (no try/catch; the validator gate IS the only error path)", async () => {
  const src = readFileSync(join(repoRoot, "src", "index.ts"), "utf8");
  // Match the handler block from `toolHandlers["record_routing_outcome"]` up to
  // the next blank-line-terminated `};` so the regex is anchored to a single
  // handler body — this is the same pattern the other lens#1 tests use.
  const handlerMatch = src.match(
    /toolHandlers\["record_routing_outcome"\] = async \(args\) => \{[\s\S]*?\n\};/,
  );
  assert.ok(
    handlerMatch,
    "toolHandlers['record_routing_outcome'] handler block must exist at src/index.ts:2473-2491",
  );
  const body = handlerMatch[0];

  // Validator gate: every required field must be checked. Removing any one of
  // these would silently reintroduce the cast_vote failure mode. Each regex
  // is anchored to start-of-line (^[ \t]*) so a commented-out version of the
  // call (e.g. `// requireBoolean(...)`) does not satisfy the assertion —
  // this matters because the RED-on-revert test deliberately comments out
  // the requireBoolean call to prove the cast_vote footgun would otherwise
  // slip back in. Without the line anchor, a `// requireBoolean(...)`
  // comment is a free pass and Test 6 stays green on a regression.
  assert.match(
    body,
    /^[ \t]*requireString\(\s*"record_routing_outcome"\s*,\s*"agent_id"\s*,\s*agent_id\s*\)/m,
    "handler must requireString on agent_id",
  );
  assert.match(
    body,
    /^[ \t]*requireString\(\s*"record_routing_outcome"\s*,\s*"capability_key"\s*,\s*capability_key\s*\)/m,
    "handler must requireString on capability_key",
  );
  assert.match(
    body,
    /^[ \t]*requireBoolean\(\s*"record_routing_outcome"\s*,\s*"success"\s*,\s*success\s*\)/m,
    "handler must requireBoolean on success (the cast_vote footgun is closed HERE)",
  );

  // firstError + jsonError: proves the validator output is the single error
  // path. A regression that did `if (bad) throw bad` would escape as a
  // protocol-level fault instead of a tool-level isError envelope.
  assert.match(body, /^[ \t]*const bad = firstError\(/m, "handler must gate through firstError");
  assert.match(body, /^[ \t]*if \(bad\) return jsonError\(bad\)/m, "handler must return jsonError on validation failure (NOT throw)");

  // The feedback signal: recordRoutingOutcome MUST be called with all three
  // arguments. A regression that dropped this call would return {ok:true} but
  // never update the adjustment map — silent green.
  assert.match(
    body,
    /^[ \t]*recordRoutingOutcome\(\s*agent_id\s*,\s*capability_key\s*,\s*success\s*\)/m,
    "handler must call recordRoutingOutcome(agent_id, capability_key, success)",
  );

  // Return shape: jsonResult with the documented envelope — proves the field
  // echo contract (a regression that dropped `success` from the echo would
  // make the caller unable to confirm the recorded intent).
  assert.match(
    body,
    /^[ \t]*return jsonResult\(\{\s*ok:\s*true\s*,\s*agent_id\s*,\s*capability_key\s*,\s*success\s*\}\)/m,
    "handler must return jsonResult({ok:true, agent_id, capability_key, success})",
  );

  // No try/catch — recordRoutingOutcome is in-process and void; throwing is
  // not a documented contract. Pinning its absence catches a regression that
  // would wrap a non-throwing call in try/catch (noise) or, worse, would
  // convert validation errors into a transport fault.
  assert.ok(
    !/try\s*\{/.test(body),
    "handler must NOT have a try/catch block — validation is the only error path and recordRoutingOutcome is void",
  );

  // Position pin: the handler must sit at src/index.ts:2473 (per the comment
  // header). A future re-ordering of tool arrays must not silently drift the
  // handler position. We pin the LINE number, not the character offset —
  // src/index.ts is ~3093 lines today, so an L>3000 handler is drift.
  const idx = src.indexOf('toolHandlers["record_routing_outcome"] = async (args) => {');
  assert.ok(idx > 0, "handler position must be discoverable");
  const handlerLine = src.slice(0, idx).split("\n").length;
  assert.equal(
    handlerLine,
    2473,
    `handler must sit at src/index.ts:2473 (the position the comment header advertises), not at L${handlerLine}`,
  );
});
