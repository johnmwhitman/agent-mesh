/**
 * Shared test isolation for the SQLite ledger (Phase 2).
 *
 * Replaces the per-file `freshLedger()` in-memory `setLedgerOverride` fake that
 * disappeared when writers moved onto `withLedger`. Each call points the ledger
 * AND the (still flat-file) event log at a throwaway temp dir, so tests exercise
 * the real SQLite seam in full isolation — and no longer leak events into the
 * developer's real `~/.config/opencode/agent-mesh.events.log`.
 *
 * Cleanup MUST `closeDb()` before `rmSync` so the WAL `-wal`/`-shm` sidecars are
 * released (Windows keeps a lock on open handles), then restores the default
 * ledger + event-log paths so a later non-isolated test sees a clean baseline.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDbPath, closeDb, resolveDbFile, importSnapshot } from "../../src/db.js";
import { setEventLogPath, DEFAULT_EVENT_LOG, type MeshData } from "../../src/core.js";

const EMPTY: MeshData = {
  fleets: {},
  agents: {},
  messages: {},
  inboxes: {},
  capabilities: {},
  receipts: {},
  ratifications: {},
  templates: {},
};

export interface TempDb {
  /** The temp directory holding ledger.db + events.log. */
  dir: string;
  /** Absolute path to the SQLite ledger file. */
  dbFile: string;
  /** Bulk-load a snapshot into the ledger (merged over an empty MeshData). */
  seed: (data: Partial<MeshData>) => void;
  /** Close the db, delete the temp dir, restore default paths. */
  cleanup: () => void;
}

/**
 * Point the ledger + event log at a fresh temp dir. Optional `initial` seeds it.
 * Always pair with `cleanup()` (typically in a try/finally or afterEach).
 */
export function withTempDb(initial?: Partial<MeshData>): TempDb {
  const prevDbFile = resolveDbFile();
  const dir = mkdtempSync(join(tmpdir(), "agent-mesh-test-"));
  const dbFile = join(dir, "ledger.db");
  setDbPath(dbFile);
  setEventLogPath(join(dir, "events.log"));

  const seed = (data: Partial<MeshData>): void => {
    importSnapshot({ ...EMPTY, ...data });
  };
  if (initial) seed(initial);

  return {
    dir,
    dbFile,
    seed,
    cleanup: (): void => {
      closeDb();
      setDbPath(prevDbFile);
      setEventLogPath(DEFAULT_EVENT_LOG);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
