// The workflow coverage-gate checker's own fixtures (flair#2480).

import { shellScript } from "../helpers/shell-script.ts";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { ROOT } from "../../scripts/ci/lane-shards.mjs";
import { checkCoverageGate, type Gate, type WorkflowDoc } from "../helpers/workflow-gate";

const FIXTURES = join(ROOT, "test", "fixtures", "workflow-gate");
const GATE: Gate = {
  step: "Verify root unit shard coverage",
  command: "node scripts/ci/unit-shards.mjs --verify",
};

function fixture(name: string): WorkflowDoc[] {
  return [loadYaml(readFileSync(join(FIXTURES, name), "utf8")) as WorkflowDoc];
}

describe("workflow coverage-gate checker — fixtures", () => {
  test("accepts the canonical gate", () => {
    expect(() => checkCoverageGate(fixture("accepted.yml"), GATE)).not.toThrow();
  });

  for (const on of [
    "pull_request",
    ["push", "pull_request"],
    { pull_request: null },
    { pull_request: {} },
    { pull_request: { branches: ["main"] } },
    { pull_request: { types: ["opened", "synchronize", "reopened", "ready_for_review"] } },
  ]) {
    test(`accepts trigger ${JSON.stringify(on)}`, () => {
      const docs = fixture("accepted.yml");
      docs[0].on = on;
      expect(() => checkCoverageGate(docs, GATE)).not.toThrow();
    });
  }

  for (const on of [undefined, "push", ["push"], { pull_request: false }, { pull_request: [] }]) {
    test(`refuses trigger ${JSON.stringify(on)}`, () => {
      const docs = fixture("accepted.yml");
      docs[0].on = on;
      expect(() => checkCoverageGate(docs, GATE)).toThrow();
    });
  }

  for (const [name, error] of [
    ["refused-shell-step.yml", `"${GATE.step}" has shell; it must run under the default shell`],
    ["refused-shell-job.yml", `the job "test-unit" holding "${GATE.step}" sets defaults.run.shell; it must run under the default shell`],
    ["refused-shell-workflow.yml", "the workflow sets defaults.run.shell; the gate must run under the default shell"],
    ["refused-adapter-shell-step.yml", `the required "Unit Tests" job "test-unit-gate" has a step with shell; it must run under the default shell`],
    ["refused-adapter-shell-job.yml", `the required "Unit Tests" job "test-unit-gate" sets defaults.run.shell; it must run under the default shell`],
    ["refused-adapter-joined-exit.yml", `the required "Unit Tests" job "test-unit-gate" must run the canonical adapter script`],
    ["refused-unchecked-job.yml", `"${GATE.step}" runs in no job the required "Unit Tests" check depends on in the same workflow`],
    ["refused-skip-if.yml", `"${GATE.step}" has if; it must be absent`],
    ["refused-continue-on-error.yml", `"${GATE.step}" has continue-on-error; it must be absent`],
  ] as const) {
    test(`refuses ${name}`, () => {
      expect(() => checkCoverageGate(fixture(name), GATE)).toThrow(error);
    });
  }

  test("accepts the adapter script with re-indented, trailing-whitespace lines", () => {
    const docs = fixture("accepted.yml");
    const step = docs[0].jobs?.["test-unit-gate"]?.steps?.[0];
    if (typeof step?.run !== "string") throw new Error("fixture drift: adapter run not found");
    step.run = step.run.split("\n").map((line) => `\t${line}  `).join("\n");
    expect(() => checkCoverageGate(docs, GATE)).not.toThrow();
  });

  test("refuses a workflow-level shell override on a Unit Tests adapter in another workflow", () => {
    const docs = [...fixture("accepted.yml"), ...fixture("refused-adapter-shell-workflow.yml")];
    expect(() => checkCoverageGate(docs, GATE)).toThrow(
      `the workflow sets defaults.run.shell; the required "Unit Tests" job "test-unit-gate" must run under the default shell`,
    );
  });
});

// The adapter's control depends on Bash treating a newline as a command
// boundary: `exit 1` on its own line terminates the branch, but joined onto the
// preceding `echo` it is an argument to `echo` and the branch returns 0
// (flair#2584). Execute the real scripts to pin that behaviour.
const ADAPTER_JOB_ID = "test-unit-gate";
const ADAPTER_WORKFLOW = join(ROOT, ".github", "workflows", "test.yml");
const JOINED_FIXTURE = join(FIXTURES, "refused-adapter-joined-exit.yml");
const DEPENDENCY_EXPRESSION = String.raw`\$\{\{\s*needs\.([\w-]+)\.result\s*\}\}`;
const DEPENDENCY_RESULTS = ["success", "failure", "cancelled", "skipped"];

// Skip where bash is absent; CI has bash.
const HAS_BASH = !spawnSync("bash", ["--version"]).error;
const BASH_SKIP = HAS_BASH ? "" : " — skipped: bash is not available";

/** The adapter job's step script in the workflow at `path`. */
function adapterScript(path: string): string {
  const doc = loadYaml(readFileSync(path, "utf8")) as WorkflowDoc;
  const step = doc.jobs?.[ADAPTER_JOB_ID]?.steps?.[0];
  if (typeof step?.run !== "string") throw new Error(`fixture drift: adapter run not found in ${path}`);
  return step.run;
}

/** Every `needs.<job>.result` dependency the script branches on, deduplicated. */
function dependencyJobs(script: string): string[] {
  return [...new Set([...script.matchAll(new RegExp(DEPENDENCY_EXPRESSION, "g"))].map((match) => match[1]))];
}

/** `script` with each dependency expression replaced by its result in `results`. */
function substitute(script: string, results: Record<string, string>): string {
  return script.replace(new RegExp(DEPENDENCY_EXPRESSION, "g"), (_match, job: string) => {
    const result = results[job];
    if (result === undefined) throw new Error(`no result supplied for dependency "${job}"`);
    return result;
  });
}

/** Every assignment of a result to each job (the 4^jobs combinations). */
function resultCombinations(jobs: string[]): Record<string, string>[] {
  return jobs.reduce<Record<string, string>[]>((combos, job) => combos.flatMap((combo) => DEPENDENCY_RESULTS.map((result) => ({ ...combo, [job]: result }))), [{}]);
}

/** The adapter script as real `bash -e` would run it. */
function execute(script: string) {
  return spawnSync("bash", ["-e", shellScript(script)]);
}

describe("workflow coverage-gate checker — the adapter script on real bash", () => {
  test.skipIf(!HAS_BASH)(`exits 0 only when both dependencies succeed${BASH_SKIP}`, () => {
    const script = adapterScript(ADAPTER_WORKFLOW);
    const jobs = dependencyJobs(script);
    expect(jobs.sort()).toEqual(["test-darwin-gated", "test-unit"]);
    const wrong = resultCombinations(jobs)
      .map((results) => {
        const label = jobs.map((job) => `${job}=${results[job]}`).join(", ");
        const allSuccess = jobs.every((job) => results[job] === "success");
        const status = execute(substitute(script, results)).status;
        return { label, allSuccess, status };
      })
      .filter(({ allSuccess, status }) => (allSuccess ? status !== 0 : status === 0));
    expect(wrong).toEqual([]);
  });

  test.skipIf(!HAS_BASH)(`the joined fixture exits 0 for a failed unit dependency, and the checker refuses it${BASH_SKIP}`, () => {
    const script = adapterScript(JOINED_FIXTURE);
    const jobs = dependencyJobs(script);
    expect(jobs.sort()).toEqual(["test-darwin-gated", "test-unit"]);
    const failedUnit = { "test-unit": "failure", "test-darwin-gated": "success" };
    expect(execute(substitute(script, failedUnit)).status).toBe(0);
    expect(() => checkCoverageGate(fixture("refused-adapter-joined-exit.yml"), GATE)).toThrow(
      `the required "Unit Tests" job "${ADAPTER_JOB_ID}" must run the canonical adapter script`,
    );
  });
});
