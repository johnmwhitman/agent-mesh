/**
 * Dogfood regression: the routing tool errors must let a first-time caller
 * construct a valid call from the error text alone.
 *
 * The Claude conductor session that surfaced this defect tried
 *   { kind, description, requires_tools },
 *   { description, traits },
 *   { traits }
 * against MCP `recommend_route` and `compile_route_candidates`, and every
 * attempt was rejected with an error that named the offending key but never
 * the allowed keys. Each round forced a guess — the canonical shape of a
 * useless error.
 *
 * This test exercises the actual MCP handler `recommend_route` /
 * `compile_route_candidates` error path, parses the list of allowed keys out
 * of the message, and uses only those keys to construct a call that the
 * server accepts. No external test fixtures, no schema lookup, no reading the
 * source. The error text is the contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ROUTE_CANDIDATE_COMPILER_VERSION,
  compileRouteCandidates,
  type CompileRouteCandidatesInput,
} from "../src/compile-route-candidates.js";
import { recommendRoute } from "../src/recommend-route.js";

/**
 * Pull the comma-separated "allowed keys are: a, b, c" suffix out of an error
 * message produced by the routing validators. The validators always emit
 *   "<prefix> is not allowed; allowed keys are: <comma list>"
 * so this is a stable contract, not a guess.
 */
const parseAllowedKeys = (message: string): string[] => {
  // Case-insensitive: tool descriptions and runtime errors use slightly
  // different capitalisation ("Allowed top-level keys are:" vs
  // "allowed keys are:") but the trailing colon-comma list is the same shape
  // in both places, so a single parser must accept either surface.
  const lower = message.toLowerCase();
  const marker = "allowed keys are: ";
  const index = lower.indexOf(marker);
  assert.ok(index >= 0, `error message must enumerate allowed keys: ${message}`);
  return message
    .slice(index + marker.length)
    .split(",")
    .map((key) => key.trim())
    // Allowed keys are single lowercase tokens (e.g. "task", "top_n"). Anything
    // containing whitespace is a sentence fragment that bled into the list
    // after the trailing period; drop it.
    .filter((key) => key.length > 0 && !/\s/.test(key) && /[a-z0-9_]/.test(key));
};

/**
 * Strip the trailing parenthetical reminder ("(recommendation never executes
 * or wakes agents)") so the rest of the message is just the schema.
 */
const stripParenthetical = (message: string): string =>
  message.replace(/\s*\([^)]*\)\s*$/, "");

const minimalCandidate = {
  candidate_id: "lane-grk",
  capabilities: ["code"],
  privacy: "network_ok",
  locality: "any",
};

const minimalObservation = {
  candidate_id: "lane-grk",
  status: "green",
  confidence: "measured",
  budget: { used: 1, total: 100 },
};

const validManifest = {
  version: ROUTE_CANDIDATE_COMPILER_VERSION,
  candidates: [minimalCandidate],
};

const validObservations = [minimalObservation];

test("in-library: recommend_route errors enumerate the allowed top-level keys", () => {
  const attempts: Array<{ name: string; input: Record<string, unknown> }> = [
    { name: "kind/description/requires_tools", input: { kind: "x", description: "y", requires_tools: ["z"] } },
    { name: "description/traits", input: { description: "y", traits: ["z"] } },
    { name: "traits-only", input: { traits: ["z"] } },
    { name: "kind-only", input: { kind: "x" } },
  ];

  for (const attempt of attempts) {
    assert.throws(
      () => recommendRoute(attempt.input as unknown as Parameters<typeof recommendRoute>[0]),
      (error: Error) => {
        const allowed = parseAllowedKeys(stripParenthetical(error.message));
        assert.ok(
          allowed.includes("task") && allowed.includes("candidates"),
          `attempt '${attempt.name}' must surface task and candidates as allowed; got ${allowed.join(", ")}`,
        );
        return true;
      },
      attempt.name,
    );
  }
});

test("in-library: compile_route_candidates errors enumerate the allowed top-level keys", () => {
  const attempts: Array<{ name: string; input: Record<string, unknown> }> = [
    { name: "kind/description/requires_tools", input: { kind: "x", description: "y", requires_tools: ["z"] } },
    { name: "description/traits", input: { description: "y", traits: ["z"] } },
    { name: "traits-only", input: { traits: ["z"] } },
  ];

  for (const attempt of attempts) {
    assert.throws(
      () => compileRouteCandidates(attempt.input as unknown as CompileRouteCandidatesInput),
      (error: Error) => {
        const allowed = parseAllowedKeys(stripParenthetical(error.message));
        assert.ok(
          allowed.includes("manifest"),
          `attempt '${attempt.name}' must surface manifest as allowed; got ${allowed.join(", ")}`,
        );
        return true;
      },
      attempt.name,
    );
  }
});

test("in-library: a first-time caller can build a valid recommend_route call from the error text", () => {
  // The caller gave the wrong keys. The error must tell them which keys are
  // accepted. They must be able to read enough off that message to construct
  // a valid call without reading the source or schema.
  const badInput = { description: "summarize files", traits: ["code"] };
  let message = "";
  try {
    recommendRoute(badInput as unknown as Parameters<typeof recommendRoute>[0]);
  } catch (error) {
    message = (error as Error).message;
  }
  assert.ok(message.length > 0, "must produce an error");
  const allowed = parseAllowedKeys(stripParenthetical(message));
  assert.ok(
    allowed.includes("task") && allowed.includes("candidates"),
    `allowed keys must include task and candidates; got ${allowed.join(", ")}`,
  );

  // The caller now knows the right keys. They build a minimal valid call.
  const minimal = {
    task: {
      required_capabilities: ["code"],
      privacy: "network_ok",
      locality: "any",
    },
    candidates: [
      {
        candidate_id: "lane-grk",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
        budget: { measured: false },
      },
    ],
  };
  const result = recommendRoute(minimal as unknown as Parameters<typeof recommendRoute>[0]);
  assert.equal(result.advisory, true);
  assert.equal(result.effects.executed, false);
  assert.equal(result.ranked.length, 1);
});

test("in-library: a first-time caller can build a valid compile_route_candidates call from the error text", () => {
  const badInput = { kind: "route", items: [] };
  let message = "";
  try {
    compileRouteCandidates(badInput as unknown as CompileRouteCandidatesInput);
  } catch (error) {
    message = (error as Error).message;
  }
  assert.ok(message.length > 0, "must produce an error");
  const allowed = parseAllowedKeys(stripParenthetical(message));
  assert.ok(allowed.includes("manifest"), `allowed must include manifest; got ${allowed.join(", ")}`);

  const minimal = { manifest: validManifest, observations: validObservations };
  const result = compileRouteCandidates(minimal as unknown as CompileRouteCandidatesInput);
  assert.equal(result.projection, true);
  assert.equal(result.candidates.length, 1);
});

test("in-library: error-text-driven repair extracts allowed keys and drops the bad ones", () => {
  const badInput = { description: "x", traits: ["y"], kind: "z" };
  let message = "";
  try {
    compileRouteCandidates(badInput as unknown as CompileRouteCandidatesInput);
  } catch (error) {
    message = (error as Error).message;
  }
  const allowed = new Set(parseAllowedKeys(stripParenthetical(message)));
  const repaired: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(badInput)) {
    if (allowed.has(key)) repaired[key] = value;
  }
  // The bad keys are not allowed, so the repair must drop them.
  assert.equal("description" in repaired, false);
  assert.equal("traits" in repaired, false);
  assert.equal("kind" in repaired, false);
});

test("in-library: nested 'manifest.X' unknown-key errors enumerate manifest's allowed keys", () => {
  const badInput = {
    manifest: {
      version: ROUTE_CANDIDATE_COMPILER_VERSION,
      candidates: [minimalCandidate],
      endpoint: "https://attacker.example",
    },
  };
  let message = "";
  try {
    compileRouteCandidates(badInput as unknown as CompileRouteCandidatesInput);
  } catch (error) {
    message = (error as Error).message;
  }
  const allowed = parseAllowedKeys(message);
  assert.ok(
    allowed.includes("version") && allowed.includes("candidates"),
    `manifest-level error must list manifest's allowed keys; got ${allowed.join(", ")}`,
  );
  assert.equal(
    allowed.includes("endpoint"),
    false,
    `rejected key must not appear in the allowed-list`,
  );
});

test("in-library: candidate-level unknown-key errors enumerate candidate's allowed keys", () => {
  const badInput = {
    manifest: {
      version: ROUTE_CANDIDATE_COMPILER_VERSION,
      candidates: [
        {
          candidate_id: "lane-grk",
          capabilities: ["code"],
          privacy: "network_ok",
          locality: "any",
          provider: "stripe",
          api_key: "x",
        },
      ],
    },
  };
  let message = "";
  try {
    compileRouteCandidates(badInput as unknown as CompileRouteCandidatesInput);
  } catch (error) {
    message = (error as Error).message;
  }
  const allowed = parseAllowedKeys(message);
  assert.ok(
    allowed.includes("candidate_id") && allowed.includes("capabilities"),
    `candidate-level error must list candidate's allowed keys; got ${allowed.join(", ")}`,
  );
  assert.equal(allowed.includes("provider"), false);
  assert.equal(allowed.includes("api_key"), false);
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "mf-routing-error-dx-"));
  return {
    dir,
    dbFile: join(dir, "test.db"),
    dataFile: join(dir, "test.json"),
    eventLog: join(dir, "test.events.log"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function withClient(fn: (client: Client) => Promise<void>): Promise<void> {
  const tmp = tempDir();
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      ...process.env,
      MESHFLEET_DB_FILE: tmp.dbFile,
      MESHFLEET_DATA_FILE: tmp.dataFile,
      MESHFLEET_EVENT_LOG_FILE: tmp.eventLog,
      AGENT_MESH_CHILD: "1",
    },
  });
  const client = new Client({ name: "routing-error-dx-test", version: "0.1" });
  try {
    await client.connect(transport);
    await fn(client);
  } finally {
    await client.close().catch(() => {});
    tmp.cleanup();
  }
}

const parseToolError = (result: unknown): string =>
  (result as { content: Array<{ type: string; text?: string }> }).content[0]!.text!;

/**
 * The MCP handler returns JSON-RPC content whose payload is either
 *   { error: "<message>" }
 * or a successful body. When the handler rejects the call, the message is
 * the JSON-serialized error string — strip the wrapper so the regex tests
 * run against the bare message text.
 */
const extractErrorText = (toolOutput: string): string => {
  const trimmed = toolOutput.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as { error?: string };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // fall through
  }
  return trimmed;
};

test("mcp: recommend_route errors enumerate the allowed keys over real stdio", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: "recommend_route",
      arguments: { description: "summarize files", traits: ["code"] },
    });
    const text = extractErrorText(parseToolError(result));
    const allowed = parseAllowedKeys(stripParenthetical(text));
    assert.ok(allowed.includes("task"), `top-level must surface task; got ${allowed.join(", ")}`);
    assert.ok(allowed.includes("candidates"), `top-level must surface candidates; got ${allowed.join(", ")}`);
  });
});

test("mcp: recommend_route task-level errors enumerate task's allowed keys over real stdio", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: "recommend_route",
      arguments: {
        task: { description: "summarize files", traits: ["code"] },
        candidates: [
          {
            candidate_id: "lane-grk",
            capabilities: ["code"],
            privacy: "network_ok",
            locality: "any",
            budget: { measured: false },
          },
        ],
      },
    });
    const text = extractErrorText(parseToolError(result));
    assert.match(text, /'task\.[a-z_]+' is not allowed/);
    const allowed = parseAllowedKeys(stripParenthetical(text));
    assert.ok(
      allowed.includes("required_capabilities") && allowed.includes("privacy"),
      `task-level must list task's allowed keys; got ${allowed.join(", ")}`,
    );
  });
});

test("mcp: compile_route_candidates errors enumerate the allowed keys over real stdio", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: "compile_route_candidates",
      arguments: { kind: "x", description: "y", requires_tools: ["z"] },
    });
    const text = extractErrorText(parseToolError(result));
    const allowed = parseAllowedKeys(text);
    assert.ok(allowed.includes("manifest"), `top-level must surface manifest; got ${allowed.join(", ")}`);
  });
});

test("mcp: a first-time caller can build a valid recommend_route call from the error text over real stdio", async () => {
  await withClient(async (client) => {
    // First attempt — uses the wrong vocabulary (the dogfood finding).
    const first = await client.callTool({
      name: "recommend_route",
      arguments: { description: "summarize files", traits: ["code"] },
    });
    const firstText = extractErrorText(parseToolError(first));
    const topAllowed = parseAllowedKeys(stripParenthetical(firstText));

    // Caller reads the error, knows only `task` and `candidates` are accepted.
    assert.ok(topAllowed.includes("task") && topAllowed.includes("candidates"));

    // Second attempt — uses only the allowed keys discovered from the error.
    const second = await client.callTool({
      name: "recommend_route",
      arguments: {
        task: { required_capabilities: ["code"], privacy: "network_ok", locality: "any" },
        candidates: [
          {
            candidate_id: "lane-grk",
            capabilities: ["code"],
            privacy: "network_ok",
            locality: "any",
            budget: { measured: false },
          },
        ],
      },
    });
    const body = JSON.parse(parseToolError(second));
    assert.equal(body.effects.executed, false);
    assert.equal(body.effects.contacted_providers, false);
    assert.ok(body.ranked.length > 0);
  });
});

test("mcp: a first-time caller can build a valid compile_route_candidates call from the error text over real stdio", async () => {
  await withClient(async (client) => {
    const first = await client.callTool({
      name: "compile_route_candidates",
      arguments: { kind: "routes", description: "all of them" },
    });
    const firstText = extractErrorText(parseToolError(first));
    const allowed = parseAllowedKeys(firstText);
    assert.ok(allowed.includes("manifest"));

    const second = await client.callTool({
      name: "compile_route_candidates",
      arguments: {
        manifest: validManifest,
        observations: validObservations,
      },
    });
    const body = JSON.parse(parseToolError(second));
    assert.equal(body.projection, true);
    assert.equal(body.candidates.length, 1);
  });
});

test("mcp: recommend_route description advertises the allowed top-level keys", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "recommend_route");
    assert.ok(tool, "missing MCP tool: recommend_route");
    const description = tool.description ?? "";
    assert.match(description, /task/i, "description must list task");
    assert.match(description, /candidates/i, "description must list candidates");
    assert.match(description, /top_n/i, "description must list top_n");
    assert.match(description, /preference/i, "description must list preference");
    assert.match(
      description,
      /allowed keys/i,
      "description must call out the allowed-keys summary",
    );
  });
});

test("mcp: compile_route_candidates description advertises the allowed top-level keys", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "compile_route_candidates");
    assert.ok(tool, "missing MCP tool: compile_route_candidates");
    const description = tool.description ?? "";
    assert.match(description, /manifest/i, "description must list manifest");
    assert.match(description, /observations/i, "description must list observations");
    assert.match(
      description,
      /allowed keys/i,
      "description must call out the allowed-keys summary",
    );
  });
});

test("mcp: error text and tool description agree on the allowed top-level keys", async () => {
  // The dogfood finding: the error naming and the description naming must
  // agree, so a caller can use either surface to learn the schema. Drift
  // here is the exact defect that produced three rounds of guess-and-retry.
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const recommendTool = tools.find((candidate) => candidate.name === "recommend_route");
    const compileTool = tools.find((candidate) => candidate.name === "compile_route_candidates");
    assert.ok(recommendTool);
    assert.ok(compileTool);

    const recommendAllowed = parseAllowedKeys(recommendTool.description ?? "");
    const compileAllowed = parseAllowedKeys(compileTool.description ?? "");
    assert.ok(recommendAllowed.includes("task") && recommendAllowed.includes("candidates"));
    assert.ok(compileAllowed.includes("manifest"));

    // Confirm the runtime error mirrors the description.
    const errorResult = await client.callTool({
      name: "recommend_route",
      arguments: { description: "x", traits: ["y"] },
    });
    const errorAllowed = parseAllowedKeys(stripParenthetical(extractErrorText(parseToolError(errorResult))));
    for (const key of recommendAllowed) {
      assert.ok(
        errorAllowed.includes(key),
        `runtime error must mention description-listed key '${key}'`,
      );
    }
  });
});
