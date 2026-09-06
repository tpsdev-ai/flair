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
  const visit = (node: ts.Node) => {
    if (isTable(node)) handles.push(node);
    if (ts.isCallExpression(node)) {
      const name = member(node.expression) ?? (ts.isIdentifier(node.expression) ? node.expression.text : "");
      if (["post", "put", "patch", "delete", "update", "patchRecord", "patchRecordSilent"].includes(name)) writes.push(node);
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
