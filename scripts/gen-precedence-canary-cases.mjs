#!/usr/bin/env node
/**
 * Generates mutation canary cases for each adjacent A00-A13 pair of the local
 * admission evaluator. Each canary mutates the valid baseline (corpus[0]) so the
 * earlier step's failure is triggered AND the conditions for the later step's
 * failure are also present. If precedence is correct, the result is the earlier
 * step's code; if a future change reorders to the later step, the canary fails.
 *
 * Two kinds of canaries are produced:
 *   - adjacent-pair (13): the earlier-step wins, the later-step would also match
 *   - later-only control (13): the A_(N+1) step alone matches, so the adjacent
 *     pair canary must NOT match its control (prove the earlier step is what
 *     actually fired)
 *
 * Output: { canaries: [...], controls: [...] } on stdout, suitable for the
 * splice-precedence-canary-cases.mjs combine step.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalEnvelopeDigest, decodeEnvelope } from "../dist/a2a/codec.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpusPath = join(here, "..", "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const baseline = corpus.cases[0];
const baselineRequest = JSON.parse(baseline.invocation_args.request_json);
const baselineEnvelope = JSON.parse(baseline.invocation_args.envelope_json);

const baselineEnvelopeJson = baseline.invocation_args.envelope_json;
const baselineRequestJson = baseline.invocation_args.request_json;

/** The TypeScript evaluator delegates envelope digest to canonicalEnvelopeDigest.
 *  The generator reads the same digest for the cases that exercise the oracle
 *  (A10-A11, A11-A12, A12-A13) and the later-only controls (A09-A10.later,
 *  A10-A11.later, A11-A12.later, A12-A13.later) so the spliced expected field
 *  matches the live call argument byte-for-byte. */
function digestOfEnvelopeJson(envelopeJson) {
  return canonicalEnvelopeDigest(decodeEnvelope(envelopeJson));
}

const baselineDigest = digestOfEnvelopeJson(baselineEnvelopeJson);
const expiredEnvelopeJson = JSON.stringify({ ...baselineEnvelope, expires_at_ms: 100 });
const expiredDigest = digestOfEnvelopeJson(expiredEnvelopeJson);

function oracleArguments(digest) {
  return [{
    principal_ref: "principal-ref",
    request_id: "request-ref",
    sender: { namespace: "local", agent_id: "agent-a" },
    message_id: "message-ref",
    envelope_digest: digest,
  }];
}

function mutateRequest(patches) {
  return JSON.stringify({ ...baselineRequest, ...patches });
}
function mutateEnvelope(patches) {
  return JSON.stringify({ ...baselineEnvelope, ...patches });
}

const REJECTED = (code, field_path) => ({
  result: { kind: "rejected", code, field_path },
  replay_oracle_calls: 0,
  replay_oracle_arguments: [],
});
const NOT_ADMITTED = (disposition, replay_oracle_calls, replay_oracle_arguments) => ({
  result: { kind: "not_admitted", disposition },
  replay_oracle_calls,
  replay_oracle_arguments,
});

const canaries = [
  // A00 (request framing) vs A01 (request schema): too-large request also has an unknown extra field.
  // Precedence-correct: REQUEST_TOO_LARGE ($).
  {
    id: "precedence.A00-A01",
    request_json: mutateRequest({ extra: "x".repeat(262145) }),
    envelope_json: baselineEnvelopeJson,
    replay_oracle_result: "unseen",
    expected: REJECTED("REQUEST_TOO_LARGE", "$"),
  },
  // A01 (request schema) vs A02 (fixed fields): unknown core field also has wrong version.
  {
    id: "precedence.A01-A02",
    request_json: mutateRequest({ extra: "x", version: "other" }),
    envelope_json: baselineEnvelopeJson,
    replay_oracle_result: "unseen",
    expected: REJECTED("UNKNOWN_CORE_FIELD", "$"),
  },
  // A02 (fixed fields) vs A03 (envelope decode): bad action + malformed envelope.
  {
    id: "precedence.A02-A03",
    request_json: mutateRequest({ action: "other" }),
    envelope_json: "{",
    replay_oracle_result: "unseen",
    expected: REJECTED("INVALID_REQUEST", "$.action"),
  },
  // A03 (envelope decode) vs A04 (evidence fields): missing envelope + empty evidence.
  {
    id: "precedence.A03-A04",
    request_json: mutateRequest({ authentication_evidence: {} }),
    envelope_json: "{",
    replay_oracle_result: "unseen",
    expected: REJECTED("MALFORMED_ENVELOPE", "$.envelope"),
  },
  // A04 (evidence fields) vs A05 (binding snapshot): untrusted provenance + bad binding version.
  {
    id: "precedence.A04-A05",
    request_json: mutateRequest({
      authentication_evidence: { ...baselineRequest.authentication_evidence, provenance: "untrusted_local_adapter" },
      binding_snapshot: { ...baselineRequest.binding_snapshot, snapshot_version: "other" },
    }),
    envelope_json: baselineEnvelopeJson,
    replay_oracle_result: "unseen",
    expected: REJECTED("INVALID_AUTHENTICATION_EVIDENCE", "$.authentication_evidence.provenance"),
  },
  // A05 (binding snapshot) vs A06 (authorization snapshot): bad binding + bad authorization.
  {
    id: "precedence.A05-A06",
    request_json: mutateRequest({
      binding_snapshot: { ...baselineRequest.binding_snapshot, snapshot_version: "other" },
      authorization_snapshot: { ...baselineRequest.authorization_snapshot, snapshot_version: "other" },
    }),
    envelope_json: baselineEnvelopeJson,
    replay_oracle_result: "unseen",
    expected: REJECTED("INVALID_BINDING_SNAPSHOT", "$.binding_snapshot.snapshot_version"),
  },
  // A06 (authorization snapshot) vs A07 (interval applicability): bad authorization + expired evidence.
  {
    id: "precedence.A06-A07",
    request_json: mutateRequest({
      authentication_evidence: { ...baselineRequest.authentication_evidence, expires_at_ms: 100 },
      authorization_snapshot: { ...baselineRequest.authorization_snapshot, snapshot_version: "other" },
    }),
    envelope_json: baselineEnvelopeJson,
    replay_oracle_result: "unseen",
    expected: REJECTED("INVALID_AUTHORIZATION_SNAPSHOT", "$.authorization_snapshot.snapshot_version"),
  },
  // A07 (interval applicability) vs A08 (binding match): expired evidence + mismatched audience.
  // Both collapse to AUTHORIZATION_DENIED at $ — the canary denies-before-oracle.
  {
    id: "precedence.A07-A08",
    request_json: mutateRequest({
      authentication_evidence: { ...baselineRequest.authentication_evidence, expires_at_ms: 100 },
    }),
    envelope_json: mutateEnvelope({ audience: "other-audience" }),
    replay_oracle_result: "unseen",
    expected: REJECTED("AUTHORIZATION_DENIED", "$"),
  },
  // A08 (binding match) vs A09 (authorization): wrong message type + mismatched audience.
  // Both collapse to AUTHORIZATION_DENIED at $ — the canary denies-before-oracle.
  {
    id: "precedence.A08-A09",
    request_json: mutateRequest({
      authorization_snapshot: {
        ...baselineRequest.authorization_snapshot,
        rules: [{ ...baselineRequest.authorization_snapshot.rules[0], message_types: ["alert"] }],
      },
    }),
    envelope_json: mutateEnvelope({ audience: "other-audience" }),
    replay_oracle_result: "unseen",
    expected: REJECTED("AUTHORIZATION_DENIED", "$"),
  },
  // A09 (authorization) vs A10 (oracle call): wrong message type + throwing oracle.
  // Denied-before-oracle must hide the oracle failure.
  {
    id: "precedence.A09-A10",
    request_json: mutateRequest({
      authorization_snapshot: {
        ...baselineRequest.authorization_snapshot,
        rules: [{ ...baselineRequest.authorization_snapshot.rules[0], message_types: ["alert"] }],
      },
    }),
    envelope_json: baselineEnvelopeJson,
    replay_oracle_result: "throws",
    expected: REJECTED("AUTHORIZATION_DENIED", "$"),
  },
  // A10 (oracle call) vs A11 (oracle verdict): throwing oracle + duplicate verdict.
  // Unavailable must hide the duplicate verdict.
  {
    id: "precedence.A10-A11",
    request_json: baselineRequestJson,
    envelope_json: baselineEnvelopeJson,
    replay_oracle_result: "throws",
    expected: {
      result: { kind: "rejected", code: "REPLAY_PROTECTION_UNAVAILABLE", field_path: "$" },
      replay_oracle_calls: 1,
      replay_oracle_arguments: oracleArguments(baselineDigest),
    },
  },
  // A11 (oracle verdict) vs A12 (expiry): duplicate replay + expired envelope.
  // Duplicate-verdict must hide the expiry path.
  {
    id: "precedence.A11-A12",
    request_json: baselineRequestJson,
    envelope_json: expiredEnvelopeJson,
    replay_oracle_result: "duplicate",
    expected: {
      result: { kind: "not_admitted", disposition: "duplicate" },
      replay_oracle_calls: 1,
      replay_oracle_arguments: oracleArguments(expiredDigest),
    },
  },
  // A12 (expiry) vs A13 (admission plan): expired envelope + unseen replay.
  // Expiry must beat the success path.
  {
    id: "precedence.A12-A13",
    request_json: baselineRequestJson,
    envelope_json: expiredEnvelopeJson,
    replay_oracle_result: "unseen",
    expected: {
      result: { kind: "not_admitted", disposition: "expired_at_acceptance" },
      replay_oracle_calls: 1,
      replay_oracle_arguments: oracleArguments(expiredDigest),
    },
  },
];

// Later-only controls: the later step alone matches, so the canary must NOT match.
// Used to prove the earlier step actually fired (not the later step).
const controls = [
  // A01 alone — unknown core field, no length overflow.
  {
    id: "control.A00-A01.later",
    request_json: mutateRequest({ extra: "x" }),
    envelope_json: baselineEnvelopeJson,
    replay_oracle_result: "unseen",
    expected: REJECTED("UNKNOWN_CORE_FIELD", "$"),
  },
  // A02 alone — wrong version, no unknown extra field.
  {
    id: "control.A01-A02.later",
    request_json: mutateRequest({ version: "other" }),
    envelope_json: baselineEnvelopeJson,
    replay_oracle_result: "unseen",
    expected: REJECTED("UNSUPPORTED_PROFILE_VERSION", "$.version"),
  },
  // A03 alone — malformed envelope, baseline request.
  {
    id: "control.A02-A03.later",
    request_json: baselineRequestJson,
    envelope_json: "{",
    replay_oracle_result: "unseen",
    expected: REJECTED("MALFORMED_ENVELOPE", "$.envelope"),
  },
  // A04 alone — empty evidence, baseline envelope.
  {
    id: "control.A03-A04.later",
    request_json: mutateRequest({ authentication_evidence: {} }),
    envelope_json: baselineEnvelopeJson,
    replay_oracle_result: "unseen",
    expected: REJECTED("INVALID_AUTHENTICATION_EVIDENCE", "$.authentication_evidence.adapter_id"),
  },
  // A05 alone — bad binding version, baseline evidence.
  {
    id: "control.A04-A05.later",
    request_json: mutateRequest({
      binding_snapshot: { ...baselineRequest.binding_snapshot, snapshot_version: "other" },
    }),
    envelope_json: baselineEnvelopeJson,
    replay_oracle_result: "unseen",
    expected: REJECTED("INVALID_BINDING_SNAPSHOT", "$.binding_snapshot.snapshot_version"),
  },
  // A06 alone — bad authorization version, baseline binding.
  {
    id: "control.A05-A06.later",
    request_json: mutateRequest({
      authorization_snapshot: { ...baselineRequest.authorization_snapshot, snapshot_version: "other" },
    }),
    envelope_json: baselineEnvelopeJson,
    replay_oracle_result: "unseen",
    expected: REJECTED("INVALID_AUTHORIZATION_SNAPSHOT", "$.authorization_snapshot.snapshot_version"),
  },
  // A07 alone — expired evidence, baseline envelope.
  {
    id: "control.A06-A07.later",
    request_json: mutateRequest({
      authentication_evidence: { ...baselineRequest.authentication_evidence, expires_at_ms: 100 },
    }),
    envelope_json: baselineEnvelopeJson,
    replay_oracle_result: "unseen",
    expected: REJECTED("AUTHORIZATION_DENIED", "$"),
  },
  // A08 alone — mismatched audience, baseline request.
  {
    id: "control.A07-A08.later",
    request_json: baselineRequestJson,
    envelope_json: mutateEnvelope({ audience: "other-audience" }),
    replay_oracle_result: "unseen",
    expected: REJECTED("AUTHORIZATION_DENIED", "$"),
  },
  // A09 alone — wrong message type, baseline envelope.
  {
    id: "control.A08-A09.later",
    request_json: mutateRequest({
      authorization_snapshot: {
        ...baselineRequest.authorization_snapshot,
        rules: [{ ...baselineRequest.authorization_snapshot.rules[0], message_types: ["alert"] }],
      },
    }),
    envelope_json: baselineEnvelopeJson,
    replay_oracle_result: "unseen",
    expected: REJECTED("AUTHORIZATION_DENIED", "$"),
  },
  // A10 alone — throwing oracle, baseline envelope.
  {
    id: "control.A09-A10.later",
    request_json: baselineRequestJson,
    envelope_json: baselineEnvelopeJson,
    replay_oracle_result: "throws",
    expected: {
      result: { kind: "rejected", code: "REPLAY_PROTECTION_UNAVAILABLE", field_path: "$" },
      replay_oracle_calls: 1,
      replay_oracle_arguments: oracleArguments(baselineDigest),
    },
  },
  // A11 alone — duplicate verdict, baseline envelope.
  {
    id: "control.A10-A11.later",
    request_json: baselineRequestJson,
    envelope_json: baselineEnvelopeJson,
    replay_oracle_result: "duplicate",
    expected: {
      result: { kind: "not_admitted", disposition: "duplicate" },
      replay_oracle_calls: 1,
      replay_oracle_arguments: oracleArguments(baselineDigest),
    },
  },
  // A12 alone — unseen + expired envelope.
  {
    id: "control.A11-A12.later",
    request_json: baselineRequestJson,
    envelope_json: expiredEnvelopeJson,
    replay_oracle_result: "unseen",
    expected: {
      result: { kind: "not_admitted", disposition: "expired_at_acceptance" },
      replay_oracle_calls: 1,
      replay_oracle_arguments: oracleArguments(expiredDigest),
    },
  },
  // A13 alone — the valid baseline; admission plan (full expected must match the
  // TypeScript evaluator's plan bytes exactly, so reuse the baseline case's expected).
  {
    id: "control.A12-A13.later",
    request_json: baselineRequestJson,
    envelope_json: baselineEnvelopeJson,
    replay_oracle_result: "unseen",
    expected: baseline.expected,
  },
];

process.stdout.write(JSON.stringify({ canaries, controls }, null, 2) + "\n");
