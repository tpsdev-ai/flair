#!/usr/bin/env node
/**
 * release-auto-tag — decide whether a commit that landed on `main` is a release
 * to tag, and (only at the write boundary) create that tag with a GitHub App
 * token.
 *
 * PROBLEM. Cutting a release ends with a human pushing `vX.Y.Z` by hand. The
 * release PR merges green, `release-publish.yml` is ready to stage from the tag,
 * and then nothing happens until someone remembers. A release can sit green with
 * nobody looking — that is the failure this script exists to close.
 *
 * SHAPE. `decide` runs conditions 1-9 against a commit and prints exactly one of
 *   TAG vX.Y.Z <sha>      a release, tag it
 *   SKIP <reason>         not a release, nothing to do, silent
 *   REFUSE <condition-id> looks like a release but a condition failed
 * and ALWAYS exits 0, after writing the verdict to the step output. A following
 * step in the same job turns the job red on REFUSE, so the verdict is always
 * produced by a step that SUCCEEDED and a dependent job can read it. Condition
 * ids come from the fixed enum below, never free text; SKIP's reason is prose.
 *
 * TWO JOBS, NOT ONE (round 2, item 1). `decide` (conditions 1-9) is the only
 * place candidate code runs; `tag` runs in a SEPARATE job on a fresh runner with
 * a fresh default-branch checkout, holding the App credential. The job boundary —
 * not a tree restore — is what isolates the credential from candidate code: a
 * merged commit can plant a git hook or re-point `.git`, and restoring the
 * working tree never covered that. Every checkout sets `persist-credentials:
 * false`.
 *
 * `tag` is the write boundary: it re-runs conditions 3, 4 and 8 (tag state,
 * release intent, both reviews) immediately before the POST, then creates
 * `refs/tags/v<version>` at `<sha>` and reads it back. Runs are serialized by the
 * workflow's `concurrency: release-auto-tag` (no cancel), so two taggers never
 * interleave; the residual window between the re-check and the POST is one API
 * round trip, and the atomic POST still refuses a duplicate tag.
 *
 * EVERYTHING THAT TALKS TO GITHUB IS A DEPENDENCY (see createDeps): the API
 * client, local git reads, the `<sha>` version-sync execution, the clock and
 * sleep. That is what makes every branch unit-testable with fixtures — including
 * the two INVARIANTS the checkout discipline rests on:
 *   - a `<sha>` that is not an ancestor of main never reaches the script
 *     execution in condition 6 (condition 5 runs first; asserted by a spy);
 *   - the decision step holds no App token (that is a property of the workflow,
 *     asserted by test/unit/release-auto-tag-workflow.test.ts).
 *
 * CONTRACT. src = docs? See issue #1890. This file implements it as written:
 * do not add conditions, do not reorder them, do not let a PR-derived string
 * reach a shell or the reporter outside the three validated values.
 *
 * Usage:
 *   node scripts/release-auto-tag.mjs decide --repo <owner/name> [--sha <sha> | --nightly]
 *        [--output <file>] [--self-run-id <id>] [--advisory-allowlist <path>]
 *        [--deadline-minutes <n>] [--version-file <path>] [--main-ref <ref>]
 *        [--workflow-path <path>] [--workflow-name <name>] [--reviewers a,b]
 *   node scripts/release-auto-tag.mjs tag --repo <owner/name> --sha <sha> --version <vX.Y.Z>
 *        [--output <file>] [--version-file <path>] [--main-ref <ref>]
 *        [--advisory-allowlist <path>] [--reviewers a,b]
 *
 * Environment: GH_TOKEN (read) for `decide`; the App token for `tag`.
 */

import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

// ── the fixed enum ─────────────────────────────────────────────────────────────
// Condition ids are an enum so the reporter, the summary and any test can switch
// on them. `ci-renamed` and `checks-pending` are the two that the issue lists as
// prose rather than as a bare id; they are ids here so nothing free-forms.
export const CONDITION = Object.freeze({
  VERSION_SHAPE: "version-shape",
  NOT_MAIN_ANCESTOR: "not-main-ancestor",
  SUPERSEDED: "superseded",
  VERSION_SYNC: "version-sync",
  NO_RELEASE_PR: "no-release-pr",
  REVIEWS: "reviews",
  TAG_CONFLICT: "tag-conflict",
  CHECKS_FAILED: "checks-failed",
  CHECKS_PENDING: "checks-pending",
  // Not one of the ten numbered conditions either: the commit carries no check
  // runs at all, or none of them belongs to the CI workflow's check suite. An
  // empty list is NOT "all checks green" — a commit CI never ran on must never
  // tag itself just because there is nothing to contradict it (round 2, item 3).
  CHECKS_MISSING: "checks-missing",
  CI_RENAMED: "ci-renamed",
  // The nightly could not find, in the version file's own git history, the
  // commit that introduced the version main's HEAD declares. Refused LOUDLY
  // rather than skipped: a silent SKIP is how a missed release disappears
  // (round 2, item 4).
  VERSION_ORIGIN_NOT_FOUND: "version-origin-not-found",
  // Not one of the ten conditions: the App is installed AFTER this lands, so the
  // write step must refuse loudly rather than proceed unauthenticated.
  APP_NOT_CONFIGURED: "app-not-configured",
});
export const CONDITION_IDS = Object.freeze(Object.values(CONDITION));

export const VERDICT = Object.freeze({ TAG: "TAG", SKIP: "SKIP", REFUSE: "REFUSE" });
export const WRITE_VERDICT = Object.freeze({ TAGGED: "TAGGED", SKIP: "SKIP", REFUSE: "REFUSE" });

export const VERSION_SHAPE = /^\d+\.\d+\.\d+$/;
export const CONCLUSION_WHITELIST = Object.freeze(["success", "neutral", "skipped"]);
export const DEFAULT_REVIEWERS = Object.freeze(["tps-kern", "tps-sherlock"]);
export const DEFAULT_VERSION_FILE = "package.json";
export const DEFAULT_WORKFLOW_PATH = ".github/workflows/test.yml";
export const DEFAULT_WORKFLOW_NAME = "CI";
export const DEFAULT_ADVISORY_ALLOWLIST = ".github/release-auto-tag-advisories.json";
export const DEFAULT_POLL_SECONDS = 60;
// Measured before this landed, 2026-09-25; the workflow comment carries the
// measurement. 30 min = the 24.37 min P95 of the slowest workflow on main (this
// repo's CI) rounded up with ~5 min of margin.
export const DEFAULT_DEADLINE_MINUTES = 30;
export const INVALID_VERSION = "invalid";

// ── helpers ────────────────────────────────────────────────────────────────────

/** Semver compare for `\d+.\d+.\d+`. Returns >0 when `a` is newer than `b`. */
export function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/** The version declared in a `package.json` text, or null when unreadable. */
export function readVersionFromManifest(text) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/** Parse `.github/release-auto-tag-advisories.json` into a Set of exact names. */
export function parseAdvisoryAllowlist(text) {
  const parsed = JSON.parse(text);
  const allow = parsed?.allow;
  if (!Array.isArray(allow) || allow.some((n) => typeof n !== "string")) {
    throw new Error("advisory allowlist must be an object with an `allow` array of strings");
  }
  return new Set(allow);
}

class ApiError extends Error {
  constructor(message, status, path) {
    super(message);
    this.status = status;
    this.path = path;
  }
}

// ── the injectable GitHub client ───────────────────────────────────────────────
// Semantic methods, one per read the decision needs, so a test fixture is a map
// of method -> value and no test ever asserts on a URL. The default transport is
// fetch + a token; nothing here is imported by the decision logic directly.

export function createClient({ repo, token, fetchImpl = globalThis.fetch, apiBase = "https://api.github.com" }) {
  if (!repo) throw new Error("createClient needs a repo (owner/name)");

  async function call(method, path, body) {
    const res = await fetchImpl(`${apiBase}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return res;
  }

  async function getJson(path) {
    const res = await call("GET", path);
    if (res.status === 404) return null;
    if (!res.ok) throw new ApiError(`GET ${path} -> ${res.status}`, res.status, path);
    return res.json();
  }

  /**
   * Follow `Link: rel="next"` so a paginated read never truncates. `pick`
   * unwraps endpoints that answer with an object envelope instead of an array.
   */
  async function getPaged(basePath, pick = (page) => page) {
    const out = [];
    let path = basePath;
    for (let i = 0; i < 50 && path; i++) {
      const res = await call("GET", path);
      if (res.status === 404) return out;
      if (!res.ok) throw new ApiError(`GET ${path} -> ${res.status}`, res.status, path);
      const page = pick(await res.json());
      if (Array.isArray(page)) out.push(...page);
      path = nextLink(res.headers?.get?.("link") ?? null);
    }
    return out;
  }

  return {
    repo,
    getJson,
    getPaged,
    /** `git/ref/tags/<tag>` — null when the ref does not exist. */
    async readTagRef(tag) {
      return getJson(`/repos/${repo}/git/ref/tags/${tag}`);
    },
    /** `git/tags/<sha>` — the object an annotated tag points at. */
    async readTagObject(sha) {
      return getJson(`/repos/${repo}/git/tags/${sha}`);
    },
    /** Every `v*` tag ref, paginated. */
    async listVersionTags() {
      return getPaged(`/repos/${repo}/git/matching-refs/tags/v`);
    },
    /** `commits/<sha>/pulls` — the PRs associated with a commit. */
    async listPullsForCommit(sha) {
      return getPaged(`/repos/${repo}/commits/${sha}/pulls`);
    },
    /** `pulls/<n>/reviews`, paginated. */
    async listReviews(prNumber) {
      return getPaged(`/repos/${repo}/pulls/${prNumber}/reviews?per_page=100`);
    },
    /**
     * `commits/<sha>/check-runs` — latest runs only. This endpoint answers with an
     * OBJECT (`{ total_count, check_runs }`), not an array: unwrap it, or every
     * decision sees zero check runs and cheerfully tags a commit with failing CI.
     */
    async listCheckRuns(sha) {
      return getPaged(`/repos/${repo}/commits/${sha}/check-runs?per_page=100&filter=latest`, (page) => page?.check_runs);
    },
    /** `actions/workflows/<file>` — the workflow's own name, for the CI check.
     * The API wants the FILE name (test.yml), not the path.
     */
    async readWorkflowMeta(fileName) {
      return getJson(`/repos/${repo}/actions/workflows/${fileName}`);
    },
    /** `actions/runs/<id>` — used for this run's own check suite id. */
    async readWorkflowRun(runId) {
      return getJson(`/repos/${repo}/actions/runs/${runId}`);
    },
    /**
     * `actions/workflows/<file>/runs?head_sha=<sha>&status=completed` — the
     * completed runs of the `CI` workflow for one commit. Each run carries the
     * `check_suite_id` whose check runs appear under `commits/<sha>/check-runs`,
     * which is how condition 9 proves CI actually ran on this commit rather than
     * trusting an empty list (round 2, item 3).
     */
    async listCompletedWorkflowRunsForSha(fileName, sha) {
      return getPaged(
        `/repos/${repo}/actions/workflows/${fileName}/runs?head_sha=${sha}&status=completed&per_page=100`,
        (page) => page?.workflow_runs,
      );
    },
    /** POST `git/refs` — the write boundary. Never retried: the POST is the race-breaker. */
    async createTagRef(ref, sha) {
      const res = await call("POST", `/repos/${repo}/git/refs`, { ref, sha });
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { ok: res.ok, status: res.status, body };
    },
  };
}

function nextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) {
      // Strip only the ORIGIN. The path — including its /repos/<owner>/<name>
      // prefix — must survive: dropping it 404s the next request, and `getPaged`
      // treats a 404 as the end of the list, so page 2 onward would vanish.
      const url = new URL(m[1]);
      return `${url.pathname}${url.search}`;
    }
  }
  return null;
}

// ── dependencies (git, clock, allowlist reader, version-sync runner) ───────────

export function createDeps({ overrides = {}, root = process.cwd(), log, api } = {}) {
  const logFn = log ?? { info: () => {}, warn: () => {} };
  const deps = {
    api: api ?? null,
    log: logFn,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    readTextFile: (path) => {
      if (!existsSync(path)) throw new Error(`missing file: ${path}`);
      return readFileSync(path, "utf8");
    },
    git: {
      /** `git show <rev>:<path>` — null when the path is absent at that revision. */
      show(rev, path) {
        const r = spawnSync("git", ["show", `${rev}:${path}`], { cwd: root, encoding: "utf8" });
        return r.status === 0 ? r.stdout : null;
      },
      /** true when <sha> is an ancestor of <ref>. Throws when the ref is unknown. */
      isAncestor(sha, ref) {
        const known = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: root, encoding: "utf8" });
        if (known.status !== 0) throw new Error(`git cannot resolve ${ref}`);
        const r = spawnSync("git", ["merge-base", "--is-ancestor", sha, ref], { cwd: root });
        if (r.status === 0) return true;
        if (r.status === 1) return false;
        throw new Error(`git merge-base --is-ancestor ${sha} ${ref} failed (exit ${r.status})`);
      },
      /** `git rev-parse <ref>` as a full sha. */
      revParse(ref) {
        const r = spawnSync("git", ["rev-parse", ref], { cwd: root, encoding: "utf8" });
        if (r.status !== 0) throw new Error(`git rev-parse ${ref} failed`);
        return r.stdout.trim();
      },
      /**
       * `git log --format=%H <rev> -- <path>` — the commits that touched <path>,
       * newest first. The nightly walks THIS (round 2, item 4) rather than a
       * fixed number of commits: only file-touching commits are listed, so the
       * version change is found however far back it is.
       */
      logFileHistory(rev, path) {
        const r = spawnSync("git", ["log", "--format=%H", rev, "--", path], { cwd: root, encoding: "utf8" });
        if (r.status !== 0) throw new Error(`git log ${rev} -- ${path} failed`);
        return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      },
    },
    /**
     * Condition 6: run `<sha>`'s OWN version-sync script, from a detached
     * worktree of `<sha>`. This is the one place `<sha>`'s code executes, and it
     * runs in the decide step — never next to the App token. Injectable so a test
     * can assert it is NOT reached for a non-ancestor.
     */
    runVersionSync(sha, version) {
      const tmp = mkdtempSync(join(tmpdir(), "release-auto-tag-"));
      try {
        const add = spawnSync("git", ["worktree", "add", "--detach", tmp, sha], { cwd: root, encoding: "utf8" });
        if (add.status !== 0) {
          throw new Error(`cannot check out ${sha} for version-sync: ${add.stderr?.trim() || add.status}`);
        }
        const script = join(tmp, "scripts", "check-version-sync.mjs");
        if (!existsSync(script)) {
          return { ok: false, code: 127, output: `scripts/check-version-sync.mjs is not present at ${sha}` };
        }
        const r = spawnSync(process.execPath, [script, version], { cwd: tmp, encoding: "utf8" });
        return { ok: r.status === 0, code: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
      } finally {
        spawnSync("git", ["worktree", "remove", "--force", tmp], { cwd: root, encoding: "utf8" });
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  };
  return { ...deps, ...overrides };
}

// ── conditions ─────────────────────────────────────────────────────────────────

/** Resolve a tag ref to a commit, following annotated tag objects. */
export async function resolveTagCommit(api, ref) {
  let cursor = { type: ref?.object?.type, sha: ref?.object?.sha };
  for (let i = 0; i < 20; i++) {
    if (cursor.type === "commit") return cursor.sha;
    if (cursor.type !== "tag") return null; // a non-commit, non-tag object: unknown
    const obj = await api.readTagObject(cursor.sha);
    if (!obj) return null;
    cursor = { type: obj.object?.type, sha: obj.object?.sha };
  }
  throw new Error("annotated tag chain deeper than 20 — refusing to guess");
}

export function versionAt(deps, rev, versionFile) {
  return readVersionFromManifest(deps.git.show(rev, versionFile));
}

/** Condition 1: the version at <sha> differs from <sha>^. */
export function conditionReleaseCommit(deps, { sha, versionFile }) {
  const version = versionAt(deps, sha, versionFile);
  if (!version) return { ok: false, skip: true, reason: `no version in ${versionFile} at ${sha}` };
  const parentText = deps.git.show(`${sha}^`, versionFile);
  if (parentText === null) return { ok: false, skip: true, reason: `no parent commit for ${sha}` };
  const parentVersion = readVersionFromManifest(parentText);
  if (parentVersion === version) return { ok: false, skip: true, reason: "not a release commit" };
  return { ok: true, version };
}

/** Condition 2: the new version is `\d+.\d+.\d+`. */
export function conditionVersionShape(version) {
  if (!VERSION_SHAPE.test(version)) return { ok: false, condition: CONDITION.VERSION_SHAPE, version: INVALID_VERSION };
  return { ok: true, version };
}

/** Condition 3: tag state. SKIP when the tag already points at <sha>. */
export async function conditionTagState(api, { sha, version }) {
  const ref = await api.readTagRef(`v${version}`);
  if (!ref) return { ok: true };
  const commit = await resolveTagCommit(api, ref);
  if (commit === sha) return { ok: false, skip: true, reason: "already tagged at this commit" };
  return {
    ok: false,
    condition: CONDITION.TAG_CONFLICT,
    summary: [`tag v${version} exists and resolves to ${commit ?? "an unresolvable object"}, not ${sha}`],
  };
}

/** Condition 4: this is the CURRENT release, not a superseded one. */
export async function conditionReleaseIntent(api, deps, { version, versionFile, mainRef }) {
  const headVersion = readVersionFromManifest(deps.git.show(mainRef, versionFile));
  if (!headVersion) {
    throw new Error(`${mainRef} declares no version in ${versionFile}`);
  }
  if (headVersion !== version) {
    return {
      ok: false,
      condition: CONDITION.SUPERSEDED,
      summary: [`main declares ${headVersion}; this commit releases ${version}`],
    };
  }
  const tags = await api.listVersionTags();
  const higher = [];
  for (const tag of tags) {
    const name = String(tag?.ref ?? "").replace("refs/tags/", "");
    const candidate = name.replace(/^v/, "");
    if (!VERSION_SHAPE.test(candidate)) continue;
    if (compareVersions(candidate, version) > 0) higher.push(name);
  }
  if (higher.length) {
    return {
      ok: false,
      condition: CONDITION.SUPERSEDED,
      summary: [`a newer release tag exists: ${higher.sort().join(", ")}`],
    };
  }
  return { ok: true };
}

/** Condition 5: <sha> is an ancestor of the real main. */
export function conditionMainAncestor(deps, { sha, mainRef }) {
  if (!deps.git.isAncestor(sha, mainRef)) {
    return {
      ok: false,
      condition: CONDITION.NOT_MAIN_ANCESTOR,
      summary: [`${sha} is not an ancestor of ${mainRef}`],
    };
  }
  return { ok: true };
}

/** Condition 6: <sha>'s own version-sync check passes. */
export async function conditionVersionSync(deps, { sha, version }) {
  const r = await deps.runVersionSync(sha, version);
  if (!r?.ok) {
    return {
      ok: false,
      condition: CONDITION.VERSION_SYNC,
      summary: [`<sha>'s scripts/check-version-sync.mjs ${version} exited ${r?.code}`, (r?.output ?? "").split("\n").slice(0, 5).join(" / ")].filter(Boolean),
    };
  }
  return { ok: true };
}

/** Condition 7: exactly one merged release PR, squashed onto <sha>. */
export async function conditionReleasePr(api, { sha, version, repo }) {
  const prs = await api.listPullsForCommit(sha);
  const matches = (prs ?? []).filter(
    (pr) =>
      pr?.merged_at &&
      pr?.merge_commit_sha === sha &&
      pr?.base?.ref === "main" &&
      pr?.head?.ref === `release/v${version}` &&
      pr?.head?.repo?.full_name === repo,
  );
  if (matches.length !== 1) {
    return {
      ok: false,
      condition: CONDITION.NO_RELEASE_PR,
      summary: [
        matches.length === 0
          ? `no merged release/v${version} PR with merge_commit_sha ${sha} (${(prs ?? []).length} association(s) returned)`
          : `${matches.length} PRs match merge_commit_sha ${sha} and head release/v${version}`,
      ],
    };
  }
  return { ok: true, pr: matches[0] };
}

/** Condition 8: both reviewers' LATEST review on the PR's final head is APPROVED. */
export async function conditionReviews(api, { pr, reviewers }) {
  const reviews = await api.listReviews(pr.number);
  const onHead = (reviews ?? []).filter((r) => r?.commit_id === pr?.head?.sha);
  const latest = new Map();
  for (const r of onHead) {
    const login = r?.user?.login;
    if (!login) continue;
    const prev = latest.get(login);
    if (!prev || String(r.submitted_at ?? "") >= String(prev.submitted_at ?? "")) latest.set(login, r);
  }
  const missing = [];
  for (const login of reviewers) {
    const review = latest.get(login);
    if (!review) missing.push(`${login} did not review ${pr.head?.sha}`);
    else if (review.state !== "APPROVED") missing.push(`${login}'s latest review on ${pr.head?.sha} is ${review.state}`);
  }
  if (missing.length) return { ok: false, condition: CONDITION.REVIEWS, summary: missing };
  return { ok: true, pr };
}

/**
 * Condition 9: every check run on <sha> completed on a whitelisted conclusion,
 * except allowlisted names. Polls every `pollMs` until `deadlineMs`, then REFUSE
 * `checks-pending`. This workflow's OWN check runs are excluded by check suite
 * id: without that exclusion the job waits on itself whenever the release merge
 * is still main's HEAD, which is the common case.
 */
export async function conditionChecks(deps, { sha, selfCheckSuiteId, allowlist, deadlineMs, pollMs, ciCheckSuiteIds = null }) {
  const started = deps.now();
  let runs = [];
  for (;;) {
    runs = (await deps.api.listCheckRuns(sha)).filter((r) => r?.check_suite?.id !== selfCheckSuiteId);
    const pending = runs.filter((r) => r?.status !== "completed");
    if (!pending.length) break;
    if (deps.now() - started >= deadlineMs) {
      return {
        ok: false,
        condition: CONDITION.CHECKS_PENDING,
        summary: [
          `${pending.length} check run(s) still not completed after ${Math.round((deps.now() - started) / 60000)} min: ${pending.map((r) => r?.name).join(", ")}`,
        ],
        waitedMs: deps.now() - started,
      };
    }
    deps.log.info(`release-auto-tag: ${pending.length} check run(s) pending; polling again in ${Math.round(pollMs / 1000)}s`);
    await deps.sleep(pollMs);
  }

  // round 2, item 3. An EMPTY list is not "all checks green": a commit CI never
  // ran on has nothing to contradict the whitelist, so `filter=latest` alone
  // would let it tag itself. Required: at least one check run, and — when the
  // caller names them — at least one that belongs to the CI workflow's check
  // suite (the suite that woke the tagger, or a completed CI suite on the
  // commit for the nightly). Either miss REFUSEs `checks-missing` rather than
  // passing on an absence of evidence.
  if (!runs.length) {
    return {
      ok: false,
      condition: CONDITION.CHECKS_MISSING,
      summary: [`no check runs on ${sha}: CI never ran on this commit (an empty list is not a green list)`],
      waitedMs: deps.now() - started,
    };
  }
  if (ciCheckSuiteIds !== null) {
    const suiteIds = new Set(ciCheckSuiteIds);
    if (!suiteIds.size) {
      return {
        ok: false,
        condition: CONDITION.CHECKS_MISSING,
        summary: [`no completed CI check suite on ${sha}: CI has not finished on this commit`],
        waitedMs: deps.now() - started,
      };
    }
    if (!runs.some((r) => suiteIds.has(r?.check_suite?.id))) {
      return {
        ok: false,
        condition: CONDITION.CHECKS_MISSING,
        summary: [
          `none of the ${runs.length} check run(s) on ${sha} belongs to the CI workflow's check suite (suite id(s) ${[...suiteIds].join(", ")})`,
        ],
        waitedMs: deps.now() - started,
      };
    }
  }

  const tolerated = [];
  const blocking = [];
  for (const run of runs) {
    if (CONCLUSION_WHITELIST.includes(run?.conclusion)) continue;
    if (allowlist.has(run?.name)) tolerated.push(`${run?.name} (${run?.conclusion})`);
    else blocking.push(`${run?.name} (${run?.conclusion})`);
  }
  if (blocking.length) {
    return { ok: false, condition: CONDITION.CHECKS_FAILED, summary: [`not on the conclusion whitelist: ${blocking.join(", ")}`] };
  }
  return { ok: true, tolerated, waitedMs: deps.now() - started };
}

// ── the decision (conditions 1-9, in order, all required) ──────────────────────

/**
 * Decide on <sha>. Returns a Decision; never throws for a verdict (only for an
 * unreadable input, which is a bug or a broken environment, not a verdict).
 *
 * @param {{sha: string, deps: any, options?: any}} args
 */
export async function decide({ sha, deps, options = {} }) {
  const opts = {
    versionFile: DEFAULT_VERSION_FILE,
    mainRef: "origin/main",
    workflowPath: DEFAULT_WORKFLOW_PATH,
    workflowName: DEFAULT_WORKFLOW_NAME,
    reviewers: DEFAULT_REVIEWERS,
    allowlist: new Set(),
    deadlineMs: DEFAULT_DEADLINE_MINUTES * 60_000,
    pollMs: DEFAULT_POLL_SECONDS * 1000,
    selfCheckSuiteId: null,
    // round 2, item 3: the CI workflow's check-suite id(s) for this commit. A
    // provided array is ENFORCED (empty or non-matching → checks-missing); null
    // leaves only the non-empty-list requirement (a direct unit call).
    ciCheckSuiteIds: null,
    repo: deps?.api?.repo ?? "",
    ...options,
  };
  const summary = [];

  // 1 — release commit
  const step1 = conditionReleaseCommit(deps, { sha, versionFile: opts.versionFile });
  if (!step1.ok) return { verdict: VERDICT.SKIP, condition: "", version: "", reason: step1.reason, summary };

  // 2 — version shape. Only a version that passed this is ever emitted; on this
  // REFUSE the version output is the literal `invalid`.
  const step2 = conditionVersionShape(step1.version);
  if (!step2.ok) {
    return {
      verdict: VERDICT.REFUSE,
      condition: step2.condition,
      version: INVALID_VERSION,
      summary: [`${sha} declares version ${JSON.stringify(step1.version)}, which is not \d+.\d+.\d+`],
    };
  }
  const version = step2.version;

  const refuse = (r, extra = {}) => ({ verdict: VERDICT.REFUSE, condition: r.condition, version, summary: [...summary, ...(r.summary ?? [])], ...extra });
  const skip = (reason, extra = {}) => ({ verdict: VERDICT.SKIP, condition: "", version, reason, summary, ...extra });

  // 3 — tag state, checked FIRST after shape (two API calls instead of waiting on
  // release-publish's own jobs, which attach to the same commit).
  const step3 = await conditionTagState(deps.api, { sha, version });
  if (!step3.ok) return step3.skip ? skip(step3.reason) : refuse(step3);

  // 4 — release intent
  const step4 = await conditionReleaseIntent(deps.api, deps, { version, versionFile: opts.versionFile, mainRef: opts.mainRef });
  if (!step4.ok) return refuse(step4);

  // 5 — main's commit (BEFORE 6, so merged code never runs for a non-ancestor)
  const step5 = conditionMainAncestor(deps, { sha, mainRef: opts.mainRef });
  if (!step5.ok) return refuse(step5);

  // 6 — version sync, running <sha>'s own merged, ruleset-reviewed script
  const step6 = await conditionVersionSync(deps, { sha, version });
  if (!step6.ok) return refuse(step6);

  // 7 — came from a release PR
  const step7 = await conditionReleasePr(deps.api, { sha, version, repo: opts.repo });
  if (!step7.ok) return refuse(step7);

  // 8 — both reviewers approved the PR's final head
  const step8 = await conditionReviews(deps.api, { pr: step7.pr, reviewers: opts.reviewers });
  if (!step8.ok) return refuse(step8);

  // 9 — all checks green (allowlisted exceptions tolerated and listed)
  const step9 = await conditionChecks(deps, {
    sha,
    selfCheckSuiteId: opts.selfCheckSuiteId,
    allowlist: opts.allowlist,
    deadlineMs: opts.deadlineMs,
    pollMs: opts.pollMs,
    ciCheckSuiteIds: opts.ciCheckSuiteIds,
  });
  if (!step9.ok) return refuse(step9);
  if (step9.tolerated?.length) summary.push(`allowlisted non-success checks (do not refuse): ${step9.tolerated.join(", ")}`);

  return { verdict: VERDICT.TAG, condition: "", version, summary, pr: step7.pr };
}

// ── the write boundary (condition 10) ─────────────────────────────────────────

/**
 * Condition 10: re-check tag state (3), release intent (4) and both reviews (8),
 * then POST the lightweight tag and read it back. The re-derivation of the PR is
 * a READ for condition 8's benefit; PR identity itself (condition 7) is stable
 * and is not re-checked.
 */
export async function writeTag({ sha, version, deps, options = {} }) {
  const opts = {
    versionFile: DEFAULT_VERSION_FILE,
    mainRef: "origin/main",
    reviewers: DEFAULT_REVIEWERS,
    repo: deps?.api?.repo ?? "",
    token: "",
    appId: "",
    appKeyPresent: "",
    ...options,
  };
  const summary = [];
  const refuse = (condition, extra = {}) => ({ verdict: WRITE_VERDICT.REFUSE, condition, version, summary, ...extra });

  // The App is installed after this lands: refuse loudly rather than POST unauthenticated.
  const missingBits = [];
  if (!opts.token) missingBits.push("no App token");
  if (!opts.appId) missingBits.push("no App id");
  if (opts.appKeyPresent !== "true") missingBits.push("no App private key");
  if (missingBits.length) {
    return refuse(CONDITION.APP_NOT_CONFIGURED, {
      summary: [...summary, `the release-tag GitHub App is not configured for this run: ${missingBits.join(", ")}`],
    });
  }

  const step3 = await conditionTagState(deps.api, { sha, version });
  if (!step3.ok) {
    return step3.skip
      ? { verdict: WRITE_VERDICT.SKIP, condition: "", version, reason: "already tagged at this commit", summary }
      : refuse(step3.condition, { summary: [...summary, ...(step3.summary ?? [])] });
  }

  const step4 = await conditionReleaseIntent(deps.api, deps, { version, versionFile: opts.versionFile, mainRef: opts.mainRef });
  if (!step4.ok) return refuse(step4.condition, { summary: [...summary, ...(step4.summary ?? [])] });

  const step7 = await conditionReleasePr(deps.api, { sha, version, repo: opts.repo });
  if (!step7.ok) return refuse(step7.condition, { summary: [...summary, ...(step7.summary ?? [])] });
  const step8 = await conditionReviews(deps.api, { pr: step7.pr, reviewers: opts.reviewers });
  if (!step8.ok) return refuse(step8.condition, { summary: [...summary, ...(step8.summary ?? [])] });

  const ref = `refs/tags/v${version}`;
  const created = await deps.api.createTagRef(ref, sha);
  if (!created?.ok) {
    // The POST is the race-breaker: the loser re-reads the ref and becomes a SKIP
    // (or a REFUSE when the ref points somewhere else).
    const existing = await deps.api.readTagRef(`v${version}`);
    const commit = existing ? await resolveTagCommit(deps.api, existing) : null;
    if (commit === sha) {
      return { verdict: WRITE_VERDICT.SKIP, condition: "", version, reason: "another run tagged this commit first", summary };
    }
    return refuse(CONDITION.TAG_CONFLICT, {
      summary: [...summary, `POST ${ref} failed (${created?.status}) and the ref resolves to ${commit ?? "nothing"}`],
    });
  }

  const readBack = await deps.api.readTagRef(`v${version}`);
  const resolved = readBack ? await resolveTagCommit(deps.api, readBack) : null;
  if (resolved !== sha) {
    return refuse(CONDITION.TAG_CONFLICT, {
      summary: [...summary, `after the POST, ${ref} resolves to ${resolved ?? "nothing"}, not ${sha}`],
    });
  }
  return { verdict: WRITE_VERDICT.TAGGED, condition: "", version, summary, ref };
}

// ── the nightly target ────────────────────────────────────────────────────────

/**
 * The one commit the nightly decides on: the commit that INTRODUCED the version
 * main's HEAD declares — the newest commit on main where the PARSED version value
 * differs from its parent's. Not the last commit that touched the file: a later
 * dependency or script edit to package.json leaves the version unchanged, and
 * selecting it would SKIP at condition 1 and silently miss the release.
 *
 * round 2, item 4: the walk is over the VERSION FILE's OWN history (`git log --
 * <version file>`), not a fixed number of commits up from HEAD. Only file-touching
 * commits are listed, so the version change is found however far back it is — the
 * old 200-commit linear window could walk straight past it. Returns null when the
 * walk finds no version change; the caller REFUSEs `version-origin-not-found`,
 * never SKIPs.
 */
export function nightlyTarget(deps, { versionFile = DEFAULT_VERSION_FILE, mainRef = "origin/main" } = {}) {
  const history = deps.git.logFileHistory(mainRef, versionFile);
  for (const commit of history) {
    const version = versionAt(deps, commit, versionFile);
    if (!version) continue; // unreadable at this revision: keep walking
    const parentText = deps.git.show(`${commit}^`, versionFile);
    if (parentText === null) continue; // a root commit has no parent to differ from
    if (readVersionFromManifest(parentText) !== version) return { sha: commit, version };
  }
  return null;
}

// ── CI-name check (nightly: a rename stops the trigger silently) ───────────────

export async function conditionCiName(api, { workflowPath, workflowName }) {
  const file = basename(workflowPath);
  const meta = await api.readWorkflowMeta(file);
  if (!meta || meta.name !== workflowName) {
    return {
      ok: false,
      condition: CONDITION.CI_RENAMED,
      summary: [`${workflowPath} is named ${JSON.stringify(meta?.name ?? null)}, not ${JSON.stringify(workflowName)}`],
    };
  }
  return { ok: true };
}

/**
 * round 2, item 3: the check-suite ids of the CI workflow's COMPLETED runs on
 * <sha>. A workflow run creates one check suite, and that suite's id is what
 * `commits/<sha>/check-runs` reports per run — so this is how condition 9 knows
 * whether the CI workflow actually ran on the commit. An empty list is a
 * REFUSE (`checks-missing`), never a pass.
 */
async function resolveCompletedCiSuiteIds(deps, workflowPath, sha) {
  const fileName = basename(workflowPath);
  const runs = await deps.api.listCompletedWorkflowRunsForSha(fileName, sha);
  const ids = new Set();
  for (const run of runs ?? []) {
    if (typeof run?.check_suite_id === "number") ids.add(run.check_suite_id);
  }
  return [...ids];
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = value;
    } else out._.push(arg);
  }
  return out;
}

export function renderVerdict(decision, sha) {
  if (decision.verdict === VERDICT.TAG) return `TAG v${decision.version} ${sha}`;
  if (decision.verdict === VERDICT.REFUSE) return `REFUSE ${decision.condition}`;
  return `SKIP ${decision.reason ?? "nothing to do"}`;
}

function writeOutputs(target, decision, sha = "") {
  // `sha` is the EFFECTIVE commit the decision was made on: for the nightly it is
  // what the walk found, which the `write` job must tag (round 2, item 1).
  const lines = [
    `verdict=${decision.verdict}`,
    `condition=${decision.condition ?? ""}`,
    `version=${decision.version ?? ""}`,
    `sha=${sha}`,
  ];
  if (!target || target === "-") {
    for (const line of lines) console.log(line);
    return;
  }
  appendFileSync(target, lines.join("\n") + "\n");
}

export async function main(argv = process.argv.slice(2), overrides = {}) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  const repo = args.repo ?? process.env.GITHUB_REPOSITORY;
  const output = args.output ?? process.env.GITHUB_OUTPUT ?? "-";
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "";
  if (!repo) throw new Error("--repo <owner/name> is required");
  // `overrides` is for tests (and only tests): the CLI surface — argv, output
  // file, exit code — is exercised without a network or a repository.
  const api = overrides.api ?? overrides.deps?.api ?? createClient({ repo, token });
  const deps = overrides.deps ?? createDeps({ api, root: process.cwd() });

  if (command === "decide") {
    const allowlistText = deps.readTextFile(args["advisory-allowlist"] ?? DEFAULT_ADVISORY_ALLOWLIST);
    const allowlist = parseAdvisoryAllowlist(allowlistText);
    const selfRunId = args["self-run-id"];
    let selfCheckSuiteId = args["self-check-suite-id"] ? Number(args["self-check-suite-id"]) : null;
    if (selfRunId && !selfCheckSuiteId) {
      const run = await api.readWorkflowRun(selfRunId);
      selfCheckSuiteId = run?.check_suite_id ?? null;
    }
    const options = {
      versionFile: args["version-file"] ?? DEFAULT_VERSION_FILE,
      mainRef: args["main-ref"] ?? "origin/main",
      workflowPath: args["workflow-path"] ?? DEFAULT_WORKFLOW_PATH,
      workflowName: args["workflow-name"] ?? DEFAULT_WORKFLOW_NAME,
      reviewers: (args.reviewers ?? DEFAULT_REVIEWERS.join(",")).split(",").map((s) => s.trim()).filter(Boolean),
      allowlist,
      deadlineMs: Number(args["deadline-minutes"] ?? DEFAULT_DEADLINE_MINUTES) * 60_000,
      pollMs: Number(args["poll-seconds"] ?? DEFAULT_POLL_SECONDS) * 1000,
      selfCheckSuiteId,
      repo,
    };
    let sha = args.sha ?? null;
    // round 2, item 3: condition 9 needs to know which check suites count as the
    // `CI` workflow for this commit. The workflow_run trigger carries its suite
    // id; the nightly and a dry dispatch resolve the completed CI runs on the
    // commit instead.
    const triggerSuiteId = args["trigger-check-suite-id"] ? Number(args["trigger-check-suite-id"]) : null;
    if (!sha) {
      // Nightly: the rename check first (a renamed CI never fires the trigger,
      // so this run is the only place that can see it), then one decision on the
      // commit that introduced the version main's HEAD declares.
      const stepCi = await conditionCiName(api, { workflowPath: options.workflowPath, workflowName: options.workflowName });
      if (!stepCi.ok) {
        const decision = { verdict: VERDICT.REFUSE, condition: stepCi.condition, version: "", summary: stepCi.summary };
        console.log(renderVerdict(decision, ""));
        console.log(decision.summary.join("\n"));
        writeOutputs(output, decision);
        return 0;
      }
      const target = nightlyTarget(deps, { versionFile: options.versionFile, mainRef: options.mainRef });
      if (!target) {
        // round 2, item 4: the walk could not find the version change. REFUSE
        // loudly — a silent SKIP is how a missed release disappears.
        const decision = {
          verdict: VERDICT.REFUSE,
          condition: CONDITION.VERSION_ORIGIN_NOT_FOUND,
          version: "",
          summary: [
            `could not find, in ${options.versionFile}'s own history on ${options.mainRef}, the commit that introduced the current version`,
          ],
        };
        console.log(renderVerdict(decision, ""));
        console.log(decision.summary.join("\n"));
        writeOutputs(output, decision);
        return 0;
      }
      sha = target.sha;
    }
    options.ciCheckSuiteIds =
      triggerSuiteId !== null ? [triggerSuiteId] : await resolveCompletedCiSuiteIds(deps, options.workflowPath, sha);
    const decision = await decide({ sha, deps, options });
    console.log(renderVerdict(decision, sha));
    for (const line of decision.summary ?? []) console.log(`  ${line}`);
    writeOutputs(output, decision, sha);
    return 0; // ALWAYS 0: the verdict is the output, not the exit code.
  }

  if (command === "tag") {
    if (!args.sha || !args.version) throw new Error("tag needs --sha and --version");
    const result = await writeTag({
      sha: args.sha,
      version: args.version,
      deps,
      options: {
        versionFile: args["version-file"] ?? DEFAULT_VERSION_FILE,
        mainRef: args["main-ref"] ?? "origin/main",
        reviewers: (args.reviewers ?? DEFAULT_REVIEWERS.join(",")).split(",").map((s) => s.trim()).filter(Boolean),
        repo,
        token,
        appId: process.env.RELEASE_TAG_APP_ID ?? "",
        appKeyPresent: process.env.RELEASE_TAG_APP_KEY_PRESENT ?? "",
      },
    });
    console.log(`${result.verdict} v${result.version} ${args.sha}${result.condition ? ` (${result.condition})` : ""}`);
    for (const line of result.summary ?? []) console.log(`  ${line}`);
    writeOutputs(output, result, args.sha);
    return 0;
  }

  console.error("Usage: release-auto-tag.mjs decide|tag [options]");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`release-auto-tag: ${err?.stack ?? err}`);
      process.exit(1);
    },
  );
}
