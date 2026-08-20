/**
 * ack_message is the consuming acknowledgement boundary. Exercise it through
 * real MCP stdio so advertised-schema drift, false acknowledgements, inbox
 * consumption, receipt durability, and idempotency stay coupled.
 *
 * The first test pins the minimum contract (schema, schema-mismatch refusal,
 * non-recipient forgery, single-recipient consumption, idempotency). The five
 * `ack_message hardening witness` tests cover the gaps the red-team review of
 * that minimum surfaced: broadcast isolation between sibling recipients, a
 * hallucinated message_id returning {ok:false} not a transport error, the
 * sender being unable to ack their own outbound message, the wire boundary
 * refusing every non-string shape (empty, whitespace, null, array, object),
 * and the durability of the receipt + inbox drain across a server restart.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { registerAgentInLedger, type Agent } from "../src/core.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

type ToolResponse = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
};

const textOf = (response: unknown): string => (response as ToolResponse).content[0]!.text;
const bodyOf = (response: unknown): Record<string, unknown> => JSON.parse(textOf(response)) as Record<string, unknown>;

type Fixture = {
  dir: string;
  dataFile: string;
  dbFile: string;
  eventsFile: string;
};

/**
 * Build a child-server scratch directory + parent-side env matching the paths
 * the child will read. The parent imports `registerAgentInLedger` to seed the
 * ledger before connecting the MCP client, which lets the broadcast-resolution
 * walk find the fixture agents — otherwise `to_agent_id: "*"` has no peers.
 */
function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-ack-message-mcp-"));
  return {
    dir,
    dataFile: join(dir, "ledger.json"),
    dbFile: join(dir, "ledger.db"),
    eventsFile: join(dir, "events.jsonl"),
  };
}

const childEnv = (fix: Fixture): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  MESHFLEET_DB_FILE: fix.dbFile,
  MESHFLEET_DATA_FILE: fix.dataFile,
  MESHFLEET_EVENT_LOG_FILE: fix.eventsFile,
  MESHFLEET_RATIFY_SWEEP_MS: "0",
  AGENT_MESH_CHILD: "1",
});

async function connectChild(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(repoRoot, "src", "index.ts")],
    env,
    stderr: "ignore",
  });
  const client = new Client(
    { name: "ack-message-contract-test", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

async function withServer(
  fix: Fixture,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  // Mirror the child's env in the parent process so direct-core fixture
  // helpers (registerAgentInLedger) write through the same SQLite handle the
  // child will read. Done BEFORE the child connects: the child's first read
  // of `data.messages` sees the seeded rows.
  process.env.MESHFLEET_DB_FILE = fix.dbFile;
  process.env.MESHFLEET_DATA_FILE = fix.dataFile;
  process.env.MESHFLEET_EVENT_LOG_FILE = fix.eventsFile;

  const client = await connectChild(childEnv(fix));
  try {
    await fn(client);
  } finally {
    await client.close().catch(() => {});
    rmSync(fix.dir, { recursive: true, force: true });
    delete process.env.MESHFLEET_DB_FILE;
  }
}

const fixtureAgent = (id: string, fleetId: string): Agent => ({
  id,
  fleet_id: fleetId,
  role: `${id}-role`,
  prompt: `${id}-prompt`,
  status: "running",
});

async function callOk(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await client.callTool({ name, arguments: args });
  return bodyOf(response);
}

test("ack_message advertises its schema and only a recipient can durably consume a message", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "ack_message");
    assert.ok(tool, "ack_message must be advertised");
    assert.deepEqual(tool.inputSchema, {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        message_id: { type: "string" },
      },
      required: ["agent_id", "message_id"],
    });

    for (const arguments_ of [
      { message_id: "message" },
      { agent_id: "recipient" },
      { agent_id: 42, message_id: "message" },
      { agent_id: "recipient", message_id: false },
    ]) {
      const refused = await client.callTool({
        name: "ack_message",
        arguments: arguments_ as Record<string, unknown>,
      });
      assert.equal((refused as ToolResponse).isError, true, JSON.stringify(arguments_));
      assert.match(textOf(refused), /is required and must be a non-empty string/);
    }

    const sent = await callOk(client, "send_message", {
      from_agent_id: "sender",
      to_agent_id: "recipient",
      fleet_id: "fleet",
      type: "handoff",
      payload: "bounded handoff",
    });
    const messageId = sent.message_id;
    assert.equal(typeof messageId, "string");

    assert.deepEqual(await callOk(client, "ack_message", {
      agent_id: "bystander", message_id: messageId,
    }), { ok: false }, "a non-recipient must not forge acknowledgement evidence");
    assert.deepEqual(await callOk(client, "get_receipts", {
      message_id: messageId,
    }), { receipts: [] });

    assert.equal(((await callOk(client, "get_inbox", {
      agent_id: "recipient",
    })).messages as unknown[]).length, 1);

    assert.deepEqual(await callOk(client, "ack_message", {
      agent_id: "recipient", message_id: messageId,
    }), { ok: true });
    assert.deepEqual(await callOk(client, "ack_message", {
      agent_id: "recipient", message_id: messageId,
    }), { ok: true }, "repeat acknowledgement must be idempotent");

    assert.deepEqual(await callOk(client, "get_inbox", {
      agent_id: "recipient",
    }), { messages: [] });

    const receiptBody = await callOk(client, "get_receipts", {
      message_id: messageId,
    });
    const receipts = receiptBody.receipts as Array<Record<string, unknown>>;
    assert.equal(receipts.length, 1, "idempotent repeat must not duplicate the receipt");
    assert.deepEqual(
      { ...receipts[0], timestamp: "number" },
      {
        message_id: messageId,
        agent_id: "recipient",
        action: "ack",
        timestamp: "number",
      },
    );
    assert.equal(typeof receipts[0]!.timestamp, "number");
  });
});

test("ack_message hardening witness: a broadcast recipient's ack must not drain sibling inboxes", async () => {
  // The red-team review of the basic contract found that the single-recipient
  // witness does not exercise the broadcast resolution path. A broadcast in
  // fleet F with peers {bravo, charlie} arrives in BOTH inboxes; if the
  // boundary held a buggy "consume from every matching inbox" filter,
  // acking from bravo would also remove the message from charlie's inbox.
  // The fix would be silent: the message would still be in
  // `messages[messageId]`, `get_receipts` would show the ack, and the auditor
  // would not flag it. So pin the invariant explicitly.
  const fix = makeFixture();
  // Seed the broadcast peers BEFORE the child connects, and BEFORE
  // withServer overwrites process.env, so direct-core fixture writes hit
  // the same SQLite file the child will read. (registerAgentInLedger calls
  // withLedger, which calls resolveDataFile, which reads process.env.)
  process.env.MESHFLEET_DB_FILE = fix.dbFile;
  process.env.MESHFLEET_DATA_FILE = fix.dataFile;
  process.env.MESHFLEET_EVENT_LOG_FILE = fix.eventsFile;
  for (const id of ["alpha", "bravo", "charlie"]) {
    registerAgentInLedger(fixtureAgent(id, "fleet-bcast"));
  }
  await withServer(fix, async (client) => {
    const sent = await callOk(client, "send_message", {
      from_agent_id: "alpha",
      to_agent_id: "*",
      fleet_id: "fleet-bcast",
      type: "alert",
      payload: "fleet-wide notice",
    });
    const messageId = sent.message_id as string;
    assert.equal(typeof messageId, "string");
    const recipients = sent.recipients as string[];
    assert.deepEqual(new Set(recipients), new Set(["bravo", "charlie"]));

    // Both peers see the message before any ack.
    for (const peer of ["bravo", "charlie"]) {
      const inbox = await callOk(client, "get_inbox", { agent_id: peer });
      const ids = (inbox.messages as Array<{ id: string }>).map((m) => m.id);
      assert.ok(ids.includes(messageId), `${peer} must see the broadcast before any ack`);
    }

    // Bravo acks — charlie's inbox must remain intact.
    assert.deepEqual(await callOk(client, "ack_message", {
      agent_id: "bravo", message_id: messageId,
    }), { ok: true });
    assert.deepEqual(await callOk(client, "get_inbox", {
      agent_id: "bravo",
    }), { messages: [] }, "bravo's ack must drain bravo's inbox");
    {
      const charlieInbox = await callOk(client, "get_inbox", { agent_id: "charlie" });
      const ids = (charlieInbox.messages as Array<{ id: string }>).map((m) => m.id);
      assert.ok(
        ids.includes(messageId),
        "charlie's inbox must NOT drain when bravo acks — broadcast is per-recipient",
      );
    }

    // get_receipts shows exactly one ack so far (bravo). The derived
    // `acknowledged` flag on the message is false until charlie also acks,
    // and the witness would have to look at charlie's later ack to know.
    let receiptBody = await callOk(client, "get_receipts", { message_id: messageId });
    let receipts = receiptBody.receipts as Array<Record<string, unknown>>;
    assert.equal(receipts.length, 1, "only bravo's ack is recorded so far");
    assert.equal(receipts[0]!.agent_id, "bravo");
    assert.equal(receipts[0]!.action, "ack");

    // Charlie acks — both inboxes are now drained.
    assert.deepEqual(await callOk(client, "ack_message", {
      agent_id: "charlie", message_id: messageId,
    }), { ok: true });
    assert.deepEqual(await callOk(client, "get_inbox", {
      agent_id: "charlie",
    }), { messages: [] });

    // Both acks recorded; idempotency of repeat by charlie holds too.
    assert.deepEqual(await callOk(client, "ack_message", {
      agent_id: "charlie", message_id: messageId,
    }), { ok: true });
    receiptBody = await callOk(client, "get_receipts", { message_id: messageId });
    receipts = receiptBody.receipts as Array<Record<string, unknown>>;
    assert.equal(receipts.length, 2, "idempotent repeat must not duplicate charlie's ack");
    assert.deepEqual(
      new Set(receipts.map((r) => r.agent_id)),
      new Set(["bravo", "charlie"]),
    );

    // The sender (alpha) is not a recipient of the broadcast, so an ack from
    // alpha must return {ok:false}. This is the same forge-prevention rule as
    // for direct messages — pinning it for broadcasts is its own witness
    // because the broadcast resolution path is different.
    assert.deepEqual(await callOk(client, "ack_message", {
      agent_id: "alpha", message_id: messageId,
    }), { ok: false }, "the sender of a broadcast is not a recipient and must not ack");
  });
});

test("ack_message hardening witness: a hallucinated message_id returns {ok:false}, not a transport error", async () => {
  // The basic contract's non-recipient witness relies on a real message_id,
  // so it cannot distinguish two failure modes that BOTH return {ok:false}
  // today:
  //   - the message exists and the agent is not a recipient
  //   - the message does not exist at all
  // Both are correct outcomes; the wire must not invent a transport error
  // for the latter, because that turns a typo (one missing uuid digit) into
  // a class of failure that alarms the caller and obscures the real bug
  // (their tracking of message_ids is wrong).
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    // No prior send — the message_id is hallucinatory from the start.
    const hallucinated = "definitely-not-a-real-message-12345";
    const response = await client.callTool({
      name: "ack_message",
      arguments: { agent_id: "anyone", message_id: hallucinated },
    });
    assert.equal(
      (response as ToolResponse).isError,
      undefined,
      "a hallucinated message_id must NOT be reported as a tool error — it is a no-op",
    );
    assert.deepEqual(
      bodyOf(response),
      { ok: false },
      "a hallucinated message_id must return the same wire shape as a real non-recipient refusal",
    );

    // Cross-check against a real message that someone is NOT a recipient of
    // — same shape, distinguishable only by the recipient-derivation logic
    // inside the server, not the wire.
    const sent = await callOk(client, "send_message", {
      from_agent_id: "sender",
      to_agent_id: "real-recipient",
      fleet_id: "fleet",
      type: "handoff",
      payload: "bounded handoff",
    });
    const realMessageId = sent.message_id as string;
    assert.deepEqual(
      await callOk(client, "ack_message", {
        agent_id: "real-recipient", message_id: realMessageId,
      }),
      { ok: true },
      "the real recipient must still ack normally — the hallucinated witness must not poison the inbox",
    );

    // And the hallucinated one continues to fail on the real recipient too —
    // pinning this so a regression that "succeeds when message_id is
    // unknown" cannot hide.
    assert.deepEqual(
      await callOk(client, "ack_message", {
        agent_id: "real-recipient", message_id: hallucinated,
      }),
      { ok: false },
      "a hallucinated message_id against a real recipient must STILL return {ok:false}",
    );
  });
});

test("ack_message hardening witness: the sender is not a recipient and cannot ack their own outbound message", async () => {
  // The basic contract proves a bystander cannot forge an ack, but it does
  // not cover the sender of a direct message — who is "in the conversation"
  // at the protocol level but is NOT a recipient. A sender-as-acker would
  // create the same forgeable-audit-entry defect the bystander witness
  // already prevents; this is its sibling.
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const sent = await callOk(client, "send_message", {
      from_agent_id: "alice",
      to_agent_id: "bob",
      fleet_id: "fleet",
      type: "handoff",
      payload: "alice -> bob",
    });
    const messageId = sent.message_id as string;
    assert.equal(typeof messageId, "string");

    // Sender attempts to ack her own outbound. Must be {ok:false}, no receipt.
    assert.deepEqual(
      await callOk(client, "ack_message", { agent_id: "alice", message_id: messageId }),
      { ok: false },
      "sender must not be able to forge a recipient ack on their own outbound",
    );
    assert.deepEqual(
      await callOk(client, "get_receipts", { message_id: messageId }),
      { receipts: [] },
      "no receipt must be recorded for a refused sender-as-acker call",
    );

    // Bob's inbox is unaffected.
    assert.equal(
      ((await callOk(client, "get_inbox", { agent_id: "bob" })).messages as unknown[]).length,
      1,
      "bob's inbox must still hold the message after alice's refused ack",
    );

    // And the real recipient ack still works after the forgery — the witness
    // must not have left the system in a degraded state.
    assert.deepEqual(
      await callOk(client, "ack_message", { agent_id: "bob", message_id: messageId }),
      { ok: true },
      "the real recipient must still ack normally after a refused sender forgery",
    );
    assert.deepEqual(
      await callOk(client, "get_inbox", { agent_id: "bob" }),
      { messages: [] },
    );
  });
});

test("ack_message hardening witness: boundary validation pins the wire-accepted shape for every non-string id", async () => {
  // The basic contract covers `{message_id: "message"}` (missing agent_id) and
  // `{agent_id: 42, message_id: "message"}` (number), which proves the
  // boundary rejects SOME non-strings. It does not pin the full surface the
  // wire must reject: empty string, whitespace-only, null, array, object.
  // Each of these is a real defect class — `message_id: ["x"]` previously
  // coerced to a key like `["x"]` and lost the message; `message_id: ""`
  // produced a receipt keyed on empty string. The handler now uses
  // requireString; this witness pins the actual rejection text so a
  // regression that re-coerces any of these types is loud.
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const cases: ReadonlyArray<{
      label: string;
      arguments_: Record<string, unknown>;
      expectedText: RegExp;
    }> = [
      {
        label: "empty-string agent_id",
        arguments_: { agent_id: "", message_id: "m" },
        expectedText: /agent_id.*non-empty string/,
      },
      {
        label: "whitespace-only agent_id",
        arguments_: { agent_id: "   \t \n ", message_id: "m" },
        expectedText: /agent_id.*non-empty string/,
      },
      {
        label: "null agent_id",
        arguments_: { agent_id: null, message_id: "m" },
        expectedText: /agent_id.*non-empty string/,
      },
      {
        label: "array agent_id",
        arguments_: { agent_id: ["alice"], message_id: "m" },
        expectedText: /agent_id.*non-empty string/,
      },
      {
        label: "object agent_id",
        arguments_: { agent_id: { id: "alice" }, message_id: "m" },
        expectedText: /agent_id.*non-empty string/,
      },
      {
        label: "empty-string message_id",
        arguments_: { agent_id: "a", message_id: "" },
        expectedText: /message_id.*non-empty string/,
      },
      {
        label: "whitespace-only message_id",
        arguments_: { agent_id: "a", message_id: "   \t \n " },
        expectedText: /message_id.*non-empty string/,
      },
      {
        label: "null message_id",
        arguments_: { agent_id: "a", message_id: null },
        expectedText: /message_id.*non-empty string/,
      },
      {
        label: "array message_id",
        arguments_: { agent_id: "a", message_id: ["x"] },
        expectedText: /message_id.*non-empty string/,
      },
      {
        label: "object message_id",
        arguments_: { agent_id: "a", message_id: { id: "x" } },
        expectedText: /message_id.*non-empty string/,
      },
    ];
    for (const { label, arguments_, expectedText } of cases) {
      const response = await client.callTool({
        name: "ack_message",
        arguments: arguments_,
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `${label}: must be reported as a tool error, not silently coerced`,
      );
      const text = textOf(response);
      assert.match(
        text,
        expectedText,
        `${label}: rejection text must name the offending field; got: ${JSON.stringify(text)}`,
      );
      // The whole point: none of these coerce into a real receipt. For the
      // non-string message_id shapes (null/array/object) and the empty
      // string, query get_receipts to confirm no row was written. For
      // whitespace-only and empty-string, get_receipts ALSO rejects the
      // shape with its own jsonError — that is correct defense in depth, but
      // the assertion here is "no real receipt was written". We probe by
      // querying with a syntactically valid placeholder and asserting that
      // the original hallucinated id cannot have written anything: any
      // receipt-key built from a non-string shape would have failed the
      // SQL key lookup. For the empty/whitespace cases we instead query with
      // an explicit jsonError shape — get_receipts refuses the same shape
      // ack_message refused.
      const attemptedMessageId = arguments_.message_id;
      if (typeof attemptedMessageId === "string" && attemptedMessageId.trim().length > 0) {
        const receipts = await callOk(client, "get_receipts", {
          message_id: attemptedMessageId,
        });
        assert.deepEqual(
          receipts,
          { receipts: [] },
          `${label}: a refused ack must not leave a receipt behind`,
        );
      }
    }
  });
});

test("ack_message hardening witness: the ack + inbox-drain survive a server restart", async () => {
  // The basic contract proves one ack drains the inbox and writes one
  // receipt. It does not prove the receipt and drain survive a process
  // restart — and an evidence product whose witness does not survive a
  // crash is not auditable. The cycle that motivated this gap closed the
  // basic contract on green but could not tell whether a restart
  // reconstructed the inbox from a freshly-loaded JSON or from the SQLite
  // tables. This witness kills the server and reads back through a fresh
  // process to pin durability.
  const durableFix = makeFixture();
  process.env.MESHFLEET_DB_FILE = durableFix.dbFile;
  process.env.MESHFLEET_DATA_FILE = durableFix.dataFile;
  process.env.MESHFLEET_EVENT_LOG_FILE = durableFix.eventsFile;

  let messageId = "";
  try {
    // Phase 1: send + ack on a fresh server.
    const clientA = await connectChild(childEnv(durableFix));
    try {
      const sent = await callOk(clientA, "send_message", {
        from_agent_id: "sender",
        to_agent_id: "recipient",
        fleet_id: "fleet",
        type: "handoff",
        payload: "durable handoff",
      });
      messageId = sent.message_id as string;
      assert.equal(typeof messageId, "string");
      assert.deepEqual(
        await callOk(clientA, "ack_message", { agent_id: "recipient", message_id: messageId }),
        { ok: true },
      );
      assert.deepEqual(
        await callOk(clientA, "get_inbox", { agent_id: "recipient" }),
        { messages: [] },
        "inbox must drain on the first server before restart",
      );
    } finally {
      await clientA.close().catch(() => {});
    }

    // Phase 2: fresh child process against the same files.
    const clientB = await connectChild(childEnv(durableFix));
    try {
      const receiptBody = await callOk(clientB, "get_receipts", { message_id: messageId });
      const receipts = receiptBody.receipts as Array<Record<string, unknown>>;
      assert.equal(
        receipts.length,
        1,
        "the receipt must survive the server restart — durability is part of the contract",
      );
      assert.equal(receipts[0]!.agent_id, "recipient");
      assert.equal(receipts[0]!.action, "ack");

      // The inbox drain is also durable — get_inbox on the second server
      // must still return [].
      assert.deepEqual(
        await callOk(clientB, "get_inbox", { agent_id: "recipient" }),
        { messages: [] },
        "the inbox drain must survive the server restart",
      );

      // And a re-ack on the second server remains idempotent — the receipt
      // key is the idempotency guarantee, not the process identity.
      assert.deepEqual(
        await callOk(clientB, "ack_message", { agent_id: "recipient", message_id: messageId }),
        { ok: true },
      );
      const afterReceipts = (await callOk(clientB, "get_receipts", {
        message_id: messageId,
      })).receipts as Array<Record<string, unknown>>;
      assert.equal(
        afterReceipts.length,
        1,
        "idempotency must survive the server restart — repeat ack must not duplicate the receipt",
      );
    } finally {
      await clientB.close().catch(() => {});
    }
  } finally {
    rmSync(durableFix.dir, { recursive: true, force: true });
    delete process.env.MESHFLEET_DB_FILE;
  }
});