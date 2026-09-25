/**
 * release-auto-tag.test.ts — flair#1890, `scripts/release-auto-tag.mjs`.
 *
 * THIS FILE IS A DETECTIVE, NOT A BOUNDARY. A pull request can edit the script
 * and this test together; the boundary is branch protection on main plus the
 * human review of the condition order. What this file does is make a silent
 * relaxation — dropping the `commit_id` filter in condition 8, trusting an
 * `(advisory)` suffix in condition 9, re-checking something other than 3/4/8 at
 * the write boundary — show up as a red test instead of as a quiet diff.
 *
 * Every acceptance item the issue says can be a unit test is here, named with its
 * item number, and every one of them was mutation-checked (see the PR body for
 * the mutation behind each): the fixtures are deliberately shaped so that
 * removing the guard each test exists for turns it red.
 *
 * The two INVARIANTS get their own tests below: a `<sha>` that is not an ancestor
 * of main never reaches the version-sync execution (a spy proves the script is
 * never run), and the decision step's environment holds no App token (asserted in
 * release-auto-tag-workflow.test.ts, where the workflow is parsed).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONDITION,
  DEFAULT_POLL_SECONDS,
  VERDICT,
  WRITE_VERDICT,
  compareVersions,
  createClient,
  decide,
  main,
  nightlyTarget,
  parseAdvisoryAllowlist,
  readVersionFromManifest,
  renderVerdict,
  writeTag,
  type CheckRunShape,
  type Deps,
  type GitHubClient,
  type PullRequestShape,
  type ReviewShape,
} from "../../scripts/release-auto-tag.mjs";

// ── fixtures ───────────────────────────────────────────────────────────────────

const REPO = "tpsdev-ai/flair";
const SHA = "a".repeat(40); // the release commit
const HEAD = "b".repeat(40); // the release PR's final head
const PREVIOUS = "0.56.0";
const VERSION = "0.57.0";
const TMP: string[] = [];

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "release-auto-tag-test-"));
  TMP.push(dir);
  return dir;
}

afterEach(() => {
  while (TMP.length) rmSync(TMP.pop() as string, { recursive: true, force: true });
});

function manifest(version: string): string {
  return JSON.stringify({ name: "flair", version });
}

function pull(over: Partial<PullRequestShape> = {}): PullRequestShape {
  return {
    number: 42,
    merged_at: "2026-09-24T00:00:00Z",
    merge_commit_sha: SHA,
    base: { ref: "main" },
    head: { sha: HEAD, ref: `release/v${VERSION}`, repo: { full_name: REPO } },
    ...over,
  };
}

function reviews(over: ReviewShape[] = []): ReviewShape[] {
  return [
    { user: { login: "tps-kern" }, state: "APPROVED", commit_id: HEAD, submitted_at: "2026-09-24T01:00:00Z" },
    { user: { login: "tps-sherlock" }, state: "APPROVED", commit_id: HEAD, submitted_at: "2026-09-24T01:01:00Z" },
    ...over,
  ];
}

function checks(over: CheckRunShape[] = []): CheckRunShape[] {
  return [{ name: "Unit Tests", status: "completed", conclusion: "success", check_suite: { id: 1 } }, ...over];
}

function fixtureApi(over: Partial<GitHubClient> = {}): GitHubClient {
  const base = {
    repo: REPO,
    readTagRef: async () => null,
    readTagObject: async () => null,
    listVersionTags: async () => [],
    listPullsForCommit: async () => [pull()],
    listReviews: async () => reviews(),
    listCheckRuns: async () => checks(),
    readWorkflowMeta: async () => ({ name: "CI" }),
    readWorkflowRun: async () => ({ check_suite_id: 999 }),
    listCommitsOnMain: async () => [],
    createTagRef: async () => ({ ok: true, status: 201, body: {} }),
    ...over,
  };
  return base as unknown as GitHubClient;
}

interface HarnessOptions {
  api?: Partial<GitHubClient>;
  ancestor?: boolean;
  versionSyncOk?: boolean;
  versions?: Record<string, string | null>;
  allowlist?: string[];
  /** Overrides git revParse, for the nightly walk. */
  parents?: Record<string, string>;
}

function harness(opts: HarnessOptions = {}) {
  const versionSyncCalls: string[] = [];
  const sleeps: number[] = [];
  const showCalls: string[] = [];
  const allowlistList = opts.allowlist ?? [];
  const allowlist = new Set(allowlistList);
  let nowMs = 0;
  const versions: Record<string, string | null> = {
    "origin/main": manifest(VERSION),
    [SHA]: manifest(VERSION),
    [`${SHA}^`]: manifest(PREVIOUS),
    ...opts.versions,
  };
  const deps = {
    api: fixtureApi(opts.api),
    log: { info: () => {}, warn: () => {} },
    now: () => nowMs,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      nowMs += ms;
    },
    readTextFile: () => JSON.stringify({ allow: allowlistList }),
    git: {
      show: (rev: string) => {
        showCalls.push(rev);
        return versions[rev] ?? null;
      },
      isAncestor: () => opts.ancestor ?? true,
      revParse: (ref: string) => opts.parents?.[ref] ?? ref,
    },
    runVersionSync: async (sha: string, version: string) => {
      versionSyncCalls.push(`${sha}@${version}`);
      const ok = opts.versionSyncOk ?? true;
      return { ok, code: ok ? 0 : 1, output: "" };
    },
  };
  return { deps: deps as unknown as Deps, versionSyncCalls, sleeps, showCalls, allowlist };
}

// ── condition 1 and 2 ──────────────────────────────────────────────────────────

describe("release auto-tag — conditions 1 and 2", () => {
  test("acceptance 2: a non-release commit SKIPs 'not a release commit'", async () => {
    const { deps, versionSyncCalls } = harness({
      versions: { [SHA]: manifest(VERSION), [`${SHA}^`]: manifest(VERSION) },
    });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.SKIP);
    expect(result.reason).toBe("not a release commit");
    expect(result.condition).toBe("");
    expect(renderVerdict(result, SHA)).toBe("SKIP not a release commit");
    // Nothing downstream ran: no API call, no script execution.
    expect(versionSyncCalls.length).toBe(0);
  });

  test("condition 1: a commit with no version at all SKIPs", async () => {
    const { deps } = harness({ versions: { [SHA]: JSON.stringify({ name: "flair" }) } });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.SKIP);
    expect(result.reason).toContain("no version");
  });

  test("condition 1: a first commit with no parent SKIPs rather than refuses", async () => {
    const { deps } = harness({ versions: { [`${SHA}^`]: null } });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.SKIP);
    expect(result.reason).toContain("no parent");
  });

  test("condition 2: a pre-release version REFUSEs version-shape and emits the literal invalid", async () => {
    const { deps, versionSyncCalls } = harness({ versions: { [SHA]: manifest("1.2.3-rc.4") } });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.VERSION_SHAPE);
    expect(result.version).toBe("invalid");
    expect(renderVerdict(result, SHA)).toBe(`REFUSE ${CONDITION.VERSION_SHAPE}`);
    expect(versionSyncCalls.length).toBe(0);
  });

  test("condition 2: a two-part version REFUSEs version-shape", async () => {
    const { deps } = harness({ versions: { [SHA]: manifest("1.2") } });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.VERSION_SHAPE);
  });
});

// ── condition 3 (tag state) and 4 (release intent) ─────────────────────────────

describe("release auto-tag — conditions 3 and 4", () => {
  test("condition 3: an existing tag at <sha> SKIPs as already tagged", async () => {
    const { deps } = harness({
      api: { readTagRef: async () => ({ object: { type: "commit", sha: SHA } }) },
    });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.SKIP);
    expect(result.reason).toBe("already tagged at this commit");
  });

  test("acceptance 10 (re-run): an already-tagged release commit SKIPs even after main moved on", async () => {
    // Condition 3 runs BEFORE 4, so a re-decide on a tagged commit costs two API
    // calls instead of refusing as superseded.
    const { deps, versionSyncCalls } = harness({
      versions: { "origin/main": manifest("0.58.0") },
      api: { readTagRef: async () => ({ object: { type: "commit", sha: SHA } }) },
    });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.SKIP);
    expect(result.reason).toBe("already tagged at this commit");
    expect(versionSyncCalls.length).toBe(0);
  });

  test("acceptance 7: an annotated tag resolving to <sha> SKIPs", async () => {
    const { deps } = harness({
      api: {
        readTagRef: async () => ({ object: { type: "tag", sha: "t1".padEnd(40, "0") } }),
        readTagObject: async () => ({ object: { type: "commit", sha: SHA } }),
      },
    });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.SKIP);
    expect(result.reason).toBe("already tagged at this commit");
  });

  test("acceptance 7: a tag object whose target is not a commit REFUSEs tag-conflict", async () => {
    const { deps } = harness({
      api: {
        readTagRef: async () => ({ object: { type: "tag", sha: "t1".padEnd(40, "0") } }),
        readTagObject: async () => ({ object: { type: "blob", sha: "t2".padEnd(40, "0") } }),
      },
    });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.TAG_CONFLICT);
  });

  test("acceptance 7: an annotated tag chain resolves through tag objects to a differing commit", async () => {
    let n = 0;
    const { deps } = harness({
      api: {
        readTagRef: async () => ({ object: { type: "tag", sha: "t1".padEnd(40, "0") } }),
        readTagObject: async () => {
          n += 1;
          return n === 1 ? { object: { type: "tag", sha: "t2".padEnd(40, "0") } } : { object: { type: "commit", sha: HEAD } };
        },
      },
    });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.TAG_CONFLICT);
  });

  test("condition 4: an untagged release commit that main has moved past REFUSEs superseded", async () => {
    const { deps, versionSyncCalls } = harness({ versions: { "origin/main": manifest("0.58.0") } });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.SUPERSEDED);
    expect(result.version).toBe(VERSION);
    expect(versionSyncCalls.length).toBe(0);
  });

  test("condition 4: a higher v* tag REFUSEs superseded even when main's HEAD agrees", async () => {
    const { deps } = harness({
      api: { listVersionTags: async () => [{ ref: "refs/tags/v0.58.0" }, { ref: "refs/tags/v0.1.0" }] },
    });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.SUPERSEDED);
    expect((result.summary ?? []).join(" ")).toContain("v0.58.0");
  });

  test("condition 4: non-version tags are not compared as semver", async () => {
    const { deps } = harness({
      api: { listVersionTags: async () => [{ ref: "refs/tags/v-next" }, { ref: "refs/tags/v1.0" }] },
    });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.TAG);
  });

  test("compareVersions orders numerically, not lexically", () => {
    expect(compareVersions("0.58.0", "0.57.0")).toBeGreaterThan(0);
    expect(compareVersions("0.9.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });
});

// ── condition 5 (ancestry) — the first invariant ────────────────────────────────

describe("release auto-tag — condition 5 and the script-execution invariant", () => {
  test("invariant: a <sha> that is not a main ancestor never reaches the script execution", async () => {
    const { deps, versionSyncCalls } = harness({ ancestor: false });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.NOT_MAIN_ANCESTOR);
    // THE INVARIANT: condition 6 executes <sha>'s own merged code, so it must not
    // run for a commit that is not main's. A refactor that reorders 5 and 6 turns
    // this red.
    expect(versionSyncCalls.length).toBe(0);
  });

  test("condition 6: a failing version sync REFUSEs version-sync", async () => {
    const { deps, versionSyncCalls } = harness({ versionSyncOk: false });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.VERSION_SYNC);
    expect(versionSyncCalls).toEqual([`${SHA}@${VERSION}`]);
  });
});

// ── condition 7 (the release PR) ────────────────────────────────────────────────

describe("release auto-tag — condition 7", () => {
  test("condition 7: the squashed release PR is accepted", async () => {
    const { deps } = harness();
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.TAG);
    expect(result.version).toBe(VERSION);
    expect(result.pr?.number).toBe(42);
    expect(renderVerdict(result, SHA)).toBe(`TAG v${VERSION} ${SHA}`);
  });

  test("acceptance 6: an empty PR association REFUSEs no-release-pr (never a SKIP)", async () => {
    const { deps } = harness({ api: { listPullsForCommit: async () => [] } });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.NO_RELEASE_PR);
  });

  test("condition 7: a partial association (wrong merge_commit_sha) REFUSEs", async () => {
    const { deps } = harness({ api: { listPullsForCommit: async () => [pull({ merge_commit_sha: HEAD })] } });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.NO_RELEASE_PR);
  });

  test("condition 7: a fork's release branch REFUSEs", async () => {
    const { deps } = harness({
      api: {
        listPullsForCommit: async () => [pull({ head: { sha: HEAD, ref: `release/v${VERSION}`, repo: { full_name: "someone/flair" } } })],
      },
    });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.NO_RELEASE_PR);
  });

  test("condition 7: a non-release head ref REFUSEs", async () => {
    const { deps } = harness({
      api: { listPullsForCommit: async () => [pull({ head: { sha: HEAD, ref: "my-branch", repo: { full_name: REPO } } })] },
    });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.NO_RELEASE_PR);
  });

  test("condition 7: an unmerged PR REFUSEs", async () => {
    const { deps } = harness({ api: { listPullsForCommit: async () => [pull({ merged_at: null })] } });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.NO_RELEASE_PR);
  });
});

// ── condition 8 (both reviewers, on the final head) ─────────────────────────────

describe("release auto-tag — condition 8", () => {
  test("acceptance 3: one reviewer's latest review is not APPROVED → REFUSE reviews, naming them", async () => {
    const { deps } = harness({
      api: {
        listReviews: async () =>
          reviews([{ user: { login: "tps-sherlock" }, state: "COMMENTED", commit_id: HEAD, submitted_at: "2026-09-24T02:00:00Z" }]),
      },
    });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.REVIEWS);
    expect((result.summary ?? []).join(" ")).toContain("tps-sherlock");
    expect((result.summary ?? []).join(" ")).toContain("COMMENTED");
  });

  test("acceptance 6: a review with a different commit_id REFUSEs (the stale-approval case)", async () => {
    // Both logins ARE approved — but on an earlier push. Without the commit_id
    // filter this passes.
    const wrong = "9".repeat(40);
    const { deps } = harness({
      api: {
        listReviews: async () => [
          { user: { login: "tps-kern" }, state: "APPROVED", commit_id: wrong, submitted_at: "2026-09-24T05:00:00Z" },
          { user: { login: "tps-sherlock" }, state: "APPROVED", commit_id: wrong, submitted_at: "2026-09-24T05:01:00Z" },
        ],
      },
    });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.REVIEWS);
  });

  test("acceptance 6: a DISMISSED approval REFUSEs", async () => {
    const { deps } = harness({
      api: {
        listReviews: async () =>
          reviews([{ user: { login: "tps-kern" }, state: "DISMISSED", commit_id: HEAD, submitted_at: "2026-09-24T06:00:00Z" }]),
      },
    });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.REVIEWS);
  });

  test("condition 8: CHANGES_REQUESTED does not count as an approval", async () => {
    const { deps } = harness({
      api: {
        listReviews: async () =>
          reviews([{ user: { login: "tps-kern" }, state: "CHANGES_REQUESTED", commit_id: HEAD, submitted_at: "2026-09-24T07:00:00Z" }]),
      },
    });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.REVIEWS);
  });

  test("condition 8: a missing reviewer REFUSEs, naming the absence", async () => {
    const { deps } = harness({
      api: { listReviews: async () => reviews().filter((r) => r.user?.login !== "tps-kern") },
    });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.REVIEWS);
    expect((result.summary ?? []).join(" ")).toContain("tps-kern did not review");
  });

  test("condition 8: the LATEST review per login wins (a later COMMENTED undoes an APPROVED)", async () => {
    const { deps } = harness({
      api: { listReviews: async () => reviews([{ user: { login: "tps-kern" }, state: "COMMENTED", commit_id: HEAD, submitted_at: "2026-09-25T00:00:00Z" }]) },
    });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.REVIEWS);
  });
});

// ── condition 9 (checks, allowlist, deadline, self-exclusion) ───────────────────

describe("release auto-tag — condition 9", () => {
  test("acceptance 12: a non-allowlisted cancelled check REFUSEs checks-failed", async () => {
    const { deps } = harness({
      api: { listCheckRuns: async () => checks([{ name: "Integration Tests", status: "completed", conclusion: "cancelled" }]) },
    });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.CHECKS_FAILED);
    expect((result.summary ?? []).join(" ")).toContain("Integration Tests (cancelled)");
  });

  test("acceptance 12: a non-allowlisted timed_out check REFUSEs checks-failed", async () => {
    const { deps } = harness({
      api: { listCheckRuns: async () => checks([{ name: "Unit Tests (node 22)", status: "completed", conclusion: "timed_out" }]) },
    });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.CHECKS_FAILED);
  });

  test("acceptance 6: a failing check named 'x (advisory)' that is NOT allowlisted REFUSEs", async () => {
    // The name suffix is not the allowlist. Only an exact match in the tagger's
    // own file is.
    const { deps } = harness({
      api: { listCheckRuns: async () => checks([{ name: "x (advisory)", status: "completed", conclusion: "failure" }]) },
    });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.CHECKS_FAILED);
  });

  test("condition 9: neutral and skipped are whitelisted", async () => {
    const { deps } = harness({
      api: {
        listCheckRuns: async () =>
          checks([
            { name: "First-publish preflight", status: "completed", conclusion: "skipped" },
            { name: "Optional lane", status: "completed", conclusion: "neutral" },
          ]),
      },
    });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.TAG);
  });

  test("condition 9: an allowlisted failure is tolerated, listed, and does not refuse", async () => {
    const h = harness({
      allowlist: ["launchd adopt-then-upgrade (macOS, advisory)"],
      api: {
        listCheckRuns: async () =>
          checks([{ name: "launchd adopt-then-upgrade (macOS, advisory)", status: "completed", conclusion: "failure" }]),
      },
    });
    const result = await decide({ sha: SHA, deps: h.deps, options: { allowlist: h.allowlist } });
    expect(result.verdict).toBe(VERDICT.TAG);
    expect((result.summary ?? []).join(" ")).toContain("launchd adopt-then-upgrade (macOS, advisory) (failure)");
  });

  test("acceptance 0: this run's own in-progress check run is excluded — no self-wait", async () => {
    const { deps, sleeps } = harness({
      api: {
        listCheckRuns: async () =>
          checks([
            { name: "Decide (and tag when the verdict is TAG)", status: "in_progress", conclusion: null, check_suite: { id: 999 } },
          ]),
      },
    });
    const result = await decide({ sha: SHA, deps, options: { selfCheckSuiteId: 999 } });
    expect(result.verdict).toBe(VERDICT.TAG);
    // The exclusion is what makes this a decision rather than a wait.
    expect(sleeps.length).toBe(0);
  });

  test("condition 9: pending checks poll every 60s and REFUSE checks-pending at the deadline", async () => {
    const deadlineMs = 30 * 60_000;
    const { deps, sleeps } = harness({
      api: {
        listCheckRuns: async () => checks([{ name: "Integration Tests", status: "queued", conclusion: null, check_suite: { id: 1 } }]),
      },
    });
    const result = await decide({ sha: SHA, deps, options: { deadlineMs, pollMs: DEFAULT_POLL_SECONDS * 1000 } });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.CHECKS_PENDING);
    expect(sleeps.length).toBe(deadlineMs / (DEFAULT_POLL_SECONDS * 1000));
    expect(sleeps.every((ms) => ms === DEFAULT_POLL_SECONDS * 1000)).toBe(true);
    expect((result.summary ?? []).join(" ")).toContain("Integration Tests");
  });

  test("condition 9: a check that completes during the wait is not a refusal", async () => {
    let call = 0;
    const { deps, sleeps } = harness({
      api: {
        listCheckRuns: async () => {
          call += 1;
          return checks([
            { name: "Integration Tests", status: call === 1 ? "in_progress" : "completed", conclusion: call === 1 ? null : "success" },
          ]);
        },
      },
    });
    const result = await decide({ sha: SHA, deps, options: { deadlineMs: 10 * 60_000, pollMs: 60_000 } });
    expect(result.verdict).toBe(VERDICT.TAG);
    expect(sleeps.length).toBe(1);
  });
});

// ── the allowlist file ──────────────────────────────────────────────────────────

describe("release auto-tag — the advisory allowlist", () => {
  test("parseAdvisoryAllowlist matches by exact name only", () => {
    const allow = parseAdvisoryAllowlist(readFileSync(join(import.meta.dir, "..", "..", ".github", "release-auto-tag-advisories.json"), "utf8"));
    expect(allow.has("launchd adopt-then-upgrade (macOS, advisory)")).toBe(true);
    // A suffix, a prefix or a substring is NOT a match.
    expect(allow.has("x (advisory)")).toBe(false);
    expect(allow.has("launchd adopt-then-upgrade (macOS, advisory) ")).toBe(false);
    expect(allow.has("launchd adopt-then-upgrade")).toBe(false);
  });

  test("parseAdvisoryAllowlist rejects a malformed file rather than silently allowing nothing", () => {
    expect(() => parseAdvisoryAllowlist("{}")).toThrow();
    expect(() => parseAdvisoryAllowlist(JSON.stringify({ allow: "launchd" }))).toThrow();
    expect(() => parseAdvisoryAllowlist(JSON.stringify({ allow: [1] }))).toThrow();
  });

  test("readVersionFromManifest survives a malformed manifest", () => {
    expect(readVersionFromManifest("{not json")).toBeNull();
    expect(readVersionFromManifest(null)).toBeNull();
    expect(readVersionFromManifest(JSON.stringify({ version: 3 }))).toBeNull();
  });
});

// ── the write boundary (condition 10) ───────────────────────────────────────────

const appOptions = { token: "app-token", appId: "12345", appKeyPresent: "true" };

describe("release auto-tag — the write boundary (condition 10)", () => {
  test("app-not-configured: a missing App token REFUSEs loudly instead of POSTing", async () => {
    const { deps } = harness();
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: { ...appOptions, token: "" } });
    expect(result.verdict).toBe(WRITE_VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.APP_NOT_CONFIGURED);
    expect((result.summary ?? []).join(" ")).toContain("no App token");
  });

  test("app-not-configured: a missing App id or private key also REFUSEs", async () => {
    const noId = await writeTag({ sha: SHA, version: VERSION, deps: harness().deps, options: { ...appOptions, appId: "" } });
    expect(noId.condition).toBe(CONDITION.APP_NOT_CONFIGURED);
    const noKey = await writeTag({ sha: SHA, version: VERSION, deps: harness().deps, options: { ...appOptions, appKeyPresent: "false" } });
    expect(noKey.condition).toBe(CONDITION.APP_NOT_CONFIGURED);
  });

  test("condition 10: a clean re-check POSTs the tag and reads it back", async () => {
    const created: Array<{ ref: string; sha: string }> = [];
    let tagged = false;
    const { deps } = harness({
      api: {
        createTagRef: async (ref, sha) => {
          created.push({ ref, sha });
          tagged = true;
          return { ok: true, status: 201, body: {} };
        },
        readTagRef: async () => (tagged ? { object: { type: "commit", sha: SHA } } : null),
      },
    });
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(result.verdict).toBe(WRITE_VERDICT.TAGGED);
    expect(created).toEqual([{ ref: `refs/tags/v${VERSION}`, sha: SHA }]);
  });

  test("acceptance 11: decide says TAG, then condition 10 finds a dismissed review → verdict REFUSE", async () => {
    const { deps } = harness({
      api: {
        listReviews: async () =>
          reviews([{ user: { login: "tps-kern" }, state: "DISMISSED", commit_id: HEAD, submitted_at: "2026-09-25T02:00:00Z" }]),
      },
    });
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(result.verdict).toBe(WRITE_VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.REVIEWS);
    expect(result.version).toBe(VERSION);
  });

  test("condition 10: a tag that appeared during the wait REFUSEs tag-conflict", async () => {
    const { deps } = harness({
      api: { readTagRef: async () => ({ object: { type: "commit", sha: HEAD } }) },
    });
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(result.verdict).toBe(WRITE_VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.TAG_CONFLICT);
  });

  test("condition 10: a newer release that merged during the wait REFUSEs superseded", async () => {
    const { deps } = harness({ versions: { "origin/main": manifest("0.58.0") } });
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(result.verdict).toBe(WRITE_VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.SUPERSEDED);
  });

  test("condition 10: losing the POST race re-reads the ref and becomes a SKIP", async () => {
    let attempted = false;
    const { deps } = harness({
      api: {
        createTagRef: async () => {
          attempted = true;
          return { ok: false, status: 422, body: { message: "Reference already exists" } };
        },
        readTagRef: async () => (attempted ? { object: { type: "commit", sha: SHA } } : null),
      },
    });
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(result.verdict).toBe(WRITE_VERDICT.SKIP);
    expect(result.reason).toContain("first");
  });

  test("condition 10: losing the POST race when the ref points elsewhere REFUSEs tag-conflict", async () => {
    const { deps } = harness({
      api: {
        createTagRef: async () => ({ ok: false, status: 422, body: { message: "Reference already exists" } }),
        readTagRef: async () => ({ object: { type: "commit", sha: HEAD } }),
      },
    });
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(result.verdict).toBe(WRITE_VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.TAG_CONFLICT);
  });

  test("condition 10: a read-back that does not point at <sha> REFUSEs tag-conflict", async () => {
    let tagged = false;
    const { deps } = harness({
      api: {
        createTagRef: async () => {
          tagged = true;
          return { ok: true, status: 201, body: {} };
        },
        readTagRef: async () => (tagged ? { object: { type: "commit", sha: HEAD } } : null),
      },
    });
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(result.verdict).toBe(WRITE_VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.TAG_CONFLICT);
  });

  test("condition 10: the POST is not retried after an unexpected failure", async () => {
    let posts = 0;
    const { deps } = harness({
      api: {
        createTagRef: async () => {
          posts += 1;
          return { ok: false, status: 500, body: null };
        },
      },
    });
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(posts).toBe(1);
    expect(result.verdict).toBe(WRITE_VERDICT.REFUSE);
  });
});

// ── the nightly ────────────────────────────────────────────────────────────────

describe("release auto-tag — the nightly target", () => {
  const ROOT = "0".repeat(40);
  const MID = "1".repeat(40);
  const REL = "2".repeat(40);
  const PARENT = "3".repeat(40);
  const olderParents = {
    "origin/main": MID,
    [`${MID}^`]: REL,
    [`${REL}^`]: PARENT,
    [`${PARENT}^`]: ROOT,
  };

  test("acceptance 13: a later commit that edits package.json without changing the version is skipped", async () => {
    const { deps, showCalls } = harness({
      parents: olderParents,
      versions: {
        [MID]: manifest(VERSION),
        [`${MID}^`]: manifest(VERSION), // the release commit's version …
        [REL]: manifest(VERSION),
        [`${REL}^`]: manifest(PREVIOUS), // … differs from its parent's
        [PARENT]: manifest(PREVIOUS),
        [`${PARENT}^`]: manifest("0.55.0"),
      },
    });
    const target = await nightlyTarget(deps);
    expect(target?.sha).toBe(REL);
    expect(target?.version).toBe(VERSION);
    // "One run, one decision": the walk stops at the release commit, so the older
    // version change (0.55.0 -> 0.56.0 at PARENT) is never examined.
    expect(showCalls).not.toContain(`${PARENT}^`);
  });

  test("acceptance 8: the missed release commit is selected, and the decision ON that commit tags it", async () => {
    const { deps } = harness({
      parents: olderParents,
      versions: {
        [MID]: manifest(VERSION),
        [`${MID}^`]: manifest(VERSION),
        [REL]: manifest(VERSION),
        [`${REL}^`]: manifest(PREVIOUS),
        [PARENT]: manifest(PREVIOUS),
      },
      api: { listPullsForCommit: async () => [pull({ merge_commit_sha: REL })] },
    });
    const target = await nightlyTarget(deps);
    expect(target?.sha).toBe(REL);
    // The nightly decides on that ONE commit — untagged here, so it tags itself.
    const result = await decide({ sha: target?.sha ?? "", deps });
    expect(result.verdict).toBe(VERDICT.TAG);
    expect(result.version).toBe(VERSION);
  });

  test("nightly: no version change anywhere in the walk window SKIPs", async () => {
    const { deps } = harness({
      parents: { "origin/main": REL, [`${REL}^`]: PARENT },
      versions: {
        [REL]: manifest(VERSION),
        [`${REL}^`]: manifest(VERSION),
        [PARENT]: manifest(VERSION),
        [`${PARENT}^`]: manifest(VERSION),
      },
    });
    const target = await nightlyTarget(deps, { limit: 1 });
    expect(target).toBeNull();
  });
});

// ── the client, against the API's REAL response shapes ─────────────────────────
// The fixtures everywhere else stub the semantic methods, so they cannot see a
// wrong envelope or a broken `Link` parser. These four tests drive createClient
// itself with a mocked fetch and the shapes GitHub actually returns.

describe("release auto-tag — the GitHub client", () => {
  const BASE = "https://api.github.com";

  function mockFetch(routes: Record<string, { status?: number; body?: unknown; link?: string | null }>) {
    const calls: string[] = [];
    const impl = async (url: string | URL | Request): Promise<Response> => {
      const target = String(url);
      calls.push(target);
      const route = routes[target];
      if (!route) throw new Error(`unmocked fetch: ${target}`);
      const status = route.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name: string) => (name.toLowerCase() === "link" ? (route.link ?? null) : null) },
        json: async () => route.body ?? null,
      } as unknown as Response;
    };
    return { impl: impl as unknown as typeof fetch, calls };
  }

  test("check-runs: the { total_count, check_runs } envelope is unwrapped, not dropped", async () => {
    const run: CheckRunShape = { name: "Unit Tests", status: "completed", conclusion: "success" };
    const mock = mockFetch({
      [`${BASE}/repos/${REPO}/commits/${SHA}/check-runs?per_page=100&filter=latest`]: {
        body: { total_count: 1, check_runs: [run] },
      },
    });
    const client = createClient({ repo: REPO, token: "t", fetchImpl: mock.impl });
    expect(await client.listCheckRuns(SHA)).toEqual([run]);
  });

  test("pagination: the next link keeps the full path (a stripped /repos/ prefix would 404 and truncate)", async () => {
    const page1: CheckRunShape = { name: "page-1", status: "completed", conclusion: "success" };
    const page2: CheckRunShape = { name: "page-2", status: "completed", conclusion: "failure" };
    const first = `${BASE}/repos/${REPO}/commits/${SHA}/check-runs?per_page=100&filter=latest`;
    const second = `${BASE}/repos/${REPO}/commits/${SHA}/check-runs?per_page=100&filter=latest&page=2`;
    const mock = mockFetch({
      [first]: {
        body: { total_count: 2, check_runs: [page1] },
        link: `<${second}>; rel="next", <${second}>; rel="last"`,
      },
      [second]: { body: { total_count: 2, check_runs: [page2] } },
    });
    const client = createClient({ repo: REPO, token: "t", fetchImpl: mock.impl });
    expect(await client.listCheckRuns(SHA)).toEqual([page1, page2]);
    expect(mock.calls).toEqual([first, second]);
    expect(mock.calls[1]).toContain(`/repos/${REPO}/`);
  });

  test("readTagRef: a 404 is a null ref, not a thrown error", async () => {
    const mock = mockFetch({ [`${BASE}/repos/${REPO}/git/ref/tags/v0.57.0`]: { status: 404 } });
    const client = createClient({ repo: REPO, token: "t", fetchImpl: mock.impl });
    expect(await client.readTagRef("v0.57.0")).toBeNull();
  });

  test("createTagRef: a rejected POST surfaces its status instead of throwing", async () => {
    const mock = mockFetch({
      [`${BASE}/repos/${REPO}/git/refs`]: { status: 422, body: { message: "Reference already exists" } },
    });
    const client = createClient({ repo: REPO, token: "t", fetchImpl: mock.impl });
    const result = await client.createTagRef("refs/tags/v0.57.0", SHA);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(422);
  });

  test("the client builds every read from the repo it was given", async () => {
    const mock = mockFetch({ [`${BASE}/repos/${REPO}/commits/${SHA}/pulls`]: { body: [] } });
    const client = createClient({ repo: REPO, token: "t", fetchImpl: mock.impl });
    expect(await client.listPullsForCommit(SHA)).toEqual([]);
    expect(mock.calls[0]).toBe(`${BASE}/repos/${REPO}/commits/${SHA}/pulls`);
  });

  test("a non-404 failure is thrown, never silently read as 'nothing there'", async () => {
    const mock = mockFetch({ [`${BASE}/repos/${REPO}/git/ref/tags/v0.57.0`]: { status: 500, body: {} } });
    const client = createClient({ repo: REPO, token: "t", fetchImpl: mock.impl });
    await expect(client.readTagRef("v0.57.0")).rejects.toThrow();
  });
});

// ── the CLI surface ────────────────────────────────────────────────────────────

describe("release auto-tag — the CLI surface", () => {
  test("acceptance 9: decide exits 0 on REFUSE, writes the verdict, and never emits an unvalidated version", async () => {
    const dir = scratchDir();
    const out = join(dir, "out.txt");
    const { deps } = harness({ versions: { [SHA]: manifest("1.2.3-rc.4") } });
    const code = await main(["decide", "--repo", REPO, "--sha", SHA, "--output", out], { deps });
    expect(code).toBe(0);
    const text = readFileSync(out, "utf8");
    expect(text).toContain("verdict=REFUSE");
    expect(text).toContain(`condition=${CONDITION.VERSION_SHAPE}`);
    expect(text).toContain("version=invalid");
    expect(text).not.toContain("1.2.3-rc.4");
  });

  test("the CLI writes verdict/condition/version on a TAG decision too", async () => {
    const dir = scratchDir();
    const out = join(dir, "out.txt");
    const { deps } = harness();
    const code = await main(["decide", "--repo", REPO, "--sha", SHA, "--output", out], { deps });
    expect(code).toBe(0);
    const text = readFileSync(out, "utf8");
    expect(text).toContain("verdict=TAG");
    expect(text).toContain("condition=");
    expect(text).toContain(`version=${VERSION}`);
  });

  test("the CLI's nightly path runs the CI-name check before deciding (ci-renamed)", async () => {
    const dir = scratchDir();
    const out = join(dir, "out.txt");
    const { deps } = harness({ api: { readWorkflowMeta: async () => ({ name: "CI (renamed)" }) } });
    const code = await main(["decide", "--repo", REPO, "--nightly", "--output", out], { deps });
    expect(code).toBe(0);
    const text = readFileSync(out, "utf8");
    expect(text).toContain("verdict=REFUSE");
    expect(text).toContain(`condition=${CONDITION.CI_RENAMED}`);
  });

  test("the CLI's nightly path SKIPs when there is no release commit to examine", async () => {
    const dir = scratchDir();
    const out = join(dir, "out.txt");
    const { deps } = harness({
      parents: { "origin/main": SHA, [`${SHA}^`]: SHA },
      versions: { [SHA]: manifest(VERSION), [`${SHA}^`]: manifest(VERSION) },
    });
    const code = await main(["decide", "--repo", REPO, "--nightly", "--output", out], { deps });
    expect(code).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("verdict=SKIP");
  });

  test("the CLI rejects a tag invocation without --version", async () => {
    const { deps } = harness();
    await expect(main(["tag", "--repo", REPO, "--sha", SHA], { deps })).rejects.toThrow();
  });
});
