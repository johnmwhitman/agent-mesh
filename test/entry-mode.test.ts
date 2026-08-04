import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveEntryMode, CLI_COMMANDS } from "../src/entry-mode.js";

// S2 first-run path. The `meshfleet` bin is the MCP server's launch command AND
// the name a human types. The dispatch that separates them is the single most
// dangerous edit in the package: get it wrong and every existing MCP install
// dies silently mid-handshake.
//
// The safety property pinned here is deliberately asymmetric:
//   unknown argv ALWAYS boots the server (today's behaviour, never regressed)
// and only an exact, closed allowlist of human tokens diverts to the CLI.
// A host that appends `--stdio`, a config path, or `--` must be untouched.

test("no arguments boots the MCP server — the launch contract", () => {
  assert.deepEqual(resolveEntryMode([], {}), { mode: "mcp" });
});

test("host noise is never hijacked into CLI mode", () => {
  // Every one of these is argv a real MCP client wrapper has been seen to add.
  for (const argv of [
    ["--stdio"],
    ["--"],
    ["/Users/someone/.config/meshfleet/config.json"],
    ["-y"],
    ["--transport", "stdio"],
    ["--port", "13579"],
  ]) {
    assert.deepEqual(
      resolveEntryMode(argv, {}),
      { mode: "mcp" },
      `argv ${JSON.stringify(argv)} must boot the server, not the CLI`,
    );
  }
});

test("exact human tokens dispatch to the CLI with their remaining args", () => {
  assert.deepEqual(resolveEntryMode(["doctor"], {}), {
    mode: "cli",
    command: "doctor",
    args: [],
  });
  assert.deepEqual(resolveEntryMode(["doctor", "--json"], {}), {
    mode: "cli",
    command: "doctor",
    args: ["--json"],
  });
  assert.deepEqual(resolveEntryMode(["demo"], {}), {
    mode: "cli",
    command: "demo",
    args: [],
  });
  assert.deepEqual(resolveEntryMode(["init"], {}), {
    mode: "cli",
    command: "init",
    args: [],
  });
});

test("help and version are CLI tokens too", () => {
  for (const token of ["help", "--help", "-h"]) {
    assert.equal(resolveEntryMode([token], {}).mode, "cli");
    assert.equal((resolveEntryMode([token], {}) as { command: string }).command, "help");
  }
  for (const token of ["--version", "-v"]) {
    assert.equal((resolveEntryMode([token], {}) as { command: string }).command, "version");
  }
});

test("MESHFLEET_MCP=1 forces server mode even on a human token", () => {
  // The escape hatch: if a host ever DOES pass a colliding token, one env var
  // restores the old behaviour without waiting on a release.
  assert.deepEqual(resolveEntryMode(["doctor"], { MESHFLEET_MCP: "1" }), {
    mode: "mcp",
  });
  assert.deepEqual(resolveEntryMode(["demo"], { MESHFLEET_MCP: "1" }), {
    mode: "mcp",
  });
});

test("a human token only counts in first position", () => {
  // `--stdio doctor` is host argv that happens to contain our word. Booting the
  // server is the non-regressing read.
  assert.deepEqual(resolveEntryMode(["--stdio", "doctor"], {}), { mode: "mcp" });
  assert.deepEqual(resolveEntryMode(["--transport", "demo"], {}), { mode: "mcp" });
});

test("the allowlist is closed and small", () => {
  // If this ever grows, the collision risk against host argv grows with it —
  // the test exists so growth is a deliberate, reviewed act.
  assert.deepEqual(
    [...CLI_COMMANDS].sort(),
    ["--help", "--version", "-h", "-v", "demo", "doctor", "help", "init"].sort(),
  );
});
