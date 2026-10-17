/**
 * flair#1856 — the post-publish canary must run with NO repository dependencies.
 *
 * The 0.55.2 canary died before it measured anything:
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'semver' imported from
 *   scripts/ci/registry-tarball-sha256.mjs
 *   hashed 0/9 lockstep tarballs — refusing to promote a partial set
 *
 * The canary job (`.github/workflows/canary.yml`) runs on a clean,
 * credential-less runner that NEVER installs this repo's dependencies, so any
 * bare package specifier in a script it runs is a hard crash at module load.
 *
 * This is the CLASS guard, not a check of that one file. It walks every script
 * the canary runs — `node scripts/...` invocations in the workflow, the
 * `scripts/ci/*.sh` helpers the workflow calls, and the node scripts those shell
 * scripts invoke — follows relative imports transitively, and asserts every
 * import specifier is a `node:` builtin or a relative path.
 *
 * A bare specifier anywhere in that closure is a dependency the canary cannot
 * resolve. Adding `import x from "semver"` to any canary script turns this red.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Closure, canaryScriptClosure } from "../helpers/canary-script-closure";

const REPO_ROOT = join(import.meta.dir, "..", "..");

test.each(["node -e 'require(\"semver\")'", "node --eval 'require(\"semver\")'", "node -p 'require(\"semver\")'", "node - <<'JS'\nrequire(\"semver\")\nJS", "node -pe '21+21'", "node -- <<'JS'\n21+21\nJS", "node <<'JS'\n21+21\nJS", "echo 21 | node", "node<<'JS'\n21\nJS", "node --require ./x.js scripts/ci/lockstep-packages.mjs"])("rejects inline Node in a shell fixture: %s", (inline: string) => {
  const shell = "scripts/ci/check-instance-boot.sh";
  const fixture = readFileSync(join(REPO_ROOT, shell), "utf8") + "\n" + inline + "\n";
  expect(() => canaryScriptClosure({ [shell]: fixture })).toThrow("inline Node body");
});

test("a sibling shell script called through $SCRIPT_DIR is walked and guarded", () => {
  const helper = "scripts/ci/doctor-advisory.sh";
  const fixture = readFileSync(join(REPO_ROOT, helper), "utf8") + "\nnode -e 'require(\"semver\")'\n";
  expect(() => canaryScriptClosure({ [helper]: fixture })).toThrow("inline Node body in " + helper);
});

test("a command continued across lines is scanned as one command", () => {
  const shell = "scripts/ci/check-instance-boot.sh";
  const fixture = readFileSync(join(REPO_ROOT, shell), "utf8") + "\nnode \\\n  -p '6*7'\n";
  expect(() => canaryScriptClosure({ [shell]: fixture })).toThrow("inline Node body");
});

test("a walked module that does not exist fails the walk", () => {
  const shell = "scripts/ci/check-instance-boot.sh";
  const fixture = readFileSync(join(REPO_ROOT, shell), "utf8") + "\nnode scripts/ci/does-not-exist-1859.mjs\n";
  expect(() => canaryScriptClosure({ [shell]: fixture })).toThrow("walked module missing");
});

describe("post-publish canary scripts are dependency-free (flair#1856)", () => {
  // Built in a hook, not at describe time: a throw here must FAIL these tests, not drop them.
  let closure: Closure;
  beforeAll(() => {
    closure = canaryScriptClosure();
  });

  test("the walk reached the canary's scripts (positive control)", () => {
    // A zero-length closure would make the assertion below vacuously true — the
    // exact failure mode (a check that scans nothing and reports green).
    expect(closure.modules.length).toBeGreaterThanOrEqual(5);
    expect(closure.modules).toContain("scripts/ci/registry-tarball-sha256.mjs");
    expect(closure.modules).toContain("scripts/ci/boot-probe.mjs");
    expect(closure.shellScripts).toContain("scripts/ci/check-instance-boot.sh");
    expect(closure.shellScripts).toContain("scripts/ci/canary-verdict.sh");
    expect(closure.shellScripts).toContain("scripts/ci/doctor-advisory.sh");
    // ...and it actually parsed imports out of them, rather than reading files
    // whose specifiers the regex never saw.
    expect(closure.specifierCount).toBeGreaterThan(10);
  });

  test("every import in the closure is a node: builtin or a relative path", () => {
    const rendered = closure.bare.map((b) => `${b.file} imports "${b.spec}"`);
    expect(rendered).toEqual([]);
  });
});
