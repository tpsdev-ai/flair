/**
 * workflow-gate.ts — assert a CI gate step from the workflow's parsed job graph
 * instead of from a substring of its text (flair#2289, flair#2419).
 *
 * `checkCoverageGate` is a whitelist: the gate step must run exactly its
 * command, with no `if` and no `continue-on-error` on the step or its job, in a
 * job the required check reaches through `needs` within the same workflow, and
 * the required check's own job must be the canonical `if: always()` adapter.
 * `gateCases` builds the negative cases a test feeds back to the checker.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";

export type WorkflowStep = { name?: unknown; run?: unknown; if?: unknown; "continue-on-error"?: unknown };
export type WorkflowJob = { name?: unknown; needs?: unknown; if?: unknown; "continue-on-error"?: unknown; steps?: WorkflowStep[] };
export type WorkflowDoc = { jobs?: Record<string, WorkflowJob> };

export type Gate = {
  /** The `name:` of the step that runs the gate. */
  step: string;
  /** The exact command the gate step runs (whitespace-normalised). */
  command: string;
};

export const REQUIRED_UNIT_CHECK = "Unit Tests";
export const WORKFLOW_FILE = "test.yml";
const ADAPTER_JOB = "test-unit-gate";
const GATE_JOB = "test-unit";
const OTHER_JOB = "doclint";

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

/** Parse the `.yml`/`.yaml` files in `dir`, sorted by file name. */
export function parseWorkflows(dir: string): WorkflowDoc[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .map((f) => loadYaml(readFileSync(join(dir, f), "utf8")) as WorkflowDoc);
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

/** Throws unless `gate` is a canonical, enabled step of a job the required check depends on. */
export function checkCoverageGate(docs: WorkflowDoc[], gate: Gate): void {
  const required = new Map(docs.map((doc) => [doc, requiredUnitJobs(doc)]));
  const gates = docs.flatMap((doc) =>
    Object.entries(doc.jobs ?? {}).flatMap(([id, job]) =>
      (job.steps ?? []).filter((step) => step.name === gate.step).map((step) => ({ doc, id, job, step })),
    ),
  );
  if (gates.length === 0) throw new Error(`no step is named "${gate.step}"`);
  const gated = gates.filter(({ doc, id }) => required.get(doc)?.has(id));
  if (gated.length === 0) throw new Error(`"${gate.step}" runs in no job the required "${REQUIRED_UNIT_CHECK}" check depends on in the same workflow`);
  for (const { id, job, step } of gated) {
    if ("if" in step) throw new Error(`"${gate.step}" has if; it must be absent`);
    if ("continue-on-error" in step) throw new Error(`"${gate.step}" has continue-on-error; it must be absent`);
    if (typeof step.run !== "string" || step.run.trim().replace(/\s+/g, " ") !== gate.command) {
      throw new Error(`"${gate.step}" must run exactly "${gate.command}"`);
    }
    if ("if" in job) throw new Error(`the job "${id}" holding "${gate.step}" has if; it must be absent`);
    if ("continue-on-error" in job) throw new Error(`the job "${id}" holding "${gate.step}" has continue-on-error; it must be absent`);
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

export type GateCase = [label: string, build: () => WorkflowDoc[], error: string];

/** A parsed copy of the committed workflow with `edit` applied to the adapter job and its step. */
function mutateAdapter(dir: string, edit: (job: WorkflowJob, step: WorkflowStep) => void): WorkflowDoc[] {
  const doc = loadYaml(readFileSync(join(dir, WORKFLOW_FILE), "utf8")) as WorkflowDoc;
  const job = doc.jobs?.[ADAPTER_JOB];
  const step = job?.steps?.[0];
  if (!job || !step) throw new Error(`fixture drift: ${ADAPTER_JOB} job or step not found`);
  edit(job, step);
  return [doc];
}

/** A parsed copy of the committed workflow with `edit` applied to the gate step, its job and the document. */
function mutateWorkflow(dir: string, gate: Gate, edit: (doc: WorkflowDoc, job: WorkflowJob, step: WorkflowStep) => void): WorkflowDoc[] {
  const doc = loadYaml(readFileSync(join(dir, WORKFLOW_FILE), "utf8")) as WorkflowDoc;
  const job = doc.jobs?.[GATE_JOB];
  const step = job?.steps?.find((step) => step.name === gate.step);
  if (!job || !step) throw new Error(`fixture drift: gate step or ${GATE_JOB} job not found`);
  edit(doc, job, step);
  return [doc];
}

/** The committed workflow with the gate command respaced by tabs and newlines. */
export function respacedGate(dir: string, gate: Gate): WorkflowDoc[] {
  return mutateWorkflow(dir, gate, (_doc, _job, step) => { step.run = `  ${gate.command.replace(/ /g, "\t \n ")}  `; });
}

/** Every negative case for `gate`, each with the error the checker has to throw. */
export function gateCases(dir: string, gate: Gate): GateCase[] {
  const mutate = (edit: (doc: WorkflowDoc, job: WorkflowJob, step: WorkflowStep) => void) => () => mutateWorkflow(dir, gate, edit);
  const adapt = (edit: (job: WorkflowJob, step: WorkflowStep) => void) => () => mutateAdapter(dir, edit);
  const runError = `"${gate.step}" must run exactly "${gate.command}"`;
  const stepIfError = `"${gate.step}" has if; it must be absent`;
  const stepContinueError = `"${gate.step}" has continue-on-error; it must be absent`;
  const jobIfError = `the job "${GATE_JOB}" holding "${gate.step}" has if; it must be absent`;
  const jobContinueError = `the job "${GATE_JOB}" holding "${gate.step}" has continue-on-error; it must be absent`;
  const dependencyError = `"${gate.step}" runs in no job the required "${REQUIRED_UNIT_CHECK}" check depends on in the same workflow`;
  const adapter = `the required "${REQUIRED_UNIT_CHECK}" job "${ADAPTER_JOB}"`;
  return [
    ["adapter step continue-on-error", adapt((_job, step) => { step["continue-on-error"] = true; }), `${adapter} has a step with continue-on-error; it must be absent`],
    ["adapter job continue-on-error", adapt((job) => { job["continue-on-error"] = true; }), `${adapter} has continue-on-error; it must be absent`],
    ["adapter job if: false", adapt((job) => { job.if = false; }), `${adapter} must have if: always()`],
    ["adapter job without if: always()", adapt((job) => { delete job.if; }), `${adapter} must have if: always()`],
    ["adapter step if: false", adapt((_job, step) => { step.if = false; }), `${adapter} has a step with if; it must be absent`],
    ["adapter emptied run", adapt((_job, step) => { step.run = ""; }), `${adapter} must run the canonical adapter script`],
    ["adapter altered run", adapt((_job, step) => { step.run = String(step.run).replace("exit 1", "exit 0"); }), `${adapter} must run the canonical adapter script`],
    ["rename the step", mutate((_doc, _job, step) => { step.name = "Verify coverage"; }), `no step is named "${gate.step}"`],
    ["drop --verify", mutate((_doc, _job, step) => { step.run = gate.command.replace(" --verify", ""); }), runError],
    ["drop the last argument", mutate((_doc, _job, step) => { step.run = gate.command.split(" ").slice(0, -1).join(" "); }), runError],
    ...[
      ["echo", `echo ${gate.command}`],
      ["commented-out command", `# ${gate.command}`],
      ["|| true", `${gate.command} || true`],
      ["; exit 0", `${gate.command}; exit 0`],
      ["extra argument", `${gate.command} --extra`],
    ].map(([label, run]): GateCase => [label, mutate((_doc, _job, step) => { step.run = run; }), runError]),
    ...[false, true, "${{ !true }}"].flatMap((condition): GateCase[] => [
      [`step if: ${condition}`, mutate((_doc, _job, step) => { step.if = condition; }), stepIfError],
      [`job if: ${condition}`, mutate((_doc, job) => { job.if = condition; }), jobIfError],
    ]),
    ...[true, false].flatMap((value): GateCase[] => [
      [`step continue-on-error: ${value}`, mutate((_doc, _job, step) => { step["continue-on-error"] = value; }), stepContinueError],
      [`job continue-on-error: ${value}`, mutate((_doc, job) => { job["continue-on-error"] = value; }), jobContinueError],
    ]),
    ["move to doclint", mutate((doc, job, step) => {
      const to = doc.jobs?.[OTHER_JOB];
      if (!job.steps || !to) throw new Error(`fixture drift: ${OTHER_JOB} job not found`);
      job.steps.splice(job.steps.indexOf(step), 1);
      to.steps = [...(to.steps ?? []), step];
    }), dependencyError],
    ["needs target absent from its workflow", mutate((_doc, job) => {
      job.needs = "missing-unit-job";
    }), `job "${GATE_JOB}" needs missing job "missing-unit-job" in its workflow`],
    ["gate moved across workflows with duplicate job ids", () => {
      let moved: WorkflowStep | undefined;
      const [required] = mutateWorkflow(dir, gate, (_doc, job, step) => {
        if (!job.steps) throw new Error("fixture drift: gate steps not found");
        job.steps.splice(job.steps.indexOf(step), 1);
        moved = step;
      });
      if (!moved) throw new Error("fixture drift: gate not captured");
      const unrelated: WorkflowDoc = { jobs: {
        [GATE_JOB]: { steps: [moved] },
        "unrelated-gate": { name: "Unrelated check", needs: GATE_JOB },
      } };
      return [required, unrelated];
    }, dependencyError],
    ["needs target exists only in another workflow", () => {
      const docs = mutateWorkflow(dir, gate, (_doc, job) => { job.needs = "other-workflow-job"; });
      return [...docs, { jobs: { "other-workflow-job": { steps: [] } } }];
    }, `job "${GATE_JOB}" needs missing job "other-workflow-job" in its workflow`],
  ];
}
