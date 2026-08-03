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

/**
 * The test above is the ONLY place in `test/` that named `include_receipts`
 * before this one, and it passes the string `"false"` to assert a type refusal.
 * So across 47 `get_discussion` call sites, nothing ever set the boolean and
 * watched receipts disappear — measured by exhaustive grep, and then proven:
 * deleting the whole `include_receipts === false` branch from
 * `src/discussion-store.ts` left typecheck, build and the entire suite GREEN
 * (1359/1359 on a8ec462).
 *
 * A published, documented parameter with a real behaviour branch and no test is
 * a contract nobody is holding. `additionalProperties: false` on the schema
 * means naming the field is the only way to reach it, so the grep is exhaustive
 * here — do not generalise that shortcut to behaviour reachable indirectly.
 */
test("get_discussion honours include_receipts, and changes nothing else", async () => {
  await withServer(async ({ client }) => {
    // `wake_peer: true` RESERVES turn 2 — it does not launch anything
    // (`openDiscussion` writes a receipt and calls `notify`, which is SSE only).
    // The reservation is what makes `attempts` non-empty, and without it the
    // "nothing else moves" assertion below is vacuous for that field: measured,
    // by mutating the branch to also blank `attempts` and watching this test
    // still PASS on the `wake_peer: false` fixture.
    const ask = await client.callTool({ name: "ask_peer", arguments: { ...ASK, wake_peer: true } });
    const discussion_id = (JSON.parse(textOf(ask)) as { discussion_id: string }).discussion_id;

    interface View {
      attempts: unknown[];
      policy: { conversation_deadline: number };
      transcript: { receipts: { action: string }[] }[];
    }
    const get = async (args: Record<string, unknown>): Promise<View> =>
      JSON.parse(
        textOf(await client.callTool({ name: "get_discussion", arguments: { discussion_id, ...args } }))
      ) as View;

    // Settle the clock before comparing anything. The derived view depends on
    // `now`, and the FIRST read past the conversation deadline terminalizes the
    // stranded attempt — measured on this fixture: receipts 3 -> 4, status
    // `exhausted` -> `expired`, attempt `started` -> `failed`. Every read after
    // that is byte-identical. Comparing views across that one-time transition is
    // a race, so cross the deadline and then discard exactly one read.
    // (`ask_peer` returns right AT the deadline, so an earlier draft that simply
    // read three times in a row passed 5 runs and was still racing.)
    const deadline = (await get({})).policy.conversation_deadline;
    await new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now()) + 150));
    await get({});

    // `ask_peer` writes both of these on the root message it creates
    // (`turn.sent` at discussion-store.ts:797, `wake.reserved` at :802), so the
    // default view has something to lose. A test whose "before" was already
    // empty would pass against a store that never attaches receipts at all.
    const omitted = await get({});
    assert.equal(omitted.transcript.length, 1);
    const actions = omitted.transcript[0]!.receipts.map((r) => r.action.split(":")[0]);
    for (const expected of ["discussion.turn.sent.v1", "discussion.wake.reserved.v1"]) {
      assert.ok(
        actions.includes(expected),
        `omitting the flag must include lifecycle receipts (missing ${expected}) — ` +
          "the published description says it defaults to true"
      );
    }
    // Subset, not equality: the terminal receipt is `started` or `deadman`
    // depending on where the deadline falls, and pinning it would be a flake.
    assert.ok(omitted.attempts.length > 0, "fixture guard: the checks below cannot see `attempts` if it is empty");

    const explicitTrue = await get({ include_receipts: true });
    assert.deepEqual(explicitTrue, omitted, "include_receipts:true must equal the documented default");

    const off = await get({ include_receipts: false });

    // Key-presence is checked BEFORE emptiness on purpose. A missing key also
    // fails the deepEqual below, so ordered the other way this assertion could
    // never be the one that fires and would be decoration.
    assert.ok(
      Object.prototype.hasOwnProperty.call(off.transcript[0]!, "receipts"),
      "the flag suppresses receipt CONTENT, not the receipts key itself — a client " +
        "reading `entry.receipts.length` must not crash on a dropped field"
    );
    assert.deepEqual(off.transcript[0]!.receipts, [], "include_receipts:false must empty the transcript's receipts");

    // Nothing but receipts may move. Without this, narrowing `include_receipts`
    // into a filter that also dropped attempts, status or budget would pass.
    const stripped = (v: View): unknown =>
      JSON.parse(JSON.stringify({ ...v, transcript: v.transcript.map((e) => ({ ...e, receipts: null })) }));
    assert.deepEqual(
      stripped(off),
      stripped(omitted),
      "include_receipts must change receipts and NOTHING else in the derived view"
    );
  });
});
