/**
 * check-dep-ages-collect.mjs — pure functions for the supply-chain bake-time gate.
 *
 * These functions are exported for import by:
 * - scripts/check-dep-ages.mjs (the CLI entry point)
 * - test/unit/check-dep-ages.test.ts (the unit test suite)
 *
 * Internal `@tpsdev-ai/*` deps are exempt — we publish ourselves and the
 * 0.8.0 / 0.8.1 patch sequence already shipped same-day.
 *
 * This gate checks external, exact-pinned entries in both `dependencies` AND
 * `optionalDependencies`: npm and bun install optionalDependencies by default
 * (a failed install is non-fatal, not skipped), so they install just like any
 * other dep and represent the same supply-chain risk.
 *
 * `peerDependencies` are NOT checked: peers are resolved from a range by the
 * consumer's install, so an exact-pin check of our declaration does not
 * describe what actually gets installed.
 */

/**
 * Collect external, exact-pinned dep pairs to age-check from a list of
 * package objects. Checks both `dependencies` and `optionalDependencies`
 * — npm and bun both install optionalDependencies by default (a failed
 * install is non-fatal, not skipped), so they represent the same
 * supply-chain risk.
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
export function collectDeps(pkgs, keepCurrent) {
  const toCheck = new Map(); // key: "name@version", value: { name, version, declaredIn[] }

   /**
    * Process one dep object (dependencies or optionalDependencies).
    */
  function processDeps(deps) {
    for (const [name, version] of Object.entries(deps)) {
      if (name.startsWith("@tpsdev-ai/")) continue; // workspace-internal — exempt
      if (keepCurrent.has(name)) continue;             // explicitly kept-current — exempt
      if (typeof version !== "string") continue;
      if (version.startsWith("workspace:")) continue;
      if (version.startsWith("file:") || version.startsWith("link:")) continue;
      if (version.startsWith("git+") || version.startsWith("github:")) continue;
       // Only check exact-pinned. Range specifiers (^, ~, >=) are a different
       // class of risk — flagged separately by other tools — and resolving them
       // to a concrete version would require running an install, which is too
       // heavy for a fast CI gate.
      const exactVersion = /^\d/.test(version) ? version : null;
      if (!exactVersion) continue;
      const key = `${name}@${exactVersion}`;
      if (!toCheck.has(key)) {
        toCheck.set(key, { name, version: exactVersion, declaredIn: [] });
       }
      toCheck.get(key).declaredIn.push(deps._declaredIn);
      }
    }

  for (const { pkg, path } of pkgs) {
    if (pkg.dependencies) {
      processDeps({ ...pkg.dependencies, _declaredIn: path });
     }
    if (pkg.optionalDependencies) {
      processDeps({ ...pkg.optionalDependencies, _declaredIn: path });
     }
   }

  return toCheck;
}
