import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Parity check for the tool-dispatch registry refactor.
//
// src/index.ts boots a stdio transport + SSE HTTP server as top-level side
// effects on import, so we cannot import it here without hanging the test /
// binding a port. Instead we statically parse the source and assert that the
// set of tool NAMES declared in the ListToolsRequestSchema array is exactly
// the set of handler keys registered on `toolHandlers`. If the two ever drift
// (a tool advertised with no handler, or a handler for an unadvertised tool),
// this fails.

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "src", "index.ts"), "utf8");
const readme = readFileSync(join(here, "..", "README.md"), "utf8");

// Declared tool names live in the ListToolsRequestSchema handler, i.e. between
// the ListTools registration and the toolHandlers registry declaration.
function declaredToolNames(src: string): Set<string> {
  const start = src.indexOf("setRequestHandler(ListToolsRequestSchema");
  assert.ok(start !== -1, "could not locate ListToolsRequestSchema handler");
  const end = src.indexOf("const toolHandlers", start);
  assert.ok(end !== -1, "could not locate toolHandlers declaration");
  const region = src.slice(start, end);
  const names = new Set<string>();
  for (const m of region.matchAll(/name:\s*"([^"]+)"/g)) {
    names.add(m[1]);
  }
  return names;
}

// Registered handler keys: `toolHandlers["<name>"] = ...`.
function registeredHandlerNames(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/toolHandlers\["([^"]+)"\]\s*=/g)) {
    names.add(m[1]);
  }
  return names;
}

test("every declared tool has a registered handler and vice versa", () => {
  const declared = declaredToolNames(source);
  const registered = registeredHandlerNames(source);

  assert.ok(declared.size > 0, "expected at least one declared tool");
  assert.ok(registered.size > 0, "expected at least one registered handler");

  const declaredButUnhandled = [...declared].filter((n) => !registered.has(n));
  const handledButUndeclared = [...registered].filter((n) => !declared.has(n));

  assert.deepEqual(
    declaredButUnhandled,
    [],
    `tools declared in ListTools with no handler: ${declaredButUnhandled.join(", ")}`,
  );
  assert.deepEqual(
    handledButUndeclared,
    [],
    `handlers registered with no ListTools declaration: ${handledButUndeclared.join(", ")}`,
  );

  assert.deepEqual(
    [...declared].sort(),
    [...registered].sort(),
    "declared tool-name set must equal registered handler-key set",
  );
});

test("registry has no duplicate handler registrations", () => {
  const keys = [...source.matchAll(/toolHandlers\["([^"]+)"\]\s*=/g)].map((m) => m[1]);
  const unique = new Set(keys);
  assert.equal(keys.length, unique.size, "duplicate toolHandlers registration detected");
});

// D3 (blueprint §8 "Tool-count reconciliation" + errata item 8): the pre-D3
// baseline was 27 advertised tools / 27 registered handlers; D3 adds exactly
// four Discussion tools (ask_peer, wake_agent, reply_discussion,
// get_discussion), so the D3 baseline is 31/31 with every original name still
// present. recommend_route is the next additive tool, bringing the live
// registry to 32/32 without changing any pre-D3 or Discussion name. The
// additive snapshot compiler brings the registry to 33/33.
const PRE_D3_TOOL_NAMES = [
  "spawn_fleet",
  "fleet_status",
  "list_fleets",
  "set_fleet_timeout",
  "collect_results",
  "send_message",
  "send_messages",
  "get_inbox",
  "ack_message",
  "receipt",
  "get_receipts",
  "verify_ledger",
  "open_ratification",
  "cast_vote",
  "tally_ratification",
  "sweep_ratifications",
  "register_capability",
  "route_work",
  "record_routing_outcome",
  "list_agents",
  "attach_agent",
  "ping",
  "subscribe_inbox",
  "get_health",
  "save_fleet_template",
  "list_fleet_templates",
  "spawn_from_template",
];

const D3_DISCUSSION_TOOL_NAMES = ["ask_peer", "wake_agent", "reply_discussion", "get_discussion"];

test("registry includes D3 plus additive routing and verifier-v2 tools (34 total)", () => {
  const declared = declaredToolNames(source);
  const registered = registeredHandlerNames(source);

  assert.equal(declared.size, 34, `expected 34 advertised tools, got ${declared.size}: ${[...declared].sort().join(", ")}`);
  assert.equal(registered.size, 34, `expected 34 registered handlers, got ${registered.size}: ${[...registered].sort().join(", ")}`);
  assert.ok(declared.has("recommend_route"));
  assert.ok(registered.has("recommend_route"));
  assert.ok(declared.has("compile_route_candidates"));
  assert.ok(registered.has("compile_route_candidates"));
  assert.ok(declared.has("verify_ledger_v2"));
  assert.ok(registered.has("verify_ledger_v2"));
});

test("README advertises the 34-tool registry including verifier v2", () => {
  assert.match(readme, /^## 34 MCP tools$/m, "README must advertise the 34-tool registry");
  assert.match(readme, /^That's 34\. We counted twice this time\.$/m, "README summary must agree with the 34-tool registry");
  assert.match(
    readme,
    /^\| `compile_route_candidates` \| Pure offline projection of sanitized manifest\/observation snapshots; does not rank, persist, execute, authorize, wake, or contact providers \|$/m,
    "README must describe compile_route_candidates and its effect boundary",
  );
  assert.match(
    readme,
    /^\| `verify_ledger_v2` \| Versioned unsigned-snapshot consistency envelope around the unchanged verifier report from a dedicated read-only file snapshot; the handler performs no ledger writes \|$/m,
    "README must describe verify_ledger_v2 at its read-only handler boundary",
  );
});

test("D3: all 27 pre-existing tool names remain present in both registries", () => {
  const declared = declaredToolNames(source);
  const registered = registeredHandlerNames(source);

  assert.equal(PRE_D3_TOOL_NAMES.length, 27, "pre-D3 baseline fixture must itself list exactly 27 names");
  for (const name of PRE_D3_TOOL_NAMES) {
    assert.ok(declared.has(name), `pre-existing tool "${name}" missing from ListTools`);
    assert.ok(registered.has(name), `pre-existing tool "${name}" missing from toolHandlers`);
  }
});

test("D3: the four additive Discussion tool names are present in both registries", () => {
  const declared = declaredToolNames(source);
  const registered = registeredHandlerNames(source);

  for (const name of D3_DISCUSSION_TOOL_NAMES) {
    assert.ok(declared.has(name), `Discussion tool "${name}" missing from ListTools`);
    assert.ok(registered.has(name), `Discussion tool "${name}" missing from toolHandlers`);
  }
});
