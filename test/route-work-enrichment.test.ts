import { test } from "node:test";
import assert from "node:assert/strict";
import { registerCapability, routeWork } from "../src/core.js";
import { setSkillTaxonomy, resetSkillTaxonomy } from "../src/skill-taxonomy.js";
import { withTempDb } from "./helpers/with-temp-db.js";

// ---------------------------------------------------------------------------
// ROADMAP #56 — bidirectional synonym expansion.
// Before: only the DESCRIPTION was synonym-expanded, matched by substring
// against raw role/skills. That misses the key-also-value collision: "api" is
// a top-level synonym key AND a value under "backend", so getSynonyms("api")
// returns early with api's own list and never reaches "backend". Expanding the
// capability's role+skills too closes it.
// ---------------------------------------------------------------------------

test("routeWork: description 'api' reaches a 'backend' agent (bidirectional synonyms)", () => {
  const ledger = withTempDb();
  try {
    registerCapability({ agentId: "b1", fleetId: "f1", role: "backend", skills: ["node"] });
    registerCapability({ agentId: "f2", fleetId: "f1", role: "frontend", skills: ["react"] });
    const matches = routeWork("api integration", 2);
    assert.ok(
      matches.some((m) => m.agent_id === "b1"),
      "the backend agent should match an 'api' task even though 'api' never substring-hits 'backend'"
    );
    assert.equal(matches[0].agent_id, "b1", "backend outranks the unrelated frontend agent");
  } finally {
    ledger.cleanup();
  }
});

test("routeWork: bidirectional expansion never demotes a direct keyword hit", () => {
  const ledger = withTempDb();
  try {
    registerCapability({ agentId: "a1", fleetId: "f1", role: "frontend", skills: ["react", "css"] });
    registerCapability({ agentId: "a2", fleetId: "f1", role: "backend", skills: ["node", "sql"] });
    // Direct hit on react must still win, unchanged from pre-enrichment behavior.
    const matches = routeWork("build a react component");
    assert.equal(matches[0].agent_id, "a1");
  } finally {
    ledger.cleanup();
  }
});

// ---------------------------------------------------------------------------
// ROADMAP #55 — wire skill-taxonomy into route_work.
// The taxonomy module scores a capability by its position in the user's skill
// tree (a 'react' agent gets partial credit for a 'nextjs' task). It existed
// but routeWork never called it. Default (no taxonomy set) must be unchanged.
// ---------------------------------------------------------------------------

test("routeWork: taxonomy OFF by default — 'nextjs' does NOT reach a bare 'react' agent", () => {
  const ledger = withTempDb();
  try {
    resetSkillTaxonomy();
    registerCapability({ agentId: "r1", fleetId: "f1", role: "react", skills: [] });
    const matches = routeWork("build a nextjs app", 3);
    assert.ok(
      !matches.some((m) => m.agent_id === "r1"),
      "with no taxonomy set, an unrelated keyword ('nextjs') must not credit 'react' — backward compatible"
    );
  } finally {
    resetSkillTaxonomy();
    ledger.cleanup();
  }
});

test("routeWork: taxonomy ON — 'nextjs' credits a 'react' agent via ancestor scoring", () => {
  const ledger = withTempDb();
  try {
    setSkillTaxonomy({ frontend: { react: ["nextjs", "remix"], vue: ["nuxt"] } });
    registerCapability({ agentId: "r1", fleetId: "f1", role: "react", skills: [] });
    registerCapability({ agentId: "b1", fleetId: "f1", role: "backend", skills: ["sql"] });
    const matches = routeWork("build a nextjs app", 3);
    assert.ok(
      matches.some((m) => m.agent_id === "r1"),
      "'react' is the taxonomy parent of 'nextjs' and should be credited"
    );
    assert.equal(matches[0].agent_id, "r1", "the taxonomy-related agent outranks the unrelated backend agent");
  } finally {
    resetSkillTaxonomy();
    ledger.cleanup();
  }
});

// Regression guards for two latent issues a correctness review surfaced that
// the tests above did not exercise.

test("routeWork: a role+skill double-hit still counts twice (original scoring preserved)", () => {
  const ledger = withTempDb();
  try {
    // 'react' hits BOTH role and a skill on d1 → literal 2; only the skill on d2 → literal 1.
    registerCapability({ agentId: "d1", fleetId: "f1", role: "react", skills: ["react"] });
    registerCapability({ agentId: "d2", fleetId: "f1", role: "backend", skills: ["react"] });
    const matches = routeWork("react", 2);
    assert.equal(matches[0].agent_id, "d1", "the agent matching on both role AND skill ranks first");
    assert.ok(matches[0].score > matches[1].score, "double-hit outscores single-hit");
  } finally {
    ledger.cleanup();
  }
});

test("routeWork: one literal hit always outranks a synonym-rescue, even with many keywords", () => {
  const ledger = withTempDb();
  try {
    // Long description → many expanded keywords (large K). The rescued agent must
    // still lose to a single literal hit — literal dominance is structural, not weighted.
    registerCapability({ agentId: "lit", fleetId: "f1", role: "docs", skills: [] });
    registerCapability({ agentId: "resc", fleetId: "f1", role: "backend", skills: ["node"] });
    // 'docs' literally hits lit's role. 'api' only rescue-matches resc's 'backend'
    // (api-as-key expands to [rest,graphql...] NOT backend, so no description-side
    // literal leaks to resc; the match is purely capability-side rescue).
    const matches = routeWork("generate the api docs", 2);
    const lit = matches.find((m) => m.agent_id === "lit");
    const resc = matches.find((m) => m.agent_id === "resc");
    assert.ok(lit, "literal-match agent present");
    assert.ok(resc, "rescued agent present");
    assert.ok(lit!.score > resc!.score, "literal 'docs' hit beats the api→backend synonym rescue");
  } finally {
    ledger.cleanup();
  }
});

test("routeWork: resetSkillTaxonomy restores default (no ancestor credit)", () => {
  const ledger = withTempDb();
  try {
    setSkillTaxonomy({ frontend: { react: ["nextjs"] } });
    resetSkillTaxonomy();
    registerCapability({ agentId: "r1", fleetId: "f1", role: "react", skills: [] });
    const matches = routeWork("nextjs", 3);
    assert.ok(!matches.some((m) => m.agent_id === "r1"), "after reset, taxonomy credit is gone");
  } finally {
    resetSkillTaxonomy();
    ledger.cleanup();
  }
});
