# Meshfleet Inspector (VS Code)

See your agent fleets, receipts, and council votes in the sidebar — the read
side of "your agents did the work, **prove it**."

## What you get

- **Fleets view** — every fleet with its agents and live status (running /
  complete / failed), newest first.
- **Councils view** — quorum votes with approval progress and outcome.
- **Ledger verify in the status bar** — one click runs the full integrity
  audit (`agent-mesh --verify`); a clean ledger shows ✓, a ledger that asserts
  something its own records don't support shows ✗ with the findings in the
  output channel.
- **Ledger export** — open the whole ledger as pretty JSON.

## Requirements

The [meshfleet](https://www.npmjs.com/package/meshfleet) package must be
installed (workspace or global) — the extension reads the ledger through its
CLI and never opens the database directly:

```bash
npm install meshfleet
```

If the CLI lives somewhere unusual, set `meshfleet.cliCommand`.

## Read-only by design

This extension never writes to the ledger. Auditing that mutates the thing it
audits isn't auditing.
