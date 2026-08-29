import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  INSIGHT_CALLER_BREAKDOWN_EMPTY_FIELD_SENTINEL,
  INSIGHT_CALLER_BREAKDOWN_SENTINEL,
  classifyCallerField,
  classifyOutcomeKind,
  classifyRecord,
  runInsightCallerBreakdown,
  summariseRecords,
  type ClassifiedRecord,
} from "../src/insight-caller-breakdown.js";

// ---------------------------------------------------------------------------
// classifyCallerField — gate 2 (absent vs null vs empty vs non-empty)
// ---------------------------------------------------------------------------

test("classifyCallerField: field absent from JSON lands in untracked sentinel", () => {
  const out = classifyCallerField(undefined);
  assert.equal(out.bucket, INSIGHT_CALLER_BREAKDOWN_SENTINEL);
  assert.equal(out.field_present, false);
  assert.equal(out.field_empty, false);
});

test("classifyCallerField: field present, value null lands in untracked sentinel", () => {
  const out = classifyCallerField(null);
  assert.equal(out.bucket, INSIGHT_CALLER_BREAKDOWN_SENTINEL);
  assert.equal(out.field_present, true);
  assert.equal(out.field_empty, false);
});

test("classifyCallerField: field present, value empty string lands in untracked_empty_field sentinel", () => {
  const out = classifyCallerField("");
  assert.equal(out.bucket, INSIGHT_CALLER_BREAKDOWN_EMPTY_FIELD_SENTINEL);
  assert.equal(out.field_present, true);
  assert.equal(out.field_empty, true);
});

test("classifyCallerField: field present, non-string value (producer defect) lands in untracked_empty_field", () => {
  const out = classifyCallerField(42);
  assert.equal(out.bucket, INSIGHT_CALLER_BREAKDOWN_EMPTY_FIELD_SENTINEL);
  assert.equal(out.field_present, true);
  assert.equal(out.field_empty, true);
});

test("classifyCallerField: field present, non-empty string returns the value as the bucket", () => {
  const out = classifyCallerField("solreign");
  assert.equal(out.bucket, "solreign");
  assert.equal(out.field_present, true);
  assert.equal(out.field_empty, false);
});

test("classifyCallerField: oversize string (>= 65 chars) is truncated, not rejected", () => {
  const oversize = "x".repeat(80);
  const out = classifyCallerField(oversize);
  assert.equal(out.field_present, true);
  assert.equal(out.field_empty, false);
  assert.equal(out.bucket.length, 64);
  assert.equal(out.bucket, "x".repeat(64));
});

test("classifyCallerField: 64-char string (boundary) is preserved verbatim", () => {
  const max = "x".repeat(64);
  const out = classifyCallerField(max);
  assert.equal(out.bucket, max);
});

// ---------------------------------------------------------------------------
// classifyOutcomeKind — outcome bucket mapping
// ---------------------------------------------------------------------------

test("classifyOutcomeKind: ok arm returns kind=ok with latency_ms", () => {
  const out = classifyOutcomeKind({ ok: { latency_ms: 1234, prompt_tokens: 10, completion_tokens: 20 } });
  assert.equal(out.kind, "ok");
  assert.equal(out.latency_ms, 1234);
  assert.equal(out.status, 0);
});

test("classifyOutcomeKind: err arm returns kind=err with status", () => {
  const out = classifyOutcomeKind({ err: { status: 502, class: { kind: "transient" } } });
  assert.equal(out.kind, "err");
  assert.equal(out.status, 502);
  assert.equal(out.latency_ms, 0);
});

test("classifyOutcomeKind: abandoned / local_reject / decision return distinct kinds", () => {
  assert.equal(classifyOutcomeKind({ abandoned: null }).kind, "abandoned");
  assert.equal(classifyOutcomeKind({ local_reject: { kind: "denied" } }).kind, "local_reject");
  assert.equal(classifyOutcomeKind({ decision: { candidates: [], influence_enabled: true } }).kind, "decision");
});

test("classifyOutcomeKind: malformed result returns kind=unknown (does not crash)", () => {
  assert.equal(classifyOutcomeKind({}).kind, "unknown");
  assert.equal(classifyOutcomeKind(null).kind, "unknown");
  assert.equal(classifyOutcomeKind("not-an-object").kind, "unknown");
});

// ---------------------------------------------------------------------------
// classifyRecord — full record classification
// ---------------------------------------------------------------------------

test("classifyRecord: returns null when recorded_at_ms is missing or non-numeric", () => {
  assert.equal(classifyRecord({}), null);
  assert.equal(classifyRecord({ recorded_at_ms: "not-a-number" }), null);
});

test("classifyRecord: pre-staged row (no caller field) classifies as untracked", () => {
  const rec = classifyRecord({
    recorded_at_ms: 1787000000000,
    requested_model: "minimax/minimax-m3",
    provider: "minimax",
    served_model: "MiniMax-M3",
    result: { ok: { latency_ms: 1000, prompt_tokens: 5, completion_tokens: 7 } },
  });
  assert.ok(rec);
  assert.equal(rec?.caller_bucket, INSIGHT_CALLER_BREAKDOWN_SENTINEL);
  assert.equal(rec?.caller_field_present, false);
  assert.equal(rec?.caller_field_empty, false);
  assert.equal(rec?.outcome_kind, "ok");
});

test("classifyRecord: new row with caller=solreign classifies under solreign", () => {
  const rec = classifyRecord({
    recorded_at_ms: 1787000000000,
    requested_model: "minimax/minimax-m3",
    provider: "minimax",
    served_model: "MiniMax-M3",
    caller: "solreign",
    result: { ok: { latency_ms: 200, prompt_tokens: 5, completion_tokens: 7 } },
  });
  assert.ok(rec);
  assert.equal(rec?.caller_bucket, "solreign");
  assert.equal(rec?.caller_field_present, true);
  assert.equal(rec?.caller_field_empty, false);
});

test("classifyRecord: new row with caller=null classifies as untracked (header missing on the wire)", () => {
  const rec = classifyRecord({
    recorded_at_ms: 1787000000000,
    provider: "minimax",
    served_model: "MiniMax-M3",
    caller: null,
    result: { decision: { candidates: [], influence_enabled: true } },
  });
  assert.ok(rec);
  assert.equal(rec?.caller_bucket, INSIGHT_CALLER_BREAKDOWN_SENTINEL);
  assert.equal(rec?.caller_field_present, true);
  assert.equal(rec?.caller_field_empty, false);
  assert.equal(rec?.outcome_kind, "decision");
});

// ---------------------------------------------------------------------------
// summariseRecords — bucketing + filtering
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function record(
  bucket: string,
  offsetMs: number,
  outcome: "ok" | "err" | "decision" = "ok",
  provider = "minimax",
  served_model = "MiniMax-M3",
): ClassifiedRecord {
  return {
    recorded_at_ms: NOW + offsetMs,
    caller_bucket: bucket,
    caller_field_present: bucket !== INSIGHT_CALLER_BREAKDOWN_SENTINEL,
    caller_field_empty: false,
    provider,
    served_model,
    requested_model: `${provider}/${served_model}`,
    outcome_kind: outcome,
    status: outcome === "err" ? 502 : 0,
    latency_ms: outcome === "ok" ? 100 : 0,
  };
}

test("summariseRecords: bucketing respects caller_field_present vs absent vs empty", () => {
  const records: ClassifiedRecord[] = [
    record(INSIGHT_CALLER_BREAKDOWN_SENTINEL, 0),
    record(INSIGHT_CALLER_BREAKDOWN_SENTINEL, 100),
    record("solreign", -100),
    record("conductor", -200),
  ];
  const { buckets } = summariseRecords(records);
  assert.equal(buckets.length, 3);
  const untracked = buckets.find((b) => b.caller === INSIGHT_CALLER_BREAKDOWN_SENTINEL);
  assert.ok(untracked);
  assert.equal(untracked?.total, 2);
  assert.equal(untracked?.untracked, true);
  assert.equal(untracked?.untracked_empty_field, false);
  const solreign = buckets.find((b) => b.caller === "solreign");
  assert.ok(solreign);
  assert.equal(solreign?.total, 1);
});

test("summariseRecords: caller filter returns the matching bucket in `filtered`", () => {
  const records: ClassifiedRecord[] = [
    record(INSIGHT_CALLER_BREAKDOWN_SENTINEL, 0),
    record("solreign", -100),
    record("conductor", -200),
  ];
  const { buckets, filtered } = summariseRecords(records, { caller: "solreign" });
  assert.ok(filtered);
  assert.equal(filtered?.caller, "solreign");
  assert.equal(filtered?.total, 1);
  // All buckets still present so an A2A peer can see the totals.
  assert.equal(buckets.length, 3);
});

test("summariseRecords: caller filter for an absent caller returns filtered=undefined", () => {
  const records: ClassifiedRecord[] = [
    record("solreign", -100),
    record("conductor", -200),
  ];
  const { filtered } = summariseRecords(records, { caller: "nosuchprofile" });
  assert.equal(filtered, undefined);
});

test("summariseRecords: ok_ratio uses total as denominator (so all-ok is 1.0)", () => {
  const records: ClassifiedRecord[] = [
    record("a", 0, "ok"),
    record("a", 1, "ok"),
    record("a", 2, "err"),
  ];
  const { buckets } = summariseRecords(records);
  const a = buckets.find((b) => b.caller === "a");
  assert.ok(a);
  assert.equal(a?.total, 3);
  assert.equal(a?.ok, 2);
  assert.equal(a?.err, 1);
  assert.equal(a?.ok_ratio, 2 / 3);
});

test("summariseRecords: empty input yields zero buckets", () => {
  const { buckets, filtered } = summariseRecords([]);
  assert.equal(buckets.length, 0);
  assert.equal(filtered, undefined);
});

// ---------------------------------------------------------------------------
// runInsightCallerBreakdown — end-to-end with an in-memory synthetic file
// ---------------------------------------------------------------------------

function writeSynthetic(
  home: string,
  filename: string,
  rows: ReadonlyArray<Record<string, unknown>>,
): void {
  const dir = join(home, ".routeplane");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(path, body, "utf8");
}

const SOLREIGN_QUERY_HOURS = 168; // 7 days, matching Sol's state.db query

test("end-to-end: synth two callers + untracked + empty-field across 7d; bucket and filter", () => {
  const home = mkdtempSync(join(tmpdir(), "insight-bd-"));
  try {
    const now = NOW;
    const rows: Record<string, unknown>[] = [];
    // solreign: 5 records over the last 3 days, mix of ok/err
    for (let i = 0; i < 5; i++) {
      rows.push({
        recorded_at_ms: now - i * HOUR,
        requested_model: "minimax/minimax-m3",
        provider: "minimax",
        served_model: "MiniMax-M3",
        caller: "solreign",
        result: {
          ok: { latency_ms: 100 + i * 10, prompt_tokens: 1, completion_tokens: 2 },
        },
      });
    }
    rows.push({
      recorded_at_ms: now - 2 * HOUR,
      requested_model: "minimax/minimax-m3",
      provider: "minimax",
      served_model: "MiniMax-M3",
      caller: "solreign",
      result: { err: { status: 502, class: { kind: "transient" } } },
    });
    // conductor: 3 records over the last 2 days
    for (let i = 0; i < 3; i++) {
      rows.push({
        recorded_at_ms: now - i * HOUR,
        requested_model: "minimax/minimax-m3",
        provider: "minimax",
        served_model: "MiniMax-M3",
        caller: "conductor",
        result: {
          ok: { latency_ms: 200, prompt_tokens: 1, completion_tokens: 2 },
        },
      });
    }
    // untracked: 4 records (pre-staged or header-missing)
    for (let i = 0; i < 4; i++) {
      rows.push({
        recorded_at_ms: now - i * HOUR,
        requested_model: "minimax/minimax-m3",
        provider: "minimax",
        served_model: "MiniMax-M3",
        // caller field intentionally absent
        result: { ok: { latency_ms: 150, prompt_tokens: 1, completion_tokens: 2 } },
      });
    }
    // untracked_empty_field: 1 record with caller="" (producer defect)
    rows.push({
      recorded_at_ms: now - 30 * 60 * 1000,
      requested_model: "minimax/minimax-m3",
      provider: "minimax",
      served_model: "MiniMax-M3",
      caller: "",
      result: { ok: { latency_ms: 150, prompt_tokens: 1, completion_tokens: 2 } },
    });
    writeSynthetic(home, "insight.jsonl", rows);

    const all = runInsightCallerBreakdown({
      home,
      now_ms: now,
      hours: 0,
    });
    assert.equal(all.summary.total_buckets, 4); // 3 named + untracked + untracked_empty_field
    assert.equal(all.summary.untracked_bucket_present, true);
    assert.equal(all.summary.untracked_empty_field_present, true);
    const solreign = all.buckets.find((b) => b.caller === "solreign");
    assert.ok(solreign);
    assert.equal(solreign?.total, 6);
    assert.equal(solreign?.ok, 5);
    assert.equal(solreign?.err, 1);
    const untrackedEmpty = all.buckets.find(
      (b) => b.caller === INSIGHT_CALLER_BREAKDOWN_EMPTY_FIELD_SENTINEL,
    );
    assert.ok(untrackedEmpty);
    assert.equal(untrackedEmpty?.total, 1);
    assert.equal(untrackedEmpty?.untracked_empty_field, true);

    const solreign7d = runInsightCallerBreakdown({
      home,
      now_ms: now,
      hours: SOLREIGN_QUERY_HOURS,
      caller: "solreign",
    });
    assert.ok(solreign7d.filtered);
    assert.equal(solreign7d.filtered?.caller, "solreign");
    assert.equal(solreign7d.filtered?.total, 6);
    assert.equal(solreign7d.source.records_in_window, 14);
    assert.equal(solreign7d.summary.untracked_empty_field_present, true);

    const solreignFiltered = runInsightCallerBreakdown({
      home,
      now_ms: now,
      hours: 24,
      caller: "solreign",
    });
    assert.ok(solreignFiltered.filtered);
    assert.equal(solreignFiltered.filtered?.total, 6);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("end-to-end: empty home (no files) yields zero records and zero buckets", () => {
  const home = mkdtempSync(join(tmpdir(), "insight-bd-empty-"));
  try {
    const out = runInsightCallerBreakdown({ home, now_ms: NOW, hours: 24 });
    assert.equal(out.source.records_total, 0);
    assert.equal(out.source.records_in_window, 0);
    assert.equal(out.summary.total_buckets, 0);
    assert.equal(out.filtered, undefined);
    for (const f of out.source.files) {
      assert.equal(f.present, false);
      assert.equal(f.bytes, 0);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("end-to-end: rotated archive (insight.jsonl.1) is read alongside the active file", () => {
  const home = mkdtempSync(join(tmpdir(), "insight-bd-rot-"));
  try {
    const rows = [
      {
        recorded_at_ms: NOW - 3 * DAY,
        provider: "minimax",
        served_model: "MiniMax-M3",
        caller: "solreign",
        result: { ok: { latency_ms: 100, prompt_tokens: 1, completion_tokens: 2 } },
      },
    ];
    writeSynthetic(home, "insight.jsonl.1", rows);
    const out = runInsightCallerBreakdown({
      home,
      now_ms: NOW,
      hours: 7 * 24,
    });
    assert.equal(out.source.records_total, 1);
    const solreign = out.buckets.find((b) => b.caller === "solreign");
    assert.ok(solreign);
    assert.equal(solreign?.total, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("end-to-end: malformed JSONL rows are counted as parse_errors, not thrown", () => {
  const home = mkdtempSync(join(tmpdir(), "insight-bd-bad-"));
  try {
    const dir = join(home, ".routeplane");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "insight.jsonl");
    writeFileSync(
      path,
      [
        "not-json-at-all",
        JSON.stringify({ recorded_at_ms: NOW, result: { ok: { latency_ms: 1 } }, caller: "a" }),
        "{",
        JSON.stringify({ recorded_at_ms: "bad", result: { ok: { latency_ms: 1 } }, caller: "a" }),
      ].join("\n") + "\n",
      "utf8",
    );
    const out = runInsightCallerBreakdown({ home, now_ms: NOW, hours: 24 });
    assert.equal(out.source.records_total, 1);
    assert.equal(out.source.records_parse_error, 3);
    const a = out.buckets.find((b) => b.caller === "a");
    assert.ok(a);
    assert.equal(a?.total, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("end-to-end: time-window filter excludes records older than since_ms", () => {
  const home = mkdtempSync(join(tmpdir(), "insight-bd-wnd-"));
  try {
    const rows = [
      // 8 days old — outside 7d window
      {
        recorded_at_ms: NOW - 8 * DAY,
        provider: "minimax",
        served_model: "MiniMax-M3",
        caller: "solreign",
        result: { ok: { latency_ms: 100, prompt_tokens: 1, completion_tokens: 2 } },
      },
      // 1 day old — inside 7d window
      {
        recorded_at_ms: NOW - 1 * DAY,
        provider: "minimax",
        served_model: "MiniMax-M3",
        caller: "solreign",
        result: { ok: { latency_ms: 100, prompt_tokens: 1, completion_tokens: 2 } },
      },
    ];
    writeSynthetic(home, "insight.jsonl", rows);
    const out = runInsightCallerBreakdown({
      home,
      now_ms: NOW,
      hours: 168,
    });
    assert.equal(out.source.records_total, 2);
    assert.equal(out.source.records_in_window, 1);
    const solreign = out.buckets.find((b) => b.caller === "solreign");
    assert.equal(solreign?.total, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("end-to-end: effects block pins persisted=false / executed=false / authorized=false", () => {
  const home = mkdtempSync(join(tmpdir(), "insight-bd-eff-"));
  try {
    const out = runInsightCallerBreakdown({ home, now_ms: NOW, hours: 24 });
    assert.equal(out.effects.persisted, false);
    assert.equal(out.effects.executed, false);
    assert.equal(out.effects.authorized, false);
    assert.equal(out.effects.woke_agents, false);
    assert.equal(out.effects.contacted_providers, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});