// A docs-freshness fixture must copy the gate and every module it imports
// (flair#2905: a hand-written copy list omitted a new import and 60 doc-link
// tests failed with "Cannot find module").
//
// This test holds the derived set closed: every relative import in every file
// the set copies must itself be in the set, so a module the walk misses is a
// failure here rather than in each fixture that copies the gate.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { docsFreshnessScriptFiles } from "../helpers/docs-freshness-scripts.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPTS = join(REPO_ROOT, "scripts");

/** Independent of the helper's parser: every `from "./..."` literal in the text. */
function relativeImportTargets(source: string): string[] {
  return [...source.matchAll(/\bfrom\s+["'](\.\.?\/[^"']+)["']/g)].map((match) => match[1]);
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
});
