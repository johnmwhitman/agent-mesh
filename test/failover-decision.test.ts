/**
 * The failover decision, gate by gate.
 *
 * These are pure and run on every platform. The integration test next door proves a real agent
 * really hops; this proves the reasoning that sends it, including the three cases where the honest
 * answer is DON'T hop — which is the half an end-to-end test is worst at covering.
 *
 * The refusal detail below is the REAL one, measured 2026-07-31 when grok returned 402 during a
 * live fleet run. Inventing a plausible-looking provider error would test the pattern against my
 * own imagination of what providers say.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideFailover } from "../src/failover.js";

const ESC = String.fromCharCode(27);
/** The observed grok refusal, ANSI and all — it matched on its `API 429 for` line. */
const REAL_REFUSAL =
  `${ESC}[0m\n> ultraworker · grok-4.3\n${ESC}[0m\n` +
  "opencode-claude-auth: API 429 for claude-haiku-4-5: This request would exceed your account's " +
  `rate limit. Please try again later.\n${ESC}[91m${ESC}[1mError: ${ESC}[0mForbidden: You have ` +
  "run out of credits or need a Grok subscription.\nSpawn failed with exit code 1";

const acceptAll = () => true;

test("a provider refusal hops to the other runtime", () => {
  const d = decideFailover({
    available: ["kimi-cli", "opencode-cli"],
    attempted: ["opencode-cli"],
    failureDetail: REAL_REFUSAL,
    accepts: acceptAll,
  });
  assert.deepEqual(d, { hop: true, to: "kimi-cli" });
});

test("a failure that is NOT a provider refusal stays put", () => {
  // The amplification case. Without this gate a malformed prompt burns every subscription in turn
  // to re-learn one bug, and the cost grows with each adapter added.
  for (const detail of [
    "Spawn failed with exit code 1",
    "Invalid Kimi stream-json output: malformed JSONL frame",
    "Spawn exited without output (empty stdout)",
    "Kimi timed out after 1800000ms",
  ]) {
    const d = decideFailover({
      available: ["kimi-cli", "opencode-cli"],
      attempted: ["opencode-cli"],
      failureDetail: detail,
      accepts: acceptAll,
    });
    assert.deepEqual(d, { hop: false, reason: "not_a_provider_refusal" }, `should not hop on: ${detail}`);
  }
});

test("a pinned model is never carried to another harness", () => {
  // `kimi.ts` accepts any bounded string as requestedModel, so a hop would hand
  // `opencode-go/minimax-m3` to `kimi --model` and run something the caller never named.
  const d = decideFailover({
    available: ["kimi-cli", "opencode-cli"],
    attempted: ["opencode-cli"],
    failureDetail: REAL_REFUSAL,
    requestedModel: "opencode-go/minimax-m3",
    accepts: acceptAll,
  });
  assert.deepEqual(d, { hop: false, reason: "model_is_pinned" });
});

test("a runtime that already refused is never re-offered", () => {
  const d = decideFailover({
    available: ["kimi-cli", "opencode-cli"],
    attempted: ["opencode-cli", "kimi-cli"],
    failureDetail: REAL_REFUSAL,
    accepts: acceptAll,
  });
  assert.deepEqual(d, { hop: false, reason: "no_candidate_accepts" });
});

test("a candidate that cannot accept the spec is skipped, not chosen", () => {
  // The real instance: Kimi refuses every permission mode without an admitted workspace binding,
  // so hopping to it would spend an attempt on a spec it was always going to reject.
  const d = decideFailover({
    available: ["kimi-cli", "opencode-cli"],
    attempted: ["opencode-cli"],
    failureDetail: REAL_REFUSAL,
    accepts: (id) => id !== "kimi-cli",
  });
  assert.deepEqual(d, { hop: false, reason: "no_candidate_accepts" });
});

test("with only the default runtime registered there is nowhere to go", () => {
  // Every deployment that configures nothing is in this state, and must behave exactly as before.
  const d = decideFailover({
    available: ["opencode-cli"],
    attempted: ["opencode-cli"],
    failureDetail: REAL_REFUSAL,
    accepts: acceptAll,
  });
  assert.deepEqual(d, { hop: false, reason: "no_candidate_accepts" });
});

test("the first ACCEPTING candidate wins, not merely the first candidate", () => {
  const d = decideFailover({
    available: ["a-cli", "b-cli", "opencode-cli"],
    attempted: ["opencode-cli"],
    failureDetail: REAL_REFUSAL,
    accepts: (id) => id === "b-cli",
  });
  assert.deepEqual(d, { hop: true, to: "b-cli" });
});

test("the gates are ordered so a pinned model beats an available candidate", () => {
  // If these two gates were swapped, a pinned-model agent would hop and quietly run the wrong
  // model. Asserting the ORDER, not just that both exist.
  const d = decideFailover({
    available: ["kimi-cli", "opencode-cli"],
    attempted: ["opencode-cli"],
    failureDetail: REAL_REFUSAL,
    requestedModel: "opencode-go/minimax-m3",
    accepts: acceptAll,
  });
  assert.equal(d.hop, false);
  assert.equal((d as { reason: string }).reason, "model_is_pinned");
});
