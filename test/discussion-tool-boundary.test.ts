/**
 * The four Discussions tools must validate their own published contract.
 *
 * They shipped doing `args as XParams` — the same blind cast that made
 * `register_capability` discard its ids for a month. The MCP SDK enforces
 * neither `required` nor `type`, and `toolHandlers` is typed `(args: any)`, so
 * a cast is not a check.
 *
 * Found by driving the real server over stdio with the PUBLISHED field names,
 * violated. Two of the observations are serious:
 *
 *   - `ask_peer` with `wake_peer: "false"` responded `wake_reserved: true`.
 *     `wake_peer` is the explicit, budgeted authority to RUN an agent, in a lane
 *     whose non-negotiable law is that nothing starts a process implicitly. Any
 *     client that stringifies its booleans got a peer launched after explicitly
 *     declining one. This is the cast_vote defect on the switch where it matters
 *     most.
 *
 *   - `ask_peer` with `payload` omitted returned a normal-looking result and
 *     WROTE a discussion whose derived status is `invalid` — empty fleet_id,
 *     participants `["",""]`, max_turns 0. `verify_ledger`'s
 *     `discussion.derive_invalid` then reports that row as an error, so the
 *     writer was manufacturing precisely what the auditor exists to catch.
 *
 * The refusal must happen BEFORE any write, so the strongest assertions here are
 * the ones counting rows afterwards.
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

interface Ctx {
  client: Client;
  /** Count rows in a ledger table — proves a refusal wrote nothing. */
  count: (table: string) => number;
}

async function withServer(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-disc-boundary-"));
  const dbFile = join(dir, "l.db");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(repoRoot, "src", "index.ts")],
    env: {
      ...(process.env as Record<string, string>),
      // BOTH paths — declaring only the db lets the migrator consume the real ledger.
      MESHFLEET_DB_FILE: dbFile,
      MESHFLEET_DATA_FILE: join(dir, "l.json"),
      MESHFLEET_RATIFY_SWEEP_MS: "0",
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "disc-boundary", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    // Seed two real participants directly, so ask_peer has a valid fleet without
    // spawning any process.
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

    const count = (table: string): number => {
      const d = new Database(dbFile, { readonly: true });
      try {
        return (d.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      } finally {
        d.close();
      }
    };
    await fn({ client, count });
  } finally {
    await client.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

const textOf = (r: unknown): string => (r as { content: { text: string }[] }).content[0]!.text;

/** A valid ask_peer call; individual tests override one field to violate it. */
const ASK = {
  from_agent_id: "A",
  to_agent_id: "B",
  fleet_id: "F",
  payload: "q",
  max_turns: 2,
  timeout_ms: 1000,
  turn_timeout_ms: 1000,
  wake_peer: false,
};

test("ask_peer refuses a non-boolean wake_peer instead of launching an agent", async () => {
  await withServer(async ({ client, count }) => {
    const before = count("messages");
    for (const wake_peer of ["false", "true", 0, 1, null]) {
      const res = await client.callTool({
        name: "ask_peer",
        arguments: { ...ASK, wake_peer } as Record<string, unknown>,
      });
      assert.match(
        textOf(res),
        /must be a boolean/,
        `wake_peer=${JSON.stringify(wake_peer)} must be refused — measured over stdio, ` +
          `the string "false" came back wake_reserved:true, launching a peer the caller declined`
      );
    }
    assert.equal(
      count("messages"),
      before,
      "a refused ask_peer must write NOTHING — the wake is authority to run an agent, " +
        "so a rejected call that still opened a discussion would be the same defect twice"
    );
  });
});

test("ask_peer refuses an omitted wake_peer rather than defaulting to no-wake", async () => {
  await withServer(async ({ client }) => {
    const args = { ...ASK } as Record<string, unknown>;
    delete args.wake_peer;
    const res = await client.callTool({ name: "ask_peer", arguments: args });
    // Falsy-by-omission happens to fail SAFE here, which is exactly why it
    // survived: a silently-accepted contract violation is invisible until the
    // day the default is the dangerous direction.
    assert.match(textOf(res), /'wake_peer' is required/);
  });
});

test("ask_peer refuses a missing payload instead of writing an invalid discussion", async () => {
  await withServer(async ({ client, count }) => {
    const before = count("messages");
    const args = { ...ASK } as Record<string, unknown>;
    delete args.payload;
    const res = await client.callTool({ name: "ask_peer", arguments: args });
    assert.match(textOf(res), /'payload' is required/);
    assert.doesNotMatch(
      textOf(res),
      /discussion_id/,
      "the old behaviour returned a normal-looking result carrying a real discussion_id"
    );
    assert.equal(
      count("messages"),
      before,
      "this wrote a discussion deriving to status 'invalid' (empty fleet_id, " +
        "participants ['',''], max_turns 0) — a row verify_ledger reports as an error"
    );
  });
});

test("ask_peer refuses non-numeric bounds fields", async () => {
  await withServer(async ({ client }) => {
    for (const field of ["max_turns", "timeout_ms", "turn_timeout_ms"]) {
      const res = await client.callTool({
        name: "ask_peer",
        arguments: { ...ASK, [field]: "2" } as Record<string, unknown>,
      });
      assert.match(textOf(res), new RegExp(`'${field}'`), `${field} given as a string must be refused`);
    }
  });
});

test("ask_peer still opens a discussion when the contract is honoured", async () => {
  await withServer(async ({ client }) => {
    // The guard must refuse violations without breaking the happy path — a
    // validator that rejects everything passes every negative test.
    const res = await client.callTool({
      name: "ask_peer",
      arguments: { ...ASK, wake_peer: false } as Record<string, unknown>,
    });
    const out = textOf(res);
    assert.match(out, /"discussion_id"/, `a valid call must still work; got: ${out.slice(0, 200)}`);
    assert.match(out, /"wake_reserved":\s*false/, "an explicit false must reserve no wake");
  });
});

test("wake_agent refuses missing compare-and-swap identity fields", async () => {
  await withServer(async ({ client }) => {
    const full = { agent_id: "A", discussion_id: "d", expected_head_message_id: "m" };
    for (const field of ["agent_id", "discussion_id", "expected_head_message_id"]) {
      const args = { ...full } as Record<string, unknown>;
      delete args[field];
      const res = await client.callTool({ name: "wake_agent", arguments: args });
      assert.match(
        textOf(res),
        new RegExp(`'${field}' is required`),
        `${field} omitted must name the contract violation, not fall through to a not_found ` +
          `that reads like a genuine miss`
      );
    }
  });
});

test("reply_discussion refuses an off-enum type and a non-boolean close", async () => {
  await withServer(async ({ client }) => {
    const full = {
      agent_id: "B",
      discussion_id: "d",
      attempt_id: "at",
      reply_to_message_id: "m",
      type: "result",
      payload: "x",
    };

    const badType = await client.callTool({
      name: "reply_discussion",
      arguments: { ...full, type: "alert" } as Record<string, unknown>,
    });
    assert.match(textOf(badType), /must be exactly one of question \| result/);

    // `close` was read as `params.close ?? false` — the nullish coalesce guards
    // absence but never type, so "false" is truthy and makes the conversation
    // TERMINAL. Terminal is not a state you get to take back.
    for (const close of ["false", "true", 1]) {
      const res = await client.callTool({
        name: "reply_discussion",
        arguments: { ...full, close } as Record<string, unknown>,
      });
      assert.match(
        textOf(res),
        /'close' must be a boolean/,
        `close=${JSON.stringify(close)} must be refused — "false" would close the discussion`
      );
    }
  });
});

test("get_discussion refuses a missing id and a non-boolean include_receipts", async () => {
  await withServer(async ({ client }) => {
    const missing = await client.callTool({ name: "get_discussion", arguments: {} });
    assert.match(textOf(missing), /'discussion_id' is required/);
    assert.doesNotMatch(
      textOf(missing),
      /not_found/,
      "a malformed call must not be reported as a genuine miss"
    );

    // This one fails SAFE today (`=== false` over-includes on a string), and is
    // validated anyway: safe by accident is not a contract.
    const badFlag = await client.callTool({
      name: "get_discussion",
      arguments: { discussion_id: "d", include_receipts: "false" },
    });
    assert.match(textOf(badFlag), /'include_receipts' must be a boolean/);
  });
});
