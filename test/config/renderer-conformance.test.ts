/**
 * Renderer conformance tests — deterministic, parseable, snapshot-style.
 *
 * These tests prove static configuration shape only. They are not live client
 * execution proofs. Existing packaged MCP handshake test (mcp-stdio.test.ts)
 * remains the semantic server proof.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { MESH_FLEET_STDIO } from "../../src/config/mcp-stdio-connection.js";
import { CANONICAL_CONNECTION_FIELDS } from "../../src/config/renderers/renderer-result.js";
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
    assert.ok(unsupportedFields.includes("envAllowlist"), `${result.target} must report envAllowlist unsupported`);
    assert.equal(new Set(unsupportedFields).size, unsupportedFields.length);
    const emitted = new Set(["serverId", "transport", "command"]);
    for (const field of CANONICAL_CONNECTION_FIELDS) {
      assert.ok(emitted.has(field) || unsupportedFields.includes(field), `${result.target} must account for ${field}`);
    }
  }
});

test("all renderers reject malicious caller-supplied canonical spec data before output", () => {
  const renderers = [renderGenericMcpJson, renderOpenCodeJsonc, renderClaudeCodeMcpJson, renderCodexMcpJson];
  const cases = [
    { serverId: "Meshfleet-ＡＰＩ＿ＫＥＹ" },
    { command: ["npx", "--API_KEY=inline-secret"] },
    { envAllowlist: ["MESHFLEET_DB_FILE", "X_AUTH_TOKEN"] },
    { capabilities: ["tools", "secret"] },
    { trust: { localStdioTrusted: true, notes: "Bearer abcdefghijklmnop" } },
    { description: "https://user:password@example.test/mesh" },
    { description: "-----BEGIN PRIVATE KEY-----\nmaterial\n-----END PRIVATE KEY-----" },
    { metadata: { nested: { private_key: "value" } } },
    { metadata: { blob: "QWxhZGRpbjpvcGVuIHNlc2FtZQAAAAAAAAAAAAAAAAAAAAAA" } },
  ];
  for (const patch of cases) {
    for (const render of renderers) {
      const result = render({ ...MESH_FLEET_STDIO, ...patch } as typeof MESH_FLEET_STDIO);
      assert.equal(result.status, "secret-rejected", `${result.target} must reject ${JSON.stringify(patch)}`);
      assert.equal(result.config, undefined);
      assert.equal(result.unsupported.length, 0);
      assert.equal(result.warnings[0]?.code, "secret-rejected");
    }
  }
});

test("all renderers allow benign names and descriptive metadata", () => {
  const benign = {
    ...MESH_FLEET_STDIO,
    serverId: "authoring-tools",
    name: "Agent Mesh authoring tools",
    description: "Authentication-free local orchestration for authors.",
    metadata: { author: "meshfleet", purpose: "tooling", stable: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  } as typeof MESH_FLEET_STDIO;
  for (const render of [renderGenericMcpJson, renderOpenCodeJsonc, renderClaudeCodeMcpJson, renderCodexMcpJson]) {
    assert.equal(render(benign).status, "supported");
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

test("conformance matrix is parseable JSON-compatible YAML with inbound/outbound axes", () => {
  const matrix = JSON.parse(readFileSync(new URL("../../docs/CONFORMANCE-MATRIX.yaml", import.meta.url), "utf8")) as {
    authority: string[];
    inbound: unknown[];
    outbound: unknown[];
    evidence_statuses: string[];
  };
  assert.ok(matrix.authority.includes("COMPATIBILITY.md"));
  assert.ok(matrix.inbound.length >= 4);
  assert.ok(matrix.outbound.length >= 4);
  assert.ok(matrix.evidence_statuses.includes("static-config-verified"));
  assert.ok(matrix.evidence_statuses.includes("deferred"));
});
