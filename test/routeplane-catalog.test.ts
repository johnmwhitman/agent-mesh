import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchRoutePlaneCatalog,
  normalizeRoutePlaneCatalog,
  RoutePlaneCatalogError,
  ROUTEPLANE_CATALOG_SNAPSHOT_VERSION,
} from "../src/routeplane-catalog.js";

const liveCatalog = {
  object: "list",
  data: [
    { id: "z-model", object: "model", providers: ["zeta", "alpha"] },
    { id: "a-model", object: "model", providers: ["beta"] },
  ],
};

test("normalizes a live-shaped RoutePlane catalog into a sorted, expiring snapshot", () => {
  const snapshot = normalizeRoutePlaneCatalog(liveCatalog, 1_700_000_000_000, 60_000);

  assert.deepEqual(snapshot, {
    version: ROUTEPLANE_CATALOG_SNAPSHOT_VERSION,
    source: {
      kind: "routeplane-v1-models",
      endpoint: "http://127.0.0.1:4356/v1/models",
      fetched_at_ms: 1_700_000_000_000,
      expires_at_ms: 1_700_000_060_000,
      payload_sha256: "0fc95b96522e2f6a326440a7b470e9ef98c54c5956f2a178b11766798a81f89e",
    },
    models: [
      { id: "a-model", providers: ["beta"] },
      { id: "z-model", providers: ["alpha", "zeta"] },
    ],
  });
});

test("gives semantically reordered live catalogs the same canonical digest", () => {
  const reordered = {
    object: "list",
    data: [
      { id: "a-model", object: "model", providers: ["beta"] },
      { id: "z-model", object: "model", providers: ["alpha", "zeta"] },
    ],
  };

  const first = normalizeRoutePlaneCatalog(liveCatalog, 100, 60_000);
  const second = normalizeRoutePlaneCatalog(reordered, 100, 60_000);

  assert.equal(first.source.payload_sha256, second.source.payload_sha256);
  assert.deepEqual(first.models, second.models);
});

test("rejects duplicate model IDs, unknown fields, and catalog bounds", () => {
  const validModel = { id: "model-a", object: "model", providers: ["provider-a"] };

  assert.throws(
    () => normalizeRoutePlaneCatalog({ object: "list", data: [validModel, validModel] }, 1, 1),
    /duplicate model id/i,
  );
  assert.throws(
    () => normalizeRoutePlaneCatalog({ ...liveCatalog, extra: true }, 1, 1),
    /not allowed/i,
  );
  assert.throws(
    () => normalizeRoutePlaneCatalog({ object: "list", data: [] }, 1, 0),
    /ttl_ms.*positive finite integer.*600000/i,
  );
  assert.throws(
    () => normalizeRoutePlaneCatalog({ object: "list", data: Array.from({ length: 1025 }, (_, index) => ({ ...validModel, id: `model-${index}` })) }, 1, 1),
    /0\.\.1024/i,
  );
});

test("rejects closed model fields and every required model and provider bound", () => {
  const validCatalog = {
    object: "list",
    data: [{ id: "model-a", object: "model", providers: ["provider-a"] }],
  };
  const invalidCases: Array<{ name: string; payload: unknown; expected: RegExp }> = [
    {
      name: "unknown model field",
      payload: { ...validCatalog, data: [{ ...validCatalog.data[0], endpoint: "forbidden" }] },
      expected: /payload\.data\[0\]\.endpoint.*not allowed/i,
    },
    {
      name: "duplicate provider label",
      payload: { ...validCatalog, data: [{ ...validCatalog.data[0], providers: ["provider-a", "provider-a"] }] },
      expected: /duplicate provider label/i,
    },
    {
      name: "empty model id",
      payload: { ...validCatalog, data: [{ ...validCatalog.data[0], id: "" }] },
      expected: /id.*non-empty string.*256/i,
    },
    {
      name: "overlength model id",
      payload: { ...validCatalog, data: [{ ...validCatalog.data[0], id: "m".repeat(257) }] },
      expected: /id.*non-empty string.*256/i,
    },
    {
      name: "empty provider label",
      payload: { ...validCatalog, data: [{ ...validCatalog.data[0], providers: [""] }] },
      expected: /providers\[0\].*non-empty string.*128/i,
    },
    {
      name: "overlength provider label",
      payload: { ...validCatalog, data: [{ ...validCatalog.data[0], providers: ["p".repeat(129)] }] },
      expected: /providers\[0\].*non-empty string.*128/i,
    },
    {
      name: "too many providers",
      payload: {
        ...validCatalog,
        data: [{ ...validCatalog.data[0], providers: Array.from({ length: 65 }, (_, index) => `provider-${index}`) }],
      },
      expected: /providers.*1\.\.64/i,
    },
  ];

  for (const { name, payload, expected } of invalidCases) {
    assert.throws(() => normalizeRoutePlaneCatalog(payload, 1, 1), expected, name);
  }
});

function validCatalogResponse(): Response {
  return Response.json(liveCatalog);
}

function hasCatalogError(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof RoutePlaneCatalogError);
    assert.equal(error.code, code);
    return true;
  };
}

test("fetches only the fixed loopback endpoint without headers and refuses redirects", async () => {
  let requestedUrl: string | undefined;
  let requestedInit: RequestInit | undefined;

  const snapshot = await fetchRoutePlaneCatalog({
    fetch_impl: async (url, init) => {
      requestedUrl = String(url);
      requestedInit = init;
      return validCatalogResponse();
    },
  });

  assert.equal(requestedUrl, "http://127.0.0.1:4356/v1/models");
  assert.equal(requestedInit?.method, "GET");
  assert.equal(requestedInit?.redirect, "error");
  assert.equal("headers" in (requestedInit ?? {}), false);
  assert.ok(requestedInit?.signal instanceof AbortSignal);
  assert.deepEqual(snapshot.models, [
    { id: "a-model", providers: ["beta"] },
    { id: "z-model", providers: ["alpha", "zeta"] },
  ]);
});

test("turns a refused redirect into a typed catalog error", async () => {
  await assert.rejects(
    fetchRoutePlaneCatalog({
      fetch_impl: async () => {
        throw new TypeError("fetch failed: redirect mode is set to error");
      },
    }),
    hasCatalogError("redirect"),
  );
});

test("turns a fetch timeout into a typed catalog error", async () => {
  let observedSignal: AbortSignal | undefined;

  await assert.rejects(
    fetchRoutePlaneCatalog({
      timeout_ms: 1,
      fetch_impl: async (_url, init) => {
        observedSignal = init?.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          observedSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    }),
    hasCatalogError("timeout"),
  );
  assert.equal(observedSignal?.aborted, true);
});

test("rejects non-success responses and invalid JSON with typed catalog errors", async () => {
  await assert.rejects(
    fetchRoutePlaneCatalog({ fetch_impl: async () => new Response("unavailable", { status: 503 }) }),
    hasCatalogError("http_status"),
  );
  await assert.rejects(
    fetchRoutePlaneCatalog({ fetch_impl: async () => new Response("{not json") }),
    hasCatalogError("invalid_json"),
  );
});

test("cancels the response reader and rejects bodies larger than one MiB", async () => {
  let cancelled = false;
  let chunk = 0;
  const oversizedBody = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunk === 0) {
        controller.enqueue(new Uint8Array(1_048_576));
      } else {
        controller.enqueue(new Uint8Array(1));
      }
      chunk += 1;
    },
    cancel() {
      cancelled = true;
    },
  });

  await assert.rejects(
    fetchRoutePlaneCatalog({ fetch_impl: async () => new Response(oversizedBody) }),
    hasCatalogError("body_too_large"),
  );
  assert.equal(cancelled, true);
});
