import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  ROOT, SHARDS, assignShards, coverageReport, listUnitFiles, shardFiles, verifyShards,
} from "../../scripts/ci/unit-shards.mjs";
import { unitPlan } from "../../scripts/test-unit.ts";

const ALL = listUnitFiles();
const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "flair-shard-fixture-"));
  fixtures.push(root);
  mkdirSync(join(root, "scripts/ci"), { recursive: true });
  mkdirSync(join(root, "test/unit/nested"), { recursive: true });
  for (const extension of ["js", "jsx", "ts", "tsx"]) {
    for (const dir of ["test", "test/unit", "test/unit/nested"]) {
      writeFileSync(join(root, dir, `sample.test.${extension}`), "");
    }
  }
  writeFileSync(join(root, "test/unit/ignored.spec.ts"), "");
  cpSync(join(ROOT, "scripts/ci/test-files.mjs"), join(root, "scripts/ci/test-files.mjs"));
  cpSync(join(ROOT, "scripts/ci/unit-shards.mjs"), join(root, "scripts/ci/unit-shards.mjs"));
  return root;
}

function findFiles(): string[] {
  const r = spawnSync("bash", ["-c", "{ find test/unit -type f; find test -maxdepth 1 -type f; } | LC_ALL=C sort"], {
    cwd: ROOT, encoding: "utf8", timeout: 15_000,
  });
  if (r.status !== 0) throw new Error(`find failed: ${r.stderr}`);
  return r.stdout.split("\n").filter(file =>
    [".test.js", ".test.jsx", ".test.ts", ".test.tsx"].some(suffix => file.endsWith(suffix)),
  ).sort();
}

describe("unit-shards — discovery", () => {
  test("matches independent discovery", () => {
    expect(ALL).toEqual(findFiles());
    expect(ALL.length).toBeGreaterThan(0);
  });

  test("includes all runner extensions at both root boundaries", () => {
    const root = fixtureRoot();
    const expected = ["js", "jsx", "ts", "tsx"].flatMap(extension =>
      ["test", "test/unit", "test/unit/nested"].map(dir => `${dir}/sample.test.${extension}`),
    ).sort();
    expect(listUnitFiles(root)).toEqual(expected);
    const result = spawnSync("node", [join(root, "scripts/ci/unit-shards.mjs"), "--verify"], {
      encoding: "utf8", timeout: 20_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${expected.length}/${expected.length} files covered`);
  });

  for (const dir of ["test", "test/unit"]) {
    for (const defect of ["missing", "empty"]) {
      test(`${defect} ${dir} fails discovery and the coverage gate`, () => {
        const root = fixtureRoot();
        if (dir === "test/unit") {
          rmSync(join(root, dir), { recursive: true });
          if (defect === "empty") mkdirSync(join(root, dir));
        } else if (defect === "missing") {
          rmSync(join(root, dir), { recursive: true });
        } else {
          for (const extension of ["js", "jsx", "ts", "tsx"]) {
            rmSync(join(root, dir, `sample.test.${extension}`));
          }
        }
        expect(() => listUnitFiles(root)).toThrow();
        const result = spawnSync("node", [join(root, "scripts/ci/unit-shards.mjs"), "--verify"], {
          cwd: root, encoding: "utf8", timeout: 20_000,
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(dir);
        expect(result.stdout).not.toContain("files covered");
      });
    }
  }

  test("matches the files the shared lane's shard steps run", () => {
    const steps = unitPlan(ROOT).filter(step => step.shard !== undefined);
    for (const step of steps) expect(step.args).toEqual(["test", ...step.files]);
    const laneFiles = steps.flatMap(step => step.args.slice(1).map(file => relative(ROOT, file))).sort();
    expect(laneFiles).toEqual(ALL);
  });
});

describe("unit-shards — assignment", () => {
  for (const of of [1, 2, 3, 4, 7]) {
    test(`${of} shards partition the discovered files`, () => {
      expect(verifyShards(of, ALL)).toEqual({
        total: ALL.length, covered: ALL.length, missing: [], duplicated: [], unknown: [],
      });
    });
  }

  test("adding a file leaves all existing assignments unchanged", () => {
    const before = assignShards(ALL, SHARDS);
    const added = "test/unit/aaa-added-file.test.jsx";
    const after = assignShards([...ALL, added], SHARDS);
    for (const [index, shard] of before.entries()) {
      expect(after[index].filter(file => file !== added)).toEqual(shard);
    }
    expect(after.flat().filter(file => file === added)).toHaveLength(1);
    expect(assignShards([...ALL].reverse(), SHARDS)).toEqual(before);
  });

  test("reports omissions and duplicates", () => {
    const shards = assignShards(ALL, SHARDS);
    const dropped = shards[0][0];
    expect(coverageReport(ALL, shards.map((shard, i) => i === 0 ? shard.slice(1) : shard)).missing).toEqual([dropped]);
    expect(coverageReport(ALL, [...shards, [ALL[0]]]).duplicated).toEqual([ALL[0]]);
  });
});

describe("unit-shards — CLI", () => {
  const run = (...args: string[]) => spawnSync("node", ["scripts/ci/unit-shards.mjs", ...args], {
    cwd: ROOT, encoding: "utf8", timeout: 20_000,
  });

  for (const defect of ["missing", "duplicated"] as const) {
    test(`--verify exits 1 and names a ${defect} file`, () => {
      const root = fixtureRoot();
      const modulePath = join(root, "scripts/ci/unit-shards.mjs");
      const name = "test/unit/sample.test.jsx";
      const source = readFileSync(modulePath, "utf8");
      const injected = defect === "missing"
        ? `for (const bucket of buckets) { const at = bucket.indexOf(${JSON.stringify(name)}); if (at !== -1) bucket.splice(at, 1); }`
        : `buckets[0].push(${JSON.stringify(name)});`;
      expect(source).toContain("return buckets.map");
      writeFileSync(modulePath, source.replace("return buckets.map", `${injected}\n  return buckets.map`));
      const result = spawnSync("node", [modulePath, "--verify"], { cwd: root, encoding: "utf8", timeout: 20_000 });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${defect}: ${name}`);
    });
  }

  test("--list-all prints the sorted corpus", () => {
    const r = run("--list-all");
    expect(r.status).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean)).toEqual(ALL);
  });

  test("--shard defaults to the lane's shard count", () => {
    const r = run("--shard", "2");
    expect(r.status).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean)).toEqual(shardFiles(2, SHARDS, ALL));
  });

  test("--shard accepts another shard count", () => {
    const r = run("--shard", "2", "--of", "3");
    expect(r.status).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean)).toEqual(shardFiles(2, 3, ALL));
  });

  test("--verify passes on the current assignment", () => {
    const r = run("--verify");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`${ALL.length}/${ALL.length} files covered, 0 missing, 0 duplicated`);
  });

  for (const { args, status } of [
    { args: ["--shard", "0"], status: 1 },
    { args: ["--shard", "5", "--of", "4"], status: 1 },
    { args: ["--verify", "--of", "0"], status: 2 },
    { args: ["--list-all", "--of", "2"], status: 2 },
    { args: ["--verify", "--other"], status: 2 },
    { args: [], status: 2 },
  ]) {
    test(`invalid arguments fail: ${args.join(" ")}`, () => {
      expect(run(...args).status).toBe(status);
      expect(run("--nope").status).toBe(2);
    });
  }

  test("CI runs the coverage gate", () => {
    expect(readFileSync(join(ROOT, ".github/workflows/test.yml"), "utf8")).toContain("node scripts/ci/unit-shards.mjs --verify");
  });
});
