import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const EXPECTED_SCOPE = {
  profile: "unsigned_snapshot_consistency/v1",
  ok_means: "no_detected_internal_consistency_contradiction",
  assurance_ceiling: "internal_consistency_of_the_unsigned_snapshot_read",
  not_established: [
    "authorship_and_authenticated_provenance",
    "pre_read_snapshot_integrity_and_tamper_evidence",
    "content_binding",
    "completeness_and_deletion",
    "external_delivery_and_execution",
    "external_time",
  ],
} as const;

function textOf(response: unknown): string {
  return (response as { content: Array<{ text: string }> }).content[0]!.text;
}

function snapshot(dir: string): Array<{ name: string; bytes: string; size: number; mtimeMs: number }> {
  return readdirSync(dir).sort().map((name) => {
    const file = join(dir, name);
    const stat = statSync(file);
    return { name, bytes: readFileSync(file).toString("base64"), size: stat.size, mtimeMs: stat.mtimeMs };
  });
}

test("verify_ledger_v2 wraps the same isolated legacy report without writing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-verify-v2-mcp-"));
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
  const client = new Client({ name: "verify-ledger-v2-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const legacyTool = tools.find((tool) => tool.name === "verify_ledger");
    const v2Tool = tools.find((tool) => tool.name === "verify_ledger_v2");
    assert.ok(legacyTool, "legacy verifier must remain advertised");
    assert.ok(v2Tool, "missing MCP tool: verify_ledger_v2");
    assert.deepEqual(v2Tool.inputSchema, { type: "object", properties: {} });

    const legacy = JSON.parse(textOf(await client.callTool({ name: "verify_ledger", arguments: {} }))) as Record<string, unknown>;
    const beforeV2 = snapshot(dir);
    const v2 = JSON.parse(textOf(await client.callTool({ name: "verify_ledger_v2", arguments: {} }))) as Record<string, unknown>;

    assert.deepEqual(Object.keys(v2).sort(), ["evidence_scope", "report", "schema"]);
    assert.equal(v2.schema, "meshfleet.verify/v2");
    assert.deepEqual(v2.evidence_scope, EXPECTED_SCOPE);
    assert.deepEqual(v2.report, legacy);
    assert.equal("evidence_scope" in legacy, false, "legacy response must remain a bare VerifyReport");
    assert.deepEqual(snapshot(dir), beforeV2, "verify_ledger_v2 must not write the isolated ledger or sidecars");
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify_ledger_v2 fails closed on an absent ledger without creating one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-verify-v2-absent-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(repoRoot, "src", "index.ts")],
    env: {
      ...(process.env as Record<string, string>),
      MESHFLEET_DB_FILE: join(dir, "absent.db"),
      MESHFLEET_DATA_FILE: join(dir, "absent.json"),
      MESHFLEET_EVENT_LOG_FILE: join(dir, "events.jsonl"),
      MESHFLEET_RATIFY_SWEEP_MS: "0",
      AGENT_MESH_CHILD: "1",
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "verify-ledger-v2-absent-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const before = snapshot(dir);
    assert.deepEqual(before, [], "the isolated directory must begin empty");
    const response = await client.callTool({ name: "verify_ledger_v2", arguments: {} });
    assert.equal((response as { isError?: boolean }).isError, true);
    assert.deepEqual(JSON.parse(textOf(response)), {
      error: "verify_ledger_v2 unavailable: configured ledger is absent or unreadable",
    });
    assert.deepEqual(snapshot(dir), before, "a failed v2 verification must not create a ledger or sidecar");
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
