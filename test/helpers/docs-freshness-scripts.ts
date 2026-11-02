/**
 * The scripts/ files a docs-freshness fixture has to copy.
 *
 * The gate runs as a subprocess against a throwaway package, so the fixture
 * needs scripts/docs-freshness-check.mjs and every module it reaches through a
 * relative import, transitively. A hand-written list of names goes stale as
 * soon as the gate imports one more module, so the set is derived from the
 * gate's own import statements.
 *
 * Copy-ready names are relative to scripts/ and sorted for a stable order. A
 * file that cannot be read, or a walk past MAX_FILES, throws: a short set would
 * make a fixture fail for a missing file instead of exercising the gate.
 */

import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const ENTRY = "docs-freshness-check.mjs";
const MAX_FILES = 200;

/** `import ... from "./x.mjs"` and `export ... from "./x.mjs"`, however wrapped. */
const RELATIVE_IMPORT = /^[ \t]*(?:import|export)\b[^;]*?\bfrom\s*["'](\.\.?\/[^"']+)["']/gm;

export function docsFreshnessScriptFiles(repoRoot: string = REPO_ROOT): string[] {
  const scripts = join(repoRoot, "scripts");
  const seen = new Set<string>();
  const queue = [ENTRY];
  while (queue.length > 0) {
    const name = queue.shift();
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    if (seen.size > MAX_FILES) {
      throw new Error(`docsFreshnessScriptFiles: more than ${MAX_FILES} script files reachable from ${ENTRY}`);
    }
    const source = readFileSync(join(scripts, name), "utf8");
    for (const match of source.matchAll(RELATIVE_IMPORT)) {
      queue.push(relative(scripts, resolve(scripts, dirname(name), match[1])));
    }
  }
  return [...seen].sort();
}
