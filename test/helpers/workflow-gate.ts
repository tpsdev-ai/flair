/**
 * workflow-gate.ts — assert a CI gate step from the workflow's parsed job graph
 * instead of from a substring of its text (flair#2289, flair#2419).
 *
 * A `toContain` over the workflow file still passes on a step that is renamed,
 * disabled (`if: false`, `continue-on-error: true`) or moved out of the job the
 * required check depends on. `checkGate` reads the parsed jobs instead: the
 * step has to be an enabled step, under its own name and passing the enforcing
 * flag of the enforcing script, of a job the required branch-protection check
 * reaches through `needs` (transitively). `gateMutations` builds the mutated
 * copies a test feeds back to `checkGate` to show each of those escapes is
 * refused.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";

export type WorkflowStep = { name?: unknown; run?: unknown; if?: unknown; "continue-on-error"?: unknown };
export type WorkflowJob = { name?: unknown; needs?: unknown; if?: unknown; steps?: WorkflowStep[] };
export type WorkflowDoc = { jobs?: Record<string, WorkflowJob> };

export type Gate = {
  /** The branch-protection required check context; the gating jobs are its transitive `needs`. */
  requiredCheck: string;
  /** The `name:` of the step that runs the gate. */
  step: string;
  /** The script the gate step has to run. */
  script: string;
  /** The flag the gate step has to pass. */
  flag: string;
};

type Found = { doc: WorkflowDoc; job: WorkflowJob; step: WorkflowStep; index: number };

/** Parse the `.yml`/`.yaml` files in `dir`, sorted by file name. */
export function parseWorkflows(dir: string): WorkflowDoc[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .map((f) => loadYaml(readFileSync(join(dir, f), "utf8")) as WorkflowDoc);
}

/** Job ids the required check depends on, transitively, including its own job. */
function requiredJobs(docs: WorkflowDoc[], requiredCheck: string): Set<string> {
  const jobs: Record<string, WorkflowJob> = {};
  for (const doc of docs) Object.assign(jobs, doc.jobs ?? {});
  const seen = new Set<string>();
  const stack = Object.entries(jobs).filter(([, job]) => job.name === requiredCheck).map(([id]) => id);
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

/** The gate step in `docs`, or a fixture-drift error. */
function findGate(docs: WorkflowDoc[], gate: Gate): Found {
  for (const doc of docs) {
    for (const job of Object.values(doc.jobs ?? {})) {
      const index = (job.steps ?? []).findIndex((step) => step.name === gate.step);
      if (index >= 0) return { doc, job, step: (job.steps as WorkflowStep[])[index], index };
    }
  }
  throw new Error(`fixture drift: no step is named "${gate.step}"`);
}

/** A copy of `docs` with one edit applied to the gate step. */
function editGate(docs: WorkflowDoc[], gate: Gate, edit: (step: WorkflowStep) => void): WorkflowDoc[] {
  const copy = structuredClone(docs);
  edit(findGate(copy, gate).step);
  return copy;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Throws unless `gate.step` is an enabled step, under its own name and passing
 * `gate.flag` for `gate.script`, of a job the `gate.requiredCheck` check depends
 * on transitively.
 */
export function checkGate(docs: WorkflowDoc[], gate: Gate): void {
  const required = requiredJobs(docs, gate.requiredCheck);
  const gates = docs.flatMap((doc) =>
    Object.entries(doc.jobs ?? {}).flatMap(([id, job]) =>
      (job.steps ?? []).filter((step) => step.name === gate.step).map((step) => ({ id, job, step })),
    ),
  );
  if (gates.length === 0) throw new Error(`no step is named "${gate.step}"`);
  const gated = gates.filter(({ id }) => required.has(id));
  if (gated.length === 0) {
    throw new Error(`"${gate.step}" runs in no job the required "${gate.requiredCheck}" check depends on`);
  }
  for (const { id, job, step } of gated) {
    if (neverRuns(step.if)) throw new Error(`"${gate.step}" is disabled by its if`);
    if (step["continue-on-error"] ?? false) throw new Error(`"${gate.step}" has continue-on-error`);
    const args = String(step.run ?? "").trim().split(/\s+/).filter(Boolean);
    if (!args.includes(gate.script)) throw new Error(`"${gate.step}" does not run ${gate.script}`);
    if (!args.includes(gate.flag)) throw new Error(`"${gate.step}" does not pass ${gate.flag}`);
    if (neverRuns(job.if)) throw new Error(`the job "${id}" holding "${gate.step}" is disabled by its if`);
  }
}

/**
 * The mutations a test feeds back to `checkGate` to show each escape is refused:
 * a renamed step, `continue-on-error: true`, `if: false`, a dropped enforcing
 * flag, and a step moved into a job the required check does not depend on.
 */
export function gateMutations(docs: WorkflowDoc[], gate: Gate): Array<[string, () => WorkflowDoc[]]> {
  const required = requiredJobs(docs, gate.requiredCheck);
  const mutate = (edit: (step: WorkflowStep) => void): (() => WorkflowDoc[]) => () => editGate(docs, gate, edit);
  return [
    ["rename the step", mutate((step) => { step.name = `${gate.step} (renamed)`; })],
    ["continue on error", mutate((step) => { step["continue-on-error"] = true; })],
    ["if: false", mutate((step) => { step.if = false; })],
    ["drop the enforcing flag", mutate((step) => {
      const run = String(step.run ?? "").trim();
      const dropped = run.replace(new RegExp(`(^|\\s)${escapeRegex(gate.flag)}(?=\\s|$)`), " ").trim();
      if (dropped === run) throw new Error(`fixture drift: "${gate.step}" does not pass ${gate.flag}`);
      step.run = dropped;
    })],
    ["move to a job the check does not require", () => {
      const copy = structuredClone(docs);
      const { doc, job, index } = findGate(copy, gate);
      const target = Object.entries(doc.jobs ?? {}).find(([id]) => !required.has(id));
      if (!target) throw new Error("fixture drift: no job outside the required set to move the gate to");
      const [removed] = (job.steps as WorkflowStep[]).splice(index, 1);
      target[1].steps = [...(target[1].steps ?? []), removed];
      return copy;
    }],
  ];
}
