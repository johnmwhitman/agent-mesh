import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileRoutePlaneCandidates,
  fetchRoutePlaneCatalog,
  normalizeRoutePlaneCatalog,
  recommendRoutePlaneCatalog,
  RoutePlaneCatalogError,
  ROUTEPLANE_CATALOG_SNAPSHOT_VERSION,
} from "../src/routeplane-catalog.js";

const routePlaneEffects = {
  persisted: false,
  executed: false,
  authorized: false,
  woke_agents: false,
  contacted_providers: false,
} as const;

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

test("changes the catalog digest when models or their providers change", () => {
  const baseline = normalizeRoutePlaneCatalog(liveCatalog, 100, 60_000);
  const added = normalizeRoutePlaneCatalog(
    { ...liveCatalog, data: [...liveCatalog.data, { id: "new-model", object: "model", providers: ["gamma"] }] },
    100,
    60_000,
  );
  const removed = normalizeRoutePlaneCatalog(
    { ...liveCatalog, data: [liveCatalog.data[0]!] },
    100,
    60_000,
  );
  const providerChanged = normalizeRoutePlaneCatalog(
    { ...liveCatalog, data: [{ ...liveCatalog.data[0]!, providers: ["zeta"] }, liveCatalog.data[1]!] },
    100,
    60_000,
  );

  assert.notEqual(added.source.payload_sha256, baseline.source.payload_sha256);
  assert.notEqual(removed.source.payload_sha256, baseline.source.payload_sha256);
  assert.notEqual(providerChanged.source.payload_sha256, baseline.source.payload_sha256);
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

test("rejects invalid timeout values before contacting RoutePlane", async () => {
  for (const timeout_ms of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 600_001]) {
    let fetchCalls = 0;
    await assert.rejects(
      fetchRoutePlaneCatalog({
        timeout_ms,
        fetch_impl: async () => {
          fetchCalls += 1;
          return validCatalogResponse();
        },
      }),
      /timeout_ms.*positive finite integer.*600000/i,
    );
    assert.equal(fetchCalls, 0, `timeout_ms=${String(timeout_ms)}`);
  }
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

test("turns an aborted stalled response body into a typed timeout", async () => {
  let cancelled = false;
  const stalledBody = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {});
    },
    cancel() {
      cancelled = true;
    },
  });

  await assert.rejects(
    fetchRoutePlaneCatalog({
      timeout_ms: 10,
      fetch_impl: async () => new Response(stalledBody),
    }),
    hasCatalogError("timeout"),
  );
  assert.equal(cancelled, true);
});

test("turns a response stream read error into a typed body-read failure", async () => {
  const failingBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("stream exploded"));
    },
  });

  await assert.rejects(
    fetchRoutePlaneCatalog({ fetch_impl: async () => new Response(failingBody) }),
    hasCatalogError("body_read_failed"),
  );
});

test("compiles only exactly advertised RoutePlane models with caller-owned traits", () => {
  const snapshot = normalizeRoutePlaneCatalog(liveCatalog, 1_700_000_000_000, 60_000);
  const compilation = compileRoutePlaneCandidates({
    snapshot,
    now_ms: 1_700_000_000_030,
    policies: [
      {
        candidate_id: "lane-z",
        model: "z-model",
        capabilities: ["code"],
        privacy: "local_only",
        locality: "same_host",
        coordination_modes: ["solo"],
        policy_tags: ["private"],
        context_window: 4_096,
      },
      {
        candidate_id: "lane-missing",
        model: "missing-model",
        capabilities: ["chat"],
        privacy: "unrestricted",
        locality: "any",
      },
    ],
  });

  assert.equal(compilation.projection, true);
  assert.deepEqual(compilation.effects, routePlaneEffects);
  assert.deepEqual(compilation.source, snapshot.source);
  assert.deepEqual(compilation.candidates, [
    {
      candidate_id: "lane-z",
      capabilities: ["code"],
      privacy: "local_only",
      locality: "same_host",
      coordination_modes: ["solo"],
      policy_tags: ["private"],
      context_window: 4_096,
      budget: { measured: false },
      requested_identity: { runtime: "routeplane", model: "z-model" },
    },
  ]);
  assert.equal("observed_identity" in compilation.candidates[0]!, false);
  assert.deepEqual(compilation.diagnostics, [
    { candidate_id: "lane-missing", reason_codes: ["MODEL_NOT_ADVERTISED"] },
    { candidate_id: "lane-z", reason_codes: ["OBSERVATION_MISSING", "BUDGET_UNMEASURED"] },
  ]);
});

test("recommends exactly advertised RoutePlane policies", () => {
  const snapshot = normalizeRoutePlaneCatalog(liveCatalog, 100, 60_000);

  const result = recommendRoutePlaneCatalog({
    snapshot,
    now_ms: 100,
    policies: [{
      candidate_id: "lane-a",
      model: "a-model",
      capabilities: ["code"],
      privacy: "network_ok",
      locality: "any",
    }],
    task: {
      required_capabilities: ["code"],
      privacy: "network_ok",
      locality: "any",
    },
  });

  assert.equal(result.status, "evaluated");
  assert.equal(result.advisory, true);
  assert.deepEqual(result.effects, routePlaneEffects);
  assert.deepEqual(result.source, snapshot.source);
  assert.deepEqual(result.compilation, {
    compiler_version: "meshfleet.route-candidates.v0.1",
    projection: true,
    diagnostics: [{ candidate_id: "lane-a", reason_codes: ["OBSERVATION_MISSING", "BUDGET_UNMEASURED"] }],
  });
  assert.deepEqual(result.ranked.map(({ candidate_id, identity }) => ({ candidate_id, identity })), [{
    candidate_id: "lane-a",
    identity: {
      requested: { runtime: "routeplane", model: "a-model" },
      evidence_only: true,
      status: "unobserved",
    },
  }]);
  assert.deepEqual(result.excluded, []);
});

test("rejects malformed recommendation tasks when no catalog candidates compile", () => {
  const snapshot = normalizeRoutePlaneCatalog({ object: "list", data: [] }, 100, 60_000);

  assert.throws(
    () => recommendRoutePlaneCatalog({
      snapshot,
      now_ms: 100,
      policies: [],
      task: { prompt: "secret" } as never,
    }),
    /recommend_route: 'task\.prompt' is not allowed/,
  );
});

test("keeps catalog diagnostics distinct when a policy model is missing", () => {
  const snapshot = normalizeRoutePlaneCatalog(liveCatalog, 100, 60_000);
  const result = recommendRoutePlaneCatalog({
    snapshot,
    now_ms: 100,
    policies: [{
      candidate_id: "lane-missing",
      model: "not-advertised",
      capabilities: ["code"],
      privacy: "network_ok",
      locality: "any",
    }],
    task: { required_capabilities: ["code"], privacy: "network_ok", locality: "any" },
  });

  assert.equal(result.status, "no_compiled_candidates");
  assert.deepEqual(result.compilation.diagnostics, [
    { candidate_id: "lane-missing", reason_codes: ["MODEL_NOT_ADVERTISED"] },
  ]);
  assert.deepEqual(result.ranked, []);
  assert.deepEqual(result.excluded, []);
});

test("excludes only measured exhausted budget after compiling RoutePlane policy evidence", () => {
  const snapshot = normalizeRoutePlaneCatalog(liveCatalog, 100, 60_000);
  const result = recommendRoutePlaneCatalog({
    snapshot,
    now_ms: 100,
    policies: [{
      candidate_id: "lane-a",
      model: "a-model",
      capabilities: ["code"],
      privacy: "network_ok",
      locality: "any",
    }],
    observations: [{
      candidate_id: "lane-a",
      status: "exhausted",
      confidence: "measured",
      budget: { used: 10, total: 10 },
    }],
    task: { required_capabilities: ["code"], privacy: "network_ok", locality: "any" },
  });

  assert.equal(result.status, "evaluated");
  assert.deepEqual(result.compilation.diagnostics, [
    { candidate_id: "lane-a", reason_codes: ["BUDGET_EXHAUSTED_EVIDENCE"] },
  ]);
  assert.deepEqual(result.ranked, []);
  assert.deepEqual(result.excluded, [
    { candidate_id: "lane-a", reason_codes: ["BUDGET_EXHAUSTED"] },
  ]);
});

test("keeps unmeasured budget neutral for an advertised RoutePlane policy", () => {
  const snapshot = normalizeRoutePlaneCatalog(liveCatalog, 100, 60_000);
  const result = recommendRoutePlaneCatalog({
    snapshot,
    now_ms: 100,
    policies: [{
      candidate_id: "lane-a",
      model: "a-model",
      capabilities: ["code"],
      privacy: "network_ok",
      locality: "any",
    }],
    task: { required_capabilities: ["code"], privacy: "network_ok", locality: "any" },
  });

  assert.deepEqual(result.compilation.diagnostics, [
    { candidate_id: "lane-a", reason_codes: ["OBSERVATION_MISSING", "BUDGET_UNMEASURED"] },
  ]);
  assert.deepEqual(result.ranked.map(({ candidate_id, budget, reason_codes }) => ({
    candidate_id,
    budget,
    reason_codes,
  })), [{
    candidate_id: "lane-a",
    budget: { measured: false, status: "unmeasured" },
    reason_codes: ["OUTCOMES_UNMEASURED", "BUDGET_UNMEASURED"],
  }]);
  assert.deepEqual(result.excluded, []);
});

test("does not infer recommendation authority from RoutePlane provider labels", () => {
  const baselineSnapshot = normalizeRoutePlaneCatalog(liveCatalog, 100, 60_000);
  const relabeledSnapshot = normalizeRoutePlaneCatalog({
    ...liveCatalog,
    data: [
      liveCatalog.data[0]!,
      { ...liveCatalog.data[1]!, providers: ["budget-available", "unrestricted"] },
    ],
  }, 100, 60_000);
  const input = {
    now_ms: 100,
    policies: [{
      candidate_id: "lane-a",
      model: "a-model",
      capabilities: ["code"],
      privacy: "network_ok" as const,
      locality: "any" as const,
    }],
    task: { required_capabilities: ["code"], privacy: "network_ok" as const, locality: "any" as const },
  };
  const baseline = recommendRoutePlaneCatalog({ snapshot: baselineSnapshot, ...input });
  const relabeled = recommendRoutePlaneCatalog({ snapshot: relabeledSnapshot, ...input });
  const { source: baselineSource, ...baselineAuthority } = baseline;
  const { source: relabeledSource, ...relabeledAuthority } = relabeled;

  assert.notEqual(relabeledSource.payload_sha256, baselineSource.payload_sha256);
  assert.deepEqual(relabeledAuthority, baselineAuthority);
});

test("returns typed empty advisory with sorted diagnostics for catalog misses", () => {
  const snapshot = normalizeRoutePlaneCatalog({ object: "list", data: [] }, 100, 60_000);
  const policies = [
    {
      candidate_id: "lane-z",
      model: "z-model",
      capabilities: ["code"],
      privacy: "network_ok" as const,
      locality: "any" as const,
    },
    {
      candidate_id: "lane-a",
      model: "a-model",
      capabilities: ["code"],
      privacy: "network_ok" as const,
      locality: "any" as const,
    },
  ];
  const task = { required_capabilities: ["code"], privacy: "network_ok" as const, locality: "any" as const };

  for (const top_n of [1, 256]) {
    const result = recommendRoutePlaneCatalog({ snapshot, policies, task, now_ms: 100, top_n });
    assert.equal(result.status, "no_compiled_candidates");
    assert.equal(result.advisory, true);
    assert.deepEqual(result.effects, routePlaneEffects);
    assert.deepEqual(result.source, snapshot.source);
    assert.deepEqual(result.compilation, {
      compiler_version: "meshfleet.route-candidates.v0.1",
      projection: true,
      diagnostics: [
        { candidate_id: "lane-a", reason_codes: ["MODEL_NOT_ADVERTISED"] },
        { candidate_id: "lane-z", reason_codes: ["MODEL_NOT_ADVERTISED"] },
      ],
    });
    assert.deepEqual(result.ranked, []);
    assert.deepEqual(result.excluded, []);
  }
});

test("rejects stale RoutePlane recommendation snapshots", () => {
  const snapshot = normalizeRoutePlaneCatalog(liveCatalog, 100, 60_000);
  const input = {
    snapshot,
    policies: [{
      candidate_id: "lane-a",
      model: "a-model",
      capabilities: ["code"],
      privacy: "network_ok" as const,
      locality: "any" as const,
    }],
    task: { required_capabilities: ["code"], privacy: "network_ok" as const, locality: "any" as const },
  };

  assert.throws(
    () => recommendRoutePlaneCatalog({ ...input, now_ms: 99 }),
    /compile_routeplane_candidates: 'snapshot' is future-dated/,
  );
  assert.throws(
    () => recommendRoutePlaneCatalog({ ...input, now_ms: 60_100 }),
    /compile_routeplane_candidates: 'snapshot' is expired/,
  );
});

test("rejects invalid RoutePlane recommendation top_n", () => {
  const snapshot = normalizeRoutePlaneCatalog(liveCatalog, 100, 60_000);
  const input = {
    snapshot,
    now_ms: 100,
    policies: [{
      candidate_id: "lane-a",
      model: "a-model",
      capabilities: ["code"],
      privacy: "network_ok" as const,
      locality: "any" as const,
    }],
    task: { required_capabilities: ["code"], privacy: "network_ok" as const, locality: "any" as const },
  };

  for (const top_n of [0, -1, 257, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    assert.throws(
      () => recommendRoutePlaneCatalog({ ...input, top_n }),
      /compile_routeplane_candidates: 'top_n' must be a finite integer between 1 and 256/,
      `top_n=${String(top_n)}`,
    );
  }
  assert.throws(
    () => recommendRoutePlaneCatalog({ ...input, top_n: 2 }),
    /recommend_route: 'top_n' cannot exceed candidates\.length/,
  );
});

test("RoutePlane catalog recommendation is deterministic and does not mutate input", () => {
  const input = {
    snapshot: normalizeRoutePlaneCatalog(liveCatalog, 100, 60_000),
    policies: [
      {
        candidate_id: "lane-a",
        model: "a-model",
        capabilities: ["code"],
        privacy: "network_ok" as const,
        locality: "any" as const,
      },
      {
        candidate_id: "lane-z",
        model: "z-model",
        capabilities: ["code"],
        privacy: "network_ok" as const,
        locality: "any" as const,
      },
      {
        candidate_id: "lane-missing",
        model: "not-advertised",
        capabilities: ["code"],
        privacy: "network_ok" as const,
        locality: "any" as const,
      },
    ],
    observations: [
      {
        candidate_id: "lane-a",
        status: "green" as const,
        confidence: "measured" as const,
        budget: { used: 1, total: 2 },
      },
      {
        candidate_id: "lane-z",
        status: "green" as const,
        confidence: "measured" as const,
        budget: { used: 1, total: 2 },
      },
      {
        candidate_id: "lane-missing",
        status: "green" as const,
        confidence: "assumed" as const,
      },
    ],
    task: { required_capabilities: ["code"], privacy: "network_ok" as const, locality: "any" as const },
    now_ms: 100,
    top_n: 2,
  };
  const before = structuredClone(input);
  const permuted = structuredClone(input);
  permuted.policies.reverse();
  permuted.observations.reverse();
  const permutedBefore = structuredClone(permuted);

  const first = recommendRoutePlaneCatalog(input);
  const second = recommendRoutePlaneCatalog(input);
  const permutedResult = recommendRoutePlaneCatalog(permuted);

  assert.deepEqual(input, before);
  assert.deepEqual(permuted, permutedBefore);
  assert.deepEqual(second, first);
  assert.deepEqual(permutedResult, first);
  assert.deepEqual(first.ranked.map(({ candidate_id }) => candidate_id), ["lane-a", "lane-z"]);
});

test("rejects expired, future-dated, malformed, and unknown-version catalog snapshots", () => {
  const snapshot = normalizeRoutePlaneCatalog(liveCatalog, 100, 60_000);
  const policies = [{
    candidate_id: "lane-a",
    model: "a-model",
    capabilities: ["code"],
    privacy: "network_ok" as const,
    locality: "any" as const,
  }];

  assert.throws(
    () => compileRoutePlaneCandidates({ snapshot, policies, now_ms: 60_100 }),
    /snapshot.*expired/i,
  );
  assert.throws(
    () => compileRoutePlaneCandidates({ snapshot, policies, now_ms: 99 }),
    /snapshot.*future/i,
  );
  assert.throws(
    () => compileRoutePlaneCandidates({ snapshot: { ...snapshot, version: "wrong" }, policies, now_ms: 100 }),
    /snapshot\.version.*meshfleet\.routeplane-model-snapshot\.v1/i,
  );
  assert.throws(
    () => compileRoutePlaneCandidates({ snapshot: { ...snapshot, models: [{ id: "a-model", providers: ["beta", "beta"] }] }, policies, now_ms: 100 }),
    /duplicate provider label/i,
  );
});

test("returns an empty, side-effect-free compilation when no policy model is advertised", () => {
  const snapshot = normalizeRoutePlaneCatalog({ object: "list", data: [] }, 100, 60_000);
  const compilation = compileRoutePlaneCandidates({
    snapshot,
    now_ms: 100,
    policies: [{
      candidate_id: "lane-missing",
      model: "not-advertised",
      capabilities: ["code"],
      privacy: "network_ok",
      locality: "any",
    }],
  });

  assert.equal(compilation.projection, true);
  assert.deepEqual(compilation.effects, routePlaneEffects);
  assert.deepEqual(compilation.candidates, []);
  assert.deepEqual(compilation.diagnostics, [
    { candidate_id: "lane-missing", reason_codes: ["MODEL_NOT_ADVERTISED"] },
  ]);
});

test("ignores observations for unadvertised policies while retaining eligible observations", () => {
  const snapshot = normalizeRoutePlaneCatalog(liveCatalog, 100, 60_000);
  const compilation = compileRoutePlaneCandidates({
    snapshot,
    now_ms: 100,
    policies: [
      {
        candidate_id: "lane-a",
        model: "a-model",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
      },
      {
        candidate_id: "lane-missing",
        model: "not-advertised",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
      },
    ],
    observations: [
      { candidate_id: "lane-a", status: "green", confidence: "measured", budget: { used: 1, total: 2 } },
      { candidate_id: "lane-missing", status: "green", confidence: "assumed" },
    ],
  });

  assert.deepEqual(compilation.candidates, [{
    candidate_id: "lane-a",
    capabilities: ["code"],
    privacy: "network_ok",
    locality: "any",
    budget: { measured: true, used: 1, total: 2 },
    requested_identity: { runtime: "routeplane", model: "a-model" },
  }]);
  assert.deepEqual(compilation.diagnostics, [
    { candidate_id: "lane-a", reason_codes: [] },
    { candidate_id: "lane-missing", reason_codes: ["MODEL_NOT_ADVERTISED"] },
  ]);
});

test("rejects duplicate policy IDs before advertised-model partitioning", () => {
  const snapshot = normalizeRoutePlaneCatalog(liveCatalog, 100, 60_000);
  assert.throws(
    () => compileRoutePlaneCandidates({
      snapshot,
      now_ms: 100,
      policies: [
        { candidate_id: "lane-a", model: "a-model", capabilities: ["code"], privacy: "network_ok", locality: "any" },
        { candidate_id: "lane-a", model: "not-advertised", capabilities: ["code"], privacy: "network_ok", locality: "any" },
      ],
      observations: [{ candidate_id: "lane-a", status: "green", confidence: "assumed" }],
    }),
    /policies\[1\]\.candidate_id.*duplicate candidate_id 'lane-a'/i,
  );
});

test("does not derive authority from RoutePlane provider labels", () => {
  const snapshot = normalizeRoutePlaneCatalog({
    object: "list",
    data: [{ id: "model-a", object: "model", providers: ["unrestricted", "budget-available"] }],
  }, 100, 60_000);
  const compilation = compileRoutePlaneCandidates({
    snapshot,
    now_ms: 100,
    policies: [{
      candidate_id: "lane-a",
      model: "model-a",
      capabilities: ["code"],
      privacy: "local_only",
      locality: "same_host",
    }],
  });

  assert.deepEqual(compilation.candidates[0], {
    candidate_id: "lane-a",
    capabilities: ["code"],
    privacy: "local_only",
    locality: "same_host",
    budget: { measured: false },
    requested_identity: { runtime: "routeplane", model: "model-a" },
  });
});
