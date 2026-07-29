import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  findPackageBoundaryViolations,
  listCoreSourceModulePaths,
  listPackedDistEntries,
  listProductionDependencyGroups,
  listProductionDependencyRoots,
  normalizeRelativePath,
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

const APPROVED_PACKED_DIST_ENTRIES = [
  'dist/a2a/codec.js',
  'dist/a2a/delivery-trace.js',
  'dist/a2a/legacy-map.js',
  'dist/a2a/local-admission.js',
  'dist/a2a/replay-decision.js',
  'dist/a2a/static-harness-mapping.js',
  'dist/a2a/types.js',
  'dist/attempt-lifecycle.js',
  'dist/bin/dashboard.js',
  'dist/bin/fleetbudget-sanitize.js',
  'dist/bin/inspect.js',
  'dist/bin/routeplane-catalog.js',
  'dist/budget-awareness.js',
  'dist/compile-route-candidates.js',
  'dist/core.js',
  'dist/db.js',
  'dist/demo.js',
  'dist/discussion-mcp.js',
  'dist/discussion-store.js',
  'dist/discussion.js',
  'dist/doctor.js',
  'dist/env.js',
  'dist/fleetbudget-observations.js',
  'dist/fleetbudget-sanitizer.js',
  'dist/health.js',
  'dist/heartbeat.js',
  'dist/index.js',
  'dist/inspector.js',
  'dist/lifecycle-execution.js',
  'dist/lifecycle-visibility.js',
  'dist/migrate.js',
  'dist/ratify.js',
  'dist/realtime.js',
  'dist/recommend-route.js',
  'dist/retry.js',
  'dist/route-candidate-validation.js',
  'dist/routeplane-catalog.js',
  'dist/routing-feedback.js',
  'dist/runtime/local-process.js',
  'dist/runtime/opencode.js',
  'dist/runtime/process.js',
  'dist/runtime/registry.js',
  'dist/runtime/types.js',
  'dist/skill-taxonomy.js',
  'dist/spawn-attempt.js',
  'dist/spawn-config.js',
  'dist/spawn-result.js',
  'dist/speculative-backlog-planner.js',
  'dist/sse-server.js',
  'dist/synonyms.js',
  'dist/templates.js',
  'dist/tool-args.js',
  'dist/verify-envelope-v2.js',
  'dist/verify-envelope-v3.js',
  'dist/verify.js',
  'dist/wrapper-usage-observations.js',
] as const

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

test('package boundary guard inspects direct and aliased createRequire loads', () => {
  withFixture(
    {
      'src/entry.ts': [
        'import { createRequire } from "node:module"',
        'createRequire(import.meta.url)("missing-direct")',
        'const req = createRequire(import.meta.url)',
        'req("missing-alias")',
        'req("../outside.cjs")',
      ].join('\n'),
    },
    { name: 'fixture' },
    (root) => {
      assert.deepEqual(
        findPackageBoundaryViolations(root).map(({ kind, specifier, reason }) => ({ kind, specifier, reason })),
        [
          {
            kind: 'require',
            specifier: 'missing-direct',
            reason: 'external package "missing-direct" is not declared in dependencies, optionalDependencies, or peerDependencies',
          },
          {
            kind: 'require',
            specifier: 'missing-alias',
            reason: 'external package "missing-alias" is not declared in dependencies, optionalDependencies, or peerDependencies',
          },
          {
            kind: 'require',
            specifier: '../outside.cjs',
            reason: 'relative specifier resolves outside src',
          },
        ],
      )
    },
  )
})

test('package boundary guard follows namespace and default createRequire member forms', () => {
  withFixture(
    {
      'src/entry.ts': [
        'import * as moduleNamespace from "node:module"',
        'import moduleDefault from "module"',
        'moduleNamespace.createRequire(import.meta.url)("missing-namespace-member");',
        'moduleNamespace["createRequire"](import.meta.url)("missing-namespace-computed");',
        '(moduleDefault.createRequire)(import.meta.url)("missing-default-parenthesized");',
        'const moduleAlias = moduleNamespace',
        'moduleAlias.createRequire(import.meta.url)("missing-namespace-alias");',
        'const { createRequire } = moduleAlias',
        'createRequire(import.meta.url)("missing-destructured");',
        'const { createRequire: aliasedCreateRequire } = moduleDefault',
        'aliasedCreateRequire(import.meta.url)("missing-destructured-alias");',
        'const assignedCreateRequire = moduleNamespace.createRequire',
        'assignedCreateRequire(import.meta.url)("missing-assigned-alias");',
      ].join('\n'),
    },
    { name: 'fixture' },
    (root) => {
      assert.deepEqual(
        findPackageBoundaryViolations(root).map(({ kind, specifier }) => ({ kind, specifier })),
        [
          { kind: 'require', specifier: 'missing-namespace-member' },
          { kind: 'require', specifier: 'missing-namespace-computed' },
          { kind: 'require', specifier: 'missing-default-parenthesized' },
          { kind: 'require', specifier: 'missing-namespace-alias' },
          { kind: 'require', specifier: 'missing-destructured' },
          { kind: 'require', specifier: 'missing-destructured-alias' },
          { kind: 'require', specifier: 'missing-assigned-alias' },
        ],
      )
    },
  )
})

test('package boundary guard follows createRequire acquired through CommonJS and dynamic import', () => {
  withFixture(
    {
      'src/entry.ts': [
        'const commonJsModule = require("module")',
        'commonJsModule.createRequire(import.meta.url)("missing-commonjs-member")',
        'const { createRequire: commonJsCreateRequire } = require("node:module")',
        'commonJsCreateRequire(import.meta.url)("missing-commonjs-destructured")',
        'const dynamicModule = await import("node:module")',
        'dynamicModule["createRequire"](import.meta.url)("missing-dynamic-member")',
        'const dynamicAlias = dynamicModule',
        'const { createRequire: dynamicCreateRequire } = dynamicAlias',
        'dynamicCreateRequire(import.meta.url)("missing-dynamic-destructured")',
      ].join('\n'),
    },
    { name: 'fixture' },
    (root) => {
      assert.deepEqual(
        findPackageBoundaryViolations(root)
          .map(({ kind, specifier }) => ({ kind, specifier })),
        [
          { kind: 'require', specifier: 'missing-commonjs-member' },
          { kind: 'require', specifier: 'missing-commonjs-destructured' },
          { kind: 'require', specifier: 'missing-dynamic-member' },
          { kind: 'require', specifier: 'missing-dynamic-destructured' },
        ],
      )
    },
  )
})

test('package boundary guard follows nested Module, import-equals, and computed createRequire forms', () => {
  withFixture(
    {
      'src/entry.ts': [
        'import { Module as NamedModule } from "node:module"',
        'import * as moduleNamespace from "node:module"',
        'import moduleDefault from "module"',
        'import equalsModule = require("node:module")',
        'NamedModule.createRequire(import.meta.url)("missing-named-module");',
        'moduleNamespace.Module.createRequire(import.meta.url)("missing-namespace-module");',
        'moduleDefault.Module.createRequire(import.meta.url)("missing-default-module");',
        'equalsModule.createRequire(import.meta.url)("missing-import-equals");',
        'moduleNamespace[("createRequire")](import.meta.url)("missing-parenthesized-key");',
        'moduleDefault[`createRequire`](import.meta.url)("missing-template-key");',
        'const { ["createRequire"]: computedCreateRequire } = moduleNamespace',
        'computedCreateRequire(import.meta.url)("missing-computed-destructure");',
        'const { [`createRequire`]: templateCreateRequire } = moduleDefault',
        'templateCreateRequire(import.meta.url)("missing-template-destructure");',
      ].join('\n'),
    },
    { name: 'fixture' },
    (root) => {
      assert.deepEqual(
        findPackageBoundaryViolations(root).map(({ kind, specifier }) => ({ kind, specifier })),
        [
          { kind: 'require', specifier: 'missing-named-module' },
          { kind: 'require', specifier: 'missing-namespace-module' },
          { kind: 'require', specifier: 'missing-default-module' },
          { kind: 'require', specifier: 'missing-import-equals' },
          { kind: 'require', specifier: 'missing-parenthesized-key' },
          { kind: 'require', specifier: 'missing-template-key' },
          { kind: 'require', specifier: 'missing-computed-destructure' },
          { kind: 'require', specifier: 'missing-template-destructure' },
        ],
      )
    },
  )
})

test('package boundary guard follows Module aliases acquired through destructuring', () => {
  withFixture(
    {
      'src/entry.ts': [
        'import * as moduleNamespace from "node:module"',
        'const { Module: ModuleAlias } = moduleNamespace',
        'ModuleAlias.createRequire(import.meta.url)("missing-destructured-module")',
        'const { Module: { createRequire: nestedCreateRequire } } = moduleNamespace',
        'nestedCreateRequire(import.meta.url)("missing-nested-module")',
      ].join('\n'),
    },
    { name: 'fixture' },
    (root) => {
      assert.deepEqual(
        findPackageBoundaryViolations(root).map(({ kind, specifier }) => ({ kind, specifier })),
        [
          { kind: 'require', specifier: 'missing-destructured-module' },
          { kind: 'require', specifier: 'missing-nested-module' },
        ],
      )
    },
  )
})

test('package boundary guard follows wrapped module objects without leaking through lexical shadows', () => {
  withFixture(
    {
      'src/entry.ts': [
        'import * as moduleNamespace from "node:module"',
        'const { Module: ModuleAlias } = moduleNamespace as typeof moduleNamespace',
        'ModuleAlias.createRequire(import.meta.url)("missing-wrapped-module")',
        'const { ...moduleRest } = moduleNamespace satisfies typeof moduleNamespace',
        'moduleRest.createRequire(import.meta.url)("missing-wrapped-rest")',
        'const key = "createRequire";',
        '(moduleNamespace!)[key](import.meta.url)("missing-wrapped-computed")',
        'const { [key]: wrappedFactory } = <typeof moduleNamespace>moduleNamespace',
        'wrappedFactory(import.meta.url)("missing-wrapped-binding")',
        'function harmless(ModuleAlias: { createRequire: () => (value: string) => string }) {',
        '  return ModuleAlias.createRequire()("ordinary-value")',
        '}',
        'void harmless',
      ].join('\n'),
    },
    { name: 'fixture' },
    (root) => {
      assert.deepEqual(
        findPackageBoundaryViolations(root).map(({ kind, specifier }) => ({ kind, specifier })),
        [
          { kind: 'require', specifier: 'missing-wrapped-module' },
          { kind: 'require', specifier: 'missing-wrapped-rest' },
          { kind: 'require', specifier: '<ambiguous>' },
          { kind: 'require', specifier: '<ambiguous>' },
        ],
      )
    },
  )
})

test('package boundary guard follows module bindings through for-of declarations, parameter defaults, and arrays', () => {
  withFixture(
    {
      'src/entry.ts': [
        'import * as moduleNamespace from "node:module"',
        'for (const { createRequire: loopFactory } of [moduleNamespace]) {',
        '  loopFactory(import.meta.url)("missing-for-of-binding")',
        '}',
        'function load({ createRequire: parameterFactory } = moduleNamespace) {',
        '  parameterFactory(import.meta.url)("missing-parameter-binding")',
        '}',
        'const [arrayModule] = [moduleNamespace]',
        'arrayModule.createRequire(import.meta.url)("missing-array-binding")',
        'void load',
      ].join('\n'),
    },
    { name: 'fixture' },
    (root) => {
      assert.deepEqual(
        findPackageBoundaryViolations(root).map(({ kind, specifier }) => ({ kind, specifier })),
        [
          { kind: 'require', specifier: 'missing-for-of-binding' },
          { kind: 'require', specifier: 'missing-parameter-binding' },
          { kind: 'require', specifier: 'missing-array-binding' },
        ],
      )
    },
  )
})

test('package boundary guard follows binding defaults, merged var bindings, and value-preserving wrappers', () => {
  withFixture(
    {
      'src/entry.ts': [
        'import * as moduleNamespace from "node:module"',
        'const { value: defaultModule = moduleNamespace } = {} as { value?: typeof moduleNamespace }',
        'defaultModule.createRequire(import.meta.url)("missing-binding-default")',
        'var mergedModule: unknown = {}',
        'var mergedModule = moduleNamespace',
        'mergedModule.createRequire(import.meta.url)("missing-merged-var")',
        ';(0, moduleNamespace).createRequire(import.meta.url)("missing-comma-wrapper")',
        ';(true ? moduleNamespace : {}).createRequire(import.meta.url)("missing-conditional-wrapper")',
      ].join('\n'),
    },
    { name: 'fixture' },
    (root) => {
      assert.deepEqual(
        findPackageBoundaryViolations(root).map(({ kind, specifier }) => ({ kind, specifier })),
        [
          { kind: 'require', specifier: 'missing-binding-default' },
          { kind: 'require', specifier: 'missing-merged-var' },
          { kind: 'require', specifier: 'missing-comma-wrapper' },
          { kind: 'require', specifier: 'missing-conditional-wrapper' },
        ],
      )
    },
  )
})

test('package boundary guard fails closed when assignments acquire module objects by identifier', () => {
  withFixture(
    {
      'src/entry.ts': [
        'import * as moduleNamespace from "node:module"',
        'let directModule: unknown',
        'let arrayModule: unknown',
        'let loopModule: unknown',
        'directModule = moduleNamespace;',
        '[arrayModule] = [moduleNamespace];',
        'for (loopModule of [moduleNamespace]) {}',
      ].join('\n'),
    },
    { name: 'fixture' },
    (root) => {
      assert.deepEqual(findPackageBoundaryViolations(root), [
        {
          file: 'src/entry.ts',
          kind: 'require',
          specifier: '<ambiguous>',
          reason: 'module object destructuring assignment cannot be resolved statically',
        },
        {
          file: 'src/entry.ts',
          kind: 'require',
          specifier: '<ambiguous>',
          reason: 'module object destructuring assignment cannot be resolved statically',
        },
        {
          file: 'src/entry.ts',
          kind: 'require',
          specifier: '<ambiguous>',
          reason: 'module object destructuring assignment cannot be resolved statically',
        },
      ])
    },
  )
})

test('package boundary guard resolves loader, catch, and method-name bindings lexically', () => {
  withFixture(
    {
      'src/entry.ts': [
        'import * as moduleNamespace from "node:module"',
        'const req = moduleNamespace.createRequire(import.meta.url)',
        'req("missing-loader-alias")',
        'function harmless(req: (value: string) => string) {',
        '  return req("ordinary-shadowed-loader")',
        '}',
        'try { throw moduleNamespace } catch (moduleNamespace) {',
        '  void moduleNamespace.createRequire()("ordinary-catch-binding")',
        '}',
        'class Local {',
        '  require() { return 1 }',
        '}',
        'class Accessor {',
        '  get require() { return 1 }',
        '  set require(value: number) { void value }',
        '}',
        'require("missing-global-require")',
        'void [harmless, Local, Accessor]',
      ].join('\n'),
    },
    { name: 'fixture' },
    (root) => {
      assert.deepEqual(
        findPackageBoundaryViolations(root).map(({ kind, specifier, reason }) => ({ kind, specifier, reason })),
        [
          {
            kind: 'require',
            specifier: 'missing-loader-alias',
            reason: 'external package "missing-loader-alias" is not declared in dependencies, optionalDependencies, or peerDependencies',
          },
          {
            kind: 'require',
            specifier: 'missing-global-require',
            reason: 'external package "missing-global-require" is not declared in dependencies, optionalDependencies, or peerDependencies',
          },
        ],
      )
    },
  )
})

test('package boundary guard fails closed on module object destructuring assignments', () => {
  withFixture(
    {
      'src/entry.ts': [
        'import * as moduleNamespace from "node:module"',
        'let createRequireAlias: unknown',
        '({ createRequire: createRequireAlias } = moduleNamespace)',
      ].join('\n'),
    },
    { name: 'fixture' },
    (root) => {
      assert.deepEqual(findPackageBoundaryViolations(root), [
        {
          file: 'src/entry.ts',
          kind: 'require',
          specifier: '<ambiguous>',
          reason: 'module object destructuring assignment cannot be resolved statically',
        },
      ])
    },
  )
})

test('package boundary guard recursively analyzes module object assignment patterns', () => {
  withFixture(
    {
      'src/entry.ts': [
        'import * as moduleNamespace from "node:module"',
        'let createRequireAlias: unknown',
        'let nestedCreateRequireAlias: unknown',
        'let builtinModules: unknown',
        '({ builtinModules } = moduleNamespace)',
        '([{ createRequire: createRequireAlias }] = [moduleNamespace])',
        'for ({ Module: { createRequire: nestedCreateRequireAlias } } of [moduleNamespace]) {}',
      ].join('\n'),
    },
    { name: 'fixture' },
    (root) => {
      assert.deepEqual(findPackageBoundaryViolations(root), [
        {
          file: 'src/entry.ts',
          kind: 'require',
          specifier: '<ambiguous>',
          reason: 'module object destructuring assignment cannot be resolved statically',
        },
        {
          file: 'src/entry.ts',
          kind: 'require',
          specifier: '<ambiguous>',
          reason: 'module object destructuring assignment cannot be resolved statically',
        },
      ])
    },
  )
})

test('package boundary guard follows module object aliases acquired through object rest', () => {
  withFixture(
    {
      'src/entry.ts': [
        'import * as moduleNamespace from "node:module"',
        'const { ...moduleRest } = moduleNamespace',
        'moduleRest.createRequire(import.meta.url)("missing-object-rest")',
      ].join('\n'),
    },
    { name: 'fixture' },
    (root) => {
      assert.deepEqual(
        findPackageBoundaryViolations(root).map(({ kind, specifier }) => ({ kind, specifier })),
        [
          { kind: 'require', specifier: 'missing-object-rest' },
        ],
      )
    },
  )
})

test('package boundary guard does not propagate object rest after loader properties are excluded', () => {
  withFixture(
    {
      'src/entry.ts': [
        'import * as moduleNamespace from "node:module"',
        'const { createRequire, Module, ...metadata } = moduleNamespace',
        'const key = "builtinModules"',
        'void metadata[key]',
      ].join('\n'),
    },
    { name: 'fixture' },
    (root) => {
      assert.deepEqual(findPackageBoundaryViolations(root), [])
    },
  )
})

test('package boundary guard fails closed on dynamic computed module object keys', () => {
  withFixture(
    {
      'src/computed-access.ts': [
        'import * as moduleNamespace from "node:module"',
        'const key = "createRequire"',
        'moduleNamespace[key](import.meta.url)("missing-dynamic-key")',
      ].join('\n'),
      'src/computed-binding.ts': [
        'import * as moduleNamespace from "node:module"',
        'const key = "createRequire"',
        'const { [key]: dynamicCreateRequire } = moduleNamespace',
        'dynamicCreateRequire(import.meta.url)("missing-dynamic-binding")',
      ].join('\n'),
      'src/nested-computed-binding.ts': [
        'import * as moduleNamespace from "node:module"',
        'const key = "createRequire"',
        'const { Module: { [key]: dynamicCreateRequire } } = moduleNamespace',
        'dynamicCreateRequire(import.meta.url)("missing-nested-dynamic-binding")',
      ].join('\n'),
    },
    { name: 'fixture' },
    (root) => {
      assert.deepEqual(
        findPackageBoundaryViolations(root),
        [
          {
            file: 'src/computed-access.ts',
            kind: 'require',
            specifier: '<ambiguous>',
            reason: 'module object computed property cannot be resolved statically',
          },
          {
            file: 'src/computed-binding.ts',
            kind: 'require',
            specifier: '<ambiguous>',
            reason: 'module object computed property cannot be resolved statically',
          },
          {
            file: 'src/nested-computed-binding.ts',
            kind: 'require',
            specifier: '<ambiguous>',
            reason: 'module object computed property cannot be resolved statically',
          },
        ],
      )
    },
  )
})

test('package boundary guard fails closed when a createRequire factory value escapes through a property', () => {
  withFixture(
    {
      'src/entry.ts': [
        'import * as moduleNamespace from "node:module"',
        'const propertyBag = { factory: moduleNamespace.createRequire }',
        'const target: { factory?: unknown } = {}',
        'target.factory = moduleNamespace["createRequire"]',
        'void propertyBag',
      ].join('\n'),
    },
    { name: 'fixture' },
    (root) => {
      assert.deepEqual(findPackageBoundaryViolations(root), [
        {
          file: 'src/entry.ts',
          kind: 'require',
          specifier: '<ambiguous>',
          reason: 'createRequire factory expression escapes static analysis',
        },
        {
          file: 'src/entry.ts',
          kind: 'require',
          specifier: '<ambiguous>',
          reason: 'createRequire factory expression escapes static analysis',
        },
      ])
    },
  )
})

test('package boundary guard fails closed on non-awaited dynamic module acquisition', () => {
  withFixture(
    {
      'src/entry.ts': [
        'import("node:module").then(({ createRequire }) => {',
        '  createRequire(import.meta.url)("missing-from-callback")',
        '})',
      ].join('\n'),
    },
    { name: 'fixture' },
    (root) => {
      assert.deepEqual(findPackageBoundaryViolations(root), [
        {
          file: 'src/entry.ts',
          kind: 'require',
          specifier: '<ambiguous>',
          reason: 'dynamic module import is not awaited and cannot be resolved statically',
        },
      ])
    },
  )
})

test('package boundary guard fails closed when a createRequire loader escapes static analysis', () => {
  withFixture(
    {
      'src/entry.ts': [
        'import { createRequire } from "node:module"',
        'const req = createRequire(import.meta.url)',
        'const escaped = req',
        'void escaped',
      ].join('\n'),
    },
    { name: 'fixture' },
    (root) => {
      assert.deepEqual(findPackageBoundaryViolations(root), [
        {
          file: 'src/entry.ts',
          kind: 'require',
          specifier: '<ambiguous>',
          reason: 'createRequire loader "req" escapes static analysis',
        },
      ])
    },
  )
})

test('package boundary guard accepts no-substitution templates and rejects interpolated module specifiers', () => {
  withFixture(
    {
      'src/entry.ts': [
        'const name = "value"',
        'void import(`missing-dynamic`)',
        'require(`missing-require`)',
        'void import(`dynamic-${name}`)',
        'require(`require-${name}`)',
      ].join('\n'),
    },
    { name: 'fixture' },
    (root) => {
      assert.deepEqual(
        findPackageBoundaryViolations(root).map(({ kind, specifier, reason }) => ({ kind, specifier, reason })),
        [
          {
            kind: 'dynamic-import',
            specifier: 'missing-dynamic',
            reason: 'external package "missing-dynamic" is not declared in dependencies, optionalDependencies, or peerDependencies',
          },
          {
            kind: 'require',
            specifier: 'missing-require',
            reason: 'external package "missing-require" is not declared in dependencies, optionalDependencies, or peerDependencies',
          },
          {
            kind: 'dynamic-import',
            specifier: '<dynamic>',
            reason: 'dynamic import specifier cannot be resolved statically',
          },
          {
            kind: 'require',
            specifier: '<dynamic>',
            reason: 'require specifier cannot be resolved statically',
          },
        ],
      )
    },
  )
})

test('package boundary guard fails closed when a local binding shadows CommonJS require', () => {
  withFixture(
    {
      'src/entry.ts': [
        'const require = (specifier: string) => specifier',
        'require("looks-declared")',
      ].join('\n'),
    },
    { name: 'fixture', dependencies: { 'looks-declared': '1.0.0' } },
    (root) => {
      assert.deepEqual(findPackageBoundaryViolations(root), [
        {
          file: 'src/entry.ts',
          kind: 'require',
          specifier: 'looks-declared',
          reason: 'local binding shadows CommonJS require',
        },
      ])
    },
  )
})

test('package boundary guard inspects require.resolve and parenthesized require, then rejects alias escape', () => {
  withFixture(
    {
      'src/entry.cjs': [
        'require.resolve("missing-resolve");',
        '(require)("missing-parenthesized");',
        'const req = require;',
        'req("missing-alias");',
      ].join('\n'),
    },
    { name: 'fixture' },
    (root) => {
      assert.deepEqual(
        findPackageBoundaryViolations(root).map(({ kind, specifier, reason }) => ({ kind, specifier, reason })),
        [
          {
            kind: 'require',
            specifier: 'missing-resolve',
            reason: 'external package "missing-resolve" is not declared in dependencies, optionalDependencies, or peerDependencies',
          },
          {
            kind: 'require',
            specifier: 'missing-parenthesized',
            reason: 'external package "missing-parenthesized" is not declared in dependencies, optionalDependencies, or peerDependencies',
          },
          {
            kind: 'require',
            specifier: '<ambiguous>',
            reason: 'CommonJS require escapes static analysis',
          },
        ],
      )
    },
  )
})

test('violation paths normalize Windows separators', () => {
  assert.equal(normalizeRelativePath('src\\nested\\entry.ts'), 'src/nested/entry.ts')
})

test('packed dist filtering normalizes Windows separators before matching and sorting', () => {
  assert.deepEqual(
    listPackedDistEntries([
      { path: 'README.md' },
      { path: 'dist\\nested\\module.js' },
      { path: 'dist/index.js' },
    ]),
    ['dist/index.js', 'dist/nested/module.js'],
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

test('source baseline lists every supported source extension', () => {
  withFixture(
    {
      'src/component.tsx': 'export {}\n',
      'src/entry.ts': 'export {}\n',
      'src/module.cjs': 'module.exports = {}\n',
      'src/module.cts': 'export {}\n',
      'src/module.js': 'export {}\n',
      'src/module.mjs': 'export {}\n',
      'src/module.mts': 'export {}\n',
      'src/module.jsx': 'export default null\n',
      'src/types.d.ts': 'export type Value = string\n',
    },
    { name: 'fixture' },
    (root) => {
      assert.deepEqual(listCoreSourceModulePaths(root), [
        'component.tsx',
        'entry.ts',
        'module.cjs',
        'module.cts',
        'module.js',
        'module.jsx',
        'module.mjs',
        'module.mts',
        'types.d.ts',
      ])
    },
  )
})

test('source baseline does not ignore uppercase module extensions', () => {
  withFixture(
    { 'src/escape.TS': 'import "missing-uppercase"\n' },
    { name: 'fixture' },
    (root) => assert.deepEqual(listCoreSourceModulePaths(root), ['escape.TS']),
  )
})

test('package boundary guard checks every supported source extension', () => {
  withFixture(
    {
      'src/entry.cjs': 'require("missing-cjs")\n',
      'src/entry.cts': 'require("missing-cts")\n',
      'src/entry.js': 'import "missing-js"\n',
      'src/entry.jsx': 'import "missing-jsx"\n',
      'src/entry.mjs': 'import "missing-mjs"\n',
      'src/entry.mts': 'import "missing-mts"\n',
      'src/entry.ts': 'import "missing-ts"\n',
      'src/entry.tsx': 'import "missing-tsx"\n',
    },
    { name: 'fixture' },
    (root) => {
      assert.deepEqual(
        findPackageBoundaryViolations(root).map(({ file, specifier }) => ({ file, specifier })),
        [
          { file: 'src/entry.cjs', specifier: 'missing-cjs' },
          { file: 'src/entry.cts', specifier: 'missing-cts' },
          { file: 'src/entry.js', specifier: 'missing-js' },
          { file: 'src/entry.jsx', specifier: 'missing-jsx' },
          { file: 'src/entry.mjs', specifier: 'missing-mjs' },
          { file: 'src/entry.mts', specifier: 'missing-mts' },
          { file: 'src/entry.ts', specifier: 'missing-ts' },
          { file: 'src/entry.tsx', specifier: 'missing-tsx' },
        ],
      )
    },
  )
})

test('source scan rejects a file symlink', (t) => {
  withFixture(
    {
      'outside.ts': 'export {}\n',
      'src/entry.ts': 'export {}\n',
    },
    { name: 'fixture' },
    (root) => {
      try {
        symlinkSync(join(root, 'outside.ts'), join(root, 'src', 'linked.ts'), 'file')
      } catch (error) {
        if (process.platform === 'win32' && ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          t.skip('Windows denied fixture file-symlink creation')
          return
        }
        throw error
      }

      assert.throws(
        () => findPackageBoundaryViolations(root),
        /source tree contains symlink: linked\.ts/,
      )
    },
  )
})

test('source scan rejects a directory symlink', (t) => {
  withFixture(
    { 'src/entry.ts': 'export {}\n' },
    { name: 'fixture' },
    (root) => {
      const outside = join(root, 'outside')
      mkdirSync(outside)
      writeFileSync(join(outside, 'nested.ts'), 'export {}\n')
      try {
        symlinkSync(outside, join(root, 'src', 'linked-dir'), process.platform === 'win32' ? 'junction' : 'dir')
      } catch (error) {
        if (process.platform === 'win32' && ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          t.skip('Windows denied fixture directory-symlink creation')
          return
        }
        throw error
      }

      assert.throws(
        () => listCoreSourceModulePaths(root),
        /source tree contains symlink: linked-dir/,
      )
    },
  )
})

test('source scan can prove symlink rejection without operating-system symlink privileges', () => {
  withFixture(
    { 'src/entry.ts': 'export {}\n' },
    { name: 'fixture' },
    (root) => {
      assert.throws(
        () => listCoreSourceModulePaths(root, () => ({
          isSymbolicLink: () => true,
          isDirectory: () => false,
        })),
        /source tree contains symlink: entry\.ts/,
      )
    },
  )
})

test('public Core production dependency baseline is exact', () => {
  const repoRoot = join(fileURLToPath(new URL('..', import.meta.url)))
  assert.deepEqual(listProductionDependencyRoots(repoRoot), APPROVED_PRODUCTION_DEPENDENCY_ROOTS)
  assert.deepEqual(listProductionDependencyGroups(repoRoot), APPROVED_PRODUCTION_DEPENDENCY_GROUPS)
})

test('packed tarball contains exactly the approved Core modules', { timeout: 30_000 }, () => {
  const repoRoot = join(fileURLToPath(new URL('..', import.meta.url)))
  const temp = mkdtempSync(join(tmpdir(), 'meshfleet-package-boundary-pack-'))
  const packageRoot = join(temp, 'package')
  const packDestination = join(temp, 'packed')
  const workspaceDistEntry = join(repoRoot, 'dist', 'index.js')
  const workspaceDistBefore = existsSync(workspaceDistEntry)
    ? statSync(workspaceDistEntry, { bigint: true }).mtimeNs
    : undefined
  try {
    mkdirSync(packageRoot)
    mkdirSync(packDestination)
    for (const file of [
      'package.json',
      'mcp.json',
      'README.md',
      'LICENSE',
      'AGENT-MESH-SPEC.md',
      'SPEC-P2P.md',
      'SPEC-COUNCILS.md',
    ]) {
      copyFileSync(join(repoRoot, file), join(packageRoot, file))
    }

    const build = spawnSync(process.execPath, [
      join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--project',
      join(repoRoot, 'tsconfig.json'),
      '--rootDir',
      join(repoRoot, 'src'),
      '--outDir',
      join(packageRoot, 'dist'),
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    assert.equal(build.status, 0, build.stderr || build.stdout)

    const pack = spawnSync(NPM, ['pack', '--json', '--pack-destination', packDestination], {
      cwd: packageRoot,
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
    assert.equal(existsSync(join(packDestination, packed[0]!.filename)), true)
    assert.deepEqual(
      listPackedDistEntries(packed[0]!.files),
      APPROVED_PACKED_DIST_ENTRIES,
    )
    assert.equal(
      existsSync(workspaceDistEntry)
        ? statSync(workspaceDistEntry, { bigint: true }).mtimeNs
        : undefined,
      workspaceDistBefore,
      'pack verification must not create or rewrite workspace dist',
    )
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
