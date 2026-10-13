// Integration-test shards (flair#2149, #2131, #2554).
//
// The load-bearing assertion is coverage: the shards PARTITION the full file
// list — the union is every file and no file is in two shards. A file that fell
// out of the union would run in no shard and gate nothing, so that case fails
// here and in the job's `--verify` step.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_WEIGHT,
  ROOT,
  SECONDS_BY_FILE,
  assignShards,
  listIntegrationFiles,
  loadWeights,
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
  test("listIntegrationFiles returns the same sorted set as an independent find", () => {
    expect(ALL).toEqual(findFiles());
    expect(ALL.length).toBeGreaterThan(0);
  });

  test("each listed file starts with test/integration/ and ends with .test.ts", () => {
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

  test("assignShards is deterministic and disjoint for --of 3", () => {
    const first = [1, 2, 3].map((i) => shardFiles(i, 3, ALL));
    const second = [1, 2, 3].map((i) => shardFiles(i, 3, ALL));
    expect(first).toEqual(second);
    const flat = first.flat();
    expect(new Set(flat).size).toBe(flat.length); // no file in two shards
    expect(flat.length).toBe(ALL.length); // and no file dropped
  });

  test("the three heaviest weighted files land in three different shards", () => {
    const heaviest = Object.entries(SECONDS_BY_FILE)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([file]) => file);
    expect(heaviest.every((f) => ALL.includes(f))).toBe(true);
    const shards = assignShards(ALL, 3);
    const where = heaviest.map((file) => shards.findIndex((s) => s.includes(file)));
    expect(where.every((i) => i >= 0)).toBe(true);
    expect(new Set(where).size).toBe(3);
  });

  test("a file with no measured weight still lands in a shard", () => {
    const unweighted = ALL.find((f) => !(f in SECONDS_BY_FILE));
    expect(unweighted).toBeDefined();
    expect(weightOf(unweighted as string)).toBe(DEFAULT_WEIGHT);
    expect(DEFAULT_WEIGHT).toBeGreaterThan(0);
    expect(assignShards(ALL, 3).flat()).toContain(unweighted as string);
  });
});

describe("integration-shards — weights", () => {
  test("a measured file's weight is its entry in the weights file", () => {
    const [file, seconds] = Object.entries(SECONDS_BY_FILE).sort((a, b) => b[1] - a[1])[0];
    expect(ALL).toContain(file);
    expect(weightOf(file)).toBe(seconds);
  });

  test("every weight is a positive number keyed by an integration file", () => {
    for (const [file, seconds] of Object.entries(SECONDS_BY_FILE)) {
      expect(ALL, file).toContain(file);
      expect(Number.isFinite(seconds) && seconds > 0, file).toBe(true);
    }
  });

  test("a malformed weights file throws instead of falling back silently", () => {
    const dir = mkdtempSync(join(tmpdir(), "shard-weights-"));
    const cases: Array<[string, string]> = [
      ["garbage.json", "{ not json"],
      ["array.json", "[1, 2, 3]"],
      ["bad-weight.json", '{"test/integration/a.test.ts": 0}'],
      ["negative.json", '{"test/integration/a.test.ts": -5}'],
      ["string-weight.json", '{"test/integration/a.test.ts": "slow"}'],
    ];
    for (const [name, body] of cases) {
      const p = join(dir, name);
      writeFileSync(p, body);
      expect(() => loadWeights(p), name).toThrow();
    }
  });

  test("a missing weights file throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "shard-weights-"));
    expect(() => loadWeights(join(dir, "absent.json"))).toThrow();
  });
});

describe("integration-shards — the CLI", () => {
  const run = (...args: string[]) =>
    spawnSync("node", ["scripts/ci/integration-shards.mjs", ...args], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 20_000,
    });

  test("--list-all prints the sorted file list", () => {
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

  test("a bad argument or an out-of-range shard is refused", () => {
    expect(run("--list-all", "--of", "3").status).toBe(2);
    expect(run("--verify").status).toBe(2);
    expect(run("--shard", "9", "--of", "3").status).toBe(1);
    expect(run("--nope").status).toBe(2);
  });
});
