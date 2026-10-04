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
 * preflight, move one `dist-tag` per package (flair last), and keep no
 * per-package sha tests. Since round 4 the block moves the tags in a LOOP over
 * `_LPKGS`, so the test runs that loop against a stub `npm` and counts the adds,
 * rather than grepping for text the block no longer emits.
 * Darwin-gated (`test.skipIf(!isDarwin)`) so the Linux unit lane reports it as
 * skipped and the Darwin-gated unit-tests lane runs it on macOS.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

/**
 * Run the block's per-package move LOOP (section 3) under DARWIN_BASH with a stub
 * `npm` on PATH, and return the `dist-tag add` invocations it actually made.
 * The loop is taken verbatim from the emitted block, so this observes the real
 * shipped text, not a paraphrase of it.
 */
function runMoveLoop(block: string) {
  const lines = block.split("\n");
  const start = lines.findIndex((l) => l.startsWith("_LPKGS="));
  expect(start, "the block must set _LPKGS for the move loop").toBeGreaterThanOrEqual(0);
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === "done") {
      end = i;
      break;
    }
  }
  expect(end, "the move loop must close with a top-level `done`").toBeGreaterThan(start);
  const loop = lines.slice(start, end + 1).join("\n");

  const dir = mkdtempSync(join(tmpdir(), "darwin-moveloop-"));
  try {
    const shim = join(dir, "shim");
    mkdirSync(shim, { recursive: true });
    const dt = join(dir, "disttag.log");
    writeFileSync(dt, "");
    writeFileSync(
      join(shim, "npm"),
      [
        "#!/usr/bin/env bash",
        'if [ "${1:-}" = "dist-tag" ] && [ "${2:-}" = "add" ]; then',
        '  printf "dist-tag add %s\\n" "${3:-}" >> "${DISTTAG_LOG:-/dev/null}"',
        "  exit 0",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(join(shim, "npm"), 0o755);

    const prev = join(dir, "prev");
    const moved = join(dir, "moved");
    // Seed every package's PREVIOUS latest so the loop's `grep` finds one.
    writeFileSync(prev, PACKAGES.map((p) => `${p}=1.2.2`).join("\n") + "\n");
    writeFileSync(moved, "");
    const harness = join(dir, "harness.sh");
    writeFileSync(harness, ["set -e", `PREV_LATEST=${prev}`, `MOVED=${moved}`, loop, ""].join("\n"));

    const r = spawnSync(DARWIN_BASH, [harness], {
      cwd: REPO,
      encoding: "utf8",
      env: { ...process.env, PATH: `${shim}:${process.env.PATH}`, DISTTAG_LOG: dt },
    });
    expect(r.status, `loop stderr:\n${r.stderr}`).toBe(0);
    return readFileSync(dt, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("dist-tag add "));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

    const m = r.stdout.match(/```\n([\s\S]*?)\n```/);
    expect(m?.[1], "the PASS output must contain a fenced block").toBeDefined();
    const block = m![1]!;
    // The loop iterates the lockstep set in order — flair LAST (the CLI must not
    // move ahead of its client library).
    const lpkgs = block
      .split("\n")
      .find((l) => l.startsWith("_LPKGS="))
      ?.replace(/^_LPKGS="|"$/g, "")
      .split(/\s+/);
    expect(lpkgs).toEqual(PACKAGES);
    expect(lpkgs?.[lpkgs.length - 1]).toBe("@tpsdev-ai/flair");

    // And the loop ACTUALLY makes one `dist-tag add` per package, flair last.
    const adds = runMoveLoop(block);
    expect(adds.length).toBe(PACKAGES.length);
    expect(adds[adds.length - 1]).toBe("dist-tag add @tpsdev-ai/flair@1.2.3");
    expect(adds.map((l) => l.replace(/^dist-tag add /, "").replace(/@1\.2\.3$/, ""))).toEqual(PACKAGES);
  });

  test.skipIf(!isDarwin)("emits a non-empty FAIL block (one deprecate line per package)", () => {
    const r = runDarwinBash(["fail", "1.2.3", RUN_URL, "--os", "macos-latest"]);
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
    expect((r.stdout.match(/^npm deprecate /gm) ?? []).length).toBe(PACKAGES.length);
  });
});
