#!/usr/bin/env node
// Generator: 11 envelope member-class corpus cases (coverage-ledger envelope row).
// Splices the cases into the canonical corpus by id, preserving order, and
// updates mandatory_case_ids in place. Repo-root-relative, no /Users leak.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpusPath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));

// Canonical request skeleton for every case: valid local-admission request.
const REQUEST = JSON.stringify({
  version: "meshfleet.a2a.local-admission.v0.1",
  evaluation_time_ms: 100,
  request_id: "request-ref",
  action: "a2a.message.admit",
  authentication_evidence: {
    adapter_id: "local.adapter",
    principal_ref: "principal-ref",
    audience: "local-audience",
    session_ref: "session-ref",
    issued_at_ms: 0,
    expires_at_ms: 200,
    provenance: "trusted_local_adapter",
  },
  binding_snapshot: {
    snapshot_version: "meshfleet.a2a.binding-snapshot.v0.1",
    snapshot_id: "binding-fixture",
    fixture_provenance: "caller_supplied_fixture",
    effective_from_ms: 0,
    effective_until_ms: 200,
    rules: [{ adapter_id: "local.adapter", principal_ref: "principal-ref", audience: "local-audience", session_ref: "session-ref", sender: { namespace: "local", agent_id: "agent-a" } }],
  },
  authorization_snapshot: {
    snapshot_version: "meshfleet.a2a.authorization-snapshot.v0.1",
    snapshot_id: "authorization-fixture",
    fixture_provenance: "caller_supplied_fixture",
    effective_from_ms: 0,
    effective_until_ms: 200,
    rules: [{ adapter_id: "local.adapter", principal_ref: "principal-ref", audience: "local-audience", session_ref: "session-ref", sender: { namespace: "local", agent_id: "agent-a" }, action: "a2a.message.admit", message_types: ["handoff"], recipients: [{ namespace: "local", agent_id: "agent-b" }] }],
  },
});

const VALID_ENVELOPE = {
  protocol: "meshfleet.a2a",
  version: "0.1",
  kind: "message",
  message_id: "message-ref",
  sender: { namespace: "local", agent_id: "agent-a" },
  recipients: [{ namespace: "local", agent_id: "agent-b" }],
  type: "handoff",
  issued_at_ms: 1,
  expires_at_ms: 150,
  audience: "local-audience",
  payload: { media_type: "text/plain", body: "offline" },
};

// Each case: mutate one member of the VALID_ENVELOPE; expected path is the
// projected member root (MALFORMED_ENVELOPE at `$.envelope.<member>`), with
// recipient-family cases projecting to `$.envelope.recipients`.
const members = [
  { id: "envelope.recipients-empty", path: "recipients", value: [] },
  { id: "envelope.recipients-duplicate", path: "recipients", value: [{ namespace: "local", agent_id: "agent-b" }, { namespace: "local", agent_id: "agent-b" }] },
  { id: "envelope.recipients-self", path: "recipients", value: [{ namespace: "local", agent_id: "agent-a" }] },
  { id: "envelope.sender-wildcard", path: "sender", value: { namespace: "local", agent_id: "*" } },
  { id: "envelope.payload-not-object", path: "payload", value: "offline" },
  { id: "envelope.payload-missing-media-type", path: "payload", value: { body: "offline" } },
  { id: "envelope.message-id-empty", path: "message_id", value: "" },
  { id: "envelope.type-unknown", path: "type", value: "teleport" },
  { id: "envelope.audience-empty", path: "audience", value: "" },
  { id: "envelope.expires-not-after-issued", path: "expires_at_ms", value: 0 },
  { id: "envelope.scope-fleet-id-empty", path: "scope", value: { fleet_id: "" } },
];

const newCases = members.map(({ id, path, value }) => {
  const envelope = JSON.parse(JSON.stringify(VALID_ENVELOPE));
  envelope[path] = value;
  return {
    id,
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: REQUEST,
      envelope_json: JSON.stringify(envelope),
      replay_oracle_result: "unseen",
    },
    expected: {
      result: { kind: "rejected", code: "MALFORMED_ENVELOPE", field_path: path === "recipients" ? "$.envelope.recipients" : `$.envelope.${path}` },
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  };
});

// Sanity: none of the ids may already exist.
for (const item of newCases) {
  if (corpus.mandatory_case_ids.includes(item.id)) {
    throw new Error(`case ${item.id} already exists in corpus`);
  }
}

// Insert each new id after the last existing id whose sort key precedes it.
const sorted = [...corpus.mandatory_case_ids, ...newCases.map((c) => c.id)].sort();
const ids = [...corpus.mandatory_case_ids];
for (const item of newCases) {
  const position = sorted.indexOf(item.id);
  let insertAt = 0;
  for (let index = 0; index < ids.length; index += 1) {
    const key = sorted.indexOf(ids[index]);
    if (key < position) insertAt = index + 1;
  }
  ids.splice(insertAt, 0, item.id);
}

// Ids must be stable for the whole list and equal the case order.
const byId = new Map(corpus.cases.map((c) => [c.id, c]));
const cases = ids.map((id) => byId.get(id) ?? newCases.find((c) => c.id === id));
if (cases.some((c) => c === undefined)) throw new Error("missing case body for spliced id");

corpus.mandatory_case_ids = ids;
corpus.cases = cases;
writeFileSync(corpusPath, JSON.stringify(corpus));
console.log(`spliced ${newCases.length} cases; corpus now ${corpus.cases.length} mandatory cases`);
