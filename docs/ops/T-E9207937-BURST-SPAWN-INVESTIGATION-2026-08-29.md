# Burst-spawn rate-limit investigation (t_e9207937)

**Date**: 2026-08-29  
**Incident**: Two production ratifications (R2 t_15b01212 + R3 t_5cf0eaa1) failed to reach quorum on 2026-08-27T14:36Z / 15:07Z because all 8 spawned opencode-cli agents hung indefinitely waiting on the upstream model path.

## Root cause

**No concurrency limit at fleet spawn level.**

`src/lifecycle-execution.ts` line 314:
```typescript
for (const spec of specs) this.launch(spec.agentId);
```

This is a synchronous for-loop that calls `launch()` for each agent in the fleet without any backpressure or rate limiting.

`src/lifecycle-execution.ts` line 468:
```typescript
void this.runtime.start(spec).then((handle) => { ... });
```

The runtime start is fire-and-forget (`void`), so all agents in a fleet launch concurrently. Each agent gets its own 30-minute timeout (`DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000` in `src/spawn-config.ts` line 22).

The OpenCode runtime adapter (`src/runtime/opencode.ts`) calls `startProcessExecution` with no queue or concurrency gate. When 8 agents are spawned simultaneously, they all hit the upstream provider (opencode-go/minimax-m3) at once.

## Why the hang is silent

The upstream provider either:
1. Rate-limits silently (no error response, just no progress), or
2. The runtime fails to surface the failure promptly (no early timeout on "no output received" heuristic).

The 30-minute fleet timeout is the only backstop, and it's too long for a rate-limit signal. R1 completed in <2 minutes when uncontended, proving the path works when not burst-spawned.

## Recommendations

### 1. Fleet-level concurrency limit (HIGH PRIORITY)

Add a configurable max-concurrent-agents-per-fleet (default: 4) at the spawn_fleet entrypoint. When the limit is reached, queue remaining agents and launch them as running agents complete.

**Implementation sketch**:
```typescript
// In lifecycle-execution.ts spawnFleet()
const maxConcurrent = resolveEnv(env, "MESHFLEET_MAX_CONCURRENT_AGENTS", "4");
const launchQueue: string[] = [];
for (const spec of specs) {
  if (this.handles.size >= maxConcurrent) {
    launchQueue.push(spec.agentId);
  } else {
    this.launch(spec.agentId);
  }
}
// Schedule queue drain on handle completion
```

### 2. Pre-flight health check (MEDIUM PRIORITY)

Before spawn_fleet, probe the upstream provider with a lightweight request (e.g., a minimal prompt with max_tokens=1). If the probe times out or returns an error, fail the fleet spawn immediately with a clear error ("upstream provider unavailable") rather than launching 8 agents that will hang.

**Implementation sketch**:
```typescript
// In spawn_fleet tool handler (index.ts)
const probeResult = await runtime.probeHealth({ timeoutMs: 5000 });
if (!probeResult.healthy) {
  return { error: `Upstream provider unavailable: ${probeResult.error}` };
}
```

### 3. Early-failure heuristic on "no output" (MEDIUM PRIORITY)

Add a secondary timeout: if an agent has not produced any stdout/stderr within 60 seconds of launch, cancel it and mark it failed with error "no output received within 60s (possible upstream rate-limit)". This surfaces the failure mode promptly instead of waiting for the 30-minute fleet timeout.

**Implementation sketch**:
```typescript
// In opencode.ts runtime adapter
const noOutputTimeout = setTimeout(() => {
  if (handle.bytesReceived === 0) {
    this.cancel(handle, "no output received within 60s");
  }
}, 60_000);
```

### 4. Alternative model path (LOW PRIORITY)

Investigate whether routeplane/moonshotai/kimi-k3 (per memory) has better burst-spawn behavior. If so, document it as the preferred path for high-concurrency ratifications.

## Test recipe

After implementing recommendation 1 (concurrency limit):

```bash
# Spawn 3 concurrent fleets, each with 4 agents
for i in 1 2 3; do
  meshfleet spawn_fleet --agents 4 --prompt "test" &
done

# All 12 agents should complete within 5 minutes
# (4 concurrent per fleet × 3 fleets = 12 agents, but only 4 run at a time per fleet)
wait
echo "All fleets completed"
```

Expected: all 12 agents complete within 5 minutes (no 30-minute hangs).

## Evidence handles

- Investigation note: `docs/ops/T-E9207937-BURST-SPAWN-INVESTIGATION-2026-08-29.md`
- Root cause location: `src/lifecycle-execution.ts:314` (synchronous launch loop), `src/lifecycle-execution.ts:468` (fire-and-forget runtime.start)
- Timeout config: `src/spawn-config.ts:22` (DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000)
- Incident evidence: `/Users/johnwhitman/AI/agents/.hermes/kanban/workspaces/t_15b01212/R2-EVIDENCE.md`

## Lane ownership

This is owned by the meshfleet lane. Conductor will not work on it. The two retry cards (R2 retry t_764d77bb, R3 retry if needed) should NOT be claimed until the lane signals the contention is resolved or an alternative path is identified.
