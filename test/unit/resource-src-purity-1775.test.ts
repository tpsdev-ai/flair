import { expect, test } from "bun:test";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { unitPlan } from "../../scripts/test-unit.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import {
  STRUCTURAL_PAIRS,
  structuralImbalance,
} from "../../src/rem/promote-policy.ts";

const root = realpathSync(join(import.meta.dir, "../.."));
const dist = join(root, "dist");
function staticDependencies(file: string): string[] {
  const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  return ast.statements.flatMap(s =>
    (ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) &&
    s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier) ? [s.moduleSpecifier.text] : []);
}

// Inspect emitted JavaScript, including loads nested inside function bodies.
// A computed argument still constitutes a dependency: never discard the call
// just because its module name cannot be resolved statically.
function allModuleLoads(file: string, topLevelResolutionsOnly = false): string[] {
  const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const loads: string[] = [];
  const requireNames = new Set(["require"]);
  let functionDepth = 0;
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
      ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "createRequire") requireNames.add(node.name.text);
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      loads.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && requireNames.has(node.expression.text)) ||
        (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "resolve" &&
          (!topLevelResolutionsOnly || functionDepth === 0)))
    ) {
      const specifier = node.arguments[0];
      loads.push(
        specifier !== undefined && ts.isStringLiteralLike(specifier)
          ? specifier.text
          : node.getText(ast),
      );
    }
    if (ts.isFunctionLike(node)) functionDepth++;
    ts.forEachChild(node, visit);
    if (ts.isFunctionLike(node)) functionDepth--;
  }
  visit(ast);
  return loads;
}

test("src excludes harper imports and top-level resolution", () => {
  const violations: string[] = [];
  for (const source of new Bun.Glob("src/**/*.{ts,tsx,js,mjs,cjs}").scanSync({ cwd: root })) {
    for (const spec of allModuleLoads(join(root, source), true)) {
      if (spec === "harper" || spec.startsWith("harper/")) violations.push(`${source}: ${spec}`);
    }
  }
  expect(violations).toEqual([]);
});

test("the shared unit lane emits server modules before checking the boundary", () => {
  const plan = unitPlan(root);
  const emit = plan.findIndex(s => s.name === "emit server for boundary guard");
  expect(emit).toBeGreaterThanOrEqual(0);
  expect(emit).toBeLessThan(plan.findIndex(s => s.shard !== undefined));
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
    expect(allModuleLoads(target), relative(root, target)).toEqual([]);
  }
});

// These are emitted-JavaScript fixtures. They are parsed, never executed.
const loadCases: Array<{ name: string; source: string; expected: string[] }> = [
  {
    name: "static import",
    source: 'import { readFileSync } from "node:fs";',
    expected: ["node:fs"],
  },
  {
    name: "side-effect import",
    source: 'import "node:fs";',
    expected: ["node:fs"],
  },
  {
    name: "named re-export",
    source: 'export { readFileSync } from "node:fs";',
    expected: ["node:fs"],
  },
  {
    name: "star re-export",
    source: 'export * from "node:fs";',
    expected: ["node:fs"],
  },
  {
    name: "nested import()",
    source: 'export function load() { return import("node:fs"); }',
    expected: ["node:fs"],
  },
  {
    name: "nested require()",
    source: 'export function load() { return require("node:fs"); }',
    expected: ["node:fs"],
  },
  {
    name: "require.resolve()",
    source: 'const dependency = require.resolve("harper");',
    expected: ["harper"],
  },
  {
    name: "createRequire alias",
    source: 'const load = createRequire(import.meta.url); load("harper");',
    expected: ["harper"],
  },
  {
    name: "computed import()",
    source: "export function load(name) { return import(name); }",
    expected: ["import(name)"],
  },
  {
    name: "computed require()",
    source: "export function load(name) { return require(name); }",
    expected: ["require(name)"],
  },
  {
    name: "nested loads inside arguments",
    source: 'export function load() { return require(import("node:fs")); }',
    expected: ['require(import("node:fs"))', "node:fs"],
  },
];

function compiledFixture(source: string): string {
  const scratch = realpathSync(tempDir("flair-resource-purity-"));
  const file = join(scratch, "helper.js");
  writeFileSync(file, source, "utf8");
  return file;
}

for (const row of loadCases) {
  test("allModuleLoads detects " + row.name, () => {
    expect(allModuleLoads(compiledFixture(row.source))).toEqual(row.expected);
  });
}

test("allModuleLoads ignores comments, strings and local exports", () => {
  const source = [
    '// import("node:fs"); require("node:fs");',
    'const text = \'import("node:fs"); require("node:fs");\';',
    "export { text };",
    "export function pure(value) { return value + 1; }",
  ].join("\n");
  expect(allModuleLoads(compiledFixture(source))).toEqual([]);
});

test("coverage comment distinguishes bracket pairs from backticks", () => {
  const comment = readFileSync(join(root, "resources/auto-promote-lib.ts"), "utf8");
  expect(comment).toContain(
    "// including its full-width/CJK pairs; unlisted bracket pairs are not checked.",
  );
  expect(STRUCTURAL_PAIRS.flat()).not.toContain("\u0060");
  expect(structuralImbalance("an open \u0060 span")).toBe("unbalanced backtick");
  expect(structuralImbalance("a closed \u0060span\u0060")).toBeNull();
});
