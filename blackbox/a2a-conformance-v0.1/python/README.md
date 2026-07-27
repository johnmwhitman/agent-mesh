# Python Raw Stdio Parity Witness v0.1

This dependency-free Python 3 client independently speaks MCP JSON-RPC to the
real Meshfleet stdio server. It does not import the MCP SDK, invoke the
JavaScript witness, or copy an existing receipt.

```sh
npm run build
python3 blackbox/a2a-conformance-v0.1/python/runner.py --self-test
node blackbox/a2a-conformance-v0.1/python/differential.mjs --self-test
node blackbox/a2a-conformance-v0.1/wire/runner.mjs \
  > /tmp/meshfleet-node-wire-receipt.json
python3 blackbox/a2a-conformance-v0.1/python/runner.py \
  > /tmp/meshfleet-python-wire-receipt.json
node blackbox/a2a-conformance-v0.1/python/differential.mjs \
  /tmp/meshfleet-node-wire-receipt.json \
  /tmp/meshfleet-python-wire-receipt.json
```

The runner consumes the same pinned, language-neutral transcript fixture as
the Node witness. It executes both complementary fragmentation profiles,
including byte-by-byte fragmentation through a non-BMP UTF-8 code point. It
then validates:

- `initialize` followed by `notifications/initialized`.
- Strict LF-delimited UTF-8 JSON-RPC response framing through stdout EOF.
- Rejection of duplicate JSON object members at every nesting level.
- Exact response-ID correlation.
- Empty-object ping behavior.
- The established canonical tool-catalog SHA-256.
- Stable `get_health` response fields and exact unknown-tool rejection.
- Equal normalized transcript digests across both launch profiles.
- Agreement with the independent Node witness on catalog and profile identity.

The client passes a minimal environment and redirects its home/config roots,
database, data file, data directory, and event log to a process-local
temporary directory. This limits named state exposure; it is not an OS
filesystem or network sandbox. Normal completion requires stdout EOF with no
extra or partial frame and then a zero exit after stdin closes. Failure
cleanup is bounded and targets the process group on POSIX. Live Windows
execution fails closed pending Job Object ownership; `taskkill /T` against a
live root is not sufficient evidence for descendants after root exit.

The co-located contract pins the shared fixture, catalog, and built
entrypoint hashes for review and drift detection. The runner requires the
contract command to be exactly `node dist/index.js`, resolves `node` to an
absolute executable before launch, and hashes that exact entrypoint before
execution. Those pins are not tamper-proof by themselves; the branch commit
and independent review bind the evidence.

The differential comparator launches no processes. It accepts two
independently generated receipt files, rejects paths observed as symlinks and
opened descriptors that are non-regular, caps each read at 4 MiB, rejects
duplicate JSON members, requires fatal UTF-8 decoding and exactly one
LF-terminated JSON line, and pins the exact v0.1 witness identities, profiles,
checks, and Python artifact hashes. Witness supervision therefore remains
independent from bounded comparison. On platforms without `O_NOFOLLOW`, this
does not claim protection against a concurrent hostile path replacement.

## Evidence boundary

- This proves an independent Python client can interoperate with the local
  Meshfleet stdio server for the pinned valid-path transcript.
- The server remains the Node artifact under test; this is client-language
  parity, not a Python server implementation.
- The JavaScript fault suite remains the executable evidence for the nine
  server-side negative transport classes. Python self-tests cover its strict
  JSON, framing completion, output cap, Unicode scalar, and response-ID
  helpers, but do not duplicate the complete executable server-fault corpus.
- The differential comparator validates local receipt content but cannot
  authenticate which process produced an unsigned file. Its PASS receipt marks
  provenance `UNAUTHENTICATED_LOCAL_FILES`; branch commits, commands, and
  independent review remain the provenance boundary.
- It does not claim byte-identical raw responses; dynamic diagnostics and
  response sizes remain profile-local.
- Windows live execution is held until a Job Object-backed process-tree
  implementation and a native Windows receipt exist.
- This is not named-client, remote transport, provider, or full MCP/A2A
  conformance evidence.
