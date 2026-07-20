/**
 * D3 — wires `src/discussion-store.ts`'s `createDiscussionStore(deps)` to the
 * real ledger, the real one-shot child-process spawn machinery, the real
 * clock, and the real SSE notify path. This module owns the ONE production
 * singleton `DiscussionStore` instance; `src/index.ts` only imports
 * `getDiscussionStore()` and `primeDiscussionSweepIndex()` — it never
 * constructs deps itself.
 *
 * Sources: SUCCESSION/a2a-discussions/drafts/d3-wiring-blueprint.md (§§0-7),
 * SUCCESSION/a2a-discussions/drafts/d3-blueprint-errata.md, and the shape of
 * the real spawn path in src/index.ts's `trySpawn` (reused here only for its
 * argv-building/stdio conventions — deliberately NOT its retry/heartbeat
 * supervisor, since a discussion wake is one-shot by design: blueprint §2
 * step 14 "Never retry automatically").
 */
import { spawn as spawnProcess, type ChildProcess } from "child_process";
import {
  createDiscussionStore,
  DiscussionError,
  type ChildExitInfo,
  type ClockFn,
  type DiscussionNotifyEvent,
  type DiscussionStore,
  type DiscussionStoreDeps,
  type KillFn,
  type LedgerFn,
  type LedgerTx,
  type NewMessage,
  type NotifyFn,
  type SpawnFn,
  type SpawnHandle,
  type SpawnJob,
} from "./discussion-store.js";
import { parseEnvelope, type TranscriptEntry } from "./discussion.js";
import { _writeReceipt, type Message, type MeshData, type Receipt } from "./core.js";
import { readLedger, withLedger } from "./db.js";
import { AGENT_SPAWN_STDIO, buildRunArgs } from "./spawn-config.js";
import { notifySubscribers } from "./realtime.js";

// ============================================================
// Ledger transaction seam — wraps db.ts's real withLedger/MeshData.
// ============================================================

class RealLedgerTx implements LedgerTx {
  constructor(
    private readonly data: MeshData,
    private readonly clockFn: ClockFn
  ) {}

  now(): number {
    return this.clockFn();
  }

  agentExists(agentId: string, fleetId: string): boolean {
    const agent = this.data.agents[agentId];
    return !!agent && agent.fleet_id === fleetId;
  }

  getMessage(messageId: string): Message | undefined {
    return this.data.messages[messageId];
  }

  messagesByCorrelation(discussionId: string): Message[] {
    return Object.values(this.data.messages).filter((m) => m.correlation_id === discussionId);
  }

  receiptsForMessage(messageId: string): Receipt[] {
    const receipts = this.data.receipts ?? {};
    return Object.values(receipts).filter((r) => r.message_id === messageId);
  }

  allReceiptsForDiscussion(discussionId: string): Receipt[] {
    const ids = new Set(this.messagesByCorrelation(discussionId).map((m) => m.id));
    const receipts = this.data.receipts ?? {};
    return Object.values(receipts).filter((r) => ids.has(r.message_id));
  }

  /**
   * Appends one durable message with the server-generated `input.id` — unlike
   * core.ts's `_sendMessage` (which always mints its own id via randomUUID),
   * discussion mutations generate the message id BEFORE the transaction
   * (blueprint §4 step 3 / §6 step 4) so the id can be embedded in the
   * envelope that gets serialized and size-checked before transaction entry.
   * Discussion messages are always direct (never `"*"` broadcast — rejected
   * upstream by the store as `broadcast_rejected`), so this mirrors
   * `_sendMessage`'s direct-message path only: one inbox entry, no
   * `recipients` resolution.
   */
  appendMessage(input: NewMessage): Message {
    if (this.data.messages[input.id]) {
      throw new Error(`duplicate message id ${input.id}`);
    }
    const message: Message = {
      id: input.id,
      from_agent_id: input.from_agent_id,
      to_agent_id: input.to_agent_id,
      fleet_id: input.fleet_id,
      type: input.type,
      payload: input.payload,
      correlation_id: input.correlation_id,
      timestamp: input.timestamp,
      acknowledged: false,
    };
    this.data.messages[input.id] = message;
    if (!this.data.inboxes[input.to_agent_id]) this.data.inboxes[input.to_agent_id] = [];
    this.data.inboxes[input.to_agent_id].push(input.id);
    return message;
  }

  /** Reuses core.ts's `_writeReceipt` — the same idempotent-per-(message,agent,action) helper every other mutator in this codebase writes through. */
  writeReceipt(messageId: string, agentId: string, action: string, note?: string): Receipt {
    const receipt = _writeReceipt(this.data, agentId, messageId, action, note);
    if (!receipt) {
      throw new Error(`writeReceipt: no such message ${messageId}`);
    }
    return receipt;
  }

  countRecentWakeReservations(agentId: string, windowStartMs: number, nowMs: number): number {
    const receipts = this.data.receipts ?? {};
    let count = 0;
    for (const r of Object.values(receipts)) {
      if (r.agent_id !== agentId) continue;
      if (!r.action.startsWith("discussion.wake.reserved.v1:")) continue;
      if (r.timestamp >= windowStartMs && r.timestamp <= nowMs) count++;
    }
    return count;
  }
}

function makeLedgerFn(clockFn: ClockFn): LedgerFn {
  return function ledger<T>(mutator: (tx: LedgerTx) => T): T {
    return withLedger((data) => {
      const tx = new RealLedgerTx(data, clockFn);
      return mutator(tx);
    });
  };
}

// ============================================================
// Spawn / kill seam — one-shot child, reusing the existing
// argv/stdio/child-env conventions (spawn-config.ts), NOT the retry/
// heartbeat supervisor in index.ts's trySpawn (deliberately: blueprint §2
// step 14 forbids automatic retry for a wake attempt).
// ============================================================

function renderTranscript(transcript: TranscriptEntry[]): string {
  if (transcript.length === 0) return "(no prior turns)";
  return transcript
    .map((entry) => `Turn ${entry.turn} — ${entry.message.from_agent_id} -> ${entry.message.to_agent_id}:\n${entry.message.payload}`)
    .join("\n\n");
}

/** Builds the single prompt string passed to the spawned child (blueprint §2
 *  step 8: "Pass agent, discussion, attempt, turn, head, deadline, canonical
 *  transcript, and `reply_discussion` instructions to the child"). The
 *  existing spawn mechanism (buildRunArgs) only accepts one prompt string —
 *  the same shape spawn_fleet/attach_agent already use — so every required
 *  field is embedded in this text rather than passed out-of-band. */
function buildDiscussionPrompt(job: SpawnJob): string {
  return [
    `You are agent "${job.agent_id}", woken to take one turn in meshfleet discussion "${job.discussion_id}".`,
    `This is turn ${job.turn}. attempt_id="${job.attempt_id}". The current canonical head message is "${job.head_message_id}".`,
    `Your reply deadline is epoch ms ${job.deadline} (${new Date(job.deadline).toISOString()}). A reply committed after this deadline is rejected.`,
    ``,
    `Conversation policy: max_turns=${job.policy.max_turns}, conversation_deadline=${job.policy.conversation_deadline}, turn_timeout_ms=${job.policy.turn_timeout_ms}.`,
    ``,
    `Transcript so far:`,
    renderTranscript(job.transcript),
    ``,
    `When you are ready to answer, call the "reply_discussion" MCP tool with EXACTLY these arguments (do not invent ids):`,
    `  agent_id: "${job.agent_id}"`,
    `  discussion_id: "${job.discussion_id}"`,
    `  attempt_id: "${job.attempt_id}"`,
    `  reply_to_message_id: "${job.head_message_id}"`,
    `  type: "question" (to continue the discussion) or "result" (to answer)`,
    `  payload: <your reply text>`,
    `  close: true to end the discussion here, false or omitted to continue`,
    `Reply exactly once — a second reply for this attempt is rejected. Do not call reply_discussion more than once.`,
  ].join("\n");
}

function makeSpawnFn(): SpawnFn {
  return function spawnDiscussionChild(job: SpawnJob, onExit: (info: ChildExitInfo) => void): SpawnHandle {
    const prompt = buildDiscussionPrompt(job);
    const child = spawnProcess("opencode", buildRunArgs({ prompt }), {
      // Same stdin-hang avoidance as trySpawn (spawn-config.ts's documented
      // contract): `opencode run` blocks forever on a piped stdin.
      stdio: AGENT_SPAWN_STDIO,
      env: { ...process.env, AGENT_MESH_CHILD: "1" },
    });

    let settled = false;
    const settle = (info: ChildExitInfo): void => {
      if (settled) return;
      settled = true;
      onExit(info);
    };
    child.on("exit", (code) => settle({ code }));
    child.on("error", () => settle({ code: null }));

    return { attempt_id: job.attempt_id, handle: child };
  };
}

const killFn: KillFn = (handle: SpawnHandle): void => {
  const child = handle.handle as ChildProcess;
  if (child.exitCode === null && child.signalCode === null && !child.killed) {
    child.kill("SIGKILL");
  }
};

// ============================================================
// Notify seam — best-effort, post-commit only (spec §13 invariants 21/22).
// Reuses the existing SSE subscriber registry (realtime.ts) rather than
// inventing a second push channel. Some DiscussionNotifyEvent variants don't
// carry a target agent id directly (`root_sent`/`reply_appended` name a
// message id instead; `terminal` names only the attempt) — those are
// resolved via one best-effort readLedger() lookup. A lookup miss or any
// other failure is swallowed: this function must never throw or block an
// already-committed mutation or a pending/claimed launch.
// ============================================================

function pushDiscussionEvent(agentId: string, event: DiscussionNotifyEvent): void {
  notifySubscribers(agentId, [
    {
      type: "message",
      message_id: "discussion_id" in event ? event.discussion_id : "",
      payload: JSON.stringify(event),
      timestamp: Date.now(),
    },
  ]);
}

const notifyFn: NotifyFn = (event: DiscussionNotifyEvent): void => {
  try {
    switch (event.kind) {
      case "root_sent": {
        const msg = readLedger().messages[event.root_message_id];
        if (msg) pushDiscussionEvent(msg.to_agent_id, event);
        break;
      }
      case "wake_reserved": {
        pushDiscussionEvent(event.agent_id, event);
        break;
      }
      case "reply_appended": {
        const msg = readLedger().messages[event.message_id];
        if (msg) pushDiscussionEvent(msg.to_agent_id, event);
        break;
      }
      case "terminal": {
        // No direct agent id on this event; terminal-state discovery goes
        // through get_discussion / get_inbox polling instead of a targeted
        // push. Best-effort by design — never a correctness dependency.
        break;
      }
    }
  } catch {
    // Notification must never block or roll back an already-committed
    // mutation, or cancel/delay a pending or claimed launch.
  }
};

// ============================================================
// Singleton store + startup sweep-index priming.
// ============================================================

let storeSingleton: DiscussionStore | null = null;

export function getDiscussionStore(): DiscussionStore {
  if (!storeSingleton) {
    const clockFn: ClockFn = Date.now;
    const deps: DiscussionStoreDeps = {
      ledger: makeLedgerFn(clockFn),
      spawn: makeSpawnFn(),
      kill: killFn,
      clock: clockFn,
      notify: notifyFn,
    };
    storeSingleton = createDiscussionStore(deps);
  }
  return storeSingleton;
}

/** Test-only override seam (same shape as this codebase's other reset-for-tests
 *  helpers, e.g. resetSynonymOverrides/resetSkillTaxonomy). `ledger` always
 *  stays wired to the REAL `withLedger`/SQLite seam (tests isolate it via
 *  `withTempDb`, matching every other integration test in this repo) —
 *  only `spawn`/`kill`/`clock`/`notify` are overridable, since a real
 *  `deps.spawn` launches an actual `opencode` child process, which a unit
 *  test must never do. */
export interface DiscussionMcpTestOverrides {
  spawn?: SpawnFn;
  kill?: KillFn;
  clock?: ClockFn;
  notify?: NotifyFn;
}

/**
 * Cheap pre-filter (cdx pass-1 review item 4, part 1): the exact
 * `JSON.stringify` rendering of a `discussion/v1` envelope's first field is
 * `"$meshfleet":"discussion/v1"` — no spaces, fixed key order at construction
 * (discussion-store.ts's `openDiscussion`/`replyDiscussion` always build the
 * envelope object literal with `$meshfleet` first). A plain substring test
 * against the raw payload string costs a fraction of a JSON.parse, so a
 * non-discussion message (the overwhelming majority on most ledgers) is
 * rejected with one `String.prototype.includes` call instead of a parse.
 */
const DISCUSSION_ENVELOPE_MARKER = '"$meshfleet":"discussion/v1"';

/**
 * D3 recorded obligation: prime the store's sweep index at server startup by
 * scanning the ledger for discussion roots — any message carrying a
 * `correlation_id` whose payload parses as a `discussion/v1` envelope — and
 * seeding `knownDiscussionIds` for each.
 *
 * cdx pass-1 review item 4 (FAIL, fixed here): the original version called
 * `store.getDiscussion(id)` per discovered id — a full `deps.ledger()`
 * transaction plus `deriveDiscussion` — which is O(ledger) hydration work at
 * startup for every discussion that has ever existed, before the server can
 * usefully process a tool call. Priming only needs the SET of ids;
 * `seedKnownDiscussionIds` (a new zero-cost, no-ledger-read `DiscussionStore`
 * method) registers them directly. The sweeper still derives fully, but only
 * for ids it actually needs, only when `sweepStranded` itself runs — lazily,
 * not at boot.
 */
export function primeDiscussionSweepIndex(): number {
  const store = getDiscussionStore();
  const data = readLedger();
  const discussionIds = new Set<string>();
  for (const message of Object.values(data.messages)) {
    if (!message.correlation_id) continue;
    if (!message.payload.includes(DISCUSSION_ENVELOPE_MARKER)) continue;
    const envelope = parseEnvelope(message.payload);
    if (envelope && envelope.$meshfleet === "discussion/v1") {
      discussionIds.add(message.correlation_id);
    }
  }
  store.seedKnownDiscussionIds(discussionIds);
  return discussionIds.size;
}

/** Test-only: force a fresh singleton, optionally with fake spawn/kill/clock/
 *  notify seams (mirrors other modules' `resetXForTests`-style helpers). */
export function _resetDiscussionStoreForTests(overrides: DiscussionMcpTestOverrides = {}): void {
  const clockFn: ClockFn = overrides.clock ?? Date.now;
  const deps: DiscussionStoreDeps = {
    ledger: makeLedgerFn(clockFn),
    spawn: overrides.spawn ?? makeSpawnFn(),
    kill: overrides.kill ?? killFn,
    clock: clockFn,
    notify: overrides.notify ?? notifyFn,
  };
  storeSingleton = createDiscussionStore(deps);
}

export { DiscussionError };
