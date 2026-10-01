/**
 * Pure functions for the supply-chain bake-time gate.
 *
 * Exported from scripts/lib/check-dep-ages-collect.mjs for both the CLI entry
 * (scripts/check-dep-ages.mjs) and the unit test suite (test/unit/check-dep-ages.test.ts).
 */

export interface DepEntry {
  name: string;
  version: string;
  declaredIn: string[];
}

/**
 * Collect external, exact-pinned dep pairs to age-check from a list of
 * package objects. Checks both `dependencies` and `optionalDependencies`.
 *
 * Exemptions: `@tpsdev-ai/*`, keep-current list, `workspace:`, `file:`/`link:`,
 * `git+`/`github:`, and non-exact ranges.
 *
 * `peerDependencies` are NOT checked: peers are resolved from a range by the
 * consumer's install, so an exact-pin check of our declaration does not
 * describe what actually gets installed.
 *
 * @param pkgs — package objects with paths
 * @param keepCurrent — the keep-current allow-list
 * @returns Map<"name@version", { name, version, declaredIn }>
 */
export function collectDeps(
  pkgs: Array<{ pkg: Record<string, unknown>; path: string }>,
  keepCurrent: Set<string>,
): Map<string, DepEntry>;
