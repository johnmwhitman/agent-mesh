# AGENTS.md — agent-mesh (MeshFleet Core)

**Purpose:** MeshFleet's engine — fleet dispatch, receipts, ledgers, A2A profiles, MCP server.
`meshfleet-app` (marketing) and `meshfleet-pro` (parked commercial) are separate, read-only here.

**Hermes lane owner:** `meshfleet` profile (`<home>/AI/agents/.hermes/profiles/meshfleet`), specialist
under Conductor. Cross-lane matters → Conductor (`<home>/AI/CONDUCTOR-QUEUE.md`).

**Law, in order:** `docs/ops/GOAL-PROMPT.md` (the verifier + laws) → `HANDOFF.md` → `ROADMAP.md`
→ this file. Product queue = HANDOFF/GOAL-PROMPT open items; receipts append to the lane's
`<home>/AI/agents/.hermes/profiles/meshfleet/QUEUE.md` (~170K — read with `tail`, never whole).

**Verifier (the only definition of green):** pinned Node **24.18.1** (`.nvmrc`), never shell Node 26.
```
export MESHFLEET_EVENT_LOG_FILE="$(mktemp -t meshfleet-verify-events)"
npm run typecheck && npm run build && node scripts/run-tests.mjs
```
Build BEFORE test (`mcp-stdio.test.ts` packs the package). Set only that env var — setting
`MESHFLEET_DATA_FILE` forces every test onto one ledger (479 false failures). Run to a file, test `$?`.

**Branch/PR rules:** isolated worktrees for code; feature branches; `VERIFIED:` commit subjects;
never merge/push protected branches, force-push, or delete worktrees. Redeploy the installed MCP
copy after changes — the running tools are a third copy, not this tree.

**Don't:**
- Treat `status=completed`, `verify_ledger ok:true`, or a fleet summary as evidence — read the bytes.
- Mutate live ledgers, provider config, or RoutePlane from here (infrastructure, not product scope).
- Broadcast, spend, rotate credentials, deploy, or touch CarMart.
