import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import { readOpenCodeSessionEvidence } from "../src/runtime/opencode-evidence.js";
import { parseOpenCodeEvents } from "../src/runtime/opencode-events.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "mf-runtime-opencode-ev-"));
}

interface MessageRowInput {
  role?: string;
  modelID?: string | null;
  providerID?: string | null;
  rawJson?: string;
  rawRecord?: Record<string, unknown>;
}

interface SessionRowInput {
  id?: string;
  model?: Record<string, unknown> | string | null;
  agent?: string;
}

/** Build a synthetic opencode-shaped SQLite database. */
function createSyntheticDb(
  root: string,
  messages: MessageRowInput[],
  sessionId = "ses_test0000000000000000001",
  sessionOverride?: SessionRowInput,
): string {
  const dbDir = join(root, "opencode");
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, "opencode.db");
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE session (
      id text PRIMARY KEY,
      model text,
      agent text,
      time_created integer NOT NULL,
      time_updated integer NOT NULL
    );
    CREATE TABLE message (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    );
  `);

  const effectiveSessionId = sessionOverride?.id ?? sessionId;
  let sessionModelText: string | null = null;
  if (sessionOverride?.model !== undefined) {
    sessionModelText =
      typeof sessionOverride.model === "string"
        ? sessionOverride.model
        : sessionOverride.model === null
          ? null
          : JSON.stringify(sessionOverride.model);
  }

  db.prepare(
    "INSERT INTO session (id, model, agent, time_created, time_updated) VALUES (?, ?, ?, ?, ?)",
  ).run(
    effectiveSessionId,
    sessionModelText,
    sessionOverride?.agent ?? "build",
    Date.now() - 1000,
    Date.now(),
  );

  const insertMsg = db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
  );

  messages.forEach((row, i) => {
    let dataStr: string;
    if (row.rawJson !== undefined) {
      dataStr = row.rawJson;
    } else if (row.rawRecord !== undefined) {
      dataStr = JSON.stringify(row.rawRecord);
    } else {
      const data: Record<string, unknown> = { role: row.role ?? "assistant" };
      if (row.modelID !== undefined) data.modelID = row.modelID;
      if (row.providerID !== undefined) data.providerID = row.providerID;
      dataStr = JSON.stringify(data);
    }
    insertMsg.run(
      `msg_${i}`,
      effectiveSessionId,
      Date.now() - 900 + i,
      Date.now(),
      dataStr,
    );
  });

  db.close();
  return dbPath;
}

// ============================================================================
// Synthetic Event Stream Session Extraction & Projections
// ============================================================================

test("synthetic event stream: extracts valid session id from pure stream", () => {
  const sessionId = "ses_valid00000000000001";
  const stream = [
    JSON.stringify({
      type: "step_start",
      timestamp: 1000,
      sessionID: sessionId,
      part: { id: "prt_1", type: "step-start", sessionID: sessionId },
    }),
    JSON.stringify({
      type: "text",
      timestamp: 1001,
      sessionID: sessionId,
      part: { id: "prt_2", type: "text", text: "synthetic response", sessionID: sessionId },
    }),
    JSON.stringify({
      type: "step_finish",
      timestamp: 1002,
      sessionID: sessionId,
      part: { id: "prt_3", type: "step-finish", reason: "stop", sessionID: sessionId },
    }),
  ].join("\n");

  const parsed = parseOpenCodeEvents(stream);
  assert.equal(parsed.parsed, true);
  assert.equal(parsed.sessionId, sessionId);
  assert.equal(parsed.text, "synthetic response");
  assert.equal(parsed.finishReason, "stop");
  assert.equal(parsed.steps, 1);
});

test("synthetic event stream: ignores malformed, non-json, or partial lines while projecting valid records", () => {
  const sessionId = "ses_valid00000000000002";
  const stream = [
    "not-json-line-noise",
    "{ partial json: true",
    "12345",
    "null",
    JSON.stringify({ notAnEvent: true }),
    JSON.stringify({ type: 123 }), // type is not a string
    JSON.stringify({
      type: "step_start",
      sessionID: sessionId,
      part: { type: "step-start", sessionID: sessionId },
    }),
    "random prefix error log: something failed",
    JSON.stringify({
      type: "tool",
      sessionID: sessionId,
      part: { type: "tool", tool: "read_file", sessionID: sessionId },
    }),
    JSON.stringify({
      type: "tool_use",
      sessionID: sessionId,
      part: { type: "tool_use", name: "bash_exec", sessionID: sessionId },
    }),
    JSON.stringify({
      type: "text",
      sessionID: sessionId,
      part: "malformed-part-not-object",
    }),
    JSON.stringify({
      type: "text",
      sessionID: sessionId,
      part: { text: 12345 }, // text not string
    }),
    JSON.stringify({
      type: "text",
      sessionID: sessionId,
      part: { type: "text", text: "valid text projected", sessionID: sessionId },
    }),
    JSON.stringify({
      type: "step_finish",
      sessionID: sessionId,
      part: { type: "step-finish", reason: "stop", sessionID: sessionId },
    }),
  ].join("\n");

  const parsed = parseOpenCodeEvents(stream);
  assert.equal(parsed.parsed, true);
  assert.equal(parsed.sessionId, sessionId);
  assert.equal(parsed.text, "valid text projected");
  assert.equal(parsed.toolCalls, 2);
  assert.deepEqual(parsed.toolNames, ["read_file", "bash_exec"]);
  assert.equal(parsed.finishReason, "stop");
  assert.equal(parsed.steps, 1);
});

test("synthetic event stream: empty string or whitespace-only records yield parsed: false", () => {
  assert.equal(parseOpenCodeEvents("").parsed, false);
  assert.equal(parseOpenCodeEvents("   \n\n\t  ").parsed, false);
});

test("synthetic event stream: stream with only non-event JSON yields parsed: false", () => {
  const stream = [
    JSON.stringify({ foo: "bar" }),
    JSON.stringify([1, 2, 3]),
    JSON.stringify("just a string"),
  ].join("\n");
  const parsed = parseOpenCodeEvents(stream);
  assert.equal(parsed.parsed, false);
});

test("synthetic event stream: conflicting session IDs poison evidence (undefined sessionId)", () => {
  const stream = [
    JSON.stringify({
      type: "step_start",
      sessionID: "ses_conflict0001",
      part: { type: "step-start", sessionID: "ses_conflict0001" },
    }),
    JSON.stringify({
      type: "text",
      sessionID: "ses_conflict0002",
      part: { type: "text", text: "text", sessionID: "ses_conflict0002" },
    }),
  ].join("\n");

  const parsed = parseOpenCodeEvents(stream);
  assert.equal(parsed.parsed, true);
  assert.equal(parsed.sessionId, undefined);
});

test("synthetic event stream: disagreement between envelope and part sessionID poisons session id", () => {
  const stream = [
    JSON.stringify({
      type: "step_start",
      sessionID: "ses_envelope0001",
      part: { type: "step-start", sessionID: "ses_part0002" },
    }),
  ].join("\n");

  const parsed = parseOpenCodeEvents(stream);
  assert.equal(parsed.parsed, true);
  assert.equal(parsed.sessionId, undefined);
});

test("synthetic event stream: invalid or non-string sessionID types poison session id", () => {
  const badSessionValues = [12345, true, {}, [], ""];
  for (const bad of badSessionValues) {
    const stream = [
      JSON.stringify({
        type: "step_start",
        sessionID: bad,
        part: { type: "step-start" },
      }),
    ].join("\n");
    const parsed = parseOpenCodeEvents(stream);
    assert.equal(parsed.sessionId, undefined, `failed to reject sessionID ${JSON.stringify(bad)}`);
  }
});

// ============================================================================
// Database Evidence Projection & Extraction
// ============================================================================

test("readOpenCodeSessionEvidence: extracts and projects valid assistant model evidence", () => {
  const root = tmp();
  try {
    const sessionId = "ses_synth00000000000001";
    const dbPath = createSyntheticDb(
      root,
      [
        { role: "user", modelID: "ignored/user-model", providerID: "routeplane" },
        { role: "assistant", modelID: "z-ai/glm-5.2", providerID: "routeplane" },
      ],
      sessionId,
    );

    const evidence = readOpenCodeSessionEvidence({
      dbPath,
      sessionId,
      providerNamespace: "routeplane",
    });

    assert.deepEqual(evidence, { model: "routeplane/z-ai/glm-5.2" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readOpenCodeSessionEvidence: projects provider from joined session.model when assistant has no providerID", () => {
  const root = tmp();
  try {
    const sessionId = "ses_synth00000000000002";
    const dbPath = createSyntheticDb(
      root,
      [{ role: "assistant", modelID: "meta-llama/llama-3-70b" }],
      sessionId,
      { model: { id: "meta-llama/llama-3-70b", providerID: "synthetic-provider" } },
    );

    const evidence = readOpenCodeSessionEvidence({
      dbPath,
      sessionId,
      providerNamespace: "synthetic-provider",
    });

    assert.deepEqual(evidence, { model: "synthetic-provider/meta-llama/llama-3-70b" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readOpenCodeSessionEvidence: ignores user/system messages and projects the earliest assistant message", () => {
  const root = tmp();
  try {
    const sessionId = "ses_synth00000000000003";
    const dbPath = createSyntheticDb(
      root,
      [
        { role: "system", modelID: "system/model", providerID: "routeplane" },
        { role: "user", modelID: "user/model", providerID: "routeplane" },
        { role: "assistant", modelID: "first/model-1", providerID: "routeplane" },
        { role: "assistant", modelID: "second/model-2", providerID: "routeplane" },
      ],
      sessionId,
    );

    const evidence = readOpenCodeSessionEvidence({
      dbPath,
      sessionId,
      providerNamespace: "routeplane",
    });

    assert.deepEqual(evidence, { model: "routeplane/first/model-1" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readOpenCodeSessionEvidence: accepts single-segment and deeply-nested model IDs", () => {
  const root = tmp();
  try {
    const models = [
      "gpt-4o",
      "deepseek-ai/deepseek-r1",
      "org/sub-team/model.v1_alpha-2",
    ];

    for (let i = 0; i < models.length; i++) {
      const modelID = models[i];
      const subRoot = join(root, `case_${i}`);
      const sessionId = `ses_synth0000000000000${i}`;
      const dbPath = createSyntheticDb(
        subRoot,
        [{ role: "assistant", modelID, providerID: "routeplane" }],
        sessionId,
      );

      const evidence = readOpenCodeSessionEvidence({
        dbPath,
        sessionId,
        providerNamespace: "routeplane",
      });

      assert.deepEqual(
        evidence,
        { model: `routeplane/${modelID}` },
        `expected model projection for ${modelID}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// Malformed, Partial, and Mismatched Records (Fail Closed)
// ============================================================================

test("readOpenCodeSessionEvidence: rejects invalid sessionId format without reading DB", () => {
  const root = tmp();
  try {
    const invalidSessionIds = [
      "",
      "ses_",
      "ses_123", // too short (< 4 chars after ses_)
      "ses_" + "a".repeat(65), // too long (> 64 chars after ses_)
      "ses_invalid!token",
      "not_ses_token12345",
      "ses_test;DROP TABLE session;",
      "../ses_traversal",
    ];

    for (const badSessionId of invalidSessionIds) {
      const evidence = readOpenCodeSessionEvidence({
        dbPath: join(root, "non-existent.db"),
        sessionId: badSessionId,
        providerNamespace: "routeplane",
      });
      assert.equal(evidence, undefined, `accepted bad sessionId: ${badSessionId}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readOpenCodeSessionEvidence: rejects invalid providerNamespace format", () => {
  const root = tmp();
  try {
    const invalidNamespaces = [
      "",
      "a".repeat(65), // too long
      "invalid_provider!",
      "routeplane/extra",
      "routeplane..nested",
      "-starts-with-dash",
      "ends-with-dash-",
      "UpperCaseProvider",
    ];

    const dbPath = createSyntheticDb(
      root,
      [{ role: "assistant", modelID: "z-ai/glm-5.2", providerID: "routeplane" }],
    );

    for (const badNs of invalidNamespaces) {
      const evidence = readOpenCodeSessionEvidence({
        dbPath,
        sessionId: "ses_test0000000000000000001",
        providerNamespace: badNs,
      });
      assert.equal(evidence, undefined, `accepted bad providerNamespace: ${badNs}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readOpenCodeSessionEvidence: fails closed when database file does not exist", () => {
  const root = tmp();
  try {
    const evidence = readOpenCodeSessionEvidence({
      dbPath: join(root, "missing", "opencode.db"),
      sessionId: "ses_test0000000000000000001",
      providerNamespace: "routeplane",
    });
    assert.equal(evidence, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readOpenCodeSessionEvidence: fails closed on corrupted/malformed database file", () => {
  const root = tmp();
  try {
    const dbPath = join(root, "corrupted.db");
    writeFileSync(dbPath, "SQLite format 3\0THIS_IS_CORRUPTED_DATA_HEADER_GARBAGE");

    const evidence = readOpenCodeSessionEvidence({
      dbPath,
      sessionId: "ses_test0000000000000000001",
      providerNamespace: "routeplane",
    });
    assert.equal(evidence, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readOpenCodeSessionEvidence: fails closed on missing session or message tables", () => {
  const root = tmp();
  try {
    const dbPath = join(root, "incomplete.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE unrelated (id text PRIMARY KEY);");
    db.close();

    const evidence = readOpenCodeSessionEvidence({
      dbPath,
      sessionId: "ses_test0000000000000000001",
      providerNamespace: "routeplane",
    });
    assert.equal(evidence, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readOpenCodeSessionEvidence: fails closed when session exists but no assistant message exists", () => {
  const root = tmp();
  try {
    const sessionId = "ses_synth00000000000005";
    const dbPath = createSyntheticDb(
      root,
      [
        { role: "user", modelID: "z-ai/glm-5.2", providerID: "routeplane" },
        { role: "system", modelID: "z-ai/glm-5.2", providerID: "routeplane" },
      ],
      sessionId,
    );

    const evidence = readOpenCodeSessionEvidence({
      dbPath,
      sessionId,
      providerNamespace: "routeplane",
    });
    assert.equal(evidence, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readOpenCodeSessionEvidence: fails closed when assistant message JSON data is malformed", () => {
  const root = tmp();
  try {
    const sessionId = "ses_synth00000000000006";
    const dbPath = createSyntheticDb(
      root,
      [{ rawJson: "{ not valid json data" }],
      sessionId,
    );

    const evidence = readOpenCodeSessionEvidence({
      dbPath,
      sessionId,
      providerNamespace: "routeplane",
    });
    assert.equal(evidence, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readOpenCodeSessionEvidence: fails closed when assistant modelID is missing, null, empty or invalid", () => {
  const root = tmp();
  try {
    const badModels = [
      undefined,
      null,
      "",
      " ",
      "/starts/with/slash",
      "ends/with/slash/",
      "invalid characters in model!@#",
    ];

    for (let i = 0; i < badModels.length; i++) {
      const badModel = badModels[i];
      const subRoot = join(root, `bad_model_${i}`);
      const sessionId = `ses_synth0000000000000${i}`;
      const dbPath = createSyntheticDb(
        subRoot,
        [{ role: "assistant", modelID: badModel as string | null | undefined, providerID: "routeplane" }],
        sessionId,
      );

      const evidence = readOpenCodeSessionEvidence({
        dbPath,
        sessionId,
        providerNamespace: "routeplane",
      });
      assert.equal(evidence, undefined, `accepted invalid assistant modelID: ${JSON.stringify(badModel)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readOpenCodeSessionEvidence: fails closed when assistant providerID is invalid format", () => {
  const root = tmp();
  try {
    const badProviders = [
      "",
      "INVALID_UPPERCASE",
      "provider/with/slash",
      "-dash-prefix",
      "dash-suffix-",
    ];

    for (let i = 0; i < badProviders.length; i++) {
      const badProvider = badProviders[i];
      const subRoot = join(root, `bad_prov_${i}`);
      const sessionId = `ses_synth0000000000000${i}`;
      const dbPath = createSyntheticDb(
        subRoot,
        [{ role: "assistant", modelID: "z-ai/glm-5.2", providerID: badProvider }],
        sessionId,
      );

      const evidence = readOpenCodeSessionEvidence({
        dbPath,
        sessionId,
        providerNamespace: "routeplane",
      });
      assert.equal(evidence, undefined, `accepted invalid providerID: ${JSON.stringify(badProvider)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readOpenCodeSessionEvidence: fails closed when session.model json has invalid structure", () => {
  const root = tmp();
  try {
    const badSessionModels = [
      "not json",
      { id: "valid/model" }, // missing providerID
      { providerID: "routeplane" }, // missing id
      { id: "", providerID: "routeplane" }, // empty model id
      { id: "valid/model", providerID: "INVALID_PROVIDER" },
    ];

    for (let i = 0; i < badSessionModels.length; i++) {
      const badModel = badSessionModels[i];
      const subRoot = join(root, `bad_sess_model_${i}`);
      const sessionId = `ses_synth0000000000000${i}`;
      const dbPath = createSyntheticDb(
        subRoot,
        [{ role: "assistant", modelID: "valid/model", providerID: "routeplane" }],
        sessionId,
        { model: badModel },
      );

      const evidence = readOpenCodeSessionEvidence({
        dbPath,
        sessionId,
        providerNamespace: "routeplane",
      });
      assert.equal(evidence, undefined, `accepted invalid session.model: ${JSON.stringify(badModel)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readOpenCodeSessionEvidence: fails closed when sessionModelID contradicts assistantModelID", () => {
  const root = tmp();
  try {
    const sessionId = "ses_synth00000000000010";
    const dbPath = createSyntheticDb(
      root,
      [{ role: "assistant", modelID: "model-a", providerID: "routeplane" }],
      sessionId,
      { model: { id: "model-b", providerID: "routeplane" } },
    );

    const evidence = readOpenCodeSessionEvidence({
      dbPath,
      sessionId,
      providerNamespace: "routeplane",
    });
    assert.equal(evidence, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readOpenCodeSessionEvidence: fails closed when sessionProviderID contradicts assistantProviderID", () => {
  const root = tmp();
  try {
    const sessionId = "ses_synth00000000000011";
    const dbPath = createSyntheticDb(
      root,
      [{ role: "assistant", modelID: "valid-model", providerID: "routeplane" }],
      sessionId,
      { model: { id: "valid-model", providerID: "other-provider" } },
    );

    const evidence = readOpenCodeSessionEvidence({
      dbPath,
      sessionId,
      providerNamespace: "routeplane",
    });
    assert.equal(evidence, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readOpenCodeSessionEvidence: fails closed when observed provider contradicts expected providerNamespace", () => {
  const root = tmp();
  try {
    const sessionId = "ses_synth00000000000012";
    const dbPath = createSyntheticDb(
      root,
      [{ role: "assistant", modelID: "z-ai/glm-5.2", providerID: "provider-alpha" }],
      sessionId,
    );

    const evidence = readOpenCodeSessionEvidence({
      dbPath,
      sessionId,
      providerNamespace: "provider-beta",
    });
    assert.equal(evidence, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readOpenCodeSessionEvidence: fails closed when no provider identity can be found in assistant or session", () => {
  const root = tmp();
  try {
    const sessionId = "ses_synth00000000000013";
    const dbPath = createSyntheticDb(
      root,
      [{ role: "assistant", modelID: "z-ai/glm-5.2" }],
      sessionId,
      { model: null },
    );

    const evidence = readOpenCodeSessionEvidence({
      dbPath,
      sessionId,
      providerNamespace: "routeplane",
    });
    assert.equal(evidence, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
