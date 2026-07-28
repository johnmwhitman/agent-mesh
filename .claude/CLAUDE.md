# MeshFleet — agent-mesh

Auditable multi-agent coordination MCP server. npm package: `meshfleet`.

## Quick start

`/meshfleet` — activates autonomous development with fleet orchestration. Reads HANDOFF.md,
picks the next slice, dispatches to the fleet, builds, tests, iterates.

## Key files

- `HANDOFF.md` — ground truth for session continuity (commit SHA, suite counts, queue)
- `COMPATIBILITY.md` — tool surface promises and narrowing history
- `test/fixtures/corpus/manifest.json` — falsification corpus (74 vectors)
- `blackbox/` — 12 A2A conformance witnesses

## Rules

- **npm publish is Tier C** (John only) — never run `npm publish`
- Push only when `npm test` shows 0 fail
- Rebuild `dist/` and re-pin conformance catalog after any `inputSchema` edit
- Probe live server for schema ground truth — never grep static source for discussion tools
- Fleet work must be bounded and merge within session — no parking lanes
- No provider wrappers or catalogs in core

## Fleet routing

```
~/AI/Tools/grk "..."   # Grok — reasoning, review, evaluator drafts (unlimited)
~/AI/Tools/mmx "..."   # MiniMax — bulk text, corpus gen, Python evaluators (cheap)
~/AI/Tools/cdx "..."   # Codex — final verdicts, merge safety (scalpel)
~/AI/Tools/agx "..."   # Antigravity — design, UX, long-context (design weak spot)
```

Dispatch BEFORE doing. Claude context is for orchestration and verification only.
