/**
 * canary-verdict.test.ts — flair#1686.
 *
 * `scripts/ci/canary-verdict.sh` is the single definition of what the
 * post-publish canary tells a human to do. The PASS line must carry the
 * sha256-bound promote command guarded by `test` (so a wrong sha aborts before
 * `latest` moves); the FAIL line must carry the deprecate command. These are
 * exact-text assertions on purpose: the command the operator pastes is the
 * contract, and it must not drift silently.
 *
 * No network and no npm: the script only formats the command.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../..");
const SCRIPT = join(REPO, "scripts", "ci", "canary-verdict.sh");
const SHA = "a".repeat(64);
const RUN_URL = "https://github.com/tpsdev-ai/flair/actions/runs/42";

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

// Nothing to clean up (the script is pure), but keep the afterEach slot so a
// future temp-file addition has an obvious home.
afterEach(() => {});

describe("canary-verdict — PASS", () => {
  test("emits the sha256-bound promote line behind a `test` guard", () => {
    const r = run(["pass", "1.2.3", SHA, RUN_URL, "ubuntu-latest"]);
    expect(r.status).toBe(0);
    const promote = r.stdout.split("\n").find((l) => l.startsWith("test "));
    expect(promote).toBeDefined();
    expect(promote).toContain("node scripts/ci/registry-tarball-sha256.mjs 1.2.3");
    expect(promote).toContain(SHA);
    expect(promote).toContain("npm dist-tag add @tpsdev-ai/flair@1.2.3 latest");
    // The guard and the tag move are joined by `&&`, so a failed sha check
    // short-circuits the promote rather than running it anyway.
    expect(promote).toContain(`= "${SHA}" && npm dist-tag`);
    // Regression guard: npm's `dist.shasum` is a SHA-1, so comparing it to a
    // sha256 can never match. The guard must hash the published tarball.
    expect(promote).not.toContain("dist.shasum");
  });

  test("names the runner OS in the heading", () => {
    const r = run(["pass", "1.2.3", SHA, RUN_URL, "macos-latest"]);
    expect(r.stdout).toContain("`macos-latest`");
  });
});

describe("canary-verdict — FAIL", () => {
  test("emits the deprecate line carrying the run URL", () => {
    const r = run(["fail", "1.2.3", SHA, RUN_URL, "ubuntu-latest"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      `npm deprecate @tpsdev-ai/flair@1.2.3 "failed post-publish canary: ${RUN_URL}"`,
    );
    expect(r.stdout).toContain("Re-cut the next patch");
  });
});

describe("canary-verdict — usage", () => {
  test("rejects an unknown verdict", () => {
    const r = run(["maybe", "1.2.3", SHA]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage:");
  });

  test("requires a version", () => {
    const r = run(["pass"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("version is required");
  });
});
