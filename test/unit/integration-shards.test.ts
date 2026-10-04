// Integration-test shards (flair#2149, #2131).
//
// The load-bearing assertion is coverage: the shards PARTITION the full file
// list — the union is every file and no file is in two shards. A file that fell
// out of the union would run in no shard and gate nothing, so that case fails
// here and in the job's `--verify` step.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

import {
  ROOT,
  SECONDS_BY_FILE,
  assignShards,
  listIntegrationFiles,
  shardFiles,
  verifyShards,
  weightOf,
} from "../../scripts/ci/integration-shards.mjs";

const ALL = listIntegrationFiles();

/** Every `*.test.ts` the shell finds, sorted — the independent list to compare against. */
function findFiles(): string[] {
  const r = spawnSync("find", ["test/integration", "-name", "*.test.ts"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 15_000,
  });
  if (r.status !== 0) throw new Error(`find failed: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean).sort();
}

describe("integration-shards — the file list", () => {
  test("listIntegrationFiles returns every test/integration *.test.ts, sorted", () => {
    expect(ALL).toEqual(findFiles());
    expect(ALL.length).toBeGreaterThan(0);
  });

  test("every file starts with test/integration/ and ends with .test.ts", () => {
    for (const f of ALL) {
      expect(f.startsWith("test/integration/"), f).toBe(true);
      expect(f.endsWith(".test.ts"), f).toBe(true);
    }
  });
});

describe("integration-shards — the partition", () => {
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

  test("the union of the three shards is exactly the sorted file list", () => {
    const union = [...assignShards(ALL, 3).flat()].sort();
    expect(union).toEqual([...ALL].sort());
  });

  test("shardFiles is deterministic and disjoint", () => {
    const first = [1, 2, 3].map((i) => shardFiles(i, 3, ALL));
    const second = [1, 2, 3].map((i) => shardFiles(i, 3, ALL));
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
    expect(assignShards(ALL, 3).flat()).toContain(unweighted as string);
  });
});

describe("integration-shards — the CLI", () => {
  const run = (...args: string[]) =>
    spawnSync("node", ["scripts/ci/integration-shards.mjs", ...args], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 20_000,
    });

  test("--list-all prints every file, sorted", () => {
    const r = run("--list-all");
    expect(r.status).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean)).toEqual([...ALL].sort());
  });

  test("--shard 2 --of 3 prints shard 2's files", () => {
    const r = run("--shard", "2", "--of", "3");
    expect(r.status).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean)).toEqual(shardFiles(2, 3, ALL));
  });

  test("--verify --of 3 exits 0 with full coverage", () => {
    const r = run("--verify", "--of", "3");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`${ALL.length}/${ALL.length} files covered`);
  });

  test("an argument a command does not take exits 2", () => {
    expect(run("--list-all", "--of", "3").status).toBe(2);
    expect(run("--verify").status).toBe(2);
    expect(run("--shard", "9", "--of", "3").status).toBe(1);
    expect(run("--nope").status).toBe(2);
  });
});
