import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { load as loadYaml } from "js-yaml";
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
    const result = spawnSync("node", [join(root, "scripts/ci/unit-shards.mjs"), "--verify", "--of", "1"], {
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

  test("matches the file arguments passed to Bun by the shared lane's shard steps", () => {
    const steps = unitPlan(ROOT).filter(step => step.shard !== undefined);
    for (const step of steps) expect(step.args).toEqual(["test", ...step.files]);
    const laneFiles = steps.flatMap(step => step.args.slice(1).map(file => relative(ROOT, file))).sort();
    expect(laneFiles).toEqual(ALL);
  });

  test("real Bun executes only the shard's assigned fixture files", () => {
    const root = fixtureRoot();
    rmSync(join(root, "test"), { recursive: true });
    for (const file of ["test/selected.test.ts", "test/unit/selected.test.ts", "packages/flair-client/test/unit/selected.test.ts"]) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), `import { test } from "bun:test"; test(${JSON.stringify(`FILE:${file}`)}, () => { console.log(${JSON.stringify(`EXECUTED:${file}`)}); });`);
    }
    const requiredDirs = ["test/unit-isolated", ...unitPlan(ROOT).filter(step => step.cwd !== ROOT).map(step => relative(ROOT, join(step.cwd, "test"))), "packages/adk-flair-js/test/unit"];
    for (const dir of requiredDirs) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, "placeholder.test.ts"), "");
    }
    const steps = unitPlan(root).filter(step => step.shard !== undefined && step.files.length);
    for (const dir of new Set(requiredDirs)) rmSync(join(root, dir, "placeholder.test.ts"));
    for (const step of steps) {
      const result = spawnSync(process.execPath, step.args, { cwd: root, encoding: "utf8", timeout: 20_000 });
      expect(result.status).toBe(0);
      const executed = result.stdout.split("\n").filter(line => line.startsWith("EXECUTED:")).map(line => line.slice("EXECUTED:".length)).sort();
      expect(executed).toEqual(step.files.map(file => relative(root, file)).sort());
      expect(result.stderr).toContain(`${step.files.length} pass`);
      expect(result.stderr).toContain("0 fail");
    }
  }, 30_000);
});

describe("unit-shards — assignment", () => {
  for (const of of [1, 2, 3, 4, 7]) {
    test(`${of} shards partition the discovered files`, () => {
      expect(verifyShards(of, ALL)).toEqual({
        total: ALL.length, covered: ALL.length, missing: [], duplicated: [], unknown: [], empty: [],
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

  test("--verify rejects empty shards in a valid small corpus", () => {
    const root = fixtureRoot();
    rmSync(join(root, "test"), { recursive: true });
    mkdirSync(join(root, "test/unit"), { recursive: true });
    writeFileSync(join(root, "test/root.test.ts"), "");
    writeFileSync(join(root, "test/unit/child.test.ts"), "");
    const files = listUnitFiles(root);
    const empty = assignShards(files, SHARDS).flatMap((files, index) => files.length ? [] : [index + 1]);
    expect(empty.length).toBeGreaterThan(0);
    expect(verifyShards(SHARDS, files).empty).toEqual(empty);
    const result = spawnSync("node", [join(root, "scripts/ci/unit-shards.mjs"), "--verify"], { cwd: root, encoding: "utf8", timeout: 20_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`empty shards: ${empty.join(", ")}`);
  });

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

});

// The coverage gate has to actually gate. A substring match over the workflow file
// passes on a step that is disabled or moved out of the required job. Read the
// parsed job instead: the gate has to be an enabled step, named as such and passing
// the enforcing flag, of a job the required "Unit Tests" check depends on
// (flair#2289).
const WORKFLOW_DIR = join(ROOT, ".github", "workflows");
/** The branch-protection context for unit tests; its `needs` are the unit jobs. */
const REQUIRED_UNIT_CHECK = "Unit Tests";
/** The step that runs the root-unit shard coverage gate, and how it enforces. */
const GATE_STEP = "Verify root unit shard coverage";
const GATE_SCRIPT = "scripts/ci/unit-shards.mjs";
const GATE_FLAG = "--verify";

type WorkflowStep = { name?: unknown; run?: unknown; if?: unknown; "continue-on-error"?: unknown };
type WorkflowJob = { name?: unknown; needs?: unknown; if?: unknown; steps?: WorkflowStep[] };
type WorkflowDoc = { jobs?: Record<string, WorkflowJob> };

function parseWorkflows(): WorkflowDoc[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .map((f) => loadYaml(readFileSync(join(WORKFLOW_DIR, f), "utf8")) as WorkflowDoc);
}

/** Job ids the required unit check depends on, transitively, including itself. */
function requiredUnitJobs(...docs: WorkflowDoc[]): Set<string> {
  const jobs: Record<string, WorkflowJob> = {};
  for (const doc of docs) Object.assign(jobs, doc.jobs ?? {});
  const seen = new Set<string>();
  const stack = Object.entries(jobs).filter(([, job]) => job.name === REQUIRED_UNIT_CHECK).map(([id]) => id);
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const needs = jobs[id]?.needs;
    for (const dep of Array.isArray(needs) ? needs : needs ? [needs] : []) stack.push(String(dep));
  }
  return seen;
}

/** Whether a step/job `if` is a literal false. */
function neverRuns(condition: unknown): boolean {
  if (condition === false || condition === 0) return true;
  if (typeof condition !== "string") return false;
  const expr = condition.replace(/[${}\s]/g, "").toLowerCase();
  return expr === "false" || expr === "0";
}

/** Throws unless the gate step is enabled, enforcing and in a job the required unit check depends on. */
function checkCoverageGate(...docs: WorkflowDoc[]): void {
  const required = requiredUnitJobs(...docs);
  const gates = docs.flatMap((doc) =>
    Object.entries(doc.jobs ?? {}).flatMap(([id, job]) =>
      (job.steps ?? []).filter((step) => step.name === GATE_STEP).map((step) => ({ id, job, step })),
    ),
  );
  if (gates.length === 0) throw new Error(`no step is named "${GATE_STEP}"`);
  const gated = gates.filter(({ id }) => required.has(id));
  if (gated.length === 0) throw new Error(`"${GATE_STEP}" runs in no job the required "${REQUIRED_UNIT_CHECK}" check depends on`);
  for (const { id, job, step } of gated) {
    if (neverRuns(step.if)) throw new Error(`"${GATE_STEP}" is disabled by its if`);
    if (step["continue-on-error"] ?? false) throw new Error(`"${GATE_STEP}" has continue-on-error`);
    const args = String(step.run ?? "").trim().split(/\s+/).filter(Boolean);
    if (!args.includes(GATE_SCRIPT)) throw new Error(`"${GATE_STEP}" does not run ${GATE_SCRIPT}`);
    if (!args.includes(GATE_FLAG)) throw new Error(`"${GATE_STEP}" does not pass ${GATE_FLAG}`);
    if (neverRuns(job.if)) throw new Error(`the job "${id}" holding "${GATE_STEP}" is disabled by its if`);
  }
}

/** The committed workflow with one mutation applied to a text copy. */
function mutateWorkflow(edit: (text: string) => string): WorkflowDoc {
  const before = readFileSync(join(WORKFLOW_DIR, "test.yml"), "utf8");
  const after = edit(before);
  if (after === before) throw new Error("the mutation changed nothing");
  return loadYaml(after) as WorkflowDoc;
}

describe("the root-unit shard coverage gate is an enabled step of the required unit job", () => {
  test("the committed workflow satisfies the gate's required shape", () => {
    expect(() => checkCoverageGate(...parseWorkflows())).not.toThrow();
  });

  test("a renamed, disabled, continued, relocated or under-argumented gate is refused", () => {
    const cases: [string, () => WorkflowDoc][] = [
      ["rename the step", () => mutateWorkflow((t) => t.replace(`name: ${GATE_STEP}`, "name: Verify coverage"))],
      ["continue on error", () => mutateWorkflow((t) => t.replace(
        `        run: node ${GATE_SCRIPT} ${GATE_FLAG}\n`,
        `        run: node ${GATE_SCRIPT} ${GATE_FLAG}\n        continue-on-error: true\n`,
      ))],
      ["if: false", () => mutateWorkflow((t) => t.replace(
        `      - name: ${GATE_STEP}\n`,
        `      - name: ${GATE_STEP}\n        if: false\n`,
      ))],
      ["drop the enforcing flag", () => mutateWorkflow((t) => t.replace(
        `        run: node ${GATE_SCRIPT} ${GATE_FLAG}\n`,
        `        run: node ${GATE_SCRIPT}\n`,
      ))],
      ["move to a job the check does not require", () => {
        const doc = loadYaml(readFileSync(join(WORKFLOW_DIR, "test.yml"), "utf8")) as WorkflowDoc;
        const from = doc.jobs?.["test-unit"];
        const to = doc.jobs?.["doclint"];
        const at = (from?.steps ?? []).findIndex((step) => step.name === GATE_STEP);
        if (!from?.steps || !to || at < 0) throw new Error("fixture drift: gate step or doclint job not found");
        to.steps = [...(to.steps ?? []), ...from.steps.splice(at, 1)];
        return doc;
      }],
    ];
    for (const [label, build] of cases) {
      expect(() => checkCoverageGate(build()), label).toThrow();
    }
  });
});
