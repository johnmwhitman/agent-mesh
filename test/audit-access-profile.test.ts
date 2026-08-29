import assert from "node:assert/strict";
import {
  mkdirSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { requireAuditIsolationEnvironment } from "../src/audit-access-profile.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const AUDIT_TOOLS = [
  "compile_route_candidates",
  "insight_caller_breakdown",
  "ping",
  "plan_speculative_backlog",
  "recommend_route",
];
const responseText = (response: unknown): string =>
  (response as { content: Array<{ text: string }> }).content[0]!.text;

interface AuditHarness {
  dir: string;
  client: Client;
  entriesBeforeConnect: string[];
  close: () => Promise<void>;
}

async function startAuditServer(
  setup?: (dir: string) => void,
): Promise<AuditHarness> {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-audit-profile-"));
  setup?.(dir);
  const entriesBeforeConnect = readdirSync(dir);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(repoRoot, "src", "index.ts")],
    env: {
      ...(process.env as Record<string, string>),
      MESHFLEET_ACCESS_PROFILE: "audit",
      MESHFLEET_ISOLATION_ROOT: dir,
      MESHFLEET_DB_FILE: join(dir, "ledger.db"),
      MESHFLEET_DATA_FILE: join(dir, "ledger.json"),
      MESHFLEET_EVENT_LOG_FILE: join(dir, "events.jsonl"),
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "audit-profile-test", version: "1.0.0" });
  await client.connect(transport);
  return {
    dir,
    client,
    entriesBeforeConnect,
    close: async () => {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function assertAuditStartupRejected(
  changeEnv: (env: Record<string, string>, dir: string) => void,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-audit-profile-invalid-"));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MESHFLEET_ACCESS_PROFILE: "audit",
    MESHFLEET_ISOLATION_ROOT: dir,
    MESHFLEET_DB_FILE: join(dir, "ledger.db"),
    MESHFLEET_DATA_FILE: join(dir, "ledger.json"),
    MESHFLEET_EVENT_LOG_FILE: join(dir, "events.jsonl"),
    AGENT_MESH_CHILD: "1",
  };
  changeEnv(env, dir);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(repoRoot, "src", "index.ts")],
    env,
    stderr: "ignore",
  });
  const client = new Client({ name: "audit-profile-invalid-test", version: "1.0.0" });

  try {
    await assert.rejects(client.connect(transport));
  } finally {
    await client.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("audit profile advertises only source-verified pure tools", async () => {
  const harness = await startAuditServer();
  try {
    const { tools } = await harness.client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), AUDIT_TOOLS);
  } finally {
    await harness.close();
  }
});

test("audit profile rejects hidden cold-read and mutating tools even when called by exact name", async () => {
  const harness = await startAuditServer();
  try {
    const before = readdirSync(harness.dir);
    const coldRead = await harness.client.callTool({
      name: "list_fleets",
      arguments: {},
    });
    assert.equal((coldRead as { isError?: boolean }).isError, true);
    assert.equal(
      responseText(coldRead),
      JSON.stringify({ error: "Tool 'list_fleets' is unavailable in the audit access profile" }),
    );
    const mutation = await harness.client.callTool({
      name: "register_capability",
      arguments: {
        agent_id: "audit-probe-agent",
        fleet_id: "audit-probe-fleet",
        role: "auditor",
        skills: ["review"],
      },
    });
    assert.equal((mutation as { isError?: boolean }).isError, true);
    assert.equal(
      responseText(mutation),
      JSON.stringify({ error: "Tool 'register_capability' is unavailable in the audit access profile" }),
    );
    assert.deepEqual(
      readdirSync(harness.dir),
      before,
      "a denied direct call must not materialize a ledger or event log",
    );
  } finally {
    await harness.close();
  }
});

test("audit profile keeps an allowed pure tool callable without storage writes", async () => {
  const harness = await startAuditServer();
  try {
    const before = readdirSync(harness.dir);
    const response = await harness.client.callTool({ name: "ping", arguments: {} });
    assert.equal((response as { isError?: boolean }).isError, undefined);
    assert.deepEqual(readdirSync(harness.dir), before);
  } finally {
    await harness.close();
  }
});

test("audit profile refuses startup when an isolation path is undeclared", async () => {
  for (const missing of [
    "MESHFLEET_ISOLATION_ROOT",
    "MESHFLEET_DB_FILE",
    "MESHFLEET_DATA_FILE",
    "MESHFLEET_EVENT_LOG_FILE",
  ]) {
    await assertAuditStartupRejected((env) => {
      delete env[missing];
    });
  }
});

test("unknown access profiles fail closed before accepting MCP", async () => {
  for (const invalidProfile of ["", " ", "aduit", "AUDIT", "audit ", "standard"]) {
    await assertAuditStartupRejected((env) => {
      env.MESHFLEET_ACCESS_PROFILE = invalidProfile;
    });
  }
});

test("unknown access profile diagnostics do not echo untrusted environment text", () => {
  const marker = "secret-profile-marker";
  assert.throws(
    () => requireAuditIsolationEnvironment(
      { MESHFLEET_ACCESS_PROFILE: marker },
      { dbFile: "/default.db", dataFile: "/default.json", eventLogFile: "/default.events" },
    ),
    (error: unknown) => {
      assert.equal((error as Error).message, "Unknown MESHFLEET_ACCESS_PROFILE");
      assert.doesNotMatch((error as Error).message, new RegExp(marker));
      return true;
    },
  );
});

test("audit profile refuses whitespace-only and relative storage declarations", async () => {
  await assertAuditStartupRejected((env) => {
    env.MESHFLEET_DATA_FILE = " \t ";
  });
  await assertAuditStartupRejected((env) => {
    env.MESHFLEET_DB_FILE = "relative-ledger.db";
  });
});

test("audit profile rejects paths outside its canonical isolation boundary", async () => {
  await assertAuditStartupRejected((env, dir) => {
    env.MESHFLEET_DB_FILE = join(dir, "..", "escaped.db");
  });
});

test("audit profile rejects duplicate canonical storage targets", async () => {
  await assertAuditStartupRejected((env, dir) => {
    env.MESHFLEET_DATA_FILE = join(dir, "ledger.db");
  });
});

test("audit profile rejects existing hardlink aliases", async () => {
  await assertAuditStartupRejected((env, dir) => {
    const original = join(dir, "hardlink-source.db");
    writeFileSync(original, "hardlink sentinel\n");
    linkSync(original, join(dir, "ledger.db"));
    env.MESHFLEET_DB_FILE = join(dir, "ledger.db");
  });
});

test("audit profile rejects storage symlinks that escape the isolation root", async () => {
  await assertAuditStartupRejected((env, dir) => {
    const isolation = join(dir, "isolation");
    mkdirSync(isolation);
    const outside = join(dir, "outside.db");
    writeFileSync(outside, "outside sentinel\n");
    symlinkSync(outside, join(isolation, "ledger.db"));
    env.MESHFLEET_ISOLATION_ROOT = isolation;
    env.MESHFLEET_DB_FILE = join(isolation, "ledger.db");
    env.MESHFLEET_DATA_FILE = join(isolation, "ledger.json");
    env.MESHFLEET_EVENT_LOG_FILE = join(isolation, "events.jsonl");
  });
});

test("audit profile rejects a storage target symlink even when it stays inside the root", async () => {
  await assertAuditStartupRejected((env, dir) => {
    const target = join(dir, "actual-ledger.db");
    writeFileSync(target, "inside sentinel\n");
    symlinkSync(target, join(dir, "ledger.db"));
    env.MESHFLEET_DB_FILE = join(dir, "ledger.db");
  });
});

test("audit profile rejects a dangling final storage symlink", async () => {
  await assertAuditStartupRejected((env, dir) => {
    symlinkSync(join(dir, "outside-missing.db"), join(dir, "ledger.db"));
    env.MESHFLEET_DB_FILE = join(dir, "ledger.db");
  });
});

test("audit profile rejects a dangling intermediate storage symlink", async () => {
  await assertAuditStartupRejected((env, dir) => {
    symlinkSync(join(dir, "outside-missing-directory"), join(dir, "storage-alias"));
    env.MESHFLEET_DB_FILE = join(dir, "storage-alias", "ledger.db");
  });
});

test("audit profile rejects compiled default storage paths even inside the isolation root", async () => {
  for (const defaultTarget of ["db", "data", "event"] as const) {
    await assertAuditStartupRejected((env, dir) => {
      const fakeHome = join(dir, "home");
      const defaultDir = join(fakeHome, ".config", "opencode");
      mkdirSync(defaultDir, { recursive: true });
      env.HOME = fakeHome;
      env.USERPROFILE = fakeHome;
      env.MESHFLEET_ISOLATION_ROOT = fakeHome;
      env.MESHFLEET_DB_FILE = defaultTarget === "db"
        ? join(defaultDir, "agent-mesh.db")
        : join(fakeHome, "audit-ledger.db");
      env.MESHFLEET_DATA_FILE = defaultTarget === "data"
        ? join(defaultDir, "agent-mesh.json")
        : join(fakeHome, "audit-ledger.json");
      env.MESHFLEET_EVENT_LOG_FILE = defaultTarget === "event"
        ? join(defaultDir, "agent-mesh.events.log")
        : join(fakeHome, "audit-events.jsonl");
    });
  }
});

test("audit connect leaves a legacy-ledger sentinel byte-identical before any tool call", async () => {
  const sentinel = '{"schema_version":2,"fleets":{},"agents":{},"messages":{},"inboxes":{},"capabilities":{}}\n';
  const harness = await startAuditServer((dir) => {
    writeFileSync(join(dir, "ledger.json"), sentinel);
  });
  try {
    assert.deepEqual(readdirSync(harness.dir), harness.entriesBeforeConnect);
    assert.equal(readFileSync(join(harness.dir, "ledger.json"), "utf8"), sentinel);
  } finally {
    await harness.close();
  }
});

test("audit connect and every advertised tool preserve synthetic live-home sentinels", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "meshfleet-audit-live-sentinel-"));
  const fakeHome = join(fixture, "home");
  const defaultDir = join(fakeHome, ".config", "opencode");
  const isolation = join(fixture, "isolation");
  mkdirSync(defaultDir, { recursive: true });
  mkdirSync(isolation);
  const sentinels = [
    join(defaultDir, "agent-mesh.db"),
    join(defaultDir, "agent-mesh.db-wal"),
    join(defaultDir, "agent-mesh.db-shm"),
    join(defaultDir, "agent-mesh.json"),
    join(defaultDir, "agent-mesh.events.log"),
    join(defaultDir, "auth.json"),
  ];
  sentinels.forEach((file, index) => writeFileSync(file, `sentinel-${index}\n`));
  const snapshot = (): string[] => sentinels.map((file) => readFileSync(file).toString("base64"));
  const before = snapshot();
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    OPENAI_API_KEY: "provider-credential-sentinel-must-not-be-used",
    MESHFLEET_ACCESS_PROFILE: "audit",
    MESHFLEET_ISOLATION_ROOT: isolation,
    MESHFLEET_DB_FILE: join(isolation, "ledger.db"),
    MESHFLEET_DATA_FILE: join(isolation, "ledger.json"),
    MESHFLEET_EVENT_LOG_FILE: join(isolation, "events.jsonl"),
    MESHFLEET_SSE_HOST: "audit-must-not-bind.invalid",
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(repoRoot, "src", "index.ts")],
    env,
    stderr: "ignore",
  });
  const client = new Client({ name: "audit-sentinel-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    assert.deepEqual(snapshot(), before, "connect must not touch synthetic live storage or credentials");
    assert.deepEqual(readdirSync(isolation), []);

    const calls = [
      { name: "ping", arguments: {} },
      {
        name: "compile_route_candidates",
        arguments: {
          manifest: {
            version: "meshfleet.route-candidates.v0.1",
            candidates: [{
              candidate_id: "offline-a",
              capabilities: ["code"],
              privacy: "local_only",
              locality: "same_host",
            }],
          },
        },
      },
      {
        name: "recommend_route",
        arguments: {
          task: { required_capabilities: ["code"], privacy: "local_only", locality: "same_host" },
          candidates: [{
            candidate_id: "offline-a",
            capabilities: ["code"],
            privacy: "local_only",
            locality: "same_host",
            budget: { measured: false },
          }],
        },
      },
      {
        name: "plan_speculative_backlog",
        arguments: {
          version: "meshfleet.speculative-backlog.v0.1",
          candidates: [{
            candidate_id: "offline-a",
            capabilities: ["code"],
            privacy: "local_only",
            locality: "same_host",
            budget: { measured: false },
            quality_tags: ["reviewed"],
          }],
          tasks: [{
            task_id: "audit-only-task",
            kind: "code_review",
            priority: 50,
            speculative_approval: { state: "approved", approval_ref: "fixture-only" },
            route: { required_capabilities: ["code"], privacy: "local_only", locality: "same_host" },
            required_quality_tags: ["reviewed"],
          }],
        },
      },
    ];

    for (const call of calls) {
      const response = await client.callTool(call);
      assert.equal((response as { isError?: boolean }).isError, undefined, call.name);
      assert.deepEqual(snapshot(), before, `${call.name} must preserve synthetic live sentinels`);
      assert.deepEqual(readdirSync(isolation), [], `${call.name} must not materialize audit storage`);
    }
  } finally {
    await client.close().catch(() => undefined);
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("standard profile retains its isolated storage mutation surface", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-standard-profile-control-"));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MESHFLEET_DB_FILE: join(dir, "ledger.db"),
    MESHFLEET_DATA_FILE: join(dir, "ledger.json"),
    MESHFLEET_EVENT_LOG_FILE: join(dir, "events.jsonl"),
    AGENT_MESH_CHILD: "1",
  };
  delete env.MESHFLEET_ACCESS_PROFILE;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(repoRoot, "src", "index.ts")],
    env,
    stderr: "ignore",
  });
  const client = new Client({ name: "standard-profile-control", version: "1.0.0" });
  try {
    await client.connect(transport);
    const response = await client.callTool({
      name: "register_capability",
      arguments: {
        agent_id: "standard-control-agent",
        fleet_id: "standard-control-fleet",
        role: "auditor",
        skills: ["review"],
      },
    });
    assert.equal((response as { isError?: boolean }).isError, undefined);
    assert.ok(readdirSync(dir).length > 0, "standard profile control must write only its temp ledger");
  } finally {
    await client.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});
