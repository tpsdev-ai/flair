/**
 * restore-soul-refusal-inventory-2953.test.ts — the Soul write-refusal
 * inventory behind `flair restore --replace` (flair#2953).
 *
 * The replace preflight in src/commands/restore.ts duplicates the server's
 * Soul write policy. A refusal added to the write path after the preflight
 * would reopen the delete-then-refused window, so this inventory derives the
 * source set from imports and reads the refusal code at each refusal site. A
 * code found at a site must be preflighted, refused by archive admission, or
 * named out of scope here; an unlisted site whose argument is not a statically
 * known string fails instead of being skipped.
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
  /** Sites whose refusal argument is not a statically known string. */
  unresolved: Map<string, string>;
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

function buildInventory(sources: Map<string, ts.SourceFile>): RefusalInventory {
  const importAliases = new Map<string, Map<string, { file: string; name: string }>>();
  const topLevelConsts = new Map<string, Map<string, ts.Expression>>();
  const functions: FnRecord[] = [];
  const functionsByName = new Map<string, FnRecord>();

  for (const [file, source] of sources) {
    const aliases = new Map<string, { file: string; name: string }>();
    const constants = new Map<string, ts.Expression>();
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
    importAliases.set(file, aliases);
    topLevelConsts.set(file, constants);
  }
  for (const record of functions) if (!functionsByName.has(record.key)) functionsByName.set(record.key, record);

  const resolveFunction = (file: string, name: string): FnRecord | null => {
    const local = functionsByName.get(`${file}:${name}`);
    if (local) return local;
    const alias = importAliases.get(file)?.get(name);
    return alias ? (functionsByName.get(`${alias.file}:${alias.name}`) ?? null) : null;
  };

  /** The nearest preceding const/let/var in an enclosing scope, or a top-level const. */
  const lookupVariable = (at: ts.Node, name: string): ts.Expression | null => {
    let parent: ts.Node | undefined = at.parent;
    while (parent) {
      const statements = ts.isSourceFile(parent) || ts.isBlock(parent) || ts.isModuleBlock(parent) ? parent.statements : null;
      if (statements) {
        for (const statement of statements) {
          if (!ts.isVariableStatement(statement)) continue;
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) return declaration.initializer;
          }
        }
      }
      parent = parent.parent;
    }
    return topLevelConsts.get(at.getSourceFile().fileName)?.get(name) ?? null;
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
      const local = lookupVariable(expression, expression.text);
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

  /** Whether a function's body constructs a non-2xx Response, and from which parameter. */
  const describe = (record: FnRecord): FnInfo => {
    let statusParam: string | null = null;
    let messageParam: string | null = null;
    const parameters = parametersOf(record.fn);
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Response") {
        const status = propertyOf(node.arguments?.[1], record.file, "status");
        const statuses = resolveNumbers(record.file, status);
        if (!statuses && status && ts.isIdentifier(status) && parameters.has(status.text)) statusParam = status.text;
        const error = propertyOf(payloadOf(record.file, node.arguments?.[0]), record.file, "error");
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

  // (b) Direct `new Response(...)` bodies with a non-2xx status.
  for (const [file, source] of sources) {
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Response") {
        const statuses = resolveNumbers(file, propertyOf(node.arguments?.[1], file, "status"));
        if (statuses && statuses.every((value) => value >= 400)) {
          const error = propertyOf(payloadOf(file, node.arguments?.[0]), file, "error");
          const holder = enclosingFunction(node);
          if (!(holder && error && ts.isIdentifier(error) && sinkParamOf(holder) === error.text)) {
            const values = resolveString(file, error);
            if (values) for (const value of values) recordCode(value, file, lineOf(source, node));
            else recordUnresolved(file, lineOf(source, node), "unresolvable refusal body");
          }
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
    const source = sources.get(record.file)!;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && resolveFunction(record.file, node.expression.text)?.key === record.key) {
        let index = -1;
        record.fn.parameters.forEach((parameter, position) => {
          if (ts.isIdentifier(parameter.name) && parameter.name.text === statusParam) index = position;
        });
        const statuses = index >= 0 ? resolveNumbers(record.file, node.arguments[index]) : null;
        if (statuses && statuses.every((value) => value >= 400)) {
          const body = node.arguments.find((argument) => {
            if (ts.isObjectLiteralExpression(argument)) return true;
            if (!ts.isIdentifier(argument)) return false;
            const local = lookupVariable(argument, argument.text);
            return !!local && ts.isObjectLiteralExpression(local);
          });
          const values = resolveString(record.file, propertyOf(body, record.file, "error"));
          if (values) for (const value of values) recordCode(value, record.file, lineOf(source, node));
          else recordUnresolved(record.file, lineOf(source, node), "unresolvable refusal body");
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return { codes, unresolved };
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
  ["soul_write_requires_operator", "write authorization: the preflight and the write use the same admin credentials"],
  ["authentication required", "anonymous 401: the preflight and the write use the same admin credentials"],
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
  ["soul_subject_occupied", "identity-change path: the replace PUT has no stored row, so its identity did not change"],
  ["instruction_version_head_mismatch", "compare-and-set: the replace PUT supplies no expectedVersion"],
  ["instruction_version_append_failed", "commit-time version append failure, which the preflight cannot predict"],
  ["instruction_version_busy", "commit-time version lock contention, which the preflight cannot predict"],
  ["instruction_version_lock_unavailable", "commit-time version lock availability, which the preflight cannot predict"],
  ["skill_write_requires_verified_identity", "skill-version write authorization; the Soul write path does not call it"],
  ["not found", "kit by-id read gate: Soul has no get() override and the write path returns no 404"],
  ["non_canonical_request_target", "request-target canonicalisation in the auth middleware; not a Soul write rule"],
]);

/** Refusal sites whose message is built at runtime, with the reason it is accepted. */
const RUNTIME_MESSAGES = new Map<string, string>([
  ["resources/record-owner-guard.ts:220", "message interpolates the table name; the owner-scoped write middleware raises it, not the Soul row write"],
  ["resources/record-owner-guard.ts:231", "message interpolates the table name; the owner-scoped write middleware raises it, not the Soul row write"],
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

test("a refusal site whose message is built at runtime is listed with a reason", () => {
  const inventory = buildInventory(collectSourceSet());
  const unexpected = [...inventory.unresolved]
    .filter(([at]) => !RUNTIME_MESSAGES.has(at))
    .map(([at, detail]) => `${at}: ${detail}`)
    .sort();
  expect(unexpected).toEqual([]);
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
