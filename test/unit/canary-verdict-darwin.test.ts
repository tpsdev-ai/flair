/**
 * canary-verdict-darwin.test.ts — flair#1781 R0.
 *
 * The canary runs on `macos-latest`, whose `/bin/bash` is 3.2. `canary-verdict.sh`
 * must therefore be bash-3.2-safe: a bash-4 feature (`declare -A`, `mapfile`)
 * dies with "declare: -A: invalid option", writes 0 bytes, and the one artifact
 * the flow exists to emit is empty.
 *
 * This runs the script under `/bin/bash` on macOS and asserts the PASS and FAIL
 * blocks are non-empty and carry one line per lockstep package. Darwin-gated
 * (`test.skipIf(!isDarwin)`) so the Linux unit lane reports it as skipped and the
 * Darwin-gated unit-tests lane runs it on macOS.
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
const isDarwin = process.platform === "darwin";

function shaFor(pkg: string): string {
  return createHash("sha256").update(`sha:${pkg}`).digest("hex");
}
function bindings(): string[] {
  return PACKAGES.map((p) => `${p}=${shaFor(p)}`);
}
function runDarwinBash(args: string[]) {
  return spawnSync(DARWIN_BASH, [SCRIPT, ...args], { cwd: REPO, encoding: "utf8" });
}

describe("canary-verdict under macOS /bin/bash 3.2 (flair#1781 R0)", () => {
  test.skipIf(!isDarwin)("emits a non-empty PASS block (one line per package, flair last)", () => {
    const r = runDarwinBash(["pass", "1.2.3", RUN_URL, "--os", "macos-latest", ...bindings()]);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout.length).toBeGreaterThan(0);
    const verify = r.stdout.match(/^test /gm) ?? [];
    const promote = r.stdout.match(/^npm dist-tag add /gm) ?? [];
    expect(verify.length).toBe(PACKAGES.length);
    expect(promote.length).toBe(PACKAGES.length);
    const promoteLines = r.stdout.split("\n").filter((l) => l.startsWith("npm dist-tag add "));
    expect(promoteLines[promoteLines.length - 1]).toContain("npm dist-tag add @tpsdev-ai/flair@1.2.3 latest");
  });

  test.skipIf(!isDarwin)("emits a non-empty FAIL block (one deprecate line per package)", () => {
    const r = runDarwinBash(["fail", "1.2.3", RUN_URL, "--os", "macos-latest"]);
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
    expect((r.stdout.match(/^npm deprecate /gm) ?? []).length).toBe(PACKAGES.length);
  });
});
