# Examples

Concrete, working examples of how to use Agent Mesh. Each one is self-contained — copy, paste, run.

## Available examples

| Example | What it does |
|---|---|
| [`codebase-exploration.md`](codebase-exploration.md) | Spawn a 3-agent fleet to map, analyze, and plan a refactor of any codebase |
| [`design-review.md`](design-review.md) | Multi-perspective design review (frontend + security + reviewer) |
| [`ci-triage.md`](ci-triage.md) | Triage a CI failure, attach a debugger, surface root causes |

## Pattern

Each example is a single file containing:
1. **The scenario** — what problem you're solving
2. **The fleet spec** — the exact `spawn_fleet` call (TypeScript)
3. **The agent prompts** — what each agent is asked to do
4. **Expected output** — what the mesh produces
5. **Variations** — how to adapt the pattern for similar problems

## Running an example

```bash
# 1. Install Agent Mesh (see /docs/install)
# 2. Copy the spawn_fleet call from any example into your OpenCode session
# 3. OpenCode executes the MCP tools, Meshfleet spawns the agents
# 4. Watch the agents collaborate via P2P messages
# 5. Run `npx agent-mesh inspect` to see the fleet state
```

## Contributing an example

Have a scenario we should cover? Open a PR adding a new `examples/<your-scenario>.md` file following the pattern above. We especially want examples that show:

- Real production use cases (not toy scenarios)
- Concrete prompts that produce good output
- Failure modes and how to recover
- Edge cases that taught you something

See [CONTRIBUTING.md](https://github.com/johnmwhitman/agent-mesh/blob/main/CONTRIBUTING.md).