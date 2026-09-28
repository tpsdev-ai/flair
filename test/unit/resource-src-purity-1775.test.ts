import { expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { unitPlan } from "../../scripts/test-unit.ts";

const root = realpathSync(join(import.meta.dir, "../.."));
const dist = join(root, "dist");
function staticDependencies(file: string): string[] {
  const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  return ast.statements.flatMap(s =>
    (ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) &&
    s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier) ? [s.moduleSpecifier.text] : []);
}

test("the shared unit lane emits server modules before checking the boundary", () => {
  const plan = unitPlan(root);
  const emit = plan.findIndex(s => s.name === "emit server for boundary guard");
  expect(emit).toBeGreaterThanOrEqual(0);
  expect(emit).toBeLessThan(plan.findIndex(s => s.name === "root unit tests"));
  expect(plan[emit]!.args).toEqual(["x", "tsc", "-p", "tsconfig.json", "--noCheck"]);
});

test("static resource imports reach dependency-free compiled helpers", () => {
  const targets = new Set<string>();
  for (const source of new Bun.Glob("resources/**/*.ts").scanSync({ cwd: root })) {
    if (source.endsWith(".d.ts")) continue;
    // Missing output is a failed prerequisite, never a skipped check.
    const compiled = join(dist, source.replace(/\.ts$/, ".js"));
    for (const spec of staticDependencies(compiled)) {
      if (!spec.startsWith(".")) continue;
      const target = resolve(dirname(compiled), spec);
      if (target.startsWith(join(dist, "src") + sep)) targets.add(target);
    }
  }
  expect([...targets]).toContain(join(dist, "src/rem/promote-policy.js"));
  for (const target of targets) {
    expect(staticDependencies(target), relative(root, target)).toEqual([]);
  }
});
