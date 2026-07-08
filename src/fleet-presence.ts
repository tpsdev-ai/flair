// ─── Doctor: fleet presence / instance staleness (flair#639) ────────────────────
//
// `flair doctor` diagnosed a single instance only. Auto-presence (flair#608)
// gives every agent a heartbeat, and each heartbeat now carries the SERVING
// instance's own flair + harper version (resources/Presence.ts,
// buildPresenceRecord()) — so the /Presence roster doubles as an org-level
// fleet-version report, IF something reads it that way. This module is that
// reading: pure classification over an already-fetched roster, no network,
// no crypto, so it's fast and fully unit-testable in isolation — same split
// as doctor-client.ts (pure logic here; the network fetch + Ed25519 signing
// stay in src/cli.ts alongside authFetch/buildEd25519Auth, which they reuse).
//
// Deliberately NOT npm-latest aware: comparing against the newest version
// PUBLISHED is version-nudge's job (src/version-check.ts, flair#587/#594).
// This is comparing instances against EACH OTHER — "is anyone behind the
// rest of the fleet" — which stays meaningful even fully offline, and is the
// question flair#639 actually asks: an org-level answer without probing
// every host by hand.
//
// Semver comparison reuses fabric-upgrade.ts's parseSemverCore/semverGte
// (major.minor.patch only, pre-release/build suffixes ignored) — the one
// semver implementation in this codebase; duplicating it here would risk the
// two drifting on an edge case.

import { parseSemverCore, semverGte } from "./fabric-upgrade.js";

/**
 * One row of the /Presence roster relevant to fleet-version classification.
 * Deliberately a subset (not the full roster shape) — callers pass whatever
 * they fetched; extra fields are ignored, missing optional fields are
 * tolerated (an older, pre-flair#639 instance never wrote flairVersion at
 * all — that's the fleet-skew reality this feature exists to surface).
 */
export interface FleetPresenceRow {
  id: string;
  flairVersion?: string | null;
  harperVersion?: string | null;
  lastHeartbeatAt?: number | null;
  presenceStatus?: string;
  // Natural-presence activity fields (roster GET). `activity` is the CURRENT
  // activity ("idle" once decayed); `lastActivity` is the raw last-known label;
  // `activityFresh` is the server's freshness verdict. All optional — a
  // pre-feature roster omits them, and the doctor renderer tolerates absence.
  activity?: string | null;
  lastActivity?: string | null;
  activityFresh?: boolean;
}

export interface FleetInstanceRow extends FleetPresenceRow {
  /** True when this row is behind the newest version seen across the roster. */
  stale: boolean;
  /** Newest flairVersion seen across the WHOLE roster, or null if none reported one. */
  newestVersion: string | null;
}

/** True only for a non-empty, parseable semver string — the one predicate every
 *  function below needs, so it lives in exactly one place. */
function hasParsableVersion(v: string | null | undefined): v is string {
  return typeof v === "string" && parseSemverCore(v) !== null;
}

/**
 * Newest flairVersion seen across the roster. Entries with no (or an
 * unparseable) version are excluded from the computation — an unversioned
 * record can't be compared, so it can't set the bar. Returns null when NO
 * entry in the roster reports a parseable version (nothing to compare
 * against — e.g. a fleet that's entirely pre-flair#639, or a roster with a
 * single unversioned instance).
 */
export function newestVersionSeen(rows: FleetPresenceRow[]): string | null {
  let newest: string | null = null;
  for (const row of rows) {
    if (!hasParsableVersion(row.flairVersion)) continue;
    if (newest === null || semverGte(row.flairVersion, newest)) newest = row.flairVersion;
  }
  return newest;
}

/**
 * Flag each roster row as stale relative to the newest flairVersion seen
 * ACROSS THE WHOLE ROSTER (never against npm-latest — see module doc). A row
 * is stale when:
 *   - the roster has SOME newest version to compare against (newest !== null)
 *     AND
 *   - this row has no parseable version of its own (an older, pre-flair#639
 *     instance — the loudest possible skew signal), OR its version is older
 *     than the newest seen.
 *
 * A single-instance roster, or a roster where every instance reports the
 * IDENTICAL version, has nothing to compare against → newest equals every
 * row's own version (or is null) → nothing is flagged stale. A roster where
 * NO instance has ever reported a version (newest === null) similarly flags
 * nothing — there's no fleet-relative signal yet, only an org-wide gap this
 * function can't see (that's what the "pass --agent to reveal versions" /
 * "no versions reported yet" doctor messaging is for, not staleness).
 */
export function markStale(rows: FleetPresenceRow[]): FleetInstanceRow[] {
  const newest = newestVersionSeen(rows);
  return rows.map((row) => {
    const stale = newest !== null && (!hasParsableVersion(row.flairVersion) || !semverGte(row.flairVersion, newest));
    return { ...row, stale, newestVersion: newest };
  });
}

/**
 * Sort oldest-version-first so problems top the listing (flair#639's stated
 * requirement). Rows with no parseable version sort FIRST — an unversioned
 * instance is the biggest unknown in the fleet, not a middling one, and
 * markStale() always flags it stale whenever the roster has any signal at
 * all, so surfacing it first keeps the "problems on top" contract even when
 * mixed with real-but-old versions. Ties (equal versions) preserve roster
 * order (stable sort).
 */
export function sortOldestVersionFirst<T extends { flairVersion?: string | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const pa = hasParsableVersion(a.flairVersion) ? parseSemverCore(a.flairVersion) : null;
    const pb = hasParsableVersion(b.flairVersion) ? parseSemverCore(b.flairVersion) : null;
    if (!pa && !pb) return 0;
    if (!pa) return -1;
    if (!pb) return 1;
    for (let i = 0; i < 3; i++) {
      if (pa[i] !== pb[i]) return pa[i] - pb[i];
    }
    return 0;
  });
}
