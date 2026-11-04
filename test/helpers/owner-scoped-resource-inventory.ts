/**
 * owner-scoped-resource-inventory.ts — which resource classes extend which
 * flair table, read from the resource sources by parsing each class's
 * `extends` clause with the TypeScript compiler API. It is the structural
 * cross-check in the owner-scoped write matrix; that matrix's primary coverage
 * gate is the OWNER_FIELDS list itself, which needs no parsing.
 *
 * Recognised, and nothing else: a class whose `extends` expression is
 *   - after removing parentheses, `as`/`<T>`/`satisfies` assertions and
 *     non-null assertions, a member access whose last step names T (`.T` or
 *     `["T"]`) and whose receiver chain has a `flair` step — for example
 *     `(databases as any).flair.T`, `databases.flair.T`, `databases.flair["T"]`;
 *     or
 *   - an identifier bound by a top-level `const`/`let`/`var` declaration in the
 *     same file to such an expression, directly or through other such
 *     identifiers (`const A = databases.flair.T; const B = A; class X extends B`).
 * Not recognised: a base imported from another module, returned by a call, or
 * built by a mixin.
 *
 * The inventory also lists every class NAMED after an owner-scoped table that
 * does not extend that table (a custom route at `/<T>`).
 */
import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ResourceClass {
  file: string;
  className: string;
  /** The flair table the class extends, or null when it extends something else. */
  table: string | null;
}

/** Strip parentheses, type assertions and non-null assertions from an expression. */
function unwrap(expr: ts.Expression): ts.Expression {
  let e: ts.Expression = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(e)) e = e.expression;
    else if (ts.isAsExpression(e)) e = e.expression;
    else if (ts.isTypeAssertionExpression(e)) e = e.expression;
    else if (ts.isNonNullExpression(e)) e = e.expression;
    else if (ts.isSatisfiesExpression(e)) e = e.expression;
    else return e;
  }
}

/** The member name of a property or string-literal element access, else null. */
function memberName(e: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) return e.argumentExpression.text;
  return null;
}

function receiver(e: ts.Expression): ts.Expression | null {
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) return e.expression;
  return null;
}

/** The table T when `expr` is `<...>.flair.T` (any spelling), else null. */
export function flairTableOf(expr: ts.Expression): string | null {
  const e = unwrap(expr);
  const table = memberName(e);
  if (table === null) return null;
  let r = receiver(e);
  while (r) {
    const u = unwrap(r);
    if (memberName(u) === "flair") return table;
    r = receiver(u);
  }
  return null;
}

/** Inventory every class declaration in one source text. */
export function classesInSource(file: string, source: string): ResourceClass[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // Top-level same-file bindings: `const A = <...>.flair.T` and `const B = A`.
  const initializers = new Map<string, ts.Expression>();
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer) initializers.set(d.name.text, d.initializer);
    }
  }
  const aliasTable = (name: string, seen = new Set<string>()): string | null => {
    if (seen.has(name)) return null;
    seen.add(name);
    const init = initializers.get(name);
    if (!init) return null;
    const direct = flairTableOf(init);
    if (direct) return direct;
    const u = unwrap(init);
    return ts.isIdentifier(u) ? aliasTable(u.text, seen) : null;
  };
  const out: ResourceClass[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name) {
      let table: string | null = null;
      for (const clause of node.heritageClauses ?? []) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        for (const t of clause.types) {
          const base = unwrap(t.expression);
          table = flairTableOf(base) ?? (ts.isIdentifier(base) ? aliasTable(base.text) : null);
        }
      }
      out.push({ file, className: node.name.text, table });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Inventory every class in every `*.ts` file directly under `resourcesDir`. */
export function resourceClasses(resourcesDir: string): ResourceClass[] {
  return readdirSync(resourcesDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .flatMap((f) => classesInSource(f, readFileSync(join(resourcesDir, f), "utf8")));
}

export interface OwnerScopedInventory {
  /** Owner-scoped tables served by at least one class that extends the table. */
  tableExtending: string[];
  /** Classes named after an owner-scoped table that do not extend that table. */
  customRoutes: ResourceClass[];
}

export function ownerScopedInventory(classes: ResourceClass[], ownerTables: readonly string[]): OwnerScopedInventory {
  const owned = new Set(ownerTables);
  const tableExtending = [...new Set(classes.filter((c) => c.table !== null && owned.has(c.table)).map((c) => c.table as string))].sort();
  const customRoutes = classes.filter((c) => owned.has(c.className) && c.table !== c.className);
  return { tableExtending, customRoutes };
}
