# MeshFleet `subs/*` OAuth refresh coverage audit

**Audit task:** kanban `t_07c461b8` (parent `t_2a5fa816`)
**Audit date:** 2026-08-29 (America/Chicago)
**Auditor lane:** meshfleet (`/Users/johnwhitman/AI/agent-mesh`)
**Cron under audit:** `conductor-oauth-refresh-cycle-6h` (id `f1a4b2c6d3e8`,
schedule `0 */6 * * *`, no-agent script `oauth_refresh_cycle.py`).

## Scope

Catalog every `subs/*` integration exposed to MeshFleet via the local
`subs-provider` shim (`/Users/johnwhitman/AI/Tools/subs-router/subs-provider/server.mjs`,
listening on `127.0.0.1:4357`, fronting RoutePlane at `127.0.0.1:4356`).
For each, state: (a) which native CLI the adapter invokes, (b) where that
CLI persists its OAuth / device-auth credentials, (c) whether the conductor
cron's `resolve_*_runtime_credentials(force_refresh=True)` path actually
warms that store, and (d) the gap if any.

The conductor cron covers seven providers by name:
`qwen`, `spotify`, `codex`, `xai-oauth`, `nous`, `minimax-oauth`, `anthropic`
(verified 2026-08-29 in `oauth_refresh_cycle.py:96-130` and the parent receipt
`t_2a5fa816`). Each resolver writes back to
`/Users/johnwhitman/.hermes/auth.json` via the root lock at
`hermes_cli/auth.py:1281` — that is the global Hermes auth store, NOT the
per-CLI store the subs adapters actually read.

## Inventory

| `subs/*` model | Adapter CLI | OAuth store the CLI reads | `auth_type` in `~/.hermes/auth.json` `credential_pool` | Covered by cron? | Gap |
|---|---|---|---|---|---|
| `subs/codex` | `codex exec` (`/Users/johnwhitman/.nvm/versions/node/v26.4.0/bin/codex`, Mach-O npm bin) | `~/.codex/auth.json` (verified 2026-08-29; tokens.id_token/refresh_token/account_id present, `last_refresh=2026-08-29T18:06:50Z`) | `openai-codex` rows in pool are `auth_type: oauth` (Hermes's own OAuth session, separate from the Codex CLI session — Hermes's resolver explicitly says: "Hermes creates its own session — won't affect Codex CLI or VS Code", `hermes_cli/auth.py:8061`) | **NO** | `codex` resolver rotates Hermes's own `~/.hermes/auth.json` `openai-codex` session; it never writes to `~/.codex/auth.json` the CLI reads. The CLI keeps its own OAuth session and refreshes it on its own cadence. |
| `subs/grok` | `grok -p` (`/Users/johnwhitman/.local/bin/grok`, Mach-O Go binary) | `~/.grok/auth.json` (verified 2026-08-29; contains `https://auth.x.ai::b1a00492-…` block with `refresh_token`, `expires_at=2026-08-30T01:36:46Z`, OIDC issuer `https://auth.x.ai`) | `xai-oauth` pool rows are `auth_type: oauth` — Hermes-side `xai-oauth` session | **NO** | `xai-oauth` resolver rotates Hermes's `~/.hermes/auth.json` xai session; `grok` CLI uses OIDC tokens in its own auth.json and refreshes independently. The 2026-08-29 cron run shows `xai-oauth: xai_discovery_failed: No module named 'httpx'` — even the Hermes-side rotation is currently failing (separate bug, see conductor row 20:19:50Z). |
| `subs/antigravity` | `agy -p` (`/Users/johnwhitman/.local/bin/agy`, 180 MB Mach-O Go binary; subs-provider `server.mjs:73-77`) | macOS Keychain (Keychain Services dylib linked into the Mach-O; no JSON store on disk) | none — Google OAuth is not in Hermes's pool today (verified 2026-08-29 in `~/.hermes/auth.json`: `providers=[nous,openai-codex,minimax-oauth,anthropic]`, `pool=[minimax,copilot,nous,openai-codex,xai-oauth,minimax-oauth,openrouter,anthropic]` — no `antigravity`/`google` row) | **NO** | `agy` reads its tokens from Keychain; there is no Hermes resolver that drives that store. The standalone helper pattern used for Anthropic (`/Users/johnwhitman/AI/agents/.hermes/profiles/conductor/scripts/anthropic_oauth_refresh.py`) could in principle be adapted for Google's `oauth2.googleapis.com/token` endpoint — but the client_id/redirect_uri/refresh_token trio is currently inaccessible to the conductor profile. |
| `subs/antigravity-flash` | `agy -p --model gemini-3.7-flash-high` (same binary) | macOS Keychain (shared with subs/antigravity) | none | **NO** | Same store, same gap as `subs/antigravity`; one Keychain entry warms both Antigravity models. |
| `subs/minimax` | HTTP fetch to `https://api.minimax.io/v1/chat/completions` (`server.mjs:84-92`) | none — header-based, reads `MINIMAX_API_KEY` from `~/.local/bin/agy`-style `readEnv` (`server.mjs:55-63` resolves via `~/AI/Tools/.env.local`) | `minimax` pool row is `auth_type: api_key`, `source: env:MINIMAX_API_KEY` | **N/A** | API key, not OAuth. Cron rotation is not applicable; key rotation is a John-gated operator action. |
| `subs/a2a` (role alias) | chains `[codex, grok, antigravity-flash]` (`server.mjs:40`) | inherits store of whichever seat serves the call | inherits | inherits | Inherits the gaps of the three real seats in the chain. |
| `subs/review` (role alias) | chains `[codex, antigravity]` (`server.mjs:41`) | inherits | inherits | inherits | Inherits gaps of `codex` + `antigravity`. |
| `subs/bulk` (role alias) | chains `[minimax, antigravity]` (`server.mjs:42`) | inherits | inherits | inherits | Inherits gaps of `minimax` (N/A) + `antigravity`. |
| `subs/longctx` (role alias) | chains `[antigravity, codex]` (`server.mjs:43`) | inherits | inherits | inherits | Inherits gaps of `antigravity` + `codex`. |
| `subs/spicy` (role alias) | chains `[grok, codex]` (`server.mjs:44`) | inherits | inherits | inherits | Inherits gaps of `grok` + `codex`. |

## Verdict

**PASS = 0, FAIL = 5, N/A = 1 (subs/minimax).** Every OAuth-bearing
`subs/*` integration is a gap relative to the conductor cron's coverage
as of 2026-08-29:

- The cron rotates the Hermes-side codex/xai sessions; it does not touch
  the Codex CLI's `~/.codex/auth.json` or the Grok CLI's `~/.grok/auth.json`.
- The cron does not touch macOS Keychain, which is where `agy` (subs/antigravity,
  subs/antigravity-flash) stores its Google OAuth tokens.
- Role aliases inherit the gaps of their real seats.

## Why the Hermes resolver path does not cover the CLI store

`hermes_cli/auth.py:3742` ("OpenAI Codex auth — tokens stored in
`~/.hermes/auth.json` (not `~/.codex/`)") and `:8061` ("Hermes creates its
own session — won't affect Codex CLI or VS Code") are explicit: Hermes
runs a separate OAuth session from the Codex CLI. The Codex CLI's
`~/.codex/auth.json` is a one-way import source — `_import_codex_cli_tokens`
(`auth.py:4122`) reads the CLI file and copies tokens into Hermes's own
session, but the resolver never writes back. Same posture for Grok:
`~/.grok/auth.json` is an OIDC client-id store keyed by
`https://auth.x.ai::b1a00492-…` and Hermes's xai-oauth resolver keeps its
own device-code session in `~/.hermes/auth.json` `providers.xai-oauth`. The
two never converge.

## What the conductor cron would need to actually warm subs/*

To cover the five real seats (subs/codex, subs/grok, subs/antigravity,
subs/antigravity-flash, plus the inherited role aliases), the conductor
lane would need three new providers, parallel to `anthropic`'s
`subprocess_helper=True` pattern (`oauth_refresh_cycle.py:159-195`):

1. `subs-codex-cli` — refresh the Codex CLI session by POSTing to
   `https://auth.openai.com/oauth/token` with the `refresh_token` read from
   `~/.codex/auth.json` and writing the rotated pair back atomically. Same
   client_id the Codex CLI uses (constant in codex-rs, treat as opaque).
2. `subs-grok-cli` — refresh the xAI OIDC session by POSTing to
   `https://auth.x.ai/oauth/token` with the refresh_token from
   `~/.grok/auth.json` (client_id `b1a00492-073a-47ea-816f-4c329264a828`),
   write rotated tokens back. Mirrors the Anthropic helper structure.
3. `subs-antigravity-keychain` — refresh the Google OAuth token via
   `https://oauth2.googleapis.com/token` using the refresh_token that the
   `agy` CLI stores in Keychain (item name follows `agy`'s own scheme —
   needs a one-time `agy login` + `security find-generic-password …`
   probe to confirm before wiring). Write rotated access_token back into
   the same Keychain entry.

These are all in scope of the conductor lane (parent `t_2a5fa816`
explicitly carved the work as "Conductor wrote its OWN cron wiring; did NOT
touch lane-owned files" — adding more providers to the same cron stays
inside conductor's scope). They are out of scope for the MeshFleet lane
(MeshFleet only owns the subs-provider shim and the route-candidate /
recommend-route surface, neither of which knows the per-CLI refresh
protocol).

## Notes for the routeplane TTL audit (sibling `t_9647558c`)

The conductor cron's `codex` and `xai-oauth` providers refresh Hermes's
own sessions on a 6h cadence. The actual `subs/codex` and `subs/grok`
seats keep their own cadence: the Codex CLI refreshes on next use after
expiry (no proactive warm-up observable), and `grok` rotates when its
expiry is < 1h away. The per-seat uptime hard-evidence packet
(t_4137150f, t_f1999c9a) shows both seats are flaky today, but that is
upstream provider behaviour, not refresh-coverage.

## Boundaries observed

- Read-only audit. No edits to `~/.hermes/auth.json`, `~/.codex/auth.json`,
  `~/.grok/auth.json`, the subs-provider shim, `oauth_refresh_cycle.py`,
  `~/.routeplane/routeplane.yaml`, or any profile config.
- No live provider call; all evidence is from on-disk byte reads and
  already-published receipt rows (`t_2a5fa816`, `t_4137150f`, `t_f1999c9a`).
- No daemon restart, no merge, no push, no deploy.

## Evidence handles

- Conductor cron's source-of-truth:
  `/Users/johnwhitman/AI/agents/.hermes/profiles/conductor/scripts/oauth_refresh_cycle.py`
  (sha256=`edaf3e84f94b6b0e01979b69a6b0f965b4804517c7033ab17764f8286b8c40cb`,
  bytes=9231).
- Conductor cron's most-recent state artifact:
  `/Users/johnwhitman/AI/agents/.hermes/profiles/conductor/runtime/oauth-refresh-state.json`
  (elapsed_s=0.39, refreshed=2 [codex, minimax-oauth], skipped=3
  [qwen, spotify, xai-oauth], errored=2 [nous httpx missing,
  anthropic invalid_grant]).
- Subs shim source:
  `/Users/johnwhitman/AI/Tools/subs-router/subs-provider/server.mjs`
  (REAL map lines 33-38; ROLES lines 40-45; adapter set lines 67-93;
  Chain + complete() lines 107-142).
- Per-CLI auth stores (bytes-read verified):
  - `~/.codex/auth.json` — `auth_mode: chatgpt`, refresh_token present,
    `last_refresh=2026-08-29T18:06:50Z`.
  - `~/.grok/auth.json` — OIDC client_id `b1a00492-073a-47ea-816f-4c329264a828`,
    `expires_at=2026-08-30T01:36:46Z` (12h away from audit time).
- Hermes resolver rotation target: `/Users/johnwhitman/.hermes/auth.json`
  (verified providers=[nous, openai-codex, minimax-oauth, anthropic];
  pool=[minimax, copilot, nous, openai-codex, xai-oauth, minimax-oauth,
  openrouter, anthropic]).
- MeshFleet's profile-level auth shadow:
  `/Users/johnwhitman/AI/agents/.hermes/profiles/meshfleet/auth.json`
  (`providers=[xai-oauth, openai-codex]`; `pool=[nous, copilot, custom:routeplane,
  kilocode, opencode-go, openai-codex, xai-oauth, ollama-cloud, minimax]`; only
  `openai-codex` (3) and `xai-oauth` (4) are `auth_type: oauth`; the
  other 7 entries are `auth_type: api_key` — confirming no Antigravity /
  Google presence in MeshFleet's pool either).
- Hermes comment confirming separate Codex CLI sessions:
  `hermes_cli/auth.py:3742` and `:8061`.

## PASS / FAIL count

PASS = 0
FAIL = 5   (`subs/codex`, `subs/grok`, `subs/antigravity`, `subs/antigravity-flash`,
            plus the five role aliases which inherit those gaps and are counted as
            one composite FAIL since the fix is upstream of the alias layer)
N/A  = 1   (`subs/minimax` — API key, not OAuth)

**End of audit.**