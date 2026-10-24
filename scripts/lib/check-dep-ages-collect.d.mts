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

export interface RangedDep {
  kind: "dependency" | "override";
  /** The declared key, which the package is installed under (an `npm:` alias differs from `target`). */
  name: string;
  /** The registry package the declaration installs. */
  target: string;
  spec: string;
  declaredIn: string;
  /** Where the declaration sits, e.g. `dependencies["x"]` or `overrides["a"]["b"]`. */
  at: string;
  /** The manifest's directory; "" for the repo root. */
  workspaceDir: string;
  /** For a dependency range, the declaring manifest's `name`, which the lock's workspace entry must match. */
  manifestName?: string;
  /** For an override, its full key path from the top of `overrides`. */
  path?: Array<{ name: string; selector: string }>;
  /** For a dependency range, the field it was declared in. */
  field?: "dependencies" | "devDependencies" | "optionalDependencies";
}

export interface ResolvedRange {
  name: string;
  version: string;
  spec: string;
  declaredIn: string;
  at: string;
  kind: "dependency" | "override";
}

export interface UnresolvedRange {
  kind: "dependency" | "override";
  name: string;
  spec: string;
  declaredIn: string;
  at: string;
  reason: string;
}

export interface UninstalledOverride {
  kind: "override";
  name: string;
  spec: string;
  declaredIn: string;
  at: string;
}

export interface LockCopy {
  key: string;
  /** The name the copy is installed under (the last key segment). */
  name: string;
  segments: string[];
  /** The registry package the entry resolves (an `npm:` alias differs from `name`). */
  registryName: string;
  version: string;
  /** The dependency names the entry declares; null when the lock does not record them. */
  dependencies: string[] | null;
}

export interface BunLock {
  workspaces?: Record<string, { name?: string }>;
  packages?: Record<string, unknown>;
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
  | { path: string[]; kind: "range"; name: string; spec: string; target?: string }
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
 * classified by classifyDependencySpec, the override value classifier except
 * that "" and "*" are ranges (as overrides they override nothing); only an
 * exact version is collected here (collectRangedDeps collects ranges).
 *
 * `peerDependencies` are NOT checked (see the module comment in
 * check-dep-ages-collect.mjs).
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
 * Every ranged declaration the bake-time gate resolves through bun.lock:
 * ranges in `dependencies`, `devDependencies` and `optionalDependencies`, and
 * ranged `overrides` rules (nested rules included), from every given manifest.
 *
 * Exemptions: `@tpsdev-ai/*` and the keep-current list, matched on `target`,
 * so an `npm:` alias is exempt only when its target is.
 */
export function collectRangedDeps(
  pkgs: Array<{ pkg: Record<string, unknown>; path: string }>,
  keepCurrent: Set<string>,
): RangedDep[];

/** Parse bun.lock (JSON with trailing commas); an unparsable lock throws. */
export function parseBunLockText(text: string): BunLock;

/**
 * The lock's `workspaces` map, validated: an object whose keys are workspace
 * paths ("" or a relative path) and whose values are objects with a non-empty
 * string `name` and object dependency fields when present. Anything else throws.
 */
export function lockWorkspaces(lock: BunLock): Record<string, { name: string }>;

/** Index a parsed lockfile's `packages` by key and by installed name; an unreadable lock throws. */
export function lockCopies(lock: BunLock): {
  byKey: Map<string, LockCopy>;
  byName: Map<string, LockCopy[]>;
};

/**
 * Resolve every ranged declaration to the lockfile entries it installs. A
 * declaration the gate cannot resolve (including a dependency range whose
 * manifest has no entry in the lock's `workspaces`) is returned in
 * `unresolved`; an overrides range with no installed copy in its scope in
 * `uninstalled`.
 */
export function resolveRangedDeps(
  entries: RangedDep[],
  lock: BunLock,
): { resolved: ResolvedRange[]; unresolved: UnresolvedRange[]; uninstalled: UninstalledOverride[] };

export interface UnsupportedDep {
  declaredIn: string;
  field: "dependencies" | "devDependencies" | "optionalDependencies";
  name: string;
  spec: string;
  reason: string;
}

/**
 * The dependencies, devDependencies and optionalDependencies entries in a form
 * this gate does not support, a non-string specifier or a field that is not an
 * object. The CLI refuses to run while any exist.
 */
export function collectUnsupportedDeps(
  pkgs: Array<{ pkg: Record<string, unknown>; path: string }>,
): UnsupportedDep[];

/**
 * The override rules in a form this gate does not support. The CLI refuses to
 * run while any exist.
 */
export function collectUnsupportedOverrides(
  pkgs: Array<{ pkg: Record<string, unknown>; path: string }>,
): UnsupportedOverride[];
