# Agent Mesh — Examples

Working fleet configs you can drop into `spawn_fleet` or save as templates.

## [Code review trio](code-review-trio.json)

Three specialists, one job: review a PR. Explorer maps the diff, analyst flags risks, engineer drafts a fix.

```json
{
  "agents": [
    { "role": "Explorer", "prompt": "Summarize what this PR changes", "agent": "codebase-onboarding-engineer" },
    { "role": "Analyst", "prompt": "List risks, regressions, and missing tests", "agent": "oracle" },
    { "role": "Engineer", "prompt": "Draft a follow-up commit for the most important issue", "agent": "backend-architect" }
  ]
}
```

## [Frontend bug bash](frontend-bug-bash.json)

Fan-out: 3 frontend specialists each investigate the same bug from a different angle. The orchestrator picks the best fix.

```json
{
  "agents": [
    { "role": "React expert", "prompt": "Hypothesize the React-side cause", "agent": "frontend-developer" },
    { "role": "CSS expert",   "prompt": "Hypothesize the CSS/layout cause",     "agent": "frontend-designer" },
    { "role": "A11y expert",  "prompt": "Hypothesize an accessibility cause",   "agent": "accessibility-auditor" }
  ]
}
```

Use with `route_work(description, top_n=3)` to pick the right agent for each handoff.

## [Pipeline: explore → plan → implement](pipeline-explain-plan-implement.json)

Sequential handoff via `send_message`. Agent A finishes, hands off to B, B hands off to C.

```json
{
  "agents": [
    { "role": "Explorer",  "prompt": "Map the auth layer and find the JWT refresh path", "agent": "codebase-onboarding-engineer" },
    { "role": "Planner",   "prompt": "Write a 3-step plan to fix JWT refresh",            "agent": "backend-architect" },
    { "role": "Engineer",  "prompt": "Implement step 1 of the plan",                      "agent": "backend-developer" }
  ]
}
```

After the first agent returns, your orchestrator reads the result and calls `send_message` to the next agent with the previous output as context.

## [CI failure triage](ci-failure-triage.json)

Three specialists process a CI failure: categorizer (regression / flaky / infrastructure / real bug), investigator (root cause + most likely file), fixer (minimal patch for the highest-confidence real bug). Piped sequentially — the fixer only runs if the categorizer flags a real bug.

## [Doc generation](doc-generation.json)

Three specialists generate docs for a module: doc reader (structured outline of the public API surface), doc writer (README based on the outline), doc reviewer (checks claims against the actual code and flags drift).

## [Test generation](test-generation.json)

Three specialists generate tests for a module: test reader (list of behaviors that should be covered), test writer (node:test cases for each behavior), coverage checker (runs the tests and reports gaps).

## [Security audit](security-audit.json)

Four specialists run a security review: threat modeler (trust boundaries, input vectors), vulnerability scanner (common vuln patterns), severity rater (CVSS-style), fix recommender (minimal patches). Pipeline runs sequentially; output is a structured finding list.

## [Refactor](refactor.json)

Four specialists run a code-health pass: smell detector (long functions, deep nesting, duplication), pattern proposer (extract method, parameter object, etc.), risk assessor (rates proposed refactors by reversibility and scope), refactor executor (applies low-risk ones one at a time).

## [Bug investigation](bug-investigation.json)

Four specialists run a structured bug fix: bug reproducer (failing test first), root cause investigator (git blame + code analysis), fix applier (minimal fix), postmortem writer (blameless retrospective on what process change would catch this earlier).

## [Load test](load-test.json)

Spawn 10 short-running agents in parallel. Useful for verifying the retry + heartbeat machinery works at modest scale.

```json
{
  "agents": [
    { "role": "Worker 1", "prompt": "Reply with DONE" },
    { "role": "Worker 2", "prompt": "Reply with DONE" },
    { "role": "Worker 3", "prompt": "Reply with DONE" },
    { "role": "Worker 4", "prompt": "Reply with DONE" },
    { "role": "Worker 5", "prompt": "Reply with DONE" },
    { "role": "Worker 6", "prompt": "Reply with DONE" },
    { "role": "Worker 7", "prompt": "Reply with DONE" },
    { "role": "Worker 8", "prompt": "Reply with DONE" },
    { "role": "Worker 9", "prompt": "Reply with DONE" },
    { "role": "Worker 10", "prompt": "Reply with DONE" }
  ]
}
```

Set `set_fleet_timeout(fleet_id, 60000)` to 60s so the test runs fast.

## Saving as a template

```ts
await callTool("save_fleet_template", {
  name: "code-review-trio",
  description: "3-agent code review pipeline",
  agents: [
    { role: "Explorer", prompt: "...", agent: "codebase-onboarding-engineer" },
    { role: "Analyst",  prompt: "...", agent: "oracle" },
    { role: "Engineer", prompt: "...", agent: "backend-architect" }
  ]
});
```

Then spawn from the template:

```ts
await callTool("spawn_fleet", await callTool("spawn_from_template", { name: "code-review-trio" }));
```
