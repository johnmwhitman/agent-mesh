# Incident Timeline Window Design

## Purpose

MeshFleet already reconstructs an ordered local-ledger timeline with:

```text
agent-mesh inspect timeline [fleet]
```

That surface is useful for broad history, but it cannot isolate an incident
window and does not state what its timestamps establish. This slice adds a
bounded, read-only view without changing any unbounded timeline output.

## Operator contract

The existing command gains two optional flags:

```text
agent-mesh inspect timeline [fleet] [--from <bound>] [--to <bound>] [--json]
```

Each bound is either a digits-only epoch-millisecond value, an ISO date
(`YYYY-MM-DD`), or a timezone-bearing ISO datetime
(`YYYY-MM-DDTHH:mm:ss[.fraction](Z|±HH:mm)`). Calendar and clock fields must be
valid, and the result must decode to a finite safe epoch-millisecond integer.
Fractional precision is normalized to milliseconds. The interval is half-open:

- `--from` includes rows whose stored `ts` equals the lower bound.
- `--to` excludes rows whose stored `ts` equals the upper bound.
- either bound may be used alone;
- when both are present, `from_ms` must be less than `to_ms`.

The optional fleet filter and the time window are intersected. The clock source
is only the timestamp stored on each existing timeline row. The command does
not call `Date.now`, a provider, a network service, or an external clock.

With no bounds, the current text and JSON outputs remain byte-for-byte
unchanged.

## Windowed JSON

A bounded invocation emits the additive inspect envelope kind
`timeline_window`:

```json
{
  "schema": "meshfleet.inspect/v1",
  "kind": "timeline_window",
  "data": {
    "window": {
      "from_ms": null,
      "to_ms": 1710000000000,
      "interval": "half_open"
    },
    "fleet_id": null,
    "rows": [],
    "evidence": {
      "label": "local_ledger_timestamps",
      "nonclaims": [
        "authenticity",
        "completeness",
        "tamper_evidence",
        "authenticated_provenance",
        "external_time"
      ]
    }
  }
}
```

`from_ms`, `to_ms`, and `fleet_id` are present on every bounded response and
use `null` when absent. `rows` contain the unchanged `TimelineRow` objects.
No confidence score or authenticity label is attached to individual rows.

## Windowed text

A bounded text invocation prepends one evidence-ceiling line to the existing
timeline table:

```text
Local ledger timestamps in [from,to) · not authenticity, completeness, tamper evidence, authenticated provenance, or external time
```

The existing empty-result message follows the same preamble when no row falls
inside the window. An empty window is a successful read, not an error.

## Validation

The timeline subcommand accepts only:

- zero or one positional fleet ID;
- `--json`;
- one `--from` flag followed by one bound;
- one `--to` flag followed by one bound.

Unknown, repeated, or missing-value flags, extra positionals, invalid bounds,
and `from_ms >= to_ms` fail before reading the ledger. They write a stable
diagnostic to stderr and exit 2 without a JSON body.

## Boundaries and compatibility

This slice adds no MCP tool, persistence, verifier behavior, verifier confidence
band, event kind, dashboard contract, VS Code contract, causal expansion,
fingerprint, external timestamp anchor, or background process. It does not
touch A2A authentication, provider routing, drain or wrapper tooling,
Discussion, or lifecycle execution.

The window is a selection over local records. It does not establish
authenticity, completeness, tamper evidence, authenticated provenance, or
external time. The unchanged unbounded command retains its current output and
semantics.

## Test strategy

Focused tests will prove:

1. inclusive lower and exclusive upper bounds across existing row kinds;
2. independent lower-only and upper-only windows;
3. fleet and window intersection;
4. exact additive JSON shape and evidence nonclaims;
5. bounded text preamble plus unchanged table formatting;
6. epoch-millisecond and ISO-8601 parsing;
7. strict rejection of unknown, duplicate, missing, invalid, reversed, equal,
   and extra arguments;
8. successful empty windows;
9. byte-identical unbounded text and JSON output;
10. no ledger byte changes during a bounded read.
