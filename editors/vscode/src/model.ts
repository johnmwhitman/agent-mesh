/**
 * Pure data layer for the Meshfleet VS Code inspector. Everything here parses
 * the JSON emitted by `agent-mesh --export` (and the text from `--verify`)
 * into view-ready shapes — no VS Code APIs, no I/O, fully unit-testable.
 *
 * The extension deliberately reads the ledger THROUGH the shipped CLI instead
 * of opening SQLite itself: better-sqlite3 is a native module compiled for
 * Node's ABI, not VS Code's Electron, and the CLI boundary is the shipped,
 * versioned, already-tested read path.
 */

export interface AgentView {
  id: string;
  role: string;
  status: string;
}

export interface FleetView {
  id: string;
  status: string;
  createdAt: number;
  agents: AgentView[];
}

export interface CouncilView {
  messageId: string;
  subject: string;
  status: string;
  quorum: number;
  approvals: number;
  voters: number;
}

export interface LedgerModel {
  fleets: FleetView[];
  councils: CouncilView[];
}

export interface VerifyVerdict {
  ok: boolean;
  summary: string;
}

export interface VerifyEnvelopeFinding {
  severity: string;
  check: string;
  detail: string;
}

export interface VerifyEnvelope {
  ok: boolean;
  summary: string;
  errors: number;
  warnings: number;
  findings: VerifyEnvelopeFinding[];
}

const VOTE_APPROVE_RE = /^r-ack(?::(?:0|[1-9]\d*))?$/;
const VOTE_DECLINE_RE = /^r-decline(?::(?:0|[1-9]\d*))?$/;

export function parseLedgerExport(json: string): LedgerModel {
  let raw: any;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`ledger export was not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const fleetsRaw: Record<string, any> = raw.fleets ?? {};
  const agentsRaw: Record<string, any> = raw.agents ?? {};
  const receiptsRaw: Record<string, any> = raw.receipts ?? {};
  const ratsRaw: Record<string, any> = raw.ratifications ?? {};

  const fleets: FleetView[] = Object.values(fleetsRaw)
    .map((f: any): FleetView => ({
      id: String(f.id),
      status: String(f.status ?? "unknown"),
      createdAt: Number(f.created_at ?? 0),
      agents: Object.values(agentsRaw)
        .filter((a: any) => a.fleet_id === f.id)
        .map((a: any): AgentView => ({
          id: String(a.id),
          role: String(a.role ?? "?"),
          status: String(a.status ?? "unknown"),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => b.createdAt - a.createdAt);

  const councils: CouncilView[] = Object.values(ratsRaw)
    .map((r: any): CouncilView => {
      // Effective approvals: latest vote per voter, seq then timestamp then
      // decline-wins — mirrors the shipped tally rule closely enough for a
      // progress display (the CLI remains the authority).
      const best = new Map<string, { approve: boolean; seq: number; ts: number }>();
      for (const rec of Object.values(receiptsRaw) as any[]) {
        if (rec.message_id !== r.message_id) continue;
        if (!Array.isArray(r.voters) || !r.voters.includes(rec.agent_id)) continue;
        const approve = VOTE_APPROVE_RE.test(rec.action);
        const decline = VOTE_DECLINE_RE.test(rec.action);
        if (!approve && !decline) continue;
        const seqMatch = /:(\d+)$/.exec(rec.action);
        const cand = { approve, seq: seqMatch ? Number(seqMatch[1]) : 0, ts: Number(rec.timestamp ?? 0) };
        const cur = best.get(rec.agent_id);
        const later =
          !cur ||
          cand.seq > cur.seq ||
          (cand.seq === cur.seq && cand.ts > cur.ts) ||
          (cand.seq === cur.seq && cand.ts === cur.ts && !cand.approve && cur.approve);
        if (later) best.set(rec.agent_id, cand);
      }
      let approvals = 0;
      for (const v of best.values()) if (v.approve) approvals++;
      return {
        messageId: String(r.message_id),
        subject: String(r.subject ?? ""),
        status: String(r.status ?? "open"),
        quorum: Number(r.quorum ?? 0),
        approvals,
        voters: Array.isArray(r.voters) ? r.voters.length : 0,
      };
    })
    .sort((a, b) => a.subject.localeCompare(b.subject));

  return { fleets, councils };
}

export function verdictFromVerifyOutput(exitCode: number, stdout: string): VerifyVerdict {
  const summary = stdout.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "(no output)";
  return { ok: exitCode === 0, summary };
}

function assertString(value: unknown, label: string): void {
  if (typeof value !== "string") throw new Error(`verify envelope ${label} must be a string`);
}

function assertNumber(value: unknown, label: string): void {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`verify envelope ${label} must be a number`);
  }
}

function assertBoolean(value: unknown, label: string): void {
  if (typeof value !== "boolean") throw new Error(`verify envelope ${label} must be a boolean`);
}

export function parseVerifyEnvelope(json: string): VerifyEnvelope {
  let envelope: any;
  try {
    envelope = JSON.parse(json);
  } catch (err) {
    throw new Error(`verify output was not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!envelope || typeof envelope !== "object") {
    throw new Error("verify envelope must be an object");
  }

  if (envelope.schema !== "meshfleet.inspect/v1") {
    throw new Error(`verify envelope has unsupported schema: ${String(envelope.schema)}`);
  }

  if (envelope.kind !== "verify") {
    throw new Error(`verify envelope has unexpected kind: ${String(envelope.kind)}`);
  }

  const data = envelope.data;
  if (!data || typeof data !== "object") {
    throw new Error("verify envelope missing data object");
  }

  assertNumber(data.errors, "data.errors");
  assertNumber(data.warnings, "data.warnings");
  const counts = data.counts;
  if (!counts || typeof counts !== "object") {
    throw new Error("verify envelope missing data.counts");
  }
  assertBoolean(data.ok, "data.ok");

  ["fleets", "agents", "messages", "receipts", "councils"].forEach((key) => {
    assertNumber((counts as Record<string, unknown>)[key], `data.counts.${key}`);
  });

  const findingsRaw = data.findings;
  if (!Array.isArray(findingsRaw)) {
    throw new Error("verify envelope data.findings must be an array");
  }

  const findings: VerifyEnvelopeFinding[] = findingsRaw.map((finding: any, idx: number) => {
    if (!finding || typeof finding !== "object") {
      throw new Error(`verify envelope data.findings[${idx}] must be an object`);
    }
    assertString(finding.severity, `data.findings[${idx}].severity`);
    assertString(finding.check, `data.findings[${idx}].check`);
    assertString(finding.detail, `data.findings[${idx}].detail`);
    return { severity: finding.severity, check: finding.check, detail: finding.detail };
  });

  const errors = data.errors;
  const warnings = data.warnings;
  const summary = `${errors} errors, ${warnings} warnings (fleets ${counts.fleets} · agents ${counts.agents} · messages ${counts.messages} · receipts ${counts.receipts} · councils ${counts.councils})`;

  return {
    ok: data.ok,
    summary,
    errors,
    warnings,
    findings,
  };
}
