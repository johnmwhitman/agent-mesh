/**
 * `get_discussion` publishes itself as **"Read-only"** (`src/index.ts`, the tool
 * description) and `discussion-store.ts` repeats the claim in prose
 * ("`getDiscussion` is synchronous and read-only: it never ..."). Nothing
 * enforced either sentence.
 *
 * Measured 2026-08-01 on `a8ec462`: adding a `tx.writeReceipt(...)` inside
 * `getDiscussion` — so that EVERY read appends a row — left `npm run typecheck`
 * at 0, `npm run build` at 0, and `node scripts/run-tests.mjs` at **1359/1359,
 * exit 0**. The three files that drive Discussions end to end
 * (`discussion-tool-boundary`, `discussion-mcp`, `discussion-reservation`, 78
 * tests between them) all passed with the write present. A published contract
 * with no enforcement is a claim, not a contract — priority 3 of the
 * GOAL-PROMPT.
 *
 * 🔴 DO NOT re-derive this from a PRE-deadline read alone. A discussion that is
 * still `active` has nothing to settle, so `receipts 3 -> 3 -> 3` is what a
 * WRITER would print too — the measurement is narrower than the claim, and that
 * exact vacuity was believed and shipped in a comment once already
 * (`NIGHT-2026-08-01-0904.md` GOT WRONG #2). The load-bearing assertion here is
 * the POST-deadline one, taken after the discussion has actually reached a
 * terminal state.
 *
 * 🔴 The +1 receipt this fixture produces is NOT written by the read. It is
 * `discussion.wake.failed.v1`, written by `handleChildExit` — the spawned
 * child's exit callback — and it lands ASYNCHRONOUSLY, at whatever moment the
 * child dies. A probe that counts before a sleep and again after a
 * post-deadline read attributes that row to the read and is simply reading a
 * race (measured both ways 2026-08-01: a no-read control arm reaches the same
 * count). Hence `settle()` below: the count is polled to quiescence BEFORE the
 * post-deadline assertions begin, so what they observe is the read and nothing
 * else. `sweepStranded` — the only function in this file's neighbourhood that
 * writes on a derive — has no caller anywhere under `src/`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

interface Snapshot {
  n: number;
  /** Sorted `action` strings — a stronger identity than a bare count: a write
   *  paired with a delete would hold the count still, and a re-derive that
   *  rewrote a row under a different action would too. */
  actions: string[];
}

interface Ctx {
  client: Client;
  snapshot: () => Snapshot;
}

async function withServer(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-getdisc-readonly-"));
  const dbFile = join(dir, "l.db");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(repoRoot, "src", "index.ts")],
    env: {
      ...(process.env as Record<string, string>),
      // ALL THREE. The db alone lets the startup migrator pair a redirected
      // destination with a defaulted source; the event log is the one that gets
      // forgotten, and this file spawns a server, so it is exactly the case the
      // isolation law is written for.
      MESHFLEET_DB_FILE: dbFile,
      MESHFLEET_DATA_FILE: join(dir, "l.json"),
      MESHFLEET_EVENT_LOG_FILE: join(dir, "l.events.log"),
      // No competing sweeper: an unrelated background writer would make the
      // "unchanged across reads" assertions flaky for a reason that is not the
      // subject under test.
      MESHFLEET_RATIFY_SWEEP_MS: "0",
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "getdisc-readonly", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const db = new Database(dbFile);
    db.prepare("INSERT OR REPLACE INTO fleets (id, data) VALUES (?, ?)").run(
      "F",
      JSON.stringify({ id: "F", status: "running", created_at: Date.now() })
    );
    for (const id of ["A", "B"]) {
      db.prepare("INSERT OR REPLACE INTO agents (id, fleet_id, data) VALUES (?, ?, ?)").run(
        id,
        "F",
        JSON.stringify({ id, fleet_id: "F", role: id, prompt: "p", status: "running" })
      );
      db.prepare("INSERT OR REPLACE INTO inboxes (agent_id, data) VALUES (?, ?)").run(id, "[]");
    }
    db.close();

    const snapshot = (): Snapshot => {
      const d = new Database(dbFile, { readonly: true });
      try {
        const rows = d.prepare("SELECT data FROM receipts").all() as { data: string }[];
        const actions = rows
          .map((r) => String((JSON.parse(r.data) as { action?: unknown }).action ?? "?"))
          .sort();
        return { n: rows.length, actions };
      } finally {
        d.close();
      }
    };
    await fn({ client, snapshot });
  } finally {
    await client.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

const textOf = (r: unknown): string => (r as { content: { text: string }[] }).content[0]!.text;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const ASK = {
  from_agent_id: "A",
  to_agent_id: "B",
  fleet_id: "F",
  payload: "q",
  max_turns: 2,
  timeout_ms: 1000,
  turn_timeout_ms: 1000,
  // The spawn is what drives the discussion to a real terminal state, which is
  // what makes the post-deadline assertion non-vacuous.
  wake_peer: true,
};

interface View {
  status: string;
  attempts: { state: string }[];
}

test("get_discussion is read-only — a post-deadline derive writes no receipt", async () => {
  await withServer(async ({ client, snapshot }) => {
    const ask = await client.callTool({ name: "ask_peer", arguments: ASK as Record<string, unknown> });
    const parsed = JSON.parse(textOf(ask)) as {
      discussion_id: string;
      discussion?: { policy?: { conversation_deadline?: number } };
    };
    const id = parsed.discussion_id;
    const deadline = parsed.discussion?.policy?.conversation_deadline ?? 0;
    assert.ok(deadline > 0, "fixture must expose a conversation_deadline to wait past");

    const pre = snapshot();

    /**
     * Wait past the deadline AND to receipt quiescence. Two separate conditions:
     * the deadline is wall-clock, the child's exit receipt is asynchronous, and
     * neither implies the other. Returns the settled snapshot.
     */
    const settle = async (): Promise<Snapshot> => {
      const giveUp = Date.now() + 20_000;
      let last = snapshot();
      let stable = 0;
      for (;;) {
        await sleep(100);
        const now = snapshot();
        stable = now.n === last.n && now.actions.join() === last.actions.join() ? stable + 1 : 0;
        last = now;
        if (Date.now() >= deadline + 250 && stable >= 5) return now;
        assert.ok(Date.now() < giveUp, "receipts never reached quiescence past the deadline");
      }
    };

    const mid = await settle();

    // CONTROL — the instrument can see a write, and this fixture really did
    // travel through the settle path. Without this, "unchanged" below could pass
    // on a broken snapshot() or on a discussion that never left `active`, and
    // would read as coverage either way.
    assert.ok(
      mid.n > pre.n,
      `CONTROL: the fixture must produce a write before the read is tested (pre=${pre.n} mid=${mid.n})`
    );
    assert.ok(
      mid.actions.some((a) => a.startsWith("discussion.wake.failed.v1")),
      `CONTROL: the settling write is the child-exit receipt, not the read (actions=${mid.actions.join(",")})`
    );

    // CONTROL — the derive under test is genuinely POST-terminal. A read of a
    // still-`active` discussion has nothing to settle, so asserting it writes
    // nothing proves nothing about the claim.
    const first = JSON.parse(
      textOf(await client.callTool({ name: "get_discussion", arguments: { discussion_id: id } }))
    ) as View;
    assert.ok(
      first.status === "expired" || first.status === "deadman" || first.status === "closed",
      `CONTROL: the discussion must be terminal for this assertion to mean anything (status=${first.status})`
    );

    // THE CLAIM. Read repeatedly past the deadline; the receipts table must not
    // move — not on the first derive, which is the only one a terminalizing read
    // would write on, and not on any later one.
    const afterFirst = snapshot();
    assert.deepEqual(
      afterFirst,
      mid,
      "the FIRST post-deadline get_discussion wrote to the ledger — the published description says Read-only"
    );

    for (let i = 0; i < 3; i++) {
      await client.callTool({ name: "get_discussion", arguments: { discussion_id: id } });
    }
    assert.deepEqual(
      snapshot(),
      mid,
      "a repeated post-deadline get_discussion wrote to the ledger — the published description says Read-only"
    );

    // include_receipts is a second code path through the same derive
    // (`src/discussion-store.ts` branches on `=== false`); it must not write
    // either.
    await client.callTool({
      name: "get_discussion",
      arguments: { discussion_id: id, include_receipts: false },
    });
    assert.deepEqual(
      snapshot(),
      mid,
      "get_discussion with include_receipts:false wrote to the ledger — the published description says Read-only"
    );
  });
});
