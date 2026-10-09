import ts from "typescript";

export interface TableWriteSite {
  key: string;
  line: number;
  kind: "alias-source" | "writer";
  expression: string;
}

/** Conservative inventory: in every module referencing the raw target table,
 * enumerate ALL put/update calls and patchRecord helpers, including aliases
 * and table-map dispatch. Unrelated sinks require an explicit classification
 * too; this avoids pretending a local alias analysis proves a dynamic target.
 * Escaped handles (variables, table maps, returns, arguments) are inventoried
 * separately so read-only aliases and injected migration adapters are reviewed.
 */
/** The function helpers that write a row of the table they are handed, and the
 *  module each is exported from. */
export const WRITER_HELPERS: Readonly<Record<string, RegExp>> = Object.freeze({
  writeBackCommittedRow: /(^|\/)write-back(\.js|\.ts)?$/,
  patchRecord: /(^|\/)table-helpers(\.js|\.ts)?$/,
  patchRecordSilent: /(^|\/)table-helpers(\.js|\.ts)?$/,
});

/** Types whose value is a writer helper (an injected helper parameter). */
const WRITER_HELPER_TYPES: Readonly<Record<string, string>> = Object.freeze({ WriteBackFn: "writeBackCommittedRow" });

export interface WriterHelperCall {
  /** The helper the call reaches. */
  helper: string;
  /** The callee as written (`writeBackCommittedRow`, an alias, `ns.writeBackCommittedRow`). */
  callee: string;
  line: number;
  call: ts.CallExpression;
}

const unwrap = (node: ts.Expression): ts.Expression => {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression;
  return current;
};

/**
 * Every call of a writer helper in `source`, through its own name, an import
 * alias (`import { writeBackCommittedRow as wb }`), a namespace import, a
 * local alias (`const wb = writeBackCommittedRow`) or a parameter or variable
 * defaulted to one or typed as `WriteBackFn`. Names are resolved by name, not
 * scope, so a same-named binding counts too. Any other reference to a helper
 * name or helper-module namespace, a re-export of a helper, or a dynamic
 * import of a helper module by name throws: the scan accepts only references
 * it can follow to a call (flair#2354).
 */
export function writerHelperCalls(file: string, source: string): WriterHelperCall[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const where = (node: ts.Node) => `${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`;
  const unresolved = (node: ts.Node, what: string): never => {
    throw new Error(`unresolved writer-helper reference (${what}): ${where(node)}`);
  };
  const names = new Map<string, string>();
  const namespaces = new Map<string, RegExp>();
  const helperModule = (spec: string) => Object.values(WRITER_HELPERS).some((re) => re.test(spec));
  for (const statement of ast.statements) {
    if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier) && helperModule(statement.moduleSpecifier.text)) {
      const spec = statement.moduleSpecifier.text;
      if (ts.isExportDeclaration(statement)) {
        if (statement.isTypeOnly) continue;
        const clause = statement.exportClause;
        if (!clause || !ts.isNamedExports(clause)) unresolved(statement, "re-export");
        for (const element of (clause as ts.NamedExports).elements) {
          if (!element.isTypeOnly && (element.propertyName ?? element.name).text in WRITER_HELPERS) unresolved(element, "re-export");
        }
        continue;
      }
      const clause = statement.importClause;
      if (!clause || clause.isTypeOnly) continue;
      if (clause.name) unresolved(clause, "default import");
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        const re = Object.values(WRITER_HELPERS).find((r) => r.test(spec))!;
        namespaces.set(bindings.name.text, re);
      } else if (bindings) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (!element.isTypeOnly && imported in WRITER_HELPERS && WRITER_HELPERS[imported].test(spec)) {
            names.set(element.name.text, imported);
          }
        }
      }
    }
  }
  // Declarations of a helper (the defining module) and alias bindings, to a
  // fixed point: a binding initialised with, defaulted to or typed as a helper
  // is that helper.
  const bindingHelper = (node: ts.VariableDeclaration | ts.ParameterDeclaration): string | undefined => {
    const init = node.initializer && unwrap(node.initializer);
    if (init && ts.isIdentifier(init) && names.has(init.text)) return names.get(init.text);
    if (init && ts.isPropertyAccessExpression(init) && ts.isIdentifier(init.expression) && namespaces.has(init.expression.text) &&
        init.name.text in WRITER_HELPERS) return init.name.text;
    const type = node.type;
    if (type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text in WRITER_HELPER_TYPES) {
      return WRITER_HELPER_TYPES[type.typeName.text];
    }
    return undefined;
  };
  for (let changed = true; changed;) {
    changed = false;
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name && node.name.text in WRITER_HELPERS && !names.has(node.name.text)) {
        names.set(node.name.text, node.name.text);
        changed = true;
      }
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name) && !names.has(node.name.text)) {
        const helper = bindingHelper(node);
        if (helper) { names.set(node.name.text, helper); changed = true; }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  const calls: WriterHelperCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) && helperModule(arg.text)) unresolved(node, "dynamic import");
    }
    if (ts.isIdentifier(node) && (names.has(node.text) || namespaces.has(node.text))) {
      const parent = node.parent;
      const isName = (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isMethodDeclaration(parent) && parent.name === node) ||
        (ts.isPropertyDeclaration(parent) && parent.name === node) ||
        (ts.isPropertySignature(parent) && parent.name === node) ||
        ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) ||
        ts.isTypeQueryNode(parent) || ts.isQualifiedName(parent) ||
        (ts.isFunctionDeclaration(parent) && parent.name === node) ||
        ((ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.name === node);
      if (!isName) {
        let reference: ts.Node = node;
        while (ts.isParenthesizedExpression(reference.parent) || ts.isAsExpression(reference.parent) ||
          ts.isNonNullExpression(reference.parent) || ts.isTypeAssertionExpression(reference.parent) ||
          ts.isSatisfiesExpression(reference.parent)) reference = reference.parent;
        const holder = reference.parent;
        if (namespaces.has(node.text)) {
          // Only `ns.<member>`: a helper member must be called or aliased below.
          if (!(ts.isPropertyAccessExpression(holder) && holder.expression === reference)) unresolved(node, "namespace use");
          const member = (holder as ts.PropertyAccessExpression).name.text;
          if (member in WRITER_HELPERS) {
            let use: ts.Node = holder;
            while (ts.isParenthesizedExpression(use.parent) || ts.isAsExpression(use.parent) || ts.isNonNullExpression(use.parent)) use = use.parent;
            const isCall = ts.isCallExpression(use.parent) && use.parent.expression === use;
            const isAlias = (ts.isVariableDeclaration(use.parent) || ts.isParameter(use.parent)) && use.parent.initializer === use &&
              ts.isIdentifier(use.parent.name) && names.has(use.parent.name.text);
            if (isCall) {
              const call = use.parent as ts.CallExpression;
              calls.push({ helper: member, callee: holder.getText(ast), line: ast.getLineAndCharacterOfPosition(call.getStart(ast)).line + 1, call });
            } else if (!isAlias) unresolved(node, "namespace member use");
          }
        } else {
          const isCall = ts.isCallExpression(holder) && holder.expression === reference;
          const isAlias = (ts.isVariableDeclaration(holder) || ts.isParameter(holder)) && holder.initializer === reference &&
            ts.isIdentifier(holder.name) && names.has(holder.name.text);
          if (isCall) {
            calls.push({ helper: names.get(node.text)!, callee: node.text, line: ast.getLineAndCharacterOfPosition(holder.getStart(ast)).line + 1, call: holder as ts.CallExpression });
          } else if (!isAlias) {
            unresolved(node, "reference");
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return calls;
}

export function rawTableWriteSites(file: string, source: string, tableName: string): TableWriteSite[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const handles: ts.Node[] = [];
  const writes: ts.CallExpression[] = [];
  const member = (node: ts.Node): string | undefined => {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression)) return node.argumentExpression.text;
  };
  // Resolve local namespace aliases too (`const db = databases.flair`). Names
  // may have multiple bindings: union them conservatively rather than silently
  // overlooking a write because a same-named binding shadows another scope.
  const bindings = new Map<string, ts.Node[]>();
  const collect = (node: ts.Node) => {
    if ((ts.isVariableDeclaration(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name)) {
      bindings.set(node.name.text, [...(bindings.get(node.name.text) ?? []), node]);
    }
    ts.forEachChild(node, collect);
  };
  collect(ast);
  const paths = (node: ts.Node, seen = new Set<ts.Node>()): string[][] => {
    if (seen.has(node)) return [];
    const next = new Set(seen).add(node);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) return paths(node.expression, next);
    if (ts.isVariableDeclaration(node)) return node.initializer ? paths(node.initializer, next) : [];
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const declaration = node.parent.parent;
      const name = node.propertyName ?? node.name;
      if (ts.isVariableDeclaration(declaration) && declaration.initializer && (ts.isIdentifier(name) || ts.isStringLiteral(name))) {
        return paths(declaration.initializer, next).map(path => [...path, name.text]);
      }
    }
    if (ts.isIdentifier(node)) return [[node.text], ...(bindings.get(node.text) ?? []).flatMap(binding => paths(binding, next))];
    const name = member(node);
    if (name && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) return paths(node.expression, next).map(path => [...path, name]);
    return [];
  };
  const isTable = (node: ts.Node): boolean =>
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isBindingElement(node)) &&
    paths(node).some(path => path.slice(-2).join(".") === `flair.${tableName}` || path.join(".") === `tables.${tableName}`);
  // Writer-helper calls through any alias count as writes (writerHelperCalls
  // throws on a reference it cannot follow). The call's own text is the key.
  const helperCalls = new Set<ts.Node>(writerHelperCalls(file, source).map((c) => c.call));
  const visit = (node: ts.Node) => {
    if (isTable(node)) handles.push(node);
    if (ts.isCallExpression(node)) {
      const name = member(node.expression) ?? (ts.isIdentifier(node.expression) ? node.expression.text : "");
      const helperCall = [...helperCalls].some((call) => call.pos === node.pos && call.end === node.end);
      if (helperCall || ["create", "post", "put", "patch", "delete", "update", "patchRecord", "patchRecordSilent", "writeBackCommittedRow"].includes(name)) writes.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!handles.length) return [];
  const result: TableWriteSite[] = [];
  const counts = new Map<string, number>();
  const add = (node: ts.Node, kind: TableWriteSite["kind"], expression: string) => {
    const base = `${file}:${kind}:${expression}`;
    const occurrence = (counts.get(base) ?? 0) + 1;
    counts.set(base, occurrence);
    result.push({ key: `${base}#${occurrence}`, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, kind, expression });
  };
  for (const handle of handles) {
    // A direct method call is covered by its writer (or is only a read).
    const parent = handle.parent;
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && ts.isCallExpression(parent.parent) && parent.parent.expression === parent) continue;
    add(handle, "alias-source", handle.getText(ast).replace(/\s+/g, " "));
  }
  for (const write of writes) add(write, "writer", write.expression.getText(ast).replace(/\s+/g, " "));
  return result;
}
