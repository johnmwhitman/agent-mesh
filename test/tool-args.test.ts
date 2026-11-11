import { test } from "node:test";
import assert from "node:assert/strict";
import {
  firstError,
  requireString,
  requirePresentString,
  optionalNonBlankString,
  requireBoolean,
  requireNumber,
  optionalBoolean,
  optionalNumber,
  optionalModelSelector,
  requireStringArray,
  requireEnum,
} from "../src/tool-args.js";

// ---------------------------------------------------------------------------
// firstError
// ---------------------------------------------------------------------------

test("firstError returns null when given no arguments or all nulls", () => {
  assert.equal(firstError(), null);
  assert.equal(firstError(null), null);
  assert.equal(firstError(null, null, null), null);
});

test("firstError returns the first non-null error string", () => {
  assert.equal(firstError("first bad", "second bad"), "first bad");
  assert.equal(firstError(null, "first non-null", "later non-null"), "first non-null");
  assert.equal(firstError(null, null, "only non-null"), "only non-null");
});

// ---------------------------------------------------------------------------
// requireString
// ---------------------------------------------------------------------------

test("requireString accepts valid non-empty strings", () => {
  assert.equal(requireString("my_tool", "agent_id", "agent-123"), null);
  assert.equal(requireString("my_tool", "description", "a"), null);
  assert.equal(requireString("my_tool", "role", "Lead Engineer"), null);
});

test("requireString rejects missing and undefined values", () => {
  const err = requireString("my_tool", "agent_id", undefined);
  assert.match(err!, /my_tool: 'agent_id' is required and must be a non-empty string, got undefined \(undefined\)/);
});

test("requireString rejects null values", () => {
  const err = requireString("my_tool", "agent_id", null);
  assert.match(err!, /my_tool: 'agent_id' is required and must be a non-empty string, got null \(null\)/);
});

test("requireString rejects empty or blank strings", () => {
  const errEmpty = requireString("my_tool", "agent_id", "");
  assert.match(errEmpty!, /my_tool: 'agent_id' is required and must be a non-empty string, got "" \(string\)/);

  const errSpaces = requireString("my_tool", "agent_id", "   ");
  assert.match(errSpaces!, /my_tool: 'agent_id' is required and must be a non-empty string, got "   " \(string\)/);

  const errTabs = requireString("my_tool", "agent_id", "\t\n");
  assert.match(errTabs!, /my_tool: 'agent_id' is required and must be a non-empty string/);
});

test("requireString rejects wrong types (number, boolean, object, array)", () => {
  assert.match(
    requireString("my_tool", "agent_id", 123)!,
    /got 123 \(number\)/
  );
  assert.match(
    requireString("my_tool", "agent_id", true)!,
    /got true \(boolean\)/
  );
  assert.match(
    requireString("my_tool", "agent_id", false)!,
    /got false \(boolean\)/
  );
  assert.match(
    requireString("my_tool", "agent_id", {})!,
    /got {} \(object\)/
  );
  assert.match(
    requireString("my_tool", "agent_id", ["agent-1"])!,
    /got \["agent-1"\] \(object\)/
  );
});

test("requireString handles snake_case payload vs camelCase mismatches", () => {
  // Wire payloads arrive as snake_case (e.g. { agent_id: "a1", fleet_id: "f1" }).
  // When accessed via camelCase directly (e.g. payload.agentId), it is undefined.
  const wirePayload: Record<string, unknown> = {
    agent_id: "agent-123",
    fleet_id: "fleet-456",
  };

  // Valid extraction using snake_case key:
  assert.equal(requireString("register_capability", "agent_id", wirePayload["agent_id"]), null);
  assert.equal(requireString("register_capability", "fleet_id", wirePayload["fleet_id"]), null);

  // Defect case: accessing camelCase key on snake_case wire payload produces undefined:
  const err = requireString("register_capability", "agentId", wirePayload["agentId"]);
  assert.match(err!, /register_capability: 'agentId' is required and must be a non-empty string, got undefined/);
});

// ---------------------------------------------------------------------------
// requirePresentString
// ---------------------------------------------------------------------------

test("requirePresentString accepts valid strings including empty strings", () => {
  assert.equal(requirePresentString("ask_peer", "payload", "hello world"), null);
  assert.equal(requirePresentString("ask_peer", "payload", ""), null);
  assert.equal(requirePresentString("ask_peer", "payload", "   "), null);
});

test("requirePresentString rejects missing or undefined values", () => {
  const err = requirePresentString("ask_peer", "payload", undefined);
  assert.match(err!, /ask_peer: 'payload' is required and must be a string, got undefined \(undefined\)/);
});

test("requirePresentString rejects null values", () => {
  const err = requirePresentString("ask_peer", "payload", null);
  assert.match(err!, /ask_peer: 'payload' is required and must be a string, got null \(null\)/);
});

test("requirePresentString rejects wrong types (number, boolean, object, array)", () => {
  assert.match(
    requirePresentString("ask_peer", "payload", 42)!,
    /got 42 \(number\)/
  );
  assert.match(
    requirePresentString("ask_peer", "payload", false)!,
    /got false \(boolean\)/
  );
  assert.match(
    requirePresentString("ask_peer", "payload", {})!,
    /got {} \(object\)/
  );
  assert.match(
    requirePresentString("ask_peer", "payload", [])!,
    /got \[\] \(object\)/
  );
});

test("requirePresentString handles snake_case payload vs camelCase mismatches", () => {
  const wirePayload: Record<string, unknown> = {
    message_body: "contents",
  };
  assert.equal(requirePresentString("send_message", "message_body", wirePayload["message_body"]), null);
  assert.match(
    requirePresentString("send_message", "messageBody", wirePayload["messageBody"])!,
    /got undefined/
  );
});

// ---------------------------------------------------------------------------
// optionalNonBlankString
// ---------------------------------------------------------------------------

test("optionalNonBlankString accepts undefined (omitted) and valid non-blank strings", () => {
  assert.equal(optionalNonBlankString("register_capability", "model", undefined), null);
  assert.equal(optionalNonBlankString("register_capability", "model", "claude-3-5-sonnet"), null);
});

test("optionalNonBlankString rejects null (explicit non-string value)", () => {
  const err = optionalNonBlankString("register_capability", "model", null);
  assert.match(err!, /register_capability: 'model' must be a non-empty string when provided, got null \(null\)/);
});

test("optionalNonBlankString rejects empty and blank strings when provided", () => {
  assert.match(
    optionalNonBlankString("register_capability", "model", "")!,
    /must be a non-empty string when provided, got "" \(string\)/
  );
  assert.match(
    optionalNonBlankString("register_capability", "model", "   ")!,
    /must be a non-empty string when provided, got "   " \(string\)/
  );
});

test("optionalNonBlankString rejects wrong types when provided (number, boolean, object, array)", () => {
  assert.match(
    optionalNonBlankString("register_capability", "model", 123)!,
    /got 123 \(number\)/
  );
  assert.match(
    optionalNonBlankString("register_capability", "model", true)!,
    /got true \(boolean\)/
  );
  assert.match(
    optionalNonBlankString("register_capability", "model", {})!,
    /got {} \(object\)/
  );
  assert.match(
    optionalNonBlankString("register_capability", "model", ["m1"])!,
    /got \["m1"\] \(object\)/
  );
});

test("optionalNonBlankString handles snake_case payload reading", () => {
  const wirePayload: Record<string, unknown> = {
    agent_model: "gpt-4o",
  };
  assert.equal(
    optionalNonBlankString("test_tool", "agent_model", wirePayload["agent_model"]),
    null
  );
  // Reading missing camelCase is undefined, which is treated as absent
  assert.equal(
    optionalNonBlankString("test_tool", "agentModel", wirePayload["agentModel"]),
    null
  );
});

// ---------------------------------------------------------------------------
// requireBoolean
// ---------------------------------------------------------------------------

test("requireBoolean accepts real boolean values true and false", () => {
  assert.equal(requireBoolean("cast_vote", "approve", true), null);
  assert.equal(requireBoolean("cast_vote", "approve", false), null);
});

test("requireBoolean rejects missing and undefined values", () => {
  const err = requireBoolean("cast_vote", "approve", undefined);
  assert.match(err!, /cast_vote: 'approve' is required and must be a boolean, got undefined \(undefined\)/);
  assert.match(err!, /Refusing to infer intent/);
});

test("requireBoolean rejects null values", () => {
  const err = requireBoolean("cast_vote", "approve", null);
  assert.match(err!, /got null \(null\)/);
  assert.match(err!, /Refusing to infer intent/);
});

test("requireBoolean rejects string booleans (truthiness traps: 'false', 'true', '')", () => {
  assert.match(
    requireBoolean("cast_vote", "approve", "false")!,
    /got "false" \(string\)/
  );
  assert.match(
    requireBoolean("cast_vote", "approve", "true")!,
    /got "true" \(string\)/
  );
  assert.match(
    requireBoolean("cast_vote", "approve", "")!,
    /got "" \(string\)/
  );
});

test("requireBoolean rejects numeric representations (0, 1, NaN)", () => {
  assert.match(
    requireBoolean("cast_vote", "approve", 0)!,
    /got 0 \(number\)/
  );
  assert.match(
    requireBoolean("cast_vote", "approve", 1)!,
    /got 1 \(number\)/
  );
});

test("requireBoolean rejects objects and arrays", () => {
  assert.match(
    requireBoolean("cast_vote", "approve", {})!,
    /got {} \(object\)/
  );
  assert.match(
    requireBoolean("cast_vote", "approve", [true])!,
    /got \[true\] \(object\)/
  );
});

test("requireBoolean handles snake_case payload vs camelCase mismatches", () => {
  const wirePayload: Record<string, unknown> = {
    is_active: false,
  };
  assert.equal(requireBoolean("update_status", "is_active", wirePayload["is_active"]), null);

  const err = requireBoolean("update_status", "isActive", wirePayload["isActive"]);
  assert.match(err!, /got undefined \(undefined\)/);
});

// ---------------------------------------------------------------------------
// requireNumber
// ---------------------------------------------------------------------------

test("requireNumber accepts valid finite numbers", () => {
  assert.equal(requireNumber("set_timeout", "timeout_ms", 1000), null);
  assert.equal(requireNumber("set_timeout", "timeout_ms", 0), null);
  assert.equal(requireNumber("set_timeout", "timeout_ms", -5), null);
  assert.equal(requireNumber("set_timeout", "timeout_ms", 3.14159), null);
});

test("requireNumber rejects missing, undefined, and null values", () => {
  assert.match(
    requireNumber("set_timeout", "timeout_ms", undefined)!,
    /got undefined \(undefined\)/
  );
  assert.match(
    requireNumber("set_timeout", "timeout_ms", null)!,
    /got null \(null\)/
  );
});

test("requireNumber rejects non-finite numbers (NaN, Infinity, -Infinity)", () => {
  assert.match(
    requireNumber("set_timeout", "timeout_ms", Number.NaN)!,
    /got null \(number\)/
  );
  assert.match(
    requireNumber("set_timeout", "timeout_ms", Number.POSITIVE_INFINITY)!,
    /got null \(number\)/
  );
  assert.match(
    requireNumber("set_timeout", "timeout_ms", Number.NEGATIVE_INFINITY)!,
    /got null \(number\)/
  );
});

test("requireNumber rejects strings, booleans, objects, arrays", () => {
  assert.match(
    requireNumber("set_timeout", "timeout_ms", "1000")!,
    /got "1000" \(string\)/
  );
  assert.match(
    requireNumber("set_timeout", "timeout_ms", "")!,
    /got "" \(string\)/
  );
  assert.match(
    requireNumber("set_timeout", "timeout_ms", true)!,
    /got true \(boolean\)/
  );
  assert.match(
    requireNumber("set_timeout", "timeout_ms", [1000])!,
    /got \[1000\] \(object\)/
  );
});

test("requireNumber enforces options (integer, min, max)", () => {
  // integer check
  assert.equal(requireNumber("set_timeout", "timeout_ms", 10, { integer: true }), null);
  assert.match(
    requireNumber("set_timeout", "timeout_ms", 10.5, { integer: true })!,
    /must be an integer, got 10.5/
  );

  // min check
  assert.equal(requireNumber("set_timeout", "timeout_ms", 1, { min: 1 }), null);
  assert.match(
    requireNumber("set_timeout", "timeout_ms", 0, { min: 1 })!,
    /must be >= 1, got 0/
  );

  // max check
  assert.equal(requireNumber("set_timeout", "timeout_ms", 100, { max: 100 }), null);
  assert.match(
    requireNumber("set_timeout", "timeout_ms", 101, { max: 100 })!,
    /must be <= 100, got 101/
  );

  // combined options
  assert.equal(requireNumber("set_timeout", "timeout_ms", 5, { min: 1, max: 10, integer: true }), null);
  assert.match(
    requireNumber("set_timeout", "timeout_ms", 0.5, { min: 1, integer: true })!,
    /must be an integer/
  );
});

test("requireNumber handles snake_case payload vs camelCase mismatches", () => {
  const wirePayload: Record<string, unknown> = {
    timeout_ms: 5000,
  };
  assert.equal(requireNumber("set_timeout", "timeout_ms", wirePayload["timeout_ms"]), null);
  assert.match(
    requireNumber("set_timeout", "timeoutMs", wirePayload["timeoutMs"])!,
    /got undefined \(undefined\)/
  );
});

// ---------------------------------------------------------------------------
// optionalBoolean
// ---------------------------------------------------------------------------

test("optionalBoolean accepts undefined and null (absence)", () => {
  assert.equal(optionalBoolean("spawn_fleet", "expects_artifact", undefined), null);
  assert.equal(optionalBoolean("spawn_fleet", "expects_artifact", null), null);
});

test("optionalBoolean accepts valid boolean values true and false", () => {
  assert.equal(optionalBoolean("spawn_fleet", "expects_artifact", true), null);
  assert.equal(optionalBoolean("spawn_fleet", "expects_artifact", false), null);
});

test("optionalBoolean rejects string booleans and truthiness traps ('false', 'true', '')", () => {
  const errFalse = optionalBoolean("spawn_fleet", "expects_artifact", "false");
  assert.match(errFalse!, /spawn_fleet: 'expects_artifact' must be a boolean when provided, got "false" \(string\)/);
  assert.match(errFalse!, /Refusing to infer intent — the string "false" is truthy/);

  assert.match(
    optionalBoolean("spawn_fleet", "expects_artifact", "true")!,
    /must be a boolean when provided/
  );
  assert.match(
    optionalBoolean("spawn_fleet", "expects_artifact", "")!,
    /must be a boolean when provided/
  );
});

test("optionalBoolean rejects numbers, objects, arrays", () => {
  assert.match(
    optionalBoolean("spawn_fleet", "expects_artifact", 0)!,
    /got 0 \(number\)/
  );
  assert.match(
    optionalBoolean("spawn_fleet", "expects_artifact", 1)!,
    /got 1 \(number\)/
  );
  assert.match(
    optionalBoolean("spawn_fleet", "expects_artifact", {})!,
    /got {} \(object\)/
  );
});

test("optionalBoolean handles snake_case payload", () => {
  const wirePayload: Record<string, unknown> = {
    expects_artifact: true,
  };
  assert.equal(optionalBoolean("spawn_fleet", "expects_artifact", wirePayload["expects_artifact"]), null);
  // Omitted camelCase key is undefined -> treated as absent, returns null
  assert.equal(optionalBoolean("spawn_fleet", "expectsArtifact", wirePayload["expectsArtifact"]), null);
});

// ---------------------------------------------------------------------------
// optionalNumber
// ---------------------------------------------------------------------------

test("optionalNumber accepts undefined and null (absence)", () => {
  assert.equal(optionalNumber("register_capability", "context_window", undefined), null);
  assert.equal(optionalNumber("register_capability", "context_window", null), null);
});

test("optionalNumber accepts valid finite numbers", () => {
  assert.equal(optionalNumber("register_capability", "context_window", 128000), null);
  assert.equal(optionalNumber("register_capability", "context_window", 0), null);
  assert.equal(optionalNumber("register_capability", "context_window", -10), null);
  assert.equal(optionalNumber("register_capability", "context_window", 2.5), null);
});

test("optionalNumber rejects non-finite numbers (NaN, Infinity, -Infinity)", () => {
  assert.match(
    optionalNumber("register_capability", "context_window", Number.NaN)!,
    /must be a finite number when provided, got null \(number\)/
  );
  assert.match(
    optionalNumber("register_capability", "context_window", Number.POSITIVE_INFINITY)!,
    /must be a finite number when provided/
  );
  assert.match(
    optionalNumber("register_capability", "context_window", Number.NEGATIVE_INFINITY)!,
    /must be a finite number when provided/
  );
});

test("optionalNumber rejects strings, booleans, objects, arrays", () => {
  assert.match(
    optionalNumber("register_capability", "context_window", "128000")!,
    /got "128000" \(string\)/
  );
  assert.match(
    optionalNumber("register_capability", "context_window", "")!,
    /got "" \(string\)/
  );
  assert.match(
    optionalNumber("register_capability", "context_window", true)!,
    /got true \(boolean\)/
  );
  assert.match(
    optionalNumber("register_capability", "context_window", {})!,
    /got {} \(object\)/
  );
});

test("optionalNumber handles snake_case payload vs camelCase mismatches", () => {
  const wirePayload: Record<string, unknown> = {
    context_window: 64000,
  };
  assert.equal(optionalNumber("register_capability", "context_window", wirePayload["context_window"]), null);
  // Omitted camelCase key yields undefined, which optionalNumber treats as absent
  assert.equal(optionalNumber("register_capability", "contextWindow", wirePayload["contextWindow"]), null);
});

// ---------------------------------------------------------------------------
// optionalModelSelector
// ---------------------------------------------------------------------------

test("optionalModelSelector accepts undefined (omitted)", () => {
  assert.equal(optionalModelSelector("spawn_fleet", "model", undefined), null);
});

test("optionalModelSelector accepts valid provider/model selectors", () => {
  assert.equal(optionalModelSelector("spawn_fleet", "model", "anthropic/claude-3-5-sonnet"), null);
  assert.equal(optionalModelSelector("spawn_fleet", "model", "openai/gpt-4o"), null);
  assert.equal(optionalModelSelector("spawn_fleet", "model", "provider/model/extra-slash"), null);
  assert.equal(optionalModelSelector("spawn_fleet", "model", "p/m"), null);
});

test("optionalModelSelector rejects null and missing non-undefined values", () => {
  assert.match(
    optionalModelSelector("spawn_fleet", "model", null)!,
    /must be a provider\/model selector string/
  );
});

test("optionalModelSelector rejects empty or whitespace-containing strings", () => {
  assert.match(
    optionalModelSelector("spawn_fleet", "model", "")!,
    /must be a provider\/model selector string/
  );
  assert.match(
    optionalModelSelector("spawn_fleet", "model", "   ")!,
    /must be a provider\/model selector string/
  );
  assert.match(
    optionalModelSelector("spawn_fleet", "model", "provider/ model")!,
    /must be a provider\/model selector string/
  );
  assert.match(
    optionalModelSelector("spawn_fleet", "model", "provider /model")!,
    /must be a provider\/model selector string/
  );
});

test("optionalModelSelector rejects strings lacking '/' or having '/' at start or end", () => {
  // No slash
  assert.match(
    optionalModelSelector("spawn_fleet", "model", "claude-3-5")!,
    /must be a provider\/model selector string/
  );
  // Leading slash
  assert.match(
    optionalModelSelector("spawn_fleet", "model", "/claude-3-5")!,
    /must be a provider\/model selector string/
  );
  // Trailing slash
  assert.match(
    optionalModelSelector("spawn_fleet", "model", "anthropic/")!,
    /must be a provider\/model selector string/
  );
});

test("optionalModelSelector rejects strings exceeding 256 characters", () => {
  const longProvider = "p".repeat(250);
  const validLength = `${longProvider}/m`; // length 252 <= 256
  assert.equal(optionalModelSelector("spawn_fleet", "model", validLength), null);

  const tooLong = `${"p".repeat(256)}/m`; // length 258 > 256
  assert.match(
    optionalModelSelector("spawn_fleet", "model", tooLong)!,
    /length ≤ 256/
  );
});

test("optionalModelSelector rejects wrong types (number, boolean, object, array)", () => {
  assert.match(
    optionalModelSelector("spawn_fleet", "model", 123)!,
    /got 123 \(number\)/
  );
  assert.match(
    optionalModelSelector("spawn_fleet", "model", true)!,
    /got true \(boolean\)/
  );
  assert.match(
    optionalModelSelector("spawn_fleet", "model", {})!,
    /got {} \(object\)/
  );
});

test("optionalModelSelector handles snake_case payload reading", () => {
  const wirePayload: Record<string, unknown> = {
    requested_model: "anthropic/claude-3-opus",
  };
  assert.equal(
    optionalModelSelector("spawn_fleet", "requested_model", wirePayload["requested_model"]),
    null
  );
  // Undefined camelCase key is treated as omitted
  assert.equal(
    optionalModelSelector("spawn_fleet", "requestedModel", wirePayload["requestedModel"]),
    null
  );
});

// ---------------------------------------------------------------------------
// requireStringArray
// ---------------------------------------------------------------------------

test("requireStringArray accepts valid arrays of non-empty strings", () => {
  assert.equal(requireStringArray("open_ratification", "voters", ["alice", "bob"]), null);
  assert.equal(requireStringArray("open_ratification", "voters", ["solo"]), null);
  assert.equal(requireStringArray("open_ratification", "voters", []), null);
});

test("requireStringArray rejects missing and undefined when required (default)", () => {
  const err = requireStringArray("open_ratification", "voters", undefined);
  assert.match(err!, /open_ratification: 'voters' is required and must be an array of strings/);
});

test("requireStringArray rejects null when required (default)", () => {
  const err = requireStringArray("open_ratification", "voters", null);
  assert.match(err!, /open_ratification: 'voters' is required and must be an array of strings/);
});

test("requireStringArray accepts undefined and null when opts.optional is true", () => {
  assert.equal(requireStringArray("open_ratification", "voters", undefined, { optional: true }), null);
  assert.equal(requireStringArray("open_ratification", "voters", null, { optional: true }), null);
});

test("requireStringArray rejects bare strings (preventing character-by-character iteration trap)", () => {
  const err = requireStringArray("open_ratification", "voters", "alice");
  assert.match(err!, /open_ratification: 'voters' must be an ARRAY of strings, got the bare string "alice"/);
  assert.match(err!, /A string would be iterated character by character/);
});

test("requireStringArray rejects arrays with empty or blank strings", () => {
  assert.match(
    requireStringArray("open_ratification", "voters", ["alice", ""])!,
    /must be an array of non-empty strings, got \["alice",""\] \(object\)/
  );
  assert.match(
    requireStringArray("open_ratification", "voters", ["   "])!,
    /must be an array of non-empty strings, got \["   "\] \(object\)/
  );
});

test("requireStringArray rejects arrays with non-string elements", () => {
  assert.match(
    requireStringArray("open_ratification", "voters", ["alice", 123])!,
    /must be an array of non-empty strings/
  );
  assert.match(
    requireStringArray("open_ratification", "voters", [null])!,
    /must be an array of non-empty strings/
  );
  assert.match(
    requireStringArray("open_ratification", "voters", [{}])!,
    /must be an array of non-empty strings/
  );
});

test("requireStringArray rejects non-array types (numbers, booleans, objects)", () => {
  assert.match(
    requireStringArray("open_ratification", "voters", 42)!,
    /must be an array of non-empty strings, got 42 \(number\)/
  );
  assert.match(
    requireStringArray("open_ratification", "voters", true)!,
    /must be an array of non-empty strings, got true \(boolean\)/
  );
  assert.match(
    requireStringArray("open_ratification", "voters", { 0: "alice" })!,
    /must be an array of non-empty strings, got {"0":"alice"} \(object\)/
  );
});

test("requireStringArray handles snake_case payload vs camelCase mismatches", () => {
  const wirePayload: Record<string, unknown> = {
    required_signoffs: ["auditor", "lead"],
  };
  assert.equal(
    requireStringArray("open_ratification", "required_signoffs", wirePayload["required_signoffs"]),
    null
  );

  // Missing when required:
  assert.match(
    requireStringArray("open_ratification", "requiredSignoffs", wirePayload["requiredSignoffs"])!,
    /is required and must be an array of strings/
  );

  // Missing when optional:
  assert.equal(
    requireStringArray("open_ratification", "requiredSignoffs", wirePayload["requiredSignoffs"], {
      optional: true,
    }),
    null
  );
});

// ---------------------------------------------------------------------------
// requireEnum
// ---------------------------------------------------------------------------

const ALLOWED_POLICIES = ["abstain", "object", "quorum_majority"] as const;

test("requireEnum accepts valid allowed enum values", () => {
  assert.equal(requireEnum("open_ratification", "silence_policy", "abstain", ALLOWED_POLICIES), null);
  assert.equal(requireEnum("open_ratification", "silence_policy", "object", ALLOWED_POLICIES), null);
  assert.equal(requireEnum("open_ratification", "silence_policy", "quorum_majority", ALLOWED_POLICIES), null);
});

test("requireEnum rejects missing and undefined when required (default)", () => {
  const err = requireEnum("open_ratification", "silence_policy", undefined, ALLOWED_POLICIES);
  assert.match(
    err!,
    /open_ratification: 'silence_policy' is required and must be one of abstain \| object \| quorum_majority/
  );
});

test("requireEnum rejects null when required (default)", () => {
  const err = requireEnum("open_ratification", "silence_policy", null, ALLOWED_POLICIES);
  assert.match(
    err!,
    /open_ratification: 'silence_policy' is required and must be one of abstain \| object \| quorum_majority/
  );
});

test("requireEnum accepts undefined and null when opts.optional is true", () => {
  assert.equal(
    requireEnum("get_health", "verbosity", undefined, ["full", "summary"], { optional: true }),
    null
  );
  assert.equal(
    requireEnum("get_health", "verbosity", null, ["full", "summary"], { optional: true }),
    null
  );
});

test("requireEnum rejects unrecognized values and empty strings", () => {
  const errUnknown = requireEnum("open_ratification", "silence_policy", "APPROVE", ALLOWED_POLICIES);
  assert.match(
    errUnknown!,
    /open_ratification: 'silence_policy' must be exactly one of abstain \| object \| quorum_majority, got "APPROVE" \(string\)/
  );
  assert.match(errUnknown!, /An unrecognized value would silently fall through to a default/);

  assert.match(
    requireEnum("open_ratification", "silence_policy", "", ALLOWED_POLICIES)!,
    /must be exactly one of/
  );
});

test("requireEnum is case-sensitive", () => {
  assert.match(
    requireEnum("open_ratification", "silence_policy", "Abstain", ALLOWED_POLICIES)!,
    /got "Abstain" \(string\)/
  );
});

test("requireEnum rejects non-string types (numbers, booleans, objects, arrays)", () => {
  assert.match(
    requireEnum("open_ratification", "silence_policy", 1, ALLOWED_POLICIES)!,
    /got 1 \(number\)/
  );
  assert.match(
    requireEnum("open_ratification", "silence_policy", false, ALLOWED_POLICIES)!,
    /got false \(boolean\)/
  );
  assert.match(
    requireEnum("open_ratification", "silence_policy", {}, ALLOWED_POLICIES)!,
    /got {} \(object\)/
  );
  assert.match(
    requireEnum("open_ratification", "silence_policy", ["abstain"], ALLOWED_POLICIES)!,
    /got \["abstain"\] \(object\)/
  );
});

test("requireEnum handles snake_case payload vs camelCase mismatches", () => {
  const wirePayload: Record<string, unknown> = {
    silence_policy: "abstain",
  };
  assert.equal(
    requireEnum("open_ratification", "silence_policy", wirePayload["silence_policy"], ALLOWED_POLICIES),
    null
  );

  // Missing when required:
  assert.match(
    requireEnum("open_ratification", "silencePolicy", wirePayload["silencePolicy"], ALLOWED_POLICIES)!,
    /is required and must be one of/
  );

  // Missing when optional:
  assert.equal(
    requireEnum("open_ratification", "silencePolicy", wirePayload["silencePolicy"], ALLOWED_POLICIES, {
      optional: true,
    }),
    null
  );
});
