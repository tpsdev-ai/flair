/**
 * workflow-gate.ts — assert a CI gate step from the workflow's parsed job graph
 * instead of from a substring of its text (flair#2289, flair#2419).
 *
 * Gates must cover every PR targeting main, run in directly result-checked
 * jobs, and use the canonical command and default shell without skip controls.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";

export type WorkflowStep = { env?: unknown; name?: unknown; run?: unknown; if?: unknown; "continue-on-error"?: unknown; shell?: unknown };
export type WorkflowJob = { env?: unknown; name?: unknown; needs?: unknown; if?: unknown; "continue-on-error"?: unknown; shell?: unknown; defaults?: { run?: { shell?: unknown } }; steps?: WorkflowStep[] };
export type WorkflowDoc = { env?: unknown; on?: unknown; defaults?: { run?: { shell?: unknown } }; jobs?: Record<string, WorkflowJob> };

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

const ADAPTER_RUN_LINES = [
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
];
const ADAPTER_RUN = ADAPTER_RUN_LINES.join(" ");
const RESULT_CHECKED_JOBS = new Set(
  [...ADAPTER_RUN.matchAll(/if \[ "\$\{\{ needs\.([\w-]+)\.result \}\}" != "success" \]; then/g)].map((match) => match[1]),
);
const normalise = (text: string) => text.trim().replace(/\s+/g, " ");
/** The script's commands, one per non-blank line, with surrounding whitespace trimmed. */
const scriptLines = (text: string) => text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
/**
 * Whether `run` is the canonical adapter script, compared command by command.
 * Each command must be on its own line: an `exit 1` joined onto the preceding
 * `echo` is a single `echo` command and is refused (flair#2584). Surrounding
 * whitespace on each line is trimmed, so indentation and trailing spaces are
 * accepted.
 */
const isCanonicalAdapterRun = (run: string) => {
  const lines = scriptLines(run);
  return lines.length === ADAPTER_RUN_LINES.length && lines.every((line, index) => line === ADAPTER_RUN_LINES[index]);
};

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

function checkPullRequestTrigger(doc: WorkflowDoc): void {
  const on = doc.on;
  const missing = "the gate workflow must have a pull_request trigger";
  if (typeof on === "string") {
    if (on !== "pull_request") throw new Error(missing);
    return;
  }
  if (Array.isArray(on)) {
    if (!on.includes("pull_request")) throw new Error(missing);
    return;
  }
  if (!on || typeof on !== "object" || !("pull_request" in on)) throw new Error(missing);
  const pr = on.pull_request;
  if (pr === null) return;
  if (!pr || typeof pr !== "object" || Array.isArray(pr)) throw new Error("pull_request must be a mapping or null");
  for (const filter of ["paths", "paths-ignore", "branches-ignore"]) {
    if (filter in pr) throw new Error(`pull_request must not set ${filter}`);
  }
  if ("branches" in pr && (!Array.isArray(pr.branches) || pr.branches.length !== 1 || pr.branches[0] !== "main")) {
    throw new Error("pull_request branches must be absent or exactly [main]");
  }
  const types = "types" in pr ? pr.types : undefined;
  if ("types" in pr && (!Array.isArray(types) || !["opened", "synchronize", "reopened"].every((type) => types.includes(type)))) {
    throw new Error("pull_request types must include opened, synchronize and reopened");
  }
}

/** Throws unless every gate is enabled for PRs targeting main and its job is result-checked. */
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
  for (const { doc, id, job, step } of gates) {
    checkPullRequestTrigger(doc);
    const checked = Object.values(doc.jobs ?? {}).some((adapter) =>
      adapter.name === REQUIRED_UNIT_CHECK && (Array.isArray(adapter.needs) ? adapter.needs : [adapter.needs]).includes(id),
    );
    if (!RESULT_CHECKED_JOBS.has(id) || !checked) throw new Error(`the gate job "${id}" must be directly result-checked by the required "${REQUIRED_UNIT_CHECK}" adapter`);
    for (const [scope, env] of [["gate step", step.env], ["gate job", job.env], ["workflow", doc.env]] as const) {
      for (const variable of ["FLAIR_DEP_MIN_AGE_DAYS", "FLAIR_DEP_KEEP_CURRENT", "FLAIR_NPM_REGISTRY", "FLAIR_CHECK_DEP_AGES_ROOT"]) {
        if (env !== null && typeof env === "object" && variable in env) {
          throw new Error(`the ${scope} env sets ${variable}; it must be absent`);
        }
      }
    }
    if ("if" in step) throw new Error(`"${gate.step}" has if; it must be absent`);
    if ("continue-on-error" in step) throw new Error(`"${gate.step}" has continue-on-error; it must be absent`);
    if ("shell" in step) throw new Error(`"${gate.step}" has shell; it must run under the default shell`);
    if (typeof step.run !== "string" || step.run.trim().replace(/\s+/g, " ") !== gate.command) {
      throw new Error(`"${gate.step}" must run exactly "${gate.command}"`);
    }
    if ("if" in job) throw new Error(`the job "${id}" holding "${gate.step}" has if; it must be absent`);
    if ("continue-on-error" in job) throw new Error(`the job "${id}" holding "${gate.step}" has continue-on-error; it must be absent`);
    if ("shell" in job) throw new Error(`the job "${id}" holding "${gate.step}" has shell; it must run under the default shell`);
    if (job.defaults?.run?.shell !== undefined) throw new Error(`the job "${id}" holding "${gate.step}" sets defaults.run.shell; it must run under the default shell`);
    if (doc.defaults?.run?.shell !== undefined) throw new Error(`the workflow sets defaults.run.shell; the gate must run under the default shell`);
  }
  for (const doc of docs) {
    for (const [id, job] of Object.entries(doc.jobs ?? {})) {
      if (job.name !== REQUIRED_UNIT_CHECK) continue;
      const label = `the required "${REQUIRED_UNIT_CHECK}" job "${id}"`;
      if ("continue-on-error" in job) throw new Error(`${label} has continue-on-error; it must be absent`);
      if ("shell" in job) throw new Error(`${label} has shell; it must run under the default shell`);
      if (job.defaults?.run?.shell !== undefined) throw new Error(`${label} sets defaults.run.shell; it must run under the default shell`);
      if (doc.defaults?.run?.shell !== undefined) throw new Error(`the workflow sets defaults.run.shell; ${label} must run under the default shell`);
      if (!("if" in job) || normalise(String(job.if).replace(/^\s*\$\{\{(.*)\}\}\s*$/s, "$1")) !== "always()") {
        throw new Error(`${label} must have if: always()`);
      }
      const steps = job.steps ?? [];
      if (steps.length !== 1) throw new Error(`${label} must have exactly one step`);
      const [step] = steps;
      if ("continue-on-error" in step) throw new Error(`${label} has a step with continue-on-error; it must be absent`);
      if ("if" in step) throw new Error(`${label} has a step with if; it must be absent`);
      if ("shell" in step) throw new Error(`${label} has a step with shell; it must run under the default shell`);
      if (typeof step.run !== "string" || !isCanonicalAdapterRun(step.run)) {
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
  const stepShellError = `"${gate.step}" has shell; it must run under the default shell`;
  const jobShellError = `the job "${GATE_JOB}" holding "${gate.step}" has shell; it must run under the default shell`;
  const jobDefaultsShellError = `the job "${GATE_JOB}" holding "${gate.step}" sets defaults.run.shell; it must run under the default shell`;
  const workflowDefaultsShellError = "the workflow sets defaults.run.shell; the gate must run under the default shell";
  const adapterStepShellError = `${adapter} has a step with shell; it must run under the default shell`;
  const adapterJobShellError = `${adapter} has shell; it must run under the default shell`;
  const adapterJobDefaultsShellError = `${adapter} sets defaults.run.shell; it must run under the default shell`;
  return [
    // Listed here, not shared with the check above, so dropping a variable from the check fails its cases.
    ...["FLAIR_DEP_MIN_AGE_DAYS", "FLAIR_DEP_KEEP_CURRENT", "FLAIR_NPM_REGISTRY", "FLAIR_CHECK_DEP_AGES_ROOT"].flatMap((variable): GateCase[] => [
      [`gate step env ${variable}`, mutate((_doc, _job, step) => { step.env = { [variable]: "" }; }), `the gate step env sets ${variable}; it must be absent`],
      [`gate job env ${variable}`, mutate((_doc, job) => { job.env = { [variable]: "" }; }), `the gate job env sets ${variable}; it must be absent`],
      [`workflow env ${variable}`, mutate((doc) => { doc.env = { [variable]: "" }; }), `the workflow env sets ${variable}; it must be absent`],
    ]),
    ["gate step shell override", mutate((_doc, _job, step) => { step.shell = "bash"; }), stepShellError],
    ["gate job shell override", mutate((_doc, job) => { job.shell = "bash"; }), jobShellError],
    ["gate job defaults.run.shell override", mutate((_doc, job) => { job.defaults = { run: { shell: "bash" } }; }), jobDefaultsShellError],
    ["workflow defaults.run.shell override", mutate((doc) => { doc.defaults = { run: { shell: "bash" } }; }), workflowDefaultsShellError],
    ["adapter step shell override", adapt((_job, step) => { step.shell = "bash"; }), adapterStepShellError],
    ["adapter job shell override", adapt((job) => { job.shell = "bash"; }), adapterJobShellError],
    ["adapter job defaults.run.shell override", adapt((job) => { job.defaults = { run: { shell: "bash" } }; }), adapterJobDefaultsShellError],
    ["adapter step continue-on-error", adapt((_job, step) => { step["continue-on-error"] = true; }), `${adapter} has a step with continue-on-error; it must be absent`],
    ["adapter job continue-on-error", adapt((job) => { job["continue-on-error"] = true; }), `${adapter} has continue-on-error; it must be absent`],
    ["adapter job if: false", adapt((job) => { job.if = false; }), `${adapter} must have if: always()`],
    ["adapter job without if: always()", adapt((job) => { delete job.if; }), `${adapter} must have if: always()`],
    ["adapter step if: false", adapt((_job, step) => { step.if = false; }), `${adapter} has a step with if; it must be absent`],
    ["adapter emptied run", adapt((_job, step) => { step.run = ""; }), `${adapter} must run the canonical adapter script`],
    ["adapter altered run", adapt((_job, step) => { step.run = String(step.run).replace("exit 1", "exit 0"); }), `${adapter} must run the canonical adapter script`],
    ["adapter joins exit 1 onto the error echo", adapt((_job, step) => {
      if (typeof step.run !== "string") throw new Error("fixture drift: adapter run not found");
      const joined = step.run.replace(/\n[ \t]*exit 1\n/, " exit 1\n");
      if (joined === step.run) throw new Error("fixture drift: adapter run has no standalone exit 1");
      step.run = joined;
    }), `${adapter} must run the canonical adapter script`],
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
    ["move gate to unchecked direct need", mutate((doc, job, step) => {
      const adapter = doc.jobs?.[ADAPTER_JOB];
      if (!doc.jobs || !job.steps || !adapter || !Array.isArray(adapter.needs)) throw new Error("fixture drift: gate or adapter needs not found");
      job.steps.splice(job.steps.indexOf(step), 1);
      doc.jobs["unchecked-direct-need"] = { steps: [step] };
      adapter.needs.push("unchecked-direct-need");
    }), `the gate job "unchecked-direct-need" must be directly result-checked by the required "${REQUIRED_UNIT_CHECK}" adapter`],
    ["unchecked copy alongside checked gate", mutate((doc, _job, step) => {
      const adapter = doc.jobs?.[ADAPTER_JOB];
      if (!doc.jobs || !adapter || !Array.isArray(adapter.needs)) throw new Error("fixture drift: adapter needs not found");
      doc.jobs["unchecked-direct-need"] = { steps: [{ ...step }] };
      adapter.needs.push("unchecked-direct-need");
    }), `the gate job "unchecked-direct-need" must be directly result-checked by the required "${REQUIRED_UNIT_CHECK}" adapter`],
    ["gate reachable only through an intermediate job", mutate((doc) => {
      const adapter = doc.jobs?.[ADAPTER_JOB];
      if (!doc.jobs || !adapter) throw new Error("fixture drift: adapter not found");
      doc.jobs["intermediate"] = { needs: GATE_JOB };
      adapter.needs = ["intermediate", "test-darwin-gated"];
    }), `the gate job "${GATE_JOB}" must be directly result-checked by the required "${REQUIRED_UNIT_CHECK}" adapter`],
    ...["paths", "paths-ignore", "branches-ignore"].map((filter): GateCase => [
      `pull_request ${filter} filter`, mutate((doc) => { doc.on = { pull_request: { [filter]: ["docs/**"] } }; }), `pull_request must not set ${filter}`,
    ]),
    ["missing pull_request trigger", mutate((doc) => { doc.on = { push: null }; }), "the gate workflow must have a pull_request trigger"],
    ...[["develop"], ["main", "develop"], [], "main", null].map((branches): GateCase => [
      `pull_request branches ${JSON.stringify(branches)}`, mutate((doc) => { doc.on = { pull_request: { branches } }; }), "pull_request branches must be absent or exactly [main]",
    ]),
    ...["opened", "synchronize", "reopened"].map((omitted): GateCase => [
      `pull_request types omit ${omitted}`, mutate((doc) => { doc.on = { pull_request: { types: ["opened", "synchronize", "reopened"].filter((type) => type !== omitted) } }; }), "pull_request types must include opened, synchronize and reopened",
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
