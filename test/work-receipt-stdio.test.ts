import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = join(import.meta.dirname, "..");
const sourceVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

type CallToolResultShape = { content: Array<{ type: string; text: string }>; isError?: boolean };

test("MCP stdio parity: record_work_receipt and get_work_receipt are advertised, callable, and round-trip", async () => {
  // Build the exact tarball once and install IT (not the worktree directly).
  // `npm install <directory>` symlinks the directory, so the resolved
  // import.meta.url would still point at the worktree — proving only that
  // tsx can resolve the source, not that a packed consumer works.
  // The packed-consumer test is the contract: install the tarball, then
  // assert the runtime's manifest_path points inside node_modules/meshfleet
  // and entrypoints_match_runtime is true.
  const packDir = mkdtempSync(join(tmpdir(), "meshfleet-wr-pack-"));
  const tempProject = mkdtempSync(join(tmpdir(), "meshfleet-wr-stdio-"));
  const eventLog = join(tempProject, "events.jsonl");
  const dbFile = join(tempProject, "agent-mesh.db");
  try {
    const packOutput = execFileSync(
      "npm",
      ["pack", "--pack-destination", packDir],
      { cwd: repoRoot, encoding: "utf-8", timeout: 120_000 },
    ).trim();
    const tarball = packOutput.split("\n").pop()!.trim();
    const tarballPath = join(packDir, tarball);
    assert.ok(existsSync(tarballPath), `tarball ${tarballPath} not produced`);
    const tarballBytes = execFileSync("cat", [tarballPath], { encoding: "buffer" });
    const tarballSha = createHash("sha256").update(tarballBytes).digest("hex");

    execFileSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["install", "--offline", "--no-package-lock", "--no-audit", "--no-fund", tarballPath],
      {
        cwd: tempProject,
        env: { ...process.env, npm_config_offline: "true" },
        stdio: "pipe",
        timeout: 120_000,
        shell: process.platform === "win32",
      },
    );

    const installed = join(tempProject, "node_modules", "meshfleet");
    assert.ok(existsSync(join(installed, "dist", "meshfleet-build-manifest.json")), "tarball missing dist/meshfleet-build-manifest.json");
    assert.ok(existsSync(join(installed, "dist", "index.js")), "tarball missing dist/index.js");

    const transport = new StdioClientTransport({
      command: "npx",
      args: ["--no-install", "meshfleet"],
      cwd: tempProject,
      stderr: "pipe",
      env: {
        ...process.env,
        MESHFLEET_DB_FILE: dbFile,
        AGENT_MESH_CHILD: "1",
        MESHFLEET_RATIFY_SWEEP_MS: "0",
        MESHFLEET_EVENT_LOG_FILE: eventLog,
        npm_config_offline: "true",
      },
    });
    const client = new Client({ name: "meshfleet-work-receipt-stdio-test", version: "1.0.0" });
    try {
      await client.connect(transport);

      const { tools } = await client.listTools();
      const names = new Set(tools.map((t) => t.name));
      assert.ok(names.has("record_work_receipt"), "record_work_receipt missing from advertised surface");
      assert.ok(names.has("get_work_receipt"), "get_work_receipt missing from advertised surface");

      const recordTool = tools.find((t) => t.name === "record_work_receipt");
      assert.ok(recordTool);
      const recordSchema = recordTool.inputSchema as {
        properties: Record<string, { enum?: string[]; minimum?: number; pattern?: string; minLength?: number }>;
        required: string[];
      };
      assert.deepEqual(recordSchema.required.slice().sort(), [
        "assignee",
        "completed_at",
        "evidence",
        "payload_sha256",
        "quality_gate",
        "result_contract",
        "run_id",
        "schema",
        "task_id",
        "terminal_outcome",
      ]);
      assert.deepEqual(recordSchema.properties.schema!.enum, ["hermes.kanban-result/v1"]);
      assert.equal(recordSchema.properties.run_id!.minimum, 1);
      assert.equal(recordSchema.properties.completed_at!.minimum, 1);
      assert.equal(recordSchema.properties.payload_sha256!.pattern, "^[0-9a-f]{64}$");
      assert.equal(recordSchema.properties.task_id!.pattern, "^t_[A-Za-z0-9]+$");
      assert.equal(recordSchema.properties.assignee!.minLength, 1);
      assert.deepEqual(recordSchema.properties.terminal_outcome!.enum, [
        "completed",
        "failed",
        "refused",
        "blocked",
      ]);

      const getTool = tools.find((t) => t.name === "get_work_receipt");
      assert.ok(getTool);
      const getSchema = getTool.inputSchema as {
        properties: Record<string, { enum?: string[]; minimum?: number; pattern?: string }>;
        required: string[];
      };
      assert.deepEqual(getSchema.required.slice().sort(), ["run_id", "source", "task_id"]);
      assert.deepEqual(getSchema.properties.source!.enum, ["hermes-kanban"]);

      const evidence = [{ kind: "git_commit", handle: "abc1234" }];
      const canonical = JSON.stringify({
        schema: "hermes.kanban-result/v1",
        task_id: "t_stdiotest",
        run_id: 1,
        assignee: "meshfleet",
        terminal_outcome: "completed",
        result_contract: "ok",
        quality_gate: "passed",
        completed_at: 1_700_000_000,
        evidence,
      });
      const payload_sha256 = createHash("sha256").update(canonical).digest("hex");

      const recorded = (await client.callTool({
        name: "record_work_receipt",
        arguments: {
          schema: "hermes.kanban-result/v1",
          task_id: "t_stdiotest",
          run_id: 1,
          assignee: "meshfleet",
          terminal_outcome: "completed",
          result_contract: "ok",
          quality_gate: "passed",
          completed_at: 1_700_000_000,
          evidence,
          payload_sha256,
        },
      })) as CallToolResultShape;
      const recordResult = JSON.parse(recorded.content[0]!.text);
      assert.equal(recordResult.ok, true);
      assert.equal(recordResult.inserted, true);
      assert.equal(recordResult.replayed, false);

      const readBack = (await client.callTool({
        name: "get_work_receipt",
        arguments: { source: "hermes-kanban", task_id: "t_stdiotest", run_id: 1 },
      })) as CallToolResultShape;
      const getResult = JSON.parse(readBack.content[0]!.text);
      assert.equal(getResult.ok, true);
      assert.equal(getResult.receipt.payload_sha256, payload_sha256);
      assert.equal(getResult.receipt.assignee, "meshfleet");

      const replay = (await client.callTool({
        name: "record_work_receipt",
        arguments: {
          schema: "hermes.kanban-result/v1",
          task_id: "t_stdiotest",
          run_id: 1,
          assignee: "meshfleet",
          terminal_outcome: "completed",
          result_contract: "ok",
          quality_gate: "passed",
          completed_at: 1_700_000_000,
          evidence,
          payload_sha256,
        },
      })) as CallToolResultShape;
      const replayResult = JSON.parse(replay.content[0]!.text);
      assert.equal(replayResult.ok, true);
      assert.equal(replayResult.inserted, false);
      assert.equal(replayResult.replayed, true);
      assert.equal(replayResult.recorded_at, recordResult.recorded_at);

      // Conflict: same key, DIFFERENT bytes — recomputed digest so validation
      // passes and the idempotency layer sees a real conflict (preserving the
      // original row verbatim).
      const conflictAssignee = "different-assignee";
      const conflictCanonical = JSON.stringify({
        schema: "hermes.kanban-result/v1",
        task_id: "t_stdiotest",
        run_id: 1,
        assignee: conflictAssignee,
        terminal_outcome: "completed",
        result_contract: "ok",
        quality_gate: "passed",
        completed_at: 1_700_000_000,
        evidence,
      });
      const conflictPayloadSha = createHash("sha256").update(conflictCanonical).digest("hex");

      const conflict = (await client.callTool({
        name: "record_work_receipt",
        arguments: {
          schema: "hermes.kanban-result/v1",
          task_id: "t_stdiotest",
          run_id: 1,
          assignee: conflictAssignee,
          terminal_outcome: "completed",
          result_contract: "ok",
          quality_gate: "passed",
          completed_at: 1_700_000_000,
          evidence,
          payload_sha256: conflictPayloadSha,
        },
      })) as CallToolResultShape;
      assert.equal(conflict.isError, true);
      assert.match(conflict.content[0]!.text, /work_receipt_conflict/);
      const readAfterConflict = (await client.callTool({
        name: "get_work_receipt",
        arguments: { source: "hermes-kanban", task_id: "t_stdiotest", run_id: 1 },
      })) as CallToolResultShape;
      const readAfterConflictResult = JSON.parse(readAfterConflict.content[0]!.text);
      assert.equal(readAfterConflictResult.ok, true);
      assert.equal(readAfterConflictResult.receipt.assignee, "meshfleet");
      assert.equal(readAfterConflictResult.receipt.payload_sha256, payload_sha256);

      // Validation refusal: wrong digest rejected at validation time, never
      // reaches the idempotency layer.
      const invalid = (await client.callTool({
        name: "record_work_receipt",
        arguments: {
          schema: "hermes.kanban-result/v1",
          task_id: "t_stdiotest",
          run_id: 2,
          assignee: "meshfleet",
          terminal_outcome: "completed",
          result_contract: "ok",
          quality_gate: "passed",
          completed_at: 1_700_000_000,
          evidence,
          payload_sha256: "0".repeat(64),
        },
      })) as CallToolResultShape;
      assert.equal(invalid.isError, true);
      assert.match(invalid.content[0]!.text, /invalid input/i);

      // verify_ledger_v3 picks up the persisted row and exercises the
      // work_receipt path through the packed consumer.
      const verify = (await client.callTool({
        name: "verify_ledger_v3",
        arguments: {},
      })) as CallToolResultShape;
      const verifyResult = JSON.parse(verify.content[0]!.text);
      assert.ok(verifyResult.report);
      assert.equal(verifyResult.schema, "meshfleet.verify/v3");

      const health = (await client.callTool({
        name: "get_health",
        arguments: {},
      })) as CallToolResultShape;
      const healthReport = JSON.parse(health.content[0]!.text);
      assert.equal(healthReport.work_receipt_count, 1);
      assert.equal(healthReport.build_identity.status, "ok");
      assert.equal(healthReport.build_identity.schema, "meshfleet.build/v1");
      assert.ok(
        healthReport.build_identity.entrypoints_match_runtime,
        `entrypoints_match_runtime is false — packed manifest disagrees with installed bytes. tarball sha: ${tarballSha}`,
      );
      const manifestPath = healthReport.build_identity.manifest_path as string;
      // macOS exposes /var/folders/... as /private/var/folders/...; resolve the
      // symlink so the prefix check is portable.
      const realpath = (await import("node:fs")).realpathSync(manifestPath);
      const installedReal = (await import("node:fs")).realpathSync(installed);
      assert.ok(
        realpath.startsWith(installedReal),
        `manifest_path ${realpath} (resolved from ${manifestPath}) is NOT inside the installed package ${installedReal} (resolved from ${installed}) — packed-consumer parity not proven`,
      );
      assert.equal(healthReport.build_identity.package_version, sourceVersion);
      console.log(`packed-consumer test: tarball sha ${tarballSha}, manifest ${manifestPath}`);
    } finally {
      await client.close();
    }
  } finally {
    try { rmSync(join(tempProject, "node_modules"), { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(tempProject, { recursive: true, force: true }); } catch { /* leak */ }
    try { rmSync(packDir, { recursive: true, force: true }); } catch { /* leak */ }
  }
});
