// Unit-file discovery must accept the names Bun's test runner discovers, and
// refuse the ones it does not (flair#2288).
//
// Bun's runner "recursively searches the working directory for files that match
// the following patterns" — `*.test.<ext>`, `*_test.<ext>`, `*.spec.<ext>`,
// `*_spec.<ext>` for `<ext>` in js, jsx, ts, tsx, mjs, cjs, mts, cts
// (https://bun.sh/docs/test). This compares the shared predicate, and the disk
// discovery built on it, with what the real Bun binary runs on a scratch tree
// that holds every suffix/extension pair the predicate accepts, a few case
// variants, and a set of rejected names.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { isUnitTestFile, testFiles } from "../../scripts/ci/test-files.mjs";

const SUFFIXES = [".test", "_test", ".spec", "_spec"];
const EXTENSIONS = ["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"];

/** Every suffix/extension pair Bun discovers, plus case variants — Bun matches case-insensitively. */
const ACCEPTED = [
  ...SUFFIXES.flatMap(suffix => EXTENSIONS.map(extension => `sample${suffix}.${extension}`)),
  "upper.TEST.ts", "title.Spec.tsx", "ext.test.TS", "ext.spec.MJS",
];

/** Names Bun's runner does not discover. */
const REJECTED = [
  "sample.js", "sample.ts", "sample.tsx", "sample.mjs",
  "sample-test.ts", "test-sample.ts", "sample_test.py", "sample.spec.py",
  "sample.test", "sample.spec", "sample.test.md", "sample.spec.json",
  "sample.speck.ts", "sample.testy.ts", "sample.test.ts.bak",
];

const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A scratch root whose `names/` holds `names`, each a test that logs its own name. */
function scratchTree(names: string[]): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flair-bun-names-")));
  fixtures.push(root);
  const dir = join(root, "names");
  mkdirSync(dir);
  for (const name of names) {
    writeFileSync(join(dir, name),
      `import { appendFileSync } from "node:fs";\n` +
      `import { test } from "bun:test";\n` +
      `test(${JSON.stringify(name)}, () => appendFileSync(process.env.BUN_NAMES_LOG, ${JSON.stringify(`${name}\n`)}));\n`);
  }
  return root;
}

/** The names the real Bun binary discovers and runs under `names/`. */
function bunDiscovered(root: string): string[] {
  const log = join(root, "ran.log");
  writeFileSync(log, "");
  const result = spawnSync(process.execPath, ["test", "./names/"], {
    cwd: root, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, BUN_NAMES_LOG: log },
  });
  expect(result.status).toBe(0);
  return [...new Set(readFileSync(log, "utf8").split("\n").filter(Boolean))].sort();
}

describe("unit-file discovery names (flair#2288)", () => {
  test("the predicate accepts the accepted names and rejects the rejected ones", () => {
    expect([...ACCEPTED, ...REJECTED].filter(isUnitTestFile).sort()).toEqual([...ACCEPTED].sort());
  });

  test("matches Bun's own discovery, on disk and by predicate", () => {
    const root = scratchTree([...ACCEPTED, ...REJECTED]);
    const ran = bunDiscovered(root);
    expect(ran).toEqual([...ACCEPTED].sort());
    expect([...ACCEPTED, ...REJECTED].filter(isUnitTestFile).sort()).toEqual(ran);
    expect(testFiles(join(root, "names")).map(file => basename(file)).sort()).toEqual(ran);
  });
});
