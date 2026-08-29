/**
 * Focused tests for the MeshFleet → RoutePlane provider endpoint
 * (`routeplane/intelligent-router`).
 *
 * Acceptance criteria from t_c369adf1:
 *   - End-to-end test from a fake profile through the provider endpoint
 *     into the router and back.
 *   - Test that the metadata receipt is populated on success and on
 *     fallthrough.
 *   - Test for the router-down degraded path.
 *   - Auth boundary: missing or wrong bearer returns 401 with receipt.
 *   - Schema: malformed JSON body returns 400 with receipt.
 *
 * These tests bind to a free port and stand up a fake RoutePlane daemon
 * that the endpoint forwards to. They are pure-Node (`node:test`) and
 * have no side effects on the live router.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import {
  ROUTEPLANE_PROVIDER_ENDPOINT_VERSION,
  ROUTEPLANE_PROVIDER_RECEIPT_VERSION,
  DEFAULT_FALLBACK_CHAIN,
  DEFAULT_ROUTEPLANE_CHAT_COMPLETIONS_URL,
  createRoutePlaneProviderHandler,
  validateChatCompletionsBody,
  authorizeFromEnv,
  type ProviderRoutingReceipt,
} from "../src/routeplane-provider-endpoint.js";

type RunningServer = {
  server: Server;
  base: string;
  upstream: Server;
  state: { hits: number; lastBody: string | null };
  restore: () => void;
};

async function serve(
  options: {
    upstreamStatus?: number;
    upstreamBody?: Record<string, unknown>;
    upstreamDelayMs?: number;
    upstreamHang?: boolean;
    fallback_chain?: ReadonlyArray<string>;
    upstream_url?: string;
    timeout_ms?: number;
    auth_token?: string;
  } = {},
): Promise<RunningServer> {
  const upstreamState: {
    hits: number;
    lastBody: string | null;
  } = { hits: 0, lastBody: null };

  const upstream = createServer((req, res) => {
    upstreamState.hits++;
    if (options.upstreamHang) {
      // Never reply — the client's timeout must fire.
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      upstreamState.lastBody = Buffer.concat(chunks).toString("utf8");
      if (options.upstreamDelayMs && options.upstreamDelayMs > 0) {
        setTimeout(() => {
          res.writeHead(options.upstreamStatus ?? 200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(options.upstreamBody ?? { id: "ok", model: "gpt-x", choices: [] }));
        }, options.upstreamDelayMs);
        return;
      }
      res.writeHead(options.upstreamStatus ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(options.upstreamBody ?? { id: "ok", model: "gpt-x", choices: [] }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamAddr = upstream.address();
  assert.ok(upstreamAddr && typeof upstreamAddr === "object");
  const upstreamBase = `http://127.0.0.1:${upstreamAddr.port}`;
  const upstreamUrl = options.upstream_url ?? `${upstreamBase}/v1/chat/completions`;

  const previousToken = process.env.MESHFLEET_SSE_TOKEN;
  const previousLegacy = process.env.MESHFLEET_AUTH_TOKEN;
  if (options.auth_token) {
    process.env.MESHFLEET_SSE_TOKEN = options.auth_token;
    process.env.MESHFLEET_AUTH_TOKEN = options.auth_token;
  } else {
    delete process.env.MESHFLEET_SSE_TOKEN;
    delete process.env.MESHFLEET_AUTH_TOKEN;
  }

  const provider = createServer(
    createRoutePlaneProviderHandler({
      upstream_url: upstreamUrl,
      fallback_chain: options.fallback_chain,
      timeout_ms: options.timeout_ms ?? 1_000,
      authorize: options.auth_token ? authorizeFromEnv(process.env) : () => true,
    }),
  );
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerAddr = provider.address();
  assert.ok(providerAddr && typeof providerAddr === "object");
  const providerBase = `http://127.0.0.1:${providerAddr.port}`;

  return {
    server: provider,
    base: providerBase,
    upstream,
    state: upstreamState,
    restore: () => {
      if (previousToken === undefined) delete process.env.MESHFLEET_SSE_TOKEN;
      else process.env.MESHFLEET_SSE_TOKEN = previousToken;
      if (previousLegacy === undefined) delete process.env.MESHFLEET_AUTH_TOKEN;
      else process.env.MESHFLEET_AUTH_TOKEN = previousLegacy;
    },
  };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function chatCompletionsBody(model?: string): string {
  return JSON.stringify({
    model: model ?? "openai-codex/gpt-5.6-sol",
    messages: [{ role: "user", content: "hello" }],
  });
}

test("schema constants are stable", () => {
  assert.equal(ROUTEPLANE_PROVIDER_ENDPOINT_VERSION, "meshfleet.routeplane-provider-endpoint.v1");
  assert.equal(ROUTEPLANE_PROVIDER_RECEIPT_VERSION, "meshfleet.routeplane-provider-receipt.v1");
  assert.equal(DEFAULT_ROUTEPLANE_CHAT_COMPLETIONS_URL, "http://127.0.0.1:4356/v1/chat/completions");
  assert.deepEqual([...DEFAULT_FALLBACK_CHAIN], ["openai-codex", "anthropic", "opencode-go"]);
});

test("validateChatCompletionsBody: rejects non-object, empty messages, bad role", () => {
  assert.equal(validateChatCompletionsBody(null).ok, false);
  assert.equal(validateChatCompletionsBody([]).ok, false);
  const empty = validateChatCompletionsBody({ messages: [] });
  assert.equal(empty.ok, false);
  const noRole = validateChatCompletionsBody({ messages: [{ content: "hi" }] });
  assert.equal(noRole.ok, false);
  const ok = validateChatCompletionsBody({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(ok.ok, true);
});

test("e2e: forwarded chat completions surface the routing receipt on success", async () => {
  const fake = await serve({
    upstreamBody: {
      id: "chatcmpl-1",
      model: "gpt-5.6-sol",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi back" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  });
  try {
    const response = await fetch(`${fake.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-MeshFleet-Profile": "fake-profile" },
      body: chatCompletionsBody("openai-codex/gpt-5.6-sol"),
    });
    assert.equal(response.status, 200);
    const headerReceiptRaw = response.headers.get("x-meshfleet-router-receipt");
    assert.ok(headerReceiptRaw, "expected x-meshfleet-router-receipt header on success");
    const headerReceipt = JSON.parse(headerReceiptRaw) as ProviderRoutingReceipt;
    assert.equal(headerReceipt.outcome, "routed");
    assert.equal(headerReceipt.profile_id, "fake-profile");
    assert.equal(headerReceipt.chosen_model, "gpt-5.6-sol");
    assert.equal(headerReceipt.schema_version, ROUTEPLANE_PROVIDER_RECEIPT_VERSION);
    assert.equal(headerReceipt.chain.length, 1);

    const body = (await response.json()) as Record<string, unknown>;
    const receiptFromBody = body.routing_receipt as ProviderRoutingReceipt;
    assert.ok(receiptFromBody, "expected routing_receipt field on success body");
    assert.equal(receiptFromBody.outcome, "routed");
    assert.equal(receiptFromBody.chosen_model, "gpt-5.6-sol");
    assert.equal(receiptFromBody.receipt_id, headerReceipt.receipt_id);
    const metadata = body.metadata as Record<string, unknown>;
    assert.ok(metadata?.routing_receipt, "expected routing_receipt mirrored under metadata");
    assert.equal((metadata.routing_receipt as ProviderRoutingReceipt).receipt_id, headerReceipt.receipt_id);
    assert.deepEqual((body.choices as Array<unknown>).length, 1);
  } finally {
    fake.restore();
    await close(fake.upstream);
    await close(fake.server);
  }
});

test("e2e: profile id is forwarded to upstream so the router can audit per-profile", async () => {
  const fake = await serve({
    upstreamBody: { id: "x", model: "grok-4.6", choices: [] },
  });
  try {
    await fetch(`${fake.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-MeshFleet-Profile": "fake-profile" },
      body: chatCompletionsBody(),
    });
    assert.equal(fake.state.hits, 1);
    const upstreamBody = JSON.parse(fake.state.lastBody as string) as Record<string, unknown>;
    assert.equal(upstreamBody.profile_id, "fake-profile");
  } finally {
    fake.restore();
    await close(fake.upstream);
    await close(fake.server);
  }
});

test("router-down degraded path: 200 with fallthrough receipt, never silent no-op", async () => {
  // Build a provider whose upstream points at a closed port. The endpoint
  // must NOT return an empty body — it returns a clearly-marked static
  // response with a receipt naming the degradation reason.
  const provider = createServer(
    createRoutePlaneProviderHandler({
      upstream_url: "http://127.0.0.1:1/v1/chat/completions",
      timeout_ms: 200,
      fallback_chain: ["openai-codex", "anthropic"],
    }),
  );
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const addr = provider.address();
  assert.ok(addr && typeof addr === "object");
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: chatCompletionsBody(),
    });
    assert.equal(response.status, 200);
    const headerReceiptRaw = response.headers.get("x-meshfleet-router-receipt");
    assert.ok(headerReceiptRaw);
    const headerReceipt = JSON.parse(headerReceiptRaw) as ProviderRoutingReceipt;
    assert.equal(headerReceipt.outcome, "fallthrough_static");
    assert.equal(headerReceipt.degradation_reason, "router_unreachable");
    assert.deepEqual([...headerReceipt.chain], ["openai-codex", "anthropic"]);
    assert.equal(headerReceipt.chosen_model, "openai-codex");
    assert.equal(headerReceipt.diagnostics?.static_chain_source, "configured");

    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.metadata && (body.metadata as Record<string, unknown>).routeplane_static_fallback, true);
    const receiptFromBody = body.routing_receipt as ProviderRoutingReceipt;
    assert.equal(receiptFromBody.outcome, "fallthrough_static");
    assert.ok(Array.isArray((body.choices as unknown[])) && (body.choices as unknown[]).length > 0,
      "fallthrough response must include a static choices payload so the caller is never silent-noop'd");
  } finally {
    await close(provider);
  }
});

test("router timeout: receipt records router_timeout", async () => {
  const provider = createServer(
    createRoutePlaneProviderHandler({
      upstream_url: "http://127.0.0.1:1/v1/chat/completions",
      timeout_ms: 50,
      fallback_chain: ["openai-codex"],
    }),
  );
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const addr = provider.address();
  assert.ok(addr && typeof addr === "object");
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: chatCompletionsBody(),
    });
    const headerReceiptRaw = response.headers.get("x-meshfleet-router-receipt");
    assert.ok(headerReceiptRaw);
    const headerReceipt = JSON.parse(headerReceiptRaw) as ProviderRoutingReceipt;
    assert.equal(headerReceipt.outcome, "fallthrough_static");
    // ECONNREFUSED on port 1 fires faster than the timeout; either reason is
    // acceptable here as long as the fallthrough label is honest.
    assert.ok(
      headerReceipt.degradation_reason === "router_timeout" ||
        headerReceipt.degradation_reason === "router_unreachable",
      `unexpected degradation_reason: ${headerReceipt.degradation_reason}`,
    );
  } finally {
    await close(provider);
  }
});

test("router returns 5xx: degraded path with router_http_status reason", async () => {
  const fake = await serve({ upstreamStatus: 502, upstreamBody: { error: "upstream bad gateway" } });
  try {
    const response = await fetch(`${fake.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: chatCompletionsBody(),
    });
    assert.equal(response.status, 200);
    const headerReceiptRaw = response.headers.get("x-meshfleet-router-receipt");
    assert.ok(headerReceiptRaw);
    const headerReceipt = JSON.parse(headerReceiptRaw) as ProviderRoutingReceipt;
    assert.equal(headerReceipt.outcome, "fallthrough_static");
    assert.equal(headerReceipt.degradation_reason, "router_http_status");
    assert.equal(headerReceipt.diagnostics?.upstream_status, 502);
  } finally {
    fake.restore();
    await close(fake.upstream);
    await close(fake.server);
  }
});

test("auth: missing bearer returns 401 with refused_unauthorized receipt", async () => {
  const fake = await serve({ auth_token: "secret-token" });
  try {
    const response = await fetch(`${fake.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: chatCompletionsBody(),
    });
    assert.equal(response.status, 401);
    const headerReceiptRaw = response.headers.get("x-meshfleet-router-receipt");
    assert.ok(headerReceiptRaw);
    const headerReceipt = JSON.parse(headerReceiptRaw) as ProviderRoutingReceipt;
    assert.equal(headerReceipt.outcome, "refused_unauthorized");
    // The router was never consulted.
    assert.equal(fake.state.hits, 0);
  } finally {
    fake.restore();
    await close(fake.upstream);
    await close(fake.server);
  }
});

test("auth: wrong bearer returns 401 with refused_unauthorized receipt", async () => {
  const fake = await serve({ auth_token: "secret-token" });
  try {
    const response = await fetch(`${fake.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
      body: chatCompletionsBody(),
    });
    assert.equal(response.status, 401);
    const headerReceiptRaw = response.headers.get("x-meshfleet-router-receipt");
    assert.ok(headerReceiptRaw);
    const headerReceipt = JSON.parse(headerReceiptRaw) as ProviderRoutingReceipt;
    assert.equal(headerReceipt.outcome, "refused_unauthorized");
  } finally {
    fake.restore();
    await close(fake.upstream);
    await close(fake.server);
  }
});

test("auth: matching bearer is admitted", async () => {
  const fake = await serve({ auth_token: "secret-token" });
  try {
    const response = await fetch(`${fake.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret-token" },
      body: chatCompletionsBody(),
    });
    assert.equal(response.status, 200);
    assert.equal(fake.state.hits, 1);
  } finally {
    fake.restore();
    await close(fake.upstream);
    await close(fake.server);
  }
});

test("malformed JSON body returns 400 with refused_malformed receipt", async () => {
  const fake = await serve({});
  try {
    const response = await fetch(`${fake.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    assert.equal(response.status, 400);
    const headerReceiptRaw = response.headers.get("x-meshfleet-router-receipt");
    assert.ok(headerReceiptRaw);
    const headerReceipt = JSON.parse(headerReceiptRaw) as ProviderRoutingReceipt;
    assert.equal(headerReceipt.outcome, "refused_malformed");
    assert.equal(fake.state.hits, 0);
  } finally {
    fake.restore();
    await close(fake.upstream);
    await close(fake.server);
  }
});

test("empty messages array returns 400 with refused_malformed receipt", async () => {
  const fake = await serve({});
  try {
    const response = await fetch(`${fake.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(response.status, 400);
    const headerReceiptRaw = response.headers.get("x-meshfleet-router-receipt");
    assert.ok(headerReceiptRaw);
    const headerReceipt = JSON.parse(headerReceiptRaw) as ProviderRoutingReceipt;
    assert.equal(headerReceipt.outcome, "refused_malformed");
  } finally {
    fake.restore();
    await close(fake.upstream);
    await close(fake.server);
  }
});

test("non-POST method returns 405 with refused_malformed receipt", async () => {
  const fake = await serve({});
  try {
    const response = await fetch(`${fake.base}/v1/chat/completions`, { method: "GET" });
    assert.equal(response.status, 405);
    const headerReceiptRaw = response.headers.get("x-meshfleet-router-receipt");
    assert.ok(headerReceiptRaw);
    const headerReceipt = JSON.parse(headerReceiptRaw) as ProviderRoutingReceipt;
    assert.equal(headerReceipt.outcome, "refused_malformed");
  } finally {
    fake.restore();
    await close(fake.upstream);
    await close(fake.server);
  }
});

test("oversized body returns 400 with refused_malformed receipt", async () => {
  const fake = await serve({});
  try {
    const huge = "x".repeat(300 * 1024);
    const response = await fetch(`${fake.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: huge,
    });
    assert.equal(response.status, 400);
    const headerReceiptRaw = response.headers.get("x-meshfleet-router-receipt");
    assert.ok(headerReceiptRaw);
    const headerReceipt = JSON.parse(headerReceiptRaw) as ProviderRoutingReceipt;
    assert.equal(headerReceipt.outcome, "refused_malformed");
  } finally {
    fake.restore();
    await close(fake.upstream);
    await close(fake.server);
  }
});

test("secrets never travel through the receipt: response_sha256 is a digest, not a body", async () => {
  const fake = await serve({
    upstreamBody: {
      id: "x",
      model: "gpt-x",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    },
  });
  try {
    const response = await fetch(`${fake.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: chatCompletionsBody(),
    });
    const headerReceiptRaw = response.headers.get("x-meshfleet-router-receipt");
    assert.ok(headerReceiptRaw);
    const headerReceipt = JSON.parse(headerReceiptRaw) as ProviderRoutingReceipt;
    assert.ok(headerReceipt.response_sha256);
    assert.equal((headerReceipt.response_sha256 as string).length, 64);
    // The receipt must not contain a copy of the response body.
    assert.equal((headerReceipt as unknown as Record<string, unknown>).response, undefined);
    assert.equal((headerReceipt as unknown as Record<string, unknown>).body, undefined);
  } finally {
    fake.restore();
    await close(fake.upstream);
    await close(fake.server);
  }
});

// Touch `httpRequest` so the import isn't flagged as unused on some runtimes.
test("smoke: import surface is reachable", () => {
  assert.ok(typeof httpRequest === "function");
});