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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  CONDITION,
  DEFAULT_POLL_SECONDS,
  VERDICT,
  WRITE_VERDICT,
  compareVersions,
  createClient,
  createDeps,
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
    // The PR-files API. Condition 7b no longer READS it (round 5, item 1: the
    // release commit's LOCAL diff is the source). Kept so a test can shape what an
    // API-based reader WOULD have seen — the round-5 truncation test does that,
    // and the "fall back to the API list" mutation turns it red.
    listPullFiles: async () => [],
    listCheckRuns: async () => checks(),
    readWorkflowMeta: async () => ({ name: "CI" }),
    readWorkflowRun: async () => ({ check_suite_id: 999 }),
    // The CI workflow's completed runs on the commit. `checks()` above carries
    // check_suite id 1, so the default suite list makes condition 9's
    // CI-suite guard pass for a fixture that does not override it.
    listCompletedWorkflowRunsForSha: async () => [{ check_suite_id: 1 }],
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
  /** The version file's own commit history (newest first), for the nightly. */
  fileHistory?: string[];
  /**
   * The default branch's checker inventory (`--list`). `null` models a checker
   * that cannot be read; omit for the default inventory.
   */
  versionFiles?: string[] | null;
  /**
   * The release commit's LOCAL changed-file list (condition 7b, round 5, item 1).
   * Omit for a well-shaped release; `[]` models an empty diff (a REFUSE).
   */
  changedFiles?: string[];
  /**
   * The lockfile(s) the repo tracks at its own root (condition 7b, round 5, item
   * 2). `null` models an answer git could not give, which REFUSEs.
   */
  rootLockfiles?: string[] | null;
}

/** The inventory a fixture's checker would list. */
const DEFAULT_VERSION_FILES = ["package.json", "packages/flair-client/package.json"];

/**
 * A well-shaped release's local diff: the version-bearing files, the changelog
 * and THIS repo's tracked root lockfile (condition 7b, round 5). The default is
 * the well-shaped list, so every test that expects 7b to pass is explicit about
 * what the release changes.
 */
const DEFAULT_CHANGED_FILES = ["package.json", "packages/flair-client/package.json", "CHANGELOG.md", "bun.lock"];

/**
 * The lockfile(s) this repo tracks at its own root — `git ls-files` reports
 * exactly `bun.lock` at the worktree. Asserted against the real repo below, so
 * this fixture default cannot drift from the repository silently.
 */
const DEFAULT_ROOT_LOCKFILES = ["bun.lock"];

function harness(opts: HarnessOptions = {}) {
  const versionSyncCalls: string[] = [];
  const sleeps: number[] = [];
  const showCalls: string[] = [];
  // Every `pulls/<n>/files` read. Condition 7b must make NONE (round 5, item 1):
  // the release commit's local diff is the only source of its file list.
  const pullFileCalls: number[] = [];
  const allowlistList = opts.allowlist ?? [];
  const allowlist = new Set(allowlistList);
  let nowMs = 0;
  const versions: Record<string, string | null> = {
    "origin/main": manifest(VERSION),
    [SHA]: manifest(VERSION),
    [`${SHA}^`]: manifest(PREVIOUS),
    ...opts.versions,
  };
  const api = fixtureApi(opts.api);
  const listPullFiles = api.listPullFiles.bind(api);
  api.listPullFiles = async (prNumber: number) => {
    pullFileCalls.push(prNumber);
    return listPullFiles(prNumber);
  };
  const deps = {
    api,
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
      logFileHistory: () => opts.fileHistory ?? [],
      changedFiles: () => opts.changedFiles ?? DEFAULT_CHANGED_FILES,
    },
    runVersionSync: async (sha: string, version: string) => {
      versionSyncCalls.push(`${sha}@${version}`);
      const ok = opts.versionSyncOk ?? true;
      return { ok, code: ok ? 0 : 1, output: "" };
    },
    listVersionFiles: () => ("versionFiles" in opts ? opts.versionFiles : DEFAULT_VERSION_FILES),
    rootLockfiles: () => ("rootLockfiles" in opts ? opts.rootLockfiles : DEFAULT_ROOT_LOCKFILES),
  };
  return { deps: deps as unknown as Deps, versionSyncCalls, sleeps, showCalls, allowlist, pullFileCalls };
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

// ── conditions 5 and 6 — the candidate is read as DATA ──────────────────────────

describe("release auto-tag — conditions 5 and 6 (the candidate is read as data)", () => {
  test("condition 6: a failing version sync REFUSEs version-sync", async () => {
    const { deps, versionSyncCalls } = harness({ versionSyncOk: false });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.VERSION_SYNC);
    expect(versionSyncCalls).toEqual([`${SHA}@${VERSION}`]);
  });

  test("round 3: condition 6 executes NO file from the candidate — a candidate whose checker would write GITHUB_OUTPUT changes nothing", () => {
    // A real repo. The DEFAULT branch's checker (at HEAD) is benign; the CANDIDATE
    // commit carries a MALICIOUS scripts/check-version-sync.mjs plus agreeing
    // version files. Condition 6 must materialise the candidate's version-bearing
    // files as data and run HEAD's checker — so the candidate's script never runs
    // and can neither forge this step's output nor touch the workspace.
    const repo = scratchDir();
    const git = (...args: string[]): string => {
      const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr?.trim() ?? r.status}`);
      return r.stdout.trim();
    };
    git("init", "-q");
    git("symbolic-ref", "HEAD", "refs/heads/main");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    mkdirSync(join(repo, "scripts"), { recursive: true });
    // The DEFAULT branch's checker: a benign stub implementing the tiny
    // `--list` / `--root <dir> <version>` protocol the tagger drives.
    writeFileSync(
      join(repo, "scripts", "check-version-sync.mjs"),
      [
        'import { readFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "const argv = process.argv.slice(2);",
        'if (argv.includes("--list")) { console.log("package.json"); process.exit(0); }',
        'const root = argv[argv.indexOf("--root") + 1];',
        "const version = argv[argv.length - 1];",
        'const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));',
        "process.exit(pkg.version === version ? 0 : 1);",
        "",
      ].join("\n"),
    );
    writeFileSync(join(repo, "package.json"), manifest(VERSION));
    git("add", "-A");
    git("commit", "-q", "-m", "default branch");

    // The candidate commit: a checker that WOULD announce itself on stdout and
    // forge the output if anything ever executed it. Its own version files agree.
    git("checkout", "-q", "-b", "candidate");
    writeFileSync(
      join(repo, "scripts", "check-version-sync.mjs"),
      [
        'import { appendFileSync } from "node:fs";',
        'if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "verdict=TAG\\n");',
        'console.log("MALICIOUS-CHECKER-RAN");',
        "process.exit(0);",
        "",
      ].join("\n"),
    );
    git("add", "-A");
    git("commit", "-q", "-m", "candidate");
    const candidateSha = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");

    const ghOutput = join(repo, "gh-output.txt");
    writeFileSync(ghOutput, "");
    const prev = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_OUTPUT = ghOutput;
    try {
      const result = createDeps({ root: repo }).runVersionSync(candidateSha, VERSION);
      expect(result.ok, "the candidate's version-bearing files agree").toBe(true);
      // The runtime-independent proof: the candidate's script never runs, so its
      // stdout banner never appears (the default branch's checker's output does).
      expect(result.output, "the candidate's checker did not execute").not.toContain("MALICIOUS-CHECKER-RAN");
      // And it cannot have touched the step output it would have forged.
      expect(readFileSync(ghOutput, "utf8"), "GITHUB_OUTPUT is untouched — the candidate's script never ran").toBe("");
      expect(existsSync(join(repo, "CANDIDATE-EXECUTED")), "no side effect in the workspace").toBe(false);
    } finally {
      if (prev === undefined) delete process.env.GITHUB_OUTPUT;
      else process.env.GITHUB_OUTPUT = prev;
    }
  });

  test("round 4, item 3: a candidate that adds an UNDECLARED version site REFUSEs version-sync", () => {
    // The discovery scan's whole point: a version declaration the checker's
    // inventory does not list. It exists only in the candidate's tree, so
    // materialising the INVENTORY hid it. The tagger must extract the WHOLE tree
    // (`git archive`) and let the checker walk every file of it.
    const repo = scratchDir();
    const git = (...args: string[]): string => {
      const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr?.trim() ?? r.status}`);
      return r.stdout.trim();
    };
    git("init", "-q");
    git("symbolic-ref", "HEAD", "refs/heads/main");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");

    // The default branch: the REAL checker (its inventory, its exclusions, its
    // discovery scan) over its real inventory, all at the real version — copied
    // out of this checkout, so the scan has the inventory it expects.
    const realRoot = resolve(import.meta.dir, "../..");
    const realVersion = JSON.parse(readFileSync(join(realRoot, "package.json"), "utf8")).version;
    const realChecker = join(realRoot, "scripts", "check-version-sync.mjs");
    const listed = spawnSync(process.execPath, [realChecker, "--list"], { cwd: realRoot, encoding: "utf8" });
    expect(listed.status, "the real checker lists its inventory").toBe(0);
    const inventory = String(listed.stdout ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(inventory.length, "the real inventory is not empty").toBeGreaterThan(0);
    mkdirSync(join(repo, "scripts"), { recursive: true });
    writeFileSync(join(repo, "scripts", "check-version-sync.mjs"), readFileSync(realChecker, "utf8"));
    for (const path of inventory) {
      const dest = join(repo, path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(join(realRoot, path)));
    }
    git("add", "-A");
    git("commit", "-q", "-m", "default branch");

    // The candidate: ONE new file that declares the version but is NOT in the
    // inventory. Every other declaration still agrees.
    git("checkout", "-q", "-b", "candidate");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "new-version-site.ts"), `export const RELEASE_VERSION = "${realVersion}";\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "candidate");
    const candidateSha = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");

    const result = createDeps({ root: repo }).runVersionSync(candidateSha, realVersion);
    expect(result.ok, "an undeclared version site refuses").toBe(false);
    expect(result.output).toContain("new-version-site.ts");
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

// ── condition 7b (the release PR's shape) ─────────────────────────────────────

describe("release auto-tag — condition 7b (the release PR stays inside the release surface)", () => {
  // A well-shaped release's diff: the version-bearing files, the changelog, a
  // fragment and THIS repo's tracked root lockfile.
  const IN_SURFACE = [
    "package.json",
    "packages/flair-client/package.json",
    "CHANGELOG.md",
    ".changelog/unreleased/fixed-x.md",
    "bun.lock",
  ];

  test("round 4, item 1: a release PR that ALSO touches the tagger REFUSEs release-pr-shape", async () => {
    // The failure the shape check exists for: a release that carries a change to
    // the code that runs on the release, inside the release itself.
    const { deps } = harness({ changedFiles: [...IN_SURFACE, "scripts/release-auto-tag.mjs"] });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.RELEASE_PR_SHAPE);
    expect(result.summary.join(" ")).toContain("scripts/release-auto-tag.mjs");
  });

  test("round 4, item 1: a release PR inside the release surface passes 7b", async () => {
    const { deps } = harness({ changedFiles: IN_SURFACE });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.TAG);
  });

  test("round 4, item 1: a RENAME out of the trust root REFUSEs (both paths are checked)", async () => {
    // `git diff --name-status -M` reports a rename with BOTH of its paths and
    // `changedFiles` flattens them, so a release that MOVES the tagger into an
    // allowed path is still seen — it cannot pass by deletion. The helper's own
    // parse of a real rename is exercised at the end of this block.
    const { deps } = harness({ changedFiles: ["CHANGELOG.md", "scripts/release-auto-tag.mjs"] });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.RELEASE_PR_SHAPE);
    expect(result.summary.join(" ")).toContain("scripts/release-auto-tag.mjs");
  });

  test("round 4, item 1: a lockfile-LOOKALIKE in a subdirectory is not the lockfile", async () => {
    const { deps } = harness({ changedFiles: ["docs/bun.lock"] });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.RELEASE_PR_SHAPE);
  });

  test("round 4, item 1: an unreadable inventory REFUSEs (never 'no version files')", async () => {
    const { deps } = harness({ versionFiles: null });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.RELEASE_PR_SHAPE);
  });

  // ── round 5, item 1: the changed-file list is computed LOCALLY ──────────────

  test("round 5, item 1: condition 7b reads NO PR-files API — the local diff is the only source", async () => {
    const { deps, pullFileCalls } = harness({ changedFiles: IN_SURFACE });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.TAG);
    expect(pullFileCalls, "no pulls/<n>/files read").toEqual([]);
  });

  test("round 5, item 1: an EMPTY change list REFUSEs release-pr-shape", async () => {
    // A release changes at least its version-bearing files, so an empty diff is
    // not a release. It is also the shape a first-page 404 from the PR-files API
    // used to take — and that PASSED the subset check vacuously.
    const { deps } = harness({ changedFiles: [] });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.RELEASE_PR_SHAPE);
    expect(result.summary.join(" "), "the empty diff is named").toContain("changes no file");
  });

  test("round 5, item 1: a change list the PR-files API would TRUNCATE is still fully checked", async () => {
    // The API caps a PR's file list at 3,000 files. The 3,001st file is what a
    // truncating reader never sees; the local diff is the source, so it IS seen.
    const files = [
      ...IN_SURFACE,
      ...Array.from({ length: 3000 }, (_, i) => `.changelog/unreleased/bulk-${i}.md`),
      "scripts/release-auto-tag.mjs",
    ];
    const { deps, pullFileCalls } = harness({
      changedFiles: files,
      // What an API-based reader would have received: the first page only, which
      // does not contain the offender.
      api: { listPullFiles: async () => files.slice(0, 100).map((filename) => ({ filename })) },
    });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.RELEASE_PR_SHAPE);
    expect(result.summary.join(" ")).toContain("scripts/release-auto-tag.mjs");
    expect(pullFileCalls, "still no API read").toEqual([]);
  });

  // ── round 5, item 2: only the lockfile(s) THIS repo tracks at its root ─────

  test("round 5, item 2: a release changing package-lock.json REFUSEs — this repo tracks bun.lock", async () => {
    const { deps } = harness({ changedFiles: ["package.json", "bun.lock", "package-lock.json"] });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.RELEASE_PR_SHAPE);
    expect(result.summary.join(" ")).toContain("package-lock.json");
  });

  test("round 5, item 2: the repo's OWN tracked root lockfile is allowed (bun.lock)", async () => {
    const { deps } = harness({ changedFiles: ["package.json", "bun.lock"] });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.TAG);
  });

  test("round 5, item 2: the allowed lockfile is whatever the repo TRACKS, not a fixed name", async () => {
    // A repo tracking package-lock.json allows it and refuses bun.lock: the set
    // comes from the repo, so it cannot be a hard-coded list of lockfile names.
    const pkgLockRepo = harness({
      rootLockfiles: ["package-lock.json"],
      changedFiles: ["package.json", "package-lock.json"],
    });
    expect((await decide({ sha: SHA, deps: pkgLockRepo.deps })).verdict).toBe(VERDICT.TAG);
    const bunLockRepo = harness({ rootLockfiles: ["package-lock.json"], changedFiles: ["package.json", "bun.lock"] });
    const refused = await decide({ sha: SHA, deps: bunLockRepo.deps });
    expect(refused.verdict).toBe(VERDICT.REFUSE);
    expect(refused.condition).toBe(CONDITION.RELEASE_PR_SHAPE);
  });

  test("round 5, item 2: an unreadable tracked-lockfile answer REFUSEs", async () => {
    const { deps } = harness({ rootLockfiles: null });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.RELEASE_PR_SHAPE);
  });

  // ── the real-git readers behind both items ────────────────────────────────

  test("round 5, item 1: the local diff reports a RENAME with both paths, and an empty commit as empty (real git)", () => {
    const repo = scratchDir();
    const git = (...args: string[]): string => {
      const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr?.trim() ?? r.status}`);
      return r.stdout.trim();
    };
    git("init", "-q");
    git("symbolic-ref", "HEAD", "refs/heads/main");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    mkdirSync(join(repo, "scripts"), { recursive: true });
    writeFileSync(join(repo, "scripts", "release-auto-tag.mjs"), "// the tagger\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    // The release commit: the tagger MOVED into an allowed path, plus a bump.
    git("mv", "scripts/release-auto-tag.mjs", "CHANGELOG.md");
    writeFileSync(join(repo, "package.json"), manifest(VERSION));
    git("add", "-A");
    git("commit", "-q", "-m", "release");
    const deps = createDeps({ root: repo });
    const paths = deps.git.changedFiles(git("rev-parse", "HEAD"));
    expect(paths).toContain("scripts/release-auto-tag.mjs");
    expect(paths).toContain("CHANGELOG.md");
    expect(paths).toContain("package.json");
    // A commit that changes nothing has an EMPTY diff (condition 7b REFUSEs it).
    git("commit", "-q", "--allow-empty", "-m", "empty");
    expect(deps.git.changedFiles(git("rev-parse", "HEAD"))).toEqual([]);
  });

  test("round 5, item 2: the tracked root lockfile is read FROM the repo (real git)", () => {
    const repo = scratchDir();
    const git = (...args: string[]): string => {
      const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr?.trim() ?? r.status}`);
      return r.stdout.trim();
    };
    git("init", "-q");
    git("symbolic-ref", "HEAD", "refs/heads/main");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "package.json"), manifest("0.1.0"));
    writeFileSync(join(repo, "package-lock.json"), "{}");
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(join(repo, "docs", "bun.lock"), "");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    // The tracked ROOT lockfile and nothing else: the subdirectory lookalike is
    // not a lockfile.
    expect(createDeps({ root: repo }).rootLockfiles()).toEqual(["package-lock.json"]);
  });

  test("round 5, item 2: this repo's tracked root lockfile is exactly bun.lock", () => {
    // The fixture default, tied to the repository it models.
    const real = createDeps({ root: resolve(import.meta.dir, "../..") }).rootLockfiles();
    expect(real).toEqual(["bun.lock"]);
    expect(DEFAULT_ROOT_LOCKFILES, "the fixture default matches the repo it models").toEqual(["bun.lock"]);
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

  test("round 2, item 3: no check runs at all REFUSEs checks-missing (an empty list is not green)", async () => {
    const { deps } = harness({ api: { listCheckRuns: async () => [] } });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.CHECKS_MISSING);
    expect((result.summary ?? []).join(" ")).toContain("no check runs");
  });

  test("round 2, item 3: check runs, but none from the CI workflow's suite, REFUSEs checks-missing", async () => {
    const { deps } = harness({
      api: { listCheckRuns: async () => checks() }, // default run carries check_suite id 1
    });
    const result = await decide({ sha: SHA, deps, options: { ciCheckSuiteIds: [2] } });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.CHECKS_MISSING);
  });

  test("round 2, item 3: an empty CI-suite list (no completed CI suite on the commit) REFUSEs checks-missing", async () => {
    const { deps } = harness({ api: { listCheckRuns: async () => checks() } });
    const result = await decide({ sha: SHA, deps, options: { ciCheckSuiteIds: [] } });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.CHECKS_MISSING);
  });

  test("round 2, item 3: a check run from the CI workflow's suite satisfies the guard", async () => {
    const { deps } = harness({ api: { listCheckRuns: async () => checks() } });
    const result = await decide({ sha: SHA, deps, options: { ciCheckSuiteIds: [1] } });
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

  test("round 3 (CodeRabbit): condition 10's READS use the read client, and the POST stays on the App token", async () => {
    // The App holds Contents read/write + Metadata read and NO pull-requests
    // permission, so a reviews read on the App token 403s. `writeTag` must do its
    // reads with the read-only client the job supplies (GITHUB_TOKEN) and keep
    // the POST + read-back on the App client.
    const restricted = async () => {
      throw new Error("403: Resource not accessible by integration");
    };
    let posted = 0;
    const { deps } = harness({
      api: {
        // The "App token" client: the pull-request reads are refused…
        listPullsForCommit: restricted,
        listReviews: restricted,
        // …but the ref write and its read-back work.
        createTagRef: async () => {
          posted += 1;
          return { ok: true, status: 201, body: {} };
        },
        readTagRef: async () => (posted ? { object: { type: "commit", sha: SHA } } : null),
      },
    });
    const readApi = fixtureApi(); // the read-only client the job passes as GH_READ_TOKEN
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: { ...appOptions, readApi } });
    expect(result.verdict).toBe(WRITE_VERDICT.TAGGED);
    expect(posted).toBe(1);
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
  // The version file's OWN history, newest first: MID touched the file without
  // changing the version; REL is where 0.56.0 became 0.57.0.
  const fileHistory = [MID, REL, PARENT];
  const versions = {
    [MID]: manifest(VERSION),
    [`${MID}^`]: manifest(VERSION), // edited the file, version unchanged
    [REL]: manifest(VERSION),
    [`${REL}^`]: manifest(PREVIOUS), // the change the nightly is looking for
    [PARENT]: manifest(PREVIOUS),
    [`${PARENT}^`]: manifest("0.55.0"),
  };

  test("acceptance 13: a later commit that edits package.json without changing the version is skipped", () => {
    const { deps, showCalls } = harness({ fileHistory, versions });
    const target = nightlyTarget(deps);
    expect(target?.sha).toBe(REL);
    expect(target?.version).toBe(VERSION);
    // "One run, one decision": the walk stops at the release commit, so the older
    // version change (0.55.0 -> 0.56.0 at PARENT) is never examined.
    expect(showCalls).not.toContain(`${PARENT}^`);
  });

  test("acceptance 8: the missed release commit is selected, and the decision ON that commit tags it", async () => {
    const { deps } = harness({
      fileHistory,
      versions,
      api: { listPullsForCommit: async () => [pull({ merge_commit_sha: REL })] },
    });
    const target = nightlyTarget(deps);
    expect(target?.sha).toBe(REL);
    // The nightly decides on that ONE commit — untagged here, so it tags itself.
    const result = await decide({ sha: target?.sha ?? "", deps });
    expect(result.verdict).toBe(VERDICT.TAG);
    expect(result.version).toBe(VERSION);
  });

  test("round 2, item 4: no version change in the file's history → null (the caller REFUSEs, never SKIPs)", () => {
    const { deps } = harness({
      fileHistory: [REL, PARENT],
      versions: {
        [REL]: manifest(VERSION),
        [`${REL}^`]: manifest(VERSION),
        [PARENT]: manifest(VERSION),
        [`${PARENT}^`]: manifest(VERSION),
      },
    });
    expect(nightlyTarget(deps)).toBeNull();
  });

  test("round 2, item 4: a version change more than 200 commits back is still found (the file's own history)", () => {
    // The old walk went at most 200 commits up from HEAD, so a release buried
    // under 250 later (non-version) commits was walked straight past and the run
    // SKIPped. The walk now follows git log -- <version file>, which lists only
    // the commits that touched it.
    const dir = scratchDir();
    const git = (...args: string[]): string => {
      const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr?.trim() ?? r.status}`);
      return r.stdout.trim();
    };
    git("init", "-q");
    git("symbolic-ref", "HEAD", "refs/heads/main");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "release-auto-tag test");
    writeFileSync(join(dir, "package.json"), manifest("0.1.0"));
    git("add", "-A");
    git("commit", "-q", "-m", "initial");
    // The release commit, then 250 commits that never touch package.json.
    writeFileSync(join(dir, "package.json"), manifest("0.2.0"));
    git("add", "-A");
    git("commit", "-q", "-m", "release 0.2.0");
    const releaseSha = git("rev-parse", "HEAD");
    for (let i = 0; i < 250; i++) {
      writeFileSync(join(dir, `filler-${i}.txt`), String(i));
      git("add", "-A");
      git("commit", "-q", "-m", `filler ${i}`);
    }
    expect(git("rev-list", "--count", `HEAD`), "the release commit is more than 200 commits back").toBe("252");

    const deps = createDeps({ root: dir });
    const target = nightlyTarget(deps, { mainRef: "main" });
    expect(target?.sha).toBe(releaseSha);
    expect(target?.version).toBe("0.2.0");
  });

  test("round 3 (CodeRabbit): a two-parent release MERGE is preserved by the walk (--first-parent)", () => {
    // Condition 7 accepts only the PR's `merge_commit_sha`. Default path-history
    // simplification drops a merge whose file content matches the merged-in
    // branch (it is TREESAME to that parent), listing the BRANCH commit instead —
    // which condition 7 rejects, so the nightly could not tag the release.
    const dir = scratchDir();
    const git = (...args: string[]): string => {
      const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr?.trim() ?? r.status}`);
      return r.stdout.trim();
    };
    git("init", "-q");
    git("symbolic-ref", "HEAD", "refs/heads/main");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    writeFileSync(join(dir, "package.json"), manifest("0.1.0"));
    writeFileSync(join(dir, "a.txt"), "a\n");
    git("add", "-A");
    git("commit", "-q", "-m", "initial");
    // The release branch bumps the version…
    git("checkout", "-q", "-b", "release/v0.2.0");
    writeFileSync(join(dir, "package.json"), manifest("0.2.0"));
    git("add", "-A");
    git("commit", "-q", "-m", "release 0.2.0");
    const branchSha = git("rev-parse", "HEAD");
    // …main moves on independently, then MERGES the release
    git("checkout", "-q", "main");
    writeFileSync(join(dir, "b.txt"), "b\n");
    git("add", "-A");
    git("commit", "-q", "-m", "unrelated");
    git("merge", "-q", "--no-ff", "-m", "Merge release/v0.2.0", "release/v0.2.0");
    const mergeSha = git("rev-parse", "HEAD");
    const parents = git("rev-list", "--parents", "-n", "1", "HEAD").split(" ");
    expect(parents.length, "the release landed as a real two-parent merge").toBe(3);
    expect(mergeSha).not.toBe(branchSha);

    const target = nightlyTarget(createDeps({ root: dir }), { mainRef: "main" });
    expect(target?.sha, "the walk selects the MERGE commit, not the branch commit").toBe(mergeSha);
    expect(target?.version).toBe("0.2.0");
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

  test("completed workflow runs: the { workflow_runs } envelope is unwrapped (round 2, item 3)", async () => {
    const run = { id: 7, check_suite_id: 42 };
    const mock = mockFetch({
      [`${BASE}/repos/${REPO}/actions/workflows/test.yml/runs?head_sha=${SHA}&status=completed&per_page=100`]: {
        body: { total_count: 1, workflow_runs: [run] },
      },
    });
    const client = createClient({ repo: REPO, token: "t", fetchImpl: mock.impl });
    expect(await client.listCompletedWorkflowRunsForSha("test.yml", SHA)).toEqual([run]);
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

  test("round 2, item 4: the CLI's nightly path REFUSEs version-origin-not-found when the walk finds no change", async () => {
    const dir = scratchDir();
    const out = join(dir, "out.txt");
    // No version-file history to walk → the origin cannot be found. This used to
    // be a silent SKIP, which is how a missed release disappears.
    const { deps } = harness();
    const code = await main(["decide", "--repo", REPO, "--nightly", "--output", out], { deps });
    expect(code).toBe(0);
    const text = readFileSync(out, "utf8");
    expect(text).toContain("verdict=REFUSE");
    expect(text).toContain(`condition=${CONDITION.VERSION_ORIGIN_NOT_FOUND}`);
  });

  test("the CLI rejects a tag invocation without --version", async () => {
    const { deps } = harness();
    await expect(main(["tag", "--repo", REPO, "--sha", SHA], { deps })).rejects.toThrow();
  });
});
