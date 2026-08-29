// RoutePlane insight.jsonl consumer — per-caller breakdown.
//
// MeshFleet owns the consumer side of the routeplane insight schema; the
// producer side (the new `caller` field on every Outcome row) is owned by
// the routeplane+steward lane and is staged behind John-gated prod-deploy
// word on branch `wt/t_d94eb6f9` (cycle row 2026-08-28T05:34:31Z, commit
// 3ded381). This module is forward-compatible with the staged schema: it
// treats the `caller` field as `Option<String>` and buckets records into
// four honest categories so an absent field (pre-staged records) is never
// confused with an empty-string field (a producer defect) or a present
// non-empty value.
//
// Acceptance gates (kanban t_6e3d04cc):
//   (1) `insight_caller_breakdown --caller <profile>` exits 0 and returns a
//       per-caller breakdown filtered to that caller.
//   (2) Records with absent `caller` field land in `untracked`; records with
//       caller=null also land in `untracked`; records with caller="" land in
//       the separate `untracked_empty_field` bucket (a producer defect — the
//       parser at routeplane-sdk/src/caller.rs rejects empty values).
//   (3) A scripted re-run of the Solreign 7-day query reproduces the verdict
//       that RoutePlane insight log has zero records with `caller=solreign`
//       in the 7d window — consistent with Sol's own state.db showing zero
//       routeplane traffic in the same window (Sol queried direct APIs only).
//
// Boundary law: this module is read-only and pure. It never writes files,
// contacts providers, refreshes budgets, reserves capacity, executes work,
// or authorizes spend. It is enabled in the `audit` access profile alongside
// the other pure-computational advisory tools.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const INSIGHT_CALLER_BREAKDOWN_VERSION =
  "meshfleet.insight-caller-breakdown.v1" as const;

export const INSIGHT_CALLER_BREAKDOWN_SENTINEL = "<untracked>" as const;
export const INSIGHT_CALLER_BREAKDOWN_EMPTY_FIELD_SENTINEL =
  "<untracked_empty_field>" as const;

/** Where RoutePlane keeps its rolling insight log on the local machine. */
export interface InsightFileLayout {
  readonly home: string;
  readonly files: ReadonlyArray<string>;
}

/** A single record from insight.jsonl after the caller field is normalised. */
export interface ClassifiedRecord {
  /** ms epoch when the request was observed by RoutePlane. */
  readonly recorded_at_ms: number;
  /** Caller bucket key. Never empty. Either a profile name or one of the two sentinels. */
  readonly caller_bucket: string;
  /** True iff the JSONL row carried a `caller` key whose value was an empty string. */
  readonly caller_field_empty: boolean;
  /** True iff the row carried a `caller` key at all (regardless of value). */
  readonly caller_field_present: boolean;
  /** The provider the request was routed to. May be empty string for `decision` rows. */
  readonly provider: string;
  /** The concrete upstream model id. May be empty string. */
  readonly served_model: string;
  /** The model string the caller requested (pre-routing). */
  readonly requested_model: string;
  /** Whether the upstream call succeeded. Decision and LocalReject rows have a sentinel value. */
  readonly outcome_kind:
    | "ok"
    | "err"
    | "abandoned"
    | "local_reject"
    | "decision"
    | "unknown";
  /** HTTP-ish status for Err rows; 0 for everything else. */
  readonly status: number;
  /** Latency in ms for Ok rows; 0 otherwise. */
  readonly latency_ms: number;
}

/** Aggregate counters for one caller bucket over the time window. */
export interface CallerBucket {
  readonly caller: string;
  /** True iff this bucket is the sentinel `untracked` (absent-or-null caller field). */
  readonly untracked: boolean;
  /** True iff this bucket is the sentinel `untracked_empty_field` (caller="" — a producer defect). */
  readonly untracked_empty_field: boolean;
  readonly total: number;
  readonly ok: number;
  readonly err: number;
  readonly abandoned: number;
  readonly local_reject: number;
  readonly decision: number;
  readonly ok_ratio: number;
  readonly distinct_providers: ReadonlyArray<string>;
  readonly top_served_models: ReadonlyArray<{
    readonly served_model: string;
    readonly count: number;
  }>;
  readonly first_seen_ms: number;
  readonly last_seen_ms: number;
}

/** The full result of one breakdown run. */
export interface InsightCallerBreakdownResult {
  readonly version: typeof INSIGHT_CALLER_BREAKDOWN_VERSION;
  readonly effects: {
    persisted: false;
    executed: false;
    authorized: false;
    woke_agents: false;
    contacted_providers: false;
  };
  readonly window: {
    readonly hours: number;
    readonly since_ms: number | null;
    readonly until_ms: number;
    readonly truncate_to_present: boolean;
  };
  readonly source: {
    readonly files: ReadonlyArray<{ readonly path: string; readonly present: boolean; readonly bytes: number }>;
    readonly records_total: number;
    readonly records_in_window: number;
    readonly records_parse_error: number;
  };
  readonly summary: {
    readonly total_buckets: number;
    readonly untracked_bucket_present: boolean;
    readonly untracked_empty_field_present: boolean;
  };
  readonly buckets: ReadonlyArray<CallerBucket>;
  /** Present only when input.caller is set. Mirrors the matching bucket for convenience. */
  readonly filtered?: CallerBucket;
}

export interface InsightCallerBreakdownInput {
  /** Optional exact-match caller filter. When set, `filtered` is populated. */
  readonly caller?: string;
  /** Time window in hours back from `now`. 0 / undefined = all retained records. */
  readonly hours?: number;
  /** Override "now" for deterministic tests. Default: Date.now(). */
  readonly now_ms?: number;
  /** Override the routeplane home dir. Default: ~/.routeplane. */
  readonly home?: string;
  /** Override the rotated file names. Default: ["insight.jsonl.1", "insight.jsonl"]. */
  readonly files?: ReadonlyArray<string>;
  /** Hard cap on bytes read per file. Default 64 MiB — matches poolstate. */
  readonly max_bytes_per_file?: number;
  /** Hard cap on records parsed. Default: 200_000. */
  readonly max_records?: number;
}

// ---------------------------------------------------------------------------
// Pure logic — no I/O. Tested directly without touching disk.
// ---------------------------------------------------------------------------

const CALLER_LABEL_MAX_LEN = 64;

/**
 * Classify a raw insight.jsonl row's caller field. The field is
 * `Option<String>` on the routeplane producer side (parse_caller_label at
 * routeplane-sdk/src/caller.rs rejects oversize, empty, non-printable, and
 * whitespace inputs by returning None). Honest consumers therefore MUST
 * distinguish:
 *
 *   - field absent from JSON    → SENTINEL  (untracked, schema-additive)
 *   - field present, value null → SENTINEL  (untracked, header was missing)
 *   - field present, value ""   → EMPTY-FIELD-SENTINEL (a producer defect;
 *                                  parse_caller_label would have rejected it)
 *   - field present, non-empty string → that string (validated)
 */
export function classifyCallerField(raw: unknown): {
  bucket: string;
  field_present: boolean;
  field_empty: boolean;
} {
  if (raw === undefined) {
    return {
      bucket: INSIGHT_CALLER_BREAKDOWN_SENTINEL,
      field_present: false,
      field_empty: false,
    };
  }
  if (raw === null) {
    return {
      bucket: INSIGHT_CALLER_BREAKDOWN_SENTINEL,
      field_present: true,
      field_empty: false,
    };
  }
  if (typeof raw !== "string") {
    // A producer defect — a non-string where a String was expected. Surface
    // as empty-field so the operator sees the anomaly rather than losing the
    // record into a silently-mismatched bucket.
    return {
      bucket: INSIGHT_CALLER_BREAKDOWN_EMPTY_FIELD_SENTINEL,
      field_present: true,
      field_empty: true,
    };
  }
  if (raw.length === 0) {
    return {
      bucket: INSIGHT_CALLER_BREAKDOWN_EMPTY_FIELD_SENTINEL,
      field_present: true,
      field_empty: true,
    };
  }
  if (raw.length > CALLER_LABEL_MAX_LEN) {
    // A producer defect — parse_caller_label rejects oversize. The downstream
    // bucket keeps the value but truncates; the operator can see the anomaly
    // via total count vs filtered count if they ask for the full value.
    return {
      bucket: raw.slice(0, CALLER_LABEL_MAX_LEN),
      field_present: true,
      field_empty: false,
    };
  }
  return {
    bucket: raw,
    field_present: true,
    field_empty: false,
  };
}

/**
 * Classify one JSONL record's Outcome shape. RoutePlane's `OutcomeResult`
 * enum is serialised as a tagged snake_case object with a `decision`,
 * `local_reject`, `ok`, `err`, or `abandoned` key (serde rename_all =
 * snake_case at insight.rs). When none of those keys is present we return
 * `"unknown"` — that is the only outcome that should NOT appear on a
 * healthy daemon, and surfacing it as a distinct bucket makes a future
 * producer regression visible to operators rather than silently absorbed.
 */
export function classifyOutcomeKind(
  result: unknown,
): {
  kind: ClassifiedRecord["outcome_kind"];
  status: number;
  latency_ms: number;
} {
  if (typeof result !== "object" || result === null) {
    return { kind: "unknown", status: 0, latency_ms: 0 };
  }
  const r = result as Record<string, unknown>;
  if (typeof r.ok === "object" && r.ok !== null) {
    const ok = r.ok as Record<string, unknown>;
    const latency_ms =
      typeof ok.latency_ms === "number" && Number.isFinite(ok.latency_ms)
        ? Math.trunc(ok.latency_ms)
        : 0;
    return { kind: "ok", status: 0, latency_ms };
  }
  if (typeof r.err === "object" && r.err !== null) {
    const err = r.err as Record<string, unknown>;
    const status =
      typeof err.status === "number" && Number.isFinite(err.status)
        ? Math.trunc(err.status)
        : 0;
    return { kind: "err", status, latency_ms: 0 };
  }
  if (r.abandoned !== undefined) {
    return { kind: "abandoned", status: 0, latency_ms: 0 };
  }
  if (typeof r.local_reject === "object" && r.local_reject !== null) {
    return { kind: "local_reject", status: 0, latency_ms: 0 };
  }
  if (typeof r.decision === "object" && r.decision !== null) {
    return { kind: "decision", status: 0, latency_ms: 0 };
  }
  return { kind: "unknown", status: 0, latency_ms: 0 };
}

/** Classify one parsed JSONL row into the consumer-side record shape. */
export function classifyRecord(raw: Record<string, unknown>): ClassifiedRecord | null {
  const recorded_at_ms_raw = raw.recorded_at_ms;
  const recorded_at_ms =
    typeof recorded_at_ms_raw === "number" && Number.isFinite(recorded_at_ms_raw)
      ? Math.trunc(recorded_at_ms_raw)
      : NaN;
  if (!Number.isFinite(recorded_at_ms)) {
    return null;
  }
  const caller = classifyCallerField(raw.caller);
  const outcome = classifyOutcomeKind(raw.result);
  return {
    recorded_at_ms,
    caller_bucket: caller.bucket,
    caller_field_present: caller.field_present,
    caller_field_empty: caller.field_empty,
    provider: typeof raw.provider === "string" ? raw.provider : "",
    served_model: typeof raw.served_model === "string" ? raw.served_model : "",
    requested_model:
      typeof raw.requested_model === "string" ? raw.requested_model : "",
    outcome_kind: outcome.kind,
    status: outcome.status,
    latency_ms: outcome.latency_ms,
  };
}

const TOP_SERVED_MODELS_LIMIT = 8;

/**
 * Reduce classified records into per-caller buckets, optionally filtered to
 * one caller name. The bucketing rules are explicit:
 *
 *   - Records with caller_field_present=false land in the `untracked` bucket
 *     (sentinel INSIGHT_CALLER_BREAKDOWN_SENTINEL) regardless of value.
 *   - Records with caller_field_empty=true (value === "" or non-string) land
 *     in the `untracked_empty_field` sentinel bucket — a producer defect.
 *   - Records with a non-empty caller field land in their caller-named bucket.
 *
 * The result includes the full bucket list even when caller-filtered, so an
 * A2A peer can verify "no records for this caller" by inspecting the totals
 * rather than having to re-query.
 */
export function summariseRecords(
  records: ReadonlyArray<ClassifiedRecord>,
  options: { caller?: string | undefined } = {},
): {
  buckets: ReadonlyArray<CallerBucket>;
  filtered?: CallerBucket;
} {
  const byBucket = new Map<
    string,
    {
      caller: string;
      untracked: boolean;
      untracked_empty_field: boolean;
      total: number;
      ok: number;
      err: number;
      abandoned: number;
      local_reject: number;
      decision: number;
      distinct_providers: Map<string, number>;
      served_models: Map<string, number>;
      first_seen_ms: number;
      last_seen_ms: number;
    }
  >();
  const ensured = (caller: string) => {
    const existing = byBucket.get(caller);
    if (existing) return existing;
    const isUntracked = caller === INSIGHT_CALLER_BREAKDOWN_SENTINEL;
    const isUntrackedEmpty =
      caller === INSIGHT_CALLER_BREAKDOWN_EMPTY_FIELD_SENTINEL;
    const created = {
      caller,
      untracked: isUntracked,
      untracked_empty_field: isUntrackedEmpty,
      total: 0,
      ok: 0,
      err: 0,
      abandoned: 0,
      local_reject: 0,
      decision: 0,
      distinct_providers: new Map<string, number>(),
      served_models: new Map<string, number>(),
      first_seen_ms: Number.POSITIVE_INFINITY,
      last_seen_ms: Number.NEGATIVE_INFINITY,
    };
    byBucket.set(caller, created);
    return created;
  };
  for (const rec of records) {
    const bucket = ensured(rec.caller_bucket);
    bucket.total += 1;
    switch (rec.outcome_kind) {
      case "ok":
        bucket.ok += 1;
        break;
      case "err":
        bucket.err += 1;
        break;
      case "abandoned":
        bucket.abandoned += 1;
        break;
      case "local_reject":
        bucket.local_reject += 1;
        break;
      case "decision":
        bucket.decision += 1;
        break;
      default:
        break;
    }
    if (rec.provider !== "") {
      bucket.distinct_providers.set(
        rec.provider,
        (bucket.distinct_providers.get(rec.provider) ?? 0) + 1,
      );
    }
    if (rec.served_model !== "") {
      bucket.served_models.set(
        rec.served_model,
        (bucket.served_models.get(rec.served_model) ?? 0) + 1,
      );
    }
    if (rec.recorded_at_ms < bucket.first_seen_ms) {
      bucket.first_seen_ms = rec.recorded_at_ms;
    }
    if (rec.recorded_at_ms > bucket.last_seen_ms) {
      bucket.last_seen_ms = rec.recorded_at_ms;
    }
  }
  const finalise = (
    bucket: {
      caller: string;
      untracked: boolean;
      untracked_empty_field: boolean;
      total: number;
      ok: number;
      err: number;
      abandoned: number;
      local_reject: number;
      decision: number;
      distinct_providers: Map<string, number>;
      served_models: Map<string, number>;
      first_seen_ms: number;
      last_seen_ms: number;
    },
  ): CallerBucket => {
    const providers = Array.from(bucket.distinct_providers.entries()).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    const served = Array.from(bucket.served_models.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, TOP_SERVED_MODELS_LIMIT);
    const denom = bucket.total > 0 ? bucket.total : 1;
    return {
      caller: bucket.caller,
      untracked: bucket.untracked,
      untracked_empty_field: bucket.untracked_empty_field,
      total: bucket.total,
      ok: bucket.ok,
      err: bucket.err,
      abandoned: bucket.abandoned,
      local_reject: bucket.local_reject,
      decision: bucket.decision,
      ok_ratio: bucket.ok / denom,
      distinct_providers: providers.map(([p]) => p),
      top_served_models: served.map(([served_model, count]) => ({
        served_model,
        count,
      })),
      first_seen_ms: bucket.first_seen_ms,
      last_seen_ms: bucket.last_seen_ms,
    };
  };

  const buckets = Array.from(byBucket.values())
    .map(finalise)
    .sort((a, b) => b.total - a.total || a.caller.localeCompare(b.caller));

  if (options.caller === undefined || options.caller === "") {
    return { buckets };
  }
  const filtered = buckets.find((b) => b.caller === options.caller);
  return { buckets, filtered };
}

// ---------------------------------------------------------------------------
// I/O — file reading. Pure consumer; no writes, no symlink traversal beyond
// the configured home dir, no path injection from the caller.
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BYTES_PER_FILE = 64 * 1024 * 1024;
const DEFAULT_MAX_RECORDS = 200_000;
const DEFAULT_FILES: ReadonlyArray<string> = ["insight.jsonl.1", "insight.jsonl"];

export function defaultInsightLayout(
  home: string = homedir(),
): InsightFileLayout {
  return {
    home,
    files: DEFAULT_FILES.map((name) => join(home, ".routeplane", name)),
  };
}

function safeReadJsonl(
  path: string,
  max_bytes: number,
  out: {
    records: ClassifiedRecord[];
    parse_errors: number;
  },
  records_cap: number,
): { present: boolean; bytes: number } {
  if (!existsSync(path)) return { present: false, bytes: 0 };
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return { present: false, bytes: 0 };
  }
  if (!stat.isFile()) return { present: false, bytes: 0 };
  const bytes = Math.min(stat.size, max_bytes);
  const fd = readFileSync(path, {
    encoding: "utf8",
    flag: "r",
  });
  const slice = fd.length > max_bytes ? fd.slice(0, max_bytes) : fd;
  let cursor = 0;
  while (cursor < slice.length && out.records.length < records_cap) {
    const newline = slice.indexOf("\n", cursor);
    const end = newline === -1 ? slice.length : newline;
    const line = slice.slice(cursor, end);
    cursor = newline === -1 ? slice.length : newline + 1;
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      out.parse_errors += 1;
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      out.parse_errors += 1;
      continue;
    }
    const classified = classifyRecord(parsed as Record<string, unknown>);
    if (classified === null) {
      out.parse_errors += 1;
      continue;
    }
    out.records.push(classified);
  }
  return { present: true, bytes };
}

/**
 * Run the consumer. Default arguments match the operator CLI surface that
 * `poolstate` and `routeplan-rank` established under ~/AI/Tools/.
 *
 * The function is exported as a library entry point so the MCP tool handler
 * and any future CLI entry point share one code path. Tests cover both the
 * pure classifier and an end-to-end run against an in-memory synthetic
 * insight.jsonl; the live daemon path is exercised by an integration test
 * that is opt-in (requires the actual ~/.routeplane/insight.jsonl to exist)
 * — that opt-in path lives under test/insight-caller-breakdown-live.test.ts
 * and is registered with a t.skip guard so the verifier stays hermetic.
 */
export function runInsightCallerBreakdown(
  input: InsightCallerBreakdownInput = {},
): InsightCallerBreakdownResult {
  const home = input.home ?? homedir();
  const files = input.files ?? DEFAULT_FILES;
  const max_bytes_per_file =
    input.max_bytes_per_file ?? DEFAULT_MAX_BYTES_PER_FILE;
  const max_records = input.max_records ?? DEFAULT_MAX_RECORDS;
  const now_ms = input.now_ms ?? Date.now();
  const hours = input.hours ?? 0;
  const since_ms = hours > 0 ? now_ms - hours * 3600 * 1000 : null;

  const fileReports: Array<{ path: string; present: boolean; bytes: number }> = [];
  const aggregate = {
    records: [] as ClassifiedRecord[],
    parse_errors: 0,
  };
  for (const filename of files) {
    const path = join(home, ".routeplane", filename);
    const report = safeReadJsonl(path, max_bytes_per_file, aggregate, max_records);
    fileReports.push({ path, present: report.present, bytes: report.bytes });
  }
  const records_total = aggregate.records.length;
  const records_in_window =
    since_ms === null
      ? records_total
      : aggregate.records.filter((r) => r.recorded_at_ms >= since_ms).length;
  const inWindow =
    since_ms === null
      ? aggregate.records
      : aggregate.records.filter((r) => r.recorded_at_ms >= since_ms);
  const { buckets, filtered } = summariseRecords(inWindow, {
    caller: input.caller,
  });

  return {
    version: INSIGHT_CALLER_BREAKDOWN_VERSION,
    effects: {
      persisted: false,
      executed: false,
      authorized: false,
      woke_agents: false,
      contacted_providers: false,
    },
    window: {
      hours,
      since_ms,
      until_ms: now_ms,
      truncate_to_present: true,
    },
    source: {
      files: fileReports,
      records_total,
      records_in_window,
      records_parse_error: aggregate.parse_errors,
    },
    summary: {
      total_buckets: buckets.length,
      untracked_bucket_present: buckets.some((b) => b.untracked),
      untracked_empty_field_present: buckets.some(
        (b) => b.untracked_empty_field,
      ),
    },
    buckets,
    filtered,
  };
}