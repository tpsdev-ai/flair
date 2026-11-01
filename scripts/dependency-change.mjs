// JavaScript manifest and lockfile changes (flair#2872).
//
// The waiver has two conditions:
//
//   * At pull-request time the author comes from the workflow event
//     (`github.event.pull_request.user.login`), passed in as
//     FLAIR_PR_AUTHOR_LOGIN. It is never inferred from commit metadata, which a
//     branch can set to any value.
//   * Every path against the merge base is package.json, bun.lock,
//     package-lock.json, or npm-shrinkwrap.json.
//     A change to anything else keeps the normal fragment requirement.
//
// Release collection matches the recorded author name and changed filenames.

import { execFileSync } from "node:child_process";

export const RENOVATE_LOGIN = "renovate[bot]";

// Accepted basenames at any depth.
const DEPENDENCY_FILE_NAMES = new Set([
  "package.json",
  "bun.lock",
  "package-lock.json",
  "npm-shrinkwrap.json",
]);

/** Whether a path has one of the four accepted basenames. */
export function isDependencyManifestPath(relPath) {
  const p = String(relPath ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!p) return false;
  return DEPENDENCY_FILE_NAMES.has(p.split("/").pop());
}

/**
 * Whether a non-empty path list uses only the four accepted basenames.
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

/** Whether a commit's recorded author name matches renovate[bot]. */
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
 * Whether the recorded author name matches renovate[bot] and the commit changes
 * only package.json, bun.lock, package-lock.json, or npm-shrinkwrap.json.
 */
export function isRenovateDependencyCommit(sha, cwd) {
  let meta;
  try { meta = git(cwd, ["show", "-s", "--format=%an", String(sha)]); }
  catch (err) { throw new Error(`could not read commit ${sha}: ${err?.message ?? err}`); }
  const name = meta.replace(/\n$/, "");
  if (!isRenovateCommitAuthor(name)) return false;
  let changed;
  try { changed = git(cwd, ["diff-tree", "--no-commit-id", "--no-renames", "--name-only", "-r", String(sha)]); }
  catch (err) { throw new Error(`could not read diff for commit ${sha}: ${err?.message ?? err}`); }
  const paths = changed.split("\n").map((p) => p.trim()).filter((p) => p !== "");
  return isDependencyOnlyChange(paths);
}

/** Tag selected by git describe, or null with explicit first-release permission. */
export function lastReleaseTag(cwd, { allowNoReleaseTag = false } = {}) {
  try {
    const tag = git(cwd, ["describe", "--tags", "--abbrev=0", "--match", "v*"]).trim();
    if (tag) return tag;
    throw new Error("git describe returned an empty tag");
  } catch (err) {
    let tags;
    try { tags = git(cwd, ["tag", "--list", "v*"]).trim(); }
    catch (tagErr) { throw new Error(`could not check release tags: ${tagErr?.message ?? tagErr}`); }
    if (!tags) {
      if (allowNoReleaseTag) return null;
      throw new Error("repository has no v* release tag; pass --allow-no-release-tag for a first release");
    }
    throw new Error(`could not resolve release tag with git describe: ${err?.message ?? err}`);
  }
}

/**
 * Eligible commits since the tag selected by git describe, oldest first.
 */
export function collectRenovateDependencyCommits({ cwd = process.cwd(), sinceTag, allowNoReleaseTag = false } = {}) {
  if (sinceTag !== undefined && (typeof sinceTag !== "string" || sinceTag.trim() === "")) {
    throw new Error("invalid sinceTag: supply a tag name or omit sinceTag");
  }
  const tag = sinceTag === undefined ? lastReleaseTag(cwd, { allowNoReleaseTag }) : sinceTag;
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

/** A Keep-a-Changelog section body listing supplied commits, or "". */
export function formatDependenciesSection(commits) {
  if (!Array.isArray(commits) || commits.length === 0) return "";
  return `### Dependencies\n\n${commits.map((c) => `- ${c.subject}`).join("\n")}`;
}
