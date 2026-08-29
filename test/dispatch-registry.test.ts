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
const compatibility = readFileSync(join(here, "..", "COMPATIBILITY.md"), "utf8");
const roadmap = readFileSync(join(here, "..", "ROADMAP.md"), "utf8");

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

test("registry includes D3 plus additive routing, verifier-v2/v3, speculative backlog, unified event stream, and per-caller insight consumer tools (38 total)", () => {
  const declared = declaredToolNames(source);
  const registered = registeredHandlerNames(source);

  assert.equal(declared.size, 38, `expected 38 advertised tools, got ${declared.size}: ${[...declared].sort().join(", ")}`);
  assert.equal(registered.size, 38, `expected 38 registered handlers, got ${registered.size}: ${[...registered].sort().join(", ")}`);
  assert.ok(declared.has("recommend_route"));
  assert.ok(registered.has("recommend_route"));
  assert.ok(declared.has("compile_route_candidates"));
  assert.ok(registered.has("compile_route_candidates"));
  assert.ok(declared.has("verify_ledger_v2"));
  assert.ok(registered.has("verify_ledger_v2"));
  assert.ok(declared.has("verify_ledger_v3"));
  assert.ok(registered.has("verify_ledger_v3"));
  assert.ok(declared.has("plan_speculative_backlog"));
  assert.ok(registered.has("plan_speculative_backlog"));
  assert.ok(declared.has("subscribe_events"));
  assert.ok(registered.has("subscribe_events"));
  assert.ok(declared.has("insight_caller_breakdown"));
  assert.ok(registered.has("insight_caller_breakdown"));
});

test("README advertises the 38-tool registry including verifier v3, speculative backlog, unified event stream, and insight consumer", () => {
  assert.match(readme, /^## 38 MCP tools$/m, "README must advertise the 38-tool registry");
  assert.match(readme, /^That's 38\. We counted twice this time\.$/m, "README summary must agree with the 38-tool registry");
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
  assert.match(
    readme,
    /^\| `verify_ledger_v3` \| Opt-in detached verifier envelope with severity-derived local consistency labels only; not provenance or confidence; the handler uses a dedicated read-only file snapshot and performs no ledger writes \|$/m,
    "README must describe verifier v3 without a confidence or provenance claim",
  );
  assert.doesNotMatch(
    readme,
    /"evidence_scope": "the unchanged six-item unsigned snapshot scope"/,
    "README v3 example must be a truthful JSON envelope rather than placeholder strings",
  );
  assert.match(
    readme,
    /"schema": "meshfleet\.verify\/v3"[\s\S]*?"profile": "unsigned_snapshot_consistency\/v1"[\s\S]*?"report": \{[\s\S]*?"finding_local_bands": \[\]/,
    "README v3 example must show concrete scope, report, and zero-band shapes",
  );
});

test("compatibility record includes the opt-in verifier-v3 and speculative backlog tools", () => {
  assert.match(
    compatibility,
    // These five tools were pinned as literally `unreleased` because they had
    // never shipped. 0.20.0 ships them, so the row names that version and this
    // guard now pins it. Deliberately NOT widened to accept `unreleased` again:
    // that would let the row silently regress to claiming the tools are still
    // unshipped. The next batch of tools gets its own row and its own assertion,
    // which is what keeps this a release tripwire rather than a formality.
    /^\| 0\.20\.0 \| \+ compile_route_candidates, recommend_route, verify_ledger_v2, verify_ledger_v3, plan_speculative_backlog /m,
    "the 0.20.0 compatibility row must include verifier-v3 and plan_speculative_backlog",
  );
  assert.match(
    compatibility,
    /v3 MCP is opt-in and, together with\s+`plan_speculative_backlog`, raises the implemented MCP tool\s+count to 36\./,
    "compatibility contract must reconcile the 36-tool registry",
  );
  assert.match(
    compatibility,
    /raises the count to 37/,
    "compatibility contract must acknowledge the 37th tool (subscribe_events)",
  );
  assert.match(
    compatibility,
    /raises the count to 38/,
    "compatibility contract must acknowledge the 38th tool (insight_caller_breakdown)",
  );
});

test("roadmap keeps provenance-confidence bands deferred when documenting v3's narrower local labels", () => {
  assert.match(
    roadmap,
    /^- Per-entry provenance confidence bands in verify output remain deferred;/m,
    "v3 must not silently substitute for the separate provenance-confidence aspiration",
  );
  assert.match(
    roadmap,
    /does not fulfill that deferred provenance-confidence item/i,
    "v3's shipped-roadmap entry must disclose its narrower scope",
  );
});

test("README documents plan_speculative_backlog at its projection boundary", () => {
  assert.match(
    readme,
    /^\| `plan_speculative_backlog` \| Pure projection of caller-approved speculative work, preserving route gates and explicitly leaving capacity unmodeled \|$/m,
    "README must describe plan_speculative_backlog at its projection boundary",
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
