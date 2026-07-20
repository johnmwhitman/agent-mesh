const VERSION = "meshfleet.a2a.static-harness-mapping.v0.1";
const TARGET_STATUS: Record<string, string> = {
  codex: "known-static",
  "codex-cli": "known-static",
  "claude-code": "known-static",
  opencode: "known-static",
  "antigravity-gemini": "deferred",
  grok: "deferred",
  "unknown-harness": "unprofiled",
};

type Loss = {
  field_path: "$.authentication_evidence" | "$.principal_binding_input";
  reason_code: "identity_not_represented";
  disposition: "omitted_by_contract";
};

type StaticHarnessMapping = {
  sidecar_version: typeof VERSION;
  target: string;
  status: "known-static" | "deferred" | "unprofiled";
  losses: [Loss, Loss];
  authentication_evidence: null;
  principal_binding_input: null;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(): never {
  throw new Error("invalid static harness mapping");
}

function loss(value: unknown, path: "$.authentication_evidence" | "$.principal_binding_input"): Loss {
  if (!record(value) || Object.keys(value).length !== 3 || value.field_path !== path || value.reason_code !== "identity_not_represented" || value.disposition !== "omitted_by_contract") {
    invalid();
  }
  return { field_path: path, reason_code: "identity_not_represented", disposition: "omitted_by_contract" };
}

/** Test-only closed sidecar validator; this is not an admission operation. */
export function validateStaticHarnessMapping(value: unknown): StaticHarnessMapping {
  const fields = ["sidecar_version", "target", "status", "losses", "authentication_evidence", "principal_binding_input"];
  if (!record(value) || Object.keys(value).length !== fields.length || Object.keys(value).some((key) => !fields.includes(key))) invalid();
  if (value.sidecar_version !== VERSION || typeof value.target !== "string" || TARGET_STATUS[value.target] === undefined || value.status !== TARGET_STATUS[value.target]) invalid();
  if (value.authentication_evidence !== null || value.principal_binding_input !== null || !Array.isArray(value.losses) || value.losses.length !== 2) invalid();
  const first = loss(value.losses[0], "$.authentication_evidence");
  const second = loss(value.losses[1], "$.principal_binding_input");
  return {
    sidecar_version: VERSION,
    target: value.target,
    status: value.status as StaticHarnessMapping["status"],
    losses: [first, second],
    authentication_evidence: null,
    principal_binding_input: null,
  };
}
