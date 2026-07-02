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
git clone https://github.com/meshfleet/agent-mesh.git
cd agent-mesh
npm install
npm run build
```

### Run the test suite

```bash
npm test           # 26 unit tests, runs in <200ms
npm run typecheck   # tsc --noEmit
```

The test suite uses `node --test` with the `tsx` loader. Tests are isolated via an in-memory `setLedgerOverride` pattern — see `test/core.test.ts` for the approach.

### Dev workflow

```bash
npm run dev        # tsx watch — auto-rebuild on file changes
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
- **Pure data layer in `src/core.ts`.** MCP transport in `src/index.ts`. Keep them separate so the data layer can be unit-tested without spinning up an MCP server.
- **No external dependencies without discussion.** The current dependency footprint is intentionally small (one runtime dep: `@modelcontextprotocol/sdk`).
- **Update specs** when you change architecture. `AGENT-MESH-SPEC.md` and `SPEC-P2P.md` are the source of truth.

## Reporting issues

Open a GitHub issue with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Environment (Node version, OpenCode version, OS)
- Relevant logs from `~/.config/opencode/agent-mesh.json` (redact sensitive data)

## Security issues

**Do not open a public GitHub issue for security vulnerabilities.** See [SECURITY.md](./SECURITY.md) for the reporting process.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
