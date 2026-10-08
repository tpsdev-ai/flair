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
 * This gate checks external, exact-pinned entries in `dependencies`,
 * `optionalDependencies` AND `overrides` (root and every workspace
 * package.json).
 * - `dependencies` / `optionalDependencies`: npm and bun install
 *   optionalDependencies by default (a failed install is non-fatal, not
 *   skipped), so they install just like any other dep and represent the same
 *   supply-chain risk.
 * - `overrides`: an entry here pins the version a transitive dep resolves to,
 *   so a fresh version can enter the tree without appearing in any
 *   `dependencies`. An `npm:` alias pins a different package than its key;
 *   the alias TARGET is what installs, so it is the version age-checked.
 *
 * Exemptions, in all three fields: `@tpsdev-ai/*`, the keep-current list,
 * `workspace:`, `file:`/`link:`, `git+`/`github:`, and non-exact ranges.
 *
 * `peerDependencies` are NOT checked: peers are resolved from a range by the
 * consumer's install, so an exact-pin check of our declaration does not
 * describe what actually gets installed.
 */

/** Specifiers that name no registry version, so there is no publish date to check. */
function isNonRegistrySpecifier(spec) {
  return (
    spec.startsWith("workspace:") ||
    spec.startsWith("file:") ||
    spec.startsWith("link:") ||
    spec.startsWith("git+") ||
    spec.startsWith("github:")
  );
}

/**
 * The (name, version) an override entry installs, when it is an exact pin.
 * Returns null for a range, a non-registry specifier, or a nested override
 * object (npm's nested form pins versions too, but this gate reads the flat
 * form the exact-overrides check also reads).
 */
function exactOverridePin(key, spec) {
  if (typeof spec !== "string") return null;
  if (isNonRegistrySpecifier(spec)) return null;
  if (spec.startsWith("npm:")) {
    const rest = spec.slice("npm:".length);
    const at = rest.lastIndexOf("@");
    if (at <= 0) return null;
    const name = rest.slice(0, at);
    const version = rest.slice(at + 1);
    return /^\d/.test(version) ? { name, version } : null;
  }
  return /^\d/.test(spec) ? { name: key, version: spec } : null;
}

/**
 * Collect external, exact-pinned dep pairs to age-check from a list of
 * package objects. Checks `dependencies`, `optionalDependencies` and
 * `overrides`.
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

  function record(name, version, declaredIn) {
    if (name.startsWith("@tpsdev-ai/")) return; // workspace-internal — exempt
    if (keepCurrent.has(name)) return; // explicitly kept-current — exempt
    if (version.startsWith("workspace:")) return;
    if (version.startsWith("file:") || version.startsWith("link:")) return;
    if (version.startsWith("git+") || version.startsWith("github:")) return;
    // Only check exact-pinned. Range specifiers (^, ~, >=) are a different
    // class of risk — flagged separately by other tools — and resolving them
    // to a concrete version would require running an install, which is too
    // heavy for a fast CI gate.
    if (!/^\d/.test(version)) return;
    const key = `${name}@${version}`;
    if (!toCheck.has(key)) {
      toCheck.set(key, { name, version, declaredIn: [] });
    }
    const entry = toCheck.get(key);
    if (!entry.declaredIn.includes(declaredIn)) entry.declaredIn.push(declaredIn);
  }

  function recordDeps(deps, declaredIn) {
    for (const [name, version] of Object.entries(deps)) {
      if (typeof version !== "string") continue;
      record(name, version, declaredIn);
    }
  }

  for (const { pkg, path } of pkgs) {
    if (pkg.dependencies) recordDeps(pkg.dependencies, path);
    if (pkg.optionalDependencies) recordDeps(pkg.optionalDependencies, path);
    if (pkg.overrides) {
      for (const [key, spec] of Object.entries(pkg.overrides)) {
        const pin = exactOverridePin(key, spec);
        if (pin) record(pin.name, pin.version, path);
      }
    }
  }

  return toCheck;
}

/**
 * The override specifiers the bake-time gate cannot age-check: range
 * specifiers, which resolve to a concrete version only at install time. They
 * are REPORTED by the CLI so a non-exact override never passes silently; the gate does not
 * fail on them (the exact-overrides check is what refuses a declared key).
 *
 * @param pkgs — package objects with paths
 * @returns Array<{ name, spec, declaredIn }>
 */
export function collectNonExactOverrides(pkgs) {
  const gaps = [];
  for (const { pkg, path } of pkgs) {
    if (!pkg.overrides) continue;
    for (const [name, spec] of Object.entries(pkg.overrides)) {
      if (typeof spec !== "string") continue;
      if (isNonRegistrySpecifier(spec)) continue;
      if (exactOverridePin(name, spec)) continue;
      gaps.push({ name, spec, declaredIn: path });
    }
  }
  return gaps;
}
