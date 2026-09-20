/**
 * upgrade-plain-tree-ci-lane.test.ts — flair#1109 (a) Cos fixture
 *
 * The product tarball-swap lane shipped in #1564. What main still lacks is a
 * CI spoke-ritual lane (non-launchd, non-global-npm) that runs
 * `flair upgrade --check --tree` against a packed extract + systemd unit,
 * the way `scripts/ci/macos-launchd-upgrade-lane.sh` exercises launchd.
 *
 * Fails-first: on origin/main this script is absent, so this file fails.
 * On this branch the script exists and the spoke-ritual contract holds.
 * Does not change #1560 warning wording.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "ci", "plain-tree-upgrade-lane.sh");

describe("plain-tree upgrade CI lane (flair#1109 a)", () => {
  test("fails-first: scripts/ci/plain-tree-upgrade-lane.sh is present", () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  test("spoke-ritual --check takes the tarball-swap lane (packed extract + unit)", () => {
    const home = mkdtempSync(join(tmpdir(), "flair-plain-tree-ci-home-"));
    mkdirSync(join(home, ".config"), { recursive: true });
    try {
      const r = spawnSync("bash", [SCRIPT], {
        encoding: "utf8",
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          HOME: home,
          FLAIR_PLAIN_TREE_LANE_HOME: home,
        },
      });
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      expect(r.status).toBe(0);
      expect(out).toContain("PASS: plain-tree upgrade lane");
      expect(out).toContain("in-place tarball swap");
      expect(out).toContain("preserve launcher/overlay: flair");
      expect(out).toContain("restart unit: flair.service (user:");
      expect(out).not.toContain("no systemd unit found");
      expect(out).not.toContain("`flair upgrade` only upgrades the npm-global packages");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
