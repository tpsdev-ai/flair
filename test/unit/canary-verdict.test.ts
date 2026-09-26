/**
 * canary-verdict.test.ts — flair#1686, flair#1781, flair#1671 (slice A1c).
 *
 * `scripts/ci/canary-verdict.sh` is the single definition of what the post-publish
 * canary tells a human to do. A1c rebinds the PASS block from "one sha256 test
 * per package" to a SINGLE package-set-digest preflight: the emitted block
 * re-derives the canonical package-set digest (the one the release run's pack job
 * certified) from the published tarballs at paste time and requires it to equal the
 * certified digest before any tag can move.
 *
 * Prereleases are never promoted: a SemVer prerelease version's PASS prints a
 * one-line note (no dist-tag lines at all), while a release without a prerelease
 * label still prints the digest-bound promote block.
 *
 * The FAIL block carries one `npm deprecate` line per package, the CLI first —
 * unchanged by A1c.
 *
 * No network and no npm: the script only formats the commands. The lockstep set is
 * DERIVED (scripts/ci/lockstep-packages.mjs) — the same source the script reads, so
 * the count here is not a hard-coded number.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { lockstepPackages } from "../../scripts/ci/lockstep-packages.mjs";

const REPO = join(import.meta.dir, "../..");
const SCRIPT = join(REPO, "scripts", "ci", "canary-verdict.sh");
const LOCKSTEP_SCRIPT = join(REPO, "scripts", "ci", "lockstep-packages.mjs");
const RUN_URL = "https://github.com/tpsdev-ai/flair/actions/runs/42";
const PACKAGES = lockstepPackages();
/** The certified package-set digest a PASS is bound to (any 64-hex is fine; the
    script embeds it literally and re-tests the re-derived digest against it). */
const CERTIFIED_DIGEST = createHash("sha256").update("certified-package-set").digest("hex");

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Extract the fenced ``` ... ``` promote block from a PASS verdict. */
function fencedBlock(stdout: string): string {
  const m = stdout.match(/```\n([\s\S]*?)\n```/);
  if (!m?.[1]) throw new Error("no fenced promote block in the PASS output");
  return m[1]!;
}

describe("canary-verdict — PASS is bound to ONE package-set digest (A1c, #1671)", () => {
  test("emits a single digest preflight, one dist-tag per package (flair last), no per-package sha tests", () => {
    const r = run(["pass", "1.2.3", RUN_URL, "--os", "ubuntu-latest", "--package-set-digest", CERTIFIED_DIGEST]);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    const block = fencedBlock(r.stdout);
    const blockLines = block.split("\n");

    // (b) The old form was one `test "$(node scripts/ci/registry-tarball-sha256.mjs
    // <version> <pkg> ...)" = "<sha>"` line per package. That is GONE: the only
    // comparison is the single package-set digest.
    const oldPerPkgTests = blockLines.filter((l) => l.startsWith('test "$(node scripts/ci/registry-tarball-sha256.mjs'));
    expect(oldPerPkgTests).toEqual([]);

    // The single, digest-bound preflight: exactly one comparison of the re-derived
    // digest against the certified one, and it re-derives via package-set-digest.mjs.
    const digestChecks = blockLines.filter((l) => l.includes('if [ "$_rehash" != "'));
    expect(digestChecks.length).toBe(1);
    expect(digestChecks[0]!).toContain(CERTIFIED_DIGEST);
    expect(block).toContain("node scripts/ci/package-set-digest.mjs");
    expect(block).toContain(`--version 1.2.3`);

    // One dist-tag per lockstep package, `@tpsdev-ai/flair` LAST (partial paste
    // never leaves the CLI ahead of its client library).
    const promote = blockLines.filter((l) => l.startsWith("npm dist-tag add "));
    expect(promote.length).toBe(PACKAGES.length);
    for (const pkg of PACKAGES) {
      expect(promote.some((l) => l === `npm dist-tag add ${pkg}@1.2.3 latest`)).toBe(true);
    }
    expect(promote[promote.length - 1]!).toContain("npm dist-tag add @tpsdev-ai/flair@1.2.3 latest");

    // TWO PHASES: the (single) digest preflight comes before the first dist-tag —
    // a mid-paste mismatch (or an unmeasurable re-hash) aborts before any tag moves.
    const firstDigest = blockLines.findIndex((l) => l.includes('if [ "$_rehash" != "'));
    const firstPromote = blockLines.findIndex((l) => l.startsWith("npm dist-tag add "));
    expect(firstDigest).toBeGreaterThanOrEqual(0);
    expect(firstDigest).toBeLessThan(firstPromote);

    // One snippet pasted once, then the convergence check.
    expect(block).toContain("set -e");
    expect(block).toContain("node scripts/ci/registry-latest-skew.mjs 1.2.3");
    // Regression guard: npm's `dist.shasum` is a SHA-1, so comparing it to a sha256
    // can never match. The guard must hash the published tarball.
    expect(r.stdout).not.toContain("dist.shasum");
  });

  test("names the runner OS in the heading", () => {
    const r = run(["pass", "1.2.3", RUN_URL, "--os", "macos-latest", "--package-set-digest", CERTIFIED_DIGEST]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("`macos-latest`");
  });

  test("the certified digest is embedded as a literal the operator can read", () => {
    const r = run(["pass", "1.2.3", RUN_URL, "--package-set-digest", CERTIFIED_DIGEST]);
    expect(r.stdout).toContain(CERTIFIED_DIGEST);
  });
});

describe("canary-verdict — a SemVer prerelease is never promoted (A1c, #1671)", () => {
  test("(a) a prerelease PASS prints NO dist-tag line and a note", () => {
    const r = run(["pass", "0.55.2-rc.1", RUN_URL, "--os", "ubuntu-latest", "--package-set-digest", CERTIFIED_DIGEST]);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    // No promote block at all — not even the digest preflight.
    expect(r.stdout).not.toContain("npm dist-tag add");
    expect(r.stdout).not.toContain("dist-tag add");
    expect(r.stdout).not.toContain(CERTIFIED_DIGEST);
    // Note that prereleases live on next and are never promoted.
    expect(r.stdout.toLowerCase()).toContain("prerelease");
    expect(r.stdout.toLowerCase()).toContain("next");
    expect(r.stdout.toLowerCase()).toContain("never");
  });

  test("F2: only an exact <major>.<minor>.<patch> is promoted; every other label prints the note, no dist-tag", () => {
    // A whitelist (F2 of #1671, A1c): is_release matches ONLY <major>.<minor>.<patch>.
    // A blacklist (matching a -<prerelease> part) misses 1.2.3-- (whose first - is a valid
    // SemVer prerelease token) and build metadata (1.2.3+build) — both would wrongly promote.
    const rel = run(["pass", "1.2.3", RUN_URL, "--os", "ubuntu-latest", "--package-set-digest", CERTIFIED_DIGEST]);
    expect(rel.status).toBe(0);
    expect(rel.stderr).toBe("");
    expect(rel.stdout).toContain("npm dist-tag add @tpsdev-ai/flair@1.2.3 latest");
    // Everything that is NOT an exact <major>.<minor>.<patch> prints the note and NO dist-tag line.
    const nonReleases = ["1.2.3-rc.1", "1.2.3-0", "1.2.3--", "1.2.3+build", "totally-not-a-version"];
    for (const v of nonReleases) {
      const r = run(["pass", v, RUN_URL, "--os", "ubuntu-latest", "--package-set-digest", CERTIFIED_DIGEST]);
      expect(r.status, `status for ${v}`).toBe(0);
      expect(r.stderr, `stderr for ${v}`).toBe("");
      expect(r.stdout, `stdout for ${v}`).not.toContain("npm dist-tag add");
      expect(r.stdout, `dist-tag for ${v}`).not.toContain("dist-tag add");
      expect(r.stdout.toLowerCase(), `prerelease for ${v}`).toContain("prerelease");
      expect(r.stdout.toLowerCase(), `next for ${v}`).toContain("next");
      expect(r.stdout.toLowerCase(), `never for ${v}`).toContain("never");
    }
  });

  test("a prerelease FAIL still deprecates (the FAIL path is unchanged)", () => {
    const r = run(["fail", "0.55.1-rc.1", RUN_URL, "--os", "ubuntu-latest"]);
    expect(r.status).toBe(0);
    const deprecate = r.stdout.split("\n").filter((l) => l.startsWith("npm deprecate "));
    expect(deprecate.length).toBe(PACKAGES.length);
    expect(deprecate[0]).toContain("npm deprecate @tpsdev-ai/flair@0.55.1-rc.1 ");
    expect(r.stdout).toContain("Re-cut the next patch");
  });
});

describe("canary-verdict — FAIL is lockstep", () => {
  test("emits one deprecate line per package, the CLI FIRST", () => {
    const r = run(["fail", "1.2.3", RUN_URL, "--os", "ubuntu-latest"]);
    expect(r.status).toBe(0);
    const deprecate = r.stdout.split("\n").filter((l) => l.startsWith("npm deprecate "));
    expect(deprecate.length).toBe(PACKAGES.length);
    // flair#1781 R6: the CLI is the likeliest install target, so it is warned first.
    expect(deprecate[0]).toContain("npm deprecate @tpsdev-ai/flair@1.2.3 ");
    for (const pkg of PACKAGES) {
      expect(deprecate.some((l) => l.includes(`npm deprecate ${pkg}@1.2.3 "`))).toBe(true);
    }
    expect(r.stdout).toContain("Re-cut the next patch");
  });
});

describe("canary-verdict — refuses a malformed promote", () => {
  test("a missing --package-set-digest => DID NOT RUN, no promote lines", () => {
    const r = run(["pass", "1.2.3", RUN_URL, "--os", "ubuntu-latest"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("DID NOT RUN");
    expect(r.stderr).toContain("package-set-digest");
    expect(r.stdout).not.toContain("npm dist-tag add");
  });

  test("a non-hex --package-set-digest => DID NOT RUN (still the 64-hex guard)", () => {
    const r = run(["pass", "1.2.3", RUN_URL, "--os", "ubuntu-latest", "--package-set-digest", "not-a-sha"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("64-char hex");
    expect(r.stdout).not.toContain("npm dist-tag add");
  });

  test("a 40-hex (SHA-1) digest => DID NOT RUN", () => {
    const r = run(["pass", "1.2.3", RUN_URL, "--os", "ubuntu-latest", "--package-set-digest", "0123456789abcdef0123456789abcdef01234567"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("64-char hex");
    expect(r.stdout).not.toContain("npm dist-tag add");
  });
});

describe("canary-verdict — usage", () => {
  test("rejects an unknown verdict", () => {
    const r = run(["maybe", "1.2.3", RUN_URL]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage:");
  });

  test("requires a version", () => {
    const r = run(["pass"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("version is required");
  });

  test("rejects an unexpected argument", () => {
    const r = run(["pass", "1.2.3", RUN_URL, "surprise"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unexpected argument");
  });
});

describe("lockstep-packages — the ONE source for the release set", () => {
  test("derives the published lockstep set with @tpsdev-ai/flair LAST", () => {
    expect(PACKAGES.length).toBeGreaterThan(1);
    expect(PACKAGES[PACKAGES.length - 1]).toBe("@tpsdev-ai/flair");
    expect(PACKAGES).not.toContain("@tpsdev-ai/flair-tool-descriptors");
    expect(lockstepPackages()).toEqual(PACKAGES);
  });

  /** A fixture repo root with a copy of the script, so ROOT resolves there. */
  function fixtureRoot(manifests: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "flair-1781-manifest-"));
    tmpDirs.push(root);
    mkdirSync(join(root, "scripts", "ci"), { recursive: true });
    copyFileSync(LOCKSTEP_SCRIPT, join(root, "scripts", "ci", "lockstep-packages.mjs"));
    for (const [rel, body] of Object.entries(manifests)) {
      const p = join(root, rel);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, body);
    }
    return root;
  }
  function runLockstep(root: string) {
    return spawnSync(process.execPath, [join(root, "scripts", "ci", "lockstep-packages.mjs")], { encoding: "utf8" });
  }

  test("an existing-but-malformed manifest is FATAL — no partial list (flair#1781 R2)", () => {
    const root = fixtureRoot({
      "package.json": JSON.stringify({ name: "@tpsdev-ai/flair", version: "0.0.0" }),
      "packages/good/package.json": JSON.stringify({ name: "@tpsdev-ai/good", version: "0.0.0" }),
      "packages/bad/package.json": "{ this is not json",
    });
    const r = runLockstep(root);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("DID NOT RUN");
    expect(r.stderr).toContain("bad");
    expect(r.stdout).not.toContain("@tpsdev-ai/good");
  });

  test("a directory with no package.json is skipped, not fatal (flair#1781 R2)", () => {
    const root = fixtureRoot({
      "package.json": JSON.stringify({ name: "@tpsdev-ai/flair", version: "0.0.0" }),
      "packages/good/package.json": JSON.stringify({ name: "@tpsdev-ai/good", version: "0.0.0" }),
      "packages/empty/.keep": "",
    });
    const r = runLockstep(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("@tpsdev-ai/good");
    expect(r.stdout.trim().split("\n")).toEqual(["@tpsdev-ai/good", "@tpsdev-ai/flair"]);
  });
});
