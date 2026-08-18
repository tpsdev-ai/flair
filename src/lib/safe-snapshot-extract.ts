// safe-snapshot-extract.ts — path-escape-safe extraction for physical
// snapshot tarballs.
//
// WHY THIS EXISTS
// ---------------
// `createDataSnapshot` archives with `preservePaths: true`, and it needs to:
// WITHOUT it, node-tar strips the leading "/" off any absolute symlink
// TARGET, so an in-bounds symlink pointing at an absolute path under the
// data dir comes back as a nonsense RELATIVE path — silently broken.
//
// The restore side used to mirror that flag, reasoning that the archive
// "only contains what createDataSnapshot's filter chose to include". That
// reasoning does not hold: restore accepts a tarball the CLI did not create
// — copied from another machine, downloaded, or handed over during a
// migration. `preservePaths: true` disables BOTH of node-tar's containment
// behaviours (it stops stripping a leading "/" from entry PATHS, and stops
// rejecting ".." segments), so a hostile archive could write anywhere the
// invoking user can write.
//
// The flag is load-bearing for symlink TARGET text and useless-to-harmful
// for entry PATHS, and node-tar exposes only the one knob for both. So we
// keep `preservePaths: true` and do the containment check ourselves —
// strictly, and BEFORE anything is written to disk.
//
// Posture is FAIL CLOSED: a snapshot with even one out-of-bounds entry is
// refused whole, rather than extracted-minus-the-bad-parts. A snapshot that
// wants to escape is not a snapshot we can vouch for the rest of.

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { extract as tarExtract, list as tarList } from "tar";
// flair#901 — the entry contract is TYPED against node-tar's own export, so a
// property rename in a future tar release fails at COMPILE time. That is the
// only place a rename can be caught: at runtime the defensive coercions below
// would quietly turn a renamed property into ""/undefined, and this file's
// whole job is to decide from those very properties. The runtime shape checks
// in checkSnapshotEntry are the belt to this type's suspenders — they fail
// CLOSED on an entry whose properties don't carry what the contract promises.
import type { ReadEntry } from "tar";

/** Thrown when a snapshot entry would resolve outside the target directory. */
export class SnapshotPathEscapeError extends Error {
  readonly entryPath: string;
  readonly reason: string;

  constructor(message: string, entryPath: string, reason: string) {
    super(message);
    this.name = "SnapshotPathEscapeError";
    this.entryPath = entryPath;
    this.reason = reason;
  }
}

/**
 * True when `candidate` is the directory itself or lives underneath it.
 * Compares resolved absolute paths; the `+ sep` guard stops "/a/bc" from
 * counting as inside "/a/b".
 */
function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * Absolute in the sense that matters for tar containment. `isAbsolute` alone
 * is platform-dependent, and an archive is attacker-controlled data that need
 * not match the host it is being extracted on — so a Windows-shaped drive or
 * UNC path is treated as absolute even on POSIX.
 */
function looksAbsolute(p: string): boolean {
  return isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");
}

/** A ".." component anywhere in the path, under either separator. */
function hasDotDotSegment(p: string): boolean {
  return p.split(/[\\/]+/).includes("..");
}

/**
 * Lexical containment check for a single archive entry. Pure — no filesystem
 * access — so it can run over the whole archive listing before a single byte
 * is written.
 *
 * `linkpath` is the entry's link target, when it has one.
 */
export function checkSnapshotEntry(
  entryPath: string,
  type: string | undefined,
  linkpath: string | undefined,
  resolvedTargetDir: string,
): { ok: true } | { ok: false; reason: string } {
  // flair#901 fail-closed shape checks: an entry this check cannot READ is an
  // entry it must not PASS. An empty path used to resolve to the target dir
  // itself (inside, so ok), and a link entry with no linkpath skipped the
  // link branches entirely — both silently approved exactly when the input
  // was least trustworthy (tampered archive, or an upstream property rename
  // surviving to runtime).
  if (!entryPath) {
    return { ok: false, reason: "entry has an empty or unreadable path — refusing an entry this check cannot classify" };
  }
  if ((type === "Link" || type === "SymbolicLink") && !linkpath) {
    return { ok: false, reason: `${type === "Link" ? "hard link" : "symlink"} "${entryPath}" has no readable link target — refusing an entry this check cannot classify` };
  }
  if (looksAbsolute(entryPath)) {
    return { ok: false, reason: `entry has an absolute path ("${entryPath}"), which would write outside the target directory` };
  }
  if (hasDotDotSegment(entryPath)) {
    return { ok: false, reason: `entry path contains a ".." segment ("${entryPath}"), which would traverse outside the target directory` };
  }
  const dest = resolve(resolvedTargetDir, entryPath);
  if (!isWithin(dest, resolvedTargetDir)) {
    return { ok: false, reason: `entry resolves to "${dest}", outside the target directory` };
  }

  if (linkpath) {
    if (type === "Link") {
      // Hardlink: node-tar resolves linkpath relative to cwd, and a hardlink
      // to a file outside the target would expose that file's contents
      // through the restored tree.
      if (looksAbsolute(linkpath) || hasDotDotSegment(linkpath)) {
        return { ok: false, reason: `hard link "${entryPath}" points to "${linkpath}", outside the target directory` };
      }
      const linkDest = resolve(resolvedTargetDir, linkpath);
      if (!isWithin(linkDest, resolvedTargetDir)) {
        return { ok: false, reason: `hard link "${entryPath}" resolves to "${linkDest}", outside the target directory` };
      }
    } else if (type === "SymbolicLink") {
      // Symlink targets are written verbatim (that is what preservePaths
      // buys us), so an absolute target is legitimate — but only if it lands
      // inside the target directory. This mirrors createDataSnapshot's own
      // filter, which already refuses to archive a symlink pointing outside
      // the data dir; such an entry cannot have come from a snapshot this
      // CLI produced for this target directory.
      const linkDest = looksAbsolute(linkpath)
        ? resolve(linkpath)
        : resolve(dirname(resolve(resolvedTargetDir, entryPath)), linkpath);
      if (!isWithin(linkDest, resolvedTargetDir)) {
        return { ok: false, reason: `symlink "${entryPath}" points to "${linkDest}", outside the target directory` };
      }
    }
  }

  return { ok: true };
}

/**
 * Resolve a path's existing ancestor chain through symlinks. Used to catch an
 * entry that would be written THROUGH a symlink an earlier entry in the same
 * archive created — the lexical check cannot see that, because the path has
 * no ".." and is not absolute.
 */
function realpathOfNearestExistingAncestor(p: string): string {
  let cur = p;
  // Walk up until something exists; the freshly-created target dir always does.
  for (let i = 0; i < 256; i++) {
    if (existsSync(cur)) return realpathSync(cur);
    const parent = dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
  return cur;
}

/**
 * Resolve the target directory for containment comparisons. realpath when it
 * already exists — on macOS the temp dir itself sits behind a symlink
 * (/tmp -> /private/tmp), so a purely lexical resolve would misclassify
 * genuinely in-bounds paths — falling back to a lexical resolve when it does
 * not (validation runs before the directory is recreated).
 */
function resolveTargetDir(p: string): string {
  const lexical = resolve(p);
  try {
    return realpathSync(lexical);
  } catch {
    return lexical;
  }
}

/**
 * Read the archive's listing and throw if any entry would land outside
 * `targetDir`. Writes NOTHING — call this before any destructive step so a
 * hostile snapshot cannot cost the operator their data directory on the way
 * to being refused.
 */
export async function validateSnapshotArchive(opts: {
  file: string;
  targetDir: string;
}): Promise<void> {
  const resolvedTargetDir = resolveTargetDir(opts.targetDir);
  const violations: Array<{ entryPath: string; reason: string }> = [];
  await tarList({
    file: opts.file,
    // Typed against tar's ReadEntry (flair#901) — a property rename upstream
    // now fails compilation instead of coercing to ""/undefined at runtime.
    // The coercions below remain as the runtime belt, and they no longer
    // default to safe: checkSnapshotEntry refuses an empty path and a
    // link-typed entry with no link target.
    onReadEntry: (entry: ReadEntry) => {
      const entryPath = typeof entry.path === "string" ? entry.path : "";
      const verdict = checkSnapshotEntry(
        entryPath,
        entry.type,
        typeof entry.linkpath === "string" && entry.linkpath !== "" ? entry.linkpath : undefined,
        resolvedTargetDir,
      );
      // `verdict.ok === false` rather than `!verdict.ok`: an explicit
      // comparison against the literal discriminant is what narrows the union
      // to its failure member, so `reason` is known to exist here. The union
      // is deliberately shaped so a caller cannot read a reason off a success.
      if (verdict.ok === false) {
        violations.push({ entryPath, reason: verdict.reason });
      }
    },
  });

  if (violations.length > 0) {
    const shown = violations.slice(0, 5).map((v) => `  - ${v.reason}`).join("\n");
    const more = violations.length > 5 ? `\n  ...and ${violations.length - 5} more` : "";
    throw new SnapshotPathEscapeError(
      `refusing to restore: this snapshot contains ${violations.length} ` +
        `entr${violations.length === 1 ? "y that would write" : "ies that would write"} outside ${resolvedTargetDir}.\n` +
        `${shown}${more}\n` +
        `Nothing was extracted and the target directory was left as-is.\n` +
        `A snapshot taken by "flair snapshot create" never contains such entries — this archive was ` +
        `either produced by something else or modified after it was taken. Restore from a snapshot you ` +
        `trust, or inspect this one with "tar -tzvf <snapshot>" before using it.`,
      violations[0].entryPath,
      violations[0].reason,
    );
  }
}

/**
 * Extract a snapshot tarball into `targetDir`, refusing any archive that
 * would write outside it.
 *
 * Two passes on purpose:
 *   1. `validateSnapshotArchive` — no writes at all, so a hostile archive is
 *      refused before it can leave a partial mess behind.
 *   2. Extract, with a filesystem-aware guard that re-checks each entry
 *      against symlinks created earlier in the same archive — an escape the
 *      lexical pass cannot see, because such a path is neither absolute nor
 *      contains "..".
 *
 * `preservePaths: true` is retained for symlink-target fidelity; see this
 * file's header.
 */
export async function extractSnapshotSafely(opts: {
  file: string;
  targetDir: string;
}): Promise<void> {
  await validateSnapshotArchive(opts);
  const resolvedTargetDir = resolveTargetDir(opts.targetDir);

  // ── Pass 2: extract, guarding against write-through-symlink ─────────────
  const runtimeViolations: Array<{ entryPath: string; reason: string }> = [];
  await tarExtract({
    file: opts.file,
    cwd: resolvedTargetDir,
    // Load-bearing: keeps absolute symlink TARGET text verbatim. Entry-path
    // containment is our job, done above and re-checked here.
    preservePaths: true,
    filter: (entryPath: string) => {
      const dest = resolve(resolvedTargetDir, entryPath);
      // Resolve `dest` itself, NOT dirname(dest): a real snapshot's first
      // entry is "./" (createDataSnapshot archives the fileList ["."]), whose
      // dest IS the target directory — taking its parent would resolve to the
      // directory ABOVE the target and reject every legitimate snapshot.
      // Walking up from dest gives the target dir itself for that entry, and
      // still catches a symlinked ancestor for everything deeper.
      const anchor = realpathOfNearestExistingAncestor(dest);
      if (!isWithin(anchor, resolvedTargetDir)) {
        runtimeViolations.push({
          entryPath,
          reason: `entry "${entryPath}" would be written through a symlink to "${anchor}", outside the target directory`,
        });
        return false;
      }
      return true;
    },
  });

  if (runtimeViolations.length > 0) {
    const v = runtimeViolations[0];
    throw new SnapshotPathEscapeError(
      `refusing to complete this restore: ${v.reason}.\n` +
        `The target directory ${resolvedTargetDir} is now partially written and must not be used — ` +
        `delete it and restore from a snapshot you trust.`,
      v.entryPath,
      v.reason,
    );
  }
}
