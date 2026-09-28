/**
 * flair#1757 — migration baselines skip deprecated npm versions.
 *
 * Version order alone installed 0.54.1 (deprecated: the global install omits
 * fs-extra) and the lane died later with `Cannot find module 'fs-extra'`.
 * The helper must pick the previous non-deprecated version. "Skipped" means
 * passed over: a deprecated version newer than the chosen baseline. An older
 * deprecation (0.52.0, when the baseline is 0.54.0) is not a skip.
 *
 * stderr when a baseline is chosen: those skip lines, then `baseline <version>`.
 * stderr when every candidate is deprecated: `no baseline`, not a chosen
 * baseline line.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tempDir } from "../helpers/temp-dir.ts";
import {
  NO_BASELINE,
  collectCandidateRecords,
  formatSelection,
  parseDeprecatedField,
  parseNpmVersions,
  selectMigrationBaseline,
} from "../../scripts/ci/select-migration-baseline.mjs";

const REPO = join(import.meta.dir, "../..");
const SCRIPT = join(REPO, "scripts/ci/select-migration-baseline.mjs");
const MIGRATION_YML = readFileSync(join(REPO, ".github/workflows/migration-ci-lanes.yml"), "utf8");
const TEST_YML = readFileSync(join(REPO, ".github/workflows/test.yml"), "utf8");

const BROKEN_0541 =
  "Broken publish: the global install omits Harper's transitive dependencies (fs-extra is missing), so flair init fails on first run. Use 0.54.2 or later.";

/** Newest version below 0.54.2 is deprecated. The previous release is not. */
const NEWEST_LOWER_DEPRECATED = [
  { version: "0.52.0", deprecated: "ancient yank" },
  { version: "0.53.0" },
  { version: "0.54.0" },
  { version: "0.54.1", deprecated: BROKEN_0541 },
  { version: "0.54.2" },
  { version: "0.55.0" },
  { version: "0.54.3-rc.1" },
];

/** Every strict version below HEAD carries a deprecation. */
const ALL_DEPRECATED = [
  { version: "0.53.0", deprecated: "rolled back" },
  { version: "0.54.1", deprecated: "Broken publish: fs-extra is missing" },
  { version: "0.54.2" },
];

function runHelper(args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("selectMigrationBaseline (flair#1757)", () => {
  test("a deprecated newest-lower version yields the previous non-deprecated one", () => {
    const selected = selectMigrationBaseline(NEWEST_LOWER_DEPRECATED, "0.54.2");
    expect(selected.status).toBe("ok");
    expect(selected.baseline).toBe("0.54.0");
    expect(selected.skipped.map((skip) => skip.version)).toEqual(["0.54.1"]);
    expect(selected.skipped[0]?.reason).toBe(BROKEN_0541);
  });

  test("numeric order wins over lexicographic order", () => {
    const selected = selectMigrationBaseline(
      [{ version: "0.9.0" }, { version: "0.10.0" }],
      "0.11.0",
    );
    expect(selected.baseline).toBe("0.10.0");
  });

  test("an empty deprecation string is still usable", () => {
    const selected = selectMigrationBaseline(
      [{ version: "0.54.0" }, { version: "0.54.1", deprecated: "   " }],
      "0.54.2",
    );
    expect(selected.baseline).toBe("0.54.1");
    expect(selected.skipped).toEqual([]);
  });

  test("the all-deprecated fixture reports no baseline by name", () => {
    const selected = selectMigrationBaseline(ALL_DEPRECATED, "0.54.2");
    expect(selected.status).toBe(NO_BASELINE);
    expect(NO_BASELINE).toBe("no baseline");
    expect(selected.baseline).toBeNull();
    expect(selected.message.startsWith("no baseline")).toBe(true);
    expect(selected.message).not.toMatch(/^baseline /);
    expect(selected.message).toContain("0.54.1");
    expect(selected.message).toContain("Broken publish: fs-extra is missing");
    expect(selected.skipped.map((skip) => skip.version)).toEqual(["0.54.1", "0.53.0"]);
    const log = formatSelection(selected).join("\n");
    expect(log).toContain("no baseline:");
    expect(log).not.toMatch(/^baseline /m);
  });

  test("the selection log names only deprecations newer than the chosen baseline", () => {
    const selected = selectMigrationBaseline(NEWEST_LOWER_DEPRECATED, "0.54.2");
    const log = formatSelection(selected).join("\n");
    expect(log).toContain(`skipped deprecated 0.54.1: ${BROKEN_0541}`);
    expect(log).not.toContain("0.52.0");
    expect(log).not.toContain("ancient yank");
    expect(log).toContain("baseline 0.54.0 (newest non-deprecated version < 0.54.2)");
  });

  test("deprecated fields are read newest-first and the walk stops at the first usable version", () => {
    const seen: string[] = [];
    const records = collectCandidateRecords(
      ["0.52.0", "0.54.1", "0.53.0", "0.54.2", "0.55.0-rc.1"],
      "0.54.2",
      (version) => {
        seen.push(version);
        return version === "0.54.1" ? BROKEN_0541 : null;
      },
    );
    expect(seen).toEqual(["0.54.1", "0.53.0"]);
    const selected = selectMigrationBaseline(records, "0.54.2");
    expect(selected.baseline).toBe("0.53.0");
    expect(selected.skipped.map((skip) => skip.version)).toEqual(["0.54.1"]);
  });

  test("npm's single-version JSON string is still a version list", () => {
    expect(parseNpmVersions('"0.2.0"\n')).toEqual(["0.2.0"]);
    expect(parseNpmVersions('["0.53.0","0.54.1"]')).toEqual(["0.53.0", "0.54.1"]);
  });

  test("an absent deprecated field is not a deprecation", () => {
    expect(parseDeprecatedField("")).toBeNull();
    expect(parseDeprecatedField(`"${BROKEN_0541}"\n`)).toBe(BROKEN_0541);
  });
});

describe("select-migration-baseline CLI", () => {
  test("a fixture whose newest lower version is deprecated prints the previous one", () => {
    const dir = tempDir("baseline-fixture");
    const fixture = join(dir, "versions.json");
    writeFileSync(fixture, JSON.stringify(NEWEST_LOWER_DEPRECATED));
    const result = runHelper(["--fixture", fixture, "0.54.2"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("0.54.0\n");
    expect(result.stderr).toContain(`skipped deprecated 0.54.1: ${BROKEN_0541}`);
    expect(result.stderr).not.toContain("0.52.0");
    expect(result.stderr).not.toContain("ancient yank");
    expect(result.stderr).toContain("baseline 0.54.0 (newest non-deprecated version < 0.54.2)");
  });

  test("the all-deprecated fixture prints no baseline, not a chosen baseline", () => {
    const dir = tempDir("baseline-none");
    const fixture = join(dir, "versions.json");
    writeFileSync(fixture, JSON.stringify(ALL_DEPRECATED));
    const result = runHelper(["--fixture", fixture, "0.54.2"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("::error::no baseline:");
    expect(result.stderr).not.toMatch(/^baseline /m);
    expect(result.stderr).toContain("skipped deprecated 0.54.1: Broken publish: fs-extra is missing");
    expect(result.stderr).toContain("skipped deprecated 0.53.0: rolled back");
  });
});

describe("migration lanes call the helper (flair#1757)", () => {
  const lanes = [
    { name: "migration-ci-lanes.yml", text: MIGRATION_YML },
    { name: "test.yml", text: TEST_YML },
  ];

  for (const lane of lanes) {
    test(`${lane.name} derives its baseline with select-migration-baseline.mjs`, () => {
      const invocations = lane.text.match(
        /node "\$GITHUB_WORKSPACE\/scripts\/ci\/select-migration-baseline\.mjs" "\$HEAD_VERSION"/g,
      );
      expect(invocations?.length).toBe(1);
      expect(lane.text).not.toContain("older.sort");
      expect(lane.text).not.toContain("PUBLISHED_VERSIONS");
      expect(lane.text).not.toContain("--fixture");
    });
  }

  test("the downgrade lane still prints the chosen baseline", () => {
    expect(MIGRATION_YML).toContain(
      'echo "Baseline derivation: newest non-deprecated npm version < ${HEAD_VERSION} = ${BASELINE_VERSION}"',
    );
    expect(MIGRATION_YML).toContain(
      'echo "Baseline (previously published): ${BASELINE_VERSION} — HEAD (PR build): ${HEAD_VERSION}"',
    );
  });

  test("the launchd lane still prints the chosen baseline", () => {
    expect(TEST_YML).toContain(
      'echo "Baseline (newest non-deprecated npm version < ${HEAD_VERSION}): ${BASELINE_VERSION}"',
    );
    expect(TEST_YML).toContain('echo "baseline_version=$BASELINE_VERSION" >> "$GITHUB_OUTPUT"');
  });

  test("the launchd changed-files gate reruns when the helper changes", () => {
    expect(TEST_YML).toContain("scripts/ci/select-migration-baseline\\.mjs");
  });
});
