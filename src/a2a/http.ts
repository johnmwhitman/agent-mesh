import { createHash, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const DEFAULT_MAX_BODY_BYTES = 128 * 1024;
const BODY_IDLE_TIMEOUT_MS = 5_000;
const BODY_TOTAL_TIMEOUT_MS = 30_000;
const A2A_PROTOCOL_VERSION = "0.1";

export type A2AResultContract = "ok" | "refused" | "blocked" | "artifact_missing" | "invalid" | "absent";

export interface A2ATaskStatus {
  readonly fleetId: string;
  readonly agentId: string;
  readonly fleetStatus: "pending" | "running" | "complete" | "failed" | "abandoned";
  readonly agentStatus: "pending" | "running" | "complete" | "failed" | "interrupted";
  readonly resultContract?: A2AResultContract;
  readonly output?: string;
  readonly error?: string;
  readonly artifacts?: readonly string[];
}

interface A2AHttpOptions {
  readonly baseUrl: string;
  readonly authToken?: string;
  readonly maxBodyBytes?: number;
  readonly submitTask: (input: { readonly text: string; readonly metadata?: Record<string, unknown> }) => Promise<{ readonly fleetId: string; readonly agentId: string }>;
  readonly getTaskStatus: (fleetId: string, agentId: string) => A2ATaskStatus | undefined;
}

interface TaskRecord {
  readonly fleetId: string;
  readonly agentId: string;
}

interface TaskInput {
  readonly message: {
    readonly role: "user";
    readonly parts: readonly { readonly kind: "text"; readonly text: string }[];
  };
  readonly metadata?: Record<string, unknown>;
}

export function createA2AHttpHandler(options: A2AHttpOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const tasks = new Map<string, TaskRecord>();
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return (req, res) => {
    const url = new URL(req.url ?? "/", options.baseUrl);
    if (!authorized(req, url, options.authToken)) {
      respond(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
      return;
    }
    if (req.method === "GET" && (url.pathname === "/.well-known/agent-card.json" || url.pathname === "/.well-known/agent-card.json/")) {
      respond(res, 200, agentCard(options.baseUrl));
      return;
    }
    if (req.method === "POST" && (url.pathname === "/a2a/tasks" || url.pathname === "/a2a/tasks/")) {
      void submit(req, res, tasks, options.submitTask, maxBodyBytes);
      return;
    }
    const taskId = url.pathname.match(/^\/a2a\/tasks\/([^/]+)\/?$/)?.[1];
    if (req.method === "GET" && taskId) {
      const record = tasks.get(taskId);
      if (!record) {
        respond(res, 404, { error: "task not found" });
        return;
      }
      const current = options.getTaskStatus(record.fleetId, record.agentId);
      if (!current) {
        respond(res, 404, { error: "task status unavailable", task_id: taskId });
        return;
      }
      respond(res, 200, projectTask(taskId, record, current));
      return;
    }
    respond(res, 404, { error: "not found" });
  };
}

function agentCard(baseUrl: string): Record<string, unknown> {
  return {
    name: "MeshFleet local-only non-interoperable task adapter",
    description: "Process-local compatibility projection for MeshFleet; not Google A2A interoperability and not a public service.",
    url: baseUrl,
    version: "0.20.0",
    protocolVersion: A2A_PROTOCOL_VERSION,
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    skills: [
      { id: "local-task-submit", name: "Submit local task", description: "Submit one bounded text task to one local fleet agent." },
      { id: "local-task-status", name: "Read local task status", description: "Read process-local task status and declared result contract." },
    ],
  };
}

async function submit(
  req: IncomingMessage,
  res: ServerResponse,
  tasks: Map<string, TaskRecord>,
  submitTask: A2AHttpOptions["submitTask"],
  maxBodyBytes: number,
): Promise<void> {
  try {
    const length = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(length) && length > maxBodyBytes) {
      respond(res, 400, { error: "request body too large" });
      req.resume();
      return;
    }
    const contentType = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      respond(res, 400, { error: "content-type must be application/json" });
      req.resume();
      return;
    }
    const raw = await readBody(req, maxBodyBytes);
    if (!raw.ok) {
      respond(res, 400, { error: raw.error });
      return;
    }
    const parsed = parseTaskInput(raw.body);
    if (!parsed.ok) {
      respond(res, 400, { error: parsed.error });
      return;
    }
    const linked = await submitTask({ text: parsed.value.message.parts[0].text, ...(parsed.value.metadata ? { metadata: parsed.value.metadata } : {}) });
    const taskId = randomUUID();
    tasks.set(taskId, { fleetId: linked.fleetId, agentId: linked.agentId });
    respond(res, 202, { task_id: taskId, fleet_id: linked.fleetId, agent_id: linked.agentId, status: "working", scope: "process-local" });
  } catch {
    if (!res.destroyed && !res.writableEnded) respond(res, 500, { error: "task submission failed" });
  }
}

function parseTaskInput(raw: string): { readonly ok: true; readonly value: TaskInput } | { readonly ok: false; readonly error: string } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: "body must be valid JSON" };
  }
  if (!isRecord(value) || !isRecord(value.message) || value.message.role !== "user" || !Array.isArray(value.message.parts) || value.message.parts.length !== 1) {
    return { ok: false, error: "message must contain exactly one text part" };
  }
  const parts = value.message.parts;
  const textParts: { readonly kind: "text"; readonly text: string }[] = [];
  for (const part of parts) {
    if (!isRecord(part) || part.kind !== "text" || typeof part.text !== "string" || part.text.trim() === "") return { ok: false, error: "parts must contain non-empty text" };
    textParts.push({ kind: "text", text: part.text });
  }
  if (value.metadata !== undefined && !isRecord(value.metadata)) return { ok: false, error: "metadata must be an object" };
  return { ok: true, value: { message: { role: "user", parts: textParts }, ...(value.metadata ? { metadata: value.metadata } : {}) } };
}

function projectTask(taskId: string, record: TaskRecord, status: A2ATaskStatus): Record<string, unknown> {
  const fleetTerminal = status.fleetStatus === "complete" || status.fleetStatus === "failed" || status.fleetStatus === "abandoned";
  const agentTerminal = status.agentStatus === "complete" || status.agentStatus === "failed" || status.agentStatus === "interrupted";
  const terminal = fleetTerminal && agentTerminal;
  const taskStatus = terminal ? terminalStatus(status) : "working";
  const result = status.output === undefined && status.error === undefined && status.artifacts === undefined
    ? undefined
    : { ...(status.output !== undefined ? { text: status.output } : {}), ...(status.error !== undefined ? { error: status.error } : {}), ...(status.artifacts !== undefined ? { artifacts: status.artifacts } : {}) };
  return { task_id: taskId, fleet_id: record.fleetId, agent_id: record.agentId, status: taskStatus, scope: "process-local", result_contract: status.resultContract ?? "absent", ...(result ? { result } : {}) };
}

function terminalStatus(status: A2ATaskStatus): "completed" | "failed" | "blocked" | "refused" | "artifact_missing" {
  if (status.agentStatus === "complete" && status.resultContract === "ok") return "completed";
  if (status.resultContract === "blocked") return "blocked";
  if (status.resultContract === "refused") return "refused";
  if (status.resultContract === "artifact_missing") return "artifact_missing";
  return "failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function authorized(req: IncomingMessage, url: URL, expected: string | undefined): boolean {
  if (expected === undefined) return true;
  const provided = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? url.searchParams.get("token") ?? undefined;
  if (provided === undefined) return false;
  const expectedDigest = createHash("sha256").update(expected).digest();
  const providedDigest = createHash("sha256").update(provided).digest();
  return timingSafeEqual(expectedDigest, providedDigest);
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<{ readonly ok: true; readonly body: string } | { readonly ok: false; readonly error: string }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let timedOut = false;
  let idleTimer: NodeJS.Timeout | undefined;
  const abortRequest = () => {
    timedOut = true;
    req.resume();
    req.destroy();
  };
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(abortRequest, BODY_IDLE_TIMEOUT_MS);
  };
  const totalTimer = setTimeout(abortRequest, BODY_TOTAL_TIMEOUT_MS);
  resetIdleTimer();
  try {
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > maxBytes) {
        req.resume();
        req.destroy();
        return { ok: false, error: "request body too large" };
      }
      chunks.push(bytes);
      resetIdleTimer();
    }
  } catch {
    if (timedOut) return { ok: false, error: "request body timeout" };
    return { ok: false, error: "request body could not be read" };
  } finally {
    clearTimeout(totalTimer);
    if (idleTimer) clearTimeout(idleTimer);
  }
  if (timedOut) return { ok: false, error: "request body timeout" };
  return { ok: true, body: Buffer.concat(chunks).toString("utf8") };
}

function respond(res: ServerResponse, status: number, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(body));
}
