// engine-version.ts — Harper engine version tracking (flair#1047)
//
// Two concerns, one module:
//
// 1. STORE STAMP — flair records the engine version that last wrote the data
//    directory. At boot, if the store was written by a NEWER engine than the
//    one running, flair refuses to start and says so: which version wrote the
//    store, which is running now, and what to do about it.
//
// 2. VERSION READ — read the Harper version installed alongside this flair
//    package, and (when a target flair version is known) the Harper version
//    that target declares. Used by the upgrade path to decide whether the
//    engine version is changing and a pre-upgrade snapshot is therefore
//    mandatory.
//
// The stamp is a single-line file in the data directory. It must survive the
// data directory being moved and must not require a Harper query to read — if
// the engine cannot boot, we still need to read it.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

/** Filename of the engine-version stamp inside the data directory. */
export const ENGINE_VERSION_STAMP = "engine-version.txt";

/** Root directory for pre-upgrade snapshots (~/.flair/upgrade-snapshots). */
export const UPGRADE_SNAPSHOT_ROOT = resolve(homedir(), ".flair", "upgrade-snapshots");

/** Read the Harper version installed alongside this flair package. */
export function readInstalledHarperVersion(packageRoot: string): string | null {
  for (const name of ["harper", "@harperfast/harper"]) {
    const pkgPath = join(packageRoot, "node_modules", ...name.split("/"), "package.json");
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Fetch the Harper version that a given @tpsdev-ai/flair version declares as
 * a dependency. Returns null when the lookup fails (network, unparseable, etc.)
 * — callers treat null as "cannot determine, assume it might change."
 */
export async function fetchDeclaredHarperVersion(flairVersion: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://registry.npmjs.org/@tpsdev-ai/flair/${flairVersion}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return null;
    const data = await res.json() as { dependencies?: Record<string, string> };
    return data.dependencies?.harper ?? data.dependencies?.["@harperfast/harper"] ?? null;
  } catch {
    return null;
  }
}

// ─── Store stamp ─────────────────────────────────────────────────────────────

/** Write the engine version stamp into the data directory. */
export function writeEngineVersionStamp(dataDir: string, version: string): void {
  writeFileSync(join(dataDir, ENGINE_VERSION_STAMP), `${version}\n`, "utf-8");
}

/** Read the engine version stamp from the data directory, or null if absent. */
export function readEngineVersionStamp(dataDir: string): string | null {
  const stampPath = join(dataDir, ENGINE_VERSION_STAMP);
  if (!existsSync(stampPath)) return null;
  try {
    return readFileSync(stampPath, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check whether the running engine is OLDER than the engine that last wrote
 * the store. Returns null when the check passes (no stamp, or stamp ≤ running),
 * or an error message when the store is newer.
 *
 * The error must be actionable: actor, state, remedy.
 */
export function checkEngineVersionBackwards(
  dataDir: string,
  runningVersion: string,
): string | null {
  const stamp = readEngineVersionStamp(dataDir);
  if (!stamp) return null; // no stamp — nothing to compare (pre-stamp install)

  const parsed = compareVersions(stamp, runningVersion);
  if (parsed === null) {
    // Genuinely unparseable — cannot determine ordering. Refuse with a
    // message that does NOT claim one is newer than the other.
    return [
      `This Flair install is running Harper ${runningVersion}, but the data directory at`,
      `  ${dataDir}`,
      `was last written by Harper ${stamp}.`,
      ``,
      `The engine version stamp could not be compared to the running version.`,
      `An older Harper cannot safely read a store written by a newer one.`,
      ``,
      ...buildRecoveryLines(),
    ].join("\n");
  }
  if (parsed > 0) {
    // stamp > running — backwards boot, refuse.
    return [
      `This Flair install is running Harper ${runningVersion}, but the data directory at`,
      `  ${dataDir}`,
      `was last written by Harper ${stamp} — a newer engine version.`,
      ``,
      `An older Harper cannot safely read a store written by a newer one.`,
      `The data may appear intact but can be silently unreadable.`,
      ``,
      ...buildRecoveryLines(),
    ].join("\n");
  }
  return null; // running >= stamp — allowed
}

// ─── Version comparison (flair#1047) ─────────────────────────────────────────

/**
 * Compare two semver-like version strings.
 * Returns negative when a < b, positive when a > b, zero when equal,
 * or null when either version is genuinely unparseable (not N.N.N at all).
 *
 * Pre-release ordering follows semver: a version WITH a pre-release tag is
 * LOWER than the same core without one (5.2.0-rc1 < 5.2.0). When both have
 * pre-releases, identifiers are compared dot by dot — numeric parts
 * numerically, the rest as strings.
 */
function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;

  // Compare major.minor.patch (and any additional numeric components) numerically.
  const coreLen = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < coreLen; i++) {
    const ac = pa.core[i] ?? 0;
    const bc = pb.core[i] ?? 0;
    if (ac !== bc) return ac - bc;
  }

  // Cores are equal — compare pre-release tags.
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;  // a has no pre-release → a > b
  if (pb.pre === null) return -1; // b has no pre-release → a < b

  // Both have pre-releases — compare identifiers dot by dot.
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const ai = pa.pre[i];
    const bi = pb.pre[i];
    if (ai === undefined) return -1; // fewer identifiers → lower
    if (bi === undefined) return 1;
    const an = Number(ai);
    const bn = Number(bi);
    const aIsNum = !isNaN(an);
    const bIsNum = !isNaN(bn);
    if (aIsNum && bIsNum) {
      if (an !== bn) return an - bn;
    } else if (aIsNum) {
      return -1; // numeric < string
    } else if (bIsNum) {
      return 1;
    } else {
      if (ai !== bi) return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

interface ParsedVersion {
  core: number[];
  pre: string[] | null; // null = no pre-release (release version)
}

function parseVersion(v: string): ParsedVersion | null {
  // Split off pre-release: everything after the first hyphen.
  const hyphenIdx = v.indexOf("-");
  const coreStr = hyphenIdx === -1 ? v : v.slice(0, hyphenIdx);
  const preStr = hyphenIdx === -1 ? null : v.slice(hyphenIdx + 1);

  const coreParts = coreStr.split(".");
  if (coreParts.length < 3) return null; // not at least N.N.N
  const core = coreParts.map(Number);
  if (core.some(isNaN)) return null; // non-numeric core component

  const pre = preStr ? preStr.split(".") : null;
  return { core, pre };
}

/**
 * Build the recovery lines for a backwards-boot refusal message.
 * Inspects the snapshot directory so the operator gets a runnable command
 * (or a clear "nothing to restore" message) instead of a literal placeholder.
 */
export function buildRecoveryLines(snapshotDir?: string): string[] {
  const effectiveSnapshotDir = snapshotDir ?? UPGRADE_SNAPSHOT_ROOT;
  const snapshots = readSnapshotFiles(effectiveSnapshotDir);

  if (snapshots.length === 0) {
    return [
      `To recover:`,
      `  No pre-upgrade snapshot was found.`,
      `  1. Reinstall the newer version:  npm install -g @tpsdev-ai/flair@latest`,
      `  2. Or restore from a flair backup export (if you have one).`,
      ``,
      `This check only helps from the release that ships it onward — it cannot`,
      `rescue a downgrade to a build that predates the stamp.`,
    ];
  }

  const newest = snapshots[0];
  const lines: string[] = [`To recover:`];

  if (snapshots.length > 1) {
    lines.push(
      `  1. Reinstall the newer version:  npm install -g @tpsdev-ai/flair@latest`,
      `  2. Or restore from the newest pre-upgrade snapshot:`,
      `     flair snapshot restore ${newest.path}`,
      ``,
      `     (To see all snapshots:  flair snapshot list)`,
    );
  } else {
    lines.push(
      `  1. Reinstall the newer version:  npm install -g @tpsdev-ai/flair@latest`,
      `  2. Or restore from the pre-upgrade snapshot:`,
      `     flair snapshot restore ${newest.path}`,
    );
  }

  lines.push(
    ``,
    `This check only helps from the release that ships it onward — it cannot`,
    `rescue a downgrade to a build that predates the stamp.`,
  );

  return lines;
}

/** Read snapshot files (.tar.gz), newest first. Lexical sort = chronological, because the
    filename carries an ISO 8601 timestamp (see upgradeSnapshotFileName). If that format ever
    changes, this sort must be revisited. */
function readSnapshotFiles(dir: string): Array<{ name: string; path: string }> {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith("flair-data-") && f.endsWith(".tar.gz"))
      .sort() // alphabetical = chronological (flair-data-<timestamp>.tar.gz)
      .reverse() // newest first
      .map((f) => ({ name: f, path: join(dir, f) }));
  } catch {
    return [];
  }
}
