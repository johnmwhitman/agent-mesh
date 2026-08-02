import { createHash } from "node:crypto";
import {
  recommendRoute,
  type RecommendRouteCandidate,
  type RecommendRouteInput,
  type RecommendRouteTask,
} from "./recommend-route.js";
import { assertRouteCandidates } from "./route-candidate-validation.js";

export const SPECULATIVE_BACKLOG_PLANNER_VERSION = "meshfleet.speculative-backlog.v0.1";

type RecordValue = Record<string, unknown>;
type SpeculativeKind =
  | "benchmark"
  | "reusable_asset"
  | "code_review"
  | "test_generation"
  | "video_candidate";

export interface SpeculativeBacklogCandidate extends RecommendRouteCandidate {
  quality_tags: string[];
}

export interface SpeculativeBacklogTask {
  task_id: string;
  kind: SpeculativeKind;
  priority: number;
  speculative_approval:
    | { state: "approved"; approval_ref: string }
    | { state: "not_approved" };
  route: RecommendRouteTask;
  required_quality_tags: string[];
  artifact?: {
    source_material: "text_only" | "caller_attested_rights";
    review_scope: "private_review_only";
    human_release_required: true;
  };
}

export interface PlanSpeculativeBacklogInput {
  version: typeof SPECULATIVE_BACKLOG_PLANNER_VERSION;
  candidates: SpeculativeBacklogCandidate[];
  tasks: SpeculativeBacklogTask[];
  candidate_limit?: number;
  // Deliberately NARROWER than RecommendRouteInput["preference"]: the planner's published
  // schema and validator admit only prefer_near_reset. recommend_route's newer
  // exhaust_before_reset objective is not plumbed through here until someone asks for it —
  // widening a published surface as a type side-effect is how contracts drift.
  preference?: { objective: "prefer_near_reset"; now_ms: number };
}

export interface PlanSpeculativeBacklogResult {
  planner_version: typeof SPECULATIVE_BACKLOG_PLANNER_VERSION;
  supplied_input_sha256: string;
  projection: true;
  preference?: { objective: "prefer_near_reset"; now_ms: number; evidence_only: true };
  proposed: Array<{
    task_id: string;
    queue_index: number;
    kind: SpeculativeKind;
    priority: number;
    approval_ref: string;
    candidate_ids: string[];
    rankings: ReturnType<typeof recommendRoute>["ranked"];
    reason_codes: ["CAPACITY_UNMODELED"];
  }>;
  blocked: Array<{
    task_id: string;
    queue_index: number;
    reason_codes: string[];
    candidate_exclusions: Array<{ candidate_id: string; reason_codes: string[] }>;
  }>;
  capacity: { mode: "unmodeled"; status: "unknown" };
  effects: {
    persisted: false;
    executed: false;
    authorized: false;
    woke_agents: false;
    contacted_providers: false;
    polled: false;
    read_credentials: false;
    inferred_provider: false;
    allocated_pool: false;
    reserved_capacity: false;
    scheduled: false;
    spent_budget: false;
    sent: false;
    published: false;
    used_external_identity: false;
  };
}

const EFFECTS: PlanSpeculativeBacklogResult["effects"] = {
  persisted: false,
  executed: false,
  authorized: false,
  woke_agents: false,
  contacted_providers: false,
  polled: false,
  read_credentials: false,
  inferred_provider: false,
  allocated_pool: false,
  reserved_capacity: false,
  scheduled: false,
  spent_budget: false,
  sent: false,
  published: false,
  used_external_identity: false,
};

function invalid(path: string, detail: string): never {
  throw new Error(`plan_speculative_backlog: '${path}' ${detail}`);
}

function record(value: unknown, path: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(path, "must be an object");
  }
  return value as RecordValue;
}

function allowedKeys(value: RecordValue, path: string, keys: readonly string[]): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) invalid(path ? `${path}.${unknown}` : unknown, "is not allowed");
}

function string(value: unknown, path: string, maxLength = 128): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    invalid(path, `must be a non-empty string no longer than ${maxLength} characters`);
  }
}

function token(value: unknown, path: string, maxLength = 128): asserts value is string {
  string(value, path, maxLength);
  if (!/^[a-z0-9][a-z0-9._:-]*$/.test(value)) {
    invalid(path, "must be a lowercase opaque identifier token, not free-form text");
  }
}

function integer(value: unknown, path: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid(path, `must be a finite integer between ${minimum} and ${maximum}`);
  }
}

function tokenArray(value: unknown, path: string, maxItems = 32): asserts value is string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    invalid(path, `must be an array with 0..${maxItems} items`);
  }
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    string(value[index], `${path}[${index}]`, 64);
    const token = value[index] as string;
    if (!/^[a-z0-9][a-z0-9._:-]*$/.test(token)) {
      invalid(`${path}[${index}]`, "must be a lowercase quality token, not free-form text");
    }
    if (seen.has(token)) invalid(path, `contains duplicate token '${token}'`);
    seen.add(token);
  }
}

function candidateRouteShape(value: RecordValue, path: string): RecommendRouteCandidate {
  allowedKeys(value, path, [
    "candidate_id", "capabilities", "privacy", "locality", "coordination_modes",
    "policy_tags", "context_window", "observed_outcomes", "budget", "requested_identity",
    "observed_identity", "quality_tags",
  ]);
  tokenArray(value.quality_tags, `${path}.quality_tags`);
  const { quality_tags: _qualityTags, ...routeCandidate } = value;
  return routeCandidate as unknown as RecommendRouteCandidate;
}

function validateApproval(value: unknown, path: string): void {
  const approval = record(value, path);
  allowedKeys(approval, path, ["state", "approval_ref"]);
  if (approval.state === "approved") {
    token(approval.approval_ref, `${path}.approval_ref`);
    return;
  }
  if (approval.state === "not_approved") {
    if ("approval_ref" in approval) invalid(`${path}.approval_ref`, "is not allowed when state is not_approved");
    return;
  }
  invalid(`${path}.state`, "must be approved or not_approved");
}

function validateArtifact(value: unknown, path: string, required: boolean): void {
  if (value === undefined) {
    if (required) invalid(path, "is required for reusable_asset and video_candidate");
    return;
  }
  const artifact = record(value, path);
  allowedKeys(artifact, path, ["source_material", "review_scope", "human_release_required"]);
  if (!["text_only", "caller_attested_rights"].includes(artifact.source_material as string)) {
    invalid(`${path}.source_material`, "must be text_only or caller_attested_rights");
  }
  if (artifact.review_scope !== "private_review_only") {
    invalid(`${path}.review_scope`, "must equal private_review_only");
  }
  if (artifact.human_release_required !== true) {
    invalid(`${path}.human_release_required`, "must equal true");
  }
}

function validateTask(value: unknown, path: string): asserts value is SpeculativeBacklogTask {
  const task = record(value, path);
  allowedKeys(task, path, [
    "task_id", "kind", "priority", "speculative_approval", "route", "required_quality_tags", "artifact",
  ]);
  token(task.task_id, `${path}.task_id`);
  if (![
    "benchmark", "reusable_asset", "code_review", "test_generation", "video_candidate",
  ].includes(task.kind as string)) {
    invalid(`${path}.kind`, "must be benchmark, reusable_asset, code_review, test_generation, or video_candidate");
  }
  integer(task.priority, `${path}.priority`, 0, 100);
  validateApproval(task.speculative_approval, `${path}.speculative_approval`);
  tokenArray(task.required_quality_tags, `${path}.required_quality_tags`);
  validateArtifact(task.artifact, `${path}.artifact`, task.kind === "reusable_asset" || task.kind === "video_candidate");
  const route = record(task.route, `${path}.route`);
  allowedKeys(route, `${path}.route`, ["required_capabilities", "optional_capabilities", "privacy", "locality", "coordination", "policy_tags", "min_context_tokens"]);
  // Use the landed evaluator as the single validation and semantics authority.
  recommendRoute({ task: route as unknown as RecommendRouteTask, candidates: [{
    candidate_id: "validation-candidate", capabilities: route.required_capabilities as string[],
    privacy: route.privacy as RecommendRouteCandidate["privacy"], locality: route.locality as RecommendRouteCandidate["locality"],
  }] });
}

function validate(input: unknown): asserts input is PlanSpeculativeBacklogInput {
  const source = record(input, "input");
  allowedKeys(source, "", ["version", "candidates", "tasks", "candidate_limit", "preference"]);
  if (source.version !== SPECULATIVE_BACKLOG_PLANNER_VERSION) {
    invalid("version", `must equal ${SPECULATIVE_BACKLOG_PLANNER_VERSION}`);
  }
  if (!Array.isArray(source.candidates) || source.candidates.length < 1 || source.candidates.length > 256) {
    invalid("candidates", "must be an array with 1..256 items");
  }
  const candidateIds = new Set<string>();
  const routeCandidates: RecommendRouteCandidate[] = [];
  for (let index = 0; index < source.candidates.length; index++) {
    const candidate = record(source.candidates[index], `candidates[${index}]`);
    const routeCandidate = candidateRouteShape(candidate, `candidates[${index}]`);
    string(routeCandidate.candidate_id, `candidates[${index}].candidate_id`);
    if (candidateIds.has(routeCandidate.candidate_id)) invalid(`candidates[${index}].candidate_id`, `is a duplicate candidate_id '${routeCandidate.candidate_id}'`);
    candidateIds.add(routeCandidate.candidate_id);
    routeCandidates.push(routeCandidate);
  }
  assertRouteCandidates(routeCandidates, { errorPrefix: "plan_speculative_backlog", path: "candidates" });
  if (!Array.isArray(source.tasks) || source.tasks.length < 1 || source.tasks.length > 64) {
    invalid("tasks", "must be an array with 1..64 items");
  }
  const taskIds = new Set<string>();
  for (let index = 0; index < source.tasks.length; index++) {
    validateTask(source.tasks[index], `tasks[${index}]`);
    const taskId = (source.tasks[index] as SpeculativeBacklogTask).task_id;
    if (taskIds.has(taskId)) invalid(`tasks[${index}].task_id`, `is a duplicate task_id '${taskId}'`);
    taskIds.add(taskId);
  }
  if (source.candidate_limit !== undefined) integer(source.candidate_limit, "candidate_limit", 1, 8);
  if (source.preference !== undefined) {
    const preference = record(source.preference, "preference");
    allowedKeys(preference, "preference", ["objective", "now_ms"]);
    if (preference.objective !== "prefer_near_reset") invalid("preference.objective", "must equal prefer_near_reset");
    integer(preference.now_ms, "preference.now_ms", Number.MIN_SAFE_INTEGER);
  }
}

function canonical(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const values = value.map((entry) => canonical(entry));
    if (key === "candidates") return values.sort((left, right) => compareStrings(String((left as RecordValue).candidate_id), String((right as RecordValue).candidate_id)));
    if (key === "tasks") return values.sort((left, right) => compareStrings(String((left as RecordValue).task_id), String((right as RecordValue).task_id)));
    if (values.every((entry) => typeof entry === "string")) return values.sort((left, right) => compareStrings(String(left), String(right)));
    return values;
  }
  if (typeof value !== "object" || value === null) return value;
  const source = value as RecordValue;
  return Object.fromEntries(Object.keys(source).sort().map((entry) => [entry, canonical(source[entry], entry)]));
}

function suppliedInputHash(input: PlanSpeculativeBacklogInput): string {
  return createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function planSpeculativeBacklog(input: PlanSpeculativeBacklogInput): PlanSpeculativeBacklogResult {
  validate(input);
  const candidates = [...input.candidates].sort((left, right) => compareStrings(left.candidate_id, right.candidate_id));
  const tasks = [...input.tasks].sort((left, right) => right.priority - left.priority || compareStrings(left.task_id, right.task_id));
  const candidateLimit = input.candidate_limit ?? 3;
  const proposed: PlanSpeculativeBacklogResult["proposed"] = [];
  const blocked: PlanSpeculativeBacklogResult["blocked"] = [];

  for (let queueIndex = 0; queueIndex < tasks.length; queueIndex++) {
    const task = tasks[queueIndex]!;
    if (task.speculative_approval.state === "not_approved") {
      blocked.push({ task_id: task.task_id, queue_index: queueIndex, reason_codes: ["SPECULATIVE_APPROVAL_REQUIRED"], candidate_exclusions: [] });
      continue;
    }
    const qualityEligible = candidates.filter((candidate) =>
      task.required_quality_tags.every((tag) => candidate.quality_tags.includes(tag)),
    );
    const qualityExcluded = candidates
      .filter((candidate) => !qualityEligible.includes(candidate))
      .map((candidate) => ({ candidate_id: candidate.candidate_id, reason_codes: ["QUALITY_TAG_MISMATCH"] }));
    const recommendation = qualityEligible.length === 0
      ? undefined
      : recommendRoute({
        task: task.route,
        candidates: qualityEligible.map(({ quality_tags: _qualityTags, ...candidate }) => candidate),
        top_n: Math.min(candidateLimit, qualityEligible.length),
        ...(input.preference === undefined ? {} : { preference: input.preference }),
      });
    if (recommendation === undefined || recommendation.ranked.length === 0) {
      const candidateExclusions = [
        ...qualityExcluded,
        ...(recommendation?.excluded ?? []),
      ].sort((left, right) => compareStrings(left.candidate_id, right.candidate_id));
      blocked.push({ task_id: task.task_id, queue_index: queueIndex, reason_codes: ["NO_ELIGIBLE_CANDIDATES"], candidate_exclusions: candidateExclusions });
      continue;
    }
    proposed.push({
      task_id: task.task_id,
      queue_index: queueIndex,
      kind: task.kind,
      priority: task.priority,
      approval_ref: task.speculative_approval.approval_ref,
      candidate_ids: recommendation.ranked.map(({ candidate_id }) => candidate_id),
      rankings: recommendation.ranked,
      reason_codes: ["CAPACITY_UNMODELED"],
    });
  }

  return {
    planner_version: SPECULATIVE_BACKLOG_PLANNER_VERSION,
    supplied_input_sha256: suppliedInputHash(input),
    projection: true,
    ...(input.preference === undefined ? {} : { preference: { ...input.preference, evidence_only: true as const } }),
    proposed,
    blocked,
    capacity: { mode: "unmodeled", status: "unknown" },
    effects: { ...EFFECTS },
  };
}
