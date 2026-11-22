// A docs-freshness fixture copies the gate and its relative import literals.
// Each scanned target must belong to the copied set.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { docsFreshnessScriptFiles } from "../helpers/docs-freshness-scripts.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPTS = join(REPO_ROOT, "scripts");

/** Independent scanner for relative import literals. */
function relativeImportTargets(source: string): string[] {
  const fromClauses = [...source.matchAll(/\bfrom\s+["'](\.\.?\/[^"']+)["']/g)];
  const bareImports = [...source.matchAll(/^[ \t]*import\s+["'](\.\.?\/[^"']+)["']/gm)];
  const dynamicImports = [...source.matchAll(/\bimport\s*\(\s*["'](\.\.?\/[^"']+)["']\s*\)/g)];
  return [...fromClauses, ...bareImports, ...dynamicImports].map((match) => match[1]);
}

describe("docs-freshness fixture scripts", () => {
  test("the copied set closes over relative import literals", () => {
    const files = docsFreshnessScriptFiles(REPO_ROOT);
    expect(files).toContain("docs-freshness-check.mjs");

    let scanned = 0;
    for (const file of files) {
      const source = readFileSync(join(SCRIPTS, file), "utf8");
      for (const spec of relativeImportTargets(source)) {
        scanned += 1;
        const target = relative(SCRIPTS, resolve(SCRIPTS, dirname(file), spec));
        expect(files).toContain(target);
      }
    }
    // Canary: the gate has relative imports, so a scanner matching nothing
    // cannot report this set as closed.
    expect(scanned).toBeGreaterThan(0);
  });

  test.each(['"./dynamic.mjs"', "'../dynamic.mjs'"])("scanners follow literal import(%s)", (specifier) => {
    const dir = tempDir("docs-freshness-dynamic-");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    const source = `const loaded = import(${specifier});\n`;
    writeFileSync(join(dir, "scripts", "docs-freshness-check.mjs"), source);
    const target = specifier.slice(1, -1);
    writeFileSync(resolve(dir, "scripts", target), "export {};\n");
    expect(relativeImportTargets(source)).toEqual([target]);
    expect(docsFreshnessScriptFiles(dir)).toEqual([
      relative(join(dir, "scripts"), resolve(dir, "scripts", target)),
      "docs-freshness-check.mjs",
    ].sort());
  });

  test("follows from clauses, side-effect imports and indirect hops", () => {
    const dir = tempDir("docs-freshness-scripts-");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    const write = (name: string, body: string): void => {
      writeFileSync(join(dir, "scripts", name), body);
    };
    write("docs-freshness-check.mjs", 'import "./side.mjs";\nimport { a } from "./a.mjs";\n');
    write("a.mjs", 'export { b } from "./b.mjs";\n');
    write("b.mjs", 'import { c } from "./c.mjs";\n');
    write("c.mjs", "export const c = 1;\n");
    write("side.mjs", "export {};\n");

    expect(docsFreshnessScriptFiles(dir)).toEqual([
      "a.mjs",
      "b.mjs",
      "c.mjs",
      "docs-freshness-check.mjs",
      "side.mjs",
    ]);
  });
});
