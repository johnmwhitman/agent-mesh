import { test } from "node:test";
import assert from "node:assert/strict";
import { annotateProxiedModelFailure } from "../src/spawn-attempt.js";

const ROUTED = "model 'minimax/minimax-m3' cannot be routed";

test("annotates a proxied-model routing failure with where it actually failed", () => {
  const out = annotateProxiedModelFailure(ROUTED, "routeplane/minimax/minimax-m3");
  assert.match(out, /proxied via 'routeplane'/);
  assert.match(out, /unreachable or has not loaded its catalog/);
  assert.ok(out.startsWith(ROUTED), "must preserve the original upstream text verbatim");
});

test("is idempotent — re-annotating does not stack", () => {
  const once = annotateProxiedModelFailure(ROUTED, "routeplane/minimax/minimax-m3");
  const twice = annotateProxiedModelFailure(once, "routeplane/minimax/minimax-m3");
  assert.equal(once, twice);
});

test("stays silent on unrelated failures (no noise on the common path)", () => {
  const credits = "Forbidden: You have run out of credits or need a subscription.";
  assert.equal(annotateProxiedModelFailure(credits, "routeplane/minimax/minimax-m3"), credits);
  assert.equal(annotateProxiedModelFailure(ROUTED, "minimax-coding-plan/MiniMax-M3"), ROUTED,
    "a different proxy whose inner model is absent from the text must not be annotated");
});

test("no model, no slash, or empty detail are all pass-through", () => {
  assert.equal(annotateProxiedModelFailure(ROUTED, undefined), ROUTED);
  assert.equal(annotateProxiedModelFailure(ROUTED, "bare-model"), ROUTED);
  assert.equal(annotateProxiedModelFailure("", "routeplane/x/y"), "");
});
