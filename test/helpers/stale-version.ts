/**
 * stale-version.ts — the shared "stale predecessor version" fixture helper.
 *
 * flair#1834: eleven test files each derived a stale pin version by decrementing
 * a parsed core inline, and most of them wrote it as:
 *
 *     core[2] > 0 ? "x.y.(z-1)" : "x.(y-1).0"
 *
 * That maps a patch-0 version with minor 0 — e.g. 1.0.0 — to "1.-1.0", which is
 * not a version at all. The correct predecessor of x.0.0 is (x-1).0.0. This is
 * the single implementation of the rule; callers assign their own fixture
 * variable (STALE_VER / OLD / BEHIND) from it.
 */

/** The version immediately below `core`: decrement the patch; else the minor
 *  (patch 0); else the major (minor and patch 0). Throws on 0.0.0, which has no
 *  stale predecessor — the old inline helper mapped it to the invalid
 *  "0.-1.0". */
export function staleVersion(core: [number, number, number]): string {
  const [major, minor, patch] = core;
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  if (minor > 0) return `${major}.${minor - 1}.0`;
  if (major > 0) return `${major - 1}.0.0`;
  throw new Error("cannot derive a stale version below 0.0.0");
}
