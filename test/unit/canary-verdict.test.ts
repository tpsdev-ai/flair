/**
 * canary-verdict.test.ts — flair#1686, flair#1781.
 *
 * `scripts/ci/canary-verdict.sh` is the single definition of what the
 * post-publish canary tells a human to do. The PASS block is LOCKSTEP and
 * TWO-PHASE: it verifies EVERY package's published-tarball sha256 FIRST (so a
 * mid-paste failure touches no tag), then moves the tags (`@tpsdev-ai/flair`
 * LAST), then checks the set converged. The FAIL block carries one `npm
 * deprecate` line per package, the CLI first.
 *
 * No network and no npm: the script only formats the commands. The lockstep set
 * is derived (scripts/ci/lockstep-packages.mjs) — the same source the script
 * reads, so the count here is not a hard-coded number.
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

/** A distinct, valid 64-hex sha per package, so a mis-bound line is detectable. */
function shaFor(pkg: string): string {
  return createHash("sha256").update(`sha:${pkg}`).digest("hex");
}
function bindings(): string[] {
  return PACKAGES.map((p) => `${p}=${shaFor(p)}`);
}

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("canary-verdict — PASS is lockstep AND two-phase", () => {
  test("verifies every sha BEFORE moving any tag; promotes flair LAST", () => {
    const r = run(["pass", "1.2.3", RUN_URL, "--os", "ubuntu-latest", ...bindings()]);
    expect(r.status).toBe(0);
    const lines = r.stdout.split("\n");
    const verify = lines.map((l, i) => ({ l, i })).filter((x) => x.l.startsWith("test "));
    const promote = lines.map((l, i) => ({ l, i })).filter((x) => x.l.startsWith("npm dist-tag add "));

    expect(verify.length).toBe(PACKAGES.length);
    expect(promote.length).toBe(PACKAGES.length);
    for (let i = 0; i < PACKAGES.length; i++) {
      const pkg = PACKAGES[i]!;
      expect(verify[i]!.l).toContain(`node scripts/ci/registry-tarball-sha256.mjs 1.2.3 ${pkg}`);
      expect(verify[i]!.l).toContain(`= "${shaFor(pkg)}"`);
      expect(promote[i]!.l).toContain(`npm dist-tag add ${pkg}@1.2.3 latest`);
    }
    // The CLI is promoted last, so a partial paste never leads with the CLI.
    expect(promote[promote.length - 1]!.l).toContain("npm dist-tag add @tpsdev-ai/flair@1.2.3 latest");

    // TWO PHASES: every `test` line comes before the first `npm dist-tag add`
    // — a mid-paste sha failure aborts before any tag moves.
    const lastVerify = Math.max(...verify.map((x) => x.i));
    const firstPromote = Math.min(...promote.map((x) => x.i));
    expect(lastVerify).toBeLessThan(firstPromote);

    // One snippet pasted once, then the convergence check.
    expect(r.stdout).toContain("set -e");
    expect(r.stdout).toContain("node scripts/ci/registry-latest-skew.mjs 1.2.3");
    // Regression guard: npm's `dist.shasum` is a SHA-1, so comparing it to a
    // sha256 can never match. The guard must hash the published tarball.
    expect(r.stdout).not.toContain("dist.shasum");
  });

  test("names the runner OS in the heading", () => {
    const r = run(["pass", "1.2.3", RUN_URL, "--os", "macos-latest", ...bindings()]);
    expect(r.stdout).toContain("`macos-latest`");
  });
});

describe("canary-verdict — FAIL is lockstep", () => {
  test("emits one deprecate line per package, the CLI FIRST", () => {
    const r = run(["fail", "1.2.3", RUN_URL, "--os", "ubuntu-latest", ...bindings()]);
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

describe("canary-verdict — refuses a partial or malformed promote", () => {
  test("a missing sha256 for ANY package => DID NOT RUN, no promote lines", () => {
    const partial = bindings().filter((b) => !b.startsWith("@tpsdev-ai/flair-mcp="));
    const r = run(["pass", "1.2.3", RUN_URL, "--os", "ubuntu-latest", ...partial]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("DID NOT RUN");
    expect(r.stderr).toContain("@tpsdev-ai/flair-mcp");
    expect(r.stdout).not.toContain("npm dist-tag add");
  });

  test("a duplicate binding for a package is rejected by name (flair#1781 R7)", () => {
    const r = run(["pass", "1.2.3", RUN_URL, ...bindings(), `@tpsdev-ai/flair=${shaFor("dup")}`]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("duplicate sha256 binding");
    expect(r.stderr).toContain("@tpsdev-ai/flair");
    expect(r.stdout).not.toContain("npm dist-tag add");
  });

  test("a binding for an unknown package => DID NOT RUN", () => {
    const r = run(["pass", "1.2.3", RUN_URL, ...bindings(), `@tpsdev-ai/not-a-package=${shaFor("x")}`]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown package");
  });

  test("a non-hex sha256 => DID NOT RUN", () => {
    const bad = bindings();
    bad[0] = `${bad[0]!.split("=")[0]}=not-a-sha`;
    const r = run(["pass", "1.2.3", RUN_URL, ...bad]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("64-char hex");
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
