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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Filename of the engine-version stamp inside the data directory. */
export const ENGINE_VERSION_STAMP = "engine-version.txt";

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

  // Simple semver comparison: split on dots, compare numerically.
  // This is deliberately NOT a full semver parse — the stamp and the running
  // version both come from package.json `version` fields, which are always
  // semver strings. A full semver library would handle pre-release tags
  // correctly, but the failure mode of a naive compare (treating "5.2.0-rc1"
  // as newer than "5.2.0") is a false REFUSAL — safe direction.
  const stampParts = stamp.split(".").map(Number);
  const runningParts = runningVersion.split(".").map(Number);
  const len = Math.max(stampParts.length, runningParts.length);
  for (let i = 0; i < len; i++) {
    const s = stampParts[i] ?? 0;
    const r = runningParts[i] ?? 0;
    if (r < s) {
      return [
        `This Flair install is running Harper ${runningVersion}, but the data directory at`,
        `  ${dataDir}`,
        `was last written by Harper ${stamp} — a newer engine version.`,
        ``,
        `An older Harper cannot safely read a store written by a newer one.`,
        `The data may appear intact but can be silently unreadable.`,
        ``,
        `To recover:`,
        `  1. Reinstall the newer version:  npm install -g @tpsdev-ai/flair@latest`,
        `  2. Or restore from a pre-upgrade snapshot:`,
        `     flair snapshot restore ~/.flair/upgrade-snapshots/flair-data-<timestamp>.tar.gz`,
        ``,
        `This check only helps from the release that ships it onward — it cannot`,
        `rescue a downgrade to a build that predates the stamp.`,
      ].join("\n");
    }
    if (r > s) break; // running is newer — allowed
  }
  return null;
}
