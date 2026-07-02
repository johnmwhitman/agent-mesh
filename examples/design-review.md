# Example: Multi-perspective design review

## Scenario

Your team is about to ship a new feature. Before merging, you want:
- A frontend developer to look at the UX and accessibility
- A security auditor to look at the auth and data flow
- A code reviewer to look at the implementation

A 30-minute meeting with three people is the usual approach. A 3-agent fleet gets you 80% of the value in 90 seconds.

## The fleet

```typescript
const { fleet_id, agent_ids } = await callTool("spawn_fleet", {
  agents: [
    {
      role: "Frontend Developer",
      prompt: "Review the new 'account deletion' feature in /Users/me/projects/myapp/src/features/account-deletion. Look for: (1) accessibility issues (aria labels, focus management), (2) UX issues (loading states, error handling), (3) React anti-patterns (missing keys, mutating state, missing dependencies in useEffect). Produce a list of concrete suggestions.",
      agent: "frontend-developer",
    },
    {
      role: "Security Auditor",
      prompt: "Review the new 'account deletion' feature. Look for: (1) auth checks — does the user have to re-authenticate before deletion? (2) data flow — does it actually delete all PII, or just soft-delete? (3) audit log — is the deletion event logged? (4) rate limiting — could a user be tricked into deleting their account? Produce a list of concrete security concerns.",
      agent: "application-security-engineer",
    },
    {
      role: "Code Reviewer",
      prompt: "Review the new 'account deletion' feature for implementation quality. Look for: (1) tests — is there adequate coverage of the happy path AND edge cases? (2) error paths — what happens if the database call fails mid-deletion? (3) observability — can we tell from logs that an account was deleted? Produce a list of code review feedback.",
      agent: "code-reviewer",
    },
  ],
});
```

## What happens

Three agents review the same feature in parallel. Each one comes at it from their angle. They publish their findings independently.

## P2P message flow

For this pattern, **the agents should not message each other** — they're producing independent perspectives. The orchestrator (you) collects and synthesizes:

```typescript
// After spawn_fleet, wait for the fleet to complete
const status = await callTool("fleet_status", { fleet_id });
// Poll until status.status === "complete"...

// Get each agent's output
const results = await callTool("collect_results", { fleet_id });
for (const r of results.results) {
  console.log(`\n=== ${r.role} ===\n${r.output}`);
}
```

## Expected output

Three independent reviews:

- **Frontend**: accessibility, UX, React patterns
- **Security**: auth, data, audit, rate limit
- **Code**: tests, error paths, observability

You read all three, then make the ship/no-ship call yourself.

## Variation: debate pattern

If you want the agents to actually push back on each other, add a debate step:

```typescript
// Wait for all three to finish
// (poll fleet_status until complete)

// Then spawn a follow-up fleet that reviews the reviews
const { fleet_id: review_fleet } = await callTool("spawn_fleet", {
  agents: [
    {
      role: "Code Reviewer",
      prompt: `Here are three reviews of the account-deletion feature:
[frontend review]
[security review]
[code review]

Find any disagreements. If the security auditor says rate limiting is missing and the frontend developer didn't mention it, that's a finding. If the code reviewer says the error path is unhandled and the security auditor didn't catch it, that's a finding. Produce a 'disagreements and gaps' report.`,
      agent: "code-reviewer",
    },
  ],
});
```

This is a two-stage review: first three parallel perspectives, then a cross-check. The output is sharper than any single agent could produce.

## Why this works

A real design review is bottlenecked on calendar coordination. Three agents run in parallel as OS processes — the review happens in seconds, not days. The synthesis (your job) is where you add the most value anyway.