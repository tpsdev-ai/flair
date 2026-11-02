// A docs-freshness fixture must copy the gate and every module it imports
// (flair#2905: a hand-written copy list omitted a new import and 60 doc-link
// tests failed with "Cannot find module").
//
// This test holds the derived set closed: every relative import in every file
// the set copies must itself be in the set, so a module the walk misses is a
// failure here rather than in each fixture that copies the gate.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { docsFreshnessScriptFiles } from "../helpers/docs-freshness-scripts.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPTS = join(REPO_ROOT, "scripts");

/** Independent of the helper's parser: every relative specifier in a static import. */
function relativeImportTargets(source: string): string[] {
  const fromClauses = [...source.matchAll(/\bfrom\s+["'](\.\.?\/[^"']+)["']/g)];
  const bareImports = [...source.matchAll(/^[ \t]*import\s+["'](\.\.?\/[^"']+)["']/gm)];
  return [...fromClauses, ...bareImports].map((match) => match[1]);
}

describe("docs-freshness fixture scripts", () => {
  test("the copied set closes over every relative import", () => {
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
