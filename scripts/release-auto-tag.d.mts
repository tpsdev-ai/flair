/**
 * Typings for `release-auto-tag.mjs` (flair#1890). The script is dependency-free
 * JavaScript; these declarations exist so the unit tests that import it can be
 * type-checked under strict (see tsconfig.test.check.json, and the sibling
 * `changelog-extract.d.mts` precedent).
 */

export interface ConditionIds {
  VERSION_SHAPE: string;
  NOT_MAIN_ANCESTOR: string;
  SUPERSEDED: string;
  VERSION_SYNC: string;
  NO_RELEASE_PR: string;
  REVIEWS: string;
  RELEASE_PR_SHAPE: string;
  RELEASE_PR_NOT_SINGLE_COMMIT: string;
  TAG_CONFLICT: string;
  CHECKS_FAILED: string;
  CHECKS_PENDING: string;
  CHECKS_MISSING: string;
  CI_RENAMED: string;
  VERSION_ORIGIN_NOT_FOUND: string;
  APP_NOT_CONFIGURED: string;
}

export const CONDITION: ConditionIds;
export const CONDITION_IDS: readonly string[];
export const VERDICT: { TAG: "TAG"; SKIP: "SKIP"; REFUSE: "REFUSE" };
export const WRITE_VERDICT: { TAGGED: "TAGGED"; SKIP: "SKIP"; REFUSE: "REFUSE" };
export const VERSION_SHAPE: RegExp;
export const CONCLUSION_WHITELIST: readonly string[];
export const DEFAULT_REVIEWERS: readonly string[];
export const DEFAULT_VERSION_FILE: string;
export const DEFAULT_WORKFLOW_PATH: string;
export const DEFAULT_WORKFLOW_NAME: string;
export const DEFAULT_ADVISORY_ALLOWLIST: string;
export const DEFAULT_POLL_SECONDS: number;
export const RELEASE_PR_EXTRA_FILES: readonly string[];
export const RELEASE_PR_EXTRA_PREFIXES: readonly string[];
export const LOCKFILE_NAMES: readonly string[];
export const DEFAULT_DEADLINE_MINUTES: number;
export const INVALID_VERSION: string;

export interface PullRequestShape {
  number: number;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  /** The commit count (condition 7c). Carried by `pulls/<n>`; the
   *  `commits/<sha>/pulls` list does not include this field. */
  commits?: number;
  base?: { ref?: string } | null;
  head?: { sha?: string; ref?: string; repo?: { full_name?: string } | null } | null;
}

export interface ReviewShape {
  commit_id?: string;
  state?: string;
  submitted_at?: string;
  user?: { login?: string } | null;
}

export interface CheckRunShape {
  name?: string;
  status?: string;
  conclusion?: string | null;
  check_suite?: { id?: number } | null;
}

export interface TagRefShape {
  object?: { type?: string; sha?: string } | null;
}

export interface PullFileShape {
  filename?: string;
  previous_filename?: string;
}

export interface GitHubClient {
  repo: string;
  readTagRef(tag: string): Promise<TagRefShape | null>;
  readTagObject(sha: string): Promise<TagRefShape | null>;
  listVersionTags(): Promise<Array<{ ref?: string }>>;
  listPullsForCommit(sha: string): Promise<PullRequestShape[]>;
  readPull(prNumber: number): Promise<PullRequestShape | null>;
  listReviews(prNumber: number): Promise<ReviewShape[]>;
  listPullFiles(prNumber: number): Promise<PullFileShape[]>;
  listCheckRuns(sha: string): Promise<CheckRunShape[]>;
  readWorkflowMeta(path: string): Promise<{ name?: string } | null>;
  readWorkflowRun(runId: string | number): Promise<{ check_suite_id?: number } | null>;
  listCompletedWorkflowRunsForSha(fileName: string, sha: string): Promise<Array<{ check_suite_id?: number }>>;
  createTagRef(ref: string, sha: string): Promise<{ ok: boolean; status: number; body: unknown }>;
}

export interface GitReads {
  show(rev: string, path: string): string | null;
  isAncestor(sha: string, ref: string): boolean;
  revParse(ref: string): string;
  logFileHistory(rev: string, path: string): string[];
  changedFiles(rev: string): string[];
}

export interface Deps {
  api: GitHubClient;
  log: { info(message: string): void; warn(message: string): void };
  now(): number;
  sleep(ms: number): Promise<void>;
  readTextFile(path: string): string;
  git: GitReads;
  listVersionFiles(): string[] | null;
  rootLockfiles(): string[] | null;
  runVersionSync(sha: string, version: string): { ok: boolean; code: number; output: string };
}

export interface DecideOptions {
  versionFile: string;
  mainRef: string;
  workflowPath: string;
  workflowName: string;
  reviewers: readonly string[];
  allowlist: Set<string>;
  deadlineMs: number;
  pollMs: number;
  selfCheckSuiteId: number | null;
  ciCheckSuiteIds: number[] | null;
  repo: string;
}

export interface Decision {
  verdict: string;
  condition: string;
  version: string;
  reason?: string;
  summary: string[];
  pr?: PullRequestShape;
}

export interface WriteResult {
  verdict: string;
  condition: string;
  version: string;
  reason?: string;
  summary: string[];
  ref?: string;
}

export interface WriteOptions {
  versionFile: string;
  mainRef: string;
  reviewers: readonly string[];
  repo: string;
  token: string;
  appId: string;
  appKeyPresent: string;
  /** A read-only client for the re-check's reads (the App token cannot read
   *  pull requests). Null/absent → `deps.api` is used for the reads too. */
  readApi?: GitHubClient | null;
}

export function compareVersions(a: string, b: string): number;
export function readVersionFromManifest(text: string | null): string | null;
export function parseAdvisoryAllowlist(text: string): Set<string>;
export function createClient(options: {
  repo: string;
  token?: string;
  fetchImpl?: typeof fetch;
  apiBase?: string;
}): GitHubClient;
export function createDeps(options?: {
  overrides?: Partial<Deps>;
  root?: string;
  log?: { info(message: string): void; warn(message: string): void };
  api?: GitHubClient | null;
}): Deps;
export function resolveTagCommit(api: GitHubClient, ref: TagRefShape | null): Promise<string | null>;
export function conditionTagState(
  api: GitHubClient,
  args: { sha: string; version: string },
): Promise<{ ok: boolean; skip?: boolean; reason?: string; condition?: string; summary?: string[] }>;
export function conditionReleaseIntent(
  api: GitHubClient,
  deps: Deps,
  args: { version: string; versionFile: string; mainRef: string },
): Promise<{ ok: boolean; condition?: string; summary?: string[] }>;
export function conditionMainAncestor(
  deps: Deps,
  args: { sha: string; mainRef: string },
): { ok: boolean; condition?: string; summary?: string[] };
export function conditionVersionSync(
  deps: Deps,
  args: { sha: string; version: string },
): Promise<{ ok: boolean; condition?: string; summary?: string[] }>;
export function conditionReleasePr(
  api: GitHubClient,
  args: { sha: string; version: string; repo: string },
): Promise<{ ok: boolean; condition?: string; summary?: string[]; pr?: PullRequestShape }>;
export function conditionReviews(
  api: GitHubClient,
  args: { pr: PullRequestShape; reviewers: readonly string[] },
): Promise<{ ok: boolean; condition?: string; summary?: string[] }>;
export function conditionReleasePrShape(
  deps: Deps,
  args: { sha: string; pr: PullRequestShape; versionFiles: string[] | null },
): { ok: boolean; condition?: string; summary?: string[] };
export function conditionReleasePrSingleCommit(
  api: GitHubClient,
  args: { pr: PullRequestShape },
): Promise<{ ok: boolean; condition?: string; summary?: string[] }>;
export function conditionChecks(
  deps: Deps,
  args: {
    sha: string;
    selfCheckSuiteId: number | null;
    allowlist: Set<string>;
    deadlineMs: number;
    pollMs: number;
    ciCheckSuiteIds?: number[] | null;
  },
): Promise<{ ok: boolean; condition?: string; summary?: string[]; tolerated?: string[]; waitedMs?: number }>;
export function conditionCiName(
  api: GitHubClient,
  args: { workflowPath: string; workflowName: string },
): Promise<{ ok: boolean; condition?: string; summary?: string[] }>;
export function decide(args: { sha: string; deps: Deps; options?: Partial<DecideOptions> }): Promise<Decision>;
export function writeTag(args: {
  sha: string;
  version: string;
  deps: Deps;
  options?: Partial<WriteOptions>;
}): Promise<WriteResult>;
export function nightlyTarget(
  deps: Deps,
  options?: { versionFile?: string; mainRef?: string },
): { sha: string; version: string | null } | null;
export function renderVerdict(decision: Decision, sha: string): string;
export function main(argv?: string[], overrides?: { api?: GitHubClient; deps?: Deps }): Promise<number>;
