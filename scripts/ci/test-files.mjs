import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The predicate for "is a unit test file" that the unit lane's discovery and
 * its coverage gate share (flair#2288): a name ending in one of Bun's four
 * test suffixes followed by one of the extensions Bun transpiles.
 *
 * Bun's runner "recursively searches the working directory for files that match
 * the following patterns" — `*.test.<ext>`, `*_test.<ext>`, `*.spec.<ext>`,
 * `*_spec.<ext>` for `<ext>` in js, jsx, ts, tsx, mjs, cjs, mts, cts
 * (https://bun.sh/docs/test). Bun 1.3.10 matches case-insensitively: it runs
 * `upper.TEST.ts` and `ext.spec.MJS`.
 */
const UNIT_TEST_FILE = /(?:\.test|_test|\.spec|_spec)\.(?:[cm]?[jt]s|[jt]sx)$/i;

/** Whether `name` is a file Bun's test runner discovers. */
export function isUnitTestFile(name) {
  return UNIT_TEST_FILE.test(name);
}

export function testFiles(dir, recursive = true) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return recursive ? testFiles(path) : [];
    return isUnitTestFile(entry.name) ? [path] : [];
  }).sort();
}
