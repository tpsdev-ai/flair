/** Types for scripts/check-dep-ages.mjs. */

export function collectDeps(
  pkgs: Array<{ pkg: Record<string, unknown>; path: string }>,
  keepCurrent: Set<string>,
): Map<string, { name: string; version: string; declaredIn: string[] }>;
