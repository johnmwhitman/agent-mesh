import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

export type PackageBoundaryViolation = {
  file: string
  kind: 'import' | 'import-type' | 'export-from' | 'dynamic-import' | 'require'
  specifier: string
  reason: string
}

export type ProductionDependencyGroups = {
  dependencies: string[]
  optionalDependencies: string[]
  peerDependencies: string[]
}

type PackageJson = {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
const nodeBuiltins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')))

function readPackageJson(repoRoot: string): PackageJson {
  return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as PackageJson
}

function walkSourceFiles(directory: string, sourceDir = directory): string[] {
  return readdirSync(directory)
    .sort()
    .flatMap((entry) => {
      const path = join(directory, entry)
      const stats = lstatSync(path)
      if (stats.isSymbolicLink()) {
        throw new Error(`source tree contains symlink: ${relative(sourceDir, path).split(sep).join('/')}`)
      }
      if (stats.isDirectory()) return walkSourceFiles(path, sourceDir)
      return sourceExtensions.some((extension) => entry.endsWith(extension)) ? [path] : []
    })
}

export function listCoreSourceModulePaths(repoRoot: string): string[] {
  const sourceDir = join(repoRoot, 'src')
  return walkSourceFiles(sourceDir)
    .map((path) => relative(sourceDir, path).split(sep).join('/'))
}

export function listProductionDependencyGroups(repoRoot: string): ProductionDependencyGroups {
  const packageJson = readPackageJson(repoRoot)
  return {
    dependencies: Object.keys(packageJson.dependencies ?? {}).sort(),
    optionalDependencies: Object.keys(packageJson.optionalDependencies ?? {}).sort(),
    peerDependencies: Object.keys(packageJson.peerDependencies ?? {}).sort(),
  }
}

export function listProductionDependencyRoots(repoRoot: string): string[] {
  const groups = listProductionDependencyGroups(repoRoot)
  return [...new Set([
    ...groups.dependencies,
    ...groups.optionalDependencies,
    ...groups.peerDependencies,
  ])].sort()
}

export function listPackedDistEntries(entries: ReadonlyArray<{ path: string }>): string[] {
  return entries
    .map(({ path }) => path)
    .filter((path) => path.startsWith('dist/'))
    .sort()
}

function packageRoot(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function remainsInside(directory: string, path: string): boolean {
  const pathFromDirectory = relative(directory, path)
  return pathFromDirectory === '' || (!pathFromDirectory.startsWith(`..${sep}`) && pathFromDirectory !== '..' && !isAbsolute(pathFromDirectory))
}

function sourceCandidates(resolvedSpecifier: string): string[] {
  const extension = sourceExtensions.find((candidate) => resolvedSpecifier.endsWith(candidate))
  if (extension) {
    const withoutExtension = resolvedSpecifier.slice(0, -extension.length)
    const emittedSourceExtensions = extension === '.js'
      ? ['.ts', '.tsx', '.js', '.jsx']
      : extension === '.mjs'
        ? ['.mts', '.mjs']
        : extension === '.cjs'
          ? ['.cts', '.cjs']
          : [extension]
    return emittedSourceExtensions.map((candidate) => `${withoutExtension}${candidate}`)
  }

  return [
    ...sourceExtensions.map((candidate) => `${resolvedSpecifier}${candidate}`),
    ...sourceExtensions.map((candidate) => join(resolvedSpecifier, `index${candidate}`)),
  ]
}

function relativeViolation(sourceDir: string, sourceFile: string, specifier: string): string | undefined {
  const resolvedSpecifier = resolve(dirname(sourceFile), specifier)
  if (!remainsInside(sourceDir, resolvedSpecifier)) return 'relative specifier resolves outside src'
  return sourceCandidates(resolvedSpecifier).some((candidate) => existsSync(candidate))
    ? undefined
    : 'relative specifier does not resolve to a source module under src'
}

function collectSpecifiers(sourceFile: ts.SourceFile): Array<{ kind: PackageBoundaryViolation['kind']; specifier: string }> {
  const specifiers: Array<{ kind: PackageBoundaryViolation['kind']; specifier: string }> = []

  const add = (kind: PackageBoundaryViolation['kind'], expression: ts.Expression | undefined): void => {
    if (expression && ts.isStringLiteral(expression)) specifiers.push({ kind, specifier: expression.text })
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      add(node.importClause?.isTypeOnly ? 'import-type' : 'import', node.moduleSpecifier)
    } else if (ts.isExportDeclaration(node)) {
      add('export-from', node.moduleSpecifier)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add('require', node.moduleReference.expression)
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add('dynamic-import', node.arguments[0])
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        add('require', node.arguments[0])
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return specifiers
}

export function findPackageBoundaryViolations(repoRoot: string): PackageBoundaryViolation[] {
  const declared = new Set(listProductionDependencyRoots(repoRoot))
  const sourceDir = join(repoRoot, 'src')

  return walkSourceFiles(sourceDir).flatMap((file) => {
    const sourceFile = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    return collectSpecifiers(sourceFile).flatMap(({ kind, specifier }) => {
      if (specifier.startsWith('.')) {
        const reason = relativeViolation(sourceDir, file, specifier)
        return reason ? [{ file: relative(repoRoot, file), kind, specifier, reason }] : []
      }

      const root = packageRoot(specifier)
      if (specifier.startsWith('node:') || nodeBuiltins.has(specifier) || declared.has(root)) return []
      return [{
        file: relative(repoRoot, file),
        kind,
        specifier,
        reason: `external package "${root}" is not declared in dependencies, optionalDependencies, or peerDependencies`,
      }]
    })
  })
}
