// Integration-test shards (flair#2149, #2131, #2554).
//
// The load-bearing assertion is coverage: the shards PARTITION the full file
// list — the union is every file and no file is in two shards. A file that fell
// out of the union would run in no shard and gate nothing, so that case fails
// here and in the job's `--verify` step.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { parseJobLog } from "../../scripts/ci/update-integration-shard-weights.mjs";

const ALL = listIntegrationFiles();

/** A real `Integration Tests (shard 1/3)` job log, trimmed to five file blocks. */
const REAL_LOG = join(ROOT, "test", "fixtures", "integration-shard-log.txt");

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

  test("a file absent from the weights table falls back to DEFAULT_WEIGHT and still lands in a shard", () => {
    const unmeasured = "test/integration/not-yet-measured.test.ts";
    expect(unmeasured in SECONDS_BY_FILE).toBe(false);
    expect(weightOf(unmeasured)).toBe(DEFAULT_WEIGHT);
    expect(DEFAULT_WEIGHT).toBeGreaterThan(0);
    expect(assignShards([...ALL, unmeasured], 3).flat()).toContain(unmeasured);
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

  test("an empty weights table throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "shard-weights-"));
    const p = join(dir, "empty.json");
    writeFileSync(p, "{}");
    expect(() => loadWeights(p)).toThrow();
  });
});

describe("integration-shards — the weight parser", () => {
  const log = readFileSync(REAL_LOG, "utf8");

  test("reads per-file wall times from a real captured job log", () => {
    const w = parseJobLog(log);
    expect(Object.keys(w).length).toBe(5);
    expect(w["test/integration/patch-refreshes-embedding-2466.test.ts"]).toBeCloseTo(26.34, 1);
    expect(w["test/integration/host-pointer-negatives-1940.test.ts"]).toBeCloseTo(12.43, 1);
    expect(w["test/integration/local-delete-instance-2225.test.ts"]).toBeCloseTo(17.14, 1);
    expect(w["test/integration/skill-version-completion-inproc-2139.test.ts"]).toBeCloseTo(12.67, 1);
    expect(w["test/integration/memory-purge-unconfirmed-2290.test.ts"]).toBeCloseTo(11.92, 1);
  });

  test("ignores a leading job/step tag and a byte-order mark", () => {
    const prefixed = log
      .split("\n")
      .map((l) => (l ? `job-a\tstep-a\t${l}` : l))
      .join("\n");
    expect(parseJobLog(prefixed)).toEqual(parseJobLog(log));
    expect(parseJobLog(`\uFEFF${log}`)).toEqual(parseJobLog(log));
  });
});

describe("integration-shards — the weight updater CLI", () => {
  const run = (...args: string[]) =>
    spawnSync("node", ["scripts/ci/update-integration-shard-weights.mjs", ...args], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 20_000,
    });

  test("regenerates a weights table from the real job log", () => {
    const out = join(mkdtempSync(join(tmpdir(), "shard-regen-")), "w.json");
    const r = run("--out", out, "test/fixtures/integration-shard-log.txt");
    expect(r.status).toBe(0);
    const written = JSON.parse(readFileSync(out, "utf8"));
    expect(Object.keys(written).length).toBe(5);
  });

  test("refuses to write when the logs carry no file timings", () => {
    const dir = mkdtempSync(join(tmpdir(), "shard-regen-"));
    const logPath = join(dir, "setup-only.log");
    writeFileSync(
      logPath,
      "2026-10-13T00:00:00.0000000Z ##[group]Set up job\n" +
        "2026-10-13T00:00:01.0000000Z ##[endgroup]\n",
    );
    const out = join(dir, "w.json");
    const r = run("--out", out, logPath);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no per-file timings");
    expect(() => readFileSync(out, "utf8")).toThrow();
  });

  test("refuses a log with no file timings even next to a usable log, and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "shard-regen-"));
    try {
      const badLog = join(dir, "setup-only.log");
      writeFileSync(
        badLog,
        "2026-10-13T00:00:00.0000000Z ##[group]Set up job\n" +
          "2026-10-13T00:00:01.0000000Z ##[endgroup]\n",
      );
      const out = join(dir, "w.json");
      const before = '{\n  "test/integration/sentinel.test.ts": 7\n}\n';
      writeFileSync(out, before);
      const r = run("--out", out, "test/fixtures/integration-shard-log.txt", badLog);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`${badLog}: no per-file timings`);
      expect(r.stderr).not.toContain("integration-shard-log.txt: no per-file timings");
      expect(readFileSync(out, "utf8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
