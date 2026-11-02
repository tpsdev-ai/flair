// JavaScript manifest and lockfile changes (flair#2872).
//
// The PR-time waiver reads only the event login, never commit metadata.
// Release-time eligibility reads the recorded author NAME. With merge commits
// enabled, that name can be mis-attributed.
// The PR-time waiver evaluates the event login and changed paths. The
// since-tag exclusion in the docs-freshness gate reads the recorded author name.

import { execFileSync } from "node:child_process";

export const RENOVATE_LOGIN = "renovate[bot]";

// Accepted basenames at any depth.
const DEPENDENCY_FILE_NAMES = new Set([
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
]);

/** Match the Git basename exactly, splitting on "/" only. */
export function isDependencyManifestPath(relPath) {
  const p = String(relPath ?? "");
  if (!p) return false;
  return DEPENDENCY_FILE_NAMES.has(p.split("/").pop());
}

/** Match every path in a non-empty list. */
export function isDependencyOnlyChange(relPaths) {
  const paths = relPaths ?? [];
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
 * only paths with accepted basenames.
 */
export function isRenovateDependencyCommit(sha, cwd) {
  let meta;
  try { meta = git(cwd, ["show", "-s", "--format=%an", String(sha)]); }
  catch (err) { throw new Error(`could not read commit ${sha}: ${err?.message ?? err}`); }
  const name = meta.replace(/\n$/, "");
  if (!isRenovateCommitAuthor(name)) return false;
  let changed;
  try { changed = git(cwd, ["diff-tree", "--root", "--no-commit-id", "--no-renames", "--name-only", "-z", "-r", String(sha)]); }
  catch (err) { throw new Error(`could not read diff for commit ${sha}: ${err?.message ?? err}`); }
  const paths = changed.split("\0").filter((p) => p !== "");
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
