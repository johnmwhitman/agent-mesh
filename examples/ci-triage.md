# Example: CI failure triage

## Scenario

CI just failed. 47 tests broke. You need to know:
- Which are real bugs vs. flaky vs. infrastructure
- For the real bugs, what's the root cause
- Whether to revert, hotfix, or skip

A single engineer spends 30-60 minutes on this. A 3-agent fleet does it in 2-3 minutes.

## The fleet

```typescript
const { fleet_id, agent_ids } = await callTool("spawn_fleet", {
  agents: [
    {
      role: "Test Diagnostician",
      prompt: `Read /Users/me/projects/myapp/ci-failures.log (a JSON file with shape { failedTests: [{ name, error, file, line }] }). Categorize each failure into one of: (1) real bug — test failed because the code is wrong, (2) flaky — test has timing/race issues, (3) infrastructure — test failed because the env is broken, (4) test bug — test is wrong but code is right. Output JSON: { category, testName, evidence, severity } for each.`,
      agent: "test-diagnostician",
    },
    {
      role: "Backend Architect",
      prompt: "After the test diagnostician publishes, for the tests categorized as 'real bug', investigate the actual root cause by reading the relevant source files. For each real-bug failure, output: { testName, rootCause, affectedFiles, suggestedFix }. Don't fix the code — just diagnose.",
      agent: "backend-architect",
    },
    {
      role: "Release Manager",
      prompt: "After the other two publish, output a triage decision: (1) which commits to revert if any, (2) which tests to mark as 'skip pending investigation', (3) which to investigate further. Output a single 'recommended action' at the end. Be opinionated.",
      agent: "release-manager",
    },
  ],
});
```

## What happens

1. **Triage agent** reads the failure log and categorizes all 47 tests in seconds.
2. **Architect agent** reads the source for the "real bug" subset and produces diagnoses. This runs in parallel with the triage agent for tests that don't need triage.
3. **Release manager** synthesizes everything into a single recommendation.

## P2P message flow (the key part)

The whole flow depends on **handoffs** between the agents. The Triage agent has to finish before the Architect can do real-bug diagnoses. The Architect has to finish before the Release Manager can recommend an action.

You can wire this explicitly:

```typescript
// 1. Spawn the fleet
const { fleet_id, agent_ids } = await callTool("spawn_fleet", { agents: [...] });

// 2. Wait for triage to complete (poll fleet_status)
// ... (poll until agent_ids[0].status === "complete")

// 3. Triage hands off to Architect
await callTool("send_message", {
  from_agent_id: agent_ids[0],
  to_agent_id: agent_ids[1],
  fleet_id,
  type: "handoff",
  payload: JSON.stringify({
    context: "Triage complete. 12 real bugs, 20 flaky, 15 infrastructure.",
    next_step: "Investigate the 12 real bugs and produce diagnoses.",
  }),
});

// 4. Architect hands off to Release Manager
// ... (wait for agent_ids[1] to complete, then send another handoff)
```

But this is tedious. A simpler version: just let the agents run independently and synthesize yourself. The mesh gives you three perspectives; you pick the action.

## Real-time alerts (variation)

If you want CI triage to happen **automatically** when CI fails, hook Meshfleet up to your CI:

```yaml
# .github/workflows/triage-on-fail.yml
- name: Triage failures
  if: failure()
  run: |
    curl -X POST http://localhost:3000/api/brief/generate \
      -H "Content-Type: application/json" \
      -d @<(jq -n --rawfile log ci-failures.log '{topic:"CI triage",decision:"${{ github.event.head_commit.message }}",context:$log}')
```

(You'd need to write a small wrapper that calls your OpenCode session, but the idea is: trigger a triage fleet whenever CI fails.)

## Expected output

- **Triage agent**: JSON with category per failing test
- **Architect agent**: root causes for the real bugs
- **Release manager**: a single opinionated action ("revert commit X, skip tests Y, investigate Z")

## Variation: smaller scope

If 47 tests is too many, spawn the triage agent only, get the categories, and then **attach** a debugger for the worst 3:

```typescript
// After triage finishes
const failures = JSON.parse(triage_output).filter(t => t.category === "real bug" && t.severity === "high");

// Attach a debugger for the worst 3
for (const failure of failures.slice(0, 3)) {
  await callTool("attach_agent", {
    fleet_id,
    role: "Debugger",
    prompt: `Investigate ${failure.testName}. The error was: ${failure.error}`,
    agent: "backend-architect",
  });
}
```

## Why this works

Triage is a parallel-friendly task. Three agents running in parallel is faster than one human sequentially — and each one brings a different lens (diagnostic / architectural / strategic).