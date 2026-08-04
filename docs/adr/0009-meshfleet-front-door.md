# ADR 0009 — the `meshfleet` bin gets a front door

**Status:** accepted (2026-08-04) · **Slice:** S2, first-run path

## Context

`meshfleet` names two different callers of the same command:

- an MCP host launching a stdio server (`npx meshfleet`, no arguments, sometimes
  with wrapper noise appended by the host), and
- a human who read the package name and typed `npx meshfleet doctor`.

Before this change only the first caller existed. `bin.meshfleet` pointed at
`dist/index.js`, which is a pure MCP server with no argv handling at all. A human
typing `npx meshfleet doctor` got no error, no output, and no exit: the server
booted, ignored the argument, and waited on stdin. Exit code 0.

The human-facing CLI (`inspect`, `doctor`, `demo`) lived only on the second bin,
`agent-mesh` — a name that appears nowhere in the package name, the site, or the
install instruction. That is the hour-one abandon the S2 slice targets.

## Decision

### 1. An asymmetric dispatch, not a symmetric one

`src/entry-mode.ts` resolves argv to `mcp` or `cli`. The two failure modes are
not equally bad:

| mistake | consequence |
|---|---|
| human typed a command, we boot the server | they see a hang — annoying, recoverable |
| host launched the server, we run the CLI | the install dies mid-handshake, silently |

So the rule is deliberately lopsided: **only an exact, closed allowlist of tokens
in first position diverts to the CLI. Everything else boots the server, exactly
as before this file existed** — unknown flags, `--stdio`, `--`, config paths,
empty argv. A token in any position but the first does not count.
`MESHFLEET_MCP=1` forces server mode unconditionally, so a future collision is a
one-env-var fix rather than a release.

The allowlist is pinned by a test, so growing it is a deliberate reviewed act.

`dist/index.js` remains a valid direct entry point; host configs naming it
explicitly are untouched.

### 2. `init` prints. It does not write.

Host config layouts drift (global vs per-project, JSON vs JSONC, differing key
names). A merge bug in `init` would break a config that was already working —
strictly worse than the problem it solves — and "idempotent write" is a claim we
cannot back without golden fixtures per host per version. `meshfleet init [host]`
prints the block and the path it belongs in; the user does the paste and keeps
authority over their own files. A test reads `init.ts` back and fails if it ever
references a write API.

### 3. Doctor learns the check the other six could not make

Every pre-existing check can pass while the server boots, says nothing, and hangs
— which is the exact shape of the bug above. `checkMcpHandshake` spawns the
server entry, speaks a real MCP `initialize`, and requires an answer inside a
timeout. **A hang reads as a failure**, with a fix line naming the command to run
by hand.

The probe is hard-isolated: it redirects `MESHFLEET_DB_FILE` and both the current
and legacy event-log env names into a temp dir, and sets `AGENT_MESH_CHILD=1` so
it neither touches the live ledger nor races the running server for the SSE port.
This is a direct consequence of the 2026-08-03 incident where a demo harness
spawned the real server without redirecting the db path and wrote a synthetic
fleet into the shared ledger. **A diagnostic that can corrupt what it diagnoses is
worse than no diagnostic.** `--no-spawn` runs the synchronous checks only.

## Cut from this slice (and why)

- **Runtime-availability check** ("which runtimes can spawn workers") — second
  order. A user who cannot complete a handshake never reaches runtime selection.
- **A separate "MCP wire" check** — subsumed by the handshake; two checks for one
  property is one check and one decoration.
- **Host auto-detection and an interactive wizard** — print one correct block per
  named host; detection is guesswork that fails silently on the layouts that
  matter.

## Consequences

- `bin.meshfleet` now points at `dist/bin/meshfleet.js`.
- `doctorMain` is async (it awaits the probe). The `agent-mesh doctor` dispatch
  already awaited it through its promise chain.
- Doctor's header now reads `meshfleet doctor`, matching the command typed.
- Tool count unchanged (36). This is a CLI surface, not an MCP tool; the site
  stays true.
