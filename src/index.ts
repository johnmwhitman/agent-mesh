#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import { createRequire } from "module";
import { resolveEnv } from "./env.js";
import { requireAuditIsolationEnvironment } from "./audit-access-profile.js";

// Single source of truth for the advertised version — package.json.
// (The literal here drifted to 0.7.0 while releases moved to 0.11.x.)
const MESH_VERSION: string = createRequire(import.meta.url)("../package.json").version;
import {
  appendEvent,
  ackMessage,
  getReceipts,
  writeReceipt,
  autoRegisterFromAgent,
  _createFleet,
  _registerAgent,
  discoverPremadeAgents,
  getFleetTimeoutMs,
  getInbox,
  listFleets,
  markAgentFinished,
  MAX_BATCH_MESSAGES,
  MAX_PAYLOAD_BYTES,
  MESSAGE_TYPES,
  MessageType,
  recoverInterruptedAgents,
  reconcileAbandonedFleets,
  registerCapability,
  routeWork,
  sendMessage,
  sendMessages,
  setFleetTimeout,
  defaultDataFile,
  DEFAULT_EVENT_LOG,
} from "./core.js";
import { defaultDbFile, readLedger, resolveDbFile, withLedger } from "./db.js";
import { migrateJsonToSqlite } from "./migrate.js";
import { checkRateLimit, getHealth, ping } from "./health.js";
import {
  saveFleetTemplate as saveFleetTemplateFn,
  listFleetTemplates as listFleetTemplatesFn,
  spawnFromTemplate as spawnFromTemplateFn,
  type TemplateAgent,
} from "./templates.js";
import {
  openRatification,
  castVote,
  tallyRatification,
  resolveRatification,
  sweepRatifications,
} from "./ratify.js";
import { verifyLedger, verifyLedgerFile } from "./verify.js";
import { buildVerifyEnvelopeV2 } from "./verify-envelope-v2.js";
import { buildVerifyEnvelopeV3 } from "./verify-envelope-v3.js";
import { notifySubscribers } from "./realtime.js";
import { isSseServerRunning, startSseServer, stopSseServer, subscribeInboxUrl } from "./sse-server.js";
import { createHeartbeat } from "./heartbeat.js";
import {
  computeBackoff,
  scheduleRetry as scheduleAgentRetry,
  shouldRetry as shouldAgentRetry,
} from "./retry.js";
import { recordRoutingOutcome } from "./routing-feedback.js";
import { installCrashHandlers } from "./crash-handler.js";
import { SweepHealth, runSweepTick } from "./sweep-health.js";
import { summarizeCollection } from "./collection-summary.js";
import { isHollowSuccess, HOLLOW_SUCCESS_REASON } from "./hollow-result.js";
import {
  readResultContract,
  resultPathFor,
  withResultContract,
  type ResultContractStatus,
} from "./result-contract.js";
import { recommendRoute, type RecommendRouteInput } from "./recommend-route.js";
import {
  planSpeculativeBacklog,
  type PlanSpeculativeBacklogInput,
} from "./speculative-backlog-planner.js";
import {
  compileRouteCandidates,
  type CompileRouteCandidatesInput,
} from "./compile-route-candidates.js";
import {
  firstError,
  requireString,
  requirePresentString,
  requireBoolean,
  optionalBoolean,
  optionalNonBlankString,
  optionalModelSelector,
  requireNumber,
  optionalNumber,
  requireStringArray,
  requireEnum,
} from "./tool-args.js";
import { buildFailureDetail, projectSuccessDiagnostics } from "./spawn-attempt.js";
import { getDefaultRuntimeAdapter, requireRuntimeAdapter, availableRuntimeIds } from "./runtime/registry.js";
import type { RuntimeAdapter } from "./runtime/types.js";
import { decideFailover } from "./failover.js";
import { defaultLifecycleMode, LifecycleExecutionCoordinator, repairLifecycleOutbox } from "./lifecycle-execution.js";
import { getDiscussionStore, primeDiscussionSweepIndex } from "./discussion-mcp.js";
import {
  DiscussionError,
  type AskPeerParams,
  type WakeAgentParams,
  type ReplyDiscussionParams,
  type GetDiscussionParams,
} from "./discussion-store.js";

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const accessProfile = requireAuditIsolationEnvironment(process.env, {
  dbFile: defaultDbFile(),
  dataFile: defaultDataFile(),
  eventLogFile: DEFAULT_EVENT_LOG,
});
const isAuditProfile = accessProfile.profile === "audit";
if (accessProfile.profile === "audit") {
  process.env.MESHFLEET_ISOLATION_ROOT = accessProfile.isolationRoot;
  process.env.MESHFLEET_DB_FILE = accessProfile.dbFile;
  process.env.MESHFLEET_DATA_FILE = accessProfile.dataFile;
  process.env.MESHFLEET_EVENT_LOG_FILE = accessProfile.eventLogFile;
}
const AUDIT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "compile_route_candidates",
  "ping",
  "plan_speculative_backlog",
  "recommend_route",
]);
const toolAllowedByAccessProfile = (name: string): boolean =>
  !isAuditProfile || AUDIT_TOOL_NAMES.has(name);

const server = new Server(
  { name: "agent-mesh", version: MESH_VERSION },
  { capabilities: { tools: {} } }
);

// ---------------------------------------------------------------------------
// Agent Spawning (orchestration concern - not pure data)
// ---------------------------------------------------------------------------

interface SpawnAgentInput {
  fleetId: string;
  role: string;
  prompt: string;
  agentFile?: string;
  requestedModel?: string;
  /** Runtime adapter id. Absent = the process default (opencode-cli). */
  runtime?: string;
  /** Opaque workspace binding the caller claims is verified isolation. Never a path. */
  workspaceBinding?: string;
  /**
   * Runtime ids already tried for this agent, oldest first. In-memory only: it exists to stop
   * failover from re-offering a runtime that just refused, which would spend the retry budget
   * proving the same thing twice.
   */
  attemptedRuntimes?: readonly string[];
}

const runtimeAdapter = getDefaultRuntimeAdapter();
const lifecycleCoordinator = new LifecycleExecutionCoordinator(runtimeAdapter);

/**
 * Inner spawn loop. attempt is 1-indexed (first attempt = 1).
 * On any transient failure path, decides retry vs permanent via shouldAgentRetry().
 */
/**
 * The exact spec a given adapter would be started with.
 *
 * Extracted so failover can ask a CANDIDATE adapter `validate(spec)` about the spec it would
 * really receive. Rebuilding an approximation here would be the classic guard that cannot see its
 * own subject: it would answer about a spec nobody runs.
 */
function buildExecutionSpec(
  input: SpawnAgentInput,
  agentId: string,
  adapter: RuntimeAdapter,
  resultPath: string,
) {
  // Both branches resolve out of the SAME module-level registry, so `runtime: "opencode-cli"`
  // yields the identical instance the default path uses. Comparing instances — not comparing the
  // id string against a literal — is what makes "explicitly asked for the default" and "asked for
  // nothing" the same execution, instead of two paths that drift.
  const nonDefaultRuntime = adapter !== runtimeAdapter;
  return {
    fleetId: input.fleetId,
    agentId,
    role: input.role,
    // The prompt the runtime receives, not the prompt the caller sent: the result contract is
    // appended here so BOTH spawn paths teach it from one place. The caller's text is preserved
    // verbatim on the Agent row, which is what `collect_results` and the ledger still show.
    prompt: withResultContract(input.prompt, resultPath),
    requestedAgent: input.agentFile,
    requestedModel: input.requestedModel,
    cwd: process.cwd(),
    timeoutMs: adapter.describe().defaultTimeoutMs,
    // The child is told the path twice — env and prompt — because agents routinely never read
    // env, and an unread instruction is an absent one.
    //
    // ⚠️ This is the one field that now differs on the DEFAULT path too, and the old comment
    // claiming a byte-identical opencode environment is no longer true of `RESULT_PATH`. It is
    // still true of everything else: `environment` is merged, `environmentPolicy` is not set
    // here, so the host environment opencode authenticates with is untouched. Setting the POLICY
    // unconditionally would scrub that environment; setting one explicit variable does not.
    environment: { RESULT_PATH: resultPath },
    //
    // These fields are REQUESTS, not attestations. `kimi.ts` refuses an inherited environment, an
    // absent permission request, and a resumed session; a spec without them fails validation and
    // `start()` throws, which is how a selected Kimi agent died before this. Naming them here says
    // what MeshFleet actually does: it spawns an unattended agent that may edit its workspace.
    ...(nonDefaultRuntime
      ? {
          environmentPolicy: { mode: "scrubbed" as const },
          session: { mode: "new" as const },
          permissions: { mode: "unattended" as const, edit: "workspace" as const },
          // Only the CALLER may claim isolation, and the claim is worth nothing on its own — the
          // adapter's operator-configured admission list is the deciding key. Omitted when the
          // caller named no binding, so the adapter refuses rather than MeshFleet inventing an
          // isolation guarantee it does not provide.
          ...(input.workspaceBinding
            ? { workspace: { isolation: "verified" as const, bindingId: input.workspaceBinding } }
            : {}),
        }
      : {}),
  };
}

/**
 * Inner spawn loop. attempt is 1-indexed (first attempt = 1).
 * On any transient failure path, decides retry vs failover vs permanent.
 */
function trySpawn(input: SpawnAgentInput, agentId: string, attempt: number): void {
  // Resolve ONCE and use the same adapter for describe/start/cancel/wait. Mixing them would give
  // a Kimi agent opencode's timeout and opencode's cancel semantics, which is worse than not
  // supporting selection at all: it would look like it worked.
  const adapter = input.runtime ? requireRuntimeAdapter(input.runtime) : runtimeAdapter;
  // Per ATTEMPT. Reusing one path across retries would read attempt 1's envelope and bank it as
  // attempt 2's declaration — an outcome recorded for a run that never declared it.
  const resultPath = resultPathFor(agentId, attempt);
  const spec = buildExecutionSpec(input, agentId, adapter, resultPath);
  // Append BEFORE the spawn, not after it resolves. A runtime that refuses instantly is exactly
  // the case failover exists for, and a record written only on success would omit it.
  recordRuntimeAttempt(agentId, adapter.id);
  void adapter.start(spec).then((handle) => {
    if (handle.pid !== undefined) {
      withLedger((data) => {
        const agent = data.agents[agentId];
        if (agent) agent.pid = handle.pid;
      });
    }
    let watchdogReason: string | undefined;
    const heartbeat = createHeartbeat(agentId, input.fleetId, {
      intervalMs: 5_000,
      onHeartbeat: () => {},
      maxMissed: 12,
      isAlive: () => handle.isAlive(),
      onMaxMissed: (reason) => {
        watchdogReason = `Heartbeat watchdog: ${reason}`;
        void adapter.cancel(handle, watchdogReason);
      },
    });
    void adapter.wait(handle).then((result) => {
      heartbeat.stop();
      // Composed OUTSIDE the success branch on purpose: the success-carries-no-error guard
      // forbids the raw stderr token inside that region, and it is right to — raw transcripts
      // in Agent.error made real failures indistinguishable from normal runs. A hollow success
      // seals as FAILED, and its detail goes through buildFailureDetail, the same bounded
      // composer every other failure detail uses.
      const hollowFailureDetail = isHollowSuccess(result)
        ? buildFailureDetail(result.stderr, HOLLOW_SUCCESS_REASON)
        : undefined;
      // OBSERVE-ONLY THIS RELEASE. The status is read and recorded; it decides nothing. The next
      // release makes anything but `ok` bank `failed`. Reading it here — on the same result the
      // banking decision uses — is what makes the adoption figure honest before it is enforced.
      const resultContract = readResultContract(resultPath, { cwd: spec.cwd });
      if (result.status === "success") {
        // HOLLOW SUCCESS (2026-08-01): a runtime can exit 0 having produced no
        // output at all — the model burned its turn on tool calls and never
        // emitted a final answer. Exit code alone therefore does not mean the
        // work happened. Sealing that as `complete` is the exact overclaim
        // verify.ts already forbids: `complete` must never "claim work that
        // never happened". It is also invisible to every caller, because
        // `collect_results` returns an empty string that reads like a real
        // result, and an orchestrator accepts nothing while believing it got
        // something. `failed` is the honest seal — it is terminal (no
        // re-execution, so an agent that edited files cannot be double-run)
        // and every existing consumer already knows to reroute on it.
        if (hollowFailureDetail !== undefined) {
          markAgentFinished(
            agentId,
            "failed",
            result.stdout,
            hollowFailureDetail,
            result.identity.agent,
            result.identity.model,
            undefined,
            resultContract,
          );
          return;
        }
        markAgentFinished(
          agentId,
          "complete",
          result.stdout,
          // A SUCCESS has no error. This used to pass `result.stderr`, so a completed agent's
          // `error` held the child's entire stderr transcript — tool calls, their output,
          // duplicated warning lines and all. Measured on the live store: 753 of 763 `complete`
          // agents carried a populated `error`, averaging 4,352 bytes, 3.28 MB in total. A
          // consumer asking `agent.error` whether the work failed got a non-empty string for
          // 98.7% of successes, which makes a real failure indistinguishable from a normal run.
          //
          // The distilled signal was being DROPPED at the same moment. `classifySpawnResult`
          // already separates an auxiliary provider warning from the raw transcript, and
          // `opencode.ts` carries it in `diagnostics` — which this call ignored. The transcript
          // was kept and the diagnosis discarded: exactly backwards.
          undefined,
          result.identity.agent,
          result.identity.model,
          projectSuccessDiagnostics(result.diagnostics),
          resultContract,
        );
        return;
      }
      handleTransientFailure(
        input,
        agentId,
        attempt,
        result.stdout,
        result.stderr,
        watchdogReason ?? result.error ?? `Spawn failed with exit code ${result.exitCode}`,
        result.identity.agent,
        result.identity.model,
        resultContract,
      );
    });
  }).catch((error: unknown) => {
    handleTransientFailure(input, agentId, attempt, "", "", error instanceof Error ? error.message : String(error));
  });
}

/**
 * Append the runtime this attempt is using to the agent's durable row.
 *
 * This IS the hop record, and it is deliberately NOT a `Receipt`. A Receipt in this ledger is
 * `{message_id, agent_id, action, timestamp}` keyed `${message_id}:${agent_id}:${action}`, and
 * `verify_ledger` raises `receipt.orphan_message` for one that names no real message. Recording a
 * spawn hop as a receipt would mean inventing a message id — either orphaning the row, which the
 * audit is built to catch, or fabricating a message to hold it. Making the auditor quieter to fit
 * a new writer is the failure this product exists to prevent, so the hop goes where durable agent
 * facts already go. The same distinction the `fleet_reconciled` correction drew: an entry in the
 * ledger is not automatically a receipt.
 *
 * An ordered list, not a counter: `["opencode-cli","kimi-cli"]` states which runtime ran first,
 * which one it hopped to, and in what order — a count would say only that something happened.
 */
function recordRuntimeAttempt(agentId: string, runtimeId: string): void {
  withLedger((data) => {
    const agent = data.agents[agentId];
    if (!agent) return;
    const attempts = agent.runtime_attempts ?? [];
    // Idempotent on the id that is already last: a re-entry must not inflate the history into
    // evidence of a hop that never happened.
    if (attempts[attempts.length - 1] === runtimeId) return;
    agent.runtime_attempts = [...attempts, runtimeId];
  });
}

/**
 * The next runtime worth trying for this agent, or undefined to retry where it is.
 *
 * The gate is `validate()` and ONLY `validate()`. The tempting alternative is to read the failed
 * child's stderr and decide whether it "looks like" a quota refusal — but that is provider text,
 * unversioned and free to change, and the repo's standing scar is that three attempts to guess a
 * classification failed where probing worked. A candidate that cannot even accept the spec is
 * knowably useless; a candidate that can is worth an attempt whatever the previous error said.
 *
 * ⚠️ Order is the registry's sorted id order, which is ALPHABETICAL and therefore arbitrary. It
 * encodes no preference, health, cost or remaining quota, because MeshFleet observes none of those
 * — `recommend_route` exists for ranking and is advisory-only by design. With two runtimes this is
 * a distinction without a difference; it stops being one at three, and that is the point at which
 * ordering needs a real input rather than a better sort.
 */
function selectFailoverRuntime(
  input: SpawnAgentInput,
  agentId: string,
  currentRuntimeId: string,
  failureDetail: string,
): { adapter: RuntimeAdapter; input: SpawnAgentInput } | undefined {
  const attempted = [...(input.attemptedRuntimes ?? []), currentRuntimeId];
  const decision = decideFailover({
    // Runtimes that declare themselves ineligible (local-demo) are invisible to
    // automatic failover; they run only when a caller names them.
    available: availableRuntimeIds().filter(
      (id) => requireRuntimeAdapter(id).describe().failoverEligible !== false,
    ),
    attempted,
    failureDetail,
    requestedModel: input.requestedModel,
    // The spec is built for the CANDIDATE, because the spec depends on which adapter it is for: a
    // non-default runtime carries permission, session and environment requests the default path
    // does not. Validating the outgoing runtime's spec against the incoming one would answer the
    // wrong question.
    accepts: (id) => {
      const candidate = requireRuntimeAdapter(id);
      const next: SpawnAgentInput = { ...input, runtime: id, attemptedRuntimes: attempted };
      // A probe path, never a spawn path: `validate` inspects the spec's shape and starts
      // nothing, so no envelope is ever read from here. Naming it distinctly keeps a probe from
      // colliding with a real attempt's file if that ever stops being true.
      return candidate.validate(
        buildExecutionSpec(next, agentId, candidate, resultPathFor(agentId, "validate")),
      ).ok;
    },
  });
  if (!decision.hop) return undefined;
  return {
    adapter: requireRuntimeAdapter(decision.to),
    input: { ...input, runtime: decision.to, attemptedRuntimes: attempted },
  };
}

function handleTransientFailure(
  input: SpawnAgentInput,
  agentId: string,
  attempt: number,
  stdout: string,
  stderr: string,
  errorDetail: string,
  runtimeAgent?: string,
  runtimeModel?: string,
  // Undefined when no attempt ever ran (the spawn itself threw). Recording `absent` there would
  // blame an agent for a silence it had no chance to break.
  resultContract?: ResultContractStatus,
): void {
  const failureDetail = buildFailureDetail(stderr, errorDetail);
  if (!shouldAgentRetry(attempt)) {
    appendEvent("agent_failed_permanent", {
      agent_id: agentId,
      attempts: attempt,
      last_error: failureDetail,
      timestamp: Date.now(),
    });
    markAgentFinished(
      agentId,
      "failed",
      stdout,
      `Permanent failure after ${attempt} attempt(s). Last error: ${failureDetail}`,
      runtimeAgent,
      runtimeModel,
      undefined,
      resultContract,
    );
    return;
  }
  const nextAttempt = attempt + 1;
  const delayMs = computeBackoff(nextAttempt);
  // Which runtime just refused. `input.runtime` is absent on the default path, and the hop record
  // must name the runtime that actually ran, not the caller's silence about it.
  const currentRuntimeId = (input.runtime ? requireRuntimeAdapter(input.runtime) : runtimeAdapter).id;
  const failover = selectFailoverRuntime(input, agentId, currentRuntimeId, failureDetail);
  // Failing over rather than repeating: a retry on the runtime that just refused for quota will
  // refuse again, and the whole retry budget is spent proving it while other subscriptions sit
  // idle. Where no other runtime can take the spec, this is exactly the old behaviour — and with
  // only the default adapter registered, which is every deployment that configures nothing, the
  // candidate list is empty and nothing changes at all.
  const nextInput = failover?.input ?? input;
  if (failover) {
    appendEvent("agent_runtime_failover", {
      agent_id: agentId,
      fleet_id: input.fleetId,
      from_runtime: currentRuntimeId,
      to_runtime: failover.adapter.id,
      from_attempt: attempt,
      to_attempt: nextAttempt,
      last_error: failureDetail,
      timestamp: Date.now(),
    });
  }
  appendEvent("agent_retry_scheduled", {
    agent_id: agentId,
    from_attempt: attempt,
    to_attempt: nextAttempt,
    delay_ms: delayMs,
    last_error: failureDetail,
    timestamp: Date.now(),
  });
  scheduleAgentRetry(nextAttempt, () => {
    trySpawn(nextInput, agentId, nextAttempt);
  });
  void stdout;
}

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "spawn_fleet",
      description:
        "Spawn parallel agents. Returns fleet_id. Each agent can optionally specify an 'agent' field to use a premade agent definition from .opencode/agents/.",
      inputSchema: {
        type: "object",
        properties: {
          agents: {
            type: "array",
            items: {
              type: "object",
              properties: {
                role: { type: "string" },
                prompt: { type: "string" },
                agent: {
                  type: "string",
                  description:
                    "Premade agent filename stem (e.g. 'frontend-developer'). See list_agents.",
                },
                model: {
                  type: "string",
                  description:
                    "Optional OpenCode model selector as provider/model (e.g. 'opencode-go/minimax-m3').",
                },
                runtime: {
                  type: "string",
                  description:
                    "Runtime adapter to spawn this agent under. Omit for the default. `model` " +
                    "picks a model WITHIN a runtime; `runtime` picks the harness itself, so agents " +
                    "in one fleet can run under different CLIs and one provider outage cannot stop " +
                    "every agent at once. Not supported in durable lifecycle mode.",
                },
                workspace_binding: {
                  type: "string",
                  description:
                    "Opaque identifier for a workspace the caller asserts is verified isolation. " +
                    "Never a path. Some runtimes refuse to edit files without one, and the claim " +
                    "grants nothing on its own — the runtime independently admits the identifier " +
                    "from operator configuration. Ignored when 'runtime' is omitted.",
                },
              },
              required: ["role", "prompt"],
            },
          },
        },
        required: ["agents"],
      },
    },
    {
      name: "fleet_status",
      description: "Check fleet and agent status.",
      inputSchema: {
        type: "object",
        properties: { fleet_id: { type: "string" } },
        required: ["fleet_id"],
      },
    },
    {
      name: "list_fleets",
      description: "List all fleets with summaries (agent count, status, completion).",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "set_fleet_timeout",
      description:
        "Set a per-fleet timeout override (in milliseconds). Agents exceeding this are auto-failed.",
      inputSchema: {
        type: "object",
        properties: {
          fleet_id: { type: "string" },
          timeout_ms: { type: "number" },
        },
        required: ["fleet_id", "timeout_ms"],
      },
    },
    {
      name: "collect_results",
      description:
        "Get all agent outputs from a fleet, with an explicit loss tally. Returns total/delivered/lost/still_running, a named lost_agents list, and a `warning` string present ONLY when agents died without reporting. Check `lost` before treating the collection as the finished work: an agent killed by a crash produces no output and its silence looks identical to 'not finished yet'. Each result also carries `result_contract` — what the agent declared about its own outcome ('ok' | 'refused' | 'blocked' | 'artifact_missing' | 'invalid' | 'absent'), absent on runs that predate the contract. This release records it without acting on it, so treat `status: 'complete'` as delivered work only when `result_contract` is 'ok'; a later release will refuse to bank complete on anything else. It is a DECLARED outcome, not a truth check.",
      inputSchema: {
        type: "object",
        properties: { fleet_id: { type: "string" } },
        required: ["fleet_id"],
      },
    },
    {
      name: "send_message",
      description:
        'Send a P2P message from one agent to another within the same fleet. Set to_agent_id to "*" to broadcast to every other agent in the fleet (each recipient acks independently; see get_receipts).',
      inputSchema: {
        type: "object",
        properties: {
          from_agent_id: { type: "string", minLength: 1, pattern: "\\S" },
          to_agent_id: { type: "string", minLength: 1, pattern: "\\S", description: 'Recipient agent id, or "*" for fleet broadcast' },
          fleet_id: { type: "string", minLength: 1, pattern: "\\S" },
          type: { type: "string", enum: [...MESSAGE_TYPES] },
          payload: { type: "string" },
          correlation_id: { type: "string", minLength: 1, pattern: "\\S" },
        },
        required: ["from_agent_id", "to_agent_id", "fleet_id", "type", "payload"],
      },
    },
    {
      name: "send_messages",
      description:
        "Send a batch of P2P messages in ONE ledger transaction — use instead of repeated send_message calls for bulk fan-out (much faster: the recipient inbox is updated once per batch, not once per message). Atomic: one invalid message rejects the whole batch. Max 1000 messages per call.",
      inputSchema: {
        type: "object",
        properties: {
          messages: {
            type: "array",
            maxItems: MAX_BATCH_MESSAGES,
            items: {
              type: "object",
              properties: {
                from_agent_id: { type: "string", minLength: 1, pattern: "\\S" },
                to_agent_id: { type: "string", minLength: 1, pattern: "\\S", description: 'Recipient agent id, or "*" for fleet broadcast' },
                fleet_id: { type: "string", minLength: 1, pattern: "\\S" },
                type: { type: "string", enum: [...MESSAGE_TYPES] },
                payload: { type: "string" },
                correlation_id: { type: "string", minLength: 1, pattern: "\\S" },
              },
              required: ["from_agent_id", "to_agent_id", "fleet_id", "type", "payload"],
            },
          },
        },
        required: ["messages"],
      },
    },
    {
      name: "get_inbox",
      description:
        "Get messages in an agent's inbox, optionally since a timestamp.",
      inputSchema: {
        type: "object",
        properties: {
          agent_id: { type: "string" },
          since: { type: "number", description: "Epoch ms timestamp" },
        },
        required: ["agent_id"],
      },
    },
    {
      name: "ack_message",
      description:
        "Acknowledge a message, removing it from the agent's inbox. Writes an 'ack' receipt (per-recipient — a broadcast is acked independently by each recipient).",
      inputSchema: {
        type: "object",
        properties: {
          agent_id: { type: "string" },
          message_id: { type: "string" },
        },
        required: ["agent_id", "message_id"],
      },
    },
    {
      name: "receipt",
      description:
        "Write a non-consuming receipt on a message — the audit primitive. Use actions like 'seen', 'r-ack' (approve), 'retracted'. Unlike ack_message, the message stays in the inbox. One receipt per (message, agent, action); repeat calls are idempotent.",
      inputSchema: {
        type: "object",
        properties: {
          agent_id: { type: "string" },
          message_id: { type: "string" },
          action: { type: "string", description: "e.g. 'seen', 'r-ack', 'retracted' — any label except 'ack' (use ack_message to consume)" },
          note: { type: "string" },
        },
        required: ["agent_id", "message_id", "action"],
      },
    },
    {
      name: "get_receipts",
      description:
        "Get the full receipt trail for a message: who acked, who annotated, when. Answers 'who saw this and who acted on it'.",
      inputSchema: {
        type: "object",
        properties: {
          message_id: { type: "string" },
        },
        required: ["message_id"],
      },
    },
    {
      name: "verify_ledger",
      description:
        "Audit the ledger's internal consistency: every receipt points at a real message and honors the idempotency key, acknowledged flags are supported by ack receipts, inboxes hold no consumed or dangling messages, and ratification tallies (quorum, signoffs, vote polarity, terminal status) recompute from the receipts. Read-only. Returns ok, error/warning counts, per-finding detail, and a `scope` object stating the guarantee boundary — errors mean the ledger asserts something its own records do not support. SCOPE: ok=true means CONSISTENT, not AUTHENTIC. There is no hash chain or signature in this verifier, so an edit that rewrites the ledger consistently is indistinguishable from honest history. Do not report a passing verification as proof the ledger was not tampered with.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "verify_ledger_v2",
      description:
        "Versioned verifier output read from a dedicated read-only file snapshot; the handler performs no ledger writes. Normal parent-server startup recovery or migration may initialize or change the configured ledger before tool dispatch. Returns the unchanged internal-consistency report inside meshfleet.verify/v2 with an unsigned-snapshot evidence scope; it does not establish authorship, snapshot integrity, content binding, completeness, external delivery or execution, or external time.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "verify_ledger_v3",
      description:
        "Opt-in verifier output read from a dedicated read-only file snapshot; the handler performs no ledger writes. Returns a detached meshfleet.verify/v3 report with one local consistency band per finding, derived only from its severity. Those labels are not provenance or confidence and do not establish authenticity, completeness, tamper evidence, authorship, snapshot integrity, content binding, external delivery or execution, or external time.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "open_ratification",
      description:
        "Open a quorum vote ('council') over the fleet. Broadcasts a proposal; peers vote with cast_vote. Ratifies when approvals reach the quorum and every required signoff approves. Returns the proposal message_id.",
      inputSchema: {
        type: "object",
        properties: {
          proposer: { type: "string" },
          fleet_id: { type: "string" },
          subject: { type: "string" },
          payload: { type: "string", description: "Full proposal text (defaults to subject)" },
          quorum: { type: "number", description: "Approvals required to ratify" },
          voters: { type: "array", items: { type: "string" }, description: "Eligible voters; defaults to every other agent in the fleet" },
          required_signoffs: { type: "array", items: { type: "string" }, description: "Agents whose approval is mandatory regardless of quorum (e.g. a T5 authority)" },
          deadline: { type: "number", description: "Epoch ms; after it, silence_policy applies" },
          silence_policy: { type: "string", enum: ["abstain", "approve"], description: "How non-voters count once the deadline passes (default abstain)" },
          weights: {
            type: "object",
            additionalProperties: { type: "number" },
            description:
              "Tiered councils: per-voter positive-integer weights (max 1000000). Unlisted voters weigh 1, so quorum becomes a weight threshold. Weight never satisfies a required signoff.",
          },
        },
        required: ["proposer", "fleet_id", "subject", "quorum"],
      },
    },
    {
      name: "cast_vote",
      description:
        "Cast a vote on an open ratification. approve=true records approval, approve=false rejection. Re-casting CHANGES your effective vote (each change appends a new sequenced receipt — history is never rewritten); repeating your current vote is a no-op.",
      inputSchema: {
        type: "object",
        properties: {
          agent_id: { type: "string" },
          message_id: { type: "string" },
          approve: { type: "boolean" },
          note: { type: "string" },
        },
        required: ["agent_id", "message_id", "approve"],
      },
    },
    {
      name: "tally_ratification",
      description:
        "Read the live vote tally and current status (open / ratified / rejected / expired) of a ratification, and persist the status if it has reached a terminal state.",
      inputSchema: {
        type: "object",
        properties: {
          message_id: { type: "string" },
        },
        required: ["message_id"],
      },
    },
    {
      name: "sweep_ratifications",
      description:
        "Evaluate every open ratification now and persist any that reached a terminal state (deadline expiry, silent-approval, unreachable quorum). The server also sweeps automatically every AGENT_MESH_RATIFY_SWEEP_MS (default 60s).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "register_capability",
      description:
        "Register an agent's capabilities (role, skills, model) for routing.",
      inputSchema: {
        type: "object",
        properties: {
          // minLength mirrors the write-path validation: the schema is the
          // published contract, and a schema that accepts what the server
          // rejects sends clients a false promise.
          agent_id: { type: "string", minLength: 1 },
          fleet_id: { type: "string", minLength: 1 },
          role: { type: "string", minLength: 1 },
          skills: { type: "array", items: { type: "string" } },
          model: { type: "string" },
          context_window: { type: "number" },
        },
        required: ["agent_id", "fleet_id", "role", "skills"],
      },
    },
    {
      name: "route_work",
      description:
        "Route a work description to the best-matching registered agents by keyword + role/skill overlap scoring (with synonym expansion), weighted by routing feedback (success/fail history). top_n controls how many matches to return (default 1, max = fleet size).",
      inputSchema: {
        type: "object",
        properties: {
          description: { type: "string" },
          top_n: {
            type: "number",
            description: "Maximum number of matches to return (default 1).",
            default: 1,
            minimum: 1,
          },
        },
        required: ["description"],
      },
    },
    {
      name: "compile_route_candidates",
      description:
        "Offline projection of caller-supplied route-candidate snapshots. Does not persist, rank, execute, authorize, wake, or contact providers.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          manifest: {
            type: "object",
            additionalProperties: false,
            properties: {
              version: {
                type: "string",
                enum: ["meshfleet.route-candidates.v0.1"],
              },
              candidates: {
                type: "array",
                minItems: 1,
                maxItems: 256,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    candidate_id: { type: "string", minLength: 1, maxLength: 128 },
                    capabilities: {
                      type: "array",
                      minItems: 1,
                      maxItems: 64,
                      uniqueItems: true,
                      items: {
                        type: "string",
                        minLength: 1,
                        maxLength: 64,
                        pattern: "^[a-z0-9][a-z0-9._:-]*$",
                      },
                    },
                    privacy: {
                      type: "string",
                      enum: ["local_only", "network_ok", "unrestricted"],
                    },
                    locality: {
                      type: "string",
                      enum: ["same_host", "same_fleet", "any"],
                    },
                    coordination_modes: {
                      type: "array",
                      minItems: 1,
                      maxItems: 2,
                      uniqueItems: true,
                      items: {
                        type: "string",
                        enum: ["solo", "pair_discussion"],
                      },
                    },
                    policy_tags: {
                      type: "array",
                      minItems: 0,
                      maxItems: 64,
                      uniqueItems: true,
                      items: {
                        type: "string",
                        minLength: 1,
                        maxLength: 64,
                        pattern: "^[a-z0-9][a-z0-9._:-]*$",
                      },
                    },
                    context_window: { type: "integer", minimum: 0 },
                    requested_identity: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        runtime: { type: "string", minLength: 1, maxLength: 256 },
                        model: { type: "string", minLength: 1, maxLength: 256 },
                      },
                      anyOf: [{ required: ["runtime"] }, { required: ["model"] }],
                    },
                  },
                  required: ["candidate_id", "capabilities", "privacy", "locality"],
                },
              },
            },
            required: ["version", "candidates"],
          },
          observations: {
            type: "array",
            minItems: 0,
            maxItems: 256,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                candidate_id: { type: "string", minLength: 1, maxLength: 128 },
                status: {
                  type: "string",
                  // "unconfigured" exists as a module-level status token but is
                  // never accepted for a manifest candidate, so the published
                  // contract does not advertise it.
                  enum: ["green", "degraded", "exhausted"],
                },
                confidence: { type: "string", enum: ["measured", "assumed"] },
                budget: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    used: { type: "number", minimum: 0 },
                    total: { type: "number", exclusiveMinimum: 0 },
                    window: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        starts_at_ms: {
                          type: "integer",
                          minimum: Number.MIN_SAFE_INTEGER,
                          maximum: Number.MAX_SAFE_INTEGER,
                        },
                        ends_at_ms: {
                          type: "integer",
                          minimum: Number.MIN_SAFE_INTEGER,
                          maximum: Number.MAX_SAFE_INTEGER,
                        },
                      },
                      required: ["starts_at_ms", "ends_at_ms"],
                    },
                  },
                  required: ["used", "total"],
                },
                observed_outcomes: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    successes: { type: "integer", minimum: 0, maximum: 1_000_000 },
                    failures: { type: "integer", minimum: 0, maximum: 1_000_000 },
                  },
                  required: ["successes", "failures"],
                },
                observed_identity: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    runtime: { type: "string", minLength: 1, maxLength: 256 },
                    model: { type: "string", minLength: 1, maxLength: 256 },
                    source: { type: "string", minLength: 1, maxLength: 256 },
                  },
                  required: ["source"],
                  anyOf: [{ required: ["runtime"] }, { required: ["model"] }],
                },
              },
              required: ["candidate_id", "status", "confidence"],
            },
          },
        },
        required: ["manifest"],
      },
    },
    {
      name: "recommend_route",
      description:
        "Advisory-only ranking over caller-supplied sanitized task traits and candidate snapshots. Does not persist, execute, authorize, wake agents, or contact providers.",
      inputSchema: {
        type: "object",
        properties: {
          task: {
            type: "object",
            additionalProperties: false,
            properties: {
              required_capabilities: {
                type: "array",
                minItems: 1,
                maxItems: 64,
                uniqueItems: true,
                items: {
                  type: "string",
                  minLength: 1,
                  maxLength: 64,
                  pattern: "^[a-z0-9][a-z0-9._:-]*$",
                },
              },
              optional_capabilities: {
                type: "array",
                maxItems: 64,
                uniqueItems: true,
                description:
                  "Desirable capability tokens. Must not repeat any required_capabilities token.",
                items: {
                  type: "string",
                  minLength: 1,
                  maxLength: 64,
                  pattern: "^[a-z0-9][a-z0-9._:-]*$",
                },
              },
              privacy: {
                type: "string",
                enum: ["local_only", "network_ok", "unrestricted"],
              },
              locality: {
                type: "string",
                enum: ["same_host", "same_fleet", "any"],
              },
              coordination: {
                type: "string",
                enum: ["solo", "pair_discussion"],
              },
              policy_tags: {
                type: "array",
                maxItems: 64,
                uniqueItems: true,
                items: {
                  type: "string",
                  minLength: 1,
                  maxLength: 64,
                  pattern: "^[a-z0-9][a-z0-9._:-]*$",
                },
              },
              min_context_tokens: { type: "integer", minimum: 0 },
            },
            required: ["required_capabilities", "privacy", "locality"],
          },
          candidates: {
            type: "array",
            minItems: 1,
            maxItems: 256,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                candidate_id: {
                  type: "string",
                  minLength: 1,
                  maxLength: 128,
                  description:
                    "Opaque non-whitespace identifier; must be unique within candidates.",
                },
                capabilities: {
                  type: "array",
                  minItems: 1,
                  maxItems: 64,
                  uniqueItems: true,
                  items: {
                    type: "string",
                    minLength: 1,
                    maxLength: 64,
                    pattern: "^[a-z0-9][a-z0-9._:-]*$",
                  },
                },
                privacy: {
                  type: "string",
                  enum: ["local_only", "network_ok", "unrestricted"],
                },
                locality: {
                  type: "string",
                  enum: ["same_host", "same_fleet", "any"],
                },
                coordination_modes: {
                  type: "array",
                  minItems: 1,
                  maxItems: 2,
                  uniqueItems: true,
                  items: {
                    type: "string",
                    enum: ["solo", "pair_discussion"],
                  },
                },
                policy_tags: {
                  type: "array",
                  maxItems: 64,
                  uniqueItems: true,
                  items: {
                    type: "string",
                    minLength: 1,
                    maxLength: 64,
                    pattern: "^[a-z0-9][a-z0-9._:-]*$",
                  },
                },
                context_window: { type: "integer", minimum: 0 },
                observed_outcomes: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    successes: {
                      type: "integer",
                      minimum: 0,
                      maximum: 1_000_000,
                    },
                    failures: {
                      type: "integer",
                      minimum: 0,
                      maximum: 1_000_000,
                    },
                  },
                  required: ["successes", "failures"],
                },
                budget: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    measured: { type: "boolean" },
                    used: { type: "number", minimum: 0 },
                    total: { type: "number", exclusiveMinimum: 0 },
                    window: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        starts_at_ms: {
                          type: "integer",
                          minimum: Number.MIN_SAFE_INTEGER,
                          maximum: Number.MAX_SAFE_INTEGER,
                        },
                        ends_at_ms: {
                          type: "integer",
                          minimum: Number.MIN_SAFE_INTEGER,
                          maximum: Number.MAX_SAFE_INTEGER,
                        },
                      },
                      required: ["starts_at_ms", "ends_at_ms"],
                    },
                  },
                  required: ["measured"],
                  allOf: [
                    {
                      if: {
                        properties: { measured: { const: true } },
                        required: ["measured"],
                      },
                      then: { required: ["used", "total"] },
                    },
                    {
                      if: {
                        properties: { measured: { const: false } },
                        required: ["measured"],
                      },
                      then: {
                        not: {
                          anyOf: [
                            { required: ["used"] },
                            { required: ["total"] },
                            { required: ["window"] },
                          ],
                        },
                      },
                    },
                  ],
                },
                requested_identity: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    runtime: { type: "string", minLength: 1, maxLength: 256 },
                    model: { type: "string", minLength: 1, maxLength: 256 },
                  },
                  anyOf: [{ required: ["runtime"] }, { required: ["model"] }],
                },
                observed_identity: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    runtime: { type: "string", minLength: 1, maxLength: 256 },
                    model: { type: "string", minLength: 1, maxLength: 256 },
                    source: { type: "string", minLength: 1, maxLength: 256 },
                  },
                  required: ["source"],
                  anyOf: [{ required: ["runtime"] }, { required: ["model"] }],
                },
              },
              required: ["candidate_id", "capabilities", "privacy", "locality"],
            },
          },
          preference: {
            type: "object",
            additionalProperties: false,
            properties: {
              objective: {
                type: "string",
                // prefer_near_reset: post-score tie-break on measured window urgency.
                // exhaust_before_reset: the same measured, current-window urgency as the
                // PRIMARY key — spend the fullest pool before its rotation discards the
                // remainder. Both are advisory projections over caller-supplied evidence;
                // unmeasured candidates are never promoted or demoted by either.
                enum: ["prefer_near_reset", "exhaust_before_reset"],
              },
              now_ms: {
                type: "integer",
                minimum: Number.MIN_SAFE_INTEGER,
                maximum: Number.MAX_SAFE_INTEGER,
              },
            },
            required: ["objective", "now_ms"],
            description:
              "Opt-in advisory tie-break preference. Never changes hard gates, budget adjustment, or final_score.",
          },
          top_n: {
            type: "integer",
            minimum: 1,
            maximum: 256,
            description: "Must not exceed candidates.length.",
          },
        },
        required: ["task", "candidates"],
        additionalProperties: false,
      },
    },
    {
      name: "plan_speculative_backlog",
      description:
        "Pure, caller-approved speculative backlog projection. Does not persist, execute, authorize, wake agents, contact providers, poll, allocate capacity, schedule, spend, send, or publish.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          version: { type: "string", const: "meshfleet.speculative-backlog.v0.1" },
          candidate_limit: { type: "integer", minimum: 1, maximum: 8, default: 3 },
          preference: {
            type: "object", additionalProperties: false,
            properties: {
              objective: { type: "string", const: "prefer_near_reset" },
              now_ms: { type: "integer", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
            },
            required: ["objective", "now_ms"],
          },
          candidates: {
            type: "array", minItems: 1, maxItems: 256,
            items: {
              type: "object", additionalProperties: false,
              properties: {
                candidate_id: { type: "string", minLength: 1, maxLength: 128 },
                capabilities: { type: "array", minItems: 1, maxItems: 64, uniqueItems: true, items: { type: "string", pattern: "^[a-z0-9][a-z0-9._:-]*$" } },
                privacy: { type: "string", enum: ["local_only", "network_ok", "unrestricted"] },
                locality: { type: "string", enum: ["same_host", "same_fleet", "any"] },
                coordination_modes: { type: "array", minItems: 1, maxItems: 2, uniqueItems: true, items: { type: "string", enum: ["solo", "pair_discussion"] } },
                policy_tags: { type: "array", maxItems: 64, uniqueItems: true, items: { type: "string", pattern: "^[a-z0-9][a-z0-9._:-]*$" } },
                context_window: { type: "integer", minimum: 0 },
                observed_outcomes: { type: "object", additionalProperties: false, properties: { successes: { type: "integer", minimum: 0, maximum: 1_000_000 }, failures: { type: "integer", minimum: 0, maximum: 1_000_000 } }, required: ["successes", "failures"] },
                budget: { type: "object", additionalProperties: false, properties: { measured: { type: "boolean" }, used: { type: "number", minimum: 0 }, total: { type: "number", exclusiveMinimum: 0 }, window: { type: "object", additionalProperties: false, properties: { starts_at_ms: { type: "integer", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }, ends_at_ms: { type: "integer", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER } }, required: ["starts_at_ms", "ends_at_ms"] } }, required: ["measured"] },
                requested_identity: { type: "object", additionalProperties: false, properties: { runtime: { type: "string", minLength: 1, maxLength: 256 }, model: { type: "string", minLength: 1, maxLength: 256 } }, anyOf: [{ required: ["runtime"] }, { required: ["model"] }] },
                observed_identity: { type: "object", additionalProperties: false, properties: { runtime: { type: "string", minLength: 1, maxLength: 256 }, model: { type: "string", minLength: 1, maxLength: 256 }, source: { type: "string", minLength: 1, maxLength: 256 } }, required: ["source"], anyOf: [{ required: ["runtime"] }, { required: ["model"] }] },
                quality_tags: { type: "array", maxItems: 32, uniqueItems: true, items: { type: "string", pattern: "^[a-z0-9][a-z0-9._:-]*$" } },
              },
              required: ["candidate_id", "capabilities", "privacy", "locality", "quality_tags"],
            },
          },
          tasks: {
            type: "array", minItems: 1, maxItems: 64,
            items: {
              type: "object", additionalProperties: false,
              properties: {
                task_id: { type: "string", minLength: 1, maxLength: 128 },
                kind: { type: "string", enum: ["benchmark", "reusable_asset", "code_review", "test_generation", "video_candidate"] },
                priority: { type: "integer", minimum: 0, maximum: 100 },
                speculative_approval: {
                  oneOf: [
                    { type: "object", additionalProperties: false, properties: { state: { type: "string", const: "approved" }, approval_ref: { type: "string", minLength: 1, maxLength: 128, pattern: "^[a-z0-9][a-z0-9._:-]*$" } }, required: ["state", "approval_ref"] },
                    { type: "object", additionalProperties: false, properties: { state: { type: "string", const: "not_approved" } }, required: ["state"] },
                  ],
                },
                route: {
                  type: "object", additionalProperties: false,
                  properties: {
                    required_capabilities: { type: "array", minItems: 1, maxItems: 64, uniqueItems: true, items: { type: "string", pattern: "^[a-z0-9][a-z0-9._:-]*$" } },
                    optional_capabilities: { type: "array", maxItems: 64, uniqueItems: true, items: { type: "string", pattern: "^[a-z0-9][a-z0-9._:-]*$" } },
                    privacy: { type: "string", enum: ["local_only", "network_ok", "unrestricted"] },
                    locality: { type: "string", enum: ["same_host", "same_fleet", "any"] },
                    coordination: { type: "string", enum: ["solo", "pair_discussion"] },
                    policy_tags: { type: "array", maxItems: 64, uniqueItems: true, items: { type: "string", pattern: "^[a-z0-9][a-z0-9._:-]*$" } },
                    min_context_tokens: { type: "integer", minimum: 0 },
                  }, required: ["required_capabilities", "privacy", "locality"],
                },
                required_quality_tags: { type: "array", maxItems: 32, uniqueItems: true, items: { type: "string", pattern: "^[a-z0-9][a-z0-9._:-]*$" } },
                artifact: { type: "object", additionalProperties: false, properties: { source_material: { type: "string", enum: ["text_only", "caller_attested_rights"] }, review_scope: { type: "string", const: "private_review_only" }, human_release_required: { type: "boolean", const: true } }, required: ["source_material", "review_scope", "human_release_required"] },
              },
              required: ["task_id", "kind", "priority", "speculative_approval", "route", "required_quality_tags"],
            },
          },
        },
        required: ["version", "candidates", "tasks"],
      },
    },
    {
      name: "record_routing_outcome",
      description:
        "Record whether a routed task succeeded or failed. Future route_work calls for the same agent weight their score by accumulated outcomes (Wilson-style). NOTE: outcomes are currently accumulated PER AGENT, not per capability — capability_key is recorded for forward compatibility but does not yet scope the penalty, so a failure at one capability lowers the agent's score for all of them. Feedback is in-process and resets when the server restarts.",
      inputSchema: {
        type: "object",
        properties: {
          agent_id: { type: "string" },
          capability_key: { type: "string" },
          success: { type: "boolean" },
        },
        required: ["agent_id", "capability_key", "success"],
      },
    },
    {
      name: "list_agents",
      description:
        "List all available premade agents from .opencode/agents/ directories.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "attach_agent",
      description:
        "Dynamically attach a premade agent to an existing running fleet.",
      inputSchema: {
        type: "object",
        properties: {
          fleet_id: { type: "string" },
          role: { type: "string" },
          prompt: { type: "string" },
          agent: {
            type: "string",
            description: "Premade agent filename stem (e.g. 'frontend-developer').",
          },
          model: {
            type: "string",
            description:
              "Optional OpenCode model selector as provider/model (e.g. 'opencode-go/minimax-m3').",
          },
        },
        required: ["fleet_id", "role", "prompt"],
      },
    },
    {
      name: "ping",
      description: "Minimal liveness check. Returns { status: 'ok', timestamp }.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "subscribe_inbox",
      description:
        "Subscribe to an agent's inbox via Server-Sent Events (SSE). Returns a stream URL that the agent opens to receive real-time push of incoming P2P messages. Falls back to polling get_inbox if SSE is unreachable. If the operator set MESHFLEET_AUTH_TOKEN, requests to the stream must carry it (Authorization: Bearer, or ?token=).",
      inputSchema: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            description: "The agent whose inbox to subscribe to.",
          },
        },
        required: ["agent_id"],
      },
    },
    {
      name: "get_health",
      description:
        "Health report: ledger size, fleet/agent/message counts, uptime, last event. Use for monitoring and alerting.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "save_fleet_template",
      description:
        "Save a named fleet template (set of agent specs) for reuse. Names: lowercase letters, numbers, dashes, underscores.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          agents: {
            type: "array",
            items: {
              type: "object",
              properties: {
                role: { type: "string" },
                prompt: { type: "string" },
                agent: { type: "string" },
              },
              required: ["role", "prompt"],
            },
          },
        },
        required: ["name", "agents"],
      },
    },
    {
      name: "list_fleet_templates",
      description: "List all saved fleet templates, sorted by name.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "spawn_from_template",
      description:
        "Return a fleet spec from a saved template, ready to pass to spawn_fleet.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
    {
      name: "ask_peer",
      description:
        "Open a bounded, two-agent Discussion: sends the root question and (optionally) explicitly reserves one peer attempt, then waits until the conversation deadline for a settled answer. Message arrival never starts an agent by itself — wake_peer:true is the explicit, budgeted authority to run the peer once.",
      inputSchema: {
        type: "object",
        properties: {
          from_agent_id: { type: "string", description: "The initiating agent's ID." },
          to_agent_id: { type: "string", description: "The target peer agent's ID." },
          fleet_id: { type: "string", description: "The fleet both agents belong to." },
          payload: { type: "string", description: "The UTF-8 string payload for the root question." },
          max_turns: {
            type: "integer",
            minimum: 2,
            maximum: 32,
            description: "Total allowed turns, including the root. Must be 2..32.",
          },
          timeout_ms: {
            type: "integer",
            minimum: 1000,
            maximum: 900000,
            description: "Conversation duration in milliseconds. Must be 1s..15m.",
          },
          turn_timeout_ms: {
            type: "integer",
            minimum: 1000,
            maximum: 300000,
            description: "Per-turn deadline duration. Must be 1s..5m and <= timeout_ms.",
          },
          wake_peer: { type: "boolean", description: "If true, explicitly reserves exactly one peer attempt." },
        },
        required: [
          "from_agent_id",
          "to_agent_id",
          "fleet_id",
          "payload",
          "max_turns",
          "timeout_ms",
          "turn_timeout_ms",
          "wake_peer",
        ],
        additionalProperties: false,
      },
    },
    {
      name: "wake_agent",
      description:
        "The sole general-purpose Discussion run trigger. Atomically reserves one bounded attempt for a resident participant who is the current recipient of the canonical head, then launches it. Never waits for the reply. Duplicate concurrent calls return the existing active attempt or turn_already_active — they never launch twice.",
      inputSchema: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "The resident agent to wake." },
          discussion_id: { type: "string", description: "The discussion to resume." },
          expected_head_message_id: {
            type: "string",
            description: "The expected current canonical head for compare-and-swap.",
          },
        },
        required: ["agent_id", "discussion_id", "expected_head_message_id"],
        additionalProperties: false,
      },
    },
    {
      name: "reply_discussion",
      description:
        "Submit the one reply an active wake attempt is authorized to produce. Never launches an agent. Rejects a second reply for the same attempt, a stale head, or a reply past the conversation/attempt deadline. close:true makes the conversation terminal; exhausting the last turn without close returns exhausted.",
      inputSchema: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "The agent authoring the reply." },
          discussion_id: { type: "string", description: "The discussion being replied to." },
          attempt_id: { type: "string", description: "The server-assigned attempt ID this reply satisfies." },
          reply_to_message_id: { type: "string", description: "The canonical head being replied to." },
          type: { type: "string", enum: ["question", "result"], description: "Message type for the reply." },
          payload: { type: "string", description: "The UTF-8 string payload for the reply." },
          close: {
            type: "boolean",
            description: "If true, explicitly closes the discussion. Defaults to false.",
          },
        },
        required: ["agent_id", "discussion_id", "attempt_id", "reply_to_message_id", "type", "payload"],
        additionalProperties: false,
      },
    },
    {
      name: "get_discussion",
      description:
        "Read-only: derive and return a Discussion's full state — transcript, attempts, budget, and fail-closed status (invalid > closed > deadman > expired > exhausted > active > open) — from durable messages and receipts. Remains useful after every inbox entry has been acknowledged.",
      inputSchema: {
        type: "object",
        properties: {
          discussion_id: { type: "string", description: "The discussion ID to retrieve." },
          include_receipts: {
            type: "boolean",
            description: "Whether to include lifecycle receipts in transcript presentation. Defaults to true.",
          },
        },
        required: ["discussion_id"],
        additionalProperties: false,
      },
    },
  ].filter((tool) => toolAllowedByAccessProfile(tool.name)),
}));

// ---------------------------------------------------------------------------
// Tool Handlers
// ---------------------------------------------------------------------------

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

function jsonError(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

// D3 errata item 4, option (a): the four Discussion tools implement the
// blueprint's extended error contract (`{error, detail_fields}` + isError)
// locally rather than widening the shared `jsonError` above — the existing
// 27 tools' `{ error: string }` shape is a load-bearing contract for callers
// already depending on it, and errata item 4 explicitly frames (a) vs (b) as
// an open choice rather than mandating a global change. `DiscussionError`'s
// `.detail` fields are already snake_case at the throw site (see
// discussion-store.ts), so this only needs to project `.code`/`.detail`.
function jsonDiscussionError(code: string, detailFields: Record<string, unknown> = {}) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ error: code, detail_fields: detailFields }) },
    ],
    isError: true,
  };
}

const toolHandlers: Record<
  string,
  (args: any) => Promise<CallToolResult> | CallToolResult
> = {};

toolHandlers["spawn_fleet"] = async (args) => {
    const { agents } = args as {
      agents: {
        role: string; prompt: string; agent?: string; model?: string;
        runtime?: string; workspace_binding?: string;
      }[];
    };
    // The published schema declares agents[] items with REQUIRED string role and
    // prompt, and the MCP SDK enforces neither `required` nor `type`. Without this
    // the blind cast above let `{"agents":[{"role":"reviewer"}]}` return a normal
    // success, commit a fleet plus an agent row whose prompt is NULL, and call
    // trySpawn — a ledger write and a process start off a request that violates the
    // contract we publish. Same defect family as register_capability, cast_vote and
    // the Discussions tools; this is the highest-blast-radius member of it, so the
    // refusal must precede the transaction and the spawn, not merely report after.
    if (!Array.isArray(agents)) {
      return jsonError("spawn_fleet: 'agents' is required and must be an array");
    }
    // Refuse an unknown runtime BEFORE the transaction and the spawn. Resolving it lazily inside
    // trySpawn would throw AFTER the fleet row was committed, leaving a ledger that records a
    // fleet whose agents never start.
    const knownRuntimes = availableRuntimeIds();
    const badRuntimeAgent = agents.find(
      (a) => a?.runtime !== undefined && !knownRuntimes.includes(a.runtime),
    );
    if (badRuntimeAgent) {
      return jsonError(
        `spawn_fleet: unknown runtime '${badRuntimeAgent.runtime}'. Available: ` +
          `${knownRuntimes.join(", ")}. A runtime is available only once registered, and some ` +
          `require configuration.`,
      );
    }
    const badAgent = firstError(
      ...agents.flatMap((a, i) => [
        requireString("spawn_fleet", `agents[${i}].role`, a?.role),
        requireString("spawn_fleet", `agents[${i}].prompt`, a?.prompt),
        a?.agent === undefined
          ? null
          : requireString("spawn_fleet", `agents[${i}].agent`, a.agent),
        optionalModelSelector("spawn_fleet", `agents[${i}].model`, a?.model),
      ]),
    );
    if (badAgent) return jsonError(badAgent);
    const fleetId = randomUUID();
    const specs = agents.map((a) => ({
      agentId: randomUUID(),
      role: a.role,
      prompt: a.prompt,
      agent: a.agent,
      model: a.model,
      // Carrying `runtime` here is the whole point of the field. It was validated above and then
      // dropped: nothing copied it into these specs and nothing passed it to trySpawn, so
      // `SpawnAgentInput.runtime` had no producer and every selected agent silently ran on
      // opencode anyway. Measured 2026-08-01 — `runtime: "kimi-cli"` pointed at a marker-writing
      // executable returned a fleet_id and never invoked it.
      runtime: a.runtime,
      workspaceBinding: a.workspace_binding,
    }));

    let lifecycleMode;
    try {
      lifecycleMode = defaultLifecycleMode();
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : String(err));
    }
    if (lifecycleMode === "durable") {
      // Durable mode rehydrates a spec from the persisted Agent row, and that row has no runtime
      // column — so a durable respawn would come back on the default adapter. Refuse instead:
      // running an agent on a runtime the caller did not ask for is the defect this field exists
      // to remove, and silently honouring it only on the first attempt would hide it better.
      const durableRuntimeAgent = specs.find((s) => s.runtime !== undefined);
      if (durableRuntimeAgent) {
        return jsonError(
          "spawn_fleet: per-agent 'runtime' is not supported in durable lifecycle mode, because a " +
            "durable respawn rehydrates from the agent row and the row does not persist it. Use " +
            "legacy or shadow mode, or omit 'runtime'.",
        );
      }
      try {
        lifecycleCoordinator.createFleet(fleetId, specs.map((s) => ({
          fleetId,
          agentId: s.agentId,
          role: s.role,
          prompt: s.prompt,
          agentFile: s.agent,
          requestedModel: s.model,
        })));
      } catch (err) {
        // Durable mode is fail-closed: do not fall back to legacy spawning.
        return jsonError(err instanceof Error ? err.message : String(err));
      }
      for (const s of specs) if (s.agent) autoRegisterFromAgent(s.agentId, fleetId, s.agent);
      return jsonResult({ fleet_id: fleetId, agent_ids: specs.map((s) => s.agentId) });
    }

    // Phase 1 — ONE txn: create the fleet + pre-register every agent row.
    // spawn() is a side-effect, so it cannot live in the txn; committing the
    // rows first means a crash after commit leaves recoverable "running" agents,
    // never a fleet with phantom-missing members.
    withLedger((data) => {
      _createFleet(data, fleetId);
      for (const s of specs) {
        _registerAgent(data, {
          id: s.agentId,
          fleet_id: fleetId,
          role: s.role,
          prompt: s.prompt,
          agent_file: s.agent,
          requested_model: s.model,
          status: "running",
          started_at: Date.now(),
        });
      }
    });
    if (lifecycleMode === "shadow") lifecycleCoordinator.recordMode(fleetId, "shadow");
    appendEvent("fleet_created", { fleet_id: fleetId });
    appendEvent("spawn_fleet_called", { fleet_id: fleetId, agent_count: agents.length });

    // Phase 2 — spawn each child after commit; per-child pid write-back is in trySpawn.
    for (const s of specs) {
      trySpawn({
        fleetId,
        role: s.role,
        prompt: s.prompt,
        agentFile: s.agent,
        requestedModel: s.model,
        runtime: s.runtime,
        workspaceBinding: s.workspaceBinding,
      }, s.agentId, 1);
      appendEvent("agent_spawned", { fleet_id: fleetId, agent_id: s.agentId, role: s.role, agent_file: s.agent });
      if (s.agent) autoRegisterFromAgent(s.agentId, fleetId, s.agent);
    }

    return jsonResult({ fleet_id: fleetId, agent_ids: specs.map((s) => s.agentId) });
};

toolHandlers["fleet_status"] = async (args) => {
    const ip = "global"; // no IP extraction yet; use single bucket
    if (!checkRateLimit(ip, "read")) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Read rate limit exceeded. Slow down." }) }], isError: true };
    }
    const { fleet_id } = args as { fleet_id: string };
    const data = readLedger();
    const fleet = data.fleets[fleet_id];
    const agents = Object.values(data.agents).filter(
      (a) => a.fleet_id === fleet_id
    );
    return jsonResult({ fleet, agents });
};

toolHandlers["list_fleets"] = async (args) => {
    const ip = "global";
    if (!checkRateLimit(ip, "read")) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Read rate limit exceeded." }) }], isError: true };
    }
    return jsonResult({ fleets: listFleets() });
};

toolHandlers["set_fleet_timeout"] = async (args) => {
    const { fleet_id, timeout_ms } = args as { fleet_id: string; timeout_ms: number };
    // The env path for this same value demands > 0; the tool path accepted 0,
    // which stores a timeout that fails every agent the instant it starts.
    const badTimeout = firstError(
      requireString("set_fleet_timeout", "fleet_id", fleet_id),
      requireNumber("set_fleet_timeout", "timeout_ms", timeout_ms, { min: 1, integer: true }),
    );
    if (badTimeout) return jsonError(badTimeout);
    try {
      setFleetTimeout(fleet_id, timeout_ms);
      appendEvent("fleet_timeout_set", { fleet_id, timeout_ms });
      return jsonResult({ ok: true, timeout_ms: getFleetTimeoutMs(fleet_id) });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : String(err));
    }
};

toolHandlers["collect_results"] = async (args) => {
    const { fleet_id } = args as { fleet_id: string };
    const bad = requireString("collect_results", "fleet_id", fleet_id);
    if (bad) return jsonError(bad);
    const data = readLedger();
    const agents = Object.values(data.agents).filter(
      (a) => a.fleet_id === fleet_id
    );
    // Agent loss must be LOUD here. A crashed agent reports nothing, and its
    // silence is indistinguishable from "not finished yet" — on 2026-08-04 a
    // server crash killed 2 of 7 agents (including the operator's
    // highest-priority job) and this response said nothing: the dead entries
    // were simply present with an empty output, and a human found out by
    // counting. The summary goes FIRST in the object so it cannot be scrolled
    // past, and `warning` appears only when something was actually lost.
    const summary = summarizeCollection(agents);
    return jsonResult({
      fleet_id,
      ...summary,
      results: agents.map((a) => ({
        role: a.role,
        status: a.status,
        output: a.output,
        error: a.error,
        diagnostics: a.diagnostics,
        // What the agent DECLARED about its own outcome. Absent on rows written before the
        // contract existed, and never backfilled. This release records it without acting on it,
        // so a caller wanting the stronger guarantee today asks for BOTH facts.
        result_contract: a.result_contract,
      })),
    });
};

toolHandlers["send_message"] = async (args) => {
    const {
      from_agent_id,
      to_agent_id,
      fleet_id,
      type,
      payload,
      correlation_id,
    } = args as {
      from_agent_id: string;
      to_agent_id: string;
      fleet_id: string;
      type: MessageType;
      payload: string;
      correlation_id?: string;
    };
    const bad = firstError(
      requireString("send_message", "from_agent_id", from_agent_id),
      requireString("send_message", "to_agent_id", to_agent_id),
      requireString("send_message", "fleet_id", fleet_id),
      requirePresentString("send_message", "payload", payload),
      requireEnum("send_message", "type", type, MESSAGE_TYPES),
      optionalNonBlankString("send_message", "correlation_id", correlation_id),
    );
    if (bad) return jsonError(bad);
    try {
      // The writer returns the resolved recipient list from inside the txn, so
      // SSE notification needs no post-commit re-read (that read was a TOCTOU:
      // a concurrent write could change the message between commit and re-read).
      const { messageId, recipients } = sendMessage(
        from_agent_id,
        to_agent_id,
        fleet_id,
        type,
        payload,
        correlation_id
      );
      // v0.7.0: push to any active SSE subscribers
      // v0.9.0: broadcasts push to every resolved recipient
      for (const recipient of recipients) {
        notifySubscribers(recipient, [
          {
            type: "message",
            message_id: messageId,
            from_agent_id,
            payload: JSON.stringify({ type, payload }),
            timestamp: Date.now(),
          },
        ]);
      }
      return jsonResult({ message_id: messageId, recipients });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : String(err));
    }
};

toolHandlers["send_messages"] = async (args) => {
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
      return jsonError("send_messages: arguments must be an object");
    }
    const { messages } = args as Record<string, unknown>;
    if (!Array.isArray(messages)) {
      return jsonError("send_messages: 'messages' is required and must be an array");
    }
    if (messages.length > MAX_BATCH_MESSAGES) {
      return jsonError(
        `send_messages: 'messages' must contain at most ${MAX_BATCH_MESSAGES} items, got ${messages.length}`,
      );
    }

    const batch: Array<{
      fromAgentId: string;
      toAgentId: string;
      fleetId: string;
      type: MessageType;
      payload: string;
      correlationId?: string;
    }> = [];

    // Validate every unknown wire item before projecting it into the typed core
    // input. This is deliberately separate from sendMessages(): the direct core
    // API retains its existing compatibility surface, while this MCP handler
    // enforces the contract it publishes to remote callers.
    for (let i = 0; i < messages.length; i++) {
      const item = messages[i];
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        return jsonError(`send_messages: 'messages[${i}]' must be an object`);
      }
      const message = item as Record<string, unknown>;
      const prefix = `messages[${i}]`;
      const bad = firstError(
        requireString("send_messages", `${prefix}.from_agent_id`, message.from_agent_id),
        requireString("send_messages", `${prefix}.to_agent_id`, message.to_agent_id),
        requireString("send_messages", `${prefix}.fleet_id`, message.fleet_id),
        requirePresentString("send_messages", `${prefix}.payload`, message.payload),
        requireEnum("send_messages", `${prefix}.type`, message.type, MESSAGE_TYPES),
        optionalNonBlankString("send_messages", `${prefix}.correlation_id`, message.correlation_id),
      );
      if (bad) return jsonError(bad);

      batch.push({
        fromAgentId: message.from_agent_id as string,
        toAgentId: message.to_agent_id as string,
        fleetId: message.fleet_id as string,
        type: message.type as MessageType,
        payload: message.payload as string,
        correlationId: message.correlation_id as string | undefined,
      });
    }

    try {
      const results = sendMessages(batch);
      // Same per-recipient SSE push as send_message, after the single commit.
      results.forEach(({ messageId, recipients }, i) => {
        const src = batch[i]!;
        for (const recipient of recipients) {
          notifySubscribers(recipient, [
            {
              type: "message",
              message_id: messageId,
              from_agent_id: src.fromAgentId,
              payload: JSON.stringify({ type: src.type, payload: src.payload }),
              timestamp: Date.now(),
            },
          ]);
        }
      });
      return jsonResult({
        results: results.map((r) => ({ message_id: r.messageId, recipients: r.recipients })),
      });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : String(err));
    }
};

toolHandlers["get_inbox"] = async (args) => {
    const { agent_id, since } = args as {
      agent_id: string;
      since?: number;
    };
    // A non-numeric `since` compares as NaN and returns an empty inbox with
    // success — and this is the documented polling fallback when SSE is not
    // used, so it is a message-loss path, not a cosmetic one.
    const bad = firstError(
      requireString("get_inbox", "agent_id", agent_id),
      optionalNumber("get_inbox", "since", since),
    );
    if (bad) return jsonError(bad);
    return jsonResult({ messages: getInbox(agent_id, since) });
};

toolHandlers["compile_route_candidates"] = async (args) => {
  try {
    return jsonResult(
      compileRouteCandidates(args as unknown as CompileRouteCandidatesInput),
    );
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error));
  }
};

toolHandlers["plan_speculative_backlog"] = async (args) => {
  try {
    return jsonResult(planSpeculativeBacklog(args as PlanSpeculativeBacklogInput));
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error));
  }
};

toolHandlers["recommend_route"] = async (args) => {
  const input = args as Record<string, unknown>;
  const firstUnexpected = (
    value: unknown,
    allowed: ReadonlySet<string>,
    path: string,
  ): string | undefined => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const key = Object.keys(value as Record<string, unknown>).find(
      (candidate) => !allowed.has(candidate),
    );
    return key === undefined ? undefined : `${path}${key}`;
  };
  const topLevelUnexpected = firstUnexpected(
    input,
    new Set(["task", "candidates", "top_n", "preference"]),
    "",
  );
  if (topLevelUnexpected) {
    return jsonError(
      `recommend_route: '${topLevelUnexpected}' is not allowed; supply sanitized traits only`,
    );
  }
  const taskUnexpected = firstUnexpected(
    input.task,
    new Set([
      "required_capabilities",
      "optional_capabilities",
      "privacy",
      "locality",
      "coordination",
      "policy_tags",
      "min_context_tokens",
    ]),
    "task.",
  );
  if (taskUnexpected) {
    return jsonError(
      `recommend_route: '${taskUnexpected}' is not allowed; supply sanitized traits only`,
    );
  }
  if (Array.isArray(input.candidates)) {
    const allowedCandidateKeys = new Set([
      "candidate_id",
      "capabilities",
      "privacy",
      "locality",
      "coordination_modes",
      "policy_tags",
      "context_window",
      "observed_outcomes",
      "budget",
      "requested_identity",
      "observed_identity",
    ]);
    for (let index = 0; index < input.candidates.length; index++) {
      const candidateUnexpected = firstUnexpected(
        input.candidates[index],
        allowedCandidateKeys,
        `candidates[${index}].`,
      );
      if (candidateUnexpected) {
        return jsonError(
          `recommend_route: '${candidateUnexpected}' is not allowed; recommendation never executes or wakes agents`,
        );
      }
    }
  }
  try {
    return jsonResult(recommendRoute(args as RecommendRouteInput));
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error));
  }
};

toolHandlers["ack_message"] = async (args) => {
    const { agent_id, message_id } = args as {
      agent_id: string;
      message_id: string;
    };
    // A missing agent_id wrote a receipt keyed `<msg>:undefined:ack`, consumed
    // no inbox, and returned {ok:true}. verify_ledger passed it: its key-mismatch
    // check builds the comparison key with the same coercion, so the strings
    // matched, and it fell through to a warning — a false green.
    const bad = firstError(
      requireString("ack_message", "agent_id", agent_id),
      requireString("ack_message", "message_id", message_id),
    );
    if (bad) return jsonError(bad);
    return jsonResult({ ok: ackMessage(agent_id, message_id) });
};

toolHandlers["receipt"] = async (args) => {
    const { agent_id, message_id, action, note } = args as {
      agent_id: string;
      message_id: string;
      action: string;
      note?: string;
    };
    const bad = firstError(
      requireString("receipt", "agent_id", agent_id),
      requireString("receipt", "message_id", message_id),
      requireString("receipt", "action", action),
    );
    if (bad) return jsonError(bad);
    if (action === "ack") {
      return jsonError("Use ack_message to consume a message; receipt is for non-consuming actions");
    }
    const receipt = writeReceipt(agent_id, message_id, action, note);
    if (!receipt) return jsonError(`No such message: ${message_id}`);
    return jsonResult({ receipt });
};

toolHandlers["get_receipts"] = async (args) => {
    const { message_id } = args as { message_id: string };
    const bad = requireString("get_receipts", "message_id", message_id);
    if (bad) return jsonError(bad);
    return jsonResult({ receipts: getReceipts(message_id) });
};

toolHandlers["verify_ledger"] = async () => {
    return jsonResult(verifyLedger());
};

toolHandlers["verify_ledger_v2"] = async () => {
    try {
      return jsonResult(buildVerifyEnvelopeV2(verifyLedgerFile(resolveDbFile())));
    } catch {
      return jsonError("verify_ledger_v2 unavailable: configured ledger is absent or unreadable");
    }
};

toolHandlers["verify_ledger_v3"] = async () => {
    try {
      return jsonResult(buildVerifyEnvelopeV3(verifyLedgerFile(resolveDbFile())));
    } catch {
      return jsonError("verify_ledger_v3 unavailable: configured ledger is absent or unreadable");
    }
};

toolHandlers["open_ratification"] = async (args) => {
    const a = args as {
      proposer: string;
      fleet_id: string;
      subject: string;
      payload?: string;
      quorum: number;
      voters?: string[];
      required_signoffs?: string[];
      deadline?: number;
      silence_policy?: "abstain" | "approve";
      weights?: Record<string, number>;
    };
    // Four governance defects lived here, all returning success:
    //   - `subject` omitted wrote `undefined` as the proposal's subject
    //   - `voters: "alice"` was spread into five single-character voters,
    //     locking every real voter out of their own council
    //   - `deadline` as an ISO string made `now >= deadline` compare false
    //     forever, so the ratification could NEVER expire
    //   - `silence_policy: "APPROVE"` silently degraded to abstain, inverting
    //     the meaning of silence
    const bad = firstError(
      requireString("open_ratification", "proposer", a.proposer),
      requireString("open_ratification", "fleet_id", a.fleet_id),
      requireString("open_ratification", "subject", a.subject),
      requireNumber("open_ratification", "quorum", a.quorum, { min: 1, integer: true }),
      requireStringArray("open_ratification", "voters", a.voters, { optional: true }),
      requireStringArray("open_ratification", "required_signoffs", a.required_signoffs, { optional: true }),
      optionalNumber("open_ratification", "deadline", a.deadline),
      requireEnum("open_ratification", "silence_policy", a.silence_policy, ["abstain", "approve"], { optional: true }),
    );
    if (bad) return jsonError(bad);
    try {
      const messageId = openRatification({
        proposer: a.proposer,
        fleetId: a.fleet_id,
        subject: a.subject,
        payload: a.payload,
        quorum: a.quorum,
        voters: a.voters,
        requiredSignoffs: a.required_signoffs,
        deadline: a.deadline,
        silencePolicy: a.silence_policy,
        weights: a.weights,
      });
      return jsonResult({ message_id: messageId, tally: tallyRatification(messageId) });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : String(err));
    }
};

toolHandlers["cast_vote"] = async (args) => {
    const { agent_id, message_id, approve, note } = args as {
      agent_id: string;
      message_id: string;
      approve: boolean;
      note?: string;
    };
    const bad = firstError(
      requireString("cast_vote", "agent_id", agent_id),
      requireString("cast_vote", "message_id", message_id),
    );
    if (bad) return jsonError(bad);
    if (typeof approve !== "boolean") {
      return jsonError(
        `cast_vote: 'approve' is required and must be a boolean, not ${JSON.stringify(approve)} ` +
          `(${typeof approve}). Refusing to guess a vote — a truthiness reading would record ` +
          `"false" as an APPROVAL and an omitted value as a DECLINE.`
      );
    }
    try {
      const ok = castVote(agent_id, message_id, approve, note);
      if (!ok) return jsonError(`No such ratification: ${message_id}`);
      return jsonResult({ ok, status: resolveRatification(message_id), tally: tallyRatification(message_id) });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : String(err));
    }
};

toolHandlers["tally_ratification"] = async (args) => {
    const { message_id } = args as { message_id: string };
    const bad = requireString("tally_ratification", "message_id", message_id);
    if (bad) return jsonError(bad);
    const status = resolveRatification(message_id);
    if (status === null) return jsonError(`No such ratification: ${message_id}`);
    return jsonResult({ status, tally: tallyRatification(message_id) });
};

toolHandlers["sweep_ratifications"] = async (args) => {
    return jsonResult(sweepRatifications());
};

toolHandlers["register_capability"] = async (args) => {
    // The wire schema is snake_case; CapabilityInput is camelCase. This handler
    // used to pass `args` straight through with a cast, so `agent_id`,
    // `fleet_id` and `context_window` all arrived undefined while `role`,
    // `skills` and `model` — which happen to share a spelling — came through
    // fine. The call then returned {ok:true} having written a row keyed
    // "undefined". Destructure explicitly, exactly like every sibling handler.
    const { agent_id, fleet_id, role, skills, model, context_window } = args as {
      agent_id: string;
      fleet_id: string;
      role: string;
      skills: string[];
      model?: string;
      context_window?: number;
    };
    // Siblings (set_fleet_timeout, open_ratification, ...) return a jsonError
    // envelope rather than letting a throw escape as a protocol-level error.
    // registerCapability now rejects malformed ids, so this handler needs the
    // same treatment or a sloppy client gets a transport fault instead of a
    // readable tool result.
    try {
      registerCapability({
        agentId: agent_id,
        fleetId: fleet_id,
        role,
        skills,
        model,
        contextWindow: context_window,
      });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : String(err));
    }
    return jsonResult({ ok: true, agent_id, fleet_id });
};

toolHandlers["route_work"] = async (args) => {
    const { description, top_n } = args as { description: string; top_n?: number };
    return jsonResult({ matches: routeWork(description, top_n ?? 1) });
};

toolHandlers["record_routing_outcome"] = async (args) => {
    const { agent_id, capability_key, success } = args as {
      agent_id: string;
      capability_key: string;
      success: boolean;
    };
    // `success` was read for truthiness exactly as cast_vote's `approve` was:
    // omitted recorded a FAILURE, "false" recorded a SUCCESS. It multiplies
    // every later route_work score, and the state is an in-process Map that
    // verify_ledger cannot see — so a wrong value is invisible AND persistent.
    const bad = firstError(
      requireString("record_routing_outcome", "agent_id", agent_id),
      requireString("record_routing_outcome", "capability_key", capability_key),
      requireBoolean("record_routing_outcome", "success", success),
    );
    if (bad) return jsonError(bad);
    recordRoutingOutcome(agent_id, capability_key, success);
    return jsonResult({ ok: true, agent_id, capability_key, success });
};

toolHandlers["list_agents"] = async (args) => {
    const agents = discoverPremadeAgents();
    return jsonResult({ count: agents.length, agents });
};

toolHandlers["attach_agent"] = async (args) => {
    const { fleet_id, role, prompt, agent, model } = args as {
      fleet_id: string;
      role: string;
      prompt: string;
      agent?: string;
      model?: string;
    };
    // Same unenforced-contract hole as spawn_fleet, and attach_agent also spawns.
    // It is additionally the ONLY in-place path that reopens an `abandoned` fleet,
    // so a corrupt row written here lands on the one remedy a truthful terminal
    // status leaves available.
    const badAttach = firstError(
      requireString("attach_agent", "fleet_id", fleet_id),
      requireString("attach_agent", "role", role),
      requireString("attach_agent", "prompt", prompt),
      agent === undefined ? null : requireString("attach_agent", "agent", agent),
      optionalModelSelector("attach_agent", "model", model),
    );
    if (badAttach) return jsonError(badAttach);
    const agentId = randomUUID();
    let lifecycleMode;
    try {
      lifecycleMode = lifecycleCoordinator.modeForFleet(fleet_id);
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : String(err));
    }
    if (lifecycleMode === "durable") {
      const check = lifecycleCoordinator.attachAgent({
        fleetId: fleet_id,
        agentId,
        role,
        prompt,
        agentFile: agent,
        requestedModel: model,
      });
      if (check.error) return jsonError(check.error);
      if (agent) autoRegisterFromAgent(agentId, fleet_id, agent);
      return jsonResult({ agent_id: agentId, fleet_id, role, agent_file: agent ?? null, message: `Agent ${role} attached to fleet ${fleet_id}` });
    }
    // Re-check exists && running INSIDE the txn and pre-register the row in the
    // same transaction. Checking outside (as before) let a concurrent
    // checkFleetCompletion flip the fleet to complete between check and write —
    // a live agent attached to a dead fleet (the red-team's exact case).
    const check = withLedger((data): { error?: string; reopened?: boolean } => {
      const fleet = data.fleets[fleet_id];
      if (!fleet) return { error: `Fleet ${fleet_id} not found` };
      // `abandoned` is accepted, and this is load-bearing rather than a
      // convenience. attach_agent is the ONLY in-place path into an existing
      // fleet — nothing anywhere re-runs an interrupted agent — so if
      // terminalizing a crashed fleet also sealed it, making the fleet's status
      // truthful would have cost the only remedy its own error string names.
      // `complete` and `failed` stay sealed: those fleets reached a real outcome.
      if (fleet.status !== "running" && fleet.status !== "abandoned") {
        return { error: `Fleet ${fleet_id} is ${fleet.status}, not running` };
      }
      // Reopen: a fleet with a live agent in it is running, whatever it was a
      // moment ago. Leaving it `abandoned` while its replacement works would be
      // the same class of false projection this status was added to remove.
      const reopened = fleet.status === "abandoned";
      if (reopened) {
        fleet.status = "running";
        delete fleet.completed_at;
      }
      _registerAgent(data, {
        id: agentId,
        fleet_id,
        role,
        prompt,
        agent_file: agent,
        requested_model: model,
        status: "running",
        started_at: Date.now(),
      });
      return { reopened };
    });
    if (check.error) return jsonError(check.error);
    if (check.reopened) {
      appendEvent("fleet_reconciled", {
        fleet_id,
        from: "abandoned",
        to: "running",
        via: "attach_agent",
      });
    }

    // Spawn after commit; capability auto-register is its own txn.
    trySpawn({
      fleetId: fleet_id,
      role,
      prompt,
      agentFile: agent,
      requestedModel: model,
    }, agentId, 1);
    if (agent) autoRegisterFromAgent(agentId, fleet_id, agent);

    return jsonResult({
      agent_id: agentId,
      fleet_id,
      role,
      agent_file: agent ?? null,
      message: `Agent ${role} attached to fleet ${fleet_id}`,
    });
};

toolHandlers["ping"] = async (args) => {
    return jsonResult(ping());
};

toolHandlers["get_health"] = async (args) => {
    return jsonResult(getHealth());
};

toolHandlers["subscribe_inbox"] = async (args) => {
    const { agent_id } = args as { agent_id: string };
    const data = readLedger();
    if (!data.agents[agent_id]) {
      return jsonError(`Agent "${agent_id}" not found`);
    }
    // Do not hand back a stream URL this process cannot serve. startSseServer()
    // failure is caught and logged to stderr only, so when the port is already
    // taken — by another meshfleet instance, or anything else — this tool used
    // to return a normal-looking stream_url and the client would connect to a
    // stranger's server (or nothing) and wait forever for events that could
    // never arrive, while the messages sat correctly in the durable inbox.
    // Observed live: a squatter on the port produced 0 events, indefinitely.
    if (!isSseServerRunning()) {
      return jsonError(
        `subscribe_inbox: this server has no live SSE endpoint, so it cannot push to you — ` +
          `the listener failed to start (most often the port is already in use by another ` +
          `meshfleet instance). Poll get_inbox instead; the durable inbox is unaffected and is ` +
          `the source of truth. SSE is advisory acceleration, never correctness.`
      );
    }
    const streamUrl = subscribeInboxUrl(agent_id);
    return jsonResult({
      agent_id,
      stream_url: streamUrl,
      // Honest about scope: this process pushes only what IT writes. A sibling
      // instance sharing the same ledger has its own in-memory subscriber
      // registry and cannot reach this stream, so get_inbox remains the only
      // complete view.
      served_by_this_process_only: true,
      instructions:
        "Open an HTTP GET to the stream_url. Each event is SSE-formatted: `event: <type>\\ndata: <json>\\n\\n`. Push covers messages written by THIS server process; poll get_inbox for the complete, durable view — it is the source of truth and SSE is advisory only.",
    });
};

toolHandlers["save_fleet_template"] = async (args) => {
    const { name: tplName, description, agents } = args as {
      name: string
      description?: string
      agents: TemplateAgent[]
    };
    try {
      const tpl = saveFleetTemplateFn(tplName, agents, description ?? "");
      return jsonResult({ template: tpl });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : String(err));
    }
};

toolHandlers["list_fleet_templates"] = async (args) => {
    return jsonResult({ templates: listFleetTemplatesFn() });
};

toolHandlers["spawn_from_template"] = async (args) => {
    const { name: tplName } = args as { name: string };
    const spec = spawnFromTemplateFn(tplName);
    if (!spec) {
      return jsonError(`Template "${tplName}" not found`);
    }
    return jsonResult({ spec });
};

// ---------------------------------------------------------------------------
// Discussions (D3) — thin MCP delegation to src/discussion-mcp.ts's real-deps
// DiscussionStore singleton. All transaction/guard/receipt mechanics live in
// the store (src/discussion-store.ts, D2); handlers here only marshal args,
// delegate, and translate DiscussionError into the extended error contract.
// ---------------------------------------------------------------------------

toolHandlers["ask_peer"] = async (args) => {
    // `wake_peer` is the single most dangerous field on this tool surface: it is
    // the explicit, budgeted authority to RUN an agent, in a lane whose whole
    // premise is that nothing starts a process implicitly. Read for truthiness,
    // `wake_peer: "false"` reserved and launched a peer attempt from a caller
    // that had explicitly declined one — measured over real stdio, the response
    // came back `wake_reserved: true`. Same defect as cast_vote, on the switch
    // where it matters most.
    //
    // The string fields matter for a different reason: omitting `payload` wrote
    // a whole discussion whose derived status is `invalid` (empty fleet_id,
    // participants `["",""]`, max_turns 0) and returned a normal-looking result.
    // `verify_ledger` then correctly reports that row as an error — the writer
    // was manufacturing exactly what the auditor is there to catch.
    //
    // Numeric fields are type-checked here and RANGE-checked in the store, which
    // owns the named bounds. The boundary asserts the published contract; the
    // store asserts the domain policy.
    const argErr = firstError(
      requireString("ask_peer", "from_agent_id", (args as Record<string, unknown>).from_agent_id),
      requireString("ask_peer", "to_agent_id", (args as Record<string, unknown>).to_agent_id),
      requireString("ask_peer", "fleet_id", (args as Record<string, unknown>).fleet_id),
      requireString("ask_peer", "payload", (args as Record<string, unknown>).payload),
      requireNumber("ask_peer", "max_turns", (args as Record<string, unknown>).max_turns, { integer: true }),
      requireNumber("ask_peer", "timeout_ms", (args as Record<string, unknown>).timeout_ms, { integer: true }),
      requireNumber("ask_peer", "turn_timeout_ms", (args as Record<string, unknown>).turn_timeout_ms, { integer: true }),
      requireBoolean("ask_peer", "wake_peer", (args as Record<string, unknown>).wake_peer)
    );
    if (argErr) return jsonError(argErr);
    try {
      const params = args as AskPeerParams;
      const opened = await getDiscussionStore().openDiscussion(params);
      const result = await getDiscussionStore().awaitAnswer(opened.discussion_id, opened.root_message_id);
      return jsonResult(result);
    } catch (err) {
      if (err instanceof DiscussionError) return jsonDiscussionError(err.code, err.detail);
      return jsonError(err instanceof Error ? err.message : String(err));
    }
};

toolHandlers["wake_agent"] = async (args) => {
    // All three are the compare-and-swap identity of a wake. An omitted
    // `expected_head_message_id` would turn a guarded resume into an unguarded
    // one, and an omitted `agent_id` reached the discussion lookup before
    // anything noticed it was missing.
    const argErr = firstError(
      requireString("wake_agent", "agent_id", (args as Record<string, unknown>).agent_id),
      requireString("wake_agent", "discussion_id", (args as Record<string, unknown>).discussion_id),
      requireString(
        "wake_agent",
        "expected_head_message_id",
        (args as Record<string, unknown>).expected_head_message_id
      )
    );
    if (argErr) return jsonError(argErr);
    try {
      const params = args as WakeAgentParams;
      const result = await getDiscussionStore().wakeAgent(params);
      return jsonResult(result);
    } catch (err) {
      if (err instanceof DiscussionError) return jsonDiscussionError(err.code, err.detail);
      return jsonError(err instanceof Error ? err.message : String(err));
    }
};

toolHandlers["reply_discussion"] = async (args) => {
    // `close` is read as `params.close ?? false`, so the string "false" makes a
    // conversation TERMINAL — the nullish coalesce only guards absence, never
    // type. `type` is a two-member enum written straight into the message row;
    // an unrecognized value is persisted rather than refused.
    const argErr = firstError(
      requireString("reply_discussion", "agent_id", (args as Record<string, unknown>).agent_id),
      requireString("reply_discussion", "discussion_id", (args as Record<string, unknown>).discussion_id),
      requireString("reply_discussion", "attempt_id", (args as Record<string, unknown>).attempt_id),
      requireString(
        "reply_discussion",
        "reply_to_message_id",
        (args as Record<string, unknown>).reply_to_message_id
      ),
      requireEnum("reply_discussion", "type", (args as Record<string, unknown>).type, ["question", "result"]),
      requireString("reply_discussion", "payload", (args as Record<string, unknown>).payload),
      optionalBoolean("reply_discussion", "close", (args as Record<string, unknown>).close)
    );
    if (argErr) return jsonError(argErr);
    try {
      const params = args as ReplyDiscussionParams;
      const result = await getDiscussionStore().replyDiscussion(params);
      return jsonResult(result);
    } catch (err) {
      if (err instanceof DiscussionError) return jsonDiscussionError(err.code, err.detail);
      return jsonError(err instanceof Error ? err.message : String(err));
    }
};

toolHandlers["get_discussion"] = async (args) => {
    // Read-only, so the blast radius is small — but an omitted `discussion_id`
    // produced `not_found` naming no id, which reads like a real miss rather
    // than a malformed call. `include_receipts` is compared with `=== false`,
    // which happens to fail SAFE (a string over-includes); it is validated
    // anyway, because "safe by accident" is not a contract.
    const argErr = firstError(
      requireString("get_discussion", "discussion_id", (args as Record<string, unknown>).discussion_id),
      optionalBoolean("get_discussion", "include_receipts", (args as Record<string, unknown>).include_receipts)
    );
    if (argErr) return jsonError(argErr);
    try {
      const params = args as GetDiscussionParams;
      const view = getDiscussionStore().getDiscussion(params);
      return jsonResult(view);
    } catch (err) {
      if (err instanceof DiscussionError) return jsonDiscussionError(err.code, err.detail);
      return jsonError(err instanceof Error ? err.message : String(err));
    }
};

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (!toolAllowedByAccessProfile(name)) {
    return jsonError(`Tool '${name}' is unavailable in the audit access profile`);
  }
  const handler = toolHandlers[name];
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return await handler(args);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

// A nested instance booted by a spawned agent's own opencode session
// (spawn env sets AGENT_MESH_CHILD=1). It shares the parent's ledger, so it
// must not run startup recovery (it would flip the parent's live agents),
// must not bind the SSE port the parent already holds, and must not run a
// competing ratification sweeper.
const isChildInstance = process.env.AGENT_MESH_CHILD === "1";

// Crash handling goes on EVERY instance — parent, child, and audit profile
// alike. A child that dies silently strands work exactly as a parent does, and
// the one thing this product must never do is lose someone's work without a
// fingerprint. Registered here, before the startup work below, so a throw
// during migration or recovery is already covered.
//
// The journal sits beside the ledger, so it follows MESHFLEET_DB_FILE and an
// isolated run cannot append to the operator's real one.
installCrashHandlers({
  journalPath: `${resolveDbFile()}.crash.jsonl`,
  snapshotInFlight: () => {
    // Memory-only, best effort: after an uncaught exception the heap may be
    // untrustworthy, so this reads what is already loaded and never queries.
    try {
      const data = readLedger();
      return Object.values(data.agents)
        .filter((a) => a.status === "running" || a.status === "pending")
        .map((a) => ({ agent_id: a.id, fleet_id: a.fleet_id, pid: a.pid }));
    } catch {
      return [];
    }
  },
});

if (!isChildInstance && !isAuditProfile) {
  // Phase 2: one-shot JSON→SQLite migration. Stop-the-world, parent-only, BEFORE
  // any ledger read/write — a fresh getDb() would otherwise create an empty db
  // and strand the JSON. Fails-closed: a validation mismatch aborts startup with
  // the JSON left authoritative (never run on a partial/empty ledger).
  try {
    const migration = migrateJsonToSqlite();
    if (migration.migrated) {
      // Only claim a backup that was actually created: the rename can fail (or
      // the source can have been quarantined/vanished), in which case
      // backupPath is unset and `reason` carries the honest account — the old
      // line printed "backed up to undefined" for those cases.
      const disposition = migration.backupPath
        ? `JSON backed up to ${migration.backupPath}`
        : (migration.reason ?? "source not retired");
      console.error(
        `Agent Mesh v${MESH_VERSION} — migrated ${migration.rowCount} ledger entr${migration.rowCount === 1 ? "y" : "ies"} JSON→SQLite; ${disposition}`
      );
    } else if (migration.refused) {
      // A migration that could have run and was declined must SAY SO. Otherwise
      // someone who legitimately relocated their db sees an empty ledger with no
      // explanation — the silent-skip failure mode is nearly as bad as the
      // silent-consume one it replaces. The ordinary no-ops stay quiet.
      console.error(`Agent Mesh v${MESH_VERSION} — ledger migration SKIPPED: ${migration.reason}`);
    }
  } catch (err) {
    console.error(`Agent Mesh v${MESH_VERSION} — FATAL: ${err instanceof Error ? err.message : String(err)}`);
    throw err; // fail-closed
  }

  // v0.7.x: recover any agents left in 'running' state from a previous
  // crashed process so fleet_status reflects reality. Liveness-probed since
  // 2026-07-03 — only agents with a missing/dead pid are flipped.
  repairLifecycleOutbox();
  lifecycleCoordinator.recover();
  const recoveredCount = recoverInterruptedAgents();
  if (recoveredCount > 0) {
    console.error(`Agent Mesh v${MESH_VERSION} — recovered ${recoveredCount} interrupted agent(s) from previous run`);
  }
  // Close fleets written before the completion lattice existed, which no normal
  // write path can ever revisit. LOUD, because this rewrites stored statuses in
  // the operator's ledger on first start after upgrade; each move also leaves a
  // `fleet_reconciled` EVENT in the event log naming its before and after. Not a
  // "receipt": receipts are rows keyed to a real message, and there is no message
  // here to attest to.
  const reconciledCount = reconcileAbandonedFleets();
  if (reconciledCount > 0) {
    console.error(`Agent Mesh v${MESH_VERSION} — reconciled ${reconciledCount} fleet(s) whose agents had all finished but which were still recorded as running (see fleet_reconciled events)`);
  }

  // D3: prime the Discussions sweep index — scan the ledger for discussion
  // roots and seed the store's knownDiscussionIds (via the cheap,
  // hydration-free seedKnownDiscussionIds path — see discussion-mcp.ts's doc
  // comment on primeDiscussionSweepIndex) so a post-restart sweep can find
  // stranded reserved/started attempts. Deferred via setImmediate (cdx
  // pass-1 review item 4): `server.connect(transport)` above has already
  // resolved by this point, but this whole startup block still runs
  // synchronously on the event loop — a large-ledger scan here would still
  // delay the process from actually servicing its first incoming stdio tool
  // call. setImmediate lets that happen first; priming then runs as its own
  // best-effort tick, and a failure logs a stderr one-liner rather than
  // aborting startup or failing silently.
  setImmediate(() => {
    try {
      const primedCount = primeDiscussionSweepIndex();
      if (primedCount > 0) {
        console.error(`Agent Mesh v${MESH_VERSION} — primed ${primedCount} discussion(s) into the sweep index`);
      }
    } catch (err) {
      console.error(`Agent Mesh v${MESH_VERSION} — discussion sweep-index priming failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // v0.11: periodic ratification deadline sweep (0 disables)
  const sweepMs = Number(resolveEnv(process.env, "MESHFLEET_RATIFY_SWEEP_MS", "AGENT_MESH_RATIFY_SWEEP_MS") ?? 60_000);
  if (Number.isFinite(sweepMs) && sweepMs > 0) {
    // This sweep used to swallow its own failures: a catch holding a comment and
    // nothing else, where runSweepTick is now called. Its intent was
    // right — a broken sweep must never take the server down — but it made a
    // PERMANENT failure invisible: ratifications would stop resolving and votes
    // stop being tallied, forever, with no signal. That is the betrayal this
    // repo's first law names by name ("a receipt, a VOTE… a silent one is a
    // betrayal of the claim"). It was unobservable from the other side too:
    // a caught exception never reaches the process-level crash handler.
    //
    // SweepHealth keeps the server up and removes only the silence. It is a
    // reporter rather than a bare console.error because logging every tick
    // would emit ~1,440 identical lines a day and teach an operator to filter
    // the channel — reproducing the original silence by another route.
    // The tick body lives in runSweepTick (sweep-health.ts) rather than inline
    // here, so its FAILURE path can be watched by a test. Inline, the only way
    // to observe it was to break a live SQLite database — which cannot be done
    // from outside the process, because the open file descriptor keeps working
    // after the path is overwritten. Code that cannot be watched failing is how
    // the empty catch survived this long.
    const sweepHealth = new SweepHealth({ label: "ratification sweep" });
    const sweeper = setInterval(() => {
      runSweepTick({
        sweep: () => {
          const { resolved } = sweepRatifications();
          for (const [id, status] of Object.entries(resolved)) {
            appendEvent("ratification_resolved", { message_id: id, status, via: "sweep" });
          }
        },
        health: sweepHealth,
        warn: (message) => console.error(`Agent Mesh v${MESH_VERSION} — ${message}`),
        emit: (event, payload) => appendEvent(event, { sweep: "ratification", ...payload }),
      });
    }, sweepMs);
    sweeper.unref();
  }

  // Start the SSE HTTP server for real-time inbox push (v0.7.0)
  try {
    const { host, port } = await startSseServer();
    console.error(`Agent Mesh v${MESH_VERSION} started (JSON persistence + P2P messaging + capability routing + premade agent discovery + timeout/resilience + SSE push on ${host}:${port})`);
  } catch (err) {
    console.error(`Agent Mesh v${MESH_VERSION} started (JSON persistence + P2P messaging + capability routing + premade agent discovery + timeout/resilience + SSE push) — SSE server failed to start: ${err instanceof Error ? err.message : String(err)}`);
  }
} else if (isAuditProfile) {
  console.error("Agent Mesh started in audit access profile — storage startup, recovery, sweepers, and SSE skipped");
} else {
  console.error("Agent Mesh started in child mode (AGENT_MESH_CHILD=1) — recovery, sweeper, and SSE skipped");
}
