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
 *
 * Honest-numbers refinement (flair#1341): the TTL fast-path is only taken
 * when the cached answer implies NOTHING will be printed. When a cached
 * answer would produce a nudge, we spend one fresh fetch (same short timeout,
 * same failure tolerance) so the printed fact is current whenever possible —
 * nudges are rare, so the TTL still protects the common up-to-date path. If
 * that fetch fails, the nudge falls back to the cached value but SAYS so
 * ("latest known (checked 9h ago): …") instead of stating a stale number as
 * current fact.
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
  /**
   * Age of the cached answer at the time of the check, in ms. Present exactly
   * when source is "cache" — it lets the nudge say "checked 9h ago" instead
   * of presenting a possibly-stale number as current fact (flair#1341).
   */
  checkedAgoMs?: number;
}

/**
 * Resolve the latest published @tpsdev-ai/flair version, preferring a fresh
 * cache hit over a network round trip, and falling back to a stale cache (or
 * giving up quietly) when the registry is unreachable. NEVER throws.
 *
 * flair#1341: the cache fast-path applies only when the cached answer implies
 * no nudge. A cached answer that WOULD nudge triggers one fresh fetch (same
 * timeout, same failure tolerance) so the printed fact is current whenever
 * the network allows; on failure it falls back to the cache, age attached.
 */
export async function checkVersion(
  installed: string,
  injected: Partial<VersionCheckDeps> = {},
): Promise<VersionCheckResult> {
  const deps: VersionCheckDeps = { ...defaultVersionCheckDeps(), ...injected };
  const nowMs = deps.now();

  const cached = deps.readCache(deps.cachePath);
  if (cached && nowMs - cached.checkedAt < deps.ttlMs) {
    if (classifyGap(installed, cached.latest).severity === "none") {
      return { installed, latest: cached.latest, source: "cache", checkedAgoMs: nowMs - cached.checkedAt };
    }
    // The cached answer would print a nudge — fall through to one fresh
    // fetch so we present a CURRENT fact when possible. The failure path
    // below still falls back to this same cache (offline tolerance intact).
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

  // Registry unreachable/timed out — fall back to the cache rather than
  // reporting nothing, but never block or throw trying to get a fresh one.
  if (cached) {
    return { installed, latest: cached.latest, source: "cache", checkedAgoMs: nowMs - cached.checkedAt };
  }
  return { installed, latest: null, source: "unavailable" };
}

/**
 * Primes the version-check cache with an already-known `latest` — e.g. right
 * after `flair upgrade` fetches the true latest fresh via its own direct
 * registry call, so the NEXT `checkVersion` (from `flair status`/`doctor`)
 * reflects it immediately instead of serving a stale cached value for up to
 * `DEFAULT_TTL_MS`. Reuses `writeCacheFile`, which is already best-effort/
 * never-throws — a failed cache write must never surface as a command error.
 */
export function primeVersionCheckCache(
  latest: string,
  injected: Partial<Pick<VersionCheckDeps, "cachePath" | "now">> = {},
): void {
  const cachePath = injected.cachePath ?? DEFAULT_CACHE_PATH;
  const now = injected.now ?? (() => Date.now());
  writeCacheFile(cachePath, { latest, checkedAt: now() });
}

// ─── Severity heuristic (no advisory data — gap-based, see module doc) ──────

export type VersionGapSeverity = "none" | "yellow" | "red";

export interface VersionGap {
  severity: VersionGapSeverity;
  /** True when `latest` is a newer MAJOR than `installed`. */
  majorBehind: boolean;
  /**
   * What `versionsBehind` counted: minor versions, or patch releases within
   * the same minor. Null when majorBehind is true (minor numbering resets
   * across a major bump, so no count is meaningful) or severity is "none".
   * The nudge label MUST name this unit — "N releases behind" computed from
   * a minor delta was the flair#1341 lie.
   */
  unit: "minor" | "patch" | null;
  /**
   * Count of minor versions behind (unit "minor") or patch releases behind
   * (unit "patch" — patch delta IS the release count within a minor: our
   * release history publishes patches sequentially, e.g. v0.44.0…v0.44.13
   * with no gaps). Not meaningful when unit is null.
   */
  versionsBehind: number;
}

const NO_GAP: VersionGap = { severity: "none", majorBehind: false, unit: null, versionsBehind: 0 };

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

  if (bMaj > aMaj) return { severity: "red", majorBehind: true, unit: null, versionsBehind: 0 };
  if (bMaj < aMaj) return NO_GAP; // installed is ahead (e.g. local/pre-release build)

  if (bMin > aMin) {
    const versionsBehind = bMin - aMin;
    return { severity: versionsBehind >= 2 ? "red" : "yellow", majorBehind: false, unit: "minor", versionsBehind };
  }
  if (bMin < aMin) return NO_GAP; // ahead on minor

  if (bPatch > aPatch) {
    return { severity: "yellow", majorBehind: false, unit: "patch", versionsBehind: bPatch - aPatch };
  }
  return NO_GAP; // equal, or ahead on patch
}

export interface VersionNudge {
  severity: "yellow" | "red";
  message: string;
}

/** Compact human age for "checked … ago" — coarse on purpose (a nudge, not a log). */
function formatCheckedAgo(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/**
 * Build the human-readable nudge line for `flair status`/`flair doctor`, or
 * null when there's nothing worth printing — current, ahead (local/dev
 * build), or we couldn't determine latest at all (offline with no cache).
 * Callers own icon/color; this returns plain text plus a severity to color by.
 *
 * flair#1341 honest-numbers contract:
 *   - A cache-sourced answer is labelled as such ("latest known (checked 9h
 *     ago): X"), never stated as current fact.
 *   - The count names its unit ("N minor versions behind" / "M patch
 *     releases behind") — it must say what classifyGap actually counted.
 *   - The suggested command is our paved path, `flair upgrade` (refreshes
 *     MCP pins, verifies restart — see flair#1324), not a bare npm install.
 */
export function formatVersionNudge(result: VersionCheckResult): VersionNudge | null {
  if (!result.latest) return null;
  const gap = classifyGap(result.installed, result.latest);
  if (gap.severity === "none") return null;

  const latestClaim =
    result.source === "cache"
      ? result.checkedAgoMs != null
        ? `latest known (checked ${formatCheckedAgo(result.checkedAgoMs)} ago): ${result.latest}`
        : `latest known: ${result.latest}`
      : `latest is ${result.latest}`;
  const plural = gap.versionsBehind === 1 ? "" : "s";
  const countHint = gap.majorBehind
    ? "major version behind"
    : gap.unit === "patch"
      ? `${gap.versionsBehind} patch release${plural} behind`
      : `${gap.versionsBehind} minor version${plural} behind`;
  const message =
    `flair ${result.installed} is behind — ${latestClaim} (${countHint}). ` +
    `Run: flair upgrade`;
  return { severity: gap.severity, message };
}

/**
 * The version an INSTANCE reports, or null when it cannot be determined.
 *
 * flair#1072. Every other line `doctor` prints about a remote target is
 * genuinely remote; the currency claim was about the local CLI. This asks the
 * instance instead.
 *
 * Returns null — never a fallback — when the instance is unreachable, answers
 * without a version, or times out. The whole defect being fixed is a fallback
 * to the number already in hand, and an older instance that does not expose its
 * version is exactly the case where that fallback is most tempting and most
 * wrong. A caller that gets null must say "unknown", not substitute its own
 * version.
 *
 * Deliberately short-timeout and failure-swallowing: doctor runs against
 * possibly-down instances by design, and "cannot determine" is a legitimate,
 * reportable answer rather than an error to propagate.
 */
export async function probeInstanceVersion(
  baseUrl: string,
  timeoutMs = 5000,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const url = `${String(baseUrl).replace(/\/+$/, "")}/Health`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (!body || typeof body !== "object") return null;
    const v = (body as Record<string, unknown>).version;
    // "dev" and other non-semver markers are real answers from a real server,
    // but they cannot be compared against a published version. Treat them as
    // undeterminable rather than feeding them to a semver comparison — a
    // Fabric peer mid-failed-deploy reports exactly this (harper#2061).
    if (typeof v !== "string" || !/^\d+\.\d+\.\d+/.test(v)) return null;
    return v;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
