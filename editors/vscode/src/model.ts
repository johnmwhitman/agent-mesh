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
