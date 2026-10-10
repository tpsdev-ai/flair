import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { load as loadYaml } from "js-yaml";
import {
  ROOT, SHARDS, assignShards, coverageReport, listUnitFiles, shardFiles, verifyShards,
} from "../../scripts/ci/unit-shards.mjs";
import { unitPlan } from "../../scripts/test-unit.ts";
import { testFilesUnder } from "../../scripts/ci/check-cli-spawn-budgets.mjs";

const ALL = listUnitFiles();
const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const SUFFIXES = [".test", "_test", ".spec", "_spec"];
const EXTENSIONS = ["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"];
const DIRS = ["test", "test/unit", "test/unit/nested"];
const FIXTURE_FILES = DIRS.flatMap(dir => SUFFIXES.flatMap(suffix =>
  EXTENSIONS.map(extension => `${dir}/sample${suffix}.${extension}`)));

function fixtureRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flair-shard-fixture-")));
  fixtures.push(root);
  mkdirSync(join(root, "scripts/ci"), { recursive: true });
  mkdirSync(join(root, "test/unit/nested"), { recursive: true });
  for (const file of FIXTURE_FILES) writeFileSync(join(root, file), "");
  writeFileSync(join(root, "test/unit/not-a-test.ts"), "");
  cpSync(join(ROOT, "scripts/ci/test-files.mjs"), join(root, "scripts/ci/test-files.mjs"));
  cpSync(join(ROOT, "scripts/ci/unit-shards.mjs"), join(root, "scripts/ci/unit-shards.mjs"));
  return root;
}

// An independent enumeration (shell find) filtered by Bun's documented test
// filename patterns, checked against the module's own discovery (flair#2288).
const BUN_TEST_NAME = /(?:\.test|_test|\.spec|_spec)\.(?:[cm]?[jt]s|[jt]sx)$/i;

function findFiles(): string[] {
  const r = spawnSync("bash", ["-c", "{ find test/unit -type f; find test -maxdepth 1 -type f; } | LC_ALL=C sort"], {
    cwd: ROOT, encoding: "utf8", timeout: 15_000,
  });
  if (r.status !== 0) throw new Error(`find failed: ${r.stderr}`);
  return r.stdout.split("\n").filter(file => BUN_TEST_NAME.test(file)).sort();
}

describe("unit-shards — discovery", () => {
  test("matches independent discovery", () => {
    expect(ALL).toEqual(findFiles());
    expect(ALL.length).toBeGreaterThan(0);
  });

  test("includes every runner suffix and extension at both root boundaries", () => {
    const root = fixtureRoot();
    const expected = [...FIXTURE_FILES].sort();
    expect(listUnitFiles(root)).toEqual(expected);
    expect(testFilesUnder(root).map(file => relative(root, file))).toEqual(expected);
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
          for (const file of FIXTURE_FILES.filter(file => file.startsWith(`${dir}/sample`))) {
            rmSync(join(root, file));
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

const WORKFLOW_DIR = join(ROOT, ".github", "workflows");
const REQUIRED_UNIT_CHECK = "Unit Tests";
const GATE_STEP = "Verify root unit shard coverage";
const GATE_COMMAND = "node scripts/ci/unit-shards.mjs --verify";
const ADAPTER_RUN = [
  'echo "test-unit matrix result: ${{ needs.test-unit.result }}"',
  'echo "test-darwin-gated result: ${{ needs.test-darwin-gated.result }}"',
  'if [ "${{ needs.test-unit.result }}" != "success" ]; then',
  'echo "::error::One or more Unit Tests Node-version legs did not succeed"',
  "exit 1",
  "fi",
  'if [ "${{ needs.test-darwin-gated.result }}" != "success" ]; then',
  'echo "::error::Darwin-gated unit tests did not succeed (flair#1012)"',
  "exit 1",
  "fi",
].join(" ");
const normalise = (text: string) => text.trim().replace(/\s+/g, " ");

type WorkflowStep = { name?: unknown; run?: unknown; if?: unknown; "continue-on-error"?: unknown };
type WorkflowJob = { name?: unknown; needs?: unknown; if?: unknown; "continue-on-error"?: unknown; steps?: WorkflowStep[] };
type WorkflowDoc = { jobs?: Record<string, WorkflowJob> };

function parseWorkflows(): WorkflowDoc[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .map((f) => loadYaml(readFileSync(join(WORKFLOW_DIR, f), "utf8")) as WorkflowDoc);
}

function requiredUnitJobs(doc: WorkflowDoc): Set<string> {
  const jobs = doc.jobs ?? {};
  const dependencies = new Map<string, string[]>();
  for (const [id, job] of Object.entries(jobs)) {
    const needs = job.needs;
    const deps = (Array.isArray(needs) ? needs : needs === undefined ? [] : [needs]).map(String);
    for (const dep of deps) {
      if (!Object.hasOwn(jobs, dep)) throw new Error(`job "${id}" needs missing job "${dep}" in its workflow`);
    }
    dependencies.set(id, deps);
  }
  const seen = new Set<string>();
  const stack = Object.entries(jobs).filter(([, job]) => job.name === REQUIRED_UNIT_CHECK).map(([id]) => id);
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(dependencies.get(id) ?? []));
  }
  return seen;
}

function checkCoverageGate(docs: WorkflowDoc[]): void {
  const required = new Map(docs.map((doc) => [doc, requiredUnitJobs(doc)]));
  const gates = docs.flatMap((doc) =>
    Object.entries(doc.jobs ?? {}).flatMap(([id, job]) =>
      (job.steps ?? []).filter((step) => step.name === GATE_STEP).map((step) => ({ doc, id, job, step })),
    ),
  );
  if (gates.length === 0) throw new Error(`no step is named "${GATE_STEP}"`);
  const gated = gates.filter(({ doc, id }) => required.get(doc)?.has(id));
  if (gated.length === 0) throw new Error(`"${GATE_STEP}" runs in no job the required "${REQUIRED_UNIT_CHECK}" check depends on in the same workflow`);
  for (const { id, job, step } of gated) {
    if ("if" in step) throw new Error(`"${GATE_STEP}" has if; it must be absent`);
    if ("continue-on-error" in step) throw new Error(`"${GATE_STEP}" has continue-on-error; it must be absent`);
    if (typeof step.run !== "string" || step.run.trim().replace(/\s+/g, " ") !== GATE_COMMAND) {
      throw new Error(`"${GATE_STEP}" must run exactly "${GATE_COMMAND}"`);
    }
    if ("if" in job) throw new Error(`the job "${id}" holding "${GATE_STEP}" has if; it must be absent`);
    if ("continue-on-error" in job) throw new Error(`the job "${id}" holding "${GATE_STEP}" has continue-on-error; it must be absent`);
  }
  for (const doc of docs) {
    for (const [id, job] of Object.entries(doc.jobs ?? {})) {
      if (job.name !== REQUIRED_UNIT_CHECK) continue;
      const label = `the required "${REQUIRED_UNIT_CHECK}" job "${id}"`;
      if ("continue-on-error" in job) throw new Error(`${label} has continue-on-error; it must be absent`);
      if (!("if" in job) || normalise(String(job.if).replace(/^\s*\$\{\{(.*)\}\}\s*$/s, "$1")) !== "always()") {
        throw new Error(`${label} must have if: always()`);
      }
      const steps = job.steps ?? [];
      if (steps.length !== 1) throw new Error(`${label} must have exactly one step`);
      const [step] = steps;
      if ("continue-on-error" in step) throw new Error(`${label} has a step with continue-on-error; it must be absent`);
      if ("if" in step) throw new Error(`${label} has a step with if; it must be absent`);
      if (typeof step.run !== "string" || normalise(step.run) !== ADAPTER_RUN) {
        throw new Error(`${label} must run the canonical adapter script`);
      }
    }
  }
}

function mutateAdapter(edit: (job: WorkflowJob, step: WorkflowStep) => void): WorkflowDoc[] {
  const doc = loadYaml(readFileSync(join(WORKFLOW_DIR, "test.yml"), "utf8")) as WorkflowDoc;
  const job = doc.jobs?.["test-unit-gate"];
  const step = job?.steps?.[0];
  if (!job || !step) throw new Error("fixture drift: test-unit-gate job or step not found");
  edit(job, step);
  return [doc];
}

function mutateWorkflow(edit: (doc: WorkflowDoc, job: WorkflowJob, step: WorkflowStep) => void): WorkflowDoc[] {
  const doc = loadYaml(readFileSync(join(WORKFLOW_DIR, "test.yml"), "utf8")) as WorkflowDoc;
  const job = doc.jobs?.["test-unit"];
  const step = job?.steps?.find((step) => step.name === GATE_STEP);
  if (!job || !step) throw new Error("fixture drift: gate step or test-unit job not found");
  edit(doc, job, step);
  return [doc];
}

describe("root-unit shard coverage gate workflow shape", () => {
  test("the committed workflows satisfy the checker", () => {
    expect(() => checkCoverageGate(parseWorkflows())).not.toThrow();
  });

  test("the canonical command accepts normalised whitespace", () => {
    const mutated = mutateWorkflow((_doc, _job, step) => { step.run = "  node\t scripts/ci/unit-shards.mjs\n --verify  "; });
    expect(() => checkCoverageGate(mutated)).not.toThrow();
  });

  const runError = `"${GATE_STEP}" must run exactly "${GATE_COMMAND}"`;
  const stepIfError = `"${GATE_STEP}" has if; it must be absent`;
  const stepContinueError = `"${GATE_STEP}" has continue-on-error; it must be absent`;
  const jobIfError = `the job "test-unit" holding "${GATE_STEP}" has if; it must be absent`;
  const jobContinueError = `the job "test-unit" holding "${GATE_STEP}" has continue-on-error; it must be absent`;
  const dependencyError = `"${GATE_STEP}" runs in no job the required "${REQUIRED_UNIT_CHECK}" check depends on in the same workflow`;
  const adapter = `the required "${REQUIRED_UNIT_CHECK}" job "test-unit-gate"`;
  const cases: [string, () => WorkflowDoc[], string][] = [
    ["adapter step continue-on-error", () => mutateAdapter((_job, step) => { step["continue-on-error"] = true; }), `${adapter} has a step with continue-on-error; it must be absent`],
    ["adapter job continue-on-error", () => mutateAdapter((job) => { job["continue-on-error"] = true; }), `${adapter} has continue-on-error; it must be absent`],
    ["adapter job if: false", () => mutateAdapter((job) => { job.if = false; }), `${adapter} must have if: always()`],
    ["adapter job without if: always()", () => mutateAdapter((job) => { delete job.if; }), `${adapter} must have if: always()`],
    ["adapter step if: false", () => mutateAdapter((_job, step) => { step.if = false; }), `${adapter} has a step with if; it must be absent`],
    ["adapter emptied run", () => mutateAdapter((_job, step) => { step.run = ""; }), `${adapter} must run the canonical adapter script`],
    ["adapter altered run", () => mutateAdapter((_job, step) => { step.run = String(step.run).replace("exit 1", "exit 0"); }), `${adapter} must run the canonical adapter script`],
    ["rename the step", () => mutateWorkflow((_doc, _job, step) => { step.name = "Verify coverage"; }), `no step is named "${GATE_STEP}"`],
    ["drop --verify", () => mutateWorkflow((_doc, _job, step) => { step.run = "node scripts/ci/unit-shards.mjs"; }), runError],
    ...[
      ["echo", `echo ${GATE_COMMAND}`],
      ["commented-out command", `# ${GATE_COMMAND}`],
      ["|| true", `${GATE_COMMAND} || true`],
      ["; exit 0", `${GATE_COMMAND}; exit 0`],
      ["extra argument", `${GATE_COMMAND} --of 1`],
    ].map(([label, run]): [string, () => WorkflowDoc[], string] => [
      label, () => mutateWorkflow((_doc, _job, step) => { step.run = run; }), runError,
    ]),
    ...[false, true, "${{ !true }}"].flatMap((condition): [string, () => WorkflowDoc[], string][] => [
      [`step if: ${condition}`, () => mutateWorkflow((_doc, _job, step) => { step.if = condition; }), stepIfError],
      [`job if: ${condition}`, () => mutateWorkflow((_doc, job) => { job.if = condition; }), jobIfError],
    ]),
    ...[true, false].flatMap((value): [string, () => WorkflowDoc[], string][] => [
      [`step continue-on-error: ${value}`, () => mutateWorkflow((_doc, _job, step) => { step["continue-on-error"] = value; }), stepContinueError],
      [`job continue-on-error: ${value}`, () => mutateWorkflow((_doc, job) => { job["continue-on-error"] = value; }), jobContinueError],
    ]),
    ["move to doclint", () => mutateWorkflow((doc, job, step) => {
      const to = doc.jobs?.doclint;
      if (!job.steps || !to) throw new Error("fixture drift: doclint job not found");
      job.steps.splice(job.steps.indexOf(step), 1);
      to.steps = [...(to.steps ?? []), step];
    }), dependencyError],
    ["needs target absent from its workflow", () => mutateWorkflow((_doc, job) => {
      job.needs = "missing-unit-job";
    }), 'job "test-unit" needs missing job "missing-unit-job" in its workflow'],
    ["gate moved across workflows with duplicate job ids", () => {
      let gate: WorkflowStep | undefined;
      const [required] = mutateWorkflow((_doc, job, step) => {
        if (!job.steps) throw new Error("fixture drift: gate steps not found");
        job.steps.splice(job.steps.indexOf(step), 1);
        gate = step;
      });
      if (!gate) throw new Error("fixture drift: gate not captured");
      const unrelated: WorkflowDoc = { jobs: {
        "test-unit": { steps: [gate] },
        "unrelated-gate": { name: "Unrelated check", needs: "test-unit" },
      } };
      return [required, unrelated];
    }, dependencyError],
    ["needs target exists only in another workflow", () => {
      const docs = mutateWorkflow((_doc, job) => { job.needs = "other-workflow-job"; });
      return [...docs, { jobs: { "other-workflow-job": { steps: [] } } }];
    }, 'job "test-unit" needs missing job "other-workflow-job" in its workflow'],
  ];
  for (const [label, build, error] of cases) {
    test(`refuses ${label}`, () => {
      const mutated = build();
      expect(() => checkCoverageGate(mutated)).toThrow(error);
    });
  }
});
