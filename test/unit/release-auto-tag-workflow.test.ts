/**
 * release-auto-tag-workflow.test.ts — flair#1890, `.github/workflows/release-auto-tag.yml`.
 *
 * The unit tests next door drive the decision script; THIS file is about the
 * wiring the script cannot see: which job holds which permission, which JOB gets
 * the App credential, whether the reporter is guarded and idempotent, and whether
 * a dry run can write. It is a detective, not a boundary — a PR can edit the
 * workflow and this test together; the boundary is review of the diff.
 *
 * Round 2 split `decide` and `write` into SEPARATE jobs (the amendment in #1890,
 * "Two jobs, not one"): the credential isolation is the JOB BOUNDARY, not a
 * restore of a shared workspace. Acceptance item 9's YAML half lives here (the
 * report job's guard, its permissions, the absence of a checkout, and the
 * decide/write job-output mapping and the write-before-decide read), and so do
 * the invariants: `decide` holds no App credential at all, and every checkout
 * sets `persist-credentials: false`.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
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
  needs?: string | string[];
  permissions?: Record<string, string>;
  environment?: string;
  outputs?: Record<string, string>;
  steps?: Step[];
}

interface Workflow {
  name?: string;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs?: Record<string, Job>;
}

const REPO = join(import.meta.dir, "..", "..");
const WORKFLOW_PATH = join(REPO, ".github", "workflows", "release-auto-tag.yml");
const CI_PATH = join(REPO, ".github", "workflows", "test.yml");
const ADVISORY_PATH = join(REPO, ".github", "release-auto-tag-advisories.json");

const raw = readFileSync(WORKFLOW_PATH, "utf8");
const ciRaw = readFileSync(CI_PATH, "utf8");
const wf = yaml.load(raw) as unknown as Workflow;
const events = (wf as unknown as Record<string, unknown>)["on"] as Record<string, unknown>;

function job(name: string): Job {
  const found = wf.jobs?.[name];
  expect(found, `job ${name} exists`).toBeDefined();
  return found as Job;
}

function step(name: string, id: string): Step {
  const found = (job(name).steps ?? []).find((s) => s.id === id);
  expect(found, `job ${name} has a step with id ${id}`).toBeDefined();
  return found as Step;
}

function allSteps(): Array<{ job: string; step: Step }> {
  return Object.entries(wf.jobs ?? {}).flatMap(([name, j]) => (j.steps ?? []).map((s) => ({ job: name, step: s })));
}

describe("release-auto-tag workflow — least privilege and custody", () => {
  test("permissions: {} at the top, and the issue's exact per-job grants", () => {
    expect(wf.permissions).toEqual({});
    expect(Object.keys(job("decide").permissions ?? {}).sort()).toEqual(["actions", "checks", "contents", "pull-requests"]);
    for (const grant of Object.values(job("decide").permissions ?? {})) expect(grant).toBe("read");
    // `write` re-runs conditions 1-9 (it trusts nothing from `decide`), so it
    // needs the SAME read grants as `decide`; the ref write itself is the App
    // token, not GITHUB_TOKEN.
    expect(Object.keys(job("write").permissions ?? {}).sort()).toEqual(["actions", "checks", "contents", "pull-requests"]);
    for (const grant of Object.values(job("write").permissions ?? {})) expect(grant).toBe("read");
    expect(job("report").permissions).toEqual({ issues: "write" });
  });

  test("the release-tag environment is referenced by exactly one job — `write`", () => {
    const referencing = Object.entries(wf.jobs ?? {}).filter(([, j]) => j.environment !== undefined);
    expect(referencing.map(([name]) => name)).toEqual(["write"]);
    expect(job("write").environment).toBe("release-tag");
  });

  test("invariant: the App credential lives ONLY in the `write` job (round 2, item 1)", () => {
    // `decide` reads the candidate as data (condition 6) and runs no candidate
    // code. It must hold no App secret at all: no environment, and no step naming
    // the App id/key or the mint action.
    expect(job("decide").environment).toBeUndefined();
    const decideText = JSON.stringify(job("decide"));
    expect(decideText).not.toContain("RELEASE_TAG_APP_PRIVATE_KEY");
    expect(decideText).not.toContain("RELEASE_TAG_APP_ID");
    expect(decideText).not.toContain("create-github-app-token");

    // The decision's environment is the read-only set and nothing else.
    const decideEnv = step("decide", "decide").env ?? {};
    expect(Object.keys(decideEnv).sort()).toEqual([
      "GH_TOKEN",
      "REPO",
      "SELF_RUN_ID",
      "TARGET_SHA",
      "TRIGGER_CHECK_SUITE_ID",
    ]);
    expect(String(decideEnv.GH_TOKEN)).toBe("${{ secrets.GITHUB_TOKEN }}");

    // `write` holds it, on a fresh runner, and the private key is never
    // interpolated into an env — only the mint's `with:` and a PRESENCE boolean.
    expect(step("write", "app-token")).toBeDefined();
    expect(String(step("write", "write").env?.RELEASE_TAG_APP_KEY_PRESENT)).toContain("!= ''");
    const rawKeyUsers = (job("write").steps ?? []).filter((s) => JSON.stringify(s).includes("secrets.RELEASE_TAG_APP_PRIVATE_KEY"));
    expect(rawKeyUsers.map((s) => s.id ?? s.name)).toEqual(["app-token", "write"]);
  });

  test("round 3 (CodeRabbit): the write step READS with GITHUB_TOKEN and WRITES with the App token", () => {
    // The App holds no pull-requests permission, so condition 10's reviews read
    // must run on the read-only token; only the ref write uses the App token.
    const env = step("write", "write").env ?? {};
    expect(String(env.GH_READ_TOKEN)).toBe("${{ secrets.GITHUB_TOKEN }}");
    expect(String(env.GH_TOKEN)).toBe("${{ steps.app-token.outputs.token }}");
  });

  test("every checkout sets persist-credentials: false (round 1/2)", () => {
    const checkouts = allSteps().filter(({ step: s }) => typeof s.uses === "string" && s.uses.startsWith("actions/checkout@"));
    expect(checkouts.length, "positive control: both job checkouts found").toBe(2);
    expect(checkouts.map(({ job: j }) => j).sort()).toEqual(["decide", "write"]);
    for (const { job: j, step: s } of checkouts) {
      expect(s.with?.["persist-credentials"], `${j} checkout`).toBe(false);
      expect(s.with?.["fetch-depth"], `${j} checkout`).toBe(0);
    }
  });

  test("every action is pinned by a full commit SHA", () => {
    const uses = allSteps()
      .map(({ step: s }) => s.uses)
      .filter((u): u is string => typeof u === "string");
    expect(uses.length).toBeGreaterThan(0); // positive control: the search found actions
    for (const use of uses) expect(use).toMatch(/^[^@]+@[0-9a-f]{40}$/);
    for (const use of uses) expect(use).not.toMatch(/@(v|main|master)/);
    expect(uses.some((u) => u.startsWith("actions/create-github-app-token@"))).toBe(true);
  });

  test("the App token is minted with contents-write on this repo only", () => {
    const withArgs = step("write", "app-token").with ?? {};
    expect(withArgs["permission-contents"]).toBe("write");
    expect(withArgs.repositories).toBe("flair");
    expect(Object.keys(withArgs).filter((k) => k.startsWith("permission-"))).toEqual(["permission-contents"]);
  });
});

describe("release-auto-tag workflow — triggers and guards", () => {
  test("the three entry events, each with its guard", () => {
    const wr = events.workflow_run as { workflows?: string[]; types?: string[] } | undefined;
    expect(wr?.workflows).toEqual(["CI"]);
    expect(wr?.types).toEqual(["completed"]);
    expect(Array.isArray(events.schedule)).toBe(true);
    const dispatch = events.workflow_dispatch as { inputs?: Record<string, { required?: boolean }> } | undefined;
    expect(dispatch?.inputs?.sha?.required).toBe(true);

    const guard = job("decide").if ?? "";
    expect(guard).toContain("github.event_name == 'schedule'");
    expect(guard).toContain("github.event_name == 'workflow_dispatch'");
    expect(guard).toContain("github.event.workflow_run.event == 'push'");
    expect(guard).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(guard).toContain("github.event.workflow_run.conclusion == 'success'");
  });

  test("the path guard strips the @<ref> suffix, and still refuses a different workflow (round 2, item 2)", () => {
    const assertStep = (job("decide").steps ?? []).find((s) => (s.run ?? "").includes(".github/workflows/test.yml"));
    expect(assertStep).toBeDefined();
    expect(assertStep?.if).toContain("workflow_run");
    // GitHub reports workflow_run.path as "<path>@<ref>", so the exact comparison
    // must run on the suffix-stripped value.
    expect(assertStep?.run).toContain("%%@*");

    const runAssert = (triggerPath: string) =>
      spawnSync("bash", ["-c", assertStep?.run as string], {
        env: { PATH: process.env.PATH, TRIGGER_NAME: "CI", TRIGGER_PATH: triggerPath },
        encoding: "utf8",
      });
    // BOTH forms of the real path pass — the suffixed one is what GitHub reports.
    expect(runAssert(".github/workflows/test.yml@main").status).toBe(0);
    expect(runAssert(".github/workflows/test.yml").status).toBe(0);
    // A different workflow, with or without a suffix, still fails loudly.
    const other = runAssert(".github/workflows/other.yml@main");
    expect(other.status).not.toBe(0);
    expect(other.stderr).toContain("REFUSING");
  });

  test("concurrency: release-auto-tag, and it never cancels", () => {
    expect(wf.concurrency?.group).toBe("release-auto-tag");
    expect(wf.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  test("a dry run cannot write: the write job is excluded on dispatch, and its POST still runs after a failed mint", () => {
    const writeJob = job("write");
    expect(writeJob.needs).toBe("decide");
    expect(writeJob.if).toContain("github.event_name != 'workflow_dispatch'");
    expect(writeJob.if).toContain("needs.decide.outputs.verdict == 'TAG'");
    // The POST step still runs after a failed mint so it can REFUSE
    // `app-not-configured` rather than silently doing nothing.
    expect(step("write", "write").if).toContain("always()");
  });

  test("no run: block interpolates a value with ${{ }} — everything goes through env:", () => {
    for (const { job: name, step: s } of allSteps()) {
      if (typeof s.run === "string") expect(s.run, `${name}/${s.id ?? s.name} run: must not interpolate`).not.toContain("${{");
    }
  });

  test("the decide step runs the script from the default branch, asks for the nightly without a sha, and names the trigger's check suite", () => {
    const checkout = (job("decide").steps ?? [])[0];
    expect(checkout.uses).toContain("actions/checkout@");
    expect(String(checkout.with?.ref)).toContain("github.event.repository.default_branch");
    const run = step("decide", "decide").run ?? "";
    expect(run).toContain("node scripts/release-auto-tag.mjs");
    expect(run).toContain("--nightly");
    expect(run).toContain('--sha "$TARGET_SHA"');
    expect(run).toContain("--self-run-id");
    expect(run).toContain("--trigger-check-suite-id");
    expect(String(step("decide", "decide").env?.TRIGGER_CHECK_SUITE_ID)).toBe("${{ github.event.workflow_run.check_suite_id }}");
  });

  test("the checks-pending deadline in the workflow is the measured one, with its method", () => {
    expect(step("decide", "decide").run).toContain("--deadline-minutes 30");
    const header = raw.slice(0, raw.indexOf("\npermissions:"));
    expect(header).toContain("P95");
    expect(header).toContain("per_page=30");
    expect(header).toContain("test.yml");
    expect(header).toContain("30 minutes");
  });
});

describe("release-auto-tag workflow — the reporter (acceptance 9, YAML half)", () => {
  test("the report job's guard: always(), REFUSE read from write BEFORE decide, never dispatch", () => {
    const report = job("report");
    expect(report.needs).toEqual(["decide", "write"]);
    expect(report.if).toContain("always()");
    expect(report.if).toContain("needs.write.outputs.verdict || needs.decide.outputs.verdict");
    expect(report.if).toContain("github.event_name != 'workflow_dispatch'");
    // The condition and version it renders read write's before decide's too.
    // The adk condition wins when the adk write refused (slice 3 of #1928).
    const env = (report.steps ?? [])[0].env ?? {};
    expect(String(env.CONDITION)).toBe(
      "${{ needs.write.outputs.adk_verdict == 'REFUSE' && needs.write.outputs.adk_condition || needs.write.outputs.condition || needs.decide.outputs.condition }}",
    );
    expect(String(env.VERSION)).toBe("${{ needs.write.outputs.version || needs.decide.outputs.version }}");
  });

  test("the report job: issues: write only, and it checks out nothing", () => {
    expect(job("report").permissions).toEqual({ issues: "write" });
    const steps = job("report").steps ?? [];
    expect(steps.length).toBeGreaterThan(0); // positive control
    // No action at all: a checkout would put the tree (and its scripts) on the
    // runner. The reporter talks to the API and nothing else.
    for (const s of steps) expect(s.uses).toBeUndefined();
    for (const s of steps) expect(s.run ?? "").not.toContain("node ");
  });

  test("the reporter's title is the fixed template, and it is idempotent by title", () => {
    const run = (job("report").steps ?? []).map((s) => s.run ?? "").join("\n");
    expect(run).toContain("release auto-tag refused v");
    expect(run).toContain("${CONDITION}");
    expect(run).toContain("open_count");
    expect(run).toContain("gh issue create");
  });

  test("decide and write each map verdict, condition and version to their JOB outputs", () => {
    const decide = job("decide").outputs ?? {};
    expect(decide.verdict).toBe("${{ steps.decide.outputs.verdict }}");
    expect(decide.condition).toBe("${{ steps.decide.outputs.condition }}");
    expect(decide.version).toBe("${{ steps.decide.outputs.version }}");
    // The commit `decide` decided on — INFORMATIONAL: `write` re-derives its own
    // (round 3), so this output gates nothing.
    expect(decide.sha).toBe("${{ steps.decide.outputs.sha }}");

    const write = job("write").outputs ?? {};
    // `write`'s own verdict wins; its re-derivation is the fallback.
    expect(write.verdict).toBe("${{ steps.write.outputs.verdict || steps.redecide.outputs.verdict }}");
    expect(write.condition).toBe("${{ steps.write.outputs.condition || steps.redecide.outputs.condition }}");
    expect(write.version).toBe("${{ steps.write.outputs.version || steps.redecide.outputs.version }}");
  });

  test("round 3: `write` trusts nothing from `decide` — it binds its own target and re-derives the decision", () => {
    const steps = job("write").steps ?? [];
    const indexOf = (fn: (s: Step) => boolean) => steps.findIndex(fn);
    const bindIndex = indexOf((s) => s.id === "bind");
    const redecideIndex = indexOf((s) => s.id === "redecide");
    const mintIndex = indexOf((s) => s.id === "app-token");
    expect(bindIndex).toBeGreaterThan(-1);
    expect(redecideIndex).toBeGreaterThan(bindIndex);
    expect(mintIndex).toBeGreaterThan(redecideIndex);

    // It binds the target from the EVENT, never from `needs.decide.outputs`.
    const bind = step("write", "bind");
    expect(String(bind.env?.WORKFLOW_RUN_SHA)).toBe("${{ github.event.workflow_run.head_sha }}");
    expect(JSON.stringify(bind)).not.toContain("needs.decide.outputs");

    // It re-runs the WHOLE decision (conditions 1-9) for its own bound commit.
    expect(step("write", "redecide").run).toContain("release-auto-tag.mjs");
    expect(step("write", "redecide").run).toContain("--nightly");
    expect(String(step("write", "redecide").env?.TARGET_SHA)).toBe("${{ steps.bind.outputs.sha }}");

    // The mint and the POST happen only after the re-derivation said TAG, and the
    // sha/version they use are the re-derivation's own — never decide's.
    expect(String(step("write", "app-token").if)).toContain("steps.redecide.outputs.verdict == 'TAG'");
    expect(String(step("write", "write").if)).toContain("steps.redecide.outputs.verdict == 'TAG'");
    expect(String(step("write", "write").env?.TARGET_SHA)).toBe("${{ steps.redecide.outputs.sha }}");
    expect(String(step("write", "write").env?.VERSION)).toBe("${{ steps.redecide.outputs.version }}");
    // decide's outputs reach the write job's START GATE only.
    expect(job("write").if).toContain("needs.decide.outputs.verdict == 'TAG'");
  });
});

describe("release-auto-tag workflow — the coupling and the allowlist file", () => {
  test("test.yml carries the coupling comment, and its push trigger really has no paths filter", () => {
    expect(ciRaw).toContain("LIVENESS COUPLING");
    expect(ciRaw).toContain("release-auto-tag.yml");
    expect(ciRaw).toContain('workflows: ["CI"]');
    // The coupling is only real while the CI workflow still fires on every push
    // to main: a paths filter here would silently stop tagging releases.
    const ci = yaml.load(ciRaw) as unknown as { on?: { push?: { paths?: unknown; branches?: unknown } } };
    const push = ci.on?.push;
    expect(push).toBeDefined();
    expect(push?.paths).toBeUndefined();
    expect(push?.branches).toEqual(["main"]);
  });

  test("the decide step reads the tagger's own allowlist file", () => {
    expect(step("decide", "decide").run).toContain("--advisory-allowlist .github/release-auto-tag-advisories.json");
  });

  test("the allowlist seed is exactly the check main declares advisory", () => {
    const parsed = yaml.load(readFileSync(ADVISORY_PATH, "utf8")) as unknown as { allow: string[] };
    expect(parsed.allow).toEqual(["launchd adopt-then-upgrade (macOS, advisory)"]);
  });
});

// ── CODEOWNERS: the trust root (#1890, round 4 item 2) ────────────────────────

describe("release-auto-tag workflow — the trust root is owned by the repo admin", () => {
  test("round 4, item 2 (round 6, item 1): CODEOWNERS gives the trust root — the tagger, its workflow, the checker, the allowlist and this file — one owner", () => {
    const rules = readFileSync(join(REPO, ".github", "CODEOWNERS"), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => {
        const [pattern, ...owners] = line.split(/\s+/);
        return { pattern: pattern ?? "", owners: owners.join(" ") };
      });
    const ownerOf = (pattern: string) => rules.find((r) => r.pattern === pattern)?.owners ?? null;
    const indexOf = (pattern: string) => rules.findIndex((r) => r.pattern === pattern);
    // A release PR cannot change what the tagger does (condition 7b), and a
    // change to the tagger itself needs the repo admin — not a release. The LAST
    // matching pattern wins in CODEOWNERS, so each specific rule must sit BELOW
    // the catch-all for it to be the one that applies.
    for (const pattern of [
      "/.github/workflows/release-*.yml",
      "/scripts/release-auto-tag.mjs",
      "/scripts/check-version-sync.mjs",
      "/.github/release-auto-tag-advisories.json",
      "/.github/CODEOWNERS",
    ]) {
      expect(ownerOf(pattern), `${pattern} is owned`).toBe("@heskew");
      expect(indexOf(pattern), `${pattern} is below the catch-all`).toBeGreaterThan(indexOf("*"));
    }
    // The ownership map ITSELF (round 6, item 1): without the entry above the
    // catch-all makes the reviewers team the owner of this file, so a
    // collaborator with merge access and that team's approval could delete the
    // trust-root entries and then change the tagger in a later pull request.
    expect(ownerOf("/.github/CODEOWNERS"), ".github/CODEOWNERS is not left to the catch-all").not.toBe(
      ownerOf("*"),
    );
    // …and the existing catch-all still covers everything else, unchanged.
    expect(ownerOf("*")).toBe("@tpsdev-ai/reviewers");
  });
});

describe("release-auto-tag workflow — credential isolation and the reporter's shell", () => {
  test("isolation is the JOB BOUNDARY: `write` has a fresh default-branch checkout, and no step restores a shared tree", () => {
    // The single-job design restored the workspace between the decision and the
    // mint. That is GONE: `write` is a different job on a fresh runner with a
    // fresh checkout, so the tree `decide` read the candidate in is never reused
    // for a privileged step — a tree restore could not cover `.git` anyway.
    const writeCheckout = (job("write").steps ?? [])[0];
    expect(writeCheckout.uses).toContain("actions/checkout@");
    expect(String(writeCheckout.with?.ref)).toContain("github.event.repository.default_branch");

    const runs = allSteps().map(({ step: s }) => s.run ?? "");
    expect(runs.some((r) => r.includes("git clean -ffdqx"))).toBe(false);
    expect(runs.some((r) => r.includes("git reset --hard HEAD"))).toBe(false);
    // And the mint is not in the deciding job.
    expect((job("decide").steps ?? []).some((s) => s.id === "app-token")).toBe(false);
  });

  test("the write job re-reads main before its re-derivation and the POST, so a release that merged during the wait is seen", () => {
    const steps = job("write").steps ?? [];
    const indexOf = (fn: (s: Step) => boolean) => steps.findIndex(fn);
    const lastIndexOf = (fn: (s: Step) => boolean) => steps.map(fn).lastIndexOf(true);
    const isFetch = (s: Step) => (s.run ?? "").includes("git fetch") && (s.run ?? "").includes("refs/heads/main");
    const fetchIndex = indexOf(isFetch);
    const redecideIndex = indexOf((s) => s.id === "redecide");
    const mintIndex = indexOf((s) => s.id === "app-token");
    const writeIndex = indexOf((s) => s.id === "write");
    expect(fetchIndex).toBeGreaterThan(-1);
    expect(fetchIndex).toBeLessThan(redecideIndex);
    expect(redecideIndex).toBeLessThan(mintIndex);
    expect(mintIndex).toBeLessThan(writeIndex);
    // AND again after the re-derivation: `redecide` can itself poll for up to 30
    // minutes, so the first fetch is stale by the time the tag's release-intent
    // re-check runs. Without the second fetch a release that merged during the
    // wait is tagged as superseded (round 4: the CodeRabbit finding).
    const refetchIndex = lastIndexOf(isFetch);
    expect(refetchIndex, "main is fetched again after the re-derivation").toBeGreaterThan(redecideIndex);
    expect(refetchIndex).toBeLessThan(writeIndex);
    expect(step("write", "write").run).toContain("release-auto-tag.mjs tag");
  });

  test("round 6, item 2: the tag step requires the re-fetch's success, and the fetch still runs after a failed mint", () => {
    const steps = job("write").steps ?? [];
    const isFetch = (s: Step) => (s.run ?? "").includes("git fetch") && (s.run ?? "").includes("refs/heads/main");
    const fetches = steps.filter(isFetch);
    expect(fetches.length, "main is fetched twice in `write`").toBe(2);
    const refetch = fetches[1] as Step;
    // The re-fetch is addressable by the tag step…
    expect(typeof refetch.id, "the re-fetch has an id").toBe("string");
    // …it runs even when the App-token mint failed, so the SEPARATE
    // `app-not-configured` REFUSE below still fires…
    expect(String(refetch.if)).toContain("always()");
    // …and the tag step REQUIRES that fetch to have succeeded. With `always()`
    // alone a failed fetch left `origin/main` at its older value while the tag
    // step still ran, so condition 10 tagged the release that the wait had
    // superseded (round 6, item 2).
    const tagIf = String(step("write", "write").if);
    expect(tagIf).toContain(`steps.${refetch.id as string}.outcome == 'success'`);
    // The mint-failure path is intact: still `always()`, still gated on TAG.
    expect(tagIf).toContain("always()");
    expect(tagIf).toContain("steps.redecide.outputs.verdict == 'TAG'");
    expect(String(step("write", "app-token").if)).toContain("steps.redecide.outputs.verdict == 'TAG'");
  });

  test("the reporter's shell: opens an issue when no page holds the title, and does nothing when one does", () => {
    // Behavioural, with a fake `gh` that emulates `--paginate` (one JSON array
    // per page) and a real `jq` — the old count of a two-page result was "0\n0",
    // which is not "0", so the reporter silently stopped reporting.
    const script = (job("report").steps ?? [])[0].run;
    expect(typeof script).toBe("string");
    const dir = mkdtempSync(join(tmpdir(), "release-auto-tag-report-"));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(bin, "gh"),
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'case "$1" in',
          "  api)",
          "    printf '%s\\n' '[{\"number\":1,\"title\":\"unrelated\"},{\"number\":2,\"title\":\"another\"}]'",
          "    printf '%s\\n' '[{\"number\":3,\"title\":\"'\"$FAKE_TITLE\"'\"}]'",
          "    ;;",
          "  issue)",
          '    printf "%s\\n" "$*" >> "$FAKE_RECORD"',
          "    ;;",
          '  *) echo "unexpected gh call: $*" >&2; exit 9 ;;',
          "esac",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const title = "release auto-tag refused v0.57.0: reviews";
      const runReport = (fakeTitle: string, record: string) =>
        spawnSync("bash", ["-c", script as string], {
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            GH_TOKEN: "test-token",
            REPO: "tpsdev-ai/flair",
            CONDITION: "reviews",
            VERSION: "0.57.0",
            RUN_URL: "https://example.invalid/actions/runs/1",
            FAKE_TITLE: fakeTitle,
            FAKE_RECORD: record,
          },
          encoding: "utf8",
        });

      const openRecord = join(dir, "opened");
      const opened = runReport("no such issue", openRecord);
      expect(opened.status).toBe(0);
      expect(readFileSync(openRecord, "utf8")).toContain("issue create");
      expect(readFileSync(openRecord, "utf8")).toContain(title);

      const quietRecord = join(dir, "quiet");
      const quiet = runReport(title, quietRecord);
      expect(quiet.status).toBe(0);
      expect(quiet.stdout).toContain("already exists");
      expect(existsSync(quietRecord)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("release-auto-tag workflow — the adk-flair verdict (slice 3 of #1928)", () => {
  test("the write job publishes the adk verdict, and its Enforce step goes red on an adk REFUSE", () => {
    const write = job("write");
    expect(write.outputs?.adk_verdict).toBe("${{ steps.write.outputs.adk_verdict }}");
    expect(write.outputs?.adk_condition).toBe("${{ steps.write.outputs.adk_condition }}");
    const enforce = (write.steps ?? []).find((s) => (s.name ?? "").startsWith("Enforce"));
    expect(enforce, "the write job has an Enforce step").toBeDefined();
    // The job goes red on an adk REFUSE, not only a v REFUSE.
    expect(String(enforce!.if)).toContain("steps.write.outputs.adk_verdict == 'REFUSE'");
    // And the message names the adk condition when the adk write refused.
    expect(String(enforce!.env?.CONDITION)).toContain("steps.write.outputs.adk_condition");
  });

  test("the reporter fires on an adk REFUSE too, and names the adk condition", () => {
    const report = job("report");
    // The v verdict is TAGGED on an adk refusal, so the guard must ALSO watch the
    // adk verdict or the report job never runs.
    expect(String(report.if)).toContain("needs.write.outputs.adk_verdict == 'REFUSE'");
    const refusalStep = (report.steps ?? [])[0];
    expect(String(refusalStep.env?.CONDITION)).toContain("needs.write.outputs.adk_condition");
  });
});

describe("release-auto-tag workflow — the adk re-run (slice 3 of #1928, round 2)", () => {
  test("the write job's gate lets a same-sha re-run TAG through, and publishes v_verdict", () => {
    const write = job("write");
    // A same-sha re-run returns decide verdict TAG (the adk tag must be finished),
    // so the existing TAG gate lets it through.
    expect(String(write.if)).toContain("needs.decide.outputs.verdict == 'TAG'");
    expect(write.outputs?.v_verdict).toBe("${{ steps.write.outputs.v_verdict }}");
    expect(write.outputs?.adk_verdict).toBe("${{ steps.write.outputs.adk_verdict }}");
  });

  test("the reporter names a line PER REF, and no longer claims nothing was tagged", () => {
    const refusalStep = (job("report").steps ?? [])[0];
    const script = String(refusalStep.run ?? "");
    expect(script).toContain("v${VERSION}: ${V_VERDICT:-REFUSE}");
    expect(script).toContain("adk-flair-v${VERSION}: ${ADK_VERDICT:-not attempted}");
    expect(script).not.toContain("Nothing was tagged.");
    const env = refusalStep.env ?? {};
    expect(String(env.V_VERDICT)).toBe("${{ needs.write.outputs.v_verdict }}");
    expect(String(env.ADK_VERDICT)).toBe("${{ needs.write.outputs.adk_verdict }}");
  });
});
