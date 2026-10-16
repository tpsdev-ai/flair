// Integration-test shards (flair#2149, #2131, #2554).
//
// The load-bearing assertion is coverage: the shards PARTITION the full file
// list — the union is every file and no file is in two shards. A file that fell
// out of the union would run in no shard and gate nothing, so that case fails
// here and in the job's `--verify` step.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_WEIGHT,
  ROOT,
  assignShards,
  listIntegrationFiles,
  loadWeights,
  secondsByFile,
  shardFiles,
  verifyShards,
  weightOf,
} from "../../scripts/ci/integration-shards.mjs";
import { aggregate, parseJobLog } from "../../scripts/ci/update-integration-shard-weights.mjs";

const ALL = listIntegrationFiles();

/** Scratch directories this file creates, removed after each test. */
const SCRATCH: string[] = [];
afterEach(() => {
  for (const dir of SCRATCH.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  SCRATCH.push(dir);
  return dir;
}

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
    const heaviest = Object.entries(secondsByFile())
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
    expect(unmeasured in secondsByFile()).toBe(false);
    expect(weightOf(unmeasured)).toBe(DEFAULT_WEIGHT);
    expect(DEFAULT_WEIGHT).toBeGreaterThan(0);
    expect(assignShards([...ALL, unmeasured], 3).flat()).toContain(unmeasured);
  });
});

describe("integration-shards — weights", () => {
  test("a measured file's weight is its entry in the weights file", () => {
    const [file, seconds] = Object.entries(secondsByFile()).sort((a, b) => b[1] - a[1])[0];
    expect(ALL).toContain(file);
    expect(weightOf(file)).toBe(seconds);
  });

  test("every weight is a positive number keyed by an integration file", () => {
    for (const [file, seconds] of Object.entries(secondsByFile())) {
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

describe("integration-shards — the weight aggregation", () => {
  // One job-log block: `##[group]<file>:` and its `##[endgroup]`, `ms` apart.
  const START = Date.parse("2026-01-01T00:00:00.000Z");
  const stamp = (ms: number) => new Date(START + ms).toISOString();
  const log = (...blocks: Array<[string, number]>) =>
    `${blocks.map(([file, ms]) => `${stamp(0)} ##[group]${file}:\n${stamp(ms)} ##[endgroup]`).join("\n")}\n`;
  const A = "test/integration/a.test.ts";

  test("keeps the maximum within a log and the median across logs", () => {
    // Two blocks for one file in one log: the mutation step re-runs a file, and
    // the per-log value is the longer of the two.
    expect(aggregate([log([A, 10_000], [A, 30_000])])).toEqual({ [A]: 30 });
    expect(
      aggregate([log([A, 10_000]), log([A, 20_000]), log([A, 100_000])]),
    ).toEqual({ [A]: 20 });
  });

  test("rounds the median to whole seconds", () => {
    expect(aggregate([log([A, 12_000]), log([A, 13_000])])).toEqual({ [A]: 13 });
    expect(aggregate([log([A, 12_000]), log([A, 12_400])])).toEqual({ [A]: 12 });
  });

  test("floors a sub-second median at one second", () => {
    expect(aggregate([log([A, 400])])).toEqual({ [A]: 1 });
  });
});

describe("integration-shards — the weight updater CLI", () => {
  const run = (...args: string[]) =>
    spawnSync("node", ["scripts/ci/update-integration-shard-weights.mjs", ...args], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 20_000,
    });

  test("regenerates the complete weight map from the real job log", () => {
    const out = join(scratch("shard-regen-"), "w.json");
    const r = run("--out", out, "test/fixtures/integration-shard-log.txt");
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
      "test/integration/host-pointer-negatives-1940.test.ts": 12,
      "test/integration/local-delete-instance-2225.test.ts": 17,
      "test/integration/memory-purge-unconfirmed-2290.test.ts": 12,
      "test/integration/patch-refreshes-embedding-2466.test.ts": 26,
      "test/integration/skill-version-completion-inproc-2139.test.ts": 13,
    });
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

describe("integration-shards — the weight updater over a bad existing table (#2604)", () => {
  const FILES = ["alpha", "beta"];
  const LOG =
    [
      "2026-01-01T00:00:00.0000000Z ##[group]test/integration/alpha.test.ts:",
      "2026-01-01T00:00:20.0000000Z ##[endgroup]",
      "2026-01-01T00:00:20.0000000Z ##[group]test/integration/beta.test.ts:",
      "2026-01-01T00:00:31.0000000Z ##[endgroup]",
    ].join("\n") + "\n";

  // A scratch checkout with the two scripts, two integration files and a job
  // log that names them; the checked-in table starts in the state under test.
  function fixture(existing: string | null) {
    const root = scratch("flair-shard-table-");
    mkdirSync(join(root, "scripts/ci"), { recursive: true });
    mkdirSync(join(root, "test/integration"), { recursive: true });
    for (const file of FILES) {
      writeFileSync(join(root, "test/integration", `${file}.test.ts`), "");
    }
    for (const script of ["integration-shards.mjs", "update-integration-shard-weights.mjs"]) {
      cpSync(join(ROOT, "scripts/ci", script), join(root, "scripts/ci", script));
    }
    const table = join(root, "scripts/ci/integration-shard-weights.json");
    if (existing !== null) writeFileSync(table, existing);
    const log = join(root, "job.log");
    writeFileSync(log, LOG);
    return { root, table, log };
  }

  const VALID = {
    "test/integration/alpha.test.ts": 20,
    "test/integration/beta.test.ts": 11,
  };

  const BAD: Array<[string, string | null]> = [
    ["missing", null],
    ["merge-conflict markers", "<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> other\n"],
    ["an empty table", "{}"],
    ["a zero weight", '{"test/integration/alpha.test.ts": 0}\n'],
  ];

  for (const [name, existing] of BAD) {
    test(`writes a valid table when the existing table is ${name}`, () => {
      const { root, table, log } = fixture(existing);
      const r = spawnSync(
        "node",
        [join(root, "scripts/ci/update-integration-shard-weights.mjs"), "--out", table, log],
        { cwd: root, encoding: "utf8", timeout: 20_000 },
      );
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(readFileSync(table, "utf8"))).toEqual(VALID);
    });
  }

  for (const [name, existing] of BAD) {
    test(`the shard-assignment command still fails loudly on a bad table (${name})`, () => {
      const { root } = fixture(existing);
      const r = spawnSync(
        "node",
        [join(root, "scripts/ci/integration-shards.mjs"), "--verify", "--of", "1"],
        { cwd: root, encoding: "utf8", timeout: 20_000 },
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("shard weights file");
      expect(r.stdout).not.toContain("files covered");
    });
  }
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
