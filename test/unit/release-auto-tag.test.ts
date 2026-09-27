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
import { existsSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { readProjectVersion, replaceProjectVersion } from "../../scripts/ci/pyproject-version.mjs";

import {
  ADK_PYPROJECT_PATH,
  CONDITION,
  DEFAULT_POLL_SECONDS,
  VERDICT,
  WRITE_VERDICT,
  adkVersionCheck,
  classifyLsTree,
  readAdkPyproject,
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
    // `pulls/<n>` — the PR itself, which is where the commit COUNT lives
    // (condition 7c, round 7, item 1): the associated-commit list does not carry
    // a `commits` field. One commit is a well-shaped release PR.
    readPull: async () => ({ ...pull(), commits: 1 }),
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
   * File contents keyed by `<rev>:<path>` (the adk flake's pyproject, slice 3 of
   * #1928). A key present with `null` models an ABSENT file; unlisted non-version
   * paths read as null, exactly as `git show <rev>:<path>` would.
   */
  files?: Record<string, string | null>;
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
      show: (rev: string, path: string = "package.json") => {
        showCalls.push(rev);
        const key = `${rev}:${path}`;
        if (opts.files && Object.prototype.hasOwnProperty.call(opts.files, key)) {
          return opts.files[key];
        }
        // The version-bearing manifest is the only file the default fixture
        // serves; every OTHER path reads as absent, as `git show` would return
        // null for a path the revision does not carry.
        return path === "package.json" ? (versions[rev] ?? null) : null;
      },
      isAncestor: () => opts.ancestor ?? true,
      lsTree: (sha: string, path: string = ADK_PYPROJECT_PATH) => {
        const key = `${sha}:${path}`;
        if (opts.files && Object.prototype.hasOwnProperty.call(opts.files, key)) {
          const t = opts.files[key];
          return t === null || t === undefined ? { kind: "absent" } : { kind: "present" };
        }
        return { kind: "absent" };
      },
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
    // The checker imports the SHARED pyproject helper from a sibling module; a
    // materialised tree needs it too, or the checker cannot load (round 2).
    mkdirSync(join(repo, "scripts", "ci"), { recursive: true });
    writeFileSync(
      join(repo, "scripts", "ci", "pyproject-version.mjs"),
      readFileSync(join(realRoot, "scripts", "ci", "pyproject-version.mjs"), "utf8"),
    );
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

// ── condition 7c (the release PR is a single commit) ───────────────────────────

describe("release auto-tag — condition 7c (the release PR is a single commit)", () => {
  test("round 7, item 1: a TWO-commit release PR REFUSEs release-pr-not-single-commit", async () => {
    // 7b diffs the tag target against its first parent, and that is the whole PR
    // only under a squash merge; under a rebase merge an earlier commit of the
    // same PR lands before the tip and 7b never sees it. The count closes that.
    const { deps } = harness({ api: { readPull: async () => ({ ...pull(), commits: 2 }) } });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.RELEASE_PR_NOT_SINGLE_COMMIT);
    expect(result.summary.join(" ")).toContain("2 commit(s)");
  });

  test("round 7, item 1: a single-commit release PR passes 7c", async () => {
    const { deps } = harness();
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.TAG);
  });

  test("round 7, item 1: an UNREADABLE commit count REFUSEs (it is not assumed to be 1)", async () => {
    const { deps } = harness({ api: { readPull: async () => null } });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.RELEASE_PR_NOT_SINGLE_COMMIT);
    expect(result.summary.join(" ")).toContain("an unreadable number of commits");
  });

  test("round 7, item 1: the count is read from the pulls API (`pulls/<n>`), by PR number", async () => {
    // The associated-commit list condition 7 reads carries no `commits` field, so
    // the count comes from the PR itself.
    const asked: number[] = [];
    const { deps } = harness({
      api: {
        readPull: async (n) => {
          asked.push(n);
          return { ...pull(), commits: 1 };
        },
      },
    });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.TAG);
    expect(asked).toEqual([pull().number]);
  });

  test("round 7, item 1: a two-commit release PR also REFUSEs at the WRITE boundary", async () => {
    const { deps } = harness({ api: { readPull: async () => ({ ...pull(), commits: 2 }) } });
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(result.verdict).toBe(WRITE_VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.RELEASE_PR_NOT_SINGLE_COMMIT);
    expect((result.summary ?? []).join(" ")).toContain("2 commit(s)");
  });

  test("round 7, item 1: the write boundary's count read goes through the READ client", async () => {
    // Same custody rule as 7 and 8's reads: the App holds Contents + Metadata and
    // NO pull-requests permission, so a `pulls/<n>` read on the App token 403s
    // and an eligible release would never be tagged.
    const asked: number[] = [];
    let tagged = false;
    // The READ client answers `pulls/<n>`; the App client only POSTs the ref.
    const readApi = fixtureApi({
      readPull: async (n) => {
        asked.push(n);
        return { ...pull(), commits: 1 };
      },
    });
    const { deps } = harness({
      api: {
        createTagRef: async () => {
          tagged = true;
          return { ok: true, status: 201, body: {} };
        },
        readTagRef: async () => (tagged ? { object: { type: "commit", sha: SHA } } : null),
      },
    });
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: { ...appOptions, readApi } });
    expect(result.verdict).toBe(WRITE_VERDICT.TAGGED);
    expect(asked).toEqual([pull().number]);
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

// ── slice 3 of #1928: the auto-tag also creates the adk-flair-v tag ────────────

describe("release auto-tag — the adk-flair tag (slice 3 of #1928)", () => {
  const pyproject = (version: string) =>
    `[project]\nname = "adk-flair"\nversion = "${version}"\n`;

  /** Pin `packages/adk-flair/pyproject.toml` at every rev the tagger reads. */
  function pinPyproject(deps: Deps, text: string | null) {
    const orig = deps.git.show.bind(deps.git);
    deps.git.show = (rev: string, path: string) =>
      path === ADK_PYPROJECT_PATH ? text : orig(rev, path);
    // The shared read asks MEMBERSHIP first (round 7): pin ls-tree to agree.
    deps.git.lsTree = (sha: string, path: string) =>
      path === ADK_PYPROJECT_PATH
        ? text === null || text === undefined
          ? { kind: "absent" }
          : { kind: "present" }
        : { kind: "absent" };
  }

  /** A ref store: the POST records the ref (and makes it resolvable at <sha>);
   *  every read is recorded so a test can prove a read-back happened. */
  function refApi(
    posts: string[],
    tags: Map<string, unknown>,
    reads: string[] = [],
    reject?: (ref: string) => boolean,
    events: Array<{ op: string; ref: string; sha?: string }> = [],
  ) {
    return {
      createTagRef: async (ref: string, sha: string) => {
        posts.push(ref);
        events.push({ op: "post", ref, sha });
        if (reject?.(ref)) return { ok: false, status: 403, body: { message: "Resource not accessible" } };
        tags.set(ref.replace("refs/tags/", ""), { object: { type: "commit", sha } });
        return { ok: true, status: 201, body: {} };
      },
      readTagRef: async (tag: string) => {
        reads.push(tag);
        events.push({ op: "read", ref: tag });
        return tags.get(tag) ?? null;
      },
    };
  }

  test("(a) pyproject matches → the v ref then the adk ref are POSTed and read back, adk TAGGED", async () => {
    const posts: string[] = [];
    const tags = new Map<string, unknown>();
    const reads: string[] = [];
    const events: Array<{ op: string; ref: string; sha?: string }> = [];
    const { deps } = harness({ api: refApi(posts, tags, reads, undefined, events) });
    pinPyproject(deps, pyproject(VERSION));
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(result.verdict).toBe(WRITE_VERDICT.TAGGED);
    expect(posts).toEqual([`refs/tags/v${VERSION}`, `refs/tags/adk-flair-v${VERSION}`]);
    expect(result.adkVerdict).toBe("TAGGED");
    expect(result.adkCondition).toBe("");
    // BOTH read-backs happened (round 2, item 4): the v ref and the adk ref.
    expect(reads).toContain(`v${VERSION}`);
    expect(reads).toContain(`adk-flair-v${VERSION}`);
    // ORDERED (round 3, item 4): each ref's read-BACK FOLLOWS its POST (the
    // pre-POST reads — condition 3 and the adk pre-check — are earlier events).
    const postV = events.findIndex(
      (e) => e.op === "post" && e.ref === `refs/tags/v${VERSION}`,
    );
    const postAdk = events.findIndex(
      (e) => e.op === "post" && e.ref === `refs/tags/adk-flair-v${VERSION}`,
    );
    expect(postV, "the v POST happened").toBeGreaterThanOrEqual(0);
    expect(postAdk, "the adk POST happened").toBeGreaterThanOrEqual(0);
    const readV = events.findIndex((e, i) => e.op === "read" && e.ref === `v${VERSION}` && i > postV);
    const readAdk = events.findIndex(
      (e, i) => e.op === "read" && e.ref === `adk-flair-v${VERSION}` && i > postAdk,
    );
    expect(readV, "the v read-back follows the v POST").toBeGreaterThan(postV);
    expect(readAdk, "the adk read-back follows the adk POST").toBeGreaterThan(postAdk);
  });

  test("(b) no pyproject at <sha> → only the v ref, adk SKIP (flair releases without the Python package)", async () => {
    const posts: string[] = [];
    const tags = new Map<string, unknown>();
    const { deps } = harness({ api: refApi(posts, tags) });
    pinPyproject(deps, null);
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(result.verdict).toBe(WRITE_VERDICT.TAGGED);
    expect(posts).toEqual([`refs/tags/v${VERSION}`]);
    expect(result.adkVerdict).toBe("SKIP");
    expect(result.adkCondition).toBe("");
  });

  test("(c) a pyproject version that DIFFERS refuses adk-version-mismatch with NO POST at all", async () => {
    const posts: string[] = [];
    const tags = new Map<string, unknown>();
    const { deps } = harness({ api: refApi(posts, tags) });
    pinPyproject(deps, pyproject("0.55.2"));
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(result.verdict).toBe(WRITE_VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.ADK_VERSION_MISMATCH);
    expect(result.adkVerdict).toBe("REFUSE");
    expect(result.adkCondition).toBe(CONDITION.ADK_VERSION_MISMATCH);
    expect(posts).toEqual([]); // not even the v tag
  });

  test("(d) an adk tag at the SAME sha is a SKIP; at ANOTHER sha refuses adk-tag-exists-elsewhere", async () => {
    // same sha → SKIP, and the adk ref is not POSTed again
    {
      const posts: string[] = [];
      const tags = new Map<string, unknown>([
        [`adk-flair-v${VERSION}`, { object: { type: "commit", sha: SHA } }],
      ]);
      const { deps } = harness({ api: refApi(posts, tags) });
      pinPyproject(deps, pyproject(VERSION));
      const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
      expect(result.verdict).toBe(WRITE_VERDICT.TAGGED);
      expect(posts).toEqual([`refs/tags/v${VERSION}`]); // the adk ref was NOT posted
      expect(result.adkVerdict).toBe("SKIP");
    }
    // another sha → REFUSE with NO POST AT ALL (round 2, item 2: pre-checked
    // before the v POST, so an adk-elsewhere never writes the v tag).
    {
      const posts: string[] = [];
      const tags = new Map<string, unknown>([
        [`adk-flair-v${VERSION}`, { object: { type: "commit", sha: HEAD } }],
      ]);
      const { deps } = harness({ api: refApi(posts, tags) });
      pinPyproject(deps, pyproject(VERSION));
      const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
      expect(result.verdict).toBe(WRITE_VERDICT.REFUSE);
      expect(result.adkVerdict).toBe("REFUSE");
      expect(result.adkCondition).toBe(CONDITION.ADK_TAG_EXISTS_ELSEWHERE);
      expect(posts).toEqual([]); // zero POSTs
    }
  });

  test("(e) a rejected adk POST (403) after the v tag → adk-ref-write-rejected, v present, no retry", async () => {
    const posts: string[] = [];
    const tags = new Map<string, unknown>();
    const { deps } = harness({
      api: refApi(posts, tags, [], (ref) => ref === `refs/tags/adk-flair-v${VERSION}`),
    });
    pinPyproject(deps, pyproject(VERSION));
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(result.verdict).toBe(WRITE_VERDICT.TAGGED); // the v tag stands
    expect(result.adkVerdict).toBe("REFUSE");
    expect(result.adkCondition).toBe(CONDITION.ADK_REF_WRITE_REJECTED);
    // The adk POST was ATTEMPTED once and never retried.
    expect(posts).toEqual([`refs/tags/v${VERSION}`, `refs/tags/adk-flair-v${VERSION}`]);
    expect(tags.has(`v${VERSION}`)).toBe(true);
    // The WHOLE emitted text: what this run read back for BOTH refs, then the check.
    const adkTag = `adk-flair-v${VERSION}`;
    expect(result.summary).toEqual([
      `the POST of refs/tags/${adkTag} was rejected (403); this run read back v${VERSION} at ${SHA} and ${adkTag} not found; next: re-run the workflow on this commit, then confirm with \`git ls-remote --tags origin ${adkTag}\` that it resolves to ${SHA}`,
    ]);
  });

  test("(f) a re-run on the same sha completes the adk tag: the v POST is skipped, one adk POST, adk TAGGED", async () => {
    const posts: string[] = [];
    const tags = new Map<string, unknown>();
    const reads: string[] = [];
    let rejectAdk = true;
    const { deps } = harness({
      api: refApi(posts, tags, reads, (ref) => rejectAdk && ref === `refs/tags/adk-flair-v${VERSION}`),
    });
    pinPyproject(deps, pyproject(VERSION));
    // Pass 1: the adk POST is rejected → v is created, the adk tag is not.
    const first = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(first.verdict).toBe(WRITE_VERDICT.TAGGED);
    expect(first.adkVerdict).toBe("REFUSE");
    expect(first.adkCondition).toBe(CONDITION.ADK_REF_WRITE_REJECTED);
    expect(tags.has(`v${VERSION}`)).toBe(true);
    expect(tags.has(`adk-flair-v${VERSION}`)).toBe(false);
    const postsBeforeReRun = posts.length;
    const readsBeforeReRun = reads.length;
    // Pass 2: the SAME sha. v is already there but the adk tag is not → TAG, with
    // the v POST skipped.
    rejectAdk = false;
    const second = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(second.verdict).toBe(WRITE_VERDICT.TAGGED);
    expect(second.adkVerdict).toBe("TAGGED");
    expect(second.vVerdict).toBe(WRITE_VERDICT.SKIP);
    // Zero v POSTs, exactly one adk POST on the re-run.
    expect(posts.slice(postsBeforeReRun)).toEqual([`refs/tags/adk-flair-v${VERSION}`]);
    expect(tags.get(`adk-flair-v${VERSION}`)).toEqual({ object: { type: "commit", sha: SHA } });
    // Both read-backs were recorded on the re-run.
    expect(reads.slice(readsBeforeReRun)).toContain(`v${VERSION}`);
    expect(reads.slice(readsBeforeReRun)).toContain(`adk-flair-v${VERSION}`);
  });

  test("(g) a [tool.x] version ABOVE [project] is read as the PROJECT version (mismatch refuses)", async () => {
    const posts: string[] = [];
    const tags = new Map<string, unknown>();
    const { deps } = harness({ api: refApi(posts, tags) });
    // VERSION is 0.56.0; [project].version is 0.55.2, [tool.demo].version 0.56.0.
    pinPyproject(
      deps,
      `[tool.demo]\nversion = "${VERSION}"\n[project]\nname = "adk-flair"\nversion = "0.55.2"\n`,
    );
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(result.verdict).toBe(WRITE_VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.ADK_VERSION_MISMATCH);
    expect((result.summary ?? []).join(" ")).toContain("0.55.2");
    expect(posts).toEqual([]);
  });

  test("(h) check-version-sync reads the [project] version, not a [tool.x] line above it", () => {
    const root = scratchDir();
    const realRoot = resolve(import.meta.dir, "../..");
    const realChecker = join(realRoot, "scripts", "check-version-sync.mjs");
    const realVersion = JSON.parse(readFileSync(join(realRoot, "package.json"), "utf8")).version;
    const listed = spawnSync(process.execPath, [realChecker, "--list"], { cwd: realRoot, encoding: "utf8" });
    expect(listed.status).toBe(0);
    const inventory = String(listed.stdout ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const path of inventory) {
      const dest = join(root, path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(join(realRoot, path)));
    }
    const bumped = "0.0.1";
    writeFileSync(
      join(root, "packages/adk-flair/pyproject.toml"),
      `[tool.demo]\nversion = "${realVersion}"\n[project]\nname = "adk-flair"\nversion = "${bumped}"\n`,
    );
    const r = spawnSync(process.execPath, [realChecker, "--root", root, realVersion], { encoding: "utf8" });
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status, out).not.toBe(0);
    expect(out).toContain(bumped); // the PROJECT version is reported, not the tool line
    expect(out).toContain("packages/adk-flair/pyproject.toml");
  });

  test("(i) a failed adk read-back (resolves elsewhere) refuses with a named condition, v stays", async () => {
    const posts: string[] = [];
    const tags = new Map<string, unknown>();
    // The POST reports OK but the adk ref resolves to HEAD, not SHA.
    const api = {
      createTagRef: async (ref: string, sha: string) => {
        posts.push(ref);
        const name = ref.replace("refs/tags/", "");
        tags.set(name, { object: { type: "commit", sha: name.startsWith("adk-flair-v") ? HEAD : sha } });
        return { ok: true, status: 201, body: {} };
      },
      readTagRef: async (tag: string) => tags.get(tag) ?? null,
    };
    const { deps } = harness({ api });
    pinPyproject(deps, pyproject(VERSION));
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(result.verdict).toBe(WRITE_VERDICT.TAGGED);
    expect(result.adkVerdict).toBe("REFUSE");
    expect(result.adkCondition).toBe(CONDITION.ADK_REF_WRITE_REJECTED);
    expect(tags.get(`v${VERSION}`)).toEqual({ object: { type: "commit", sha: SHA } });
    // The WHOLE emitted text: what this run observed for BOTH refs, then the check
    // the operator runs next. No predictive phrase.
    const adkTag = `adk-flair-v${VERSION}`;
    expect(result.summary).toEqual([
      `after the POST, this run read ${adkTag} at ${HEAD}, not ${SHA}; v${VERSION} is at ${SHA}; check the ref with \`git ls-remote --tags origin ${adkTag}\` and move or delete it if it should be at ${SHA}`,
    ]);
  });

  test("(i2) a MISSING adk read-back refuses adk-ref-write-rejected with its OWN text, distinct from elsewhere", async () => {
    const posts: string[] = [];
    const tags = new Map<string, unknown>();
    // The POST reports OK, but the adk ref does NOT read back (readTagRef → null).
    const api = {
      createTagRef: async (ref: string, sha: string) => {
        posts.push(ref);
        if (ref.startsWith("refs/tags/adk-flair-v")) return { ok: true, status: 201, body: {} };
        tags.set(ref.replace("refs/tags/", ""), { object: { type: "commit", sha } });
        return { ok: true, status: 201, body: {} };
      },
      readTagRef: async (tag: string) => tags.get(tag) ?? null,
    };
    const { deps } = harness({ api });
    pinPyproject(deps, pyproject(VERSION));
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(result.adkVerdict).toBe("REFUSE"); // assertion A
    expect(result.adkCondition).toBe(CONDITION.ADK_REF_WRITE_REJECTED);
    const adkTag = `adk-flair-v${VERSION}`;
    expect(result.summary).toEqual([
      `${adkTag} did not read back after the POST; v${VERSION} stays at ${SHA}; re-run the workflow on this commit`,
    ]);
  });

  test("(i3) an adk read-back that cannot be RESOLVED to a commit refuses with its OWN text", async () => {
    const posts: string[] = [];
    const tags = new Map<string, unknown>();
    let adkPosted = false;
    const api = {
      createTagRef: async (ref: string, sha: string) => {
        posts.push(ref);
        if (ref.startsWith("refs/tags/adk-flair-v")) {
          adkPosted = true;
          return { ok: true, status: 201, body: {} };
        }
        tags.set(ref.replace("refs/tags/", ""), { object: { type: "commit", sha } });
        return { ok: true, status: 201, body: {} };
      },
      readTagRef: async (tag: string) => {
        if (tag.startsWith("adk-flair-v")) {
          // Absent BEFORE the POST (so the pre-check passes), then a ref that
          // resolves to no commit (a blob) AFTER it.
          return adkPosted ? { object: { type: "blob", sha: "deadbeef" } } : null;
        }
        return tags.get(tag) ?? null;
      },
    };
    const { deps } = harness({ api });
    pinPyproject(deps, pyproject(VERSION));
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(result.adkVerdict).toBe("REFUSE"); // assertion A
    const adkTag = `adk-flair-v${VERSION}`;
    expect(result.summary).toEqual([
      `this run read ${adkTag} as ref type "blob" at "deadbeef", which could not be resolved to a commit; v${VERSION} is at ${SHA}; inspect the ref with \`git ls-remote --tags origin ${adkTag}\``,
    ]);
  });

  test("(git-fail) a git failure at the write boundary REFUSES before ANY POST, naming the reason", async () => {
    const posts: string[] = [];
    const tags = new Map<string, unknown>();
    const { deps } = harness({ api: refApi(posts, tags) });
    deps.git.lsTree = () => ({ kind: "failed", reason: "spawn error: boom" });
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(result.verdict).toBe(WRITE_VERDICT.REFUSE); // assertion A
    expect(result.condition).toBe(CONDITION.ADK_PYPROJECT_UNREADABLE);
    expect(result.adkCondition).toBe(CONDITION.ADK_PYPROJECT_UNREADABLE);
    expect(result.summary).toEqual([
      `the on-tree ${ADK_PYPROJECT_PATH} could not be read at ${SHA} (spawn error: boom); bob cannot verify the Python package, so the whole release is refused before any tag`,
    ]); // assertion B: the reason, in the whole text
    expect(posts).toEqual([]); // assertion C: zero POSTs
  });

  test("(r1) ls-tree says absent → absent, and git show is NEVER called", async () => {
    const posts: string[] = [];
    const tags = new Map<string, unknown>();
    const { deps } = harness({ api: refApi(posts, tags) });
    let showCalls = 0;
    const origShow = deps.git.show.bind(deps.git);
    deps.git.show = (rev: string, path: string) => {
      if (path === ADK_PYPROJECT_PATH) showCalls++;
      return origShow(rev, path);
    };
    deps.git.lsTree = () => ({ kind: "absent" });
    expect(readAdkPyproject(deps.git, SHA)).toEqual({ kind: "absent" }); // assertion A
    expect(showCalls).toBe(0); // assertion B: no show call
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(result.adkVerdict).toBe("SKIP"); // the adk step is skipped
    expect(posts).toEqual([`refs/tags/v${VERSION}`]); // only the v POST
  });

  test("(r2) ls-tree exits NON-ZERO with stderr containing the old absence fragment → failed → REFUSE adk-pyproject-unreadable, ZERO POSTs", async () => {
    // The OLD classifier returned null (absent) when stderr contained "does not
    // exist in"; this is that false-absent case. Classification is by EXIT STATUS.
    const cls = classifyLsTree(
      { status: 128, stdout: "", stderr: "fatal: path 'packages/adk-flair/pyproject.toml' does not exist in 'abc'" },
      ADK_PYPROJECT_PATH,
    );
    expect(cls.kind).toBe("failed"); // assertion A: the old classifier's false-absent case
    const posts: string[] = [];
    const tags = new Map<string, unknown>();
    const { deps } = harness({ api: refApi(posts, tags) });
    deps.git.lsTree = () => cls;
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(result.verdict).toBe(WRITE_VERDICT.REFUSE); // assertion B
    expect(result.condition).toBe(CONDITION.ADK_PYPROJECT_UNREADABLE);
    expect(result.summary).toEqual([
      `the on-tree ${ADK_PYPROJECT_PATH} could not be read at ${SHA} (git ls-tree exited 128: fatal: path 'packages/adk-flair/pyproject.toml' does not exist in 'abc'); bob cannot verify the Python package, so the whole release is refused before any tag`,
    ]); // assertion C: the whole text
    expect(posts).toEqual([]); // assertion D: ZERO POSTs
  });

  test("(r3) ls-tree TIMES OUT → failed, reason names the timeout, ZERO POSTs", async () => {
    const cls = classifyLsTree({ error: { code: "ETIMEDOUT" }, signal: "SIGTERM", status: null }, ADK_PYPROJECT_PATH);
    expect(cls.kind).toBe("failed"); // assertion A
    expect(cls.kind === "failed" ? cls.reason : "").toContain("timeout"); // assertion B: names the timeout
    const posts: string[] = [];
    const tags = new Map<string, unknown>();
    const { deps } = harness({ api: refApi(posts, tags) });
    deps.git.lsTree = () => cls;
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(result.verdict).toBe(WRITE_VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.ADK_PYPROJECT_UNREADABLE);
    expect(result.summary).toEqual([
      `the on-tree ${ADK_PYPROJECT_PATH} could not be read at ${SHA} (timeout after ${10_000}ms); bob cannot verify the Python package, so the whole release is refused before any tag`,
    ]); // assertion C
    expect(posts).toEqual([]); // assertion D: ZERO POSTs
  });

  test("(r4) the DECIDE path with v at the sha and a failing read → a STRUCTURED REFUSE, not a throw", async () => {
    const tags = new Map<string, unknown>([[`v${VERSION}`, { object: { type: "commit", sha: SHA } }]]);
    const { deps } = harness({
      api: refApi([], tags),
      files: { [`${SHA}:${ADK_PYPROJECT_PATH}`]: pyproject(VERSION) },
    });
    deps.git.lsTree = () => ({ kind: "failed", reason: "spawn error: boom" });
    const result = await decide({ sha: SHA, deps }); // must NOT throw
    expect(result.verdict).toBe(VERDICT.REFUSE); // assertion A: a structured refuse
    expect(result.condition).toBe(CONDITION.ADK_PYPROJECT_UNREADABLE);
    expect(result.adkCondition).toBe(CONDITION.ADK_PYPROJECT_UNREADABLE);
    expect((result.summary ?? []).join(" ")).toContain("could not be read"); // assertion B: its summary survives
    expect(result.vVerdict).toBe(WRITE_VERDICT.SKIP);
  });

  test("(r5) check-version-sync on `version = 1` reports 'present but unsupported: <reason>', not 'no declaration'", () => {
    const root = scratchDir();
    const realRoot = resolve(import.meta.dir, "../..");
    const checker = join(realRoot, "scripts", "check-version-sync.mjs");
    const realVersion = JSON.parse(readFileSync(join(realRoot, "package.json"), "utf8")).version;
    const listed = spawnSync(process.execPath, [checker, "--list"], { cwd: realRoot, encoding: "utf8" });
    expect(listed.status).toBe(0);
    const inventory = String(listed.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
    for (const path of inventory) {
      const dest = join(root, path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(join(realRoot, path)));
    }
    // A present but UNSUPPORTED [project] version (valid TOML, a non-string value).
    writeFileSync(join(root, "packages/adk-flair/pyproject.toml"), `[project]\nname = "adk-flair"\nversion = 1\n`);
    const r = spawnSync(process.execPath, [checker, realVersion, "--root", root], { encoding: "utf8" });
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status).not.toBe(0); // assertion A
    expect(out).toContain("present but unsupported: project.version is not a string (int)"); // assertion B: the reader's reason
    expect(out).not.toContain("no [project].version declaration"); // assertion C: NOT the other message
  });

  test("(r6) a rejected adk POST with an UNRESOLVABLE read-back reports its raw type and SHA", async () => {
    const posts: string[] = [];
    const tags = new Map<string, unknown>();
    let attempted = false;
    const api = {
      createTagRef: async (ref: string, sha: string) => {
        posts.push(ref);
        if (ref.startsWith("refs/tags/adk-flair-v")) {
          attempted = true;
          return { ok: false, status: 403, body: { message: "nope" } };
        }
        tags.set(ref.replace("refs/tags/", ""), { object: { type: "commit", sha } });
        return { ok: true, status: 201, body: {} };
      },
      readTagRef: async (tag: string) =>
        tag.startsWith("adk-flair-v")
          ? attempted
            ? { object: { type: "blob", sha: "deadbeef" } }
            : null
          : (tags.get(tag) ?? null),
    };
    const { deps } = harness({ api });
    pinPyproject(deps, pyproject(VERSION));
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    const adkTag = `adk-flair-v${VERSION}`;
    expect(result.summary).toEqual([
      `the POST of refs/tags/${adkTag} was rejected (403); this run read back v${VERSION} at ${SHA} and ${adkTag} at an unresolvable ref (type "blob", sha "deadbeef"); next: re-run the workflow on this commit, then confirm with \`git ls-remote --tags origin ${adkTag}\` that it resolves to ${SHA}`,
    ]); // assertion: the raw type and SHA are in the text
  });

  test("(reader) a valid-TOML pyproject whose version the reader rejects emits the whole 'could not be verified' text", async () => {
    const posts: string[] = [];
    const tags = new Map<string, unknown>();
    const { deps } = harness({ api: refApi(posts, tags) });
    // Valid TOML; the reader rejects a non-string version (a reader failure path).
    pinPyproject(deps, `[project]\nname = "adk-flair"\nversion = 1\n`);
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(result.verdict).toBe(WRITE_VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.ADK_PYPROJECT_UNSUPPORTED);
    expect(result.summary).toEqual([
      `the project version in ${ADK_PYPROJECT_PATH} could not be verified: project.version is not a string (int)`,
    ]); // assertion: the ACTUAL reason, not a claim about the file's form
  });

  test("(write-msg) check-version-sync --write emits the WHOLE 'could not be safely rewritten' text", () => {
    const root = scratchDir();
    mkdirSync(join(root, "packages/flair-bench/src"), { recursive: true });
    mkdirSync(join(root, "packages/adk-flair"), { recursive: true });
    const bench = join(root, "packages/flair-bench/src/version.ts");
    writeFileSync(bench, 'export const TOOL_VERSION = "1.0.0";\n');
    writeFileSync(
      join(root, "packages/adk-flair/pyproject.toml"),
      `[project]\nname = "adk-flair"\ndescription = """\nversion = "0.55.2"\n"""\nversion = "1.0.0"\n`,
    );
    const realRoot = resolve(import.meta.dir, "../..");
    const checker = join(realRoot, "scripts", "check-version-sync.mjs");
    const r = spawnSync(process.execPath, [checker, "--write", "2.0.0", "--root", root], {
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0); // assertion A: refused
    expect(String(r.stderr).trim()).toBe(
      `❌ packages/adk-flair/pyproject.toml: the version could not be safely rewritten: a version declaration exists, but the rewrite would not change only [project].version (the tomllib re-verify refused)`,
    ); // assertion B: the WHOLE message
    expect(readFileSync(bench, "utf8")).toBe('export const TOOL_VERSION = "1.0.0";\n'); // assertion C: NOTHING written
  });

  test("(phrases) no recovery/refusal text the module actually EMITS predicts a future outcome", async () => {
    const phrases = ["will refuse", "completes it", "was created", "was not created", "is written"];
    const adkTag = `adk-flair-v${VERSION}`;
    const emitted: string[] = [];
    const collect = async (api: unknown, pin: string) => {
      const { deps } = harness({ api: api as never });
      pinPyproject(deps, pin);
      const r = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
      emitted.push(...(r.summary ?? []));
    };
    // rejected adk POST
    {
      const posts: string[] = [];
      const tags = new Map<string, unknown>();
      await collect(refApi(posts, tags, [], (ref) => ref === `refs/tags/${adkTag}`), pyproject(VERSION));
    }
    // MISSING
    await collect(
      {
        createTagRef: async (ref: string, sha: string) => {
          if (!ref.startsWith("refs/tags/adk-flair-v")) {
            /* the v ref reads back */
          }
          return { ok: true, status: 201, body: {} };
        },
        readTagRef: async (tag: string) =>
          tag.startsWith("adk-flair-v") ? null : { object: { type: "commit", sha: SHA } },
      },
      pyproject(VERSION),
    );
    // UNRESOLVED
    {
      let posted = false;
      await collect(
        {
          createTagRef: async (ref: string, sha: string) => {
            if (ref.startsWith("refs/tags/adk-flair-v")) posted = true;
            return { ok: true, status: 201, body: {} };
          },
          readTagRef: async (tag: string) =>
            tag.startsWith("adk-flair-v")
              ? posted
                ? { object: { type: "blob", sha: "deadbeef" } }
                : null
              : { object: { type: "commit", sha: SHA } },
        },
        pyproject(VERSION),
      );
    }
    // ELSEWHERE
    {
      let posted = false;
      await collect(
        {
          createTagRef: async (ref: string) => {
            if (ref.startsWith("refs/tags/adk-flair-v")) posted = true;
            return { ok: true, status: 201, body: {} };
          },
          readTagRef: async (tag: string) =>
            tag.startsWith("adk-flair-v")
              ? posted
                ? { object: { type: "commit", sha: HEAD } }
                : null
              : { object: { type: "commit", sha: SHA } },
        },
        pyproject(VERSION),
      );
    }
    // git failure
    {
      const posts: string[] = [];
      const tags = new Map<string, unknown>();
      const { deps } = harness({ api: refApi(posts, tags) });
      deps.git.lsTree = () => ({ kind: "failed", reason: "spawn error: boom" });
      const r = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
      emitted.push(...(r.summary ?? []));
    }
    // reader failure
    await collect(refApi([], new Map()), `[project]\nname = "adk-flair"\nversion = 1\n`);
    // decide path: v already at <sha>, adk absent → the TAG/vAlreadyAtSha summary
    {
      const tags = new Map<string, unknown>([[`v${VERSION}`, { object: { type: "commit", sha: SHA } }]]);
      const { deps } = harness({
        api: { readTagRef: async (t: string) => tags.get(t) ?? null },
        files: { [`${SHA}:${ADK_PYPROJECT_PATH}`]: pyproject(VERSION) },
      });
      const r = await decide({ sha: SHA, deps });
      emitted.push(...(r.summary ?? []));
    }

    expect(emitted.length).toBeGreaterThan(0); // the scan saw real texts
    // SCAN COMPLETENESS: the fixture list must name every emitting path. The
    // branches (file:line at this commit) are:
    //   release-auto-tag.mjs: decide's adk-work refusal (:~1050) + the vAlreadyAtSha
    //     TAG summary (:1212); writeTag's git-failure refusal (:1315),
    //     version-mismatch/unsupported refusals (:1328), pre-POST adk-elsewhere,
    //     rejected-POST (:1422), MISSING (:1427), UNRESOLVED (:1440), ELSEWHERE (:1454);
    //   check-version-sync.mjs: write()'s refusal (:276) and readDeclared's two
    //     reasons (:241/:244).
    const FIXTURES = [
      "rejected-post",
      "missing",
      "unresolved",
      "elsewhere",
      "git-fail",
      "reader",
      "decide-v-at-sha",
      "cvs-verify",
      "cvs-write",
    ];
    expect(FIXTURES.length).toBe(9); // the fixtures this scan runs
    const checkVersionSyncMessages: string[] = [];
    {
      // check-version-sync's two messages, collected from real runs.
      const realRoot = resolve(import.meta.dir, "../..");
      const checker = join(realRoot, "scripts", "check-version-sync.mjs");
      const root = scratchDir();
      mkdirSync(join(root, "packages/flair-bench/src"), { recursive: true });
      mkdirSync(join(root, "packages/adk-flair"), { recursive: true });
      writeFileSync(join(root, "packages/flair-bench/src/version.ts"), 'export const TOOL_VERSION = "1.0.0";\n');
      writeFileSync(join(root, "packages/adk-flair/pyproject.toml"), `[project]\nname = "adk-flair"\nversion = 1\n`);
      const a = spawnSync(process.execPath, [checker, "1.0.0", "--root", root], { encoding: "utf8" });
      checkVersionSyncMessages.push(`${a.stdout}${a.stderr}`);
      writeFileSync(join(root, "packages/adk-flair/pyproject.toml"), `[project]\nname = "adk-flair"\ndescription = """\nversion = "0.55.2"\n"""\nversion = "1.0.0"\n`);
      const b = spawnSync(process.execPath, [checker, "--write", "2.0.0", "--root", root], { encoding: "utf8" });
      checkVersionSyncMessages.push(`${b.stdout}${b.stderr}`);
    }
    // The population the scan must have seen: the writeText fixtures (6) + the
    // check-version-sync messages (2). A new emitting path that is NOT added here
    // makes this assertion drift — the guard the brief asks for.
    expect(emitted.length + checkVersionSyncMessages.length).toBe(12);
    for (const t of [...emitted, ...checkVersionSyncMessages]) {
      for (const p of phrases) {
        const readBack = /[0-9a-f]{40}/.test(t) || /read back|not found|did not read back/.test(t);
        if (t.includes(p)) expect(readBack, `"${p}" with no read-back value: ${t}`).toBe(true);
      }
      expect(t).not.toContain("will refuse");
      expect(t).not.toContain("completes it");
      expect(t).not.toContain("is written");
    }
  });

  test("(j) a [[array-of-tables]] + dynamic version refuses adk-version-mismatch naming dynamic, zero POSTs", async () => {
    const posts: string[] = [];
    const tags = new Map<string, unknown>();
    const { deps } = harness({ api: refApi(posts, tags) });
    pinPyproject(
      deps,
      `[project]\nname = "adk-flair"\ndynamic = ["version"]\n[[tool.demo]]\nversion = "${VERSION}"\n`,
    );
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(result.verdict).toBe(WRITE_VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.ADK_VERSION_MISMATCH);
    expect((result.summary ?? []).join(" ")).toContain("dynamic");
    expect(posts).toEqual([]);
  });

  test("(k) a quoted `version` key is READ (valid TOML): tomllib reads it as the project version", () => {
    // Round 4: the hand-written parser called a quoted key unsupported; tomllib
    // (what PyPI's publish workflow uses) reads it. The value is the version.
    const r = readProjectVersion(`[project]\nname = "adk-flair"\n"version" = "${VERSION}"\n`);
    expect(r.kind).toBe("version"); // assertion: a quoted key is read, not refused
    expect(r.kind === "version" ? r.version : null).toBe(VERSION);
  });

  test("(l) a version line after a [project.x] sub-table is NOT read (no [project].version → mismatch)", async () => {
    const posts: string[] = [];
    const tags = new Map<string, unknown>();
    const { deps } = harness({ api: refApi(posts, tags) });
    pinPyproject(
      deps,
      `[project]\nname = "adk-flair"\n[project.urls]\nhomepage = "https://example.invalid"\nversion = "${VERSION}"\n`,
    );
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(result.verdict).toBe(WRITE_VERDICT.REFUSE);
    expect(result.condition).toBe(CONDITION.ADK_VERSION_MISMATCH);
    expect(posts).toEqual([]);
  });

  test("(m) the writer refuses a file it cannot line-rewrite (a quoted key), but still READS it", () => {
    // Round 4: the value is readable (tomllib), but there is no bare
    // `version = "…"` line to rewrite, so the writer returns null.
    expect(replaceProjectVersion(`[project]\n"version" = "1.0.0"\n`, "2.0.0")).toBeNull();
    expect(readProjectVersion(`[project]\n"version" = "1.0.0"\n`).kind).toBe("version");
  });

  test("(n) decide: v at <sha>, pyproject equal, adk absent → TAG with v_verdict=SKIP (unfinished)", async () => {
    const tags = new Map<string, unknown>([[`v${VERSION}`, { object: { type: "commit", sha: SHA } }]]);
    const { deps } = harness({
      api: { readTagRef: async (t: string) => tags.get(t) ?? null },
      files: { [`${SHA}:${ADK_PYPROJECT_PATH}`]: pyproject(VERSION) },
    });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.TAG);
    expect(result.vVerdict).toBe(WRITE_VERDICT.SKIP);
  });

  test("(o) decide: BOTH tags at <sha> → SKIP (completed; no write job starts)", async () => {
    // Mutation that turns (o) red: make decide return TAG unconditionally (drop
    // the adkWorkAfterVAtSha `skip` branch) — then this asserts SKIP and fails.
    const tags = new Map<string, unknown>([
      [`v${VERSION}`, { object: { type: "commit", sha: SHA } }],
      [`adk-flair-v${VERSION}`, { object: { type: "commit", sha: SHA } }],
    ]);
    const { deps } = harness({
      api: { readTagRef: async (t: string) => tags.get(t) ?? null },
      files: { [`${SHA}:${ADK_PYPROJECT_PATH}`]: pyproject(VERSION) },
    });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.SKIP);
  });

  test("(n2) a LATER decide refusal (superseded) still carries vVerdict=SKIP when v is at the sha", async () => {
    const tags = new Map<string, unknown>([[`v${VERSION}`, { object: { type: "commit", sha: SHA } }]]);
    const { deps } = harness({
      api: { readTagRef: async (t: string) => tags.get(t) ?? null },
      files: { [`${SHA}:${ADK_PYPROJECT_PATH}`]: pyproject(VERSION) },
      versions: { "origin/main": manifest("0.58.0") },
    });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE); // assertion A
    expect(result.condition).toBe(CONDITION.SUPERSEDED);
    expect(result.vVerdict).toBe(WRITE_VERDICT.SKIP); // assertion B: never REFUSE for an existing ref
  });

  test("reporter: decide refuses an adk conflict with v already at the sha, carrying v_verdict=SKIP", async () => {
    const tags = new Map<string, unknown>([
      [`v${VERSION}`, { object: { type: "commit", sha: SHA } }],
      [`adk-flair-v${VERSION}`, { object: { type: "commit", sha: HEAD } }],
    ]);
    const { deps } = harness({
      api: { readTagRef: async (t: string) => tags.get(t) ?? null },
      files: { [`${SHA}:${ADK_PYPROJECT_PATH}`]: pyproject(VERSION) },
    });
    const result = await decide({ sha: SHA, deps });
    expect(result.verdict).toBe(VERDICT.REFUSE);
    expect(result.adkCondition).toBe(CONDITION.ADK_TAG_EXISTS_ELSEWHERE);
    // The v ref EXISTS at <sha>, so its output is SKIP — never REFUSE.
    expect(result.vVerdict).toBe(WRITE_VERDICT.SKIP);
  });

  // ── round 4: the reader is Python's tomllib (p)-(x) ────────────────────────

  test("(p) a multi-line description containing a version line does NOT fool the reader → REFUSE, zero POSTs", async () => {
    // Mutation that turns (p) red: point the reader back at the JS parser — it
    // reads the `version = "0.57.0"` line INSIDE the description and returns TAG.
    const posts: string[] = [];
    const tags = new Map<string, unknown>();
    const { deps } = harness({ api: refApi(posts, tags) });
    pinPyproject(
      deps,
      `[project]\nname = "adk-flair"\nversion = "0.55.2"\ndescription = """\nversion = "${VERSION}"\n"""\n`,
    );
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(result.verdict).toBe(WRITE_VERDICT.REFUSE); // assertion A: REFUSE
    expect(result.condition).toBe(CONDITION.ADK_VERSION_MISMATCH);
    expect((result.summary ?? []).join(" ")).toContain("0.55.2"); // assertion B: the PROJECT version
    expect(posts).toEqual([]); // assertion C: zero POSTs
  });

  test("(q) a multi-line ARRAY containing a version line does NOT fool the reader → REFUSE, zero POSTs", async () => {
    const posts: string[] = [];
    const tags = new Map<string, unknown>();
    const { deps } = harness({ api: refApi(posts, tags) });
    pinPyproject(
      deps,
      `[project]\nname = "adk-flair"\nversion = "0.55.2"\nkeywords = [\n  """\nversion = "${VERSION}"\n""",\n]\n`,
    );
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(result.verdict).toBe(WRITE_VERDICT.REFUSE); // assertion A: REFUSE
    expect(result.condition).toBe(CONDITION.ADK_VERSION_MISMATCH);
    expect(posts).toEqual([]); // assertion B: zero POSTs
  });

  test("(r) a version line after [project.\"urls#alternate\"] is NOT read → mismatch", async () => {
    const posts: string[] = [];
    const tags = new Map<string, unknown>();
    const { deps } = harness({ api: refApi(posts, tags) });
    pinPyproject(
      deps,
      `[project]\nname = "adk-flair"\n[project."urls#alternate"]\nhomepage = "https://example.invalid"\nversion = "${VERSION}"\n`,
    );
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(result.verdict).toBe(WRITE_VERDICT.REFUSE); // assertion: not read → REFUSE
    expect(result.condition).toBe(CONDITION.ADK_VERSION_MISMATCH);
    expect(posts).toEqual([]);
  });

  test("(s) [[project]] → unsupported (project is not a table)", async () => {
    const posts: string[] = [];
    const tags = new Map<string, unknown>();
    const { deps } = harness({ api: refApi(posts, tags) });
    pinPyproject(deps, `[[project]]\nname = "adk-flair"\nversion = "${VERSION}"\n`);
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(result.verdict).toBe(WRITE_VERDICT.REFUSE); // assertion: REFUSE
    expect(result.condition).toBe(CONDITION.ADK_PYPROJECT_UNSUPPORTED);
    expect(posts).toEqual([]);
  });

  test("(t) a multi-line dynamic = [ \\n \"version\", \\n ] → none/dynamic → mismatch", async () => {
    const posts: string[] = [];
    const tags = new Map<string, unknown>();
    const { deps } = harness({ api: refApi(posts, tags) });
    pinPyproject(deps, `[project]\nname = "adk-flair"\ndynamic = [\n  "version",\n]\n`);
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(result.verdict).toBe(WRITE_VERDICT.REFUSE); // assertion: dynamic is NONE → REFUSE
    expect(result.condition).toBe(CONDITION.ADK_VERSION_MISMATCH);
    expect((result.summary ?? []).join(" ")).toContain("dynamic");
    expect(posts).toEqual([]);
  });

  test("(u) a single-quoted 'version' key IS valid TOML: tomllib reads the value", () => {
    const r = readProjectVersion(`[project]\nname = "adk-flair"\n'version' = "1.2.3"\n`);
    expect(r.kind).toBe("version"); // assertion: read, not refused
    expect(r.kind === "version" ? r.version : null).toBe("1.2.3");
  });

  test("(v) python3 absent (PATH points at an empty dir) → unsupported, and the tagger REFUSES", () => {
    // Run in a CHILD process with PATH emptied: bun caches its own command
    // resolution, so mutating this process's PATH would not hide `python3`.
    const mod = resolve(import.meta.dir, "../../scripts/ci/pyproject-version.mjs");
    const code = [
      `import { readProjectVersion } from ${JSON.stringify(mod)};`,
      `console.log(readProjectVersion('[project]\\nversion = "1.0.0"\\n').kind);`,
    ].join("\n");
    const run = spawnSync(process.execPath, ["-e", code], {
      env: { ...process.env, PATH: scratchDir() },
      encoding: "utf8",
    });
    expect(String(run.stdout ?? "").trim()).toBe("unsupported"); // assertion: fail closed
    // The tagger maps unsupported → REFUSE adk-pyproject-unsupported (a
    // tomllib-invalid shape stands in for the no-python case here).
    const c = adkVersionCheck(`[[project]]\nname = "adk-flair"\nversion = "1.0.0"\n`, VERSION);
    expect(c.kind === "refuse" ? c.condition : null).toBe(CONDITION.ADK_PYPROJECT_UNSUPPORTED);
  });

  test("(w) the writer refuses a case the locator accepts but tomllib reads differently", () => {
    // The locator finds a bare `version = "..."` line INSIDE the multi-line
    // description (lineIndex >= 0), but tomllib reads project.version as 1.0.0;
    // rewriting the description would change the document, so the tomllib
    // comparison refuses (null) and the file is left byte-identical.
    const src = `[project]\nname = "adk-flair"\ndescription = """\nversion = "0.55.2"\n"""\nversion = "1.0.0"\n`;
    const rv = readProjectVersion(src);
    expect(rv.kind).toBe("version"); // assertion: tomllib reads 1.0.0
    expect(rv.kind === "version" ? rv.lineIndex : -1).toBeGreaterThanOrEqual(0); // assertion: the locator accepts a line
    const file = join(scratchDir(), "pyproject.toml");
    writeFileSync(file, src);
    const next = replaceProjectVersion(readFileSync(file, "utf8"), "2.0.0");
    expect(next).toBeNull(); // assertion: the tomllib comparison refuses
    if (next !== null) writeFileSync(file, next);
    expect(readFileSync(file, "utf8")).toBe(src); // assertion: byte-identical
  });

  test("(x) the writer preserves CRLF line endings", () => {
    const next = replaceProjectVersion(`[project]\r\nname = "adk-flair"\r\nversion = "1.0.0"\r\n`, "2.0.0");
    expect(next).toBe(`[project]\r\nname = "adk-flair"\r\nversion = "2.0.0"\r\n`); // assertion: CRLF preserved
    expect(next?.includes("\r\n")).toBe(true);
  });

  test("(x2) a MIXED CRLF/LF file: only the version bytes differ", () => {
    const src = `[project]\r\nname = "adk-flair"\nversion = "1.0.0"\r\n`;
    const next = replaceProjectVersion(src, "2.0.0");
    // assertion: the mixed endings are preserved exactly
    expect(next).toBe(`[project]\r\nname = "adk-flair"\nversion = "2.0.0"\r\n`);
    // assertion: no byte OUTSIDE the version span changed
    expect(next?.replace('"2.0.0"', '"1.0.0"')).toBe(src);
  });

  test("(y) dynamic = [version] PLUS a static version line → REFUSE adk-version-mismatch (dynamic wins), zero POSTs", async () => {
    const posts: string[] = [];
    const tags = new Map<string, unknown>();
    const { deps } = harness({ api: refApi(posts, tags) });
    pinPyproject(deps, `[project]\nname = "adk-flair"\ndynamic = ["version"]\nversion = "${VERSION}"\n`);
    const result = await writeTag({ sha: SHA, version: VERSION, deps, options: appOptions });
    expect(result.verdict).toBe(WRITE_VERDICT.REFUSE); // assertion A: REFUSE, not TAG
    expect(result.condition).toBe(CONDITION.ADK_VERSION_MISMATCH);
    expect((result.summary ?? []).join(" ")).toContain("dynamic"); // assertion B: names dynamic
    expect(posts).toEqual([]); // assertion C: zero POSTs
  });

  /** A stub executable the reader is pointed at (the pythonBin seam). */
  function stub(body: string): string {
    const p = join(scratchDir(), "stub.sh");
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  }

  test("(z1) a zero exit WITH stderr noise is unsupported (stderr: …)", () => {
    const bin = stub(
      "cat >/dev/null\nprintf '%s' '{\"version\": \"1.0.0\"}'\nprintf '%s\\n' 'sitecustomize noise' >&2\nexit 0",
    );
    const r = readProjectVersion(`[project]\nversion = "1.0.0"\n`, { pythonBin: bin });
    expect(r.kind).toBe("unsupported"); // assertion: noise on stderr is not trusted
    expect(r.kind === "unsupported" ? r.reason : "").toBe("stderr: sitecustomize noise");
  });

  test("(z2) a JSON `null` response is unsupported 'bad response', no throw", () => {
    const bin = stub("cat >/dev/null\nprintf '%s' 'null'\nexit 0");
    const r = readProjectVersion(`[project]\nversion = "1.0.0"\n`, { pythonBin: bin });
    expect(r.kind).toBe("unsupported"); // assertion: shape validated
    expect(r.kind === "unsupported" ? r.reason : "").toBe("bad response");
  });

  test("(z3) a stub that sleeps past the timeout is unsupported 'timeout'", () => {
    const bin = stub("cat >/dev/null\nsleep 5\nprintf '%s' '{\"version\": \"1.0.0\"}'");
    const r = readProjectVersion(`[project]\nversion = "1.0.0"\n`, { pythonBin: bin, timeoutMs: 300 });
    expect(r.kind).toBe("unsupported"); // assertion: a hung reader is unsupported
    expect(r.kind === "unsupported" ? r.reason : "").toBe("timeout");
  });

  test("round 5, item 4: --write is ALL-OR-NOTHING (a refusing pyproject writes NOTHING)", () => {
    const root = scratchDir();
    mkdirSync(join(root, "packages/flair-bench/src"), { recursive: true });
    mkdirSync(join(root, "packages/adk-flair"), { recursive: true });
    const bench = join(root, "packages/flair-bench/src/version.ts");
    const py = join(root, "packages/adk-flair/pyproject.toml");
    writeFileSync(bench, 'export const TOOL_VERSION = "1.0.0";\n');
    writeFileSync(py, `[project]\nname = "adk-flair"\nversion = """1.0.0"""\n`); // the writer refuses this
    const before = { bench: readFileSync(bench, "utf8"), py: readFileSync(py, "utf8") };
    const realRoot = resolve(import.meta.dir, "../..");
    const checker = join(realRoot, "scripts", "check-version-sync.mjs");
    const r = spawnSync(process.execPath, [checker, "--write", "2.0.0", "--root", root], { encoding: "utf8" });
    expect(r.status).not.toBe(0); // assertion: the refusal exits non-zero
    expect(readFileSync(bench, "utf8")).toBe(before.bench); // assertion: flair-bench NOT written
    expect(readFileSync(py, "utf8")).toBe(before.py); // assertion: pyproject NOT written
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
    // 253 `git` subprocesses: ~1.2s here and ~1.8s on CI, but a CI run on
    // 2026-09-25 took 5.7s and hit bun's 5s per-test default, turning a working
    // walk into a red lane. The work is subprocess-bound, so this test carries
    // its own (generous) deadline rather than the default.
  }, 30_000);

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
