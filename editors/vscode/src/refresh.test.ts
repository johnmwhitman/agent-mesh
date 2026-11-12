import { test } from "node:test";
import assert from "node:assert/strict";
import { LatestStartedRefresh, type RefreshModel, type RefreshVerdict } from "./refresh.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function emptyModel(tag: string): RefreshModel & { tag: string } {
  return { fleets: [], councils: [], tag };
}

type Trace = {
  models: string[];
  statuses: string[];
  errors: string[];
};

function recordingUi(): { ui: import("./refresh.js").RefreshUi<RefreshModel & { tag: string }>; trace: Trace } {
  const trace: Trace = { models: [], statuses: [], errors: [] };
  return {
    trace,
    ui: {
      setModel: (model) => {
        trace.models.push(String((model as { tag: string }).tag));
      },
      setStatus: (verdict: RefreshVerdict) => {
        trace.statuses.push(`${verdict.ok ? "ok" : "bad"}:${verdict.summary}`);
      },
      setError: (message) => {
        trace.errors.push(message);
      },
    },
  };
}

test("older model finishing after a newer result does not replace the sidebar", async () => {
  const refresh = new LatestStartedRefresh<RefreshModel & { tag: string }>();
  const { ui, trace } = recordingUi();
  const olderModel = deferred<RefreshModel & { tag: string }>();
  const newerModel = deferred<RefreshModel & { tag: string }>();
  const newerVerify = deferred<RefreshVerdict>();

  const older = refresh.run(
    {
      loadModel: () => olderModel.promise,
      verifyLedger: async () => ({ ok: true, summary: "older-verify" }),
    },
    ui,
  );
  const newer = refresh.run(
    {
      loadModel: () => newerModel.promise,
      verifyLedger: () => newerVerify.promise,
    },
    ui,
  );

  newerModel.resolve(emptyModel("newer"));
  await Promise.resolve();
  newerVerify.resolve({ ok: true, summary: "newer-verify" });
  await newer;

  olderModel.resolve(emptyModel("older"));
  await older;

  assert.deepEqual(trace.models, ["newer"]);
  assert.deepEqual(trace.statuses, ["ok:newer-verify"]);
  assert.deepEqual(trace.errors, []);
});

test("older verification finishing late does not overwrite newer status", async () => {
  const refresh = new LatestStartedRefresh<RefreshModel & { tag: string }>();
  const { ui, trace } = recordingUi();
  const olderVerify = deferred<RefreshVerdict>();
  const newerVerify = deferred<RefreshVerdict>();

  const older = refresh.run(
    {
      loadModel: async () => emptyModel("older"),
      verifyLedger: () => olderVerify.promise,
    },
    ui,
  );
  await Promise.resolve();
  const newer = refresh.run(
    {
      loadModel: async () => emptyModel("newer"),
      verifyLedger: () => newerVerify.promise,
    },
    ui,
  );
  await Promise.resolve();

  newerVerify.resolve({ ok: true, summary: "newer-verify" });
  await newer;

  olderVerify.resolve({ ok: false, summary: "older-verify" });
  await older;

  assert.deepEqual(trace.models, ["older", "newer"]);
  assert.deepEqual(trace.statuses, ["ok:newer-verify"]);
  assert.deepEqual(trace.errors, []);
});

test("a late error from an older refresh does not overwrite a newer success", async () => {
  const refresh = new LatestStartedRefresh<RefreshModel & { tag: string }>();
  const { ui, trace } = recordingUi();
  const olderModel = deferred<RefreshModel & { tag: string }>();

  const older = refresh.run(
    {
      loadModel: () => olderModel.promise,
      verifyLedger: async () => ({ ok: true, summary: "unused" }),
    },
    ui,
  );
  const newer = refresh.run(
    {
      loadModel: async () => emptyModel("newer"),
      verifyLedger: async () => ({ ok: true, summary: "newer-verify" }),
    },
    ui,
  );
  await newer;

  olderModel.reject(new Error("stale CLI failure"));
  await older;

  assert.deepEqual(trace.models, ["newer"]);
  assert.deepEqual(trace.statuses, ["ok:newer-verify"]);
  assert.deepEqual(trace.errors, []);
});

test("the latest refresh error still reaches the current error path", async () => {
  const refresh = new LatestStartedRefresh<RefreshModel & { tag: string }>();
  const { ui, trace } = recordingUi();
  const olderModel = deferred<RefreshModel & { tag: string }>();
  const newerModel = deferred<RefreshModel & { tag: string }>();

  const older = refresh.run(
    {
      loadModel: () => olderModel.promise,
      verifyLedger: async () => ({ ok: true, summary: "unused" }),
    },
    ui,
  );
  const newer = refresh.run(
    {
      loadModel: () => newerModel.promise,
      verifyLedger: async () => ({ ok: true, summary: "unused" }),
    },
    ui,
  );

  newerModel.reject(new Error("CLI not found"));
  await newer;

  olderModel.resolve(emptyModel("older"));
  await older;

  assert.deepEqual(trace.models, []);
  assert.deepEqual(trace.statuses, []);
  assert.deepEqual(trace.errors, ["CLI not found"]);
});

test("a single refresh still stages model before verification", async () => {
  const refresh = new LatestStartedRefresh<RefreshModel & { tag: string }>();
  const order: string[] = [];
  const verify = deferred<RefreshVerdict>();

  const done = refresh.run(
    {
      loadModel: async () => emptyModel("only"),
      verifyLedger: () => verify.promise,
    },
    {
      setModel: (model) => {
        order.push(`model:${(model as { tag: string }).tag}`);
      },
      setStatus: (verdict) => {
        order.push(`status:${verdict.summary}`);
      },
      setError: (message) => {
        order.push(`error:${message}`);
      },
    },
  );

  await Promise.resolve();
  assert.deepEqual(order, ["model:only"]);

  verify.resolve({ ok: false, summary: "2 errors" });
  await done;
  assert.deepEqual(order, ["model:only", "status:2 errors"]);
});
