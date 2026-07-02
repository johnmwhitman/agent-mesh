# Contributing to Agent Mesh

Thanks for your interest in contributing! Agent Mesh is an open-source MCP server that powers peer-to-peer agent orchestration for OpenCode. Every contribution helps.

## Code of conduct

This project follows the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). Be respectful. Assume good faith. Focus on the work, not the person.

## Development setup

### Prerequisites

- Node.js 18 or later
- npm (or pnpm / yarn)
- OpenCode CLI in `$PATH` (`brew install anomalyco/tap/opencode` or download from [opencode.ai](https://opencode.ai))
- Git

### Clone and build

```bash
git clone https://github.com/johnmwhitman/agent-mesh.git
cd agent-mesh
npm install
npm run build
```

### Run the test suite

```bash
npm test           # 51 unit tests, runs in <200ms
npm run typecheck   # tsc --noEmit
```

The test suite uses `node --test` with the `tsx` loader. Tests are isolated via an in-memory `setLedgerOverride` pattern — see `test/core.test.ts` and `test/inspector.test.ts` for the approach.

### Dev workflow

```bash
npm run dev        # tsx watch — auto-rebuild on file changes
npm run inspect    # run the CLI inspector against your real ledger
```

## Pull request process

1. **Fork** the repo and create a feature branch: `git checkout -b feat/your-feature`
2. **Write tests first**. New behavior must have a failing test that becomes passing. Bug fixes must have a regression test.
3. **Match the existing style**. The codebase is TypeScript strict mode, ESM, single quotes, no semicolons inside imports. Look at neighboring code before adding new files.
4. **Run the full suite** before opening the PR:
   ```bash
   npm test && npm run typecheck && npm run build
   ```
5. **Write a clear commit message** following [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat: <description>` for new features
   - `fix: <description>` for bug fixes
   - `chore: <description>` for maintenance
   - `docs: <description>` for documentation only
   - `refactor: <description>` for code changes that neither fix nor add
6. **Open the PR** with:
   - Summary of what changed and why
   - Test plan (which scenarios you ran)
   - Any breaking changes called out in `BREAKING CHANGE:` footer

## Coding conventions

- **TypeScript strict mode.** No `any`, no `@ts-ignore`. Use `unknown` and narrow.
- **ESM only.** This package is `"type": "module"`. Use `.js` extensions in imports.
- **Pure data layer in `src/core.ts`.** MCP transport in `src/index.ts`. CLI tools in `src/bin/`. Keep them separate so the data layer can be unit-tested without spinning up an MCP server.
- **Pure formatting in `src/inspector.ts`.** No I/O, no side effects — easy to test.
- **No external dependencies without discussion.** The current dependency footprint is intentionally small (one runtime dep: `@modelcontextprotocol/sdk`).
- **Update specs** when you change architecture. `AGENT-MESH-SPEC.md` and `SPEC-P2P.md` are the source of truth.

## Reporting issues

Open a GitHub issue with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Environment (Node version, OpenCode version, OS)
- Relevant output from `npx agent-mesh inspect` (redact sensitive data)
- If related to a fleet crash, include the contents of `~/.config/opencode/agent-mesh.events.log` (last 50 lines)

## Good first issues

Look for issues labeled `good first issue`. These are scoped, well-defined, and a good way to learn the codebase. If you don't see any, open one and ask — there are always more things to build.

## Security issues

**Do not open a public GitHub issue for security vulnerabilities.** See [SECURITY.md](./SECURITY.md) for the reporting process.

## Architecture overview

```
src/
├── core.ts          # Pure data layer: ledger, messages, capabilities, events
├── inspector.ts     # Pure formatters for CLI output
├── index.ts         # MCP server: transport, tool handlers
└── bin/
    └── inspect.ts   # CLI: `npx agent-mesh inspect`
```

The data layer (`core.ts`) is the only place that reads/writes the JSON ledger. The MCP server (`index.ts`) imports it for tool handlers. The CLI (`bin/inspect.ts`) imports it directly. This separation lets us test the data layer without spinning up an MCP server, and test the formatters without touching the filesystem.

## Adding a new MCP tool

1. Add the pure function to `src/core.ts` (e.g. `getFleetMetrics`).
2. Add the tool schema to `src/index.ts` (the `tools` array in `ListToolsRequestSchema`).
3. Add the handler in `src/index.ts` (the `CallToolRequestSchema` block).
4. Add unit tests to `test/core.test.ts` (or a new `test/your-feature.test.ts`).
5. Update `docs/api` on meshfleet.app (or submit a PR to the website repo).
6. Add a CHANGELOG entry under `[Unreleased]`.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
