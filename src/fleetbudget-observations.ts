import { createHash } from "node:crypto";
import type { CompileRouteCandidateObservation } from "./compile-route-candidates.js";

export const FLEETBUDGET_SNAPSHOT_VERSION =
  "meshfleet.fleetbudget-snapshot.v1" as const;

const MAX_ITEMS = 256;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_UNIT_LENGTH = 64;
const MAX_SNAPSHOT_TTL_MS = 600_000;
const UNIT_TOKEN = /^[a-z0-9][a-z0-9._:-]*$/;

export interface FleetBudgetWindow {
  id: string;
  starts_at_ms: number;
  ends_at_ms: number;
}
export interface FleetBudgetLane {
  lane_id: string;
  measured: boolean;
  used: number | null;
  total: number | null;
  unit: string | null;
  window?: FleetBudgetWindow;
}

export interface FleetBudgetSnapshot {
  version: typeof FLEETBUDGET_SNAPSHOT_VERSION;
  observed_at_ms: number;
  expires_at_ms: number;
  lanes: FleetBudgetLane[];
}

export interface FleetBudgetObservationBinding {
  candidate_id: string;
  lane_id: string;
}

export interface FleetBudgetObservationInput {
  snapshot: FleetBudgetSnapshot;
  bindings: FleetBudgetObservationBinding[];
  now_ms: number;
}

export interface FleetBudgetObservationResult {
  projection: true;
  effects: {
    persisted: false;
    executed: false;
    authorized: false;
    woke_agents: false;
    contacted_providers: false;
  };
  source: {
    kind: "fleetbudget-sanitized-v1";
    observed_at_ms: number;
    expires_at_ms: number;
    snapshot_sha256: string;
    bindings_sha256: string;
  };
  observations: CompileRouteCandidateObservation[];
  diagnostics: Array<{
    candidate_id: string;
    lane_id: string;
    reason_codes: string[];
  }>;
}

type RecordValue = Record<string, unknown>;

function invalid(path: string, detail: string): never {
  throw new Error(`fleetbudget_observations: '${path}' ${detail}`);
}

function requireRecord(value: unknown, path: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(path, "must be an object");
  }
  return value as RecordValue;
}

function requireExactKeys(
  value: RecordValue,
  path: string,
  allowed: readonly string[],
  required: readonly string[],
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) invalid(`${path}.${unknown}`, "is not allowed");
  const missing = required.find((key) => !(key in value));
  if (missing !== undefined) invalid(`${path}.${missing}`, "is required");
}

function requireFiniteInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    invalid(path, "must be a finite integer");
  }
}

function requireIdentifier(value: unknown, path: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH
  ) {
    invalid(path, `must be a non-empty string no longer than ${MAX_IDENTIFIER_LENGTH} characters`);
  }
}

function validateUnit(value: unknown, path: string): asserts value is string | null {
  if (value === null) return;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_UNIT_LENGTH ||
    !UNIT_TOKEN.test(value)
  ) {
    invalid(path, `must be null or a lowercase unit token no longer than ${MAX_UNIT_LENGTH} characters`);
  }
}

function validateMetric(
  value: unknown,
  path: string,
  minimum: number,
  exclusiveMinimum = false,
): asserts value is number | null {
  if (value === null) return;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (exclusiveMinimum ? value <= minimum : value < minimum)
  ) {
    invalid(
      path,
      exclusiveMinimum
        ? `must be null or a finite number > ${minimum}`
        : `must be null or a finite number >= ${minimum}`,
    );
  }
}

function validateWindow(value: unknown, path: string, observedAtMs: number): FleetBudgetWindow {
  const window = requireRecord(value, path);
  requireExactKeys(
    window,
    path,
    ["id", "starts_at_ms", "ends_at_ms"],
    ["id", "starts_at_ms", "ends_at_ms"],
  );
  requireIdentifier(window.id, `${path}.id`);
  requireFiniteInteger(window.starts_at_ms, `${path}.starts_at_ms`);
  requireFiniteInteger(window.ends_at_ms, `${path}.ends_at_ms`);
  if (window.ends_at_ms <= window.starts_at_ms) {
    invalid(`${path}.ends_at_ms`, "must be greater than starts_at_ms");
  }
  if (
    observedAtMs < window.starts_at_ms ||
    observedAtMs >= window.ends_at_ms
  ) {
    invalid(path, "must contain snapshot.observed_at_ms");
  }
  return {
    id: window.id,
    starts_at_ms: window.starts_at_ms,
    ends_at_ms: window.ends_at_ms,
  };
}

function validateSnapshotHeader(value: unknown): RecordValue {
  const snapshot = requireRecord(value, "input.snapshot");
  requireExactKeys(
    snapshot,
    "input.snapshot",
    ["version", "observed_at_ms", "expires_at_ms", "lanes"],
    ["version", "observed_at_ms", "expires_at_ms", "lanes"],
  );
  if (snapshot.version !== FLEETBUDGET_SNAPSHOT_VERSION) {
    invalid("input.snapshot.version", `must equal ${FLEETBUDGET_SNAPSHOT_VERSION}`);
  }
  return snapshot;
}

function validateSnapshotTiming(
  snapshot: RecordValue,
): Omit<FleetBudgetSnapshot, "lanes"> & { lanes: unknown } {
  requireFiniteInteger(snapshot.observed_at_ms, "input.snapshot.observed_at_ms");
  requireFiniteInteger(snapshot.expires_at_ms, "input.snapshot.expires_at_ms");
  const ttlMs = snapshot.expires_at_ms - snapshot.observed_at_ms;
  if (!Number.isFinite(ttlMs) || !Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_SNAPSHOT_TTL_MS) {
    invalid(
      "input.snapshot.expires_at_ms",
      `must make snapshot TTL a finite integer between 1 and ${MAX_SNAPSHOT_TTL_MS} ms`,
    );
  }
  return {
    version: FLEETBUDGET_SNAPSHOT_VERSION,
    observed_at_ms: snapshot.observed_at_ms,
    expires_at_ms: snapshot.expires_at_ms,
    lanes: snapshot.lanes,
  };
}

function validateLanes(value: unknown, observedAtMs: number): FleetBudgetLane[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) {
    invalid("input.snapshot.lanes", `must be an array with 0..${MAX_ITEMS} items`);
  }
  const seen = new Set<string>();
  return value.map((laneValue, index) => {
    const path = `input.snapshot.lanes[${index}]`;
    const lane = requireRecord(laneValue, path);
    requireExactKeys(
      lane,
      path,
      ["lane_id", "measured", "used", "total", "unit", "window"],
      ["lane_id", "measured", "used", "total", "unit"],
    );
    requireIdentifier(lane.lane_id, `${path}.lane_id`);
    if (seen.has(lane.lane_id)) {
      invalid(`${path}.lane_id`, `is a duplicate lane_id '${lane.lane_id}'`);
    }
    seen.add(lane.lane_id);
    if (typeof lane.measured !== "boolean") {
      invalid(`${path}.measured`, "must be a boolean");
    }
    if (!lane.measured) {
      if (lane.used !== null) invalid(`${path}.used`, "must be null when measured is false");
      if (lane.total !== null) invalid(`${path}.total`, "must be null when measured is false");
      if (lane.unit !== null) invalid(`${path}.unit`, "must be null when measured is false");
      if (lane.window !== undefined) invalid(`${path}.window`, "must be omitted when measured is false");
      return {
        lane_id: lane.lane_id,
        measured: false,
        used: null,
        total: null,
        unit: null,
      };
    }
    validateMetric(lane.used, `${path}.used`, 0);
    validateMetric(lane.total, `${path}.total`, 0, true);
    validateUnit(lane.unit, `${path}.unit`);
    const window = lane.window === undefined
      ? undefined
      : validateWindow(lane.window, `${path}.window`, observedAtMs);
    return {
      lane_id: lane.lane_id,
      measured: true,
      used: lane.used,
      total: lane.total,
      unit: lane.unit,
      ...(window === undefined ? {} : { window }),
    };
  });
}

function validateBindings(value: unknown): FleetBudgetObservationBinding[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) {
    invalid("input.bindings", `must be an array with 0..${MAX_ITEMS} items`);
  }
  const candidates = new Set<string>();
  const lanes = new Map<string, string>();
  return value.map((bindingValue, index) => {
    const path = `input.bindings[${index}]`;
    const binding = requireRecord(bindingValue, path);
    requireExactKeys(binding, path, ["candidate_id", "lane_id"], ["candidate_id", "lane_id"]);
    requireIdentifier(binding.candidate_id, `${path}.candidate_id`);
    requireIdentifier(binding.lane_id, `${path}.lane_id`);
    if (candidates.has(binding.candidate_id)) {
      invalid(`${path}.candidate_id`, `is a duplicate candidate_id '${binding.candidate_id}'`);
    }
    candidates.add(binding.candidate_id);
    const firstCandidate = lanes.get(binding.lane_id);
    if (firstCandidate !== undefined) {
      invalid(`${path}.lane_id`, `is already bound to candidate_id '${firstCandidate}'`);
    }
    lanes.set(binding.lane_id, binding.candidate_id);
    return { candidate_id: binding.candidate_id, lane_id: binding.lane_id };
  });
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalSnapshot(snapshot: FleetBudgetSnapshot): object {
  return {
    version: snapshot.version,
    observed_at_ms: snapshot.observed_at_ms,
    expires_at_ms: snapshot.expires_at_ms,
    lanes: [...snapshot.lanes]
      .sort((left, right) => compareStrings(left.lane_id, right.lane_id))
      .map((lane) => ({
        lane_id: lane.lane_id,
        measured: lane.measured,
        used: lane.used,
        total: lane.total,
        unit: lane.unit,
        window: lane.window === undefined
          ? null
          : {
              id: lane.window.id,
              starts_at_ms: lane.window.starts_at_ms,
              ends_at_ms: lane.window.ends_at_ms,
            },
      })),
  };
}

function canonicalBindings(bindings: FleetBudgetObservationBinding[]): object {
  return {
    bindings: [...bindings]
      .sort((left, right) => compareStrings(left.candidate_id, right.candidate_id))
      .map((binding) => ({
        candidate_id: binding.candidate_id,
        lane_id: binding.lane_id,
      })),
  };
}

function projectObservations(
  snapshot: FleetBudgetSnapshot,
  bindings: FleetBudgetObservationBinding[],
  nowMs: number,
): Pick<FleetBudgetObservationResult, "observations" | "diagnostics"> {
  const lanes = new Map(snapshot.lanes.map((lane) => [lane.lane_id, lane]));
  const observations: CompileRouteCandidateObservation[] = [];
  const diagnostics: FleetBudgetObservationResult["diagnostics"] = [];

  for (const binding of [...bindings].sort((left, right) =>
    compareStrings(left.candidate_id, right.candidate_id),
  )) {
    const lane = lanes.get(binding.lane_id);
    if (lane === undefined) {
      diagnostics.push({
        candidate_id: binding.candidate_id,
        lane_id: binding.lane_id,
        reason_codes: ["LANE_NOT_REPORTED"],
      });
      continue;
    }
    if (!lane.measured) {
      diagnostics.push({
        candidate_id: binding.candidate_id,
        lane_id: binding.lane_id,
        reason_codes: ["LANE_UNMEASURED"],
      });
      continue;
    }

    const reasonCodes: string[] = [];
    if (lane.used === null) reasonCodes.push("BUDGET_USED_UNAVAILABLE");
    if (lane.total === null) reasonCodes.push("BUDGET_TOTAL_UNAVAILABLE");
    if (lane.unit === null) reasonCodes.push("BUDGET_UNIT_UNAVAILABLE");
    if (lane.window === undefined) {
      reasonCodes.push("WINDOW_MISSING");
    } else if (nowMs < lane.window.starts_at_ms || nowMs >= lane.window.ends_at_ms) {
      reasonCodes.push("WINDOW_NOT_CURRENT");
    }

    diagnostics.push({
      candidate_id: binding.candidate_id,
      lane_id: binding.lane_id,
      reason_codes: reasonCodes,
    });
    if (reasonCodes.length === 0) {
      observations.push({
        candidate_id: binding.candidate_id,
        status: lane.used! >= lane.total! ? "exhausted" : "green",
        confidence: "measured",
        budget: { used: lane.used!, total: lane.total! },
      });
    }
  }

  return { observations, diagnostics };
}

export function compileFleetBudgetObservations(
  input: FleetBudgetObservationInput,
): FleetBudgetObservationResult {
  const record = requireRecord(input, "input");
  requireExactKeys(record, "input", ["snapshot", "bindings", "now_ms"], ["snapshot", "bindings", "now_ms"]);
  const snapshotRecord = validateSnapshotHeader(record.snapshot);
  requireFiniteInteger(record.now_ms, "input.now_ms");
  const header = validateSnapshotTiming(snapshotRecord);
  if (record.now_ms < header.observed_at_ms) {
    invalid("input.snapshot", "is future-dated");
  }
  if (record.now_ms >= header.expires_at_ms) {
    invalid("input.snapshot", "is expired");
  }
  const snapshot: FleetBudgetSnapshot = {
    ...header,
    lanes: validateLanes(header.lanes, header.observed_at_ms),
  };
  const bindings = validateBindings(record.bindings);
  const projection = projectObservations(snapshot, bindings, record.now_ms);

  return {
    projection: true,
    effects: {
      persisted: false,
      executed: false,
      authorized: false,
      woke_agents: false,
      contacted_providers: false,
    },
    source: {
      kind: "fleetbudget-sanitized-v1",
      observed_at_ms: snapshot.observed_at_ms,
      expires_at_ms: snapshot.expires_at_ms,
      snapshot_sha256: sha256(canonicalSnapshot(snapshot)),
      bindings_sha256: sha256(canonicalBindings(bindings)),
    },
    observations: projection.observations,
    diagnostics: projection.diagnostics,
  };
}
