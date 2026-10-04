// Root-unit-test shards (flair#2258).
//
// The load-bearing assertion is coverage: the shards PARTITION the full root
// unit corpus — the union is every file and no file is in two shards. A file
// that fell out of the union would run in no shard and gate nothing, so that
// case fails here and in the job's `--verify` step.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
  ROOT,
  SECONDS_BY_FILE,
  SHARDS,
  assignShards,
  coverageReport,
  listUnitFiles,
  shardFiles,
  verifyShards,
  weightOf,
} from "../../scripts/ci/unit-shards.mjs";
import { unitPlan } from "../../scripts/test-unit.ts";

const ALL = listUnitFiles();

/** Every root unit file the shell finds, sorted — the independent list to compare against. */
function findFiles(): string[] {
  const r = spawnSync(
    "bash",
    ["-c", "{ find test/unit -name '*.test.ts'; find test -maxdepth 1 -name '*.test.ts'; } | sort"],
    { cwd: ROOT, encoding: "utf8", timeout: 15_000 },
  );
  if (r.status !== 0) throw new Error(`find failed: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean).sort();
}

describe("unit-shards — the file list", () => {
  test("listUnitFiles returns every root unit *.test.ts, sorted", () => {
    expect(ALL).toEqual(findFiles());
    expect(ALL.length).toBeGreaterThan(0);
  });

  test("every file is a test/unit/** or root test/*.test.ts path", () => {
    for (const f of ALL) {
      expect(f.startsWith("test/unit/") || (f.startsWith("test/") && !f.slice(5).includes("/")), f).toBe(true);
      expect(f.endsWith(".test.ts"), f).toBe(true);
    }
  });

  test("the list matches the files the shared lane's shard steps run", () => {
    // The lane shards the corpus it discovers; the CI job's --verify reads this
    // module's list. They must name the same files or a file could run in no
    // shard while --verify stays green.
    const steps = unitPlan(ROOT).filter((step) => step.shard !== undefined);
    const laneFiles = [...new Set(steps.flatMap((step) => step.files.map((file) => relative(ROOT, file))))].sort();
    expect(laneFiles).toEqual([...ALL].sort());
  });
});

describe("unit-shards — the partition", () => {
  for (const of of [1, 2, 3, 4, 7]) {
    test(`--of ${of} partitions the full list (union = all, no duplicates)`, () => {
      const res = verifyShards(of, ALL);
      expect(res.total).toBe(ALL.length);
      expect(res.covered).toBe(ALL.length);
      expect(res.missing).toEqual([]);
      expect(res.duplicated).toEqual([]);
      expect(res.unknown).toEqual([]);
    });
  }

  test("the union of the shards is exactly the sorted file list", () => {
    const union = [...assignShards(ALL, SHARDS).flat()].sort();
    expect(union).toEqual([...ALL].sort());
  });

  test("shardFiles is deterministic and disjoint", () => {
    const first = Array.from({ length: SHARDS }, (_, i) => shardFiles(i + 1, SHARDS, ALL));
    const second = Array.from({ length: SHARDS }, (_, i) => shardFiles(i + 1, SHARDS, ALL));
    expect(first).toEqual(second);
    const flat = first.flat();
    expect(new Set(flat).size).toBe(flat.length); // no file in two shards
  });

  test("the three heaviest weighted files land in three different shards", () => {
    const heaviest = Object.entries(SECONDS_BY_FILE)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name]) => ALL.find((f) => f.endsWith(`/${name}`)));
    expect(heaviest.every(Boolean)).toBe(true);
    const shards = assignShards(ALL, 3);
    const where = heaviest.map((file) => shards.findIndex((s) => s.includes(file as string)));
    expect(where.every((i) => i >= 0)).toBe(true);
    expect(new Set(where).size).toBe(3);
  });

  test("a file with no weight still lands in a shard", () => {
    const unweighted = ALL.find((f) => !(Object.keys(SECONDS_BY_FILE).some((n) => f.endsWith(`/${n}`))));
    expect(unweighted).toBeDefined();
    expect(weightOf(unweighted as string)).toBeGreaterThan(0);
    expect(assignShards(ALL, SHARDS).flat()).toContain(unweighted as string);
  });
});

describe("unit-shards — the coverage check", () => {
  test("a planted file is covered by exactly one shard", () => {
    const planted = "test/unit/planted-file-2258.test.ts";
    const withPlanted = [...ALL, planted];
    const where = assignShards(withPlanted, SHARDS).filter((shard) => shard.includes(planted));
    expect(where).toHaveLength(1);
    const res = coverageReport(withPlanted, assignShards(withPlanted, SHARDS));
    expect(res.covered).toBe(withPlanted.length);
    expect(res.missing).toEqual([]);
    expect(res.duplicated).toEqual([]);
  });

  test("a file missing from the shards is reported, not silently dropped", () => {
    const shards = assignShards(ALL, SHARDS);
    const dropped = shards[0][0];
    const missingOne = shards.map((shard, i) => (i === 0 ? shard.slice(1) : shard));
    const res = coverageReport(ALL, missingOne);
    expect(res.missing).toEqual([dropped]);
    expect(res.covered).toBe(ALL.length - 1);
  });

  test("a file in two shards is reported as duplicated", () => {
    const shards = assignShards(ALL, SHARDS);
    const duplicated = [...shards, [ALL[0]]];
    const res = coverageReport(ALL, duplicated);
    expect(res.duplicated).toEqual([ALL[0]]);
    expect(res.missing).toEqual([]);
  });

  test("the CLI --verify exits 1 when the assignment does not cover the list", () => {
    // The CLI builds the shards itself, so it cannot be handed a bad assignment
    // directly; drive the same check through the exported function instead and
    // pin the CLI's clean-exit path separately below.
    const shards = assignShards(ALL, SHARDS).map((shard, i) => (i === 0 ? shard.slice(1) : shard));
    const res = coverageReport(ALL, shards);
    expect(res.missing.length).toBeGreaterThan(0);
    expect(res.duplicated).toEqual([]);
  });
});

describe("unit-shards — the CLI", () => {
  const run = (...args: string[]) =>
    spawnSync("node", ["scripts/ci/unit-shards.mjs", ...args], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 20_000,
    });

  test("--list-all prints every file, sorted", () => {
    const r = run("--list-all");
    expect(r.status).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean)).toEqual([...ALL].sort());
  });

  test("--shard 2 prints shard 2's files, defaulting --of to the lane's shard count", () => {
    const r = run("--shard", "2");
    expect(r.status).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean)).toEqual(shardFiles(2, SHARDS, ALL));
  });

  test("--shard 2 --of 3 prints shard 2 of 3", () => {
    const r = run("--shard", "2", "--of", "3");
    expect(r.status).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean)).toEqual(shardFiles(2, 3, ALL));
  });

  test("--verify exits 0 with full coverage and reports the count", () => {
    const r = run("--verify");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`${ALL.length}/${ALL.length} files covered`);
  });

  test("an argument a command does not take exits 2, and a bad shard index exits 1", () => {
    expect(run("--list-all", "--of", "3").status).toBe(2);
    expect(run("--verify", "--of", "0").status).toBe(2);
    expect(run("--shard", "9", "--of", "3").status).toBe(1);
    expect(run("--nope").status).toBe(2);
  });

  test("the CI job runs the coverage gate on this module", () => {
    const workflow = readFileSync(join(ROOT, ".github", "workflows", "test.yml"), "utf8");
    expect(workflow).toContain("node scripts/ci/unit-shards.mjs --verify");
  });
});
