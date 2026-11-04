/**
 * restore-soul-refusal-inventory-2953.test.ts — the Soul write-refusal
 * inventory behind `flair restore --replace` (flair#2953).
 *
 * The source set is the relative-import closure of resources/Soul.ts.
 * Every syntactic reference to `Response` in a construction or call position
 * (bare, `globalThis.Response`, `<x>.Response`, or a top-level alias of one)
 * is counted, and each is either classified or recorded as an unresolved site;
 * the test asserts classified + unresolved equals the number of references.
 * For new Response and Response.json, only no init (default 200) or a
 * plain, unwrapped object literal with no spread or computed keys is classified;
 * every property is read to prove status absent or statically numeric.
 * Every other init, every other static method (`Response.redirect`) and
 * `Response.error()` (status 0) is unresolved and fails with file:line unless
 * listed with a reason. Recognised status-taking helpers require statically
 * numeric status arguments; their unresolved definitions must also be listed.
 * A function that forwards one of its parameters into a callee the inventory
 * cannot resolve (a method call, a computed callee, a callee outside the
 * closure) is opaque: listed by name with a reason, or the test fails naming
 * it. Refusal codes must be preflighted, admission-refused or listed out of scope.
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
  /** Response references (construction or call position). */
  occurrences: number;
  /** References `responseShape` classified (a status list it proved). */
  classified: number;
  /** References recorded as unresolved. */
  unresolvedReferences: number;
  /** Functions forwarding a parameter into a callee the inventory cannot resolve. */
  opaque: Map<string, string>;
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

/** Whether a `new`/call's callee is the Response constructor, directly or through a top-level alias. */
function responseCallee(file: string, callee: ts.Expression, aliases: Map<string, Set<string>>): boolean {
  if (isResponseReferenceName(callee)) return true;
  if (ts.isIdentifier(callee)) return aliases.get(file)?.has(callee.text) === true;
  // `Response.json(...)` and `Response.redirect(...)`, and the same on an alias.
  if (ts.isPropertyAccessExpression(callee)) {
    if (isResponseReferenceName(callee.expression)) return true;
    return ts.isIdentifier(callee.expression) && aliases.get(file)?.has(callee.expression.text) === true;
  }
  return false;
}

function buildInventory(sources: Map<string, ts.SourceFile>): RefusalInventory {
  const importAliases = new Map<string, Map<string, { file: string; name: string }>>();
  const topLevelConsts = new Map<string, Map<string, ts.Expression>>();
  const responseAliases = new Map<string, Set<string>>();
  const functions: FnRecord[] = [];
  const functionsByName = new Map<string, FnRecord>();

  for (const [file, source] of sources) {
    const aliases = new Map<string, { file: string; name: string }>();
    const constants = new Map<string, ts.Expression>();
    const responseNames = new Set<string>();
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const target = resolveRelative(file, statement.moduleSpecifier.text);
        const bindings = statement.importClause?.namedBindings;
        if (target && bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            aliases.set(element.name.text, { file: target, name: (element.propertyName ?? element.name).text });
          }
        }
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer) {
            constants.set(declaration.name.text, declaration.initializer);
            if (isResponseReferenceName(declaration.initializer)) responseNames.add(declaration.name.text);
          }
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
    importAliases.set(file, aliases);
    topLevelConsts.set(file, constants);
    responseAliases.set(file, responseNames);
  }
  for (const record of functions) if (!functionsByName.has(record.key)) functionsByName.set(record.key, record);

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

  const responseShape = (file: string, node: ts.Expression): ResponseShape | null => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Response") {
      const init = node.arguments?.[1];
      if (node.arguments?.some(ts.isSpreadElement)) return { status: undefined, statuses: null, body: null };
      return {
        ...responseInit(file, init),
        body: node.arguments?.[0] ?? null,
      };
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Response") {
      const method = node.expression.name.text;
      if (method === "json") {
        const init = node.arguments?.[1];
        if (node.arguments.some(ts.isSpreadElement)) return { status: undefined, statuses: null, body: null };
        return {
          ...responseInit(file, init),
          body: node.arguments?.[0] ?? null,
        };
      }
      if (method === "error") return { status: undefined, statuses: null, body: null };
    }
    return null;
  };

  const describe = (record: FnRecord): FnInfo => {
    let statusParam: string | null = null;
    let messageParam: string | null = null;
    const parameters = parametersOf(record.fn);
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
        const shape = responseShape(record.file, node);
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
        if (argument && ts.isIdentifier(argument) && parameters.has(argument.text)) forwarded = argument.text;
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
      if (argument && ts.isIdentifier(argument) && sinkParamOf(enclosingFunction(node)) === argument.text) {
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

  // (b) Every Response reference in a construction or call position is counted:
  // no init (200), or a plain, unwrapped object literal without spread/computed
  // keys, with every property read and status absent or statically numeric, is
  // classified. Every other init, every other static method (Response.redirect),
  // Response.error() (status 0), a globalThis/alias form and an unresolvable body
  // are unresolved and fail with file:line unless listed with a reason.
  // Status-taking helpers require static status arguments in (c).
  let occurrences = 0;
  let classified = 0;
  let unresolvedReferences = 0;
  for (const [file, source] of sources) {
    const visit = (node: ts.Node): void => {
      if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && responseCallee(file, node.expression, responseAliases)) {
        occurrences++;
        const shape = responseShape(file, node);
        if (shape && shape.statuses !== null) {
          classified++;
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
          unresolvedReferences++;
          recordUnresolved(file, lineOf(source, node), shape ? "unresolvable Response status" : "unrecognised Response reference");
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

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
            if (ts.isIdentifier(argument) && parameters.has(argument.text) && !opaque.has(record.key)) {
              const source = record.fn.getSourceFile();
              opaque.set(record.key,
                `${record.file}:${lineOf(source, node)} forwards ${argument.text} into ${callee.getText(source)}`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(bodyOf(record.fn));
  }

  return { codes, unresolved, occurrences, classified, unresolvedReferences, opaque };
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
  ["instruction_version_append_failed", "commit-time version append failure not caused by the archived row's schema, which admission refuses before any delete"],
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
 * cannot resolve, with the reason the forwarding cannot hide a refusal.
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

test("every Response reference is classified or listed unresolved", () => {
  const inventory = buildInventory(collectSourceSet());
  expect(inventory.occurrences).toBeGreaterThan(0);
  expect(inventory.classified + inventory.unresolvedReferences).toBe(inventory.occurrences);
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
  'new globalThis.Response(JSON.stringify({ error: "x" }), { status: 403 })',
  'Response.redirect("http://example.invalid/")',
  'const R = Response; new R(JSON.stringify({ error: "x" }), { status: 403 })',
  'const R = Response; R.json({ error: "x" }, { status: 403 })',
])('counts a Response form it does not classify as unresolved: %s', (expression) => {
  const source = ts.createSourceFile("fixture.ts", expression, ts.ScriptTarget.Latest, true);
  const inventory = buildInventory(new Map([["fixture.ts", source]]));
  expect(inventory.occurrences).toBe(1);
  expect(inventory.classified).toBe(0);
  expect(inventory.unresolvedReferences).toBe(1);
  expect([...inventory.unresolved]).toEqual([["fixture.ts:1", "unrecognised Response reference"]]);
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
