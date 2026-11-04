/**
 * restore-soul-refusal-inventory-2953.test.ts — the Soul write-refusal
 * inventory behind `flair restore --replace` (flair#2953).
 *
 * Threat model: detect refusal drift in forms the TypeScript checker can bind
 * statically, within the relative-import closure of resources/Soul.ts. Prove
 * JSON and Response against TypeScript's global library bindings, and
 * globalThis against TypeScript's intrinsic globalThis symbol. A trusted value
 * or proven alias may occur only as the receiver or callee of a recognised
 * member call or new, the right operand of instanceof, the operand of typeof,
 * or the initializer of an alias binding the resolver tracks. Named imports
 * and exports must be followed by the resolver; alias uses obey this whitelist.
 * Every other use is unresolved, with file:line:column.
 * Follow literal consts and aliases to a bounded fixpoint; fail closed
 * on unsupported forms. eval/Function are out of scope. #2970 replaces this inventory
 * with a server dry run.
 *
 * TypeScript's scanner accounts for lexical Response tokens independently of
 * the classifier. Unresolved sites require file:line:column and a reason.
 * Row object properties are unsupported; only proven globalThis.Response is
 * accepted as a qualified constructor. Payload objects with spreads, computed
 * keys, duplicate error/status keys or toJSON are unresolved.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
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
  bodyParam: string | null;
}

interface RefusalInventory {
  /** Refusal code → the file:line of the first site that produces it. */
  codes: Map<string, string>;
  unresolved: Map<string, string>;
  statuses: Map<string, number[]>;
  /** Construction or call sites that reference Response directly or through an alias. */
  occurrences: number;
  /** Lexical `Response` identifier tokens in the source set. */
  lexicalTokens: number;
  classified: number;
  /** Tokens recorded as unresolved references. */
  unresolvedReferences: number;
  /** Tokens that define an alias the classifier follows. */
  aliasDefinitions: number;
  /** Tokens in a type position, which cannot produce a refusal. */
  typeReferences: number;
  /** Tokens in an `instanceof` or `typeof` check. */
  checkReferences: number;
  /** Alias uses classified or unresolved (there is no Response token at the use). */
  aliasSites: number;
  unaccountedAliasUses: string[];
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

function siteOf(source: ts.SourceFile, node: ts.Node): string {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${relative(root, resolve(source.fileName))}:${line + 1}:${character + 1}`;
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

function responseCallee(file: string, callee: ts.Expression,
  isResponseReferenceName: (expression: ts.Expression) => boolean,
  aliasAt: (file: string, expression: ts.Identifier) => ResponseAlias | null): ResponseAlias | null {
  if (isResponseReferenceName(callee)) return { kind: "constructor" };
  if (ts.isPropertyAccessExpression(callee)) {
    if (isResponseReferenceName(callee.expression)) return { kind: "method", method: callee.name.text };
    if (ts.isIdentifier(callee.expression)) {
      const alias = aliasAt(file, callee.expression);
      if (alias?.kind === "constructor") return { kind: "method", method: callee.name.text };
    }
    return null;
  }
  return ts.isIdentifier(callee) ? aliasAt(file, callee) : null;
}

function buildInventory(sources: Map<string, ts.SourceFile>): RefusalInventory {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, moduleDetection: ts.ModuleDetectionKind.Force, types: [],
    lib: ["lib.esnext.d.ts", "lib.dom.d.ts"],
  };
  const host = ts.createCompilerHost(options, true);
  const readFile = host.readFile.bind(host);
  host.readFile = (file) => sources.get(relative(root, resolve(file)))?.text ?? readFile(file);
  host.resolveModuleNames = (names, fromFile) => names.map((name) => {
    const target = resolveRelative(relative(root, fromFile), name);
    return target && sources.has(target) ? { resolvedFileName: join(root, target), extension: ts.Extension.Ts } : undefined;
  });
  const program = ts.createProgram([...sources.keys()].map((file) => join(root, file)), options, host);
  sources = new Map([...sources.keys()].map((file) => [file, program.getSourceFile(join(root, file))!]));
  const checker = program.getTypeChecker();
  const symbolAt = (node: ts.Node): ts.Symbol | undefined => {
    let symbol = ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
    const seen = new Set<ts.Symbol>();
    while (symbol && (symbol.flags & ts.SymbolFlags.Alias)) {
      if (seen.has(symbol)) return undefined;
      seen.add(symbol);
      symbol = checker.getAliasedSymbol(symbol);
    }
    return symbol;
  };
  const libDirectory = dirname(ts.getDefaultLibFilePath(options));
  const isLibSymbol = (symbol: ts.Symbol | undefined, name: "JSON" | "Response"): boolean =>
    symbol?.getName() === name && !!symbol.declarations?.length && symbol.declarations.every((declaration) => {
      const source = declaration.getSourceFile();
      return dirname(source.fileName) === libDirectory && /^lib\..+\.d\.ts$/.test(basename(source.fileName)) &&
        program.isSourceFileDefaultLibrary(source);
    });
  const isGlobalThis = (node: ts.Expression): boolean => {
    if (!ts.isIdentifier(node) || node.text !== "globalThis") return false;
    const symbol = symbolAt(node);
    // TypeScript's intrinsic globalThis has no declarations.
    return !!symbol && symbol === checker.resolveName("globalThis", undefined, ts.SymbolFlags.Value, false) &&
      symbol.declarations?.length === 0;
  };
  const isResponseReferenceName = (expression: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(expression)) return isResponseReferenceName(expression.expression);
    if (ts.isIdentifier(expression)) return expression.text === "Response" && isLibSymbol(symbolAt(expression), "Response");
    return ts.isPropertyAccessExpression(expression) && expression.name.text === "Response" &&
      builtinPaths(expression.expression).some((path) => path.length === 1 && path[0] === "globalThis") &&
      isLibSymbol(symbolAt(expression.name), "Response");
  };
  const provenAliases = new Map<ts.Symbol, ResponseAlias>();
  const aliasAt = (_file: string, node: ts.Identifier): ResponseAlias | null => {
    const symbol = symbolAt(node);
    return symbol ? provenAliases.get(symbol) ?? null : null;
  };
  const importAliases = new Map<string, Map<string, { file: string; name: string }>>();
  const responseAliases = new Map<string, Map<string, ResponseAlias>>();
  const exportedAliases = new Map<string, Map<string, ResponseAlias>>();
  const aliasConsts = new Map<string, Array<{ name: string; initializer: ts.Expression; binding: ts.Identifier }>>();
  const aliasAssignments = new Map<string, Array<{ name: string; initializer: ts.Expression; binding: ts.Identifier }>>();
  const aliasDestructured = new Map<string, Array<{ name: string; property: string; initializer: ts.Expression; fallback?: ts.Expression; binding: ts.Identifier }>>();
  const aliasImports = new Map<string, Array<{ localName: string; importedName: string; targetFile: string }>>();
  const aliasLocalExports = new Map<string, Array<{ exportedName: string; localName: string; localNode: ts.ModuleExportName }>>();
  const aliasReExports = new Map<string, Array<{ exportedName: string; importedName: string; targetFile: string }>>();
  const aliasStarExports = new Map<string, string[]>();
  const aliasExportDeclarations = new Map<string, Set<string>>();
  const functions: FnRecord[] = [];
  const functionsByName = new Map<string, FnRecord>();

  for (const [file, source] of sources) {
    const aliases = new Map<string, { file: string; name: string }>();
    const consts: Array<{ name: string; initializer: ts.Expression; binding: ts.Identifier }> = [];
    const assignments: Array<{ name: string; initializer: ts.Expression; binding: ts.Identifier }> = [];
    const destructured: Array<{ name: string; property: string; initializer: ts.Expression; fallback?: ts.Expression; binding: ts.Identifier }> = [];
    const imports: Array<{ localName: string; importedName: string; targetFile: string }> = [];
    const localExports: Array<{ exportedName: string; localName: string; localNode: ts.ModuleExportName }> = [];
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
            else localExports.push({ exportedName, localName, localNode: element.propertyName ?? element.name });
          }
        } else if (!clause && target) {
          starExports.push(target);
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
          consts.push({ name: node.name.text, initializer: node.initializer, binding: node.name });
          if (exported) exportDeclarations.add(node.name.text);
        } else if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            if (element.dotDotDotToken || !ts.isIdentifier(element.name)) continue;
            const property = element.propertyName && (ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName))
              ? element.propertyName.text
              : element.name.text;
            destructured.push({ name: element.name.text, property, initializer: node.initializer, fallback: element.initializer, binding: element.name });
            if (exported) exportDeclarations.add(element.name.text);
          }
        }
      }
      ts.forEachChild(node, collectVariables);
    };
    collectVariables(source);
    const collectAssignments = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(node.left)) {
        assignments.push({ name: node.left.text, initializer: node.right, binding: node.left });
      }
      ts.forEachChild(node, collectAssignments);
    };
    collectAssignments(source);
    importAliases.set(file, aliases);
    responseAliases.set(file, new Map());
    exportedAliases.set(file, new Map());
    aliasConsts.set(file, consts);
    aliasAssignments.set(file, assignments);
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
  type SelectedProperty = { kind: "absent" } | { kind: "value"; value: ts.Expression } | { kind: "unknown" };
  const selectedProperty = (expression: ts.Expression, property: string): SelectedProperty => {
    const value = unwrapAliasExpression(expression);
    if (!ts.isObjectLiteralExpression(value)) return { kind: "unknown" };
    let supplied: ts.Expression | undefined;
    for (const member of value.properties) {
      if (ts.isSpreadAssignment(member) || !member.name || ts.isComputedPropertyName(member.name)) return { kind: "unknown" };
      const name = member.name;
      if (!ts.isIdentifier(name) && !ts.isStringLiteral(name) && !ts.isNumericLiteral(name)) return { kind: "unknown" };
      if (name.text !== property) continue;
      if (supplied || (!ts.isPropertyAssignment(member) && !ts.isShorthandPropertyAssignment(member))) return { kind: "unknown" };
      supplied = ts.isPropertyAssignment(member) ? member.initializer : member.name;
    }
    return supplied ? { kind: "value", value: supplied } : { kind: "absent" };
  };
  const builtinPaths = (expression: ts.Expression, seen = new Set<ts.Symbol>()): string[][] => {
    const value = unwrapAliasExpression(expression);
    if (isGlobalThis(value)) return [["globalThis"]];
    if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.EqualsToken) return builtinPaths(value.right, seen);
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      const key = ts.isPropertyAccessExpression(value) ? value.name.text :
        ts.isStringLiteral(value.argumentExpression) ? value.argumentExpression.text : "*";
      return builtinPaths(value.expression, seen).map((base) => [...base, key]);
    }
    if (!ts.isIdentifier(value)) return [];
    const symbol = symbolAt(value);
    for (const name of ["JSON", "Response"] as const) {
      if (isLibSymbol(symbol, name)) return [[name]];
    }
    if (!symbol || seen.has(symbol)) return [];
    const next = new Set([...seen, symbol]);
    const paths: string[][] = [];
    const declaration = symbol.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
      paths.push(...builtinPaths(declaration.initializer, next));
    }
    if (declaration && ts.isBindingElement(declaration) && !declaration.dotDotDotToken &&
        ts.isObjectBindingPattern(declaration.parent) && ts.isVariableDeclaration(declaration.parent.parent)) {
      const initializer = declaration.parent.parent.initializer;
      const name = declaration.propertyName ?? declaration.name;
      if (initializer && (ts.isIdentifier(name) || ts.isStringLiteral(name))) {
        paths.push(...builtinPaths(initializer, next).map((base) => [...base, name.text]));
        const selected = selectedProperty(initializer, name.text);
        if (selected.kind === "value") paths.push(...builtinPaths(selected.value, next));
        if (selected.kind === "absent" && declaration.initializer) paths.push(...builtinPaths(declaration.initializer, next));
      }
    }
    for (const assignments of aliasAssignments.values()) {
      for (const assignment of assignments) {
        if (symbolAt(assignment.binding) === symbol) paths.push(...builtinPaths(assignment.initializer, next));
      }
    }
    return paths;
  };
  const uncertainAliases = new Set<ts.Symbol>();
  const sameAliasMap = (left: Map<string, ResponseAlias>, right: Map<string, ResponseAlias>): boolean => {
    if (left.size !== right.size) return false;
    for (const [name, alias] of left) {
      const other = right.get(name);
      if (!other || other.kind !== alias.kind) return false;
      if (alias.kind === "method" && other.kind === "method" && alias.method !== other.method) return false;
    }
    return true;
  };
  // Continue to the bounded fixpoint; fail if resolution does not converge.
  const ALIAS_PASS_BOUND = 100;
  let converged = false;
  let lastChangedModule = "";
  for (let pass = 0; pass < ALIAS_PASS_BOUND; pass++) {
    let mutated = false;
    for (const file of sources.keys()) {
      const local = responseAliases.get(file)!;
      const priorSize = local.size;
      const aliasOf = (expression: ts.Expression): ResponseAlias | null => {
        const unwrapped = unwrapAliasExpression(expression);
        if (isResponseReferenceName(unwrapped)) return { kind: "constructor" };
        if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          return aliasOf(unwrapped.right);
        }
        if (ts.isPropertyAccessExpression(unwrapped)) {
          if (isResponseReferenceName(unwrapped.expression)) return { kind: "method", method: unwrapped.name.text };
          const base = ts.isIdentifier(unwrapped.expression) ? aliasAt(file, unwrapped.expression) : undefined;
          return base?.kind === "constructor" ? { kind: "method", method: unwrapped.name.text } : null;
        }
        return ts.isIdentifier(unwrapped) ? aliasAt(file, unwrapped) : null;
      };
      for (const declaration of aliasConsts.get(file) ?? []) {
        const alias = aliasOf(declaration.initializer);
        const input = unwrapAliasExpression(declaration.initializer);
        const inputSymbol = ts.isIdentifier(input) ? symbolAt(input) : undefined;
        const outputSymbol = symbolAt(declaration.binding);
        if (inputSymbol && outputSymbol && uncertainAliases.has(inputSymbol) && !uncertainAliases.has(outputSymbol)) {
          uncertainAliases.add(outputSymbol); mutated = true; lastChangedModule = file;
        }
        if (alias) {
          const symbol = symbolAt(declaration.binding);
          if (symbol && !provenAliases.has(symbol)) { provenAliases.set(symbol, alias); mutated = true; lastChangedModule = file; }
          if (!local.has(declaration.name)) local.set(declaration.name, alias);
        }
      }
      for (const declaration of aliasAssignments.get(file) ?? []) {
        const alias = aliasOf(declaration.initializer);
        const input = unwrapAliasExpression(declaration.initializer);
        const inputSymbol = ts.isIdentifier(input) ? symbolAt(input) : undefined;
        const outputSymbol = symbolAt(declaration.binding);
        if (inputSymbol && outputSymbol && uncertainAliases.has(inputSymbol) && !uncertainAliases.has(outputSymbol)) {
          uncertainAliases.add(outputSymbol); mutated = true; lastChangedModule = file;
        }
        if (alias) {
          const symbol = symbolAt(declaration.binding);
          if (symbol && !provenAliases.has(symbol)) { provenAliases.set(symbol, alias); mutated = true; lastChangedModule = file; }
          if (!local.has(declaration.name)) local.set(declaration.name, alias);
        }
      }
      for (const declaration of aliasDestructured.get(file) ?? []) {
        const base = aliasOf(declaration.initializer);
        const alias = base?.kind === "constructor"
          ? { kind: "method" as const, method: declaration.property }
          : (() => {
            const selected = selectedProperty(declaration.initializer, declaration.property);
            if (selected.kind === "value") return aliasOf(selected.value);
            return selected.kind === "absent" && declaration.fallback ? aliasOf(declaration.fallback) : null;
          })();
        const bindingSymbol = symbolAt(declaration.binding);
        if (!alias && bindingSymbol && (responseIdentifiersIn(declaration.initializer).length ||
            (declaration.fallback && (aliasOf(declaration.fallback) || responseIdentifiersIn(declaration.fallback).length)))) {
          if (!uncertainAliases.has(bindingSymbol)) { uncertainAliases.add(bindingSymbol); mutated = true; lastChangedModule = file; }
        }
        if (alias) {
          const symbol = symbolAt(declaration.binding);
          if (symbol && !provenAliases.has(symbol)) { provenAliases.set(symbol, alias); mutated = true; lastChangedModule = file; }
          if (!local.has(declaration.name)) local.set(declaration.name, alias);
        }
      }
      for (const element of aliasImports.get(file) ?? []) {
        const alias = exportedAliases.get(element.targetFile)?.get(element.importedName);
        if (alias && !local.has(element.localName)) local.set(element.localName, alias);
      }
      const exported = new Map<string, ResponseAlias>();
      for (const name of aliasExportDeclarations.get(file) ?? []) {
        const alias = local.get(name);
        if (alias) exported.set(name, alias);
      }
      for (const element of aliasLocalExports.get(file) ?? []) {
        const alias = ts.isIdentifier(element.localNode)
          ? (isResponseReferenceName(element.localNode) ? { kind: "constructor" as const } : aliasAt(file, element.localNode)) : null;
        if (alias) exported.set(element.exportedName, alias);
      }
      for (const element of aliasReExports.get(file) ?? []) {
        const alias = exportedAliases.get(element.targetFile)?.get(element.importedName);
        if (alias) exported.set(element.exportedName, alias);
      }
      for (const target of aliasStarExports.get(file) ?? []) {
        for (const [name, alias] of exportedAliases.get(target) ?? []) if (!exported.has(name)) exported.set(name, alias);
      }
      const exportedBefore = exportedAliases.get(file)!;
      if (!sameAliasMap(exportedBefore, exported)) {
        exportedAliases.set(file, exported);
        mutated = true;
        lastChangedModule = file;
      }
      if (local.size !== priorSize) {
        mutated = true;
        lastChangedModule = file;
      }
    }
    if (!mutated) {
      converged = true;
      break;
    }
  }
  if (!converged) {
    throw new Error(`alias resolution did not converge within ${ALIAS_PASS_BOUND} passes: ${lastChangedModule}`);
  }

  const resolveFunction = (file: string, name: string): FnRecord | null => {
    const local = functionsByName.get(`${file}:${name}`);
    if (local) return local;
    const alias = importAliases.get(file)?.get(name);
    return alias ? (functionsByName.get(`${alias.file}:${alias.name}`) ?? null) : null;
  };

  const branches = (expression: ts.Expression): ts.Expression[] => {
    if (ts.isConditionalExpression(expression)) return [expression.whenTrue, expression.whenFalse];
    if (ts.isBinaryExpression(expression) && [ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(expression.operatorToken.kind)) {
      return [expression.left, expression.right];
    }
    return [expression];
  };

  const evaluate = <T,>(expression: ts.Expression | null | undefined,
    literal: (node: ts.Expression) => T[] | null): T[] | null => {
    if (!expression) return null;
    const alternatives = branches(expression);
    if (alternatives.length === 1) return literal(expression);
    const values = alternatives.map((branch) => evaluate(branch, literal));
    return values.every((value) => value !== null) ? [...new Set(values.flatMap((value) => value!))] : null;
  };

  const literalConst = (expression: ts.Expression): ts.Expression => {
    if (!ts.isIdentifier(expression)) return expression;
    let symbol = ts.isShorthandPropertyAssignment(expression.parent)
      ? checker.getShorthandAssignmentValueSymbol(expression.parent)
      : checker.getSymbolAtLocation(expression);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol);
    const declaration = symbol?.valueDeclaration;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name) ||
        !ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const) ||
        !declaration.initializer) return expression;
    let value = declaration.initializer;
    while (ts.isParenthesizedExpression(value) ||
           (ts.isAsExpression(value) && ts.isTypeReferenceNode(value.type) &&
            ts.isIdentifier(value.type.typeName) && value.type.typeName.text === "const")) {
      value = value.expression;
    }
    return ts.isStringLiteral(value) || ts.isNumericLiteral(value) ? value : expression;
  };

  const resolveString = (_file: string, expression: ts.Expression | null | undefined): string[] | null =>
    evaluate(expression, (node) => {
      const value = literalConst(node);
      return ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value) ? [value.text] : null;
    });

  const resolveNumbers = (_file: string, expression: ts.Expression | null | undefined): number[] | null =>
    evaluate(expression, (node) => {
      const value = literalConst(node);
      return ts.isNumericLiteral(value) ? [Number(value.text)] : null;
    });

  const payloadOf = (_file: string, expression: ts.Expression | null | undefined): ts.Expression | null => {
    if (expression && ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) &&
        ts.isIdentifier(expression.expression.expression) && expression.expression.expression.text === "JSON" && isLibSymbol(symbolAt(expression.expression.expression), "JSON") &&
        expression.expression.name.text === "stringify" && expression.arguments.length === 1 &&
        !ts.isSpreadElement(expression.arguments[0])) return expression.arguments[0];
    return expression ?? null;
  };

  const propertiesOf = (object: ts.Expression): Map<string, ts.Expression> | null => {
    if (!ts.isObjectLiteralExpression(object)) return null;
    const properties = new Map<string, ts.Expression>();
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property) || ts.isComputedPropertyName(property.name)) return null;
      const name = property.name;
      if (!ts.isIdentifier(name) && !ts.isStringLiteral(name) && !ts.isNumericLiteral(name)) return null;
      if (name.text === "__proto__" || name.text === "toJSON" || ((name.text === "error" || name.text === "status") && properties.has(name.text))) return null;
      if (ts.isPropertyAssignment(property)) properties.set(name.text, property.initializer);
      else if (ts.isShorthandPropertyAssignment(property)) properties.set(name.text, property.name);
      else return null;
    }
    return properties;
  };

  const propertyOf = (object: ts.Expression | null | undefined, _file: string, key: string): ts.Expression | null =>
    object ? propertiesOf(object)?.get(key) ?? null : null;

  const errorValues = (file: string, body: ts.Expression | null | undefined): string[] | null =>
    evaluate(body, (object) => resolveString(file, propertyOf(object, file, "error")));

  type ResponseShape = {
    status: ts.Expression | undefined;
    statuses: number[] | null;
    body: ts.Expression | null;
  };

  const responseInit = (file: string, init: ts.Expression | undefined): Pick<ResponseShape, "status" | "statuses"> => {
    if (init === undefined) return { status: undefined, statuses: [200] };
    const statuses = evaluate(init, (object) => {
      const properties = propertiesOf(object);
      if (!properties) return null;
      const value = properties.get("status");
      return value === undefined ? [200] : resolveNumbers(file, value);
    });
    return { status: propertyOf(init, file, "status") ?? undefined, statuses };
  };

  const responseShape = (file: string, node: ts.Expression, callee: ResponseAlias): ResponseShape | null => {
    if (callee.kind === "constructor") {
      if (!ts.isNewExpression(node)) return null;
      const init = node.arguments?.[1];
      if (node.arguments?.some(ts.isSpreadElement)) return { status: undefined, statuses: null, body: null };
      return {
        ...responseInit(file, init),
        body: payloadOf(file, node.arguments?.[0]),
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
    let bodyParam: string | null = null;
    const parameters = parametersOf(record.fn);
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
        const callee = responseCallee(record.file, node.expression, isResponseReferenceName, aliasAt);
        const shape = callee ? responseShape(record.file, node, callee) : null;
        const status = shape?.status;
        if (shape?.body && ts.isIdentifier(shape.body) && parameters.has(shape.body.text)) bodyParam = shape.body.text;
        if (status && ts.isIdentifier(status) && parameters.has(status.text)) statusParam = status.text;
        const error = propertyOf(shape?.body, record.file, "error");
        if (error && ts.isIdentifier(error) && parameters.has(error.text)) messageParam = error.text;
      }
      ts.forEachChild(node, visit);
    };
    visit(bodyOf(record.fn));
    return { statusParam, messageParam, bodyParam };
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
  const statuses = new Map<string, number[]>();
  const recordStatuses = (file: string, line: number, values: number[]): void => {
    const at = `${file}:${line}`;
    statuses.set(at, [...new Set([...(statuses.get(at) ?? []), ...values])]);
  };
  const recordCode = (message: string, file: string, line: number): void => {
    const code = codeOf(message);
    if (!codes.has(code)) codes.set(code, `${file}:${line}`);
  };
  const recordUnresolved = (file: string, node: ts.Node, detail: string): void => {
    const at = siteOf(sources.get(file)!, node);
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
      const values = resolveString(file, argument);
      if (values) for (const value of values) recordCode(value, file, lineOf(source, node));
      else recordUnresolved(file, node, `unresolvable refusal argument: ${target.name}.${sink}`);
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
      if (!aliasAt(file, declaration.binding)) continue;
      for (const identifier of responseIdentifiersIn(declaration.initializer)) account(file, identifier, "alias");
    }
    for (const declaration of aliasDestructured.get(file) ?? []) {
      if (!aliasAt(file, declaration.binding)) continue;
      for (const identifier of responseIdentifiersIn(declaration.initializer)) account(file, identifier, "alias");
      if (declaration.fallback) {
        for (const identifier of responseIdentifiersIn(declaration.fallback)) account(file, identifier, "alias");
      }
    }
    for (const declaration of aliasAssignments.get(file) ?? []) {
      if (!aliasAt(file, declaration.binding)) continue;
      for (const identifier of responseIdentifiersIn(declaration.initializer)) account(file, identifier, "alias");
    }
    const visitBindings = (node: ts.Node): void => {
      if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) {
        const original = node.propertyName ?? node.name;
        if (ts.isIdentifier(original) && original.text === "Response" &&
            (isLibSymbol(symbolAt(original), "Response") || aliasAt(file, original))) account(file, original, "alias");
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
        const alias = responseCallee(file, node.expression, isResponseReferenceName, aliasAt);
        const calleeSymbol = ts.isIdentifier(node.expression) ? symbolAt(node.expression) : undefined;
        const uncertain = calleeSymbol && uncertainAliases.has(calleeSymbol);
        if (direct.length > 0 || alias || uncertain) {
          occurrences++;
          if (alias) {
            const shape = responseShape(file, node, alias);
            const refusal = shape?.statuses?.some((value) => value >= 400);
            const values = refusal && shape ? errorValues(file, shape.body) : null;
            if (shape?.statuses !== null && shape?.statuses !== undefined) {
              recordStatuses(file, lineOf(source, node), shape.statuses);
            }
            if (shape && shape.statuses !== null && (!refusal || values !== null)) {
              if (direct.length > 0) classified += direct.length;
              else aliasSites++;
              for (const identifier of direct) account(file, identifier, "classified");
              if (refusal && values) for (const value of values) recordCode(value, file, lineOf(source, node));
            } else {
              if (direct.length > 0) unresolvedReferences += direct.length;
              else aliasSites++;
              for (const identifier of direct) account(file, identifier, "unresolved");
              recordUnresolved(file, node, !shape ? "unrecognised Response reference" :
                shape.statuses === null ? "unresolvable Response status" : "unresolvable refusal body");
            }
          } else {
            unresolvedReferences += direct.length;
            for (const identifier of direct) account(file, identifier, "unresolved");
            recordUnresolved(file, node, "unrecognised Response reference");
          }
        }
      }
      if (ts.isElementAccessExpression(node) || (ts.isBindingElement(node) && node.propertyName)) {
        const property = ts.isElementAccessExpression(node) ? node.argumentExpression : node.propertyName!;
        const value = ts.isComputedPropertyName(property) ? property.expression : property;
        const literal = ts.isExpression(value) ? literalConst(unwrapAliasExpression(value)) : value;
        const propertyType = ts.isExpression(value) ? checker.getTypeAtLocation(value) : undefined;
        if (((ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal)) && literal.text === "Response") ||
            (propertyType?.isStringLiteral() && propertyType.value === "Response")) {
          recordUnresolved(file, node, "unrecognised Response reference");
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
  const isCheckOperand = (node: ts.Node): boolean => {
    while (ts.isPropertyAccessExpression(node.parent) || ts.isParenthesizedExpression(node.parent)) node = node.parent;
    const parent = node.parent;
    return (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && parent.right === node) ||
      ts.isTypeOfExpression(parent);
  };

  const transparentParent = (node: ts.Node): ts.Node => {
    let current = node;
    while (current.parent && ts.isExpression(current.parent) && current.parent !== unwrapAliasExpression(current.parent)) {
      if (unwrapAliasExpression(current.parent) !== unwrapAliasExpression(current as ts.Expression)) break;
      current = current.parent;
    }
    return current;
  };
  const trackablePath = (path: string[]): boolean => {
    const name = path.join(".");
    return ["JSON", "JSON.stringify", "JSON.parse", "Response", "Response.json", "Response.error", "Response.redirect",
      "globalThis", "globalThis.Response", "globalThis.Response.json", "globalThis.Response.error", "globalThis.Response.redirect"].includes(name);
  };
  const trustedPaths = (expression: ts.Expression): string[][] => builtinPaths(expression).filter(trackablePath);
  const trackedBinding = (name: ts.BindingName): boolean => {
    if (ts.isIdentifier(name)) {
      const paths = trustedPaths(name);
      return paths.length > 0 && paths.every((path) =>
        !path.includes("Response") || aliasAt(name.getSourceFile().fileName, name) !== null);
    }
    return ts.isObjectBindingPattern(name) && name.elements.length > 0 && name.elements.every((element) =>
      !element.dotDotDotToken && !(element.propertyName && ts.isComputedPropertyName(element.propertyName)) && trackedBinding(element.name));
  };
  const exportsTrustedValue = (module: ts.Symbol, seen = new Set<ts.Symbol>()): boolean => {
    if (seen.has(module)) return false;
    seen.add(module);
    return checker.getExportsOfModule(module).some((exported) => {
      const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      if (target === checker.resolveName("globalThis", undefined, ts.SymbolFlags.Value, false)) return true;
      const declaration = target.valueDeclaration;
      if (declaration && (ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration)) &&
          ts.isIdentifier(declaration.name) && trustedPaths(declaration.name).length) return true;
      return !!(target.flags & ts.SymbolFlags.Module) && exportsTrustedValue(target, seen);
    });
  };
  for (const [file, source] of sources) {
    const visit = (node: ts.Node): void => {
      if (ts.isNamespaceImport(node) && !node.parent.isTypeOnly) {
        const module = symbolAt(node.name);
        if (module && exportsTrustedValue(module)) recordUnresolved(file, node.name, "unsupported trusted built-in use");
      }
      if (ts.isIdentifier(node) && trustedPaths(node).length && !isTypePosition(node)) {
        const parent = node.parent;
        const definition =
          ((ts.isVariableDeclaration(parent) || ts.isBindingElement(parent) || ts.isParameter(parent)) && parent.name === node) ||
          ts.isImportSpecifier(parent) ||
          (ts.isExportSpecifier(parent) && parent.name === node && !!parent.propertyName) ||
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node);
        let current = transparentParent(node);
        while (ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current) {
          current = transparentParent(current.parent);
        }
        const use = current.parent;
        const paths = ts.isExpression(current) ? builtinPaths(current) : [];
        const invocation = (ts.isCallExpression(use) || ts.isNewExpression(use)) && use.expression === current;
        const recognised = invocation && paths.length > 0 && paths.every((path) => {
          const name = (path[0] === "globalThis" ? path.slice(1) : path).join(".");
          if (name.startsWith("Response") && !responseCallee(file, use.expression, isResponseReferenceName, aliasAt)) return false;
          return ts.isNewExpression(use) ? name === "Response" :
            ["JSON.stringify", "JSON.parse", "Response.json", "Response.error", "Response.redirect"].includes(name);
        });
        const check = paths.length > 0 && paths.every(trackablePath) &&
          ((ts.isTypeOfExpression(use) && use.expression === current) ||
           (ts.isBinaryExpression(use) && use.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && use.right === current));
        const binding = (ts.isVariableDeclaration(use) && use.initializer === current && trackedBinding(use.name)) ||
          (ts.isBindingElement(use) && use.initializer === current && trackedBinding(use.name));
        const namedExport = ts.isExportSpecifier(parent) && (parent.propertyName ?? parent.name) === node &&
          !!symbolAt(node) && trustedPaths(node).length > 0;
        if (!definition && !recognised && !check && !binding && !namedExport) {
          recordUnresolved(file, node, `unsupported trusted built-in use: ${current.getText(source)} in ${ts.SyntaxKind[use.kind]}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  const unaccountedAliasUses: string[] = [];
  for (const [file, source] of sources) {
    const local = responseAliases.get(file)!;
    if (local.size === 0) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && aliasAt(file, node) && !isTypePosition(node)) {
        const parent = node.parent;
        const definition =
          ((ts.isVariableDeclaration(parent) || ts.isBindingElement(parent) || ts.isParameter(parent) ||
            ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) ||
          ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) ||
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          (ts.isPropertyAccessExpression(parent) && parent.name === node);
        const chainEdge =
          (ts.isVariableDeclaration(parent) && parent.initializer === node) ||
          (ts.isBindingElement(parent) && parent.initializer === node) ||
          (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === node);
        const callee =
          ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) ||
          (ts.isPropertyAccessExpression(parent) && parent.expression === node &&
            (ts.isCallExpression(parent.parent) || ts.isNewExpression(parent.parent)) && parent.parent.expression === parent);
        if (!definition && !chainEdge && !callee && !isCheckOperand(node)) {
          unaccountedAliasUses.push(`${file}:${lineOf(source, node)}: ${node.text}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  for (const [file, source] of sources) {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === "Response" && !accounted.has(`${file}:${node.getStart(source)}`)) {
        if (isTypePosition(node)) account(file, node, "type");
        else if (isCheckOperand(node)) account(file, node, "check");
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
          const statusesAtCall = index >= 0 ? resolveNumbers(file, node.arguments[index]) : null;
          if (statusesAtCall) recordStatuses(file, lineOf(source, node), statusesAtCall);
          if (statusesAtCall && statusesAtCall.some((value) => value >= 400)) {
            const bodyParam = info.get(record.key)!.bodyParam;
            const bodyIndex = record.fn.parameters.findIndex((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === bodyParam);
            const body = bodyIndex >= 0 ? node.arguments[bodyIndex] : undefined;
            const values = errorValues(file, body);
            if (values) for (const value of values) recordCode(value, file, lineOf(source, node));
            else recordUnresolved(file, node, "unresolvable refusal body");
          } else if (index >= 0 && statusesAtCall === null) {
            recordUnresolved(file, node, `unresolvable status argument: ${record.name}.${statusParam}`);
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
    codes, unresolved, statuses, occurrences, lexicalTokens: lexical.size, classified, unresolvedReferences,
    aliasDefinitions: count("alias"), typeReferences: count("type"), checkReferences: count("check"),
    aliasSites, unaccountedAliasUses, unaccounted, notLexical, opaque,
  };
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
]);

/** Expected diagnostics and reasons for accepting unresolved sites. */
const UNRESOLVED_SITES = new Map<string, { detail: string; reason: string }>([
  ["resources/request-transaction.ts:34:14", { detail: "unsupported trusted built-in use: (globalThis as any)?.transaction in VariableDeclaration", reason: "reads Harper's transaction helper from globalThis; the helper is outside the use whitelist" }],
  ["resources/replay-store.ts:107:19", { detail: "unsupported trusted built-in use: (globalThis as any).transaction in PropertyAssignment", reason: "copies Harper's transaction helper into replay dependencies; the property read is outside the use whitelist" }],
  ["resources/replay-store.ts:346:19", { detail: "unsupported trusted built-in use: (globalThis as any).transaction in PropertyAssignment", reason: "copies Harper's transaction helper into ID-JAG replay dependencies; the property read is outside the use whitelist" }],
  ["resources/replay-store.ts:400:19", { detail: "unsupported trusted built-in use: (globalThis as any).transaction in PropertyAssignment", reason: "copies Harper's transaction helper into OAuth replay dependencies; the property read is outside the use whitelist" }],
  ["resources/replay-store.ts:451:15", { detail: "unsupported trusted built-in use: (globalThis as any).server?.workerCount in TypeOfExpression", reason: "reads Harper's worker count through globalThis.server; that property chain is outside the use whitelist" }],
  ["resources/record-type-kit.ts:514:26", { detail: "unresolvable refusal argument: FORBIDDEN.msg", reason: "FORBIDDEN receives the forwarded forbiddenMessage parameter; literal wrapper-call arguments are checked separately" }],
  ["resources/record-type-kit.ts:519:26", { detail: "unresolvable refusal argument: FORBIDDEN.msg", reason: "FORBIDDEN receives the forwarded forbiddenMessage parameter; literal wrapper-call arguments are checked separately" }],
  ["resources/record-type-kit.ts:527:26", { detail: "unresolvable refusal argument: FORBIDDEN.msg", reason: "FORBIDDEN receives the forwarded forbiddenMessage parameter; literal wrapper-call arguments are checked separately" }],
  ["resources/Soul.ts:70:10", { detail: "unresolvable refusal body", reason: "patchConflict forwards its error parameter; literal call arguments are checked separately" }],
  ["resources/record-owner-guard.ts:255:10", { detail: "unresolvable Response status", reason: "status has a conditional initializer rather than a literal" }],
  ["resources/record-type-kit.ts:76:3", { detail: "unresolvable refusal body", reason: "FORBIDDEN forwards msg; literal call arguments are checked separately" }],
  ["resources/request-target.ts:75:10", { detail: "unresolvable refusal body", reason: "the HEAD/body conditional uses null and a body identifier; the request-target refusal remains unresolved" }],
  ["resources/skill-provenance.ts:212:10", { detail: "unresolvable refusal body", reason: "the error is result.error from registerSkillAssignment; this response remains unresolved" }],
  ["resources/instruction-version-record.ts:272:10", { detail: "unresolvable Response status", reason: "jsonResponse forwards its status parameter; its call sites are checked for static statuses" }],
  ["resources/record-owner-guard.ts:220:10", { detail: "unresolvable refusal body", reason: "message interpolates the table name; the owner-scoped write middleware raises it, not the Soul row write" }],
  ["resources/record-owner-guard.ts:231:10", { detail: "unresolvable refusal body", reason: "message interpolates the table name; the owner-scoped write middleware raises it, not the Soul row write" }],
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

function siteIn(source: ts.SourceFile, text: string): string {
  const pos = source.text.indexOf(text);
  if (pos < 0) throw new Error(`missing fixture site: ${text}`);
  const { line, character } = source.getLineAndCharacterOfPosition(pos);
  return `${relative(root, resolve(source.fileName))}:${line + 1}:${character + 1}`;
}

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

test("each unresolved site matches its file:line:column and diagnostic", () => {
  const inventory = buildInventory(collectSourceSet());
  for (const { reason } of UNRESOLVED_SITES.values()) expect(reason.trim()).not.toBe("");
  const unexpected = [...inventory.unresolved]
    .filter(([at, detail]) => UNRESOLVED_SITES.get(at)?.detail !== detail)
    .map(([at, detail]) => `${at}: ${detail}`)
    .sort();
  expect(unexpected).toEqual([]);
  const stale = [...UNRESOLVED_SITES.keys()].filter((at) => !inventory.unresolved.has(at)).sort();
  expect(stale).toEqual([]);
});

test("an array at a listed global property read does not match its diagnostic", () => {
  const sources = collectSourceSet();
  const file = "resources/replay-store.ts";
  const source = sources.get(file)!;
  const text = source.text.replace("(globalThis as any).transaction", "[globalThis]");
  sources.set(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  const at = "resources/replay-store.ts:107:19";
  const detail = buildInventory(sources).unresolved.get(at);
  expect(detail).toBe("unsupported trusted built-in use: globalThis in ArrayLiteralExpression");
  expect(detail).not.toBe(UNRESOLVED_SITES.get(at)!.detail);
});

test("lexical Response tokens have dispositions", () => {
  const inventory = buildInventory(collectSourceSet());
  expect(inventory.lexicalTokens).toBeGreaterThan(0);
  expect(inventory.unaccounted).toEqual([]);
  expect(inventory.unaccountedAliasUses).toEqual([]);
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
    expect([...inventory.unresolved]).toEqual([["fixture.ts:2:1", "unresolvable Response status"]]);
  }
});

test.each([
  'new Response(JSON.stringify({ error: "x" }), { status: 403 })',
  'Response.json({ error: "x" }, { status: 403 })',
])("records a static refusal: %s", (expression) => {
  const source = ts.createSourceFile("fixture.ts", expression, ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect([...inventory.codes]).toEqual([["x", "fixture.ts:1"]]);
  expect([...inventory.unresolved]).toEqual([]);
});

test("Response.error is an unresolved refusal", () => {
  const source = ts.createSourceFile("fixture.ts", "Response.error()", ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect([...inventory.unresolved]).toEqual([["fixture.ts:1:1", "unresolvable Response status"]]);
});

test.each([
  'Response.redirect("http://example.invalid/")',
])('counts a Response form it does not classify as unresolved: %s', (expression) => {
  const source = ts.createSourceFile("fixture.ts", expression, ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect(inventory.occurrences).toBe(1);
  expect(inventory.classified).toBe(0);
  expect(inventory.unresolvedReferences).toBe(1);
  expect([...inventory.unresolved]).toEqual([["fixture.ts:1:1", "unrecognised Response reference"]]);
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
  expect([...inventory.unresolved]).toContainEqual(["fixture.ts:1:1", "unrecognised Response reference"]);
  expect(inventory.unresolved.size).toBe(expression.includes("as any") ? 2 : 1);
  if (expression.includes("as any")) {
    expect(inventory.unresolved.get(siteIn(source, "Response"))).toStartWith("unsupported trusted built-in use:");
  }
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
  expect(inventory.unresolved.get(siteIn(source, "new Response"))).toBe("unresolvable Response status");
  if (status === "403") {
    expect([...inventory.codes]).toEqual([["x", "fixture.ts:3"]]);
    expect(inventory.unresolved.size).toBe(1);
  } else {
    expect(inventory.unresolved.get(siteIn(source, "jsonResponse(Date.now()"))).toBe("unresolvable status argument: jsonResponse.status");
  }
});


test.each([
  'Response.json({}, { headers() {} })',
  'let status = 200; status = 403; Response.json({}, { status })',
  'const status = 200; function f(status: number) { return Response.json({}, { status }); }',
  'Response.json(...args)',
  'new Response(...args)',
])("leaves an unproven status unresolved: %s", (expression) => {
  const source = ts.createSourceFile("fixture.ts", expression, ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect([...inventory.unresolved]).toEqual([[siteIn(source, source.text.includes("Response.json") ? "Response.json" : "new Response"), "unresolvable Response status"]]);
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
  expect(inventory.unresolved.get(siteIn(caller, "jsonResponse(Date.now()"))).toBe("unresolvable status argument: jsonResponse.status");
});

test("classifies a refusal through a two-step destructured alias chain", () => {
  const source = ts.createSourceFile("fixture.ts",
    'const { json: j } = Response;\nconst k = j;\nk({ error: "new_code" }, { status: 403 })', ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect(inventory.occurrences).toBe(1);
  expect(inventory.aliasSites).toBe(1);
  expect([...inventory.codes]).toEqual([["new_code", "fixture.ts:3"]]);
  expect([...inventory.unresolved]).toEqual([]);
  expect(inventory.unaccountedAliasUses).toEqual([]);
});

test("classifies a refusal through a four-step alias chain", () => {
  const source = ts.createSourceFile("fixture.ts",
    'const { json: a } = Response;\nconst b = a;\nconst c = b;\nconst d = c;\nd({ error: "new_code" }, { status: 403 })', ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect(inventory.occurrences).toBe(1);
  expect(inventory.aliasSites).toBe(1);
  expect([...inventory.codes]).toEqual([["new_code", "fixture.ts:5"]]);
  expect([...inventory.unresolved]).toEqual([]);
  expect(inventory.unaccountedAliasUses).toEqual([]);
});

test("classifies a three-step chain across two modules with a re-export", () => {
  const policyFile = "resources/soul-write-policy.ts";
  const soulFile = "resources/Soul.ts";
  const policy = ts.createSourceFile(policyFile,
    'export const { json: j } = Response;', ts.ScriptTarget.Latest, true);
  const soul = ts.createSourceFile(soulFile,
    'import { j } from "./soul-write-policy.js";\nexport { j as reexported };\nconst k = j;\nk({ error: "new_code" }, { status: 403 });',
    ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([[policyFile, policy], [soulFile, soul]]));
  expect(inventory.occurrences).toBe(1);
  expect(inventory.aliasSites).toBe(1);
  expect([...inventory.codes]).toEqual([["new_code", `${soulFile}:4`]]);
  expect([...inventory.unresolved]).toEqual([]);
  expect(inventory.unaccountedAliasUses).toEqual([]);
});

test("follows an alias through a destructuring default value", () => {
  const source = ts.createSourceFile("fixture.ts",
    'const { json: j = Response.json } = {};\nj({ error: "new_code" }, { status: 403 })', ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect(inventory.occurrences).toBe(1);
  expect(inventory.aliasSites).toBe(1);
  expect([...inventory.codes]).toEqual([["new_code", "fixture.ts:2"]]);
  expect([...inventory.unresolved]).toEqual([]);
  expect(inventory.unaccounted).toEqual([]);
  expect(inventory.unaccountedAliasUses).toEqual([]);
});

test.each([
  ['const other = () => Response.json({ error: "different" }, { status: 403 });', '{ json: other }'],
  ['declare const supplied: any;', 'supplied'],
  ['declare const supplied: any;', '{ ...supplied }'],
  ['declare const key: string;', '{ [key]: Response.json }'],
  ['const native = Response.json; const other = () => ({});', '{ json: other }'],
  ['const supplied: any = {}; supplied.json = () => ({});', 'supplied'],
])("does not select a destructuring default over an unproven source: %s %s", (setup, initializer) => {
  const source = ts.createSourceFile("fixture.ts",
    `${setup}\nconst { json: j = ${setup.includes("const native") ? "native" : "Response.json"} } = ${initializer};\nj({ error: "wrong_code" }, { status: 403 });`,
    ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect(inventory.codes.has("wrong_code")).toBe(false);
  expect(inventory.unresolved.get(siteIn(source, 'j({ error:'))).toBe("unrecognised Response reference");
});

test.each([
  ['', '{}', 'fallback'],
  ['', '{ json: Response.json }', 'supplied'],
])("selects a proven destructured value: %s %s", (setup, initializer, code) => {
  const source = ts.createSourceFile("fixture.ts",
    `${setup}\nconst { json: j = ${code === "supplied" ? "other" : "Response.json"} } = ${initializer};\nj({ error: "${code}" }, { status: 403 });`, ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect(inventory.codes.get(code)).toBe("fixture.ts:3");
  expect([...inventory.unresolved]).toEqual(code === "supplied"
    ? [["fixture.ts:2:37", "unsupported trusted built-in use: Response.json in PropertyAssignment"]] : []);
});

test.each([
  ['', `JSON.stringify = () => '{"error":"x_new_rule"}';`],
  ['', 'Response.json = () => new Response();'],
  ['', 'Object.defineProperty(JSON, "stringify", { value: () => "changed" });'],
  ['', 'delete globalThis.Response;'],
  ['', 'JSON.stringify ||= other;'],
  ['', 'Response.json += other;'],
  ['', 'globalThis.Response = other;'],
  ['', 'Object.assign(Response, { json: other });'],
  ['', 'Reflect.set(globalThis, "Response", other);'],
  ['const J = JSON;', 'J.stringify = other;'],
  ['let J: any = {};', 'J = JSON; J.stringify = other;'],
  ['let J: any = Object;', 'J = JSON; J.stringify = other;'],
  ['const R = Response;', 'delete R.json;'],
  ['const G = globalThis;', 'Object.defineProperty(G, "Response", { value: other });'],
  ['const { stringify: s } = JSON;', 'Object.assign(s, { toJSON: other });'],
  ['const { json: j } = Response;', 'Reflect.set(j, "name", "changed");'],
  ['const G = globalThis; const R = G.Response; const alias = R;', 'alias["json"] = other;'],
  ['const define = Object.defineProperty; const J = JSON;', 'define(J, "stringify", { value: other });'],
  ['', '({ value: JSON.stringify } = supplied);'],
  ['', '[globalThis.Response] = supplied;'],
  ['', 'JSON.count++;'],
  ['', 'function unused() { JSON.stringify = other; }'],
])("rejects a trusted built-in mutation: %s %s", (setup, mutation) => {
  const source = ts.createSourceFile("fixture.ts", `${setup}\n${mutation}`, ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  const refusals = [...inventory.unresolved].filter(([, detail]) => detail.startsWith("unsupported trusted built-in use"));
  expect(refusals.length).toBeGreaterThan(0);
  for (const [site] of refusals) expect(site).toMatch(/^fixture\.ts:2:\d+$/);
});

test.each([
  ['Object.defineProperties(JSON, { stringify: { value: other } });', 25],
  ['Reflect.defineProperty(JSON, "stringify", { value: other });', 24],
  ['Reflect.deleteProperty(JSON, "stringify");', 24],
  ['Object.setPrototypeOf(Response, other);', 23],
  ['const x = [JSON];', 12],
  ['fn(Response);', 4],
  ['function f() { return globalThis; }', 23],
  ['const x = { JSON };', 13],
  ['const x = { value: Response };', 20],
  ['const x = { ...JSON };', 16],
  ['const x = [...Response];', 15],
  ['JSON[key]({});', 1],
  ['export default JSON;', 16],
  ['JSON instanceof x;', 1],
  ['JSON = other;', 1],
  ['const { Response: R } = globalThis; R.json({});', 25],
  ['const J = JSON; J = other;', 17],
  ['const J = JSON; fn(J);', 20],
  ['const G = globalThis; function f() { return G; }', 45],
  ['const R = Response; R.json = other;', 21],
  ['const R = Response; delete R.json;', 28],
  ['const J = JSON; J["stringify"]({});', 17],
  ['const J = JSON; J.unknown({});', 17],
])("refuses a use outside the whitelist: %s", (text, column) => {
  const source = ts.createSourceFile("fixture.ts", text, ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect(inventory.unresolved.get(`fixture.ts:1:${column}`)).toStartWith("unsupported trusted built-in use:");
});

test.each([
  'JSON.stringify({})',
  'JSON.parse("{}")',
  'Response.json({})',
  'new Response()',
  'x instanceof Response',
  'typeof JSON',
  'typeof globalThis',
  'new globalThis.Response()',
  'globalThis.Response.json({})',
  'x instanceof globalThis.Response',
  'const J = JSON; J.stringify({});',
  'const R = Response; x instanceof R;',
  'const R = Response; typeof R;',
  'const G = globalThis; new G.Response();',
  'const G = globalThis; const R = G.Response; R.json({});',
  'const { stringify: s } = JSON; s({});',
])("accepts a use in the whitelist: %s", (text) => {
  const source = ts.createSourceFile("fixture.ts", text, ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect([...inventory.unresolved]).toEqual([]);
  expect(inventory.unaccounted).toEqual([]);
  expect(inventory.unaccountedAliasUses).toEqual([]);
});

test.each(['Response.error()', 'Response.redirect("http://example.invalid/")'])("permits the built-in use while retaining the refusal diagnostic: %s", (text) => {
  const source = ts.createSourceFile("fixture.ts", text, ts.ScriptTarget.Latest, true);
  expect([...buildInventory(new Map([["fixture.ts", source]])).unresolved.values()]
    .some((detail) => detail.startsWith("unsupported trusted built-in use"))).toBe(false);
});

test.each(["JSON", "Response", "globalThis"])("follows a named export and import of %s", (name) => {
  const policyFile = "resources/soul-write-policy.ts";
  const soulFile = "resources/Soul.ts";
  const call = name === "JSON" ? "J.stringify({})" : name === "Response" ? "new J()" : "new J.Response()";
  const sources = new Map([
    [policyFile, ts.createSourceFile(policyFile, `const A = ${name}; export { A as J };`, ts.ScriptTarget.Latest, true)],
    [soulFile, ts.createSourceFile(soulFile, `import { J } from "./soul-write-policy.js"; ${call}; fn(J);`, ts.ScriptTarget.Latest, true)],
  ]);
  const inventory = buildInventory(sources);
  expect([...inventory.unresolved]).toEqual([
    [`${soulFile}:1:${`import { J } from "./soul-write-policy.js"; ${call}; fn(`.length + 1}`, "unsupported trusted built-in use: J in CallExpression"],
  ]);
});

test.each(["JSON", "Response", "globalThis"])("refuses an argument reached through a namespace import of %s", (name) => {
  const policyFile = "resources/soul-write-policy.ts";
  const soulFile = "resources/Soul.ts";
  const sources = new Map([
    [policyFile, ts.createSourceFile(policyFile, `export const J = ${name};`, ts.ScriptTarget.Latest, true)],
    [soulFile, ts.createSourceFile(soulFile, 'import * as N from "./soul-write-policy.js"; fn(N.J);', ts.ScriptTarget.Latest, true)],
  ]);
  expect(buildInventory(sources).unresolved.get(`${soulFile}:1:13`)).toBe("unsupported trusted built-in use");
  sources.set(soulFile, ts.createSourceFile(soulFile, 'import type * as N from "./soul-write-policy.js";', ts.ScriptTarget.Latest, true));
  expect([...buildInventory(sources).unresolved]).toEqual([]);
});

test("rejects a mutation through an imported built-in alias anywhere in the closure", () => {
  const texts = new Map([
    ["resources/soul-write-policy.ts", 'export const J = JSON;'],
    ["resources/Soul.ts", 'import { J } from "./soul-write-policy.js";\nfunction unused() { J.stringify = other; }'],
  ]);
  const sources = new Map([...texts].map(([file, text]) => [file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)]));
  expect(buildInventory(sources).unresolved.get("resources/Soul.ts:2:21")).toBe("unsupported trusted built-in use: J.stringify in BinaryExpression");
});

test("does not treat a shadowed JSON object as a trusted built-in mutation", () => {
  const source = ts.createSourceFile("fixture.ts", 'const JSON = { stringify: () => "" }; JSON.stringify = other;', ts.ScriptTarget.Latest, true);
  expect([...buildInventory(new Map([["fixture.ts", source]])).unresolved]).toEqual([]);
});

test("an alias passed as an argument is an unaccounted use, not a silent pass", () => {
  const source = ts.createSourceFile("fixture.ts",
    'function callWith(callee: any) { return callee({ error: "x" }, { status: 403 }); }\nconst R = Response;\ncallWith(R);',
    ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect([...inventory.codes]).toEqual([]);
  expect(inventory.unaccountedAliasUses).toEqual(["fixture.ts:3: R"]);
});

test("an alias passed to a function in another module is an unaccounted use", () => {
  const policyFile = "resources/soul-write-policy.ts";
  const soulFile = "resources/Soul.ts";
  const policy = ts.createSourceFile(policyFile,
    'export function callWith(callee: any) { return callee({ error: "x" }, { status: 403 }); }',
    ts.ScriptTarget.Latest, true);
  const soul = ts.createSourceFile(soulFile,
    'import { callWith } from "./soul-write-policy.js";\nconst R = Response;\ncallWith(R);',
    ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([[policyFile, policy], [soulFile, soul]]));
  expect([...inventory.codes]).toEqual([]);
  expect(inventory.unaccountedAliasUses).toEqual([`${soulFile}:3: R`]);
});

test("an alias stored in an object property is an unaccounted use, not a silent pass", () => {
  const source = ts.createSourceFile("fixture.ts",
    'const o = { r: Response };\no.r.json({ error: "x" }, { status: 403 });', ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect([...inventory.codes]).toEqual([]);
  expect(inventory.occurrences).toBe(0);
  expect(inventory.unaccounted).toEqual(["fixture.ts:1"]);
});


test.each([
  'flag ? { error: "x" } : { error: "y" }',
  '{ error: "x" } && { error: "y" }',
  '{ error: "x" } || { error: "y" }',
  '{ error: "x" } ?? { error: "y" }',
  '{ error: flag ? "x" : "y" }',
  '{ error: "x" && "y" }',
  '{ error: "x" || "y" }',
  '{ error: "x" ?? "y" }',
])("records every literal error branch: %s", (body) => {
  for (const expression of [
    `Response.json(${body}, { status: 403 })`,
    `new Response(JSON.stringify(${body}), { status: 403 })`,
  ]) {
    const source = ts.createSourceFile("fixture.ts", expression, ts.ScriptTarget.Latest, true);
    const inventory = buildInventory(new Map([["fixture.ts", source]]));
    expect([...inventory.codes]).toEqual([["x", "fixture.ts:1"], ["y", "fixture.ts:1"]]);
    expect([...inventory.unresolved]).toEqual([]);
  }
});

test.each([
  '{ error: "x", toJSON: serialize }',
  '{ error: "x", ...extra }',
  '{ ...extra, error: "x" }',
  '{ error: "x", [key]: "y" }',
  '{ error: "x", error: "y" }',
  '{ error: "x", "error": "y" }',
  'flag ? { error: "x" } : unknown',
  'unknown && { error: "x" }',
  '{ error: "x" } || unknown',
  '{ error: "x" } ?? unknown',
  '{ error: flag ? "x" : unknown }',
  '{ error: "x" || unknown }',
  '{ error: unknown }',
  '{ error: getError() }',
  '{ error: result.error }',
  '{ error: `x${value}` }',
  'payload',
  'makePayload()',
  'JSON.stringify({ error: "x" })',
])("leaves an incompletely evaluated payload unresolved: %s", (body) => {
  const source = ts.createSourceFile("fixture.ts", `const payload = { error: "x" }; let unknown = "x"; const extra = {}; Response.json(${body}, { status: 403 })`, ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect([...inventory.codes]).toEqual([]);
  expect(inventory.classified).toBe(0);
  expect(inventory.unresolvedReferences).toBe(1);
  expect([...inventory.unresolved]).toEqual([[siteIn(source, "Response.json"), "unresolvable refusal body"]]);
});

test.each([
  '{ status: flag ? 403 : 400 }',
  '{ status: 403 && 400 }',
  '{ status: 403 || 400 }',
  '{ status: 403 ?? 400 }',
  'flag ? { status: 403 } : { status: 400 }',
  '{ status: 403 } && { status: 400 }',
  '{ status: 403 } || { status: 400 }',
  '{ status: 403 } ?? { status: 400 }',
])("records every literal status branch: %s", (init) => {
  const source = ts.createSourceFile("fixture.ts", `Response.json({ error: "skill_opt_out_not_boolean" }, ${init})`, ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect([...inventory.statuses]).toEqual([["fixture.ts:1", [403, 400]]]);
  expect([...inventory.codes]).toEqual([["skill_opt_out_not_boolean", "fixture.ts:1"]]);
  expect([...inventory.unresolved]).toEqual([]);
});

test.each([
  '{ status: flag ? 403 : unknown }',
  '{ status: 403 || unknown }',
  '{ status: result.status }',
  '{ status: `403${value}` }',
  '{ status: 200, status: 403 }',
])("leaves an incompletely evaluated status unresolved: %s", (init) => {
  const source = ts.createSourceFile("fixture.ts", `Response.json({ error: "x" }, ${init})`, ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect([...inventory.statuses]).toEqual([]);
  expect([...inventory.unresolved]).toEqual([[siteIn(source, source.text.includes("Response.json") ? "Response.json" : "new Response"), "unresolvable Response status"]]);
});

test("checks every payload and status branch passed to a status-taking helper", () => {
  const source = ts.createSourceFile("fixture.ts", `
function jsonResponse(status: number, body: any) { return new Response(JSON.stringify(body), { status }); }
jsonResponse(flag ? 403 : 400, flag ? { error: "x" } : { error: "y" });
jsonResponse(403, flag ? { error: "x" } : unknown);`, ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect(inventory.statuses.get("fixture.ts:3")).toEqual([403, 400]);
  expect([...inventory.codes]).toEqual([["x", "fixture.ts:3"], ["y", "fixture.ts:3"]]);
  expect(inventory.unresolved.get("fixture.ts:4:1")).toBe("unresolvable refusal body");
});


test("a payload toJSON override is unresolved", async () => {
  const payload = { error: "skill_opt_out_not_boolean", toJSON: () => ({ error: "x_new_rule" }) };
  expect(await Response.json(payload, { status: 403 }).json()).toEqual({ error: "x_new_rule" });
  const source = ts.createSourceFile("fixture.ts",
    'Response.json({ error: "skill_opt_out_not_boolean", toJSON: () => ({ error: "x_new_rule" }) }, { status: 403 })',
    ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect(inventory.classified).toBe(0);
  expect([...inventory.unresolved]).toEqual([[siteIn(source, "Response.json"), "unresolvable refusal body"]]);
});


test.each([
  'const code = "x"; const status = 403;',
  'const code = ("x" as const); const status = (403 as const);',
  'const code = (("x")); const status = ((403));',
])("evaluates literal const bindings: %s", (bindings) => {
  const source = ts.createSourceFile("fixture.ts",
    `${bindings} Response.json({ error: code }, { status });`, ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect([...inventory.codes]).toEqual([["x", "fixture.ts:1"]]);
  expect([...inventory.statuses]).toEqual([["fixture.ts:1", [403]]]);
  expect([...inventory.unresolved]).toEqual([]);
});

test.each([
  'let code = "x";',
  'var code = "x";',
  'const { code } = { code: "x" };',
  'const [code] = ["x"];',
  'const code = flag ? "x" : "y";',
  'const code = getCode();',
  'const original = "x"; const code = original;',
  'const code = "x" as string;',
  'const code = `x`;',
  'const code = "outer"; function f(code: string) {',
  'const code = "outer"; { let code = "inner";',
  'const code = "outer"; { const code = getCode();',
])("leaves a nonliteral or shadowed binding unresolved: %s", (bindings) => {
  const source = ts.createSourceFile("fixture.ts",
    `${bindings} Response.json({ error: code }, { status: 403 }); ${bindings.endsWith("{") || bindings.includes("; {") ? "}" : ""}`, ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect([...inventory.codes]).toEqual([]);
  expect([...inventory.unresolved]).toEqual([[siteIn(source, "Response.json"), "unresolvable refusal body"]]);
});

test.each([
  'const code = "outer"; { const code = "x";',
  'function f() { const code = "x";',
  'const code = "x"; function f() {',
])("resolves the lexical literal const: %s", (bindings) => {
  const source = ts.createSourceFile("fixture.ts",
    `${bindings} Response.json({ error: code }, { status: 403 }); }`, ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect([...inventory.codes]).toEqual([["x", "fixture.ts:1"]]);
  expect([...inventory.unresolved]).toEqual([]);
});

test.each([
  'export { code as renamed, status } from "./soul-write-policy.js";',
  'import { code, status } from "./soul-write-policy.js"; export { code as renamed, status };',
  'export * from "./soul-write-policy.js";',
])("resolves imported literal consts through re-exports: %s", (reexport) => {
  const texts = new Map([
    ["resources/soul-write-policy.ts", 'export const code = ("x" as const); export const status = (403 as const);'],
    ["resources/owner-field-guard.ts", reexport],
    ["resources/Soul.ts", `import { ${reexport.startsWith("export *") ? "code" : "renamed"} as error, status as refusalStatus } from "./owner-field-guard.js"; Response.json({ error }, { status: refusalStatus });`],
  ]);
  const sources = new Map([...texts].map(([file, text]) => [file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)]));
  const inventory = buildInventory(sources);
  expect([...inventory.codes]).toEqual([["x", "resources/Soul.ts:1"]]);
  expect([...inventory.unresolved]).toEqual([]);
});

test.each([
  'const obj = { code: "x" };',
  'const obj = { code: "x" }; obj.code = "y";',
  'const obj = { code: "x" }; Object.assign(obj, { code: "y" });',
])("leaves object members unresolved: %s", (bindings) => {
  const source = ts.createSourceFile("fixture.ts",
    `${bindings} Response.json({ error: obj.code }, { status: 403 });`, ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect([...inventory.codes]).toEqual([]);
  expect([...inventory.unresolved]).toEqual([[siteIn(source, "Response.json"), "unresolvable refusal body"]]);
});

test("record-type-kit FORBIDDEN parameter forwarding stays unresolved", () => {
  const inventory = buildInventory(collectSourceSet());
  for (const at of ["resources/record-type-kit.ts:514:26", "resources/record-type-kit.ts:519:26", "resources/record-type-kit.ts:527:26"]) {
    expect(inventory.unresolved.get(at)).toBe("unresolvable refusal argument: FORBIDDEN.msg");
  }
});


test.each([
  [`function f() { const JSON = { stringify: () => '{"error":"x_new_rule"}' }; return new Response(JSON.stringify({ error: "skill_opt_out_not_boolean" }), { status: 403 }); }`, 'new Response', 'unresolvable refusal body'],
  ['function f() { const Response = { json: () => ({ error: "x_new_rule" }) }; return Response.json({ error: "skill_opt_out_not_boolean" }, { status: 403 }); }', 'Response.json', 'unrecognised Response reference'],
  ['function f(row: any) { return row.Response.json({ error: "skill_opt_out_not_boolean" }, { status: 403 }); }', 'row.Response.json', 'unrecognised Response reference'],
  ['function f(globalThis: any) { return globalThis.Response.json({ error: "skill_opt_out_not_boolean" }, { status: 403 }); }', 'globalThis.Response.json', 'unrecognised Response reference'],
  ['function f(Response: any) { const R = Response; return R.json({ error: "skill_opt_out_not_boolean" }, { status: 403 }); }', 'R.json', 'unrecognised Response reference'],
])("rejects an unproven built-in binding: %s", (text, callee, detail) => {
  const source = ts.createSourceFile("fixture.ts", text, ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect([...inventory.codes]).toEqual([]);
  expect(inventory.classified).toBe(0);
  if (callee === "R.json") expect(inventory.unaccounted).not.toEqual([]);
  else expect([...inventory.unresolved]).toEqual([[siteIn(source, callee), detail]]);
});

test("keeps distinct unresolved calls on one line", () => {
  const source = ts.createSourceFile("fixture.ts",
    'Response.json(payload, { status: 403 }); Response.json({}, { status: unknown });', ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect([...inventory.unresolved]).toEqual([
    ["fixture.ts:1:1", "unresolvable refusal body"],
    ["fixture.ts:1:42", "unresolvable Response status"],
  ]);
});


test.each([
  'globalThis["Response"].json({ error: "x" }, { status: 403 });',
  'globalThis[`Response`].json({ error: "x" }, { status: 403 });',
  'const key = "Response"; globalThis[key].json({ error: "x" }, { status: 403 });',
  'const key = "Response"; const next = key; globalThis[next].json({ error: "x" }, { status: 403 });',
  'const { ["Response"]: R } = globalThis; R.json({ error: "x" }, { status: 403 });',
])("a static string Response property remains unresolved: %s", (text) => {
  const source = ts.createSourceFile("fixture.ts", text, ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect([...inventory.codes]).toEqual([]);
  expect([...inventory.unresolved.values()]).toContain("unrecognised Response reference");
});


test.each([
  ['JSON', 'export const JSON = { stringify: () => "x_new_rule" };', 'new Response(JSON.stringify({ error: "skill_opt_out_not_boolean" }), { status: 403 });', 'unresolvable refusal body'],
  ['Response', 'export const Response = { json: () => ({ error: "x_new_rule" }) };', 'Response.json({ error: "skill_opt_out_not_boolean" }, { status: 403 });', 'unrecognised Response reference'],
  ['globalThis', 'export const globalThis = { Response: { json: () => ({ error: "x_new_rule" }) } };', 'globalThis.Response.json({ error: "skill_opt_out_not_boolean" }, { status: 403 });', 'unrecognised Response reference'],
])("rejects an imported shadow of %s", (name, declaration, call, detail) => {
  const file = "resources/Soul.ts";
  const source = ts.createSourceFile(file,
    `import { ${name} } from "./soul-write-policy.js"; ${call}`, ts.ScriptTarget.Latest, true);
  const dependency = ts.createSourceFile("resources/soul-write-policy.ts", declaration, ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([[file, source], ["resources/soul-write-policy.ts", dependency]]));
  expect([...inventory.codes]).toEqual([]);
  expect([...inventory.unresolved]).toEqual([[siteIn(source, call), detail]]);
});


test("an authored no-default-lib declaration cannot prove Response", () => {
  const file = "resources/Soul.ts";
  const source = ts.createSourceFile(file,
    'Response.json({ error: "skill_opt_out_not_boolean" }, { status: 403 });', ts.ScriptTarget.Latest, true);
  const declarationFile = "resources/fake-global.d.ts";
  const declarations = ts.createSourceFile(declarationFile,
    '/// <reference no-default-lib="true"/>\ndeclare const Response: { json(body: any, init: any): any };', ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([[file, source], [declarationFile, declarations]]));
  expect([...inventory.codes]).toEqual([]);
  expect([...inventory.unresolved]).toEqual([[`${file}:1:1`, "unrecognised Response reference"]]);
});


test.each([
  'const JSON = { stringify: () => "x_new_rule" }; new Response(JSON.stringify({ error: "skill_opt_out_not_boolean" }), { status: 403 });',
  'const Response = { json: () => "x_new_rule" }; Response.json({ error: "skill_opt_out_not_boolean" }, { status: 403 });',
  'const globalThis = { Response: { json: () => "x_new_rule" } }; globalThis.Response.json({ error: "skill_opt_out_not_boolean" }, { status: 403 });',
])("rejects a top-level shadow: %s", (text) => {
  const source = ts.createSourceFile("fixture.ts", text, ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect([...inventory.codes]).toEqual([]);
  expect(inventory.unresolved.size).toBeGreaterThan(0);
});
