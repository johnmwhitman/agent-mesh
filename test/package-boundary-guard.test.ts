import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  findPackageBoundaryViolations,
  listCoreSourceModulePaths,
  listPackedDistSourceModulePaths,
  listProductionDependencyGroups,
  listProductionDependencyRoots,
} from './helpers/package-boundary-guard.js'

const APPROVED_CORE_SOURCE_MODULES = [
  'a2a/codec.ts',
  'a2a/delivery-trace.ts',
  'a2a/legacy-map.ts',
  'a2a/local-admission.ts',
  'a2a/replay-decision.ts',
  'a2a/static-harness-mapping.ts',
  'a2a/types.ts',
  'attempt-lifecycle.ts',
  'bin/dashboard.ts',
  'bin/fleetbudget-sanitize.ts',
  'bin/inspect.ts',
  'bin/routeplane-catalog.ts',
  'budget-awareness.ts',
  'compile-route-candidates.ts',
  'core.ts',
  'db.ts',
  'demo.ts',
  'discussion-mcp.ts',
  'discussion-store.ts',
  'discussion.ts',
  'doctor.ts',
  'env.ts',
  'fleetbudget-observations.ts',
  'fleetbudget-sanitizer.ts',
  'health.ts',
  'heartbeat.ts',
  'index.ts',
  'inspector.ts',
  'lifecycle-execution.ts',
  'lifecycle-visibility.ts',
  'migrate.ts',
  'ratify.ts',
  'realtime.ts',
  'recommend-route.ts',
  'retry.ts',
  'route-candidate-validation.ts',
  'routeplane-catalog.ts',
  'routing-feedback.ts',
  'runtime/local-process.ts',
  'runtime/opencode.ts',
  'runtime/process.ts',
  'runtime/registry.ts',
  'runtime/types.ts',
  'skill-taxonomy.ts',
  'spawn-attempt.ts',
  'spawn-config.ts',
  'spawn-result.ts',
  'speculative-backlog-planner.ts',
  'sse-server.ts',
  'synonyms.ts',
  'templates.ts',
  'tool-args.ts',
  'verify-envelope-v2.ts',
  'verify-envelope-v3.ts',
  'verify.ts',
  'wrapper-usage-observations.ts',
] as const

const APPROVED_PRODUCTION_DEPENDENCY_ROOTS = [
  '@modelcontextprotocol/sdk',
  'better-sqlite3',
] as const

const APPROVED_PRODUCTION_DEPENDENCY_GROUPS = {
  dependencies: APPROVED_PRODUCTION_DEPENDENCY_ROOTS,
  optionalDependencies: [],
  peerDependencies: [],
} as const

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function withFixture(
  files: Record<string, string>,
  packageJson: Record<string, unknown>,
  run: (root: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), 'meshfleet-package-boundary-'))
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify(packageJson))
    for (const [relativePath, text] of Object.entries(files)) {
      const file = join(root, relativePath)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, text)
    }
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('package boundary guard rejects an undeclared external package imported by source', () => {
  withFixture(
    { 'src/entry.ts': 'import value from "not-declared"\nvoid value\n' },
    { name: 'fixture', dependencies: {} },
    (root) => {
      const violations = findPackageBoundaryViolations(root)

      assert.deepEqual(violations, [
        {
          file: 'src/entry.ts',
          kind: 'import',
          specifier: 'not-declared',
          reason: 'external package "not-declared" is not declared in dependencies, optionalDependencies, or peerDependencies',
        },
      ])
    },
  )
})

test('package boundary guard permits production declarations and Node builtins but rejects dev-only packages', () => {
  withFixture(
    {
      'src/entry.ts': [
        'import dependency from "declared"',
        'import optional from "optional"',
        'import peer from "peer"',
        'import scoped from "@scope/declared/subpath"',
        'import { readFileSync } from "node:fs"',
        'import { join } from "path"',
        'import devOnly from "development-only"',
        'void [dependency, optional, peer, scoped, readFileSync, join, devOnly]',
      ].join('\n'),
    },
    {
      name: 'fixture',
      dependencies: { declared: '1.0.0', '@scope/declared': '1.0.0' },
      optionalDependencies: { optional: '1.0.0' },
      peerDependencies: { peer: '1.0.0' },
      devDependencies: { 'development-only': '1.0.0' },
    },
    (root) => {
      assert.deepEqual(findPackageBoundaryViolations(root), [
        {
          file: 'src/entry.ts',
          kind: 'import',
          specifier: 'development-only',
          reason: 'external package "development-only" is not declared in dependencies, optionalDependencies, or peerDependencies',
        },
      ])
    },
  )
})

test('package boundary guard inspects re-exports, type-only imports, dynamic imports, and literal require calls', () => {
  withFixture(
    {
      'src/entry.ts': [
        'export { value } from "missing-export"',
        'import type { Shape } from "missing-type"',
        'void import("missing-dynamic")',
        'const loaded = require("missing-require")',
        'void loaded',
      ].join('\n'),
    },
    { name: 'fixture' },
    (root) => {
      assert.deepEqual(
        findPackageBoundaryViolations(root).map(({ kind, specifier }) => ({ kind, specifier })),
        [
          { kind: 'export-from', specifier: 'missing-export' },
          { kind: 'import-type', specifier: 'missing-type' },
          { kind: 'dynamic-import', specifier: 'missing-dynamic' },
          { kind: 'require', specifier: 'missing-require' },
        ],
      )
    },
  )
})

test('package boundary guard resolves emitted relative JavaScript specifiers inside src', () => {
  withFixture(
    {
      'src/entry.ts': [
        'import "./nested/module.js"',
        'import "./missing.js"',
        'import "../outside.js"',
      ].join('\n'),
      'src/nested/module.ts': 'export const value = 1\n',
    },
    { name: 'fixture' },
    (root) => {
      assert.deepEqual(
        findPackageBoundaryViolations(root).map(({ specifier, reason }) => ({ specifier, reason })),
        [
          {
            specifier: './missing.js',
            reason: 'relative specifier does not resolve to a source module under src',
          },
          {
            specifier: '../outside.js',
            reason: 'relative specifier resolves outside src',
          },
        ],
      )
    },
  )
})

test('package boundary guard ignores import-shaped comments and strings', () => {
  withFixture(
    {
      'src/entry.ts': [
        '// import value from "not-declared"',
        'const text = "require(\\\"not-declared\\\")"',
        'const dynamic = "import(\\\"not-declared\\\")"',
        'void [text, dynamic]',
      ].join('\n'),
    },
    { name: 'fixture' },
    (root) => assert.deepEqual(findPackageBoundaryViolations(root), []),
  )
})

test('package boundary guard accepts the repository source tree', () => {
  const repoRoot = join(fileURLToPath(new URL('..', import.meta.url)))
  assert.deepEqual(findPackageBoundaryViolations(repoRoot), [])
})

test('public Core source module baseline is exact', () => {
  const repoRoot = join(fileURLToPath(new URL('..', import.meta.url)))
  assert.deepEqual(listCoreSourceModulePaths(repoRoot), APPROVED_CORE_SOURCE_MODULES)
})

test('public Core production dependency baseline is exact', () => {
  const repoRoot = join(fileURLToPath(new URL('..', import.meta.url)))
  assert.deepEqual(listProductionDependencyRoots(repoRoot), APPROVED_PRODUCTION_DEPENDENCY_ROOTS)
  assert.deepEqual(listProductionDependencyGroups(repoRoot), APPROVED_PRODUCTION_DEPENDENCY_GROUPS)
})

test('packed tarball contains exactly the approved Core modules', { timeout: 30_000 }, () => {
  const repoRoot = join(fileURLToPath(new URL('..', import.meta.url)))
  const temp = mkdtempSync(join(tmpdir(), 'meshfleet-package-boundary-pack-'))
  try {
    const build = spawnSync(NPM, ['run', 'build'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, npm_config_update_notifier: 'false' },
      shell: process.platform === 'win32',
    })
    assert.equal(build.status, 0, build.stderr || build.stdout)

    const pack = spawnSync(NPM, ['pack', '--json', '--pack-destination', temp], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, npm_config_update_notifier: 'false' },
      shell: process.platform === 'win32',
    })
    assert.equal(pack.status, 0, pack.stderr || pack.stdout)
    const packed = JSON.parse(pack.stdout) as Array<{
      filename: string
      files: Array<{ path: string }>
    }>
    assert.equal(packed.length, 1)
    assert.equal(existsSync(join(temp, packed[0]!.filename)), true)
    assert.deepEqual(
      listPackedDistSourceModulePaths(packed[0]!.files),
      APPROVED_CORE_SOURCE_MODULES,
    )
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
