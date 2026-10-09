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

export interface NonExactDep {
  name: string;
  spec: string;
  declaredIn: string;
}

export interface UnsupportedOverride {
  declaredIn: string;
  /** Where the rule sits, e.g. `overrides["a"]["b"]`. */
  at: string;
  reason: string;
}

/** One rule of a manifest's `overrides`, nested rules included. */
export type OverrideRule =
  | { path: string[]; kind: "exact"; name: string; version: string }
  | { path: string[]; kind: "range"; name: string; spec: string }
  | { path: string[]; kind: "exempt"; name: string; spec: string }
  | { path: string[]; kind: "none"; name: string }
  | { path: string[]; kind: "refused"; reason: string };

/**
 * Classify every rule in one manifest's `overrides` value, nested rules
 * included, following npm's override grammar. Forms outside the supported
 * subset are returned as "refused" with a reason.
 */
export function classifyOverrides(overrides: unknown): OverrideRule[];

/**
 * Collect external, exact-pinned dep pairs to age-check from a list of
 * package objects. Checks `dependencies`, `optionalDependencies` and
 * `overrides` (root and every workspace package.json), nested override rules
 * included; refused override forms are not collected here.
 *
 * Exemptions: `@tpsdev-ai/*`, keep-current list, `workspace:`, `file:`/`link:`,
 * `git+`/`github:`. A `dependencies` / `optionalDependencies` entry is
 * classified by the same classifier the override grammar uses; only an exact
 * version is age-checked.
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

/**
 * The `dependencies`, `optionalDependencies` and `overrides` entries the
 * bake-time gate does not age-check because they are ranges. The CLI prints
 * them; the gate does not fail on them.
 */
export function collectNonExactDeps(
  pkgs: Array<{ pkg: Record<string, unknown>; path: string }>,
): NonExactDep[];

/**
 * The override rules in a form this gate does not support. The CLI refuses to
 * run while any exist.
 */
export function collectUnsupportedOverrides(
  pkgs: Array<{ pkg: Record<string, unknown>; path: string }>,
): UnsupportedOverride[];
