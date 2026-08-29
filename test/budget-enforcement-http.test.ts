/**
 * Budget enforcement — thin HTTP wrapper smoke.
 *
 * The HTTP wrapper is a single-purpose mount point at POST /v1/budget/enforce
 * on the SSE server. These tests pin the wire shape so an out-of-process
 * caller (e.g. RoutePlane's Rust daemon) can rely on it. Mounted via
 * `startSseServer({ budgetEnforcement: true })`.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSseServer, stopSseServer } from "../src/sse-server.js";
import {
  setAgentProvider,
  setProviderBudget,
  resetBudgets,
} from "../src/budget-awareness.js";

let baseUrl: string;
let tempDir: string;
let prevEnv: string | undefined;
const PORT = 47_114; // fixed high port; nothing else in the suite binds it

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "meshfleet-budget-http-"));
  prevEnv = process.env.MESHFLEET_EVENT_LOG_FILE;
  process.env.MESHFLEET_EVENT_LOG_FILE = join(tempDir, "events.log");

  process.env.MESHFLEET_SSE_PORT = String(PORT);
  delete process.env.MESHFLEET_AUTH_TOKEN;
  delete process.env.MESHFLEET_SSE_TOKEN;
  delete process.env.AGENT_MESH_AUTH_TOKEN;
  const { host, port } = await startSseServer({ budgetEnforcement: true });
  baseUrl = `http://${host}:${port}`;
});

after(async () => {
  await stopSseServer();
  delete process.env.MESHFLEET_SSE_PORT;
  if (prevEnv === undefined) delete process.env.MESHFLEET_EVENT_LOG_FILE;
  else process.env.MESHFLEET_EVENT_LOG_FILE = prevEnv;
  if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

test("HTTP wrapper: GET /v1/budget/enforce returns the handler liveness", async () => {
  const res = await fetch(`${baseUrl}/v1/budget/enforce`, { method: "GET" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.handler, "budget_enforcement");
  assert.ok(typeof body.catalog_version === "string");
  assert.ok((body.catalog_version as string).startsWith("meshfleet.budget-enforcement."));
  assert.ok(typeof body.schema_version === "string");
});

test("HTTP wrapper: POST /v1/budget/enforce allows an under-budget call", async () => {
  resetBudgets();
  setProviderBudget({ provider: "grok-build", measured: true, used: 10, total: 1000 });
  setAgentProvider("architect", "grok-build");

  const res = await fetch(`${baseUrl}/v1/budget/enforce`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileId: "architect", requestedModel: "grok-4-fast" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.allowed, true);
  assert.equal(body.reason, "under_budget");
  assert.equal(body.downgradedModel, null);
  const receipt = body.receiptEnvelope as Record<string, unknown>;
  assert.equal(receipt.profile_id, "architect");
  assert.equal(receipt.provider_id, "grok-build");
  assert.equal(receipt.requested_model, "grok-4-fast");
  assert.ok(typeof receipt.decision_id === "string");
});

test("HTTP wrapper: POST denies an unknown profile (fail-closed)", async () => {
  resetBudgets();

  const res = await fetch(`${baseUrl}/v1/budget/enforce`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileId: "ghost", requestedModel: "grok-4-fast" }),
  });
  assert.equal(res.status, 200, "validation passes — denial is in the body, not the HTTP status");
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.allowed, false);
  assert.equal(body.reason, "unknown_profile");
});

test("HTTP wrapper: POST downgrades at-budget requests", async () => {
  resetBudgets();
  // used=60, total=100 → pre-call util=0.60 (at HEALTHY).
  // grok-4-fast catalog cost=100, so post-call requested = 1.6 → overshoots.
  // Downgrade to grok-4-mini (cost=30): post = 0.90 → fits.
  setProviderBudget({ provider: "grok-build", measured: true, used: 60, total: 100 });
  setAgentProvider("architect", "grok-build");

  const res = await fetch(`${baseUrl}/v1/budget/enforce`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileId: "architect", requestedModel: "grok-4-fast" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.allowed, true);
  assert.equal(body.reason, "downgraded");
  assert.equal(body.downgradedModel, "grok-4-mini");
});

test("HTTP wrapper: POST denies an over-budget call", async () => {
  resetBudgets();
  // codex-mini has no cheaper_alternatives. used=950/1000 → pre 0.95,
  // post requested (codex-mini cost=80) = 1.03 → over, no downgrade
  // path, deny.
  setProviderBudget({ provider: "openai-codex", measured: true, used: 950, total: 1000 });
  setAgentProvider("architect", "openai-codex");

  const res = await fetch(`${baseUrl}/v1/budget/enforce`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileId: "architect", requestedModel: "codex-mini" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.allowed, false);
  assert.equal(body.reason, "over_budget");
});

test("HTTP wrapper: POST rejects non-JSON content-type with 415", async () => {
  const res = await fetch(`${baseUrl}/v1/budget/enforce`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "not json",
  });
  assert.equal(res.status, 415);
});

test("HTTP wrapper: POST rejects malformed JSON with 400", async () => {
  const res = await fetch(`${baseUrl}/v1/budget/enforce`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{ not valid json",
  });
  assert.equal(res.status, 400);
});

test("HTTP wrapper: POST rejects unknown fields with 400", async () => {
  const res = await fetch(`${baseUrl}/v1/budget/enforce`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      profileId: "architect",
      requestedModel: "grok-4-fast",
      evil: "yes",
    }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as Record<string, unknown>;
  assert.match(String(body.error), /unknown fields: evil/);
});

test("HTTP wrapper: POST rejects empty profileId with 400", async () => {
  const res = await fetch(`${baseUrl}/v1/budget/enforce`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileId: "", requestedModel: "grok-4-fast" }),
  });
  assert.equal(res.status, 400);
});

test("HTTP wrapper: OPTIONS preflight returns 204 with permissive CORS headers", async () => {
  const res = await fetch(`${baseUrl}/v1/budget/enforce`, { method: "OPTIONS" });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.match(
    res.headers.get("Access-Control-Allow-Methods") ?? "",
    /POST/,
  );
});

test("HTTP wrapper: unknown path returns 404", async () => {
  const res = await fetch(`${baseUrl}/v1/budget/not-a-real-endpoint`, { method: "GET" });
  assert.equal(res.status, 404);
});
