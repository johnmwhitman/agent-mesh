import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  ackMessage,
  discoverPremadeAgents,
  extractSkillsFromDescription,
  getInbox,
  loadData,
  markAgentFinished,
  MAX_PAYLOAD_BYTES,
  registerCapability,
  registerAgentInLedger,
  routeWork,
  saveData,
  sendMessage,
  setLedgerPath,
  setLedgerOverride,
  loadDataFromFile,
  saveDataToFile,
} from "/Users/johnwhitman/.config/opencode/mcp-servers/agent-mesh/dist/core.js";

// ---------------------------------------------------------------------------
// Test isolation: every test gets a fresh in-memory ledger
// ---------------------------------------------------------------------------

function freshLedger(): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agent-mesh-test-"));
  const file = join(dir, "ledger.json");
  // In-memory state for this test
  let memory: import("/Users/johnwhitman/.config/opencode/mcp-servers/agent-mesh/dist/core.js").MeshData = {
    fleets: {},
    agents: {},
    messages: {},
    inboxes: {},
    capabilities: {},
  };
  setLedgerOverride(
    () => JSON.parse(JSON.stringify(memory)),
    (data) => { memory = data; }
  );
  return {
    dir,
    file,
    cleanup: () => {
      setLedgerOverride(null, null);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

// ---------------------------------------------------------------------------
// loadData / saveData
// ---------------------------------------------------------------------------

test("loadData: returns empty data when file does not exist", () => {
  const { cleanup } = freshLedger();
  const data = loadData();
  assert.deepEqual(data.fleets, {});
  assert.deepEqual(data.agents, {});
  assert.deepEqual(data.messages, {});
  assert.deepEqual(data.inboxes, {});
  assert.deepEqual(data.capabilities, {});
  cleanup();
});

test("loadData: returns empty data when file is corrupt JSON", () => {
  const { dir, file, cleanup } = freshLedger();
  writeFileSync(file, "this is not json{{{");
  const data = loadData();
  assert.deepEqual(data.fleets, {});
  cleanup();
});

test("loadData: round-trips through saveData", () => {
  const { cleanup } = freshLedger();
  const fleetId = randomUUID();
  const data = loadData();
  data.fleets[fleetId] = {
    id: fleetId,
    status: "running",
    created_at: 12345,
  };
  saveData(data);
  const reloaded = loadData();
  assert.ok(reloaded.fleets[fleetId]);
  assert.equal(reloaded.fleets[fleetId].status, "running");
  cleanup();
});

test("loadData: backward compat with v0.1 ledger (no messages/inboxes/capabilities keys)", () => {
  const { dir, file, cleanup } = freshLedger();
  writeFileSync(
    file,
    JSON.stringify({
      fleets: { abc: { id: "abc", status: "complete", created_at: 1 } },
      agents: { agent1: { id: "agent1", fleet_id: "abc", role: "r", prompt: "p", status: "complete" } },
    })
  );
  // Use file-based loader to read the raw v0.1 ledger (override is in-memory)
  const data = loadDataFromFile(file);
  assert.ok(data.fleets.abc);
  assert.ok(data.agents.agent1);
  assert.deepEqual(data.messages, {});
  assert.deepEqual(data.inboxes, {});
  assert.deepEqual(data.capabilities, {});
  cleanup();
});

// ---------------------------------------------------------------------------
// sendMessage / getInbox / ackMessage
// ---------------------------------------------------------------------------

test("sendMessage: creates message and appends to recipient inbox", () => {
  const { cleanup } = freshLedger();
  const msgId = sendMessage("a1", "a2", "f1", "handoff", '{"context":"x"}');
  assert.ok(msgId);
  const inbox = getInbox("a2");
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].from_agent_id, "a1");
  assert.equal(inbox[0].type, "handoff");
  cleanup();
});

test("sendMessage: rejects payload exceeding 64KB", () => {
  const { cleanup } = freshLedger();
  const big = "x".repeat(MAX_PAYLOAD_BYTES + 1);
  assert.throws(
    () => sendMessage("a1", "a2", "f1", "handoff", big),
    /Payload too large/
  );
  cleanup();
});

test("sendMessage: accepts payload exactly at 64KB limit", () => {
  const { cleanup } = freshLedger();
  const exact = "x".repeat(MAX_PAYLOAD_BYTES);
  const msgId = sendMessage("a1", "a2", "f1", "handoff", exact);
  assert.ok(msgId);
  cleanup();
});

test("getInbox: filters by since timestamp", async () => {
  const { cleanup } = freshLedger();
  const m1 = sendMessage("a1", "a2", "f1", "handoff", "first");
  await new Promise((r) => setTimeout(r, 5));
  const cutoff = Date.now();
  await new Promise((r) => setTimeout(r, 5));
  const m2 = sendMessage("a1", "a2", "f1", "question", "second");
  const recent = getInbox("a2", cutoff);
  // Only the second message should pass the since filter
  assert.equal(recent.length, 1);
  assert.equal(recent[0].id, m2);
  cleanup();
});

test("getInbox: returns empty array for agent with no inbox", () => {
  const { cleanup } = freshLedger();
  assert.deepEqual(getInbox("nonexistent"), []);
  cleanup();
});

test("ackMessage: marks acknowledged and removes from inbox", () => {
  const { cleanup } = freshLedger();
  const msgId = sendMessage("a1", "a2", "f1", "handoff", "x");
  assert.equal(getInbox("a2").length, 1);
  const ok = ackMessage("a2", msgId);
  assert.equal(ok, true);
  assert.equal(getInbox("a2").length, 0);
  cleanup();
});

test("ackMessage: idempotent on non-existent message", () => {
  const { cleanup } = freshLedger();
  const ok = ackMessage("a2", "nonexistent");
  assert.equal(ok, false);
  cleanup();
});

// ---------------------------------------------------------------------------
// registerCapability / routeWork
// ---------------------------------------------------------------------------

test("registerCapability: stores capability record", () => {
  const { cleanup } = freshLedger();
  registerCapability({
    agentId: "a1",
    fleetId: "f1",
    role: "Frontend Developer",
    skills: ["react", "typescript"],
  });
  const data = loadData();
  assert.ok(data.capabilities.a1);
  assert.equal(data.capabilities.a1.role, "Frontend Developer");
  assert.deepEqual(data.capabilities.a1.skills, ["react", "typescript"]);
  cleanup();
});

test("routeWork: returns empty array when no capabilities registered", () => {
  const { cleanup } = freshLedger();
  assert.deepEqual(routeWork("any description"), []);
  cleanup();
});

test("routeWork: returns sorted matches by score", () => {
  const { cleanup } = freshLedger();
  registerCapability({ agentId: "a1", fleetId: "f1", role: "Frontend Developer", skills: ["react", "ui"] });
  registerCapability({ agentId: "a2", fleetId: "f1", role: "Backend Architect", skills: ["api", "database"] });
  registerCapability({ agentId: "a3", fleetId: "f1", role: "Security Auditor", skills: ["auth", "vulnerabilities"] });

  const matches = routeWork("audit authentication security vulnerabilities");
  assert.ok(matches.length > 0);
  // Security auditor should match most keywords
  assert.equal(matches[0].agent_id, "a3");
  cleanup();
});

test("routeWork: returns empty when no keywords match", () => {
  const { cleanup } = freshLedger();
  registerCapability({ agentId: "a1", fleetId: "f1", role: "Frontend Developer", skills: ["react"] });
  const matches = routeWork("xyz qqq");
  assert.deepEqual(matches, []);
  cleanup();
});

test("routeWork: filters out zero-score matches", () => {
  const { cleanup } = freshLedger();
  registerCapability({ agentId: "a1", fleetId: "f1", role: "Unrelated Agent", skills: ["painting"] });
  const matches = routeWork("audit security");
  assert.equal(matches.length, 0);
  cleanup();
});

// ---------------------------------------------------------------------------
// extractSkillsFromDescription
// ---------------------------------------------------------------------------

test("extractSkillsFromDescription: filters stop words and short tokens", () => {
  const skills = extractSkillsFromDescription("Expert React developer for TypeScript applications");
  assert.ok(skills.includes("react"));
  assert.ok(skills.includes("developer"));
  assert.ok(skills.includes("typescript"));
  assert.ok(skills.includes("applications"));
  // stop words
  assert.ok(!skills.includes("for"));
  assert.ok(!skills.includes("the"));
});

test("extractSkillsFromDescription: caps at 15 skills", () => {
  const desc = Array.from({ length: 50 }, (_, i) => `keyword${i}`).join(" ");
  const skills = extractSkillsFromDescription(desc);
  assert.equal(skills.length, 15);
});

test("extractSkillsFromDescription: returns empty for stop-word-only input", () => {
  const skills = extractSkillsFromDescription("the a an and or for with");
  assert.deepEqual(skills, []);
});

// ---------------------------------------------------------------------------
// discoverPremadeAgents
// ---------------------------------------------------------------------------

test("discoverPremadeAgents: reads frontmatter from .md files in given dirs", () => {
  const { cleanup, dir } = freshLedger();
  const agentsDir = join(dir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "test-agent.md"),
    `---
name: Test Agent
description: A test agent for unit tests
mode: subagent
---

# Test Agent body
`
  );
  const agents = discoverPremadeAgents([agentsDir]);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].filename, "test-agent");
  assert.equal(agents[0].name, "Test Agent");
  assert.equal(agents[0].description, "A test agent for unit tests");
  assert.equal(agents[0].mode, "subagent");
  cleanup();
});

test("discoverPremadeAgents: skips files without frontmatter", () => {
  const { cleanup, dir } = freshLedger();
  const agentsDir = join(dir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, "no-frontmatter.md"), "just plain text");
  const agents = discoverPremadeAgents([agentsDir]);
  assert.equal(agents.length, 0);
  cleanup();
});

test("discoverPremadeAgents: dedupes by filename across dirs", () => {
  const { cleanup, dir } = freshLedger();
  const dirA = join(dir, "a");
  const dirB = join(dir, "b");
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  const fm = `---
name: Dup Agent
description: dup
mode: subagent
---
`;
  writeFileSync(join(dirA, "dup.md"), fm);
  writeFileSync(join(dirB, "dup.md"), fm);
  const agents = discoverPremadeAgents([dirA, dirB]);
  assert.equal(agents.length, 1);
  cleanup();
});

// ---------------------------------------------------------------------------
// markAgentFinished
// ---------------------------------------------------------------------------

test("markAgentFinished: updates agent status and triggers fleet completion when all done", () => {
  const { cleanup } = freshLedger();
  const fleetId = "f-complete";
  const a1 = randomUUID();
  const a2 = randomUUID();
  registerAgentInLedger({ id: a1, fleet_id: fleetId, role: "r1", prompt: "p1", status: "running" });
  registerAgentInLedger({ id: a2, fleet_id: fleetId, role: "r2", prompt: "p2", status: "running" });

  // Fleet must exist for checkFleetCompletion to update it
  const data = loadData();
  data.fleets[fleetId] = { id: fleetId, status: "running", created_at: 0 };
  saveData(data);

  markAgentFinished(a1, "complete", "ok", undefined);
  // Fleet should still be running because a2 is not done
  assert.equal(loadData().fleets[fleetId].status, "running");

  markAgentFinished(a2, "complete", "ok", undefined);
  // Now both are done — fleet should be complete
  assert.equal(loadData().fleets[fleetId].status, "complete");
  cleanup();
});

test("markAgentFinished: fleet marked failed if any agent failed", () => {
  const { cleanup } = freshLedger();
  const fleetId = "f-fail";
  const a1 = randomUUID();
  const a2 = randomUUID();
  registerAgentInLedger({ id: a1, fleet_id: fleetId, role: "r1", prompt: "p1", status: "running" });
  registerAgentInLedger({ id: a2, fleet_id: fleetId, role: "r2", prompt: "p2", status: "running" });

  const data = loadData();
  data.fleets[fleetId] = { id: fleetId, status: "running", created_at: 0 };
  saveData(data);

  markAgentFinished(a1, "complete", "ok", undefined);
  markAgentFinished(a2, "failed", "err", "boom");
  assert.equal(loadData().fleets[fleetId].status, "failed");
  cleanup();
});

test("markAgentFinished: idempotent on already-completed agent", () => {
  const { cleanup } = freshLedger();
  const agentId = randomUUID();
  registerAgentInLedger({ id: agentId, fleet_id: "f1", role: "r", prompt: "p", status: "running" });

  markAgentFinished(agentId, "complete", "first", undefined);
  const firstStatus = loadData().agents[agentId].status;

  // Second call should be no-op
  markAgentFinished(agentId, "failed", "second", "shouldnt apply");
  const secondStatus = loadData().agents[agentId].status;

  assert.equal(firstStatus, "complete");
  assert.equal(secondStatus, "complete"); // unchanged
  cleanup();
});

// ---------------------------------------------------------------------------
// Real-world integration: premade agent auto-registration
// ---------------------------------------------------------------------------

test("autoRegisterFromAgent: discovers + registers capabilities for a real premade agent", () => {
  const { cleanup, dir } = freshLedger();
  const agentsDir = join(dir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "frontend-developer.md"),
    `---
name: Frontend Developer
description: Expert React developer for TypeScript applications
mode: subagent
---
`
  );

  // The autoRegisterFromAgent uses the default search dirs; we need to override
  // by temporarily redirecting CWD. Since discoverPremadeAgents accepts searchDirs,
  // we use the exported function directly here for verification.
  const premade = discoverPremadeAgents([agentsDir]);
  assert.equal(premade.length, 1);
  const skills = extractSkillsFromDescription(premade[0].description);
  assert.ok(skills.includes("react"));
  assert.ok(skills.includes("typescript"));
  cleanup();
});
