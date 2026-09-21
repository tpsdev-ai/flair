/**
 * canary-verdict.test.ts — flair#1686, flair#1781.
 *
 * `scripts/ci/canary-verdict.sh` is the single definition of what the
 * post-publish canary tells a human to do. The PASS output must carry ONE
 * sha256-bound promote line per lockstep package, each guarded by `test` (so a
 * wrong sha aborts before `latest` moves) and ordered so `@tpsdev-ai/flair` is
 * LAST; the FAIL output must carry one deprecate line per package. These are
 * exact-text assertions on purpose: the commands the operator pastes are the
 * contract, and they must not drift silently.
 *
 * No network and no npm: the script only formats the commands. The lockstep set
 * is derived (scripts/ci/lockstep-packages.mjs) — the same source the script
 * reads, so the count here is not a hard-coded number.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { lockstepPackages } from "../../scripts/ci/lockstep-packages.mjs";

const REPO = join(import.meta.dir, "../..");
const SCRIPT = join(REPO, "scripts", "ci", "canary-verdict.sh");
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

// Nothing to clean up (the script is pure), but keep the afterEach slot so a
// future temp-file addition has an obvious home.
afterEach(() => {});

describe("canary-verdict — PASS is lockstep", () => {
  test("emits one sha256-bound promote line per package, in order, flair LAST", () => {
    const r = run(["pass", "1.2.3", RUN_URL, "--os", "ubuntu-latest", ...bindings()]);
    expect(r.status).toBe(0);
    const promote = r.stdout.split("\n").filter((l) => l.startsWith("test "));
    expect(promote.length).toBe(PACKAGES.length);

    for (let i = 0; i < PACKAGES.length; i++) {
      const pkg = PACKAGES[i]!;
      expect(promote[i]).toContain(`node scripts/ci/registry-tarball-sha256.mjs 1.2.3 ${pkg}`);
      expect(promote[i]).toContain(`= "${shaFor(pkg)}"`);
      expect(promote[i]).toContain(`npm dist-tag add ${pkg}@1.2.3 latest`);
    }
    // The CLI is promoted last, so a partial paste never leads with the CLI.
    expect(promote[promote.length - 1]).toContain("npm dist-tag add @tpsdev-ai/flair@1.2.3 latest");
    // The sha guard and the tag move are joined by `&&`, so a failed check
    // short-circuits the promote rather than running it anyway.
    expect(promote[0]).toContain(`= "${shaFor(PACKAGES[0]!)}" && npm dist-tag`);
    // Regression guard: npm's `dist.shasum` is a SHA-1, so comparing it to a
    // sha256 can never match. The guard must hash the published tarball.
    expect(r.stdout).not.toContain("dist.shasum");
    // The skew check is the documented last step.
    expect(r.stdout).toContain("node scripts/ci/registry-latest-skew.mjs 1.2.3");
  });

  test("names the runner OS in the heading", () => {
    const r = run(["pass", "1.2.3", RUN_URL, "--os", "macos-latest", ...bindings()]);
    expect(r.stdout).toContain("`macos-latest`");
  });
});

describe("canary-verdict — FAIL is lockstep", () => {
  test("emits one deprecate line per package, flair LAST", () => {
    const r = run(["fail", "1.2.3", RUN_URL, "--os", "ubuntu-latest", ...bindings()]);
    expect(r.status).toBe(0);
    const deprecate = r.stdout.split("\n").filter((l) => l.startsWith("npm deprecate "));
    expect(deprecate.length).toBe(PACKAGES.length);
    for (let i = 0; i < PACKAGES.length; i++) {
      expect(deprecate[i]).toContain(`npm deprecate ${PACKAGES[i]}@1.2.3 "failed post-publish canary: ${RUN_URL}"`);
    }
    expect(deprecate[deprecate.length - 1]).toContain("@tpsdev-ai/flair@1.2.3");
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
    // private/unpublished packages are excluded
    expect(PACKAGES).not.toContain("@tpsdev-ai/flair-tool-descriptors");
    // deterministic
    expect(lockstepPackages()).toEqual(PACKAGES);
  });

  test("matches exactly what release-publish.yml stages (no drift between the two)", () => {
    const yml = readFileSync(join(REPO, ".github", "workflows", "release-publish.yml"), "utf8");
    const dirsBlock = yml.match(/DIRS=\(\s*([\s\S]*?)\)/)?.[1] ?? "";
    const dirs = dirsBlock.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(dirs).toContain("."); // the root package
    // flair-bench stages in its own step (history in the workflow comment).
    dirs.push("packages/flair-bench");
    const staged = dirs.map((d) => {
      const p = d === "." ? join(REPO, "package.json") : join(REPO, d, "package.json");
      return JSON.parse(readFileSync(p, "utf8")).name as string;
    });
    expect([...new Set(staged)].sort()).toEqual([...PACKAGES].sort());
  });
});
