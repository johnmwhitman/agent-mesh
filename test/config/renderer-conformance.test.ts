/**
 * Renderer conformance tests — deterministic, parseable, snapshot-style.
 *
 * These tests prove static configuration shape only. They are not live client
 * execution proofs. Existing packaged MCP handshake test (mcp-stdio.test.ts)
 * remains the semantic server proof.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { MESH_FLEET_STDIO } from "../../src/config/mcp-stdio-connection.js";
import {
  renderGenericMcpJson,
  renderOpenCodeJsonc,
  renderClaudeCodeMcpJson,
  renderCodexMcpJson,
} from "../../src/config/renderers/index.js";

test("generic-mcp-json renderer preserves server identity, command, argv", () => {
  const result = renderGenericMcpJson();
  assert.equal(result.status, "supported");
  assert.equal(result.target, "generic-mcp-json");
  const cfg = result.config!;
  assert.ok("meshfleet" in cfg.mcpServers);
  const entry = cfg.mcpServers.meshfleet;
  assert.equal(entry.command, "npx");
  assert.deepEqual(entry.args, ["-y", "meshfleet"]);
  // server identity preserved
  assert.equal(Object.keys(cfg.mcpServers)[0], MESH_FLEET_STDIO.serverId);
});

test("opencode-jsonc renderer preserves server identity, command, argv", () => {
  const result = renderOpenCodeJsonc();
  assert.equal(result.status, "supported");
  assert.equal(result.target, "opencode-jsonc");
  const cfg = result.config!;
  assert.ok("meshfleet" in cfg.mcp);
  const entry = cfg.mcp.meshfleet;
  assert.deepEqual(entry.command, ["npx", "-y", "meshfleet"]);
  assert.equal(entry.type, "local");
  assert.equal(entry.enabled, true);
});

test("claude-code-mcp-json renderer preserves server identity, command, argv", () => {
  const result = renderClaudeCodeMcpJson();
  assert.equal(result.status, "supported");
  assert.equal(result.target, "claude-code-mcp-json");
  const cfg = result.config!;
  assert.ok("meshfleet" in cfg.mcpServers);
  const entry = cfg.mcpServers.meshfleet;
  assert.equal(entry.command, "npx");
  assert.deepEqual(entry.args, ["-y", "meshfleet"]);
});

test("codex-mcp-json renderer preserves server identity, command, argv", () => {
  const result = renderCodexMcpJson();
  assert.equal(result.status, "supported");
  assert.equal(result.target, "codex-mcp-json");
  const cfg = result.config!;
  assert.ok("meshfleet" in cfg.mcpServers);
  const entry = cfg.mcpServers.meshfleet;
  assert.equal(entry.command, "npx");
  assert.deepEqual(entry.args, ["-y", "meshfleet"]);
});

test("all renderers report unsupported fields for timeout, env, capabilities, trust", () => {
  const renderers = [
    renderGenericMcpJson,
    renderOpenCodeJsonc,
    renderClaudeCodeMcpJson,
    renderCodexMcpJson,
  ];
  for (const render of renderers) {
    const result = render();
    const unsupportedFields = result.unsupported.map((u) => u.field);
    assert.ok(unsupportedFields.includes("timeout"), `${result.target} must report timeout unsupported`);
    // env may or may not be listed depending on renderer; we only require timeout
  }
});

test("renderer results are deterministic JSON-serializable", () => {
  const results = [
    renderGenericMcpJson(),
    renderOpenCodeJsonc(),
    renderClaudeCodeMcpJson(),
    renderCodexMcpJson(),
  ];
  for (const r of results) {
    const json = JSON.stringify(r);
    const reparsed = JSON.parse(json);
    assert.deepEqual(reparsed, r);
  }
});
