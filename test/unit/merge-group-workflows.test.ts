// merge-group-workflows.test.ts — the merge-queue contract for main's required
// checks. GitHub runs a merge-queue group as a `merge_group` event on a
// gh-readonly-queue/main/* commit, and the queue waits for the required checks
// to report there. These tests evaluate the committed workflows for that event
// (test/helpers/gha-expression.ts) and fail when a trigger, a required job, a
// Node matrix leg, a gate, a concurrency group or a base binding stops working
// on it.

import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

import { evaluateIf, evaluateValue, type Context } from "../helpers/gha-expression.ts";
import { shellScript } from "../helpers/shell-script.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { runGate, SEED_INTRODUCTION_BASE } from "../../scripts/ci/check-cli-spawn-budgets.mjs";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const WORKFLOWS = join(REPO_ROOT, ".github", "workflows");

type Step = { id?: string; name?: string; if?: unknown; run?: string; uses?: string; env?: Record<string, string> };
type Job = { name?: string; needs?: string | string[]; if?: unknown; permissions?: unknown; strategy?: { matrix?: Record<string, unknown> }; steps?: Step[] };
type Workflow = { name: string; on: Record<string, unknown>; concurrency?: { group: string; "cancel-in-progress": unknown }; jobs: Record<string, Job> };

const workflow = (file: string) => load(readFileSync(join(WORKFLOWS, file), "utf8")) as Workflow;

/** The required checks GitHub Actions produces on main (ruleset 13355870), by workflow file. */
const REQUIRED_ACTIONS_CHECKS: Array<[file: string, check: string]> = [
  ["test.yml", "Unit Tests"],
  ["test.yml", "Integration Tests"],
  ["test.yml", "Type Check"],
  ["test.yml", "Dependency Audit"],
  ["test.yml", "CodeQL SAST"],
  ["test.yml", "Semgrep SAST"],
  ["test.yml", "Doc/Code Lint: docs-freshness gate"],
  ["test.yml", "Doc/Code Lint: implementation-term leaks"],
  ["test.yml", "First-publish preflight"],
  ["migration-ci-lanes.yml", "Migration snapshot-restore drill (invariant III proof)"],
  ["migration-ci-lanes.yml", "Migration downgrade-and-revert (no silent bad outcome, flair#1050)"],
  ["socket.yml", "Socket.dev Supply Chain"],
];
const WORKFLOW_FILES = [...new Set(REQUIRED_ACTIONS_CHECKS.map(([file]) => file))];

const BASE_SHA = "1111111111111111111111111111111111111111";
const HEAD_SHA = "2222222222222222222222222222222222222222";
const RUN_ID = "4242";

/** The contexts a job sees for one event. `needs` and `steps` start empty: a skipped job has no outputs. */
function eventContext(event: "merge_group" | "pull_request" | "push" | "workflow_dispatch", opts: { workflow?: string; headRef?: string } = {}): Context {
  const payload: Record<string, unknown> = {
    merge_group: { head_ref: `refs/heads/gh-readonly-queue/main/pr-3079-${BASE_SHA}`, head_sha: HEAD_SHA, base_sha: BASE_SHA, base_ref: "refs/heads/main" },
    pull_request: { number: 3079, base: { sha: "3333333333333333333333333333333333333333" }, user: { login: "human-a" } },
    push: { before: "4444444444444444444444444444444444444444" },
  };
  return {
    github: {
      event_name: event,
      workflow: opts.workflow ?? "CI",
      run_id: RUN_ID,
      head_ref: event === "pull_request" ? (opts.headRef ?? "feature/x") : "",
      base_ref: event === "pull_request" ? "main" : "",
      token: "TOKEN",
      event: { [event]: payload[event], ...(event === "push" ? payload.push as object : {}) },
    },
    needs: {},
    steps: {},
    inputs: {},
    runner: { os: "Linux" },
  };
}

function jobNamed(doc: Workflow, check: string): [string, Job] {
  const found = Object.entries(doc.jobs).filter(([, job]) => job.name === check);
  if (found.length !== 1) throw new Error(`expected exactly one job named ${JSON.stringify(check)}, found ${found.length}`);
  return found[0];
}

const needsOf = (job: Job) => (Array.isArray(job.needs) ? job.needs : job.needs === undefined ? [] : [job.needs]);

/** The job and every job it needs, transitively. */
function needsClosure(doc: Workflow, id: string): string[] {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const next = stack.pop() as string;
    if (seen.has(next)) continue;
    if (!doc.jobs[next]) throw new Error(`job ${next} is missing`);
    seen.add(next);
    stack.push(...needsOf(doc.jobs[next]));
  }
  return [...seen].sort();
}

describe("merge_group trigger", () => {
  test.each(WORKFLOW_FILES)("%s runs on merge_group checks_requested with no filters", (file) => {
    expect(workflow(file).on.merge_group).toEqual({ types: ["checks_requested"] });
  });

  test.each(WORKFLOW_FILES)("%s has no pull_request_target trigger", (file) => {
    expect(Object.keys(workflow(file).on)).not.toContain("pull_request_target");
  });
});

describe("token permissions", () => {
  test("test.yml reads the repo by default and only sast-codeql and docs-freshness declare their own permissions", () => {
    const doc = load(readFileSync(join(WORKFLOWS, "test.yml"), "utf8")) as Workflow & { permissions?: unknown };
    expect(doc.permissions).toEqual({ contents: "read" });
    const own = Object.entries(doc.jobs).filter(([, job]) => job.permissions !== undefined).map(([id]) => id).sort();
    expect(own).toEqual(["docs-freshness", "sast-codeql"]);
    expect(doc.jobs["sast-codeql"].permissions).toEqual({ "security-events": "write" });
  });
});

describe("required checks run on the merge-queue commit", () => {
  test.each(REQUIRED_ACTIONS_CHECKS.filter(([, check]) => check !== "First-publish preflight"))(
    "%s: %s and every job it needs run on merge_group",
    (file, check) => {
      const doc = workflow(file);
      const [id] = jobNamed(doc, check);
      const ctx = eventContext("merge_group", { workflow: doc.name });
      const skipped = needsClosure(doc, id).filter((job) => !evaluateIf(doc.jobs[job].if, ctx));
      expect(skipped).toEqual([]);
    },
  );

  test("First-publish preflight is the one required job skipped on merge_group, and it still runs on a release PR", () => {
    const doc = workflow("test.yml");
    const [, job] = jobNamed(doc, "First-publish preflight");
    expect(evaluateIf(job.if, eventContext("merge_group"))).toBe(false);
    expect(evaluateIf(job.if, eventContext("pull_request", { headRef: "release/v0.64.0" }))).toBe(true);
    expect(evaluateIf(job.if, eventContext("pull_request", { headRef: "fix/x" }))).toBe(false);
  });
});

describe("Node matrices and their aggregate gates on merge_group", () => {
  const FULL = ["22", "24", "26"];
  test.each([
    ["test-unit", "Unit Tests", ["22"]],
    ["typecheck", "Type Check", FULL],
    ["pack-smoke", "Install-from-tarball smoke", FULL],
  ])("%s runs the full 22/24/26 matrix on merge_group, as on push, and %s gates on it", (id, gateName, releasePr) => {
    const doc = workflow("test.yml");
    const matrix = doc.jobs[id].strategy?.matrix ?? {};
    expect(evaluateValue(matrix["node-version"], eventContext("merge_group"))).toEqual(FULL);
    expect(evaluateValue(matrix["node-version"], eventContext("push"))).toEqual(FULL);
    expect(evaluateValue(matrix["node-version"], eventContext("workflow_dispatch"))).toEqual(FULL);
    expect(evaluateValue(matrix["node-version"], eventContext("pull_request"))).toEqual(["22"]);
    expect(evaluateValue(matrix["node-version"], eventContext("pull_request", { headRef: "release/v0.64.0" }))).toEqual(releasePr);
    const [, gate] = jobNamed(doc, gateName);
    expect(needsOf(gate)).toContain(id);
    expect(evaluateIf(gate.if, eventContext("merge_group"))).toBe(true);
  });

  test.each([
    ["test-unit", "Unit Tests"],
    ["test-integration", "Integration Tests"],
    ["typecheck", "Type Check"],
  ])("the %s gate (%s) fails when a leg did not succeed", (id, gateName) => {
    const doc = workflow("test.yml");
    const [, gate] = jobNamed(doc, gateName);
    const script = gate.steps?.[0]?.run;
    if (typeof script !== "string") throw new Error(`${gateName} has no run step`);
    const run = (failed: string | null) => {
      const ctx = eventContext("merge_group");
      ctx.needs = Object.fromEntries(needsOf(gate).map((need) => [need, { result: need === failed ? "failure" : "success" }]));
      return spawnSync("bash", ["-e", shellScript(String(evaluateValue(script, ctx)))], { encoding: "utf8" }).status;
    };
    expect(run(null)).toBe(0);
    expect(run(id)).not.toBe(0);
  });
});

describe("concurrency on merge_group", () => {
  test.each(WORKFLOW_FILES)("%s gives a queue run its own run-ID group and never cancels it", (file) => {
    const doc = workflow(file);
    const queue = eventContext("merge_group", { workflow: doc.name });
    const pr = eventContext("pull_request", { workflow: doc.name });
    expect(evaluateValue(doc.concurrency?.group, queue)).toBe(`${doc.name}-${RUN_ID}`);
    expect(evaluateValue(doc.concurrency?.["cancel-in-progress"], queue)).toBe(false);
    expect(evaluateValue(doc.concurrency?.group, pr)).toBe(`${doc.name}-pr-3079`);
    expect(evaluateValue(doc.concurrency?.["cancel-in-progress"], pr)).toBe(true);
  });
});

describe("the advisory launchd lane on merge_group", () => {
  test("is skipped on merge_group and still runs on push and on a PR whose gate says run", () => {
    const doc = workflow("test.yml");
    const [, lane] = jobNamed(doc, "launchd adopt-then-upgrade (macOS, advisory)");
    expect(evaluateIf(lane.if, eventContext("merge_group"))).toBe(false);
    expect(evaluateIf(lane.if, eventContext("push"))).toBe(true);
    const pr = eventContext("pull_request");
    pr.needs = { "launchd-lane-changes": { outputs: { run: "true" } } };
    expect(evaluateIf(lane.if, pr)).toBe(true);
  });
});

describe("docs-freshness on merge_group", () => {
  const job = () => workflow("test.yml").jobs["docs-freshness"];

  test("reads PRs with pull-requests: read and hands the token only to the queued-PR lookup", () => {
    expect(job().permissions).toEqual({ contents: "read", "pull-requests": "read" });
    const tokenSteps = (job().steps ?? []).filter((step) => step.env && Object.hasOwn(step.env, "GH_TOKEN"));
    expect(tokenSteps.map((step) => step.id)).toEqual(["queued-pr"]);
    expect(tokenSteps[0].env?.GH_TOKEN).toBe("${{ github.token }}");
  });

  test("the lookup runs only on merge_group, before any step that runs the PR's code", () => {
    const steps = job().steps ?? [];
    const lookup = steps.findIndex((step) => step.id === "queued-pr");
    const firstPrCode = steps.findIndex((step) => typeof step.run === "string" && /\bbun (install|run)\b|\bnode scripts\//.test(step.run));
    expect(lookup).toBeGreaterThan(0);
    expect(lookup).toBeLessThan(firstPrCode);
    expect(evaluateIf(steps[lookup].if, eventContext("merge_group"))).toBe(true);
    expect(evaluateIf(steps[lookup].if, eventContext("pull_request"))).toBe(false);
    expect(evaluateIf(steps[lookup].if, eventContext("push"))).toBe(false);
  });

  test("the gate's login is the queued PR's on merge_group and the event's on a PR", () => {
    const gate = (job().steps ?? []).find((step) => step.run === "node scripts/docs-freshness-check.mjs");
    const binding = gate?.env?.FLAIR_PR_AUTHOR_LOGIN;
    const queue = eventContext("merge_group");
    queue.steps = { "queued-pr": { outputs: { login: "renovate[bot]" } } };
    expect(evaluateValue(binding, queue)).toBe("renovate[bot]");
    expect(evaluateValue(binding, eventContext("pull_request"))).toBe("human-a");
    expect(evaluateValue(binding, eventContext("merge_group")) ?? "").toBe("");
  });
});

describe("cli-spawn-budgets base ref on merge_group", () => {
  const steps = () => workflow("test.yml").jobs["cli-spawn-budgets"].steps ?? [];
  const fetchStep = () => {
    const step = steps().find((s) => s.name === "Fetch the base ref for the spawn-budget gate");
    if (!step) throw new Error("the spawn-budget fetch step is missing");
    return step;
  };
  const gateStep = () => {
    const step = steps().find((s) => s.run === "node scripts/ci/check-cli-spawn-budgets.mjs");
    if (!step) throw new Error("the spawn-budget gate step is missing");
    return step;
  };

  test.each([
    ["merge_group", BASE_SHA],
    ["pull_request", "3333333333333333333333333333333333333333"],
    ["push", "4444444444444444444444444444444444444444"],
  ] as const)("on %s both the fetch and the gate read the base %s", (event, expected) => {
    expect(evaluateValue(fetchStep().env?.BASE_SHA, eventContext(event))).toBe(expected);
    expect(evaluateValue(gateStep().env?.CLI_SPAWN_BUDGETS_BASE_REF, eventContext(event))).toBe(expected);
  });

  test("the fetch step passes the merge-group base sha and the seed anchor to git fetch", () => {
    const run = fetchStep().run ?? "";
    expect(run).not.toContain("${{");
    const dir = tempDir("flair-mq-fetch-");
    const record = join(dir, "git-args");
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "git"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\n`);
    chmodSync(join(dir, "bin", "git"), 0o755);
    const baseSha = String(evaluateValue(fetchStep().env?.BASE_SHA, eventContext("merge_group")));
    const result = spawnSync("bash", ["-e", shellScript(run)], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, BASE_SHA: baseSha },
    });
    expect(result.status).toBe(0);
    expect(readFileSync(record, "utf8").trim().split("\n")).toEqual(["fetch", "--no-tags", "origin", BASE_SHA, SEED_INTRODUCTION_BASE]);
  });

  test("the real gate reads the baseline from the merge-group base and refuses a self-granted exception", () => {
    const dir = tempDir("flair-mq-spawn-gate-");
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" }).trim();
    const write = (rel: string, body: string) => {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), body);
    };
    git("init", "-q");
    write("scripts/ci/cli-spawn-budgets.baseline.json", "[]\n");
    write("test/base.test.ts", `test("ok", () => {});\n`);
    git("add", "-A");
    git("commit", "-qm", "main");
    const mainSha = git("rev-parse", "HEAD");
    // The queue's commit on top of main: an unbudgeted CLI spawn plus its own baseline entries.
    write("test/attack.test.ts", `test("a CLI spawn", () => {\n  const p = Bun.spawn(["bun", "src/cli.ts", "status"], {});\n});\n`);
    write("scripts/ci/cli-spawn-budgets.baseline.json", JSON.stringify([
      { file: "test/attack.test.ts", scope: "a CLI spawn", fingerprint: `["bun","src/cli.ts","status"] ; {}`, kind: "spawn-no-timeout", occurrence: 0, reason: "self-granted" },
      { file: "test/attack.test.ts", scope: "a CLI spawn", fingerprint: "a CLI spawn", kind: "case-no-budget", occurrence: 0, reason: "self-granted" },
    ], null, 2) + "\n");
    git("add", "-A");
    git("commit", "-qm", "fix: queue group (#3079)");

    const ctx = eventContext("merge_group");
    (ctx.github as { event: { merge_group: { base_sha: string } } }).event.merge_group.base_sha = mainSha;
    const baseRef = String(evaluateValue(gateStep().env?.CLI_SPAWN_BUDGETS_BASE_REF, ctx));
    expect(baseRef).toBe(mainSha);
    const result = runGate({ root: dir, baseRef, env: { CLI_SPAWN_BUDGETS_BASE_REF: baseRef } });
    expect(result.baseSha).toBe(mainSha);
    expect(result.defaulted).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.added.length).toBeGreaterThan(0);
  });
});
