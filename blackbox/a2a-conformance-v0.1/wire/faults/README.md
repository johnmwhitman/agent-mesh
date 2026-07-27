# Raw Stdio Executable Fault Suite v0.2

This meta-runner launches the real raw stdio witness against byte-pinned local
fixture servers. Each negative fixture violates one wire invariant and must
produce one exact structured failure class and message through the witness's
live parser, correlator, or lifecycle path.

```sh
node blackbox/a2a-conformance-v0.1/wire/faults/meta-runner.mjs
```

## Cases

Negative cases:

- `INVALID_JSON`: stdout pollution.
- `INVALID_UTF8`: malformed UTF-8.
- `WRONG_RESPONSE_ID`: response for an unknown request.
- `DUPLICATE_SETTLED_ID`: duplicate response after a valid match.
- `TRAILING_FRAME`: EOF with non-LF-terminated bytes.
- `OVERSIZED_LINE`: frame exceeds the line cap.
- `REQUEST_TIMEOUT`: open child that does not respond.
- `CHILD_EXIT`: deterministic exit after reading the request.
- `INVALID_RESPONSE`: malformed JSON-RPC response envelope.

Controls:

- Stderr noise remains outside the protocol stream.
- An honest minimal initialize response passes.

## Anti-cheating controls

- The case manifest has an exact required case and fixture set.
- Every fixture is SHA-256 pinned and realpath-contained.
- Extra fixture-directory entries, symlinks, directories, and non-regular
  files are rejected.
- Fixture source using process-spawning, worker, cluster, or detaching APIs is
  rejected.
- Fault cases require exact class, exact message, exactly one fault event, and
  an exact ordered correlation trace.
- Outer results must be one fatal-UTF-8 atomic JSON line with the expected exit
  state.
- Timeouts and output are bounded.
- POSIX process-group liveness is checked after every case and escalated through
  TERM and KILL if needed.

## Boundary

On Windows, timeout cleanup uses bounded, awaited `taskkill /T`. For normal
completion, descendant evidence is limited to the exact byte-pinned fixture set
that is prohibited from using process-spawning or detaching APIs. This suite
does not claim arbitrary Windows descendant discovery, OS sandboxing, full MCP
or A2A conformance, or named-client compatibility.
