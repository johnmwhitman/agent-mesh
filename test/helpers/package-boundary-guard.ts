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

export type SourceEntryInspector = (path: string) => {
  isSymbolicLink(): boolean
  isDirectory(): boolean
}

export function normalizeRelativePath(path: string): string {
  return path.replaceAll('\\', '/')
}

function readPackageJson(repoRoot: string): PackageJson {
  return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as PackageJson
}

function walkSourceFiles(
  directory: string,
  sourceDir = directory,
  inspect: SourceEntryInspector = lstatSync,
): string[] {
  return readdirSync(directory)
    .sort()
    .flatMap((entry) => {
      const path = join(directory, entry)
      const stats = inspect(path)
      if (stats.isSymbolicLink()) {
        throw new Error(`source tree contains symlink: ${normalizeRelativePath(relative(sourceDir, path))}`)
      }
      if (stats.isDirectory()) return walkSourceFiles(path, sourceDir, inspect)
      const normalizedEntry = entry.toLowerCase()
      return sourceExtensions.some((extension) => normalizedEntry.endsWith(extension)) ? [path] : []
    })
}

export function listCoreSourceModulePaths(
  repoRoot: string,
  inspect: SourceEntryInspector = lstatSync,
): string[] {
  const sourceDir = join(repoRoot, 'src')
  return walkSourceFiles(sourceDir, sourceDir, inspect)
    .map((path) => normalizeRelativePath(relative(sourceDir, path)))
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

type CollectedSpecifier = {
  kind: PackageBoundaryViolation['kind']
  specifier: string
  reason?: string
  loader?: 'create-require'
}

function staticSpecifier(expression: ts.Expression | undefined): string | undefined {
  return expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    ? expression.text
    : undefined
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isParenthesizedExpression(current)) current = current.expression
  return current
}

function isImportMetaUrl(expression: ts.Expression | undefined): boolean {
  return !!expression &&
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === 'url' &&
    ts.isMetaProperty(expression.expression) &&
    expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    expression.expression.name.text === 'meta'
}

function isDeclarationName(identifier: ts.Identifier): boolean {
  const parent = identifier.parent
  return (ts.isVariableDeclaration(parent) && parent.name === identifier) ||
    (ts.isParameter(parent) && parent.name === identifier) ||
    (ts.isFunctionDeclaration(parent) && parent.name === identifier) ||
    (ts.isFunctionExpression(parent) && parent.name === identifier) ||
    (ts.isMethodDeclaration(parent) && parent.name === identifier) ||
    (ts.isMethodSignature(parent) && parent.name === identifier) ||
    (ts.isPropertyDeclaration(parent) && parent.name === identifier) ||
    (ts.isPropertySignature(parent) && parent.name === identifier) ||
    (ts.isClassDeclaration(parent) && parent.name === identifier) ||
    (ts.isClassExpression(parent) && parent.name === identifier) ||
    (ts.isCatchClause(parent) && parent.variableDeclaration?.name === identifier) ||
    (ts.isImportClause(parent) && parent.name === identifier) ||
    (ts.isImportSpecifier(parent) && parent.name === identifier) ||
    ts.isNamespaceImport(parent)
}

function collectSpecifiers(sourceFile: ts.SourceFile): CollectedSpecifier[] {
  const specifiers: CollectedSpecifier[] = []
  const createRequireNames = new Set<string>()
  const moduleObjectNames = new Set<string>()

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !['module', 'node:module'].includes(statement.moduleSpecifier.text) ||
        !statement.importClause) continue

    const bindings = statement.importClause.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if ((binding.propertyName?.text ?? binding.name.text) === 'createRequire') {
          createRequireNames.add(binding.name.text)
        }
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      moduleObjectNames.add(bindings.name.text)
    }
    if (statement.importClause.name) moduleObjectNames.add(statement.importClause.name.text)
  }

  const isCreateRequireExpression = (expression: ts.Expression): boolean =>
    (ts.isIdentifier(expression) && createRequireNames.has(expression.text)) ||
    (ts.isPropertyAccessExpression(expression) &&
      expression.name.text === 'createRequire' &&
      ts.isIdentifier(expression.expression) &&
      moduleObjectNames.has(expression.expression.text))

  const isCreateRequireCall = (node: ts.Node | undefined): node is ts.CallExpression =>
    !!node && ts.isCallExpression(node) && isCreateRequireExpression(node.expression)

  const isCommonJsRequireResolve = (expression: ts.Expression): boolean => {
    if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== 'resolve') return false
    const receiver = unwrapParentheses(expression.expression)
    return ts.isIdentifier(receiver) && receiver.text === 'require'
  }

  const aliases = new Map<string, ts.VariableDeclaration>()

  const collectCreateRequire = (node: ts.Node): void => {
    if (isCreateRequireCall(node)) {
      if (node.arguments.length !== 1 || !isImportMetaUrl(node.arguments[0])) {
        specifiers.push({
          kind: 'require',
          specifier: '<ambiguous>',
          reason: 'createRequire base cannot be resolved statically',
        })
      } else if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
        // Direct createRequire(import.meta.url)(specifier) is handled on the outer call.
      } else if (ts.isVariableDeclaration(node.parent) && node.parent.initializer === node) {
        const declaration = node.parent
        const declarationList = declaration.parent
        if (!ts.isIdentifier(declaration.name) ||
            !ts.isVariableDeclarationList(declarationList) ||
            !(declarationList.flags & ts.NodeFlags.Const) ||
            aliases.has(declaration.name.text)) {
          specifiers.push({
            kind: 'require',
            specifier: '<ambiguous>',
            reason: 'createRequire loader binding cannot be resolved statically',
          })
        } else {
          aliases.set(declaration.name.text, declaration)
        }
      } else {
        specifiers.push({
          kind: 'require',
          specifier: '<ambiguous>',
          reason: 'createRequire usage cannot be resolved statically',
        })
      }
    }
    ts.forEachChild(node, collectCreateRequire)
  }
  collectCreateRequire(sourceFile)

  let requireIsShadowed = false
  const findRequireShadow = (node: ts.Node): void => {
    if (ts.isIdentifier(node) &&
        node.text === 'require' &&
        isDeclarationName(node) &&
        aliases.get('require')?.name !== node) {
      requireIsShadowed = true
    }
    ts.forEachChild(node, findRequireShadow)
  }
  findRequireShadow(sourceFile)

  const add = (
    kind: PackageBoundaryViolation['kind'],
    expression: ts.Expression | undefined,
    loader?: 'create-require',
  ): void => {
    const specifier = staticSpecifier(expression)
    if (specifier !== undefined) {
      specifiers.push({ kind, specifier, loader })
    } else {
      specifiers.push({
        kind,
        specifier: '<dynamic>',
        reason: `${kind === 'dynamic-import' ? 'dynamic import' : 'require'} specifier cannot be resolved statically`,
        loader,
      })
    }
  }

  const escapedAliases = new Set<string>()
  let requireEscapeReported = false
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      add(node.importClause?.isTypeOnly ? 'import-type' : 'import', node.moduleSpecifier)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      add('export-from', node.moduleSpecifier)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add('require', node.moduleReference.expression)
    } else if (ts.isCallExpression(node)) {
      const called = unwrapParentheses(node.expression)
      if (isCreateRequireCall(called)) {
        add('require', node.arguments[0], 'create-require')
      } else if (ts.isIdentifier(called) && aliases.has(called.text)) {
        add('require', node.arguments[0], 'create-require')
      } else if (called.kind === ts.SyntaxKind.ImportKeyword) {
        add('dynamic-import', node.arguments[0])
      } else if (ts.isIdentifier(called) && called.text === 'require') {
        const specifier = staticSpecifier(node.arguments[0]) ?? '<dynamic>'
        if (requireIsShadowed) {
          specifiers.push({ kind: 'require', specifier, reason: 'local binding shadows CommonJS require' })
        } else {
          add('require', node.arguments[0])
        }
      } else if (isCommonJsRequireResolve(called)) {
        const specifier = staticSpecifier(node.arguments[0]) ?? '<dynamic>'
        if (requireIsShadowed) {
          specifiers.push({ kind: 'require', specifier, reason: 'local binding shadows CommonJS require' })
        } else {
          add('require', node.arguments[0])
        }
      }
    } else if (ts.isIdentifier(node) && aliases.has(node.text)) {
      const declaration = aliases.get(node.text)!
      const isDeclaration = declaration.name === node
      const isLoaderCall = ts.isCallExpression(node.parent) && node.parent.expression === node
      if (!isDeclaration && !isLoaderCall && !escapedAliases.has(node.text)) {
        escapedAliases.add(node.text)
        specifiers.push({
          kind: 'require',
          specifier: '<ambiguous>',
          reason: `createRequire loader "${node.text}" escapes static analysis`,
        })
      }
    } else if (ts.isIdentifier(node) && createRequireNames.has(node.text)) {
      const isImportBinding = ts.isImportSpecifier(node.parent)
      const isFactoryCall = ts.isCallExpression(node.parent) && node.parent.expression === node
      if (!isImportBinding && !isFactoryCall) {
        specifiers.push({
          kind: 'require',
          specifier: '<ambiguous>',
          reason: `createRequire factory "${node.text}" escapes static analysis`,
        })
      }
    } else if (ts.isIdentifier(node) &&
        node.text === 'require' &&
        !isDeclarationName(node) &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
      let reference: ts.Node = node
      while (ts.isParenthesizedExpression(reference.parent) && reference.parent.expression === reference) {
        reference = reference.parent
      }
      const isDirectCall = ts.isCallExpression(reference.parent) && reference.parent.expression === reference
      const isResolveCall = ts.isPropertyAccessExpression(reference.parent) &&
        reference.parent.expression === reference &&
        reference.parent.name.text === 'resolve' &&
        ts.isCallExpression(reference.parent.parent) &&
        reference.parent.parent.expression === reference.parent
      if (!isDirectCall && !isResolveCall && !requireEscapeReported) {
        requireEscapeReported = true
        specifiers.push({
          kind: 'require',
          specifier: '<ambiguous>',
          reason: 'CommonJS require escapes static analysis',
        })
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
    const relativeFile = normalizeRelativePath(relative(repoRoot, file))
    return collectSpecifiers(sourceFile).flatMap(({ kind, specifier, reason, loader }) => {
      if (reason) return [{ file: relativeFile, kind, specifier, reason }]
      if (loader === 'create-require' && relativeFile === 'src/index.ts' && specifier === '../package.json') {
        return []
      }
      if (specifier.startsWith('.')) {
        const relativeReason = relativeViolation(sourceDir, file, specifier)
        return relativeReason ? [{ file: relativeFile, kind, specifier, reason: relativeReason }] : []
      }

      const root = packageRoot(specifier)
      if (specifier.startsWith('node:') || nodeBuiltins.has(specifier) || declared.has(root)) return []
      return [{
        file: relativeFile,
        kind,
        specifier,
        reason: `external package "${root}" is not declared in dependencies, optionalDependencies, or peerDependencies`,
      }]
    })
  })
}
