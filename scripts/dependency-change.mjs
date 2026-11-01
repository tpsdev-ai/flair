// Dependency-manifest changes and the Renovate waiver (flair#2872).
//
// A hosted Renovate dependency bump cannot carry a changelog fragment: the app
// cannot add a file to the branch. The waiver is deliberately narrow, with two
// independent conditions:
//
//   * At pull-request time the author comes from the workflow event
//     (`github.event.pull_request.user.login`), passed in as
//     FLAIR_PR_AUTHOR_LOGIN. It is never inferred from commit metadata, which a
//     branch can set to any value.
//   * Every path against the merge base is a dependency manifest or lockfile.
//     A change to anything else keeps the normal fragment requirement.
//
// A merged squash commit records its author, so the release-time record uses
// the same shape over history: author renovate[bot] AND a dependency-only diff.

import { execFileSync } from "node:child_process";

export const RENOVATE_LOGIN = "renovate[bot]";

// package.json at any depth, plus the lockfiles the issue names. Renovate
// configuration is deliberately absent: a config edit is a policy change, not
// a dependency bump.
const DEPENDENCY_FILE_NAMES = new Set([
  "package.json",
  "bun.lock",
  "package-lock.json",
  "npm-shrinkwrap.json",
]);

/** Whether one path is a dependency manifest or lockfile this waiver covers. */
export function isDependencyManifestPath(relPath) {
  const p = String(relPath ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!p) return false;
  return DEPENDENCY_FILE_NAMES.has(p.split("/").pop());
}

/**
 * Whether a changed-path list is non-empty and entirely dependency manifests or
 * lockfiles. An empty list is not a dependency-only change: it means the diff
 * could not be read, so the caller must keep the requirement.
 */
export function isDependencyOnlyChange(relPaths) {
  const paths = (relPaths ?? [])
    .map((p) => String(p).trim())
    .filter((p) => p !== "");
  return paths.length > 0 && paths.every(isDependencyManifestPath);
}

/** Case-insensitive match on the pull-request author login from the event. */
export function isRenovateLogin(login) {
  return String(login ?? "").trim().toLowerCase() === RENOVATE_LOGIN;
}

/** Whether a commit's recorded author name is the Renovate app. */
export function isRenovateCommitAuthor(name) {
  return String(name ?? "").trim().toLowerCase() === RENOVATE_LOGIN;
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Whether a merged commit is a Renovate dependency bump: author renovate[bot]
 * AND a diff that touches only dependency manifests or lockfiles. Any git
 * failure answers false, so an unreadable commit keeps the normal requirement.
 */
export function isRenovateDependencyCommit(sha, cwd) {
  let meta;
  try {
    meta = git(cwd, ["show", "-s", "--format=%an", String(sha)]);
  } catch {
    return false;
  }
  const name = meta.replace(/\n$/, "");
  if (!isRenovateCommitAuthor(name)) return false;
  let changed;
  try {
    changed = git(cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", String(sha)]);
  } catch {
    return false;
  }
  const paths = changed.split("\n").map((p) => p.trim()).filter((p) => p !== "");
  return isDependencyOnlyChange(paths);
}

/** Most recent v* tag reachable from HEAD, or null when the repo has none. */
export function lastReleaseTag(cwd) {
  try {
    const tag = git(cwd, ["describe", "--tags", "--abbrev=0", "--match", "v*"]).trim();
    return tag === "" ? null : tag;
  } catch {
    return null;
  }
}

/**
 * Renovate dependency commits reachable from HEAD but not from the last v*
 * tag, oldest first. With no tag the whole history is used.
 */
export function collectRenovateDependencyCommits({ cwd = process.cwd(), sinceTag } = {}) {
  const tag = sinceTag === undefined ? lastReleaseTag(cwd) : sinceTag;
  const range = tag ? `${tag}..HEAD` : "HEAD";
  let log;
  try {
    log = git(cwd, ["log", "--reverse", "--pretty=%H%x00%s", range]);
  } catch (err) {
    throw new Error(`could not read git history for ${range}: ${err?.message ?? err}`);
  }
  const rows = log
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
    .map((line) => {
      const [sha, ...rest] = line.split("\0");
      return { sha, subject: rest.join("\0") };
    })
    .filter(({ subject }) => /^(feat|fix)(\(|!|:)/.test(subject))
    .filter(({ sha }) => isRenovateDependencyCommit(sha, cwd));
  return rows.map(({ sha, subject }) => {
    const m = subject.match(/\(#(\d+)\)\s*$/);
    return { sha, subject, pr: m ? Number(m[1]) : null };
  });
}

/** A Keep-a-Changelog section body listing the dependency commits, or "". */
export function formatDependenciesSection(commits) {
  if (!Array.isArray(commits) || commits.length === 0) return "";
  return `### Dependencies\n\n${commits.map((c) => `- ${c.subject}`).join("\n")}`;
}
