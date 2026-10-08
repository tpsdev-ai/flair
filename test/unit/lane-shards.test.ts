// Shared-unit-lane shard map (flair#2311).
//
// Tests command/file agreement, the lane partition and workflow shard count.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { load as loadYaml } from "js-yaml";
import {
  LANE_SHARDS,
  NON_JS_TEST_PACKAGES,
  ROOT,
  WORKSPACE_PACKAGES,
  assignLaneShards,
  commandFiles,
  discoveredTestPackages,
  isShardedStep,
  laneCoverage,
  laneShardPlans,
  listLaneFiles,
  plannedTestPackages,
  shardSteps,
  sharedSteps,
  unitPlan,
  verifyLaneShards,
} from "../../scripts/ci/lane-shards.mjs";
import { effectiveMatrix, shardValues, verifyWorkflowMatrix } from "../../scripts/ci/check-lane-matrix.mjs";
import { parseUnitLaneArgs } from "../../scripts/test-unit.ts";

const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A root with the minimal directories `unitPlan` requires, plus any planted files. */
function fixtureRoot(planted: string[] = []): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flair-lane-shard-")));
  fixtures.push(root);
  const requiredDirs = [
    "test", "test/unit", "test/unit-isolated",
    ...["flair-tool-descriptors", "flair-mcp", "flair-client", "langgraph-flair", "n8n-nodes-flair", "openclaw-flair", "pi-flair", "flair-bench", "adk-flair-js", "cursor-wake-runner"].map(
      pkg => `packages/${pkg}/${pkg === "adk-flair-js" ? "test/unit" : "test"}`,
    ),
  ];
  for (const dir of requiredDirs) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "placeholder.test.ts"), "");
  }
  for (const file of planted) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), "");
  }
  return root;
}

describe("lane-shards — the plan", () => {
  const plan = unitPlan(ROOT);

  test("the plan has file-bearing steps and file-less shared setup", () => {
    const sharded = plan.filter(isShardedStep);
    const shared = sharedSteps(plan);
    expect(sharded.length).toBeGreaterThan(0);
    expect(shared.length).toBeGreaterThan(0);
    // The shared setup is exactly the steps with no test files and no root shard.
    expect(shared.every(step => step.files.length === 0)).toBe(true);
    expect(sharded.every(step => step.files.length > 0 || step.shard !== undefined)).toBe(true);
    // The shared setup is a known, fixed prologue.
    expect(shared.map(step => step.name)).toEqual([
      "vendor tool descriptors",
      "typecheck: resources (strict)",
      "typecheck: src (strict, excl. cli.ts)",
      "typecheck: root CLI",
      "typecheck: test suite (strict)",
      "emit server for boundary guard",
      "build root CLI",
      "build flair-client",
      "build flair-mcp",
      "typecheck: langgraph-flair contract (BaseStore assignability)",
    ]);
  });

  test("the on-disk file corpus matches the plan's test files", () => {
    const fromPlan = unitPlan(ROOT).filter(isShardedStep).flatMap(step => step.files).sort();
    expect(listLaneFiles(ROOT)).toEqual(fromPlan);
    expect(listLaneFiles(ROOT).length).toBeGreaterThan(100);
  });

  test("packages with recognized test filenames are planned or allowlisted", () => {
    const { jsTestPackages, nonJsTestPackages } = discoveredTestPackages(ROOT);
    const res = verifyLaneShards(LANE_SHARDS);
    expect(res.missingTestPackages).toEqual([]);
    expect(res.unlistedTestPackages).toEqual([]);
    expect(jsTestPackages).toEqual([...WORKSPACE_PACKAGES].sort());
    expect(nonJsTestPackages).toEqual([...NON_JS_TEST_PACKAGES].sort());
    expect(plannedTestPackages(unitPlan(ROOT), ROOT)).toEqual([...WORKSPACE_PACKAGES].sort());
  });

  test("package discovery skips packages/node_modules and dot entries", () => {
    const root = fixtureRoot([
      "packages/node_modules/dependency/test/a.test.ts",
      "packages/node_modules/python/tests/test_thing.py",
      "packages/.hidden/test/a.test.ts",
      "packages/.python/tests/test_thing.py",
    ]);
    expect(discoveredTestPackages(root)).toEqual({
      jsTestPackages: [...WORKSPACE_PACKAGES].sort(),
      nonJsTestPackages: [],
    });
    const res = verifyLaneShards(LANE_SHARDS, unitPlan(root), listLaneFiles(root), root);
    expect(res.missingTestPackages).toEqual([]);
    expect(res.unlistedTestPackages).toEqual([]);
  });

  test("a wholly omitted package with a .test.ts file fails the verifier", () => {
    const root = fixtureRoot(["packages/x/test/a.test.ts"]);
    const res = verifyLaneShards(LANE_SHARDS, unitPlan(root), listLaneFiles(root), root);
    expect(res.missingTestPackages).toEqual(["x"]);
  });

  test("a package with only recognized Python test filenames requires allowlisting", () => {
    const root = fixtureRoot(["packages/py-pkg/tests/test_thing.py"]);
    const res = verifyLaneShards(LANE_SHARDS, unitPlan(root), listLaneFiles(root), root);
    expect(res.missingTestPackages).toEqual([]);
    expect(res.unlistedTestPackages).toEqual(["py-pkg"]);
  });

  test("other languages and omitted files inside planned packages are deferred", () => {
    const root = fixtureRoot(["packages/rust-pkg/tests/example.rs", "packages/adk-flair-js/test/integration/extra.test.ts"]);
    const res = verifyLaneShards(LANE_SHARDS, unitPlan(root), listLaneFiles(root), root);
    expect(res.missingTestPackages).toEqual([]);
    expect(res.unlistedTestPackages).toEqual([]);
  });

  test("a step's files are covered exactly once across shards", () => {
    const res = verifyLaneShards(LANE_SHARDS);
    expect(res.missingSteps).toEqual([]);
    expect(res.duplicatedSteps).toEqual([]);
    expect(res.unknownSteps).toEqual([]);
    expect(res.missingFiles).toEqual([]);
    expect(res.duplicatedFiles).toEqual([]);
    expect(res.unknownFiles).toEqual([]);
    expect(res.empty).toEqual([]);
    expect(res.invalidSharedSteps).toEqual([]);
    expect(res.invalidTestSteps).toEqual([]);
    expect(res.coveredSteps).toBe(res.totalSteps);
    expect(res.coveredFiles).toBe(res.totalFiles);
  });

  test("a planted test file lands in exactly one shard", () => {
    const planted = "test/unit/aaa-lane-shard-planted.test.ts";
    const root = fixtureRoot([planted]);
    const steps = unitPlan(root);
    const shards = laneShardPlans(steps, LANE_SHARDS);
    const file = join(root, planted);
    const owners = shards.filter(shard => shard.some(step => step.files.includes(file)));
    expect(owners).toHaveLength(1);
    // And the whole plan still partitions cleanly with the planted file present.
    const res = laneCoverage(steps, shards, listLaneFiles(root), root);
    expect(res.missingFiles).toEqual([]);
    expect(res.duplicatedFiles).toEqual([]);
  });
});

describe("lane-shards — assignment", () => {
  for (const of of [1, 2, 3, 5]) {
    test(`${of} shards partition every step and file`, () => {
      const res = verifyLaneShards(of);
      expect(res.missingSteps).toEqual([]);
      expect(res.duplicatedSteps).toEqual([]);
      expect(res.missingFiles).toEqual([]);
      expect(res.duplicatedFiles).toEqual([]);
      expect(res.empty).toEqual([]);
      expect(res.invalidSharedSteps).toEqual([]);
      expect(res.invalidTestSteps).toEqual([]);
      expect(res.coveredSteps).toBe(res.totalSteps);
      expect(res.coveredFiles).toBe(res.totalFiles);
    });
  }

  test("shards of the same count are identical run to run", () => {
    const plan = unitPlan(ROOT);
    const once = assignLaneShards(plan, LANE_SHARDS).map(shard => shard.map(step => step.name));
    const twice = assignLaneShards(unitPlan(ROOT), LANE_SHARDS).map(shard => shard.map(step => step.name));
    expect(once).toEqual(twice);
  });

  test("root steps have distinct owners with one lane shard per root step", () => {
    const plan = unitPlan(ROOT);
    const roots = plan.filter(step => step.shard !== undefined).map(step => step.name);
    const shards = assignLaneShards(plan, roots.length);
    const owners = roots.map(name => {
      const matches = shards.flatMap((shard, index) => shard.some(step => step.name === name) ? [index] : []);
      expect(matches).toHaveLength(1);
      return matches[0];
    });
    expect(new Set(owners).size).toBe(roots.length);
  });

  test("lane shards share root steps equally and file counts differ by at most one", () => {
    const plan = unitPlan(ROOT);
    const shards = assignLaneShards(plan, LANE_SHARDS);
    const rootCount = plan.filter(step => step.shard !== undefined).length;
    for (const shard of shards) {
      expect(shard.filter(step => step.shard !== undefined)).toHaveLength(rootCount / LANE_SHARDS);
    }
    const loads = shards.map(shard => shard.reduce((sum, step) => sum + step.files.length, 0));
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(1);
  });

  test("reports a dropped file, a dropped step, and a duplicated step", () => {
    const plan = unitPlan(ROOT);
    const shards = laneShardPlans(plan, LANE_SHARDS);
    const droppedFile = shards.flatMap(s => s).find(s => s.files.length)!.files[0];
    const testAt = shards[0].findIndex(isShardedStep);
    const droppedStep = shards[0][testAt].name;
    const withoutFile = laneCoverage(plan, shards.map((shard, i) => i === 0 ? [
      ...shard.slice(0, testAt), { ...shard[testAt], files: shard[testAt].files.filter(f => f !== droppedFile) }, ...shard.slice(testAt + 1),
    ] : shard));
    expect(withoutFile.fileMismatches).toEqual([{ step: droppedStep, declaredOnly: [], commandOnly: [droppedFile] }]);
    expect(withoutFile.missingFiles).toEqual([]);
    const withoutStep = laneCoverage(plan, shards.map((shard, i) => i === 0 ? shard.filter((_, index) => index !== testAt) : shard));
    expect(withoutStep.missingSteps).toEqual([droppedStep]);
    const doubled = laneCoverage(plan, shards.map((shard, i) => i === 0 ? [...shard, shard[testAt]] : shard));
    expect(doubled.duplicatedSteps).toEqual([droppedStep]);
  });

  test("an unknown step in a shard is reported", () => {
    const plan = unitPlan(ROOT);
    const shards = assignLaneShards(plan, LANE_SHARDS);
    const bogus = { name: "not a lane step", cwd: ROOT, args: [], files: [] };
    const res = laneCoverage(plan, [...shards, [bogus]]);
    expect(res.unknownSteps).toEqual(["not a lane step"]);
  });

  test("shardSteps rejects an out-of-range index", () => {
    expect(() => shardSteps(0, LANE_SHARDS)).toThrow();
    expect(() => shardSteps(LANE_SHARDS + 1, LANE_SHARDS)).toThrow();
    expect(shardSteps(1, LANE_SHARDS).length).toBeGreaterThan(0);
  });
});

test("coverage rejects setup assigned to one shard", () => {
  const plan = unitPlan(ROOT);
  const shards = laneShardPlans(plan, 2);
  const res = laneCoverage(plan, shards.map((shard, i) => i === 1 ? shard.filter(step => step.name !== "build root CLI") : shard));
  expect(res.invalidSharedSteps).toEqual(["build root CLI"]);
});

test("coverage rejects a test-bearing build command", () => {
  const plan = unitPlan(ROOT).map(step => step.shard?.index === 1 ? { ...step, args: ["run", "build:cli"] } : step);
  expect(verifyLaneShards(2, plan).invalidTestSteps).toEqual(["root unit tests (shard 1/4)"]);
});

test("coverage rejects a test command with no declared files", () => {
  const plan = unitPlan(ROOT).map(step => step.name === "build root CLI" ? { ...step, args: ["test", "test/unit/lane-shards.test.ts"] } : step);
  expect(verifyLaneShards(2, plan).fileMismatches).toEqual([{
    step: "build root CLI", declaredOnly: [], commandOnly: [join(ROOT, "test/unit/lane-shards.test.ts")],
  }]);
});

test("command coverage reports declared-only and command-only files", () => {
  const root = fixtureRoot(["test/unit/extra.test.ts"]);
  const steps = unitPlan(root);
  const step = steps.find(step => step.shard !== undefined && step.files.length > 1)!;
  const missing = step.files[1];
  const added = join(root, "test/unit-isolated/placeholder.test.ts");
  const changed = { ...step, args: ["test", step.files[0], added] };
  const plan = steps.map(item => item === step ? changed : item);
  const res = verifyLaneShards(2, plan, listLaneFiles(root), root);
  expect(res.fileMismatches).toEqual([{ step: step.name, declaredOnly: step.files.slice(1).sort(), commandOnly: [added] }]);
  expect(res.missingFiles).toContain(missing);
  expect(res.duplicatedFiles).toContain(added);
  expect(res.coveredFiles).toBe(res.totalFiles - step.files.length + 1);
});

test("directory and literal glob targets agree with Bun discovery", () => {
  const root = fixtureRoot();
  const names = ["a.test.ts", "b.spec.ts", "c_test.ts", "d_spec.ts", "nested/e.test.mjs", "nested/f.test.cts", ".hidden.test.ts"];
  const excluded = [".hidden/g.test.ts", "node_modules/h.test.ts", "plain.ts"];
  for (const name of [...names, ...excluded]) {
    const file = join(root, "targets", name);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, `import { test } from "bun:test"; test(${JSON.stringify(name)}, () => console.log(${JSON.stringify("ran:" + name)}));`);
  }
  for (const targets of [["./targets/"], ["./targets/*.test.ts"], ["targets/*.test.ts"], names.map(name => `./targets/${name}`)]) {
    const step = { name: "fixture", cwd: root, args: ["test", ...targets], files: names.map(name => join(root, "targets", name)) };
    const result = spawnSync(process.execPath, step.args, { cwd: root, encoding: "utf8", timeout: 20_000 });
    if (targets.length === 1 && targets[0].includes("*")) {
      expect(result.status).toBe(1);
      expect(() => commandFiles(step)).toThrow();
    } else {
      expect(result.status).toBe(0);
      const ran = result.stdout.split("\n").filter(line => line.startsWith("ran:")).map(line => join(root, "targets", line.slice(4))).sort();
      expect(commandFiles(step)).toEqual(ran);
      expect(laneCoverage([step], [[step]], ran, root).fileMismatches).toEqual([]);
    }
  }
  const step = { name: "fixture", cwd: root, args: ["test", "./targets/"], files: [join(root, "targets/a.test.ts")] };
  expect(laneCoverage([step], [[step]], step.files, root).fileMismatches[0].commandOnly).toHaveLength(names.length - 1);
});

test("an unmatched target retains coverage of matched command files", () => {
  const root = fixtureRoot();
  const file = join(root, "test/unit/placeholder.test.ts");
  const step = { name: "fixture", cwd: root, args: ["test", file, "./test/unit/*.test.ts"], files: [file] };
  const result = spawnSync(process.execPath, step.args, { cwd: root, encoding: "utf8", timeout: 20_000 });
  expect(result.status).toBe(0);
  const res = laneCoverage([step], [[step]], [file], root);
  expect(res.coveredFiles).toBe(1);
  expect(res.invalidCommands).toEqual(["fixture: unmatched target: ./test/unit/*.test.ts"]);
});

test("setup precedes tests in each shard", () => {
  const plan = unitPlan(ROOT);
  for (const shard of laneShardPlans(plan, 2)) {
    const firstTest = shard.findIndex(isShardedStep);
    for (const step of sharedSteps(plan)) expect(shard.indexOf(step)).toBeLessThan(firstTest);
    expect(shard.find(step => step.name === "build root CLI")?.args).toEqual(["run", "build:cli"]);
  }
});

describe("lane-shards — CLI", () => {
  const run = (...args: string[]) => spawnSync("node", ["scripts/ci/lane-shards.mjs", ...args], {
    cwd: ROOT, encoding: "utf8", timeout: 20_000,
  });

  test("--verify passes on the current assignment", () => {
    const r = run("--verify");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("0 missing, 0 duplicated");
    expect(r.stdout).toContain("steps and");
    expect(r.stdout).toContain("files covered");
  });

  for (const mutation of ["setup", "build command", "one command file"]) {
    test(`--verify rejects ${mutation} mutation`, () => {
      const root = fixtureRoot(Array.from({ length: 24 }, (_, i) => `test/unit/extra-${i}.test.ts`));
      mkdirSync(join(root, "scripts/ci"), { recursive: true });
      for (const file of ["lane-shards.mjs", "unit-shards.mjs", "test-files.mjs"]) {
        cpSync(join(ROOT, "scripts/ci", file), join(root, "scripts/ci", file));
      }
      const modulePath = join(root, "scripts/ci/lane-shards.mjs");
      const source = readFileSync(modulePath, "utf8");
      const original = mutation === "setup"
        ? ".map(shard => [...sharedSteps(steps), ...shard])"
        : "return [...sharedSteps(steps), ...shardedSteps(steps)];";
      const replacement = mutation === "setup"
        ? ".map((shard, index) => [...sharedSteps(steps).filter(step => step.name !== 'build root CLI' || index !== 1), ...shard])"
        : mutation === "build command"
          ? "steps.find(step => step.shard?.index === 1).args = ['run', 'build:cli']; return [...sharedSteps(steps), ...shardedSteps(steps)];"
          : "const step = steps.find(step => step.shard?.index === 1); step.args = step.args.slice(0, 2); return [...sharedSteps(steps), ...shardedSteps(steps)];";
      expect(source).toContain(original);
      writeFileSync(modulePath, source.replace(original, replacement));
      const result = spawnSync("node", [modulePath, "--verify", "--of", "2"], { cwd: root, encoding: "utf8", timeout: 20_000 });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(mutation === "setup" ? "setup not once in every shard: build root CLI"
        : mutation === "build command" ? "partitioned steps must only run tests: root unit tests (shard 1/4)"
          : "command/files mismatch: root unit tests (shard 1/4); declared only:");
      if (mutation === "one command file") {
        expect(result.stderr).toContain("extra-");
        expect(result.stdout).not.toContain("0 missing");
      }
    });
  }

  test("--verify --of matches another shard count", () => {
    expect(run("--verify", "--of", "3").status).toBe(0);
  });

  test("--list-all prints every test-bearing step name, sorted", () => {
    const r = run("--list-all");
    expect(r.status).toBe(0);
    const names = r.stdout.split("\n").filter(Boolean);
    expect(names).toEqual(unitPlan(ROOT).filter(isShardedStep).map(step => step.name).sort());
  });

  test("--shard prints one shard's step names", () => {
    const r = run("--shard", "1", "--of", String(LANE_SHARDS));
    expect(r.status).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean)).toEqual(shardSteps(1, LANE_SHARDS).map(step => step.name).sort());
  });

  for (const { args, status } of [
    { args: ["--shard", "0"], status: 1 },
    { args: ["--shard", "5", "--of", "4"], status: 1 },
    { args: ["--verify", "--of", "0"], status: 2 },
    { args: ["--list-all", "--of", "2"], status: 2 },
    { args: ["--verify", "--other"], status: 2 },
    { args: ["--verify", "--verify", "--of", "2"], status: 2 },
    { args: ["--shard", "1", "--shard", "2"], status: 2 },
    { args: ["--verify", "--of", "2", "--of", "2"], status: 2 },
    { args: [], status: 2 },
  ]) {
    test(`invalid arguments fail: ${args.join(" ")}`, () => {
      const result = run(...args);
      expect(result.status).toBe(status);
      expect(result.stderr).toContain("lane-shards:");
      if (new Set(args).size < args.length && args.some(arg => arg.startsWith("--"))) {
        expect(result.stderr).toContain("repeated argument:");
      }
      expect(run("--nope").status).toBe(2);
    });
  }
});

type Matrix = Record<string, unknown>;

function workflowMatrix(text: string): Matrix {
  const doc = loadYaml(text) as { jobs: Record<string, { strategy: { matrix: Matrix } }> };
  return doc.jobs["test-unit"].strategy.matrix;
}

describe("lane-shards — the workflow runs it", () => {
  const workflow = readFileSync(join(ROOT, ".github", "workflows", "test.yml"), "utf8");

  test("CI runs the lane coverage gate", () => {
    expect(workflow).toContain("node scripts/ci/lane-shards.mjs --verify");
  });

  test("the workflow matrix contains every required shard index", () => {
    expect(workflow).toMatch(/run: bun run test:unit --keep-going --shard \$\{\{ matrix\.shard \}\} --of 2/);
    expect(shardValues(workflowMatrix(workflow))).toEqual(Array.from({ length: LANE_SHARDS }, (_, i) => i + 1));
  });

  test("the matrix resolver removes excluded shard indices", () => {
    const base = { "node-version": ["22", "24"], shard: [1, 2] };
    expect(shardValues(base)).toEqual([1, 2]);
    expect(shardValues({ ...base, exclude: [{ shard: 2 }] })).toEqual([1]);
    // An exclude narrowed by another axis leaves that shard running elsewhere.
    expect(shardValues({ ...base, exclude: [{ "node-version": "24", shard: 2 }] })).toEqual([1, 2]);
    expect(shardValues({ ...base, include: [{ shard: 3 }] })).toEqual([1, 2, 3]);
    const mutated = workflow.replace(/^( {8}shard: \[[^\]]*\]\n)/m, "$1        exclude:\n          - shard: 2\n");
    expect(mutated).not.toBe(workflow);
    expect(shardValues(workflowMatrix(mutated))).not.toEqual(Array.from({ length: LANE_SHARDS }, (_, i) => i + 1));
    expect(shardValues(workflowMatrix(mutated))).toEqual([1]);
  });

  test("the matrix checker runs in unsharded doclint", () => {
    const doc = loadYaml(workflow) as { jobs: Record<string, { strategy?: unknown; if?: unknown; steps: { run?: string; if?: unknown; "continue-on-error"?: boolean }[] }> };
    const job = doc.jobs.doclint;
    expect(job.strategy).toBeUndefined();
    expect(job.if).toBeUndefined();
    const step = job.steps.find(step => step.run === "node scripts/ci/check-lane-matrix.mjs");
    expect(step).toBeDefined();
    expect(step?.if).toBeUndefined();
    expect(step?.["continue-on-error"]).toBeUndefined();
  });

  test("excluding the test file's lane shard fails the standalone checker", () => {
    const checkerFile = join(ROOT, "test/unit/lane-shards.test.ts");
    const owner = laneShardPlans(unitPlan(ROOT)).findIndex(shard => shard.some(step => step.files.includes(checkerFile))) + 1;
    expect(owner).toBeGreaterThan(0);
    const mutated = workflow.replace(/^( {8}shard: \[[^\]]*\]\n)/m, `$1        exclude:\n          - shard: ${owner}\n`);
    expect(mutated).not.toBe(workflow);
    const dir = mkdtempSync(join(tmpdir(), "flair-matrix-"));
    fixtures.push(dir);
    const path = join(dir, "test.yml");
    writeFileSync(path, mutated);
    const result = spawnSync("node", ["scripts/ci/check-lane-matrix.mjs", path], { cwd: ROOT, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`missing lane shards: ${owner}`);
    expect(() => verifyWorkflowMatrix(workflow)).not.toThrow();
  });

  test("later includes overwrite added values on original combinations", () => {
    const matrix = { "node-version": ["22"], include: [{ shard: 2 }, { shard: 1 }] };
    expect(effectiveMatrix(matrix)).toEqual([{ "node-version": "22", shard: 1 }]);
    expect(shardValues(matrix)).toEqual([1]);
    expect(() => verifyWorkflowMatrix(`jobs:\n  test-unit:\n    strategy:\n      matrix: ${JSON.stringify(matrix)}`)).toThrow("missing lane shards: 2");
  });

  test("includes that conflict with originals add separate combinations", () => {
    expect(effectiveMatrix({ fruit: ["apple", "pear"], include: [{ color: "green" }, { color: "pink", fruit: "apple" }, { fruit: "banana" }, { fruit: "banana", color: "yellow" }] })).toEqual([
      { fruit: "apple", color: "pink" }, { fruit: "pear", color: "green" },
      { fruit: "banana" }, { fruit: "banana", color: "yellow" },
    ]);
    expect(effectiveMatrix({ include: [{ shard: 2 }, { shard: 1 }] })).toEqual([{ shard: 2 }, { shard: 1 }]);
    expect(effectiveMatrix({ shard: [1, 2], exclude: [{ shard: 2 }], include: [{ shard: 2 }] })).toEqual([{ shard: 1 }, { shard: 2 }]);
  });

  test("--shard/--of are accepted by the runner's own argument parser", () => {
    expect(parseUnitLaneArgs(["--shard", "2", "--of", "2"], {})).toEqual({ list: false, keepGoing: false, shard: { index: 2, of: 2 } });
    expect(parseUnitLaneArgs(["--keep-going", "--shard", "1", "--of", "2"], {}).shard).toEqual({ index: 1, of: 2 });
    expect(() => parseUnitLaneArgs(["--shard", "3", "--of", "2"], {})).toThrow();
    expect(() => parseUnitLaneArgs(["--of", "2"], {})).toThrow();
    expect(() => parseUnitLaneArgs(["--shard", "x"], {})).toThrow();
  });

  test("the runner selects the shared setup plus one shard's steps", () => {
    const plan = unitPlan(ROOT);
    for (const [index, shard] of laneShardPlans(plan, LANE_SHARDS).entries()) {
      const result = spawnSync(process.execPath, ["scripts/test-unit.ts", "--list", "--shard", String(index + 1), "--of", "2"], {
        cwd: ROOT, encoding: "utf8", timeout: 20_000,
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(shard.map(step => ({
        ...step,
        cwd: relative(ROOT, step.cwd) || ".",
        files: step.files.map(file => relative(ROOT, file)),
      })));
    }
  });
});
