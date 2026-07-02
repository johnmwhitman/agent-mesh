# Example: Codebase exploration before a refactor

## Scenario

You have a 10k-line codebase. You want to refactor a module but you don't know:
- What the module actually does today
- What calls it (and what it calls)
- What the highest-risk areas are

A single agent can answer one of these. A fleet of three agents can answer all three **in parallel** and share findings.

## The fleet

```typescript
const { fleet_id, agent_ids } = await callTool("spawn_fleet", {
  agents: [
    {
      role: "Codebase Onboarding Engineer",
      prompt: "Map the directory structure of /Users/me/projects/myapp. Identify the top-level modules, what each one does (read package.json, README, and the main entry point), and produce a one-paragraph summary of each. Pay special attention to the `auth` module — what files it contains, what it exports, what it imports.",
      agent: "codebase-onboarding-engineer",
    },
    {
      role: "Code Reviewer",
      prompt: "Review the auth module in /Users/me/projects/myapp/src/auth. Find: (1) functions with high cyclomatic complexity, (2) functions over 50 lines, (3) any `any` types in TypeScript, (4) any places where errors are swallowed, (5) any hardcoded secrets. Produce a prioritized list of the top 5 risks.",
      agent: "code-reviewer",
    },
    {
      role: "Backend Architect",
      prompt: "Based on the codebase map and risk list from the other agents, draft a refactor plan for the auth module. Output a markdown document with: goals, non-goals, phased approach (3-5 phases), and risks for each phase. Be specific about which files change in each phase.",
      agent: "backend-architect",
    },
  ],
});
```

## What happens

1. **Meshfleet spawns three `opencode run` processes** in parallel. Each one runs as a different agent (via `--agent <filename>`).
2. **The Explorer maps the codebase** — this typically takes 30-60 seconds for a 10k-line project.
3. **The Code Reviewer analyzes the auth module** — this runs in parallel, no waiting.
4. **The Architect waits** for the other two to publish findings (via P2P `result` messages), then synthesizes a plan.

## P2P message flow

The Architect doesn't have to do all the synthesis alone. You can extend this pattern so the three agents actually message each other:

```typescript
// After spawn_fleet, route work to drive the synthesis:
const { matches } = await callTool("route_work", {
  description: "synthesize codebase exploration into refactor plan"
});
// matches[0] is the best agent for synthesis — probably the architect
```

Or explicitly chain them with P2P `handoff` messages:

```typescript
// Wait for explorer to finish
const explorer = agent_ids[0];
const status = await callTool("fleet_status", { fleet_id });
// Poll until explorer's status is "complete"...

// Then send a handoff to the architect
await callTool("send_message", {
  from_agent_id: agent_ids[0],
  to_agent_id: agent_ids[2],
  fleet_id,
  type: "handoff",
  payload: JSON.stringify({
    context: "Codebase map complete. See fleet_status for output.",
    next_step: "Synthesize with the risk list and draft the plan.",
  }),
});
```

## Expected output

After ~60-90 seconds, you'll have:

- **From the Explorer**: a one-paragraph summary of each top-level module
- **From the Code Reviewer**: a prioritized risk list
- **From the Architect**: a phased refactor plan with specific file lists

You'll see this via `npx agent-mesh inspect --events 5` or by calling `collect_results` for each agent.

## Variations

- **Add a Security Auditor** to the fleet for security-sensitive refactors
- **Add a Test Engineer** to identify which existing tests cover the refactor scope
- **Skip the Architect** and just have the Explorer + Code Reviewer hand off to a human
- **Time it**: spawn the fleet, then `npx agent-mesh inspect` repeatedly to see each agent complete

## Why this works

The three agents run **in parallel** as independent OS processes. They don't block each other. The Architect only needs to wait if you explicitly wire handoffs; otherwise it gets the full picture from `collect_results` at the end.

Compare to a single agent doing all three: 3x faster, and each agent specializes in its concern (map / review / plan) rather than context-switching.