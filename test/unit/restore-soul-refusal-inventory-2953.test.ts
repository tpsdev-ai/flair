/**
 * restore-soul-refusal-inventory-2953.test.ts — the Soul write-refusal
 * inventory behind `flair restore --replace` (flair#2953).
 *
 * The source set is the relative-import closure of resources/Soul.ts. Every
 * Response identifier token in the import closure's source is accounted for;
 * a name built at runtime (e.g. from strings) is not seen — #2970 replaces
 * this inventory with a server dry run.
 *
 * The tokens come from TypeScript's scanner over each module's raw text
 * (trivia and comments skipped; string and template literal contents are not
 * identifiers), independently of the AST classifier. For each token the
 * classifier records one disposition: a classified Response construction or
 * call, an unresolved site, an alias definition it follows (and whose uses it
 * classifies), a type reference, or an `instanceof` check. Any lexical token
 * without a disposition fails, naming file:line. For new Response and
 * Response.json, only no init (default 200) or a plain, unwrapped object
 * literal with no spread or computed keys is classified; every property is
 * read to prove status absent or statically numeric. Every other init, every
 * other static method (`Response.redirect`) and `Response.error()` (status 0)
 * is unresolved and fails with file:line unless listed with a reason.
 * Recognised status-taking helpers require statically numeric status
 * arguments; their unresolved definitions must also be listed. A function that
 * forwards one of its parameters into a callee the inventory cannot resolve (a
 * method call, a computed callee, a callee outside the closure), including
 * through a parenthesis, an `as` cast or a non-null assertion, is opaque:
 * listed by name with a reason, or the test fails naming it. Refusal codes
 * must be preflighted, admission-refused or listed out of scope.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const root = join(import.meta.dir, "../..");
const ENTRY = "resources/Soul.ts";

/** The modules the inventory named before it derived its set from imports. */
const REQUIRED_SOURCES = [
  "resources/Soul.ts",
  "resources/soul-write-policy.ts",
  "resources/skill-provenance.ts",
  "resources/originator-instance.ts",
  "resources/owner-field-guard.ts",
  "resources/record-owner-guard.ts",
  "resources/instruction-version-record.ts",
  "src/lib/soul-scope-fields.ts",
] as const;

// ─── Module graph ───────────────────────────────────────────────────────────

/** Resolve a relative module specifier to a TypeScript source file in the repo. */
function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const target = resolve(dirname(join(root, fromFile)), specifier);
  const candidates = target.endsWith(".js") ? [target.slice(0, -3) + ".ts", target] : [target + ".ts", target];
  for (const candidate of candidates) {
    if (candidate.endsWith(".ts") && existsSync(candidate)) return relative(root, candidate);
  }
  return null;
}

function parseSource(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(join(root, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** The transitive closure of relative imports starting at resources/Soul.ts. */
function collectSourceSet(): Map<string, ts.SourceFile> {
  const sources = new Map<string, ts.SourceFile>();
  const pending = [ENTRY];
  while (pending.length > 0) {
    const file = pending.shift()!;
    if (sources.has(file)) continue;
    const source = parseSource(file);
    sources.set(file, source);
    const visit = (node: ts.Node): void => {
      const specifier =
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : null;
      if (specifier) {
        const resolved = resolveRelative(file, specifier);
        if (resolved && !sources.has(resolved)) pending.push(resolved);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sources;
}

// ─── Refusal call sites ─────────────────────────────────────────────────────

type FnNode = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

interface FnRecord {
  file: string;
  name: string;
  key: string;
  fn: FnNode;
}

interface FnInfo {
  /** The Response status comes from this parameter (a status-taking builder). */
  statusParam: string | null;
  /** The Response error comes from this parameter (a code-taking builder). */
  messageParam: string | null;
}

interface RefusalInventory {
  /** Refusal code → the file:line of the first site that produces it. */
  codes: Map<string, string>;
  unresolved: Map<string, string>;
  /** Construction or call sites that reference Response directly or through an alias. */
  occurrences: number;
  /** Lexical `Response` identifier tokens in the source set. */
  lexicalTokens: number;
  /** Tokens whose construction or call `responseShape` classified (a status list it proved). */
  classified: number;
  /** Tokens recorded as unresolved references. */
  unresolvedReferences: number;
  /** Tokens that define an alias the classifier follows. */
  aliasDefinitions: number;
  /** Tokens in a type position, which cannot produce a refusal. */
  typeReferences: number;
  /** Tokens in an `instanceof` check, which cannot produce a refusal. */
  checkReferences: number;
  /** Alias uses classified or unresolved (there is no Response token at the use). */
  aliasSites: number;
  /** Lexical tokens with no disposition, as file:line. */
  unaccounted: string[];
  /** Dispositions with no lexical token; must stay empty. */
  notLexical: string[];
  /** Functions forwarding a parameter into a callee the inventory cannot resolve. */
  opaque: Map<string, string>;
}

/**
 * Unwrap the transparent wrappers a caller can put around an argument without
 * changing which value it passes: parentheses, an `as` cast, a `<T>` assertion
 * and a non-null assertion.
 */
function forwardedIdentifier(expression: ts.Expression | undefined): ts.Identifier | null {
  let current = expression;
  while (current) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
        ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    return ts.isIdentifier(current) ? current : null;
  }
  return null;
}

type ResponseAlias = { kind: "constructor" } | { kind: "method"; method: string };

interface LexicalToken {
  file: string;
  pos: number;
  line: number;
}

/**
 * Every `Response` identifier token in `raw`, from TypeScript's scanner and
 * independent of the AST: trivia and comments are skipped, and the contents of
 * a string or template literal are not identifiers.
 */
function lexicalResponseTokens(file: string, raw: string): LexicalToken[] {
  const tokens: LexicalToken[] = [];
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, raw);
  // `scan()` does not re-enter a template after a substitution's closing brace;
  // `reScanTemplateToken` does. Track the brace depth at each `${` so a `}`
  // closing an object literal is not mistaken for the substitution's close.
  const substitutions: number[] = [];
  let braces = 0;
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.OpenBraceToken) {
      braces++;
    } else if (token === ts.SyntaxKind.CloseBraceToken) {
      if (substitutions.length > 0 && braces === substitutions[substitutions.length - 1]) {
        token = scanner.reScanTemplateToken(false);
        if (token === ts.SyntaxKind.TemplateTail) substitutions.pop();
        continue;
      }
      braces--;
    } else if (token === ts.SyntaxKind.TemplateHead) {
      substitutions.push(braces);
    }
    if (token === ts.SyntaxKind.Identifier && scanner.getTokenText() === "Response") {
      const pos = scanner.getTokenStart();
      tokens.push({ file, pos, line: raw.slice(0, pos).split("\n").length });
    }
  }
  return tokens;
}

/** Every `Response` identifier inside an expression, whatever form it takes. */
function responseIdentifiersIn(expression: ts.Expression): ts.Identifier[] {
  const found: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "Response") found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return found;
}

function parametersOf(fn: FnNode): Set<string> {
  const names = new Set<string>();
  for (const parameter of fn.parameters) if (ts.isIdentifier(parameter.name)) names.add(parameter.name.text);
  return names;
}

function bodyOf(fn: FnNode): ts.Node {
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return fn.body;
  return fn.body ?? fn;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/**
 * A refusal code is the snake_case rule name before the first ":" when the
 * literal carries one; a prose message (the `forbidden: …` attribution and
 * owner-field refusals) is kept whole so distinct refusals stay distinct.
 */
function codeOf(message: string): string {
  const colon = message.indexOf(":");
  if (colon < 0) return message;
  const prefix = message.slice(0, colon);
  return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(prefix) ? prefix : message;
}

/** `Response`, `globalThis.Response`, `self.Response`, … — the constructor, not a member of a row. */
function isResponseReferenceName(expression: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expression)) return isResponseReferenceName(expression.expression);
  if (ts.isIdentifier(expression)) return expression.text === "Response";
  return ts.isPropertyAccessExpression(expression) && expression.name.text === "Response";
}

/** The Response constructor or static method a `new`/call's callee names, directly or through an alias. */
function responseCallee(file: string, callee: ts.Expression, aliases: Map<string, Map<string, ResponseAlias>>): ResponseAlias | null {
  const local = aliases.get(file);
  if (isResponseReferenceName(callee)) return { kind: "constructor" };
  if (ts.isPropertyAccessExpression(callee)) {
    if (isResponseReferenceName(callee.expression)) return { kind: "method", method: callee.name.text };
    if (ts.isIdentifier(callee.expression)) {
      const alias = local?.get(callee.expression.text);
      if (alias?.kind === "constructor") return { kind: "method", method: callee.name.text };
    }
    return null;
  }
  if (ts.isIdentifier(callee)) return local?.get(callee.text) ?? null;
  return null;
}

function buildInventory(sources: Map<string, ts.SourceFile>): RefusalInventory {
  const importAliases = new Map<string, Map<string, { file: string; name: string }>>();
  const topLevelConsts = new Map<string, Map<string, ts.Expression>>();
  const responseAliases = new Map<string, Map<string, ResponseAlias>>();
  const exportedAliases = new Map<string, Map<string, ResponseAlias>>();
  const aliasConsts = new Map<string, Array<{ name: string; initializer: ts.Expression }>>();
  const aliasDestructured = new Map<string, Array<{ name: string; property: string; initializer: ts.Expression }>>();
  const aliasImports = new Map<string, Array<{ localName: string; importedName: string; targetFile: string }>>();
  const aliasLocalExports = new Map<string, Array<{ exportedName: string; localName: string }>>();
  const aliasReExports = new Map<string, Array<{ exportedName: string; importedName: string; targetFile: string }>>();
  const aliasStarExports = new Map<string, string[]>();
  const aliasExportDeclarations = new Map<string, Set<string>>();
  const functions: FnRecord[] = [];
  const functionsByName = new Map<string, FnRecord>();

  for (const [file, source] of sources) {
    const aliases = new Map<string, { file: string; name: string }>();
    const constants = new Map<string, ts.Expression>();
    const consts: Array<{ name: string; initializer: ts.Expression }> = [];
    const destructured: Array<{ name: string; property: string; initializer: ts.Expression }> = [];
    const imports: Array<{ localName: string; importedName: string; targetFile: string }> = [];
    const localExports: Array<{ exportedName: string; localName: string }> = [];
    const reExports: Array<{ exportedName: string; importedName: string; targetFile: string }> = [];
    const starExports: string[] = [];
    const exportDeclarations = new Set<string>();
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const target = resolveRelative(file, statement.moduleSpecifier.text);
        const bindings = statement.importClause?.namedBindings;
        if (target && bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const importedName = (element.propertyName ?? element.name).text;
            aliases.set(element.name.text, { file: target, name: importedName });
            imports.push({ localName: element.name.text, importedName, targetFile: target });
          }
        }
      }
      if (ts.isExportDeclaration(statement)) {
        const target = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? resolveRelative(file, statement.moduleSpecifier.text)
          : null;
        const clause = statement.exportClause;
        if (clause && ts.isNamedExports(clause)) {
          for (const element of clause.elements) {
            const exportedName = element.name.text;
            const localName = (element.propertyName ?? element.name).text;
            if (target) reExports.push({ exportedName, importedName: localName, targetFile: target });
            else localExports.push({ exportedName, localName });
          }
        } else if (!clause && target) {
          starExports.push(target);
        }
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer) constants.set(declaration.name.text, declaration.initializer);
        }
      }
      const addFunction = (name: string, fn: FnNode): void => {
        functions.push({ file, name, key: `${file}:${name}`, fn });
      };
      if (ts.isFunctionDeclaration(statement) && statement.name) addFunction(statement.name.text, statement);
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer &&
              (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
            addFunction(declaration.name.text, declaration.initializer);
          }
        }
      }
      if (ts.isClassDeclaration(statement) && statement.name) {
        for (const member of statement.members) {
          if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name)) addFunction(`${statement.name.text}.${member.name.text}`, member);
        }
      }
    }
    const collectVariables = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const list = node.parent;
        const statement = list && ts.isVariableDeclarationList(list) ? list.parent : undefined;
        const exported = !!(statement && ts.isVariableStatement(statement) && statement.parent === source &&
          (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false));
        if (ts.isIdentifier(node.name)) {
          consts.push({ name: node.name.text, initializer: node.initializer });
          if (exported) exportDeclarations.add(node.name.text);
        } else if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            if (element.dotDotDotToken || !ts.isIdentifier(element.name)) continue;
            const property = element.propertyName && (ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName))
              ? element.propertyName.text
              : element.name.text;
            destructured.push({ name: element.name.text, property, initializer: node.initializer });
            if (exported) exportDeclarations.add(element.name.text);
          }
        }
      }
      ts.forEachChild(node, collectVariables);
    };
    collectVariables(source);
    importAliases.set(file, aliases);
    topLevelConsts.set(file, constants);
    responseAliases.set(file, new Map());
    exportedAliases.set(file, new Map());
    aliasConsts.set(file, consts);
    aliasDestructured.set(file, destructured);
    aliasImports.set(file, imports);
    aliasLocalExports.set(file, localExports);
    aliasReExports.set(file, reExports);
    aliasStarExports.set(file, starExports);
    aliasExportDeclarations.set(file, exportDeclarations);
  }
  for (const record of functions) if (!functionsByName.has(record.key)) functionsByName.set(record.key, record);

  const unwrapAliasExpression = (expression: ts.Expression): ts.Expression => {
    let current = expression;
    while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
           ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current) ||
           ts.isSatisfiesExpression(current)) {
      current = current.expression;
    }
    return current;
  };
  const sameAliasMap = (left: Map<string, ResponseAlias>, right: Map<string, ResponseAlias>): boolean => {
    if (left.size !== right.size) return false;
    for (const [name, alias] of left) {
      const other = right.get(name);
      if (!other || other.kind !== alias.kind) return false;
      if (alias.kind === "method" && other.kind === "method" && alias.method !== other.method) return false;
    }
    return true;
  };
  // Resolve local aliases, imports and exports to a fixpoint: `const { json } =
  // Response`, `const R = Response as any`, `export { Response as R }` and a
  // re-export from another module all name the same constructor or method.
  for (let pass = 0; pass < 12; pass++) {
    let mutated = false;
    for (const file of sources.keys()) {
      const local = new Map<string, ResponseAlias>();
      const aliasOf = (expression: ts.Expression): ResponseAlias | null => {
        const unwrapped = unwrapAliasExpression(expression);
        if (isResponseReferenceName(unwrapped)) return { kind: "constructor" };
        return ts.isIdentifier(unwrapped) ? (local.get(unwrapped.text) ?? null) : null;
      };
      for (const declaration of aliasConsts.get(file) ?? []) {
        const alias = aliasOf(declaration.initializer);
        if (alias) local.set(declaration.name, alias);
      }
      for (const declaration of aliasDestructured.get(file) ?? []) {
        const base = aliasOf(declaration.initializer);
        if (base?.kind === "constructor") local.set(declaration.name, { kind: "method", method: declaration.property });
      }
      for (const element of aliasImports.get(file) ?? []) {
        const alias = exportedAliases.get(element.targetFile)?.get(element.importedName);
        if (alias) local.set(element.localName, alias);
      }
      const exported = new Map<string, ResponseAlias>();
      for (const name of aliasExportDeclarations.get(file) ?? []) {
        const alias = local.get(name);
        if (alias) exported.set(name, alias);
      }
      for (const element of aliasLocalExports.get(file) ?? []) {
        const alias = element.localName === "Response" ? { kind: "constructor" as const } : local.get(element.localName);
        if (alias) exported.set(element.exportedName, alias);
      }
      for (const element of aliasReExports.get(file) ?? []) {
        const alias = exportedAliases.get(element.targetFile)?.get(element.importedName);
        if (alias) exported.set(element.exportedName, alias);
      }
      for (const target of aliasStarExports.get(file) ?? []) {
        for (const [name, alias] of exportedAliases.get(target) ?? []) if (!exported.has(name)) exported.set(name, alias);
      }
      if (!sameAliasMap(responseAliases.get(file)!, local)) {
        responseAliases.set(file, local);
        mutated = true;
      }
      if (!sameAliasMap(exportedAliases.get(file)!, exported)) {
        exportedAliases.set(file, exported);
        mutated = true;
      }
    }
    if (!mutated) break;
  }

  const resolveFunction = (file: string, name: string): FnRecord | null => {
    const local = functionsByName.get(`${file}:${name}`);
    if (local) return local;
    const alias = importAliases.get(file)?.get(name);
    return alias ? (functionsByName.get(`${alias.file}:${alias.name}`) ?? null) : null;
  };

  const lookupVariable = (at: ts.Node, name: string, constantOnly = false): ts.Expression | null => {
    let parent: ts.Node | undefined = at.parent;
    while (parent) {
      if (constantOnly) {
        if (ts.isFunctionLike(parent) && parent.parameters.some((parameter) =>
          !ts.isIdentifier(parameter.name) || parameter.name.text === name)) return null;
        if (ts.isCatchClause(parent) || ts.isForStatement(parent) || ts.isForOfStatement(parent) || ts.isForInStatement(parent)) return null;
      }
      const statements = ts.isSourceFile(parent) || ts.isBlock(parent) || ts.isModuleBlock(parent) ? parent.statements : null;
      if (statements) {
        for (const statement of statements) {
          if (!ts.isVariableStatement(statement)) continue;
          for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name)) {
              if (constantOnly) return null;
              continue;
            }
            if (declaration.name.text !== name) continue;
            if (constantOnly && (!(statement.declarationList.flags & ts.NodeFlags.Const) || declaration.getStart() >= at.getStart())) return null;
            return declaration.initializer ?? null;
          }
        }
      }
      parent = parent.parent;
    }
    return constantOnly ? null : (topLevelConsts.get(at.getSourceFile().fileName)?.get(name) ?? null);
  };

  const resolveString = (file: string, expression: ts.Expression | null | undefined, depth = 0): string[] | null => {
    if (!expression || depth > 8) return null;
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) ||
        ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression)) {
      return resolveString(file, expression.expression, depth + 1);
    }
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return [expression.text];
    if (ts.isTemplateExpression(expression)) return null;
    if (ts.isConditionalExpression(expression)) {
      const whenTrue = resolveString(file, expression.whenTrue, depth + 1);
      const whenFalse = resolveString(file, expression.whenFalse, depth + 1);
      return whenTrue && whenFalse ? [...new Set([...whenTrue, ...whenFalse])] : null;
    }
    if (ts.isPropertyAccessExpression(expression)) return resolveReturnedProperty(file, expression, depth + 1);
    if (ts.isIdentifier(expression)) {
      const local = lookupVariable(expression, expression.text);
      if (local) return resolveString(file, local, depth + 1);
      const alias = importAliases.get(file)?.get(expression.text);
      const imported = alias ? topLevelConsts.get(alias.file)?.get(alias.name) : null;
      return imported ? resolveString(alias!.file, imported, depth + 1) : null;
    }
    return null;
  };

  /** `result.error` where `const result = f(…)` and `f` returns an `error` string in its object returns. */
  const resolveReturnedProperty = (file: string, expression: ts.PropertyAccessExpression, depth: number): string[] | null => {
    if (!ts.isIdentifier(expression.expression)) return null;
    const initializer = lookupVariable(expression.expression, expression.expression.text);
    if (!initializer) return null;
    if (ts.isObjectLiteralExpression(initializer)) {
      return resolveString(file, propertyOf(initializer, file, expression.name.text), depth + 1);
    }
    if (!ts.isCallExpression(initializer) || !ts.isIdentifier(initializer.expression)) return null;
    const target = resolveFunction(file, initializer.expression.text);
    if (!target) return null;
    const values: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
        const value = resolveString(target.file, propertyOf(node.expression, target.file, expression.name.text), depth + 1);
        if (value) values.push(...value);
      }
      ts.forEachChild(node, visit);
    };
    visit(bodyOf(target.fn));
    return values.length > 0 ? [...new Set(values)] : null;
  };

  const resolveNumbers = (file: string, expression: ts.Expression | null | undefined, depth = 0): number[] | null => {
    if (!expression || depth > 8) return null;
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)) {
      return resolveNumbers(file, expression.expression, depth + 1);
    }
    if (ts.isNumericLiteral(expression)) return [Number(expression.text)];
    if (ts.isConditionalExpression(expression)) {
      const whenTrue = resolveNumbers(file, expression.whenTrue, depth + 1);
      const whenFalse = resolveNumbers(file, expression.whenFalse, depth + 1);
      return whenTrue && whenFalse ? [...new Set([...whenTrue, ...whenFalse])] : null;
    }
    if (ts.isIdentifier(expression)) {
      const local = lookupVariable(expression, expression.text, true);
      return local ? resolveNumbers(file, local, depth + 1) : null;
    }
    return null;
  };

  /** The `JSON.stringify(...)` payload of a Response body, following local consts and conditionals. */
  const payloadOf = (file: string, expression: ts.Expression | null | undefined, depth = 0): ts.Expression | null => {
    if (!expression || depth > 6) return null;
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) &&
        expression.expression.name.text === "stringify") {
      return expression.arguments[0] ?? null;
    }
    if (ts.isIdentifier(expression)) {
      const local = lookupVariable(expression, expression.text);
      return local ? payloadOf(file, local, depth + 1) : null;
    }
    if (ts.isConditionalExpression(expression)) {
      return payloadOf(file, expression.whenTrue, depth + 1) ?? payloadOf(file, expression.whenFalse, depth + 1);
    }
    return ts.isObjectLiteralExpression(expression) ? expression : null;
  };

  const propertyOf = (object: ts.Expression | null | undefined, file: string, key: string, depth = 0): ts.Expression | null => {
    if (!object || depth > 6) return null;
    if (ts.isIdentifier(object)) {
      const local = lookupVariable(object, object.text);
      return local ? propertyOf(local, file, key, depth + 1) : null;
    }
    if (ts.isConditionalExpression(object)) {
      return propertyOf(object.whenTrue, file, key, depth + 1) ?? propertyOf(object.whenFalse, file, key, depth + 1);
    }
    if (!ts.isObjectLiteralExpression(object)) return null;
    for (const property of object.properties) {
      const name = ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) ? property.name : null;
      if (!name) continue;
      const matches = (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === key;
      if (!matches) continue;
      return ts.isPropertyAssignment(property) ? property.initializer : (property as ts.ShorthandPropertyAssignment).name;
    }
    return null;
  };

  type ResponseShape = {
    status: ts.Expression | undefined;
    statuses: number[] | null;
    body: ts.Expression | null;
  };

  const responseInit = (file: string, init: ts.Expression | undefined): Pick<ResponseShape, "status" | "statuses"> => {
    if (init === undefined) return { status: undefined, statuses: [200] };
    if (!ts.isObjectLiteralExpression(init)) return { status: undefined, statuses: null };
    let status: ts.Expression | undefined;
    for (const property of init.properties) {
      if (ts.isSpreadAssignment(property) || ts.isComputedPropertyName(property.name)) {
        return { status: undefined, statuses: null };
      }
      const name = property.name;
      if (!ts.isIdentifier(name) && !ts.isStringLiteral(name) && !ts.isNumericLiteral(name)) {
        return { status: undefined, statuses: null };
      }
      if (name.text === "__proto__") return { status: undefined, statuses: null };
      if (name.text !== "status") continue;
      if (ts.isPropertyAssignment(property)) status = property.initializer;
      else if (ts.isShorthandPropertyAssignment(property)) status = property.name;
      else return { status: undefined, statuses: null };
    }
    return { status, statuses: status === undefined ? [200] : resolveNumbers(file, status) };
  };

  const responseShape = (file: string, node: ts.Expression, callee: ResponseAlias): ResponseShape | null => {
    if (callee.kind === "constructor") {
      if (!ts.isNewExpression(node)) return null;
      const init = node.arguments?.[1];
      if (node.arguments?.some(ts.isSpreadElement)) return { status: undefined, statuses: null, body: null };
      return {
        ...responseInit(file, init),
        body: node.arguments?.[0] ?? null,
      };
    }
    if (!ts.isCallExpression(node)) return null;
    const method = callee.method;
    if (method === "json") {
      const init = node.arguments?.[1];
      if (node.arguments.some(ts.isSpreadElement)) return { status: undefined, statuses: null, body: null };
      return {
        ...responseInit(file, init),
        body: node.arguments?.[0] ?? null,
      };
    }
    if (method === "error") return { status: undefined, statuses: null, body: null };
    return null;
  };

  const describe = (record: FnRecord): FnInfo => {
    let statusParam: string | null = null;
    let messageParam: string | null = null;
    const parameters = parametersOf(record.fn);
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
        const callee = responseCallee(record.file, node.expression, responseAliases);
        const shape = callee ? responseShape(record.file, node, callee) : null;
        const status = shape?.status;
        if (status && ts.isIdentifier(status) && parameters.has(status.text)) statusParam = status.text;
        const error = propertyOf(payloadOf(record.file, shape?.body), record.file, "error");
        if (error && ts.isIdentifier(error) && parameters.has(error.text)) messageParam = error.text;
      }
      ts.forEachChild(node, visit);
    };
    visit(bodyOf(record.fn));
    return { statusParam, messageParam };
  };

  const info = new Map<string, FnInfo>();
  for (const record of functions) info.set(record.key, describe(record));

  // A message parameter is a sink when it reaches a refusal, directly or through
  // another sink function (stampAttribution forwards its forbiddenMessage to FORBIDDEN).
  const sinkParameter = new Map<string, string>();
  for (const record of functions) {
    const described = info.get(record.key)!;
    if (described.messageParam) sinkParameter.set(record.key, described.messageParam);
  }
  const sinkParamOf = (fn: FnNode | null): string | null => {
    const record = functions.find((candidate) => candidate.fn === fn);
    return record ? (sinkParameter.get(record.key) ?? null) : null;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of functions) {
      if (sinkParameter.has(record.key)) continue;
      const parameters = parametersOf(record.fn);
      let forwarded: string | null = null;
      const visit = (node: ts.Node): void => {
        if (forwarded) return;
        if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
        const target = resolveFunction(record.file, node.expression.text);
        const sink = target ? sinkParameter.get(target.key) : null;
        if (!target || !sink) return;
        let index = -1;
        target.fn.parameters.forEach((parameter, position) => {
          if (ts.isIdentifier(parameter.name) && parameter.name.text === sink) index = position;
        });
        const argument = index >= 0 ? node.arguments[index] : undefined;
        const forwardedArgument = forwardedIdentifier(argument);
        if (forwardedArgument && parameters.has(forwardedArgument.text)) forwarded = forwardedArgument.text;
      };
      const walk = (node: ts.Node): void => {
        if (forwarded) return;
        visit(node);
        ts.forEachChild(node, walk);
      };
      walk(bodyOf(record.fn));
      if (forwarded) {
        sinkParameter.set(record.key, forwarded);
        changed = true;
      }
    }
  }

  const codes = new Map<string, string>();
  const unresolved = new Map<string, string>();
  const recordCode = (message: string, file: string, line: number): void => {
    const code = codeOf(message);
    if (!codes.has(code)) codes.set(code, `${file}:${line}`);
  };
  const recordUnresolved = (file: string, line: number, detail: string): void => {
    const at = `${file}:${line}`;
    if (!unresolved.has(at)) unresolved.set(at, detail);
  };

  // (a) Calls to a function whose parameter is forwarded into a refusal.
  for (const [file, source] of sources) {
    const visit = (node: ts.Node): void => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) {
        ts.forEachChild(node, visit);
        return;
      }
      const target = resolveFunction(file, node.expression.text);
      const sink = target ? sinkParameter.get(target.key) : null;
      if (!target || !sink) {
        ts.forEachChild(node, visit);
        return;
      }
      let index = -1;
      target.fn.parameters.forEach((parameter, position) => {
        if (ts.isIdentifier(parameter.name) && parameter.name.text === sink) index = position;
      });
      const argument = index >= 0 ? node.arguments[index] : undefined;
      const forwardedArgument = forwardedIdentifier(argument);
      if (forwardedArgument && sinkParamOf(enclosingFunction(node)) === forwardedArgument.text) {
        ts.forEachChild(node, visit);
        return;
      }
      const values = resolveString(file, argument);
      if (values) for (const value of values) recordCode(value, file, lineOf(source, node));
      else recordUnresolved(file, lineOf(source, node), `unresolvable refusal argument: ${target.name}.${sink}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  // (b) The scanner's lexical tokens are accounted for one by one. Alias
  // definitions are recorded first: `const R = Response as any`, `const
  // { json } = Response`, `export { Response as R }` and an import or re-export
  // binding. Then a construction or call through the constructor or a followed
  // alias is classified or recorded unresolved. A token in no such position is
  // left unaccounted, and the test fails naming file:line.
  const accounted = new Map<string, string>();
  const account = (file: string, node: ts.Node, kind: string): void => {
    const key = `${file}:${node.getStart(node.getSourceFile())}`;
    if (!accounted.has(key)) accounted.set(key, kind);
  };
  for (const [file, source] of sources) {
    for (const declaration of aliasConsts.get(file) ?? []) {
      if (!responseAliases.get(file)?.has(declaration.name)) continue;
      for (const identifier of responseIdentifiersIn(declaration.initializer)) account(file, identifier, "alias");
    }
    for (const declaration of aliasDestructured.get(file) ?? []) {
      if (!responseAliases.get(file)?.has(declaration.name)) continue;
      for (const identifier of responseIdentifiersIn(declaration.initializer)) account(file, identifier, "alias");
    }
    const visitBindings = (node: ts.Node): void => {
      if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) {
        const original = node.propertyName ?? node.name;
        if (ts.isIdentifier(original) && original.text === "Response") account(file, original, "alias");
      }
      ts.forEachChild(node, visitBindings);
    };
    visitBindings(source);
  }

  let occurrences = 0;
  let classified = 0;
  let unresolvedReferences = 0;
  let aliasSites = 0;
  for (const [file, source] of sources) {
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
        const direct = responseIdentifiersIn(node.expression);
        const alias = responseCallee(file, node.expression, responseAliases);
        if (direct.length > 0 || alias) {
          occurrences++;
          if (alias) {
            const shape = responseShape(file, node, alias);
            if (shape && shape.statuses !== null) {
              if (direct.length > 0) classified += direct.length;
              else aliasSites++;
              for (const identifier of direct) account(file, identifier, "classified");
              if (shape.statuses.some((value) => value >= 400)) {
                const error = propertyOf(payloadOf(file, shape.body), file, "error");
                const holder = enclosingFunction(node);
                if (!(holder && error && ts.isIdentifier(error) && sinkParamOf(holder) === error.text)) {
                  const values = resolveString(file, error);
                  if (values) for (const value of values) recordCode(value, file, lineOf(source, node));
                  else recordUnresolved(file, lineOf(source, node), "unresolvable refusal body");
                }
              }
            } else {
              if (direct.length > 0) unresolvedReferences += direct.length;
              else aliasSites++;
              for (const identifier of direct) account(file, identifier, "unresolved");
              recordUnresolved(file, lineOf(source, node), shape ? "unresolvable Response status" : "unrecognised Response reference");
            }
          } else {
            unresolvedReferences += direct.length;
            for (const identifier of direct) account(file, identifier, "unresolved");
            recordUnresolved(file, lineOf(source, node), "unrecognised Response reference");
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  const isTypePosition = (node: ts.Node): boolean => {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isTypeNode(current)) return true;
      if (ts.isExpression(current) || ts.isStatement(current) || ts.isSourceFile(current)) return false;
      current = current.parent;
    }
    return false;
  };
  const isInstanceOfOperand = (node: ts.Node): boolean => {
    const parent = node.parent;
    return ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword;
  };
  for (const [file, source] of sources) {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === "Response" && !accounted.has(`${file}:${node.getStart(source)}`)) {
        if (isTypePosition(node)) account(file, node, "type");
        else if (isInstanceOfOperand(node)) account(file, node, "check");
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  const lexical = new Map<string, LexicalToken>();
  for (const [file, source] of sources) {
    for (const token of lexicalResponseTokens(file, source.text)) lexical.set(`${token.file}:${token.pos}`, token);
  }
  const count = (kind: string): number => [...accounted.values()].filter((value) => value === kind).length;
  const unaccounted = [...lexical]
    .filter(([key]) => !accounted.has(key))
    .map(([, token]) => `${token.file}:${token.line}`)
    .sort();
  const notLexical = [...accounted.keys()].filter((key) => !lexical.has(key)).sort();

  // (c) Calls to a status-taking builder (`jsonResponse(400, { error: … })`).
  for (const record of functions) {
    const statusParam = info.get(record.key)!.statusParam;
    if (!statusParam) continue;
    for (const [file, source] of sources) {
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && resolveFunction(file, node.expression.text)?.key === record.key) {
          let index = -1;
          record.fn.parameters.forEach((parameter, position) => {
            if (ts.isIdentifier(parameter.name) && parameter.name.text === statusParam) index = position;
          });
          const statuses = index >= 0 ? resolveNumbers(file, node.arguments[index]) : null;
          if (statuses && statuses.some((value) => value >= 400)) {
            const body = node.arguments.find((argument) => {
              if (ts.isObjectLiteralExpression(argument)) return true;
              if (!ts.isIdentifier(argument)) return false;
              const local = lookupVariable(argument, argument.text);
              return !!local && ts.isObjectLiteralExpression(local);
            });
            const values = resolveString(file, propertyOf(body, file, "error"));
            if (values) for (const value of values) recordCode(value, file, lineOf(source, node));
            else recordUnresolved(file, lineOf(source, node), "unresolvable refusal body");
          } else if (index >= 0 && statuses === null) {
            recordUnresolved(file, lineOf(source, node), `unresolvable status argument: ${record.name}.${statusParam}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }

  // (d) A function that forwards one of its parameters into a callee the
  // inventory cannot resolve is opaque.
  const opaque = new Map<string, string>();
  for (const record of functions) {
    const parameters = parametersOf(record.fn);
    if (parameters.size === 0) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const callee = node.expression;
        // An identifier that names a function in the closure is resolved; a
        // method call, a computed callee and any other expression are not.
        const resolved = ts.isIdentifier(callee) && resolveFunction(record.file, callee.text) !== null;
        if (!resolved) {
          for (const argument of node.arguments ?? []) {
            const forwardedArgument = forwardedIdentifier(argument);
            if (forwardedArgument && parameters.has(forwardedArgument.text) && !opaque.has(record.key)) {
              const source = record.fn.getSourceFile();
              opaque.set(record.key,
                `${record.file}:${lineOf(source, node)} forwards ${forwardedArgument.text} into ${callee.getText(source)}`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(bodyOf(record.fn));
  }

  return {
    codes, unresolved, occurrences, lexicalTokens: lexical.size, classified, unresolvedReferences,
    aliasDefinitions: count("alias"), typeReferences: count("type"), checkReferences: count("check"),
    aliasSites, unaccounted, notLexical, opaque,
  };
}

function enclosingFunction(node: ts.Node): FnNode | null {
  let parent: ts.Node | undefined = node.parent;
  while (parent) {
    if (ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) ||
        ts.isArrowFunction(parent) || ts.isMethodDeclaration(parent)) return parent;
    parent = parent.parent;
  }
  return null;
}

// ─── The three lists ────────────────────────────────────────────────────────

/** Refusal codes `restore --replace` decides before its first delete. */
const PREFLIGHTED = [
  "soul_scope_fields_not_writable", // suppliesSoulScopeFields in src/commands/restore.ts
  "soul_value_is_learned_content", // LEARNED_REFUSAL plus the Memory and candidate comparisons
  "skill_source_not_durable", // refuseSkillAssignmentWrite in src/lib/skill-assignment-preflight.ts
  "skill_opt_out_not_boolean", // the same predicate
] as const;

/** Codes archive admission already refuses, each with the check that covers it. */
const ADMISSION = new Map<string, string>([
  ["soul_owner_required", "rowShapeProblem refuses a Soul row whose agentId is not a non-empty string"],
]);

/** Codes the preflight deliberately leaves to the write, with the reason. */
const OUT_OF_SCOPE = new Map<string, string>([
  ["soul_write_requires_one_record", "body-shape guard: both the preflight and the write send the archive row as an object"],
  ["soul_write_requires_operator", "source-class gate: soulWriteSource (resources/soul-write-policy.ts) classifies the request, and the Soul DELETE evaluates the same gate before it runs"],
  ["authentication required", "source-class gate: the anonymous verdict comes from authorizeSoulWrite (resources/soul-write-policy.ts), and the Soul DELETE evaluates the same gate before it runs"],
  ["forbidden: agentId must match authenticated agent", "attribution guard: an admin credential takes the passthrough branch"],
  ["forbidden: the owner of a record cannot be changed", "owner-field guard: an admin credential takes the passthrough branch"],
  ["owner_check_unavailable", "owner-field guard: its read runs only for a non-admin caller"],
  ["id_target_mismatch", "body-id/address disagreement: restore addresses each row by its own id"],
  ["stored_row_lookup_failed", "stored-row read failure at the write, which the preflight does not perform"],
  ["stored_row_read_failed", "Memory/Relationship PATCH stored-row read failure; the Soul write path does not call it"],
  ["soul_delete_requires_one_record", "DELETE-only: restore --replace addresses each Soul row by its single-record id"],
  ["soul_stored_state_unavailable", "PATCH-only: restore --replace PUTs rows and never PATCHes"],
  ["soul_patch_table_unavailable", "PATCH-only: restore --replace PUTs rows and never PATCHes"],
  ["soul_patch_conflict", "PATCH-only: restore --replace PUTs rows and never PATCHes"],
  ["soul_patch_row_changed", "PATCH-only: restore --replace PUTs rows and never PATCHes"],
  ["soul_subject_occupied", "identity-change path: a successful Soul DELETE leaves the replace PUT no stored row, so its identity did not change; after a failed DELETE (recorded, and the PUT still runs) a stored row with a different identity can reach this 409"],
  ["instruction_version_head_mismatch", "compare-and-set: the replace PUT supplies no expectedVersion"],
  ["instruction_version_append_failed", "the server reports version append failures and catch-all-wrapped schema validation errors under this code (#2979); admission refuses checked schema cases (a present non-null held column of the wrong type or a missing required field the write does not supply) before any delete; unchecked validator refusals and append failures are not predictable here (#2970: server dry run)"],
  ["instruction_version_busy", "commit-time version lock contention, which the preflight cannot predict"],
  ["instruction_version_lock_unavailable", "commit-time version lock availability, which the preflight cannot predict"],
  ["skill_write_requires_verified_identity", "skill-version write authorization; the Soul write path does not call it"],
  ["not found", "kit by-id read gate: Soul has no get() override and the write path returns no 404"],
  ["non_canonical_request_target", "request-target canonicalisation in the auth middleware; not a Soul write rule"],
]);

/** Unresolved sites accepted by file:line with a reason. */
const UNRESOLVED_SITES = new Map<string, string>([
  ["resources/instruction-version-record.ts:272", "jsonResponse forwards its status parameter; its call sites are checked for static statuses"],
  ["resources/record-owner-guard.ts:220", "message interpolates the table name; the owner-scoped write middleware raises it, not the Soul row write"],
  ["resources/record-owner-guard.ts:231", "message interpolates the table name; the owner-scoped write middleware raises it, not the Soul row write"],
]);

/**
 * Functions that forward one of their parameters into a callee the inventory
 * cannot resolve, each with what the inventory knows about that call. This is
 * an explicit unresolved-call list, not a claim that forwarding cannot hide a
 * refusal: `Soul.put -> this.validate` hides validator refusals from this
 * inventory. #2970 replaces this inventory with a server dry run.
 * `file:name` matches the closure's own naming.
 */
const OPAQUE_FUNCTIONS = new Map<string, string>([
  ["resources/Soul.ts:enforceWriteAuth", "forwards data into Array.isArray, which the inventory does not resolve"],
  ["resources/Soul.ts:Soul.post", "forwards content into this.validate, which the inventory does not resolve"],
  ["resources/Soul.ts:Soul.patch", "forwards content into this.validate, which the inventory does not resolve"],
  ["resources/Soul.ts:Soul.put", "forwards content into this.validate, which the inventory does not resolve"],
  ["resources/Soul.ts:Soul.delete", "forwards id into super.delete, which the inventory does not resolve"],
  ["resources/originator-instance.ts:isPlainObject", "forwards value into Array.isArray, which the inventory does not resolve"],
  ["resources/originator-instance.ts:urlTargetId", "forwards resource into getId.call, which the inventory does not resolve"],
  ["resources/originator-instance.ts:idTargetMismatchDenial", "forwards bodyId into JSON.stringify, which the inventory does not resolve"],
  ["resources/record-types.ts:deepFreeze", "forwards value into Object.isFrozen, which the inventory does not resolve"],
  ["resources/skill-provenance.ts:parseSkillMetadata", "forwards metadata into Array.isArray, which the inventory does not resolve"],
  ["resources/skill-provenance.ts:isWindowsDrivePath", "forwards source into /^[a-zA-Z]:[\\/]/.test, which the inventory does not resolve"],
  ["resources/skill-provenance.ts:isNonDurableFilesystemPath", "forwards fsPath into resolve, which the inventory does not resolve"],
  ["resources/skill-provenance.ts:normalizePriority", "forwards p into Object.hasOwn, which the inventory does not resolve"],
  ["resources/instruction-version-record.ts:appendInstructionEvent", "forwards shared into events.create, which the inventory does not resolve"],
  ["resources/instruction-version-record.ts:removeAppendedVersion", "forwards versionRecordId into raw.delete.call, which the inventory does not resolve"],
  ["resources/instruction-version-record.ts:valueDigest", "forwards value into createHash().update, which the inventory does not resolve"],
  ["resources/instruction-version-record.ts:subjectTypeReadable", "forwards subjectType into AUTHORIZED_SUBJECT_TYPES.has, which the inventory does not resolve"],
  ["resources/instruction-version-record.ts:jsonResponse", "forwards body into JSON.stringify, which the inventory does not resolve"],
  ["resources/instruction-version-record.ts:readHead", "forwards shared into table.search, which the inventory does not resolve"],
  ["resources/instruction-version-record.ts:readVersionRecord", "forwards shared into table.search, which the inventory does not resolve"],
  ["resources/instruction-version-record.ts:readVersionRecordAfter", "forwards version into BigInt, which the inventory does not resolve"],
  ["resources/instruction-version-record.ts:resolveVersionAuthorization", "forwards subjectType into String, which the inventory does not resolve"],
  ["resources/instruction-version-record.ts:recordVersion", "forwards ctx into (joinsCaller ? withSharedWriteTransaction : withOwnedTransaction), which the inventory does not resolve"],
  ["resources/txn-pause-point.ts:isInside", "forwards parent into relative, which the inventory does not resolve"],
  ["resources/txn-pause-point.ts:txnFault", "forwards point into PAUSE_POINT_PATTERN.test, which the inventory does not resolve"],
  ["resources/txn-pause-point.ts:txnPausePointSync", "forwards point into PAUSE_POINT_PATTERN.test, which the inventory does not resolve"],
  ["resources/txn-pause-point.ts:txnPausePoint", "forwards point into PAUSE_POINT_PATTERN.test, which the inventory does not resolve"],
  ["resources/agent-auth.ts:readCredentialedPrincipal", "forwards agentId into (databases as any).flair.Agent.get, which the inventory does not resolve"],
  ["resources/agent-auth.ts:agentIsAdmin", "forwards agentId into configuredAdminAgentIds().has, which the inventory does not resolve"],
  ["resources/agent-auth.ts:isAdmin", "forwards agentId into (databases as any).flair.Agent.get, which the inventory does not resolve"],
  ["resources/agent-auth.ts:readRequestHeader", "forwards name into reqLike?.headers?.get, which the inventory does not resolve"],
  ["resources/record-owner-guard.ts:resolveGuardedRecordById", "forwards resource into Object.prototype.hasOwnProperty.call, which the inventory does not resolve"],
  ["resources/record-owner-guard.ts:isForbiddenOwnerFieldChange", "forwards requested into Object.prototype.hasOwnProperty.call, which the inventory does not resolve"],
  ["resources/provenance.ts:isSemanticPatch", "forwards content into Array.isArray, which the inventory does not resolve"],
  ["resources/key-lock.ts:withKeyLock", "forwards key into lock.tryLock, which the inventory does not resolve"],
  ["resources/skill-write-fault.ts:maybeThrowSkillWriteFault", "forwards step into hook, which the inventory does not resolve"],
  ["resources/memory-visibility.ts:assertValidVisibility", "forwards visibility into the writable-visibilities set includes, which the inventory does not resolve"],
  ["resources/memory-visibility.ts:assertVisibilityAllowedForDurability", "forwards visibility into JSON.stringify, which the inventory does not resolve"],
  ["resources/ed25519-auth.ts:parseTpsEd25519Header", "forwards header into TPS_ED25519_HEADER_RE.exec, which the inventory does not resolve"],
  ["resources/ed25519-auth.ts:importEd25519Key", "forwards publicKeyStr into keyCache.get, which the inventory does not resolve"],
  ["resources/replay-store.ts:replayWindowGap", "forwards windowMs into Number.isFinite, which the inventory does not resolve"],
  ["resources/replay-store.ts:recordOnce", "forwards key into store.getEntry, which the inventory does not resolve"],
  ["resources/replay-store.ts:isKnownAgentReplay", "forwards now into agentReplayGuard.knownReplay, which the inventory does not resolve"],
  ["resources/replay-store.ts:claimAgentNonce", "forwards now into agentReplayGuard.claim, which the inventory does not resolve"],
  ["resources/protocol-context.ts:ownDataValue", "forwards target into Object.getOwnPropertyDescriptor, which the inventory does not resolve"],
  ["resources/protocol-context.ts:dataValueInChain", "forwards key into Object.getOwnPropertyDescriptor, which the inventory does not resolve"],
  ["resources/protocol-context.ts:isDirectMqttSessionContext", "forwards value into Object.getOwnPropertyDescriptor, which the inventory does not resolve"],
  ["resources/request-target.ts:whatwgUrlMatchesRawTarget", "forwards rawTarget into URL, which the inventory does not resolve"],
  ["resources/request-target.ts:whatwgQueryMatchesRawTarget", "forwards rawTarget into URL, which the inventory does not resolve"],
  ["resources/request-target.ts:decodePathSegment", "forwards segment into decodeURIComponent, which the inventory does not resolve"],
  ["src/lib/instance-identity-row.ts:usableInstanceRows", "forwards rows into Array.isArray, which the inventory does not resolve"],
  ["src/lib/instance-identity-row.ts:opsPost", "forwards body into JSON.stringify, which the inventory does not resolve"],
  ["src/lib/instance-identity-row.ts:writeConfirmed", "forwards id into changed.map(String).includes, which the inventory does not resolve"],
  ["resources/federation-crypto.ts:sortKeys", "forwards val into Array.isArray, which the inventory does not resolve"],
  ["resources/federation-crypto.ts:signBody", "forwards secretKey into nacl.sign.detached, which the inventory does not resolve"],
  ["resources/federation-crypto.ts:verifyBodySignature", "forwards publicKeyB64url into Buffer.from, which the inventory does not resolve"],
  ["resources/write-journal.ts:materialize", "forwards value into seen.has, which the inventory does not resolve"],
  ["resources/write-journal.ts:WriteJournal.run", "forwards fn into active.run, which the inventory does not resolve"],
  ["resources/write-journal.ts:WriteJournal.undo", "forwards ctx into transact, which the inventory does not resolve"],
  ["resources/memory-host-source.ts:extractPointerInputs", "forwards content into Array.isArray, which the inventory does not resolve"],
  ["resources/memory-host-source.ts:loadPointerRows", "forwards context into table.search, which the inventory does not resolve"],
  ["resources/memory-host-source.ts:loadStoredPointer", "forwards memoryId into (await loadPointerRows([memoryId], context)).get, which the inventory does not resolve"],
  ["resources/host-pointer-adapter.ts:putPointerRow", "forwards row into currentHostPointerAdapter().putPointerRow, which the inventory does not resolve"],
  ["resources/host-pointer-adapter.ts:deletePointerRowViaTable", "forwards memoryId into currentHostPointerAdapter().deletePointerRow, which the inventory does not resolve"],
  ["resources/host-source.ts:validateHostSource", "forwards input into JSON.parse, which the inventory does not resolve"],
  ["resources/host-source.ts:parseHostSource", "forwards stored into JSON.parse, which the inventory does not resolve"],
  ["resources/host-source-visibility.ts:renderHostSourceUrl", "forwards url into URL, which the inventory does not resolve"],
  ["resources/host-pointer/registry.ts:restorePointerRowIfAbsent", "forwards row into currentHostPointerAdapter().putPointerRow, which the inventory does not resolve"],
]);

// ─── Tests ──────────────────────────────────────────────────────────────────

test("the source set contains each module the inventory names", () => {
  const sources = collectSourceSet();
  const missing = REQUIRED_SOURCES.filter((file) => !sources.has(file));
  expect(missing).toEqual([]);
});

test("each refusal code found in the derived source set is preflighted, admission-refused or out of scope", () => {
  const inventory = buildInventory(collectSourceSet());
  const listed = new Set<string>([...PREFLIGHTED, ...ADMISSION.keys(), ...OUT_OF_SCOPE.keys()]);

  for (const check of ADMISSION.values()) expect(check.trim()).not.toBe("");

  const unclassified = [...inventory.codes]
    .filter(([code]) => !listed.has(code))
    .map(([code, at]) => `${code} (${at})`)
    .sort();
  expect(unclassified).toEqual([]);

  const unlisted = [...listed].filter((code) => !inventory.codes.has(code)).sort();
  expect(unlisted).toEqual([]);
  expect(inventory.codes.size).toBe(listed.size);
});

test("each unresolved site is listed by file:line with a reason", () => {
  const inventory = buildInventory(collectSourceSet());
  for (const reason of UNRESOLVED_SITES.values()) expect(reason.trim()).not.toBe("");
  const unexpected = [...inventory.unresolved]
    .filter(([at]) => !UNRESOLVED_SITES.has(at))
    .map(([at, detail]) => `${at}: ${detail}`)
    .sort();
  expect(unexpected).toEqual([]);
});

test("every Response identifier token in the import closure's source is accounted for; a name built at runtime (e.g. from strings) is not seen — #2970 replaces this inventory with a server dry run", () => {
  const inventory = buildInventory(collectSourceSet());
  expect(inventory.lexicalTokens).toBeGreaterThan(0);
  expect(inventory.unaccounted).toEqual([]);
  expect(inventory.notLexical).toEqual([]);
  expect(
    inventory.classified + inventory.unresolvedReferences + inventory.aliasDefinitions +
    inventory.typeReferences + inventory.checkReferences,
  ).toBe(inventory.lexicalTokens);
});

test("each function that forwards a parameter into an unresolvable callee is opaque and listed", () => {
  const inventory = buildInventory(collectSourceSet());
  for (const reason of OPAQUE_FUNCTIONS.values()) expect(reason.trim()).not.toBe("");
  const unexpected = [...inventory.opaque]
    .filter(([key]) => !OPAQUE_FUNCTIONS.has(key))
    .map(([key, detail]) => `${key} (${detail})`)
    .sort();
  expect(unexpected).toEqual([]);
  const stale = [...OPAQUE_FUNCTIONS.keys()].filter((key) => !inventory.opaque.has(key)).sort();
  expect(stale).toEqual([]);
});

test("restore --replace names each preflighted Soul write rule", () => {
  const source = readFileSync(join(root, "src/commands/restore.ts"), "utf8");
  for (const marker of [
    "suppliesSoulScopeFields(row)",
    "LEARNED_REFUSAL",
    "refuseSkillAssignmentWrite(row)",
  ]) {
    expect(source).toContain(marker);
  }
});

test.each([
  'new Response()',
  'Response.json({})',
  'new Response(null, {})',
  'Response.json({}, { headers: {} })',
  'Response.json({}, { headers() {} })',
])("classifies the default status: %s", (expression) => {
  const source = ts.createSourceFile("fixture.ts", expression, ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect([...inventory.codes]).toEqual([]);
  expect([...inventory.unresolved]).toEqual([]);
});

test.each([
  '{ status: 403 } as const',
  '{ status: 403 } satisfies ResponseInit',
  '({ status: 403 })',
  '{ status: 403 }!',
  '{ ...base, status: 403 }',
  '{ status: 403, ...base }',
  'flag ? { status: 200 } : { status: 403 }',
  'flag && { status: 403 }',
  'init',
  'makeInit()',
  'undefined',
  '{ ["status"]: 403 }',
  '{ status: 200, [key]: 403 }',
  '{ get status() { return 403; } }',
  '{ status: Date.now() }',
  '{ __proto__: { status: 403 } }',
])("leaves an unsupported init unresolved: %s", (init) => {
  for (const expression of [
    `new Response(JSON.stringify({ error: "x" }), ${init})`,
    `Response.json({ error: "x" }, ${init})`,
  ]) {
    const source = ts.createSourceFile("fixture.ts", `const init = { status: 403 };\n${expression}`, ts.ScriptTarget.Latest, true);
    const inventory = buildInventory(new Map([["fixture.ts", source]]));
    expect([...inventory.unresolved]).toEqual([["fixture.ts:2", "unresolvable Response status"]]);
  }
});

test.each([
  'new Response(JSON.stringify({ error: "x" }), { status: 403 })',
  'Response.json({ error: "x" }, { status: 403 })',
  'const status = 403; Response.json({ error: "x" }, { status })',
])("records a static refusal: %s", (expression) => {
  const source = ts.createSourceFile("fixture.ts", expression, ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect([...inventory.codes]).toEqual([["x", "fixture.ts:1"]]);
  expect([...inventory.unresolved]).toEqual([]);
});

test("Response.error is an unresolved refusal", () => {
  const source = ts.createSourceFile("fixture.ts", "Response.error()", ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect([...inventory.unresolved]).toEqual([["fixture.ts:1", "unresolvable Response status"]]);
});

test.each([
  'Response.redirect("http://example.invalid/")',
])('counts a Response form it does not classify as unresolved: %s', (expression) => {
  const source = ts.createSourceFile("fixture.ts", expression, ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect(inventory.occurrences).toBe(1);
  expect(inventory.classified).toBe(0);
  expect(inventory.unresolvedReferences).toBe(1);
  expect([...inventory.unresolved]).toEqual([["fixture.ts:1", "unrecognised Response reference"]]);
});

test.each([
  'const R = Response; new R(JSON.stringify({ error: "x" }), { status: 403 })',
  'const R = Response; R.json({ error: "x" }, { status: 403 })',
  'const R = Response as any; R.json({ error: "x" }, { status: 403 })',
  'const R = globalThis.Response; R.json({ error: "x" }, { status: 403 })',
  'const { json } = Response; json({ error: "x" }, { status: 403 })',
])('classifies a refusal through a followed alias: %s', (expression) => {
  const source = ts.createSourceFile("fixture.ts", expression, ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect(inventory.occurrences).toBe(1);
  expect(inventory.aliasDefinitions).toBe(1);
  expect(inventory.aliasSites).toBe(1);
  expect([...inventory.codes]).toEqual([["x", "fixture.ts:1"]]);
  expect([...inventory.unresolved]).toEqual([]);
});

test("classifies a Response construction through globalThis", () => {
  const source = ts.createSourceFile("fixture.ts",
    'new globalThis.Response(JSON.stringify({ error: "x" }), { status: 403 })', ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect(inventory.classified).toBe(1);
  expect(inventory.aliasDefinitions).toBe(0);
  expect([...inventory.codes]).toEqual([["x", "fixture.ts:1"]]);
  expect([...inventory.unresolved]).toEqual([]);
});

test.each([
  'Response["json"]({ error: "x" }, { status: 403 })',
  '(Response as any).json({ error: "x" }, { status: 403 })',
  'new (Response as any)(JSON.stringify({ error: "x" }), { status: 403 })',
])('counts a Response form the classifier does not know as unresolved: %s', (expression) => {
  const source = ts.createSourceFile("fixture.ts", expression, ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect(inventory.lexicalTokens).toBe(1);
  expect(inventory.occurrences).toBe(1);
  expect(inventory.classified).toBe(0);
  expect(inventory.unresolvedReferences).toBe(1);
  expect([...inventory.unresolved]).toEqual([["fixture.ts:1", "unrecognised Response reference"]]);
});

test("a function forwarding a parameter through a cast is opaque", () => {
  const source = ts.createSourceFile("fixture.ts", `
function forbid(code: string) { return new Response(JSON.stringify({ error: code }), { status: 403 }); }
const gate = { forbid(code: string) { return forbid(code); } };
function refuseContent(content: any) { return gate.forbid((content as unknown)); }
function write(content: any) { return refuseContent(content); }`, ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect([...inventory.opaque.keys()]).toEqual(["fixture.ts:refuseContent"]);
});

test("a function forwarding a parameter into a class method is opaque", () => {
  const source = ts.createSourceFile("fixture.ts", `
function forbid(code: string) { return new Response(JSON.stringify({ error: code }), { status: 403 }); }
const gate = { forbid(code: string) { return forbid(code); } };
function refuseContent(content: any) { return gate.forbid(content); }
function write(content: any) { return refuseContent(content); }`, ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect([...inventory.opaque.keys()]).toEqual(["fixture.ts:refuseContent"]);
});

test.each(["403", "Date.now()"])("checks a status-taking helper call: %s", (status) => {
  const source = ts.createSourceFile("fixture.ts", `
function jsonResponse(status: number, body: any) { return new Response(JSON.stringify(body), { status }); }
jsonResponse(${status}, { error: "x" });`, ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect(inventory.unresolved.get("fixture.ts:2")).toBe("unresolvable Response status");
  if (status === "403") {
    expect([...inventory.codes]).toEqual([["x", "fixture.ts:3"]]);
    expect(inventory.unresolved.size).toBe(1);
  } else {
    expect(inventory.unresolved.get("fixture.ts:3")).toBe("unresolvable status argument: jsonResponse.status");
  }
});


test.each([
  'let status = 200; status = 403; Response.json({}, { status })',
  'const status = 200; function f(status: number) { return Response.json({}, { status }); }',
  'Response.json(...args)',
  'new Response(...args)',
])("leaves an unproven status unresolved: %s", (expression) => {
  const source = ts.createSourceFile("fixture.ts", expression, ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect([...inventory.unresolved]).toEqual([["fixture.ts:1", "unresolvable Response status"]]);
});

test("checks imported status-taking helper calls", () => {
  const builderFile = "resources/instruction-version-record.ts";
  const builder = ts.createSourceFile(builderFile,
    'export function jsonResponse(status: number, body: any) { return new Response(JSON.stringify(body), { status }); }',
    ts.ScriptTarget.Latest, true);
  const callerFile = "resources/Soul.ts";
  const caller = ts.createSourceFile(callerFile,
    'import { jsonResponse } from "./instruction-version-record.js"; jsonResponse(403, { error: "x" }); jsonResponse(Date.now(), {});',
    ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([[builderFile, builder], [callerFile, caller]]));
  expect([...inventory.codes]).toEqual([["x", "resources/Soul.ts:1"]]);
  expect(inventory.unresolved.get("resources/Soul.ts:1")).toBe("unresolvable status argument: jsonResponse.status");
});
