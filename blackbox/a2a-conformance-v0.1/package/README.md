# Packaged Stdio Catalog-Boundary Conformance

This additive runner tests the locally packed npm artifact rather than the
source-tree server. It creates a fresh temporary consumer, installs the tarball
offline with lifecycle scripts disabled, explicitly rebuilds only
`better-sqlite3` from source, and runs the parent catalog-boundary oracle
against the installed package.

```sh
npm run build
node blackbox/a2a-conformance-v0.1/package/runner.mjs
```

The runner fails closed unless:

- `npm pack` reports one tarball containing `dist/index.js`.
- The tarball installs into a fresh consumer in offline mode.
- Published `main` and `bin` entrypoints resolve inside the installed package.
- Direct dependency specs and installed versions match the trusted root lock.
- The MCP client SDK resolves from the fresh consumer, not an ancestor tree.
- The installed server reproduces the pinned catalog and read-only oracles.
- npm, native-build, and inherited-harness subprocesses remain within bounded
  output, execution, and termination policies.

The report includes artifact metadata and bounded transitive dependency drift.
Transitive drift is advisory because the package declares ranges; consumers
need their own lock policy.

## Nonclaims

- This is not full A2A, MCP-spec, or named-client compatibility evidence.
- This is not a hermetic build or an operating-system network/filesystem
  sandbox.
- Passing requires a local native build toolchain.
- Passing does not prove script-free production runtime readiness.
- The locally observed tarball digest is evidence, not an independently pinned
  release digest or publication approval.
