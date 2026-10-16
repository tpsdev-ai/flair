// The workflow coverage-gate checker's own fixtures (flair#2480).

import { describe, expect, test } from "bun:test";
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
