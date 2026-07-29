import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findPackageBoundaryViolations } from './helpers/package-boundary-guard.js'

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
