/**
 * version-check.ts — offline-tolerant, cached check of whether the installed
 * @tpsdev-ai/flair is behind the latest published npm release.
 *
 * Motivation (flair#587): a laptop install sat on 0.16.1 through v0.17.0 and
 * v0.19.0 (P0 security fixes) and v0.18.0 (memory-integrity fix) — `flair
 * status` reported "✓ all checks passing" the whole time. Nothing anywhere
 * in the CLI told the operator they were behind. `flair status` and `flair
 * doctor` both wire this in.
 *
 * Non-negotiable design constraints — this must never make status/doctor
 * WORSE:
 *   - Offline-tolerant: a failed/timed-out registry fetch falls back to a
 *     stale cache, or is skipped entirely. NEVER throws, NEVER hangs (short
 *     fetch timeout).
 *   - Cached with a TTL so a healthy network doesn't cost a registry round
 *     trip on every single `flair status`/`flair doctor` invocation.
 *   - No advisory data — we don't know which release fixed which CVE, so the
 *     severity heuristic is purely the version GAP (major/minor count), not
 *     "did this release carry a security fix". See classifyGap().
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseSemverCore } from "./fabric-upgrade.js";

export const FLAIR_PKG_NAME = "@tpsdev-ai/flair";
export const DEFAULT_CACHE_PATH = join(homedir(), ".flair", ".version-check-cache.json");
/** How long a cached "latest" answer is trusted before we re-hit the registry. */
export const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 12h
/** Registry fetch timeout — this runs on every status/doctor call, so it must stay short. */
export const DEFAULT_TIMEOUT_MS = 3000;

interface CacheFile {
  latest: string;
  checkedAt: number; // epoch ms
}

function readCacheFile(path: string): CacheFile | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof raw?.latest === "string" && typeof raw?.checkedAt === "number") {
      return { latest: raw.latest, checkedAt: raw.checkedAt };
    }
    return null;
  } catch {
    // Corrupt/unreadable cache — treat as absent, never throw.
    return null;
  }
}

function writeCacheFile(path: string, entry: CacheFile): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(entry), "utf-8");
  } catch {
    // Best-effort — a cache-write failure must never surface as a
    // status/doctor error (e.g. read-only $HOME).
  }
}

async function defaultFetchLatest(timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${FLAIR_PKG_NAME}/latest`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return typeof data?.version === "string" ? data.version : null;
  } catch {
    // Offline, DNS failure, timeout, registry 5xx, bad JSON — all the same:
    // we couldn't determine "latest" over the network this time.
    return null;
  }
}

// ─── Injectable seams (so tests never hit the network or the real $HOME) ────

export interface VersionCheckDeps {
  /** Fetch the latest published version string, or null on any failure. */
  fetchLatest: (timeoutMs: number) => Promise<string | null>;
  /** Cache file path. */
  cachePath: string;
  /** Cache TTL in ms. */
  ttlMs: number;
  /** Registry fetch timeout in ms. */
  timeoutMs: number;
  /** Clock — injectable for TTL tests. */
  now: () => number;
  readCache: (path: string) => CacheFile | null;
  writeCache: (path: string, entry: CacheFile) => void;
}

export function defaultVersionCheckDeps(): VersionCheckDeps {
  return {
    fetchLatest: defaultFetchLatest,
    cachePath: DEFAULT_CACHE_PATH,
    ttlMs: DEFAULT_TTL_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    now: () => Date.now(),
    readCache: readCacheFile,
    writeCache: writeCacheFile,
  };
}

export type VersionCheckSource = "cache" | "network" | "unavailable";

export interface VersionCheckResult {
  installed: string;
  /** Latest known published version, or null if we have neither a fresh fetch nor any cache. */
  latest: string | null;
  source: VersionCheckSource;
}

/**
 * Resolve the latest published @tpsdev-ai/flair version, preferring a fresh
 * cache hit over a network round trip, and falling back to a stale cache (or
 * giving up quietly) when the registry is unreachable. NEVER throws.
 */
export async function checkVersion(
  installed: string,
  injected: Partial<VersionCheckDeps> = {},
): Promise<VersionCheckResult> {
  const deps: VersionCheckDeps = { ...defaultVersionCheckDeps(), ...injected };
  const nowMs = deps.now();

  const cached = deps.readCache(deps.cachePath);
  if (cached && nowMs - cached.checkedAt < deps.ttlMs) {
    return { installed, latest: cached.latest, source: "cache" };
  }

  // Defense-in-depth: the default fetchLatest already catches everything
  // internally (network error, timeout, non-2xx, bad JSON) and resolves
  // null rather than rejecting. This try/catch guards the contract even if
  // a caller-injected fetchLatest misbehaves and throws/rejects instead —
  // status/doctor must never crash or hang on a version check either way.
  let fetched: string | null = null;
  try {
    fetched = await deps.fetchLatest(deps.timeoutMs);
  } catch {
    fetched = null;
  }
  if (fetched) {
    deps.writeCache(deps.cachePath, { latest: fetched, checkedAt: nowMs });
    return { installed, latest: fetched, source: "network" };
  }

  // Registry unreachable/timed out — fall back to a stale cache rather than
  // reporting nothing, but never block or throw trying to get a fresh one.
  if (cached) {
    return { installed, latest: cached.latest, source: "cache" };
  }
  return { installed, latest: null, source: "unavailable" };
}

// ─── Severity heuristic (no advisory data — gap-based, see module doc) ──────

export type VersionGapSeverity = "none" | "yellow" | "red";

export interface VersionGap {
  severity: VersionGapSeverity;
  /** True when `latest` is a newer MAJOR than `installed`. */
  majorBehind: boolean;
  /**
   * Count of minor versions behind (when majorBehind is false and minors
   * differ), or patch versions behind (when only the patch differs). Not
   * meaningful when majorBehind is true (minor numbering resets across a
   * major bump) or severity is "none".
   */
  releasesBehind: number;
}

const NO_GAP: VersionGap = { severity: "none", majorBehind: false, releasesBehind: 0 };

/**
 * Classify how far `installed` is behind `latest` using major.minor.patch
 * math only — we don't have advisory data, so:
 *   - any major version behind, or ≥2 minor versions behind → "red" (loud;
 *     heuristic for "you've likely missed a security fix")
 *   - a single minor version behind, or a patch-only gap → "yellow"
 *   - equal, ahead, or unparseable → "none"
 */
export function classifyGap(installed: string, latest: string): VersionGap {
  const a = parseSemverCore(installed);
  const b = parseSemverCore(latest);
  if (!a || !b) return NO_GAP;

  const [aMaj, aMin, aPatch] = a;
  const [bMaj, bMin, bPatch] = b;

  if (bMaj > aMaj) return { severity: "red", majorBehind: true, releasesBehind: 0 };
  if (bMaj < aMaj) return NO_GAP; // installed is ahead (e.g. local/pre-release build)

  if (bMin > aMin) {
    const releasesBehind = bMin - aMin;
    return { severity: releasesBehind >= 2 ? "red" : "yellow", majorBehind: false, releasesBehind };
  }
  if (bMin < aMin) return NO_GAP; // ahead on minor

  if (bPatch > aPatch) return { severity: "yellow", majorBehind: false, releasesBehind: bPatch - aPatch };
  return NO_GAP; // equal, or ahead on patch
}

export interface VersionNudge {
  severity: "yellow" | "red";
  message: string;
}

/**
 * Build the human-readable nudge line for `flair status`/`flair doctor`, or
 * null when there's nothing worth printing — current, ahead (local/dev
 * build), or we couldn't determine latest at all (offline with no cache).
 * Callers own icon/color; this returns plain text plus a severity to color by.
 */
export function formatVersionNudge(result: VersionCheckResult): VersionNudge | null {
  if (!result.latest) return null;
  const gap = classifyGap(result.installed, result.latest);
  if (gap.severity === "none") return null;

  const countHint = gap.majorBehind
    ? "major version"
    : `${gap.releasesBehind} release${gap.releasesBehind === 1 ? "" : "s"}`;
  const message =
    `flair ${result.installed} is behind — latest is ${result.latest} (${countHint} behind). ` +
    `Upgrade: npm i -g ${FLAIR_PKG_NAME}@latest`;
  return { severity: gap.severity, message };
}
