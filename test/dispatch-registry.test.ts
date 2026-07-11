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
