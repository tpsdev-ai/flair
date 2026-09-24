/**
 * canary-verdict-darwin.test.ts — flair#1781 R0, flair#1671 (slice A1c).
 *
 * The canary runs on `macos-latest`, whose `/bin/bash` is 3.2. `canary-verdict.sh`
 * must therefore be bash-3.2-safe: a bash-4 feature (`declare -A`, `mapfile`)
 * dies with "declare: -A: invalid option", writes 0 bytes, and the one artifact
 * the flow exists to emit is empty.
 *
 * A1c rebinds the PASS block to a single package-set-digest preflight. This
 * exercises that block under stock `/bin/bash 3.2`: it must emit the digest
 * preflight, one dist-tag per package (flair last), and no per-package sha tests.
 * Darwin-gated (`test.skipIf(!isDarwin)`) so the Linux unit lane reports it as
 * skipped and the Darwin-gated unit-tests lane runs it on macOS.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { lockstepPackages } from "../../scripts/ci/lockstep-packages.mjs";

const REPO = join(import.meta.dir, "../..");
const SCRIPT = join(REPO, "scripts", "ci", "canary-verdict.sh");
// macOS ships bash 3.2 at /bin/bash; the point is to exercise THAT, not any
// Homebrew bash the runner might also have.
const DARWIN_BASH = "/bin/bash";
const RUN_URL = "https://github.com/tpsdev-ai/flair/actions/runs/42";
const PACKAGES = lockstepPackages();
const CERTIFIED_DIGEST = createHash("sha256").update("darwin-certified").digest("hex");
const isDarwin = process.platform === "darwin";

function runDarwinBash(args: string[]) {
  return spawnSync(DARWIN_BASH, [SCRIPT, ...args], { cwd: REPO, encoding: "utf8" });
}

describe("canary-verdict under macOS /bin/bash 3.2 (flair#1781 R0 / A1c)", () => {
  test.skipIf(!isDarwin)("emits a non-empty PASS block (single digest preflight, one dist-tag per package, flair last)", () => {
    const r = runDarwinBash(["pass", "1.2.3", RUN_URL, "--os", "macos-latest", "--package-set-digest", CERTIFIED_DIGEST]);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout.length).toBeGreaterThan(0);
    const lines = r.stdout.split("\n");
    // A1c: no per-package sha tests remain; the preflight is the single digest check.
    const oldPerPkgTests = lines.filter((l) => l.startsWith('test "$(node scripts/ci/registry-tarball-sha256.mjs'));
    expect(oldPerPkgTests).toEqual([]);
    const digestChecks = lines.filter((l) => l.includes('if [ "$_rehash" != "'));
    expect(digestChecks.length).toBe(1);
    expect(r.stdout).toContain("package-set-digest.mjs");
    const promote = lines.filter((l) => l.startsWith("npm dist-tag add "));
    expect(promote.length).toBe(PACKAGES.length);
    expect(promote[promote.length - 1]).toContain("npm dist-tag add @tpsdev-ai/flair@1.2.3 latest");
   });

  test.skipIf(!isDarwin)("emits a non-empty FAIL block (one deprecate line per package)", () => {
    const r = runDarwinBash(["fail", "1.2.3", RUN_URL, "--os", "macos-latest"]);
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
    expect((r.stdout.match(/^npm deprecate /gm) ?? []).length).toBe(PACKAGES.length);
   });
});
