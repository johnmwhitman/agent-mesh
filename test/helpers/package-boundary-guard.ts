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
    .map(({ path }) => normalizeRelativePath(path))
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
  const unwrapped = expression && unwrapParentheses(expression)
  return unwrapped && (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped))
    ? unwrapped.text
    : undefined
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression
  while (true) {
    if (ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isTypeAssertionExpression(current) ||
        ts.isNonNullExpression(current) ||
        ts.isSatisfiesExpression(current)) {
      current = current.expression
      continue
    }
    return current
  }
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
    (ts.isBindingElement(parent) && parent.name === identifier) ||
    (ts.isParameter(parent) && parent.name === identifier) ||
    (ts.isFunctionDeclaration(parent) && parent.name === identifier) ||
    (ts.isFunctionExpression(parent) && parent.name === identifier) ||
    (ts.isMethodDeclaration(parent) && parent.name === identifier) ||
    (ts.isMethodSignature(parent) && parent.name === identifier) ||
    (ts.isGetAccessorDeclaration(parent) && parent.name === identifier) ||
    (ts.isSetAccessorDeclaration(parent) && parent.name === identifier) ||
    (ts.isPropertyDeclaration(parent) && parent.name === identifier) ||
    (ts.isPropertySignature(parent) && parent.name === identifier) ||
    (ts.isClassDeclaration(parent) && parent.name === identifier) ||
    (ts.isClassExpression(parent) && parent.name === identifier) ||
    (ts.isCatchClause(parent) && parent.variableDeclaration?.name === identifier) ||
    (ts.isImportClause(parent) && parent.name === identifier) ||
    (ts.isImportSpecifier(parent) && parent.name === identifier) ||
    (ts.isImportEqualsDeclaration(parent) && parent.name === identifier) ||
    ts.isNamespaceImport(parent)
}

function collectSpecifiers(sourceFile: ts.SourceFile): CollectedSpecifier[] {
  const specifiers: CollectedSpecifier[] = []
  const createRequireBindings = new Set<ts.Identifier>()
  const moduleObjectBindings = new Set<ts.Identifier>()
  const ambiguousModuleBindingElements = new Set<ts.BindingElement>()

  const nearestAncestor = (node: ts.Node, predicate: (candidate: ts.Node) => boolean): ts.Node | undefined => {
    let current: ts.Node | undefined = node.parent
    while (current) {
      if (predicate(current)) return current
      current = current.parent
    }
    return undefined
  }

  const lexicalScope = (name: ts.Identifier): ts.Node | undefined => {
    let declaration: ts.Node = name.parent
    while (ts.isBindingElement(declaration)) declaration = declaration.parent.parent

    if (ts.isParameter(declaration)) return declaration.parent
    if (ts.isCatchClause(declaration)) return declaration
    if (ts.isVariableDeclaration(declaration)) {
      if (ts.isCatchClause(declaration.parent)) return declaration.parent
      const list = declaration.parent
      if (!ts.isVariableDeclarationList(list)) return undefined
      if (!(list.flags & ts.NodeFlags.BlockScoped)) {
        return nearestAncestor(list, (candidate) => ts.isFunctionLike(candidate) || ts.isSourceFile(candidate))
      }
      return nearestAncestor(list, (candidate) =>
        ts.isBlock(candidate) ||
        ts.isSourceFile(candidate) ||
        ts.isCaseBlock(candidate) ||
        ts.isForStatement(candidate) ||
        ts.isForInStatement(candidate) ||
        ts.isForOfStatement(candidate))
    }
    if (ts.isImportClause(declaration) ||
        ts.isImportSpecifier(declaration) ||
        ts.isNamespaceImport(declaration) ||
        ts.isImportEqualsDeclaration(declaration)) {
      return sourceFile
    }
    if (ts.isFunctionExpression(declaration) || ts.isClassExpression(declaration)) return declaration
    if (ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)) {
      return nearestAncestor(declaration, (candidate) => ts.isBlock(candidate) || ts.isSourceFile(candidate))
    }
    return undefined
  }

  const lexicalBindings: Array<{ name: ts.Identifier, scope: ts.Node }> = []
  const collectLexicalBindings = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isDeclarationName(node)) {
      const scope = lexicalScope(node)
      if (scope) lexicalBindings.push({ name: node, scope })
    }
    ts.forEachChild(node, collectLexicalBindings)
  }
  collectLexicalBindings(sourceFile)

  const resolveLexicalBinding = (reference: ts.Identifier): ts.Identifier | undefined =>
    lexicalBindings
      .filter(({ name, scope }) =>
        name.text === reference.text &&
        scope.pos <= reference.pos &&
        reference.end <= scope.end)
      .sort((left, right) =>
        (left.scope.end - left.scope.pos) - (right.scope.end - right.scope.pos))[0]?.name

  const owningVariableDeclaration = (name: ts.Identifier): ts.VariableDeclaration | undefined => {
    let current: ts.Node = name.parent
    while (ts.isBindingElement(current)) current = current.parent.parent
    return ts.isVariableDeclaration(current) ? current : undefined
  }

  const isVarBinding = (name: ts.Identifier): boolean => {
    const declaration = owningVariableDeclaration(name)
    return !!declaration &&
      ts.isVariableDeclarationList(declaration.parent) &&
      !(declaration.parent.flags & ts.NodeFlags.BlockScoped)
  }

  const resolvesToTrackedBinding = (
    reference: ts.Identifier,
    tracked: ReadonlySet<ts.Identifier>,
  ): boolean => {
    const declaration = resolveLexicalBinding(reference)
    if (!declaration) return false
    if (tracked.has(declaration)) return true
    if (!isVarBinding(declaration)) return false
    const scope = lexicalScope(declaration)
    return [...tracked].some((candidate) =>
      candidate.text === declaration.text &&
      isVarBinding(candidate) &&
      lexicalScope(candidate) === scope)
  }

  for (const statement of sourceFile.statements) {
    if (ts.isImportEqualsDeclaration(statement) &&
        ts.isExternalModuleReference(statement.moduleReference)) {
      const moduleSpecifier = staticSpecifier(statement.moduleReference.expression)
      if (moduleSpecifier && ['module', 'node:module'].includes(moduleSpecifier)) {
        moduleObjectBindings.add(statement.name)
        continue
      }
    }

    if (!ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !['module', 'node:module'].includes(statement.moduleSpecifier.text) ||
        !statement.importClause) continue

    const bindings = statement.importClause.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        const importedName = binding.propertyName?.text ?? binding.name.text
        if (importedName === 'createRequire') {
          createRequireBindings.add(binding.name)
        } else if (importedName === 'Module') {
          moduleObjectBindings.add(binding.name)
        }
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      moduleObjectBindings.add(bindings.name)
    }
    if (statement.importClause.name) moduleObjectBindings.add(statement.importClause.name)
  }

  const loaderAliasBindings = new Set<ts.Identifier>()

  const isModuleSpecifier = (expression: ts.Expression | undefined): boolean => {
    const specifier = staticSpecifier(expression)
    return specifier === 'module' || specifier === 'node:module'
  }

  const propertyName = (expression: ts.Expression): string | undefined => {
    const unwrapped = unwrapParentheses(expression)
    if (ts.isPropertyAccessExpression(unwrapped)) return unwrapped.name.text
    if (ts.isElementAccessExpression(unwrapped)) return staticSpecifier(unwrapped.argumentExpression)
    return undefined
  }

  const propertyReceiver = (expression: ts.Expression): ts.Expression | undefined => {
    const unwrapped = unwrapParentheses(expression)
    if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
      return unwrapParentheses(unwrapped.expression)
    }
    return undefined
  }

  const isDynamicModuleImport = (expression: ts.Expression): boolean => {
    const unwrapped = unwrapParentheses(expression)
    if (!ts.isAwaitExpression(unwrapped)) return false
    const awaited = unwrapParentheses(unwrapped.expression)
    return ts.isCallExpression(awaited) &&
      awaited.expression.kind === ts.SyntaxKind.ImportKeyword &&
      isModuleSpecifier(awaited.arguments[0])
  }

  const isCommonJsModuleRequire = (expression: ts.Expression): boolean => {
    const unwrapped = unwrapParentheses(expression)
    if (!ts.isCallExpression(unwrapped)) return false
    const called = unwrapParentheses(unwrapped.expression)
    return ts.isIdentifier(called) &&
      called.text === 'require' &&
      resolveLexicalBinding(called) === undefined &&
      isModuleSpecifier(unwrapped.arguments[0])
  }

  const isModuleObjectExpression = (expression: ts.Expression): boolean => {
    const unwrapped = unwrapParentheses(expression)
    if ((ts.isIdentifier(unwrapped) && resolvesToTrackedBinding(unwrapped, moduleObjectBindings)) ||
      isCommonJsModuleRequire(unwrapped) ||
      isDynamicModuleImport(unwrapped)) {
      return true
    }
    if (ts.isBinaryExpression(unwrapped)) {
      if (unwrapped.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        return isModuleObjectExpression(unwrapped.right)
      }
      if (unwrapped.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          unwrapped.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          unwrapped.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
        return isModuleObjectExpression(unwrapped.left) || isModuleObjectExpression(unwrapped.right)
      }
    }
    if (ts.isConditionalExpression(unwrapped)) {
      return isModuleObjectExpression(unwrapped.whenTrue) || isModuleObjectExpression(unwrapped.whenFalse)
    }
    const receiver = propertyReceiver(unwrapped)
    return propertyName(unwrapped) === 'Module' &&
      !!receiver &&
      isModuleObjectExpression(receiver)
  }

  const isCreateRequireExpression = (expression: ts.Expression): boolean => {
    const unwrapped = unwrapParentheses(expression)
    if (ts.isIdentifier(unwrapped) && resolvesToTrackedBinding(unwrapped, createRequireBindings)) return true
    if (propertyName(unwrapped) !== 'createRequire') return false
    const receiver = propertyReceiver(unwrapped)
    return !!receiver && isModuleObjectExpression(receiver)
  }

  // Resolve module-object and createRequire factory aliases to a fixed point so
  // declaration order and multi-hop const aliases cannot open a scan bypass.
  let bindingsChanged = true
  const collectModuleObjectBinding = (pattern: ts.ObjectBindingPattern): void => {
    const excludedNames = new Set(pattern.elements.flatMap((element) => {
      if (element.dotDotDotToken) return []
      const name = !element.propertyName
        ? ts.isIdentifier(element.name) ? element.name.text : undefined
        : ts.isIdentifier(element.propertyName) ||
            ts.isStringLiteral(element.propertyName) ||
            ts.isNoSubstitutionTemplateLiteral(element.propertyName)
          ? element.propertyName.text
          : ts.isComputedPropertyName(element.propertyName)
            ? staticSpecifier(element.propertyName.expression)
            : undefined
      return name === undefined ? [] : [name]
    }))
    for (const element of pattern.elements) {
      if (element.dotDotDotToken) {
        if (ts.isIdentifier(element.name) &&
            !(excludedNames.has('createRequire') && excludedNames.has('Module')) &&
            !moduleObjectBindings.has(element.name)) {
          moduleObjectBindings.add(element.name)
          bindingsChanged = true
        }
        continue
      }
      if (element.propertyName &&
          ts.isComputedPropertyName(element.propertyName) &&
          staticSpecifier(element.propertyName.expression) === undefined) {
        ambiguousModuleBindingElements.add(element)
        continue
      }
      const importedName = !element.propertyName
        ? ts.isIdentifier(element.name) ? element.name.text : undefined
        : ts.isIdentifier(element.propertyName) ||
            ts.isStringLiteral(element.propertyName) ||
            ts.isNoSubstitutionTemplateLiteral(element.propertyName)
          ? element.propertyName.text
          : ts.isComputedPropertyName(element.propertyName)
            ? staticSpecifier(element.propertyName.expression)
            : undefined
      if (importedName === 'createRequire' &&
          ts.isIdentifier(element.name) &&
          !createRequireBindings.has(element.name)) {
        createRequireBindings.add(element.name)
        bindingsChanged = true
      } else if (importedName === 'Module') {
        if (ts.isIdentifier(element.name) && !moduleObjectBindings.has(element.name)) {
          moduleObjectBindings.add(element.name)
          bindingsChanged = true
        } else if (ts.isObjectBindingPattern(element.name)) {
          collectModuleObjectBinding(element.name)
        }
      }
    }
  }

  const collectBindingFromValue = (pattern: ts.BindingName, value: ts.Expression): void => {
    const unwrappedValue = unwrapParentheses(value)
    if (ts.isIdentifier(pattern)) {
      if (isModuleObjectExpression(unwrappedValue) && !moduleObjectBindings.has(pattern)) {
        moduleObjectBindings.add(pattern)
        bindingsChanged = true
      } else if (isCreateRequireExpression(unwrappedValue) && !createRequireBindings.has(pattern)) {
        createRequireBindings.add(pattern)
        bindingsChanged = true
      }
      return
    }
    if (ts.isObjectBindingPattern(pattern)) {
      if (isModuleObjectExpression(unwrappedValue)) collectModuleObjectBinding(pattern)
      return
    }
    if (!ts.isArrayLiteralExpression(unwrappedValue)) return
    pattern.elements.forEach((element, index) => {
      const item = unwrappedValue.elements[index]
      if (!item || ts.isOmittedExpression(element) || ts.isOmittedExpression(item)) return
      collectBindingFromValue(element.name, item as ts.Expression)
    })
  }

  while (bindingsChanged) {
    bindingsChanged = false
    const collectBindings = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        collectBindingFromValue(node.name, node.initializer)
      } else if (ts.isParameter(node) && node.initializer) {
        collectBindingFromValue(node.name, node.initializer)
      } else if (ts.isBindingElement(node) && node.initializer) {
        collectBindingFromValue(node.name, node.initializer)
      } else if (ts.isForOfStatement(node) &&
          ts.isVariableDeclarationList(node.initializer)) {
        const iterable = unwrapParentheses(node.expression)
        if (ts.isArrayLiteralExpression(iterable)) {
          for (const declaration of node.initializer.declarations) {
            for (const item of iterable.elements) {
              if (!ts.isOmittedExpression(item)) {
                collectBindingFromValue(declaration.name, item as ts.Expression)
              }
            }
          }
        }
      }
      ts.forEachChild(node, collectBindings)
    }
    collectBindings(sourceFile)
  }

  const isCreateRequireCall = (node: ts.Node | undefined): node is ts.CallExpression =>
    !!node && ts.isCallExpression(node) && isCreateRequireExpression(node.expression)

  const isCommonJsRequireResolve = (expression: ts.Expression): boolean => {
    if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== 'resolve') return false
    const receiver = unwrapParentheses(expression.expression)
    return ts.isIdentifier(receiver) && receiver.text === 'require'
  }

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
            loaderAliasBindings.has(declaration.name)) {
          specifiers.push({
            kind: 'require',
            specifier: '<ambiguous>',
            reason: 'createRequire loader binding cannot be resolved statically',
          })
        } else {
          loaderAliasBindings.add(declaration.name)
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

  const escapedAliases = new Set<ts.Identifier>()
  let requireEscapeReported = false

  const assignmentPropertyName = (name: ts.PropertyName): string | undefined => {
    if (ts.isIdentifier(name) ||
        ts.isStringLiteral(name) ||
        ts.isNumericLiteral(name) ||
        ts.isNoSubstitutionTemplateLiteral(name)) {
      return name.text
    }
    return ts.isComputedPropertyName(name) ? staticSpecifier(name.expression) : undefined
  }

  const objectAssignmentLoadsModule = (pattern: ts.ObjectLiteralExpression): boolean => {
    const excludedNames = new Set(pattern.properties.flatMap((property) => {
      if (ts.isSpreadAssignment(property)) return []
      const name = assignmentPropertyName(property.name)
      return name === undefined ? [] : [name]
    }))

    return pattern.properties.some((property) => {
      if (ts.isSpreadAssignment(property)) {
        return !(excludedNames.has('createRequire') && excludedNames.has('Module'))
      }
      const name = assignmentPropertyName(property.name)
      if (name === undefined) return true
      if (name === 'createRequire') return true
      if (name !== 'Module') return false
      if (ts.isPropertyAssignment(property)) {
        const initializer = unwrapParentheses(property.initializer)
        return ts.isObjectLiteralExpression(initializer)
          ? objectAssignmentLoadsModule(initializer)
          : true
      }
      return true
    })
  }

  const assignmentLoadsModule = (left: ts.Expression, right: ts.Expression): boolean => {
    const unwrappedLeft = unwrapParentheses(left)
    const unwrappedRight = unwrapParentheses(right)
    if (isModuleObjectExpression(unwrappedRight)) {
      return ts.isIdentifier(unwrappedLeft) ||
        (ts.isObjectLiteralExpression(unwrappedLeft) && objectAssignmentLoadsModule(unwrappedLeft))
    }
    if (ts.isArrayLiteralExpression(unwrappedLeft) && ts.isArrayLiteralExpression(unwrappedRight)) {
      return unwrappedLeft.elements.some((element, index) => {
        const value = unwrappedRight.elements[index]
        return !!value &&
          !ts.isOmittedExpression(element) &&
          !ts.isOmittedExpression(value) &&
          assignmentLoadsModule(element as ts.Expression, value as ts.Expression)
      })
    }
    return false
  }

  const addAmbiguousModuleAssignment = (): void => {
    specifiers.push({
      kind: 'require',
      specifier: '<ambiguous>',
      reason: 'module object destructuring assignment cannot be resolved statically',
    })
  }

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
      } else if (ts.isIdentifier(called) && resolvesToTrackedBinding(called, loaderAliasBindings)) {
        add('require', node.arguments[0], 'create-require')
      } else if (called.kind === ts.SyntaxKind.ImportKeyword) {
        let reference: ts.Node = node
        while (ts.isParenthesizedExpression(reference.parent) && reference.parent.expression === reference) {
          reference = reference.parent
        }
        if (isModuleSpecifier(node.arguments[0]) && !ts.isAwaitExpression(reference.parent)) {
          specifiers.push({
            kind: 'require',
            specifier: '<ambiguous>',
            reason: 'dynamic module import is not awaited and cannot be resolved statically',
          })
        } else {
          add('dynamic-import', node.arguments[0])
        }
      } else if (ts.isIdentifier(called) && called.text === 'require') {
        const specifier = staticSpecifier(node.arguments[0]) ?? '<dynamic>'
        if (resolveLexicalBinding(called)) {
          specifiers.push({ kind: 'require', specifier, reason: 'local binding shadows CommonJS require' })
        } else {
          add('require', node.arguments[0])
        }
      } else if (isCommonJsRequireResolve(called)) {
        const specifier = staticSpecifier(node.arguments[0]) ?? '<dynamic>'
        const receiver = unwrapParentheses(called.expression)
        if (ts.isIdentifier(receiver) && resolveLexicalBinding(receiver)) {
          specifiers.push({ kind: 'require', specifier, reason: 'local binding shadows CommonJS require' })
        } else {
          add('require', node.arguments[0])
        }
      }
    } else if (ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        assignmentLoadsModule(node.left, node.right)) {
      addAmbiguousModuleAssignment()
    } else if (ts.isForOfStatement(node) &&
        ts.isExpression(node.initializer) &&
        ts.isArrayLiteralExpression(unwrapParentheses(node.expression)) &&
        unwrapParentheses(node.expression).elements.some((element) =>
          !ts.isOmittedExpression(element) &&
          assignmentLoadsModule(node.initializer as ts.Expression, element as ts.Expression))) {
      addAmbiguousModuleAssignment()
    } else if (ts.isElementAccessExpression(node) &&
        staticSpecifier(node.argumentExpression) === undefined &&
        isModuleObjectExpression(node.expression)) {
      specifiers.push({
        kind: 'require',
        specifier: '<ambiguous>',
        reason: 'module object computed property cannot be resolved statically',
      })
    } else if (ts.isBindingElement(node) && ambiguousModuleBindingElements.has(node)) {
      specifiers.push({
        kind: 'require',
        specifier: '<ambiguous>',
        reason: 'module object computed property cannot be resolved statically',
      })
    } else if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        isCreateRequireExpression(node)) {
      let reference: ts.Node = node
      while (ts.isParenthesizedExpression(reference.parent) && reference.parent.expression === reference) {
        reference = reference.parent
      }
      const isFactoryCall = ts.isCallExpression(reference.parent) && reference.parent.expression === reference
      const isTrackedInitializer = ts.isVariableDeclaration(reference.parent) &&
        reference.parent.initializer === reference &&
        ts.isIdentifier(reference.parent.name) &&
        createRequireBindings.has(reference.parent.name) &&
        ts.isVariableDeclarationList(reference.parent.parent) &&
        !!(reference.parent.parent.flags & ts.NodeFlags.Const)
      if (!isFactoryCall && !isTrackedInitializer) {
        specifiers.push({
          kind: 'require',
          specifier: '<ambiguous>',
          reason: 'createRequire factory expression escapes static analysis',
        })
      }
    } else if (ts.isIdentifier(node) && resolvesToTrackedBinding(node, loaderAliasBindings)) {
      const declaration = resolveLexicalBinding(node)!
      const isDeclaration = declaration === node
      const isLoaderCall = ts.isCallExpression(node.parent) && node.parent.expression === node
      if (!isDeclaration && !isLoaderCall && !escapedAliases.has(declaration)) {
        escapedAliases.add(declaration)
        specifiers.push({
          kind: 'require',
          specifier: '<ambiguous>',
          reason: `createRequire loader "${node.text}" escapes static analysis`,
        })
      }
    } else if (ts.isIdentifier(node) && resolvesToTrackedBinding(node, createRequireBindings)) {
      let reference: ts.Node = node
      while (ts.isParenthesizedExpression(reference.parent) && reference.parent.expression === reference) {
        reference = reference.parent
      }
      const isFactoryCall = ts.isCallExpression(reference.parent) && reference.parent.expression === reference
      const isPropertyName =
        (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
        (ts.isBindingElement(node.parent) && node.parent.propertyName === node)
      if (!isDeclarationName(node) && !ts.isImportSpecifier(node.parent) && !isPropertyName && !isFactoryCall) {
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
