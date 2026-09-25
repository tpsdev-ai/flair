/**
 * release-auto-tag-workflow.test.ts — flair#1890, `.github/workflows/release-auto-tag.yml`.
 *
 * The unit tests next door drive the decision script; THIS file is about the
 * wiring the script cannot see: which job holds which permission, which step gets
 * the App credential, whether the reporter is guarded and idempotent, and whether
 * a dry run can write. It is a detective, not a boundary — a PR can edit the
 * workflow and this test together; the boundary is review of the diff.
 *
 * Acceptance item 9's YAML half lives here (the report job's guard, its
 * permissions, the absence of a checkout, and the decide job's
 * verdict/condition/version mapping), and so does the second INVARIANT: no step
 * before the decision runs with the App credential in its environment.
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
  needs?: string;
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

describe("release-auto-tag workflow — least privilege and custody", () => {
  test("permissions: {} at the top, and the issue's exact per-job grants", () => {
    expect(wf.permissions).toEqual({});
    expect(Object.keys(job("decide").permissions ?? {}).sort()).toEqual(["actions", "checks", "contents", "pull-requests"]);
    for (const grant of Object.values(job("decide").permissions ?? {})) expect(grant).toBe("read");
    expect(job("report").permissions).toEqual({ issues: "write" });
  });

  test("the release-tag environment is referenced by exactly one job", () => {
    const referencing = Object.entries(wf.jobs ?? {}).filter(([, j]) => j.environment !== undefined);
    expect(referencing.map(([name]) => name)).toEqual(["decide"]);
    expect(job("decide").environment).toBe("release-tag");
  });

  test("invariant: nothing runs with the App credential before the decision", () => {
    const steps = job("decide").steps ?? [];
    const decideIndex = steps.findIndex((s) => s.id === "decide");
    const mintIndex = steps.findIndex((s) => s.id === "app-token");
    const writeIndex = steps.findIndex((s) => s.id === "write");
    expect(decideIndex).toBeGreaterThanOrEqual(0);
    expect(mintIndex).toBeGreaterThan(decideIndex);
    expect(writeIndex).toBeGreaterThan(mintIndex);

    // The decision's environment is the read-only set, and nothing in it points
    // at the token mint, the App id or the App private key.
    const decideEnv = step("decide", "decide").env ?? {};
    expect(Object.keys(decideEnv).sort()).toEqual(["GH_TOKEN", "REPO", "SELF_RUN_ID", "TARGET_SHA"]);
    expect(String(decideEnv.GH_TOKEN)).toBe("${{ secrets.GITHUB_TOKEN }}");
    const joined = JSON.stringify(decideEnv);
    expect(joined).not.toContain("app-token");
    expect(joined).not.toContain("APP_ID");
    expect(joined).not.toContain("PRIVATE_KEY");

    // The private key is never interpolated into an env: — only read by the mint
    // step's `with:` and tested for PRESENCE (a boolean) in the write step.
    const rawKeyUsers = (job("decide").steps ?? []).filter((s) => JSON.stringify(s).includes("secrets.RELEASE_TAG_APP_PRIVATE_KEY"));
    expect(rawKeyUsers.map((s) => s.id ?? s.name)).toEqual(["app-token", "write"]);
    expect(String(step("decide", "write").env?.RELEASE_TAG_APP_KEY_PRESENT)).toContain("!= ''");
  });

  test("every action is pinned by a full commit SHA", () => {
    const uses = (job("decide").steps ?? []).map((s) => s.uses).filter((u): u is string => typeof u === "string");
    expect(uses.length).toBeGreaterThan(0); // positive control: the search found actions
    for (const use of uses) expect(use).toMatch(/^[^@]+@[0-9a-f]{40}$/);
    for (const use of uses) expect(use).not.toMatch(/@(v|main|master)/);
    expect(uses.some((u) => u.startsWith("actions/create-github-app-token@"))).toBe(true);
  });

  test("the App token is minted with contents-write on this repo only", () => {
    const withArgs = step("decide", "app-token").with ?? {};
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

  test("a second workflow named CI fails the run loudly on the path assertion", () => {
    const assertStep = (job("decide").steps ?? []).find((s) => (s.run ?? "").includes(".github/workflows/test.yml"));
    expect(assertStep).toBeDefined();
    expect(assertStep?.if).toContain("workflow_run");
    expect(assertStep?.run).toContain("exit 1");
  });

  test("concurrency: release-auto-tag, and it never cancels", () => {
    expect(wf.concurrency?.group).toBe("release-auto-tag");
    expect(wf.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  test("a dry run cannot write: the mint and the POST are both excluded on dispatch", () => {
    expect(step("decide", "app-token").if).toContain("github.event_name != 'workflow_dispatch'");
    expect(step("decide", "write").if).toContain("github.event_name != 'workflow_dispatch'");
    // The write step still runs after a failed mint so it can REFUSE
    // `app-not-configured` rather than silently doing nothing.
    expect(step("decide", "write").if).toContain("always()");
  });

  test("no run: block interpolates a value with ${{ }} — everything goes through env:", () => {
    for (const [name, j] of Object.entries(wf.jobs ?? {})) {
      for (const s of j.steps ?? []) {
        if (typeof s.run === "string") expect(s.run, `${name}/${s.id ?? s.name} run: must not interpolate`).not.toContain("${{");
      }
    }
  });

  test("the decide step runs the script from the default branch and asks for the nightly when there is no sha", () => {
    const checkout = (job("decide").steps ?? [])[0];
    expect(checkout.uses).toContain("actions/checkout@");
    expect(String(checkout.with?.ref)).toContain("github.event.repository.default_branch");
    const run = step("decide", "decide").run ?? "";
    expect(run).toContain("node scripts/release-auto-tag.mjs");
    expect(run).toContain("--nightly");
    expect(run).toContain('--sha "$TARGET_SHA"');
    expect(run).toContain("--self-run-id");
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
  test("the report job's guard: always(), REFUSE, never dispatch", () => {
    const report = job("report");
    expect(report.needs).toBe("decide");
    expect(report.if).toContain("always()");
    expect(report.if).toContain("needs.decide.outputs.verdict == 'REFUSE'");
    expect(report.if).toContain("github.event_name != 'workflow_dispatch'");
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

  test("the decide job maps verdict, condition and version from the step to the job output", () => {
    const outputs = job("decide").outputs ?? {};
    expect(outputs.verdict).toBe("${{ steps.write.outputs.verdict || steps.decide.outputs.verdict }}");
    expect(outputs.condition).toBe("${{ steps.write.outputs.condition || steps.decide.outputs.condition }}");
    expect(outputs.version).toBe("${{ steps.write.outputs.version || steps.decide.outputs.version }}");
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

describe("release-auto-tag workflow — credential isolation and the reporter's shell", () => {
  test("the workspace is restored to the default branch's tree between the decision and the mint", () => {
    // Step order alone is not isolation: condition 6 runs the release commit's
    // own script in this workspace, and the write step runs this repo's script
    // holding the App token. The tree in between must be the default branch's.
    const steps = job("decide").steps ?? [];
    const indexOf = (id: string) => steps.findIndex((s) => s.id === id);
    const restoreIndex = steps.findIndex((s) => (s.run ?? "").includes("git clean -ffdqx"));
    expect(restoreIndex).toBeGreaterThan(indexOf("decide"));
    expect(restoreIndex).toBeLessThan(indexOf("app-token"));
    const restore = steps[restoreIndex];
    expect(restore.run).toContain("git checkout -- .");
    expect(restore.if).toContain("always()");
    expect(restore.if).toContain("github.event_name != 'workflow_dispatch'");
  });

  test("the write step re-reads main, so condition 4 sees a release that merged during the wait", () => {
    const run = step("decide", "write").run ?? "";
    expect(run).toContain("git fetch --no-tags --prune origin +refs/heads/main:refs/remotes/origin/main");
    expect(run.indexOf("git fetch")).toBeLessThan(run.indexOf("release-auto-tag.mjs tag"));
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
