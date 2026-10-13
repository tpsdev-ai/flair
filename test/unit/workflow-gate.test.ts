// The workflow coverage-gate checker's own fixtures (flair#2480).
//
// `checkCoverageGate` refuses a gate that would not actually execute and fail
// the required check: a step, job or workflow shell override on the gate or on
// the `Unit Tests` adapter; a gate outside the job the adapter reaches through
// `needs`; and an `if:` or `continue-on-error` on the step or its job. Each
// fixture below is one such refusal (one workflow file per refusal);
// `accepted.yml` is none.

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

  for (const [name, error] of [
    ["refused-shell-step.yml", `"${GATE.step}" has shell; it must run under the default shell`],
    ["refused-shell-job.yml", `the job "test-unit" holding "${GATE.step}" sets defaults.run.shell; it must run under the default shell`],
    ["refused-shell-workflow.yml", "the workflow sets defaults.run.shell; the gate must run under the default shell"],
    ["refused-adapter-shell-step.yml", `the required "Unit Tests" job "test-unit-gate" has a step with shell; it must run under the default shell`],
    ["refused-adapter-shell-job.yml", `the required "Unit Tests" job "test-unit-gate" sets defaults.run.shell; it must run under the default shell`],
    ["refused-unchecked-job.yml", `"${GATE.step}" runs in no job the required "Unit Tests" check depends on in the same workflow`],
    ["refused-skip-if.yml", `"${GATE.step}" has if; it must be absent`],
    ["refused-continue-on-error.yml", `"${GATE.step}" has continue-on-error; it must be absent`],
  ] as const) {
    test(`refuses ${name}`, () => {
      expect(() => checkCoverageGate(fixture(name), GATE)).toThrow(error);
    });
  }
});
