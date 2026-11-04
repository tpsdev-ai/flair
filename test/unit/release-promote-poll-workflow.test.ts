/**
 * release-promote-poll-workflow.test.ts — flair#1928 slice 1.
 *
 * Shape tests for `.github/workflows/release-promote-poll.yml`, the UNPRIVILEGED
 * poll. It must hold no credential (no environment, no repo secret), must not
 * check out a tag's tree, must read the version from the marker payload, must use
 * an ALL-form readiness predicate, and must never let its outputs decide what gets
 * promoted.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import yaml from "js-yaml";

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  run?: string;
}
interface Job {
  name?: string;
  if?: string;
  permissions?: Record<string, string>;
  environment?: string;
  steps?: Step[];
}
interface Workflow {
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs?: Record<string, Job>;
}

const REPO = join(import.meta.dir, "..", "..");
const PATH = join(REPO, ".github", "workflows", "release-promote-poll.yml");
const raw = readFileSync(PATH, "utf8");
const wf = yaml.load(raw) as unknown as Workflow;

function job(name: string): Job {
  const found = wf.jobs?.[name];
  expect(found, `job ${name} exists`).toBeDefined();
  return found as Job;
}

describe("release-promote-poll — no credential, trusted-main only", () => {
  test("permissions: {} at the top; the poll job holds actions: write + contents/deployments read only", () => {
    expect(wf.permissions).toEqual({});
    expect(job("poll").permissions).toEqual({
      "actions": "write",
      "contents": "read",
      "deployments": "read",
    });
  });

  test("NO environment, and NO repo secret anywhere in the workflow", () => {
    for (const [name, j] of Object.entries(wf.jobs ?? {})) {
      expect(j.environment, `job ${name} has no environment`).toBeUndefined();
    }
    // The only credential-shaped value allowed is the auto GITHUB_TOKEN.
    const secretRefs = [...raw.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    expect([...new Set(secretRefs)]).toEqual(["GITHUB_TOKEN"]);
    expect(raw).not.toContain("NPM_TOKEN");
    // No `environment:` KEY at all (the word in prose is fine).
    expect(/^\s*environment:/m.test(raw), "no environment: key").toBe(false);
  });

  test("it checks out scripts/ci from the DEFAULT BRANCH (github.sha), never a tag ref", () => {
    const checkout = job("poll").steps?.find((s) => (s.uses ?? "").startsWith("actions/checkout"));
    expect(checkout, "the poll checks out").toBeDefined();
    expect(String(checkout?.with?.ref)).toBe("${{ github.sha }}");
    expect(String(checkout?.with?.ref)).not.toContain("refs/tags");
    const sparse = String(checkout?.with?.["sparse-checkout"]);
    expect(sparse).toContain("scripts/ci");
    // The derivation reads the root package.json and packages/*/package.json, so
    // the sparse checkout must bring them — otherwise lockstep-packages.mjs sees
    // an empty tree and (before the fail-closed fix) an empty package list.
    expect(sparse).toContain("package.json");
    expect(sparse).toContain("packages/*/package.json");
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  test("the version comes from the MARKER PAYLOAD, never from main's package.json", () => {
    const script = job("poll").steps?.map((s) => s.run ?? "").join("\n") ?? "";
    expect(script).toContain(".payload.package_set_digest");
    expect(script).toContain(".payload.version");
    expect(script).not.toContain("package.json");
    // Every lockstep package must be public and measurable — ALL-form.
    expect(script).toContain("registry-tarball-sha256.mjs");
    expect(script).toContain("lockstep-packages.mjs");
    expect(script).toContain("NOT READY");
  });

  test("the READY path checks for the workflow before dispatching on the tag ref", () => {
    const script = job("poll").steps?.map((s) => s.run ?? "").join("\n") ?? "";
    expect(script).toContain("gh workflow run release-promote.yml");
    expect(script).toContain("--ref");
    expect(script).toContain("release-promote.yml"); // the existence gate
    expect(script).toContain("would dispatch");
  });

  test("the header says the poll's outputs are never an input to what gets promoted", () => {
    expect(raw).toContain("NEVER an input to what gets promoted");
  });
});

describe("release-promote-poll — round 2: derivation, payload version, all pages, main-bound dispatch", () => {
  const runScript = () => (job("poll").steps ?? []).map((s) => s.run ?? "").join("\n");

  test("the package-list derivation FAILS CLOSED: status captured separately, empty is an error, no swallowing substitution", () => {
    const script = runScript();
    // The output and its exit status are captured SEPARATELY.
    expect(script).toContain("pkgs_status=$?");
    expect(script).toContain('if [ "${pkgs_status}" -ne 0 ]');
    expect(script).toContain('if [ ! -s "${PKGS}" ]');
    expect(script).toMatch(/exit 1/);
    // No `< <(node scripts/ci/lockstep-packages.mjs …)` that can swallow a non-zero exit.
    expect(script).not.toContain("< <(node scripts/ci/lockstep-packages.mjs");
  });

  test("the version is the PAYLOAD's and is validated against the ref (a mismatch refuses the marker)", () => {
    const script = runScript();
    expect(script).toContain("payload_version"); // assertion: the payload field is read
    expect(script).toContain('[ "${ref}" != "v${payload_version}" ]'); // assertion: ref must equal v<payload.version>
    expect(script).toContain("refusing this marker"); // assertion: mismatch skips
    expect(script).not.toMatch(/\bversion="\$\{ref#v\}"/); // assertion: never the ref alone
  });

  test("ALL deployment pages are read: the flatten uses add, not .[0]", () => {
    const script = runScript();
    expect(script).toContain("--paginate"); // assertion: every page is fetched
    expect(script).toContain("jq -s 'add"); // assertion: pages are flattened
    expect(script).not.toContain(".[0]"); // assertion: no first-page-only form
  });

  test("BEHAVIOURAL: a marker on page 2 is seen by the flatten (and .[0] would miss it)", () => {
    const dir = mkdtempSync(join(tmpdir(), "poll-pages-"));
    try {
      const p1 = join(dir, "p1.json");
      const p2 = join(dir, "p2.json");
      writeFileSync(p1, JSON.stringify([{ ref: "v0.1.0", payload: { version: "0.1.0" } }]));
      writeFileSync(p2, JSON.stringify([{ ref: "v0.2.0", payload: { version: "0.2.0" } }]));
      const flat = spawnSync("jq", ["-s", "add // [] | map(.ref)", p1, p2], { env: { ...process.env, FLAIR_TEST_ALLOW_BUN_HARPER: "exercise release-promote-poll-workflow process fixture arguments" }, encoding: "utf8" });
      expect(flat.status, String(flat.stderr)).toBe(0);
      const refs = JSON.parse(flat.stdout) as string[];
      expect(refs).toContain("v0.2.0"); // assertion: the page-2 marker is seen
      const old = spawnSync("jq", ["-s", ".[0] | map(.ref)", p1, p2], { env: { ...process.env, FLAIR_TEST_ALLOW_BUN_HARPER: "exercise release-promote-poll-workflow process fixture arguments" }, encoding: "utf8" });
      expect(JSON.parse(old.stdout) as string[]).not.toContain("v0.2.0"); // the old bug
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the poll runs ONLY on schedule — no manual trigger, so every run is the default branch's copy of the file", () => {
    // `gh workflow run --ref <branch>` runs THAT branch's version of the workflow file, so a guard
    // inside the file cannot bind a manual run to main (Gauge pass 2 on #1932). Schedule runs always
    // execute the default branch's copy.
    // js-yaml (YAML 1.1) reads the bare key `on` as boolean true, so accept either spelling.
    const parsed = wf as unknown as { on?: Record<string, unknown>; true?: Record<string, unknown> };
    const on = (parsed.on ?? parsed.true ?? {}) as Record<string, unknown>;
    expect(Object.keys(on)).toEqual(["schedule"]); // assertion: schedule is the only trigger
    expect(raw).not.toMatch(/^\s*workflow_dispatch\s*:/m); // assertion: no manual trigger key anywhere in the file
  });
});

describe("release-promote-poll — visible-run check (#1928 slice 2)", () => {
  const runScript = () => (job("poll").steps ?? []).map((s) => s.run ?? "").join("\n");

  test("the READY dispatch checks non-dry-run attempts and refuses an unreadable run list", () => {
    const script = runScript();
    expect(script).toContain("release-promote.yml/runs");
    expect(script).toContain("not dispatching again");
    // A failed (or uninterpretable) read is an error exit, never a dispatch on an unknown.
    expect(script).toContain("refusing to dispatch");
    expect(script).toMatch(/if ! gh api --paginate "repos\/\$\{REPO\}\/actions\/workflows\/release-promote\.yml\/runs/);
    // The auto-dispatch sets dry_run=false.
    expect(script).toContain('gh workflow run release-promote.yml --ref "${ref}" -f dry_run=false');
  });

  /**
   * Run the poll's REAL `ALREADY="$(jq ...)"` line (extracted verbatim, flags and
   * all) against `--paginate`-shaped output: one JSON object PER PAGE, written
   * back to back, exactly as `gh api --paginate` prints a run list.
   */
  function already(pages: unknown[] | string): string {
    const line = runScript()
      .split("\n")
      .find((l) => /^\s*ALREADY="\$\(jq /.test(l));
    expect(line, "the poll's ALREADY= jq line is present").toBeDefined();
    const dir = mkdtempSync(join(tmpdir(), "poll-runs-"));
    try {
      const runs = join(dir, "runs.json");
      writeFileSync(runs, typeof pages === "string" ? pages : pages.map((p) => JSON.stringify(p)).join("\n"));
      const sh = join(dir, "already.sh");
      writeFileSync(sh, `set -euo pipefail\nversion=1.2.3\nRUNS=${JSON.stringify(runs)}\n${line!.trim()}\nprintf '%s' "$ALREADY"\n`);
      const r = spawnSync("bash", [sh], { encoding: "utf8" });
      return r.status === 0 ? r.stdout.trim() : `exit ${r.status}`;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const page = (...runs: unknown[]) => ({ total_count: 999, workflow_runs: runs });

  test("ALREADY matches only queued, in-progress or successful non-dry-run titles", () => {
    for (const state of [{ status: "queued" }, { status: "in_progress" }, { status: "completed", conclusion: "success" }]) {
      expect(already([page({ display_title: "release-promote v1.2.3", head_branch: null, ...state })])).toBe("true");
      expect(already([page({ display_title: "release-promote v1.2.3 (dry run)", head_branch: "v1.2.3", ...state })])).toBe("false");
      expect(already([page({ display_title: "other", head_branch: "v1.2.3", ...state })])).toBe("false");
      expect(already([page({ display_title: "release-promote v1.2.2", head_branch: "v1.2.2", ...state })])).toBe("false");
    }
    expect(already([page({ display_title: "release-promote v1.2.3", status: "completed", conclusion: "failure" })])).toBe("false");
    expect(already([page()])).toBe("false");
  });

  test("BEHAVIOURAL: every page is flattened into ONE decision — a match on page two is found", () => {
    const p1 = page(
      ...Array.from({ length: 100 }, (_, i) => ({ display_title: `release-promote v0.0.${i}`, head_branch: `v0.0.${i}` })),
    );
    const p2 = page({ display_title: "release-promote v1.2.3", head_branch: "v1.2.3", status: "in_progress" });
    expect(already([p1, p2])).toBe("true");
    // …and two pages with no match anywhere are ONE "false", not one value per page.
    expect(already([p1, page({ display_title: "release-promote v1.2.2", head_branch: "v1.2.2" })])).toBe("false");
  });

  test("BEHAVIOURAL: an uninterpretable run list is never read as 'no run'", () => {
    // A page without a workflow_runs array, or no page at all, yields neither
    // accepted value, so the poll's next check errors out instead of dispatching.
    expect(already([page(), { message: "Not Found" }])).toBe("invalid");
    expect(already("")).toBe("invalid");
    expect(already("{not json")).toMatch(/^exit [1-9]/);
  });
});

// ── Promote settings checked before dispatch (flair#1928) ──────────
//
// The default-branch poll checks tag ruleset properties, its own token's immutable-rule
// status and the environment tag policy through the API. A fake `gh` serves JSON
// shapes (rulesets 24044017 / 23944797 as read on 2026-10-13; the environment
// as the REST API documents it).

const POLL_STEP = (name: string) => {
  const st = (job("poll").steps ?? []).find((s) => (s.name ?? "").startsWith(name));
  expect(st, `poll step '${name}'`).toBeDefined();
  return st!;
};
const POLL_ENV = (job("poll") as { env?: Record<string, string> }).env ?? {};

/** A fake `gh`: `gh api [--paginate] <path>` serves FIXTURES[<path without query>] or exits 1 (404). */
function fakeGh(dir: string, fixtures: Record<string, unknown>, extra = ""): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const fx = join(dir, "fixtures");
  mkdirSync(fx, { recursive: true });
  const index: Record<string, string> = {};
  Object.entries(fixtures).forEach(([path, body], i) => {
    const f = join(fx, `${i}.json`);
    writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body));
    index[path] = f;
  });
  writeFileSync(join(fx, "index.json"), JSON.stringify(index));
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash
${extra}
if [ "$1" = "api" ]; then
  shift; [ "$1" = "--paginate" ] && shift
  path="\${1%%\\?*}"
  f="$(jq -r --arg p "$path" '.[$p] // ""' ${JSON.stringify(join(fx, "index.json"))})"
  if [ -n "$f" ]; then cat "$f"; exit 0; fi
  echo "gh: Not Found (HTTP 404) $path" >&2; exit 1
fi
echo "fake gh: unhandled $*" >&2; exit 1
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}

const R = "octo/repo";
const ENV_PATH = `repos/${R}/environments/release-promote`;
const POL_PATH = `${ENV_PATH}/deployment-branch-policies`;
const CREATE_PATH = `repos/${R}/rulesets/24044017`;
const IMMUT_PATH = `repos/${R}/rulesets/23944797`;
const goodEnv = () => ({
  name: "release-promote",
  protection_rules: [
    { type: "required_reviewers", prevent_self_review: false, reviewers: [{ type: "User", reviewer: { login: "heskew" } }] },
    { type: "branch_policy" },
  ],
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
});
const goodPolicies = () => ({ total_count: 1, branch_policies: [{ id: 1, name: "v*", type: "tag" }] });
const goodCreate = () => ({
  id: 24044017,
  name: "release-tags-create",
  target: "tag",
  enforcement: "active",
  conditions: { ref_name: { exclude: [], include: ["refs/tags/v*"] } },
  rules: [{ type: "creation" }],
});
const goodImmutable = () => ({
  id: 23944797,
  name: "release-tags-immutable",
  target: "tag",
  enforcement: "active",
  conditions: { ref_name: { exclude: [], include: ["refs/tags/v*", "refs/tags/adk-flair-v*"] } },
  rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "update" }],
  current_user_can_bypass: "never",
});
function boundaryFixtures(over: Record<string, unknown | undefined> = {}): Record<string, unknown> {
  const all: Record<string, unknown | undefined> = {
    [ENV_PATH]: goodEnv(),
    [POL_PATH]: goodPolicies(),
    [CREATE_PATH]: goodCreate(),
    [IMMUT_PATH]: goodImmutable(),
    ...over,
  };
  return Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined));
}
/** Run the real boundary step; returns its outputs. */
function runBoundary(fixtures: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "poll-boundary-"));
  try {
    const bin = fakeGh(dir, fixtures);
    const out = join(dir, "out");
    writeFileSync(out, "");
    const sh = join(dir, "step.sh");
    writeFileSync(sh, POLL_STEP("Verify the promote boundary").run ?? "");
    const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", sh], {
      encoding: "utf8",
      env: { ...process.env, ...POLL_ENV, PATH: `${bin}:${process.env.PATH}`, REPO: R, GH_TOKEN: "x", GITHUB_OUTPUT: out },
    });
    const outputs = Object.fromEntries(
      readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    return { status: r.status, log: (r.stdout ?? "") + (r.stderr ?? ""), ok: outputs.ok, reason: outputs.reason ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("release-promote-poll — checked settings are required before dispatch", () => {
  test("the pins name the environment the promote job uses and the two pinned v* tag rulesets", () => {
    expect(POLL_ENV.PROMOTE_ENV).toBe("release-promote");
    expect(POLL_ENV.TAG_CREATE_RULESET).toBe("24044017");
    expect(POLL_ENV.TAG_IMMUTABLE_RULESET).toBe("23944797");
    const promote = yaml.load(readFileSync(join(REPO, ".github", "workflows", "release-promote.yml"), "utf8")) as {
      jobs?: Record<string, { environment?: string }>;
    };
    expect(promote.jobs?.promote?.environment).toBe(POLL_ENV.PROMOTE_ENV);
    // The boundary step runs before the dispatching step, and the dispatch reads it.
    const steps = job("poll").steps ?? [];
    const b = steps.findIndex((s) => s.id === "boundary");
    const d = steps.findIndex((s) => (s.name ?? "") === "Poll and dispatch");
    expect(b).toBeGreaterThan(0);
    expect(b).toBeLessThan(d);
    expect(JSON.stringify(steps[d]?.env)).toContain("steps.boundary.outputs.ok");
  });

  test("present: environment with a v*-only tag policy (reviewers here, an operator choice), both rulesets active → ok", () => {
    const r = runBoundary(boundaryFixtures());
    expect(r.status, r.log).toBe(0);
    expect(r.ok).toBe("true");
    expect(r.reason).toBe("");
  });

  test("environment missing → refused, named", () => {
    const r = runBoundary(boundaryFixtures({ [ENV_PATH]: undefined, [POL_PATH]: undefined }));
    expect(r.status).toBe(0); // the step never fails the poll by itself…
    expect(r.ok).toBe("false"); // …it records the refusal
    expect(r.reason).toContain("environment 'release-promote' is missing or unreadable");
  });

  test("reviewers absent → ok (reviewers are optional)", () => {
    const noRule = { ...goodEnv(), protection_rules: [{ type: "branch_policy" }] };
    const empty = { ...goodEnv(), protection_rules: [{ type: "required_reviewers", reviewers: [] }, { type: "branch_policy" }] };
    const none = { ...goodEnv(), protection_rules: [] };
    for (const env of [noRule, empty, none]) {
      const r = runBoundary(boundaryFixtures({ [ENV_PATH]: env }));
      expect(r.status, r.log).toBe(0);
      expect(r.ok).toBe("true");
      expect(r.reason).toBe("");
    }
  });

  test("wrong deployment policy → refused, named (all refs, protected branches, a branch rule, an extra rule)", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ [ENV_PATH]: { ...goodEnv(), deployment_branch_policy: null } }, "does not limit deployments to selected tags"],
      [{ [ENV_PATH]: { ...goodEnv(), deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } } }, "does not limit deployments to selected tags"],
      [{ [POL_PATH]: { total_count: 1, branch_policies: [{ name: "v*", type: "branch" }] } }, "is not exactly the tag pattern v*"],
      [{ [POL_PATH]: { total_count: 2, branch_policies: [{ name: "v*", type: "tag" }, { name: "main", type: "branch" }] } }, "is not exactly the tag pattern v*"],
      [{ [POL_PATH]: { total_count: 1, branch_policies: [{ name: "*", type: "tag" }] } }, "is not exactly the tag pattern v*"],
      [{ [POL_PATH]: undefined }, "could not read the deployment policies"],
    ];
    for (const [over, msg] of cases) {
      const r = runBoundary(boundaryFixtures(over));
      expect(r.ok, msg).toBe("false");
      expect(r.reason).toContain(msg);
    }
  });

  test.each(["always", "pull_requests", null, undefined, "unknown"])(
    "immutable ruleset current_user_can_bypass=%j → refused", (permission) => {
      const immutable: Record<string, unknown> = { ...goodImmutable(), current_user_can_bypass: permission };
      if (permission === undefined) delete immutable.current_user_can_bypass;
      const r = runBoundary(boundaryFixtures({ [IMMUT_PATH]: immutable }));
      expect(r.status, r.log).toBe(0);
      expect(r.ok).toBe("false");
      expect(r.reason).toContain("must report current_user_can_bypass=never for the poll token");
    },
  );

  test("immutable ruleset requires adk-flair-v* coverage", () => {
    const immutable = { ...goodImmutable(), conditions: { ref_name: { exclude: [], include: ["refs/tags/v*"] } } };
    const r = runBoundary(boundaryFixtures({ [IMMUT_PATH]: immutable }));
    expect(r.ok).toBe("false");
    expect(r.reason).toContain("does not cover refs/tags/adk-flair-v*");
  });

  test("an inactive tag ruleset → refused, named", () => {
    for (const enforcement of ["evaluate", "disabled"]) {
      const r = runBoundary(boundaryFixtures({ [CREATE_PATH]: { ...goodCreate(), enforcement } }));
      expect(r.ok).toBe("false");
      expect(r.reason).toContain(`tag ruleset 24044017 (release-tags-create) is not active (enforcement '${enforcement}')`);
    }
    const r = runBoundary(boundaryFixtures({ [IMMUT_PATH]: { ...goodImmutable(), enforcement: "disabled" } }));
    expect(r.reason).toContain("tag ruleset 23944797 (release-tags-immutable) is not active");
  });

  test("a tag ruleset missing, without its rule, or not covering refs/tags/v* → refused, named", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ [CREATE_PATH]: undefined }, "tag ruleset 24044017 (release-tags-create) is missing or unreadable"],
      [{ [CREATE_PATH]: { ...goodCreate(), rules: [{ type: "update" }] } }, 'does not apply ["creation"] to refs/tags/v*'],
      [{ [IMMUT_PATH]: { ...goodImmutable(), rules: [{ type: "deletion" }] } }, "(release-tags-immutable) does not apply"],
      [{ [CREATE_PATH]: { ...goodCreate(), conditions: { ref_name: { exclude: [], include: ["refs/tags/adk-flair-v*"] } } } }, "(release-tags-create) does not apply"],
      [{ [CREATE_PATH]: { ...goodCreate(), conditions: { ref_name: { exclude: ["refs/tags/v9*"], include: ["refs/tags/v*"] } } } }, "(release-tags-create) does not apply"],
      [{ [CREATE_PATH]: { ...goodCreate(), target: "branch" } }, "(release-tags-create) does not apply"],
    ];
    for (const [over, msg] of cases) {
      const r = runBoundary(boundaryFixtures(over));
      expect(r.ok, msg).toBe("false");
      expect(r.reason).toContain(msg);
    }
  });
});

// ── The poll step itself: dedup within a poll, and the boundary refusal ──────

/** sha256 the stub hasher prints for `<version> <pkg>`. */
const stubSha = (version: string, pkg: string) => createHash("sha256").update(`${version}\n${pkg}`).digest("hex");
function setDigest(version: string, pkgs: string[]): string {
  const rows = pkgs.map((p) => `${p}@${version} ${stubSha(version, p)}\n`).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return createHash("sha256").update(rows.join("")).digest("hex");
}
/** Run the real "Poll and dispatch" step in a fixture tree; returns the dispatches it made. */
function runPoll(markers: unknown[], boundary: { ok: string; reason?: string }, runs: unknown[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "poll-run-"));
  try {
    mkdirSync(join(dir, "scripts", "ci"), { recursive: true });
    copyFileSync(join(REPO, "scripts", "ci", "lockstep-packages.mjs"), join(dir, "scripts", "ci", "lockstep-packages.mjs"));
    writeFileSync(
      join(dir, "scripts", "ci", "registry-tarball-sha256.mjs"),
      `import { createHash } from "node:crypto";\nconst [v, p] = process.argv.slice(2);\nprocess.stdout.write(createHash("sha256").update(v + "\\n" + p).digest("hex") + "\\n");\n`,
    );
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@tpsdev-ai/flair", version: "0.0.0" }));
    mkdirSync(join(dir, "packages", "client"), { recursive: true });
    writeFileSync(join(dir, "packages", "client", "package.json"), JSON.stringify({ name: "@tpsdev-ai/flair-client", version: "0.0.0" }));
    const dispatches = join(dir, "dispatches.log");
    writeFileSync(dispatches, "");
    const bin = fakeGh(
      dir,
      {
        [`repos/${R}/deployments`]: markers,
        [`repos/${R}/actions/workflows/release-promote.yml`]: { id: 1 },
        [`repos/${R}/actions/workflows/release-promote.yml/runs`]: { total_count: runs.length, workflow_runs: runs },
      },
      `if [ "$1" = "workflow" ] && [ "$2" = "run" ]; then echo "$*" >> ${JSON.stringify(dispatches)}; exit 0; fi
if [ "$1" = "api" ] && [[ "$*" == *"environment=promoted"* ]]; then echo '[]'; exit 0; fi`,
    );
    const sh = join(dir, "poll.sh");
    writeFileSync(sh, POLL_STEP("Poll and dispatch").run ?? "");
    const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", sh], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        REPO: R,
        GH_TOKEN: "x",
        BOUNDARY_OK: boundary.ok,
        BOUNDARY_REASON: boundary.reason ?? "",
      },
    });
    return {
      status: r.status,
      log: (r.stdout ?? "") + (r.stderr ?? ""),
      dispatches: readFileSync(dispatches, "utf8").split("\n").filter(Boolean),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const PKGS = ["@tpsdev-ai/flair-client", "@tpsdev-ai/flair"];
const marker = (version: string) => ({ ref: `v${version}`, payload: { version, package_set_digest: setDigest(version, PKGS) } });

describe("release-promote-poll — each version is dispatched at most once per poll", () => {
  test.each(["queued", "in_progress", "completed"])("a manual dry run (%s) does not suppress the real dispatch", (status) => {
    const r = runPoll([marker("1.2.3")], { ok: "true" }, [{
      display_title: "release-promote v1.2.3 (dry run)", head_branch: "v1.2.3", status, conclusion: status === "completed" ? "success" : null,
    }]);
    expect(r.status, r.log).toBe(0);
    expect(r.dispatches).toEqual(["workflow run release-promote.yml --ref v1.2.3 -f dry_run=false"]);
  });

  test.each(["queued", "in_progress", "completed"])("a real promotion (%s; success when completed) suppresses dispatch", (status) => {
    const r = runPoll([marker("1.2.3")], { ok: "true" }, [{
      display_title: "release-promote v1.2.3", head_branch: "v1.2.3", status, conclusion: status === "completed" ? "success" : null,
    }]);
    expect(r.status, r.log).toBe(0);
    expect(r.dispatches).toEqual([]);
    expect(r.log).toContain("not dispatching again");
    expect(r.log).not.toContain("requires human review");
  });

  test.each(["failure", "cancelled", "timed_out", "action_required", "neutral", "skipped", "stale", null])(
    "a completed real attempt (%s) requires human review without redispatch", (conclusion) => {
      const r = runPoll([marker("1.2.3")], { ok: "true" }, [{
        display_title: "release-promote v1.2.3", head_branch: "v1.2.3", status: "completed", conclusion,
      }]);
      expect(r.status, r.log).toBe(0);
      expect(r.dispatches).toEqual([]);
      expect(r.log).toContain("a human must inspect the run before retrying");
    },
  );

  test("an unrecognised title on the tag branch does not establish promotion mode", () => {
    const r = runPoll([marker("1.2.3")], { ok: "true" }, [{
      display_title: "other", head_branch: "v1.2.3", status: "in_progress",
    }]);
    expect(r.status, r.log).toBe(0);
    expect(r.dispatches).toEqual(["workflow run release-promote.yml --ref v1.2.3 -f dry_run=false"]);
  });

  test.each(["waiting", "pending", "requested", "unknown", null])("a real attempt with status %s requires human review", (status) => {
    const r = runPoll([marker("1.2.3")], { ok: "true" }, [{ display_title: "release-promote v1.2.3", status }]);
    expect(r.status, r.log).toBe(0);
    expect(r.dispatches).toEqual([]);
    expect(r.log).toContain("a human must inspect the run before retrying");
  });

  test("duplicate marker rows for one version dispatch it once", () => {
    const r = runPoll([marker("1.2.3"), marker("1.2.3"), marker("1.2.3")], { ok: "true" });
    expect(r.status, r.log).toBe(0);
    expect(r.dispatches).toEqual(["workflow run release-promote.yml --ref v1.2.3 -f dry_run=false"]);
    expect(r.log).toContain("v1.2.3: duplicate marker row — already handled in this poll, skipping");
  });

  test("control: two distinct ready versions are each dispatched once", () => {
    const r = runPoll([marker("1.2.3"), marker("1.2.4"), marker("1.2.3")], { ok: "true" });
    expect(r.status, r.log).toBe(0);
    expect(r.dispatches).toEqual([
      "workflow run release-promote.yml --ref v1.2.3 -f dry_run=false",
      "workflow run release-promote.yml --ref v1.2.4 -f dry_run=false",
    ]);
  });

  test("a failed settings check: an error exit naming the reason, and nothing dispatched", () => {
    const reason = "environment 'release-promote' is missing or unreadable";
    const r = runPoll([marker("1.2.3"), marker("1.2.4")], { ok: "false", reason });
    expect(r.status).toBe(1);
    expect(r.log).toContain(`refusing to dispatch release-promote for v1.2.3: the promote boundary is not in place: ${reason}`);
    expect(r.dispatches).toEqual([]);
    // A missing settings result also prevents dispatch.
    const unknown = runPoll([marker("1.2.3")], { ok: "" });
    expect(unknown.status).toBe(1);
    expect(unknown.dispatches).toEqual([]);
  });
});
