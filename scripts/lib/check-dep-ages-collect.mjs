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
 * - `overrides`: exact declarations are age-checked, including conditional
 *   rules; the gate reads declarations, not installed versions. An `npm:`
 *   alias is checked against its target. Nested override objects are read too.
 *
 * Exemptions, in all three fields: `@tpsdev-ai/*`, the keep-current list,
 * `workspace:`, `file:`/`link:`, `git+`/`github:`, and ranges (in
 * `dependencies` and `optionalDependencies`, a version not starting with a
 * digit).
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

// ── Override grammar ───────────────────────────────────────────────────────
//
// npm's `overrides` grammar (@npmcli/arborist OverrideSet, npm-package-arg):
// - a key names a package, optionally with a version selector ("name@^1");
// - a value is a specifier string, or an object whose "." key overrides the
//   package itself and whose other keys override its dependencies (nested);
// - an object without a "." key overrides the package with its key's selector
//   ("*" when there is none, which overrides nothing).
// A value is classified the way npm-package-arg classifies a registry spec: an
// exact version, a range, or something else. classifyOverrides refuses, with a
// reason, every rule it cannot classify as exact, range, exempt or none.
// test/unit/check-dep-ages-npm-conformance.test.ts checks this against a
// recording of npm's own parser.

/** A canonical exact version: MAJOR.MINOR.PATCH with an optional prerelease. */
const EXACT_VERSION_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;
/** semver's LOOSE version pattern ("v1.0.0", "=1.0.0", "1.0.0+build"). */
const LOOSE_VERSION_RE =
  /^[v=\s]*\d+\.\d+\.\d+(?:-?[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const XR = "(?:\\d+|[xX*])";
const PARTIAL = `[v=]*${XR}(?:\\.${XR}(?:\\.${XR}(?:-?[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?)?)?`;
const COMPARATOR_RE = new RegExp(`^(?:<=?|>=?|=|~>?|\\^)?${PARTIAL}$`);
const HYPHEN_RANGE_RE = new RegExp(`^${PARTIAL}\\s+-\\s+${PARTIAL}$`);
/** npm package names, scoped or not (old-package names may use capitals). */
const PACKAGE_NAME_RE = /^(?:@[A-Za-z0-9~-][A-Za-z0-9._~-]*\/)?[A-Za-z0-9~-][A-Za-z0-9._~-]*$/;

/** A semver range ("^1", "1.x", "1 - 2", ">= 1.0.0 <2", "1.0.0 || 2.0.0"). */
function isRange(spec) {
  return spec.split("||").every((set) => {
    const s = set.trim();
    if (s === "" || HYPHEN_RANGE_RE.test(s)) return true;
    // semver lets an operator be separated from its version by spaces.
    return s
      .replace(/(<=?|>=?|=|~>?|\^)\s+/g, "$1")
      .split(/\s+/)
      .every((c) => COMPARATOR_RE.test(c));
  });
}

const refused = (reason) => ({ kind: "refused", reason });

/** Classify a registry specifier: exact, range, or refused. */
function classifyRegistrySpec(name, spec) {
  if (EXACT_VERSION_RE.test(spec)) return { kind: "exact", name, version: spec };
  if (LOOSE_VERSION_RE.test(spec)) {
    return refused(`"${spec}" is a version in a non-canonical form; write it as MAJOR.MINOR.PATCH`);
  }
  if (isRange(spec)) return { kind: "range", name, spec };
  return refused(`"${spec}" is not an exact version, a semver range or an npm: alias of one`);
}

/** Parse an override key into its package name and version selector, or null. */
function parseOverrideKey(key) {
  // npm reads these shapes as a URL, a git remote or a file, which name no package.
  if (/^(?:git[+])?[a-z]+:/i.test(key) || /^[^@]+@[^:.]+\.[^:]+:.+$/i.test(key)) return null;
  const at = key.indexOf("@", 1);
  const name = at > 0 ? key.slice(0, at) : key;
  const selector = at > 0 ? key.slice(at + 1) || "*" : "*";
  if (!PACKAGE_NAME_RE.test(name) || /[.](?:tgz|tar)$/i.test(name)) return null;
  return { name, selector };
}

/** Classify one override value (a string) for the package `name`. */
function classifyOverrideValue(name, spec) {
  // npm reads "" as "*", and a "*" value overrides nothing.
  if (spec === "" || spec === "*") return { kind: "none", name };
  if (spec !== spec.trim()) return refused(`"${spec}" has surrounding whitespace`);
  if (spec.startsWith("$")) return refused(`"${spec}" is a $ reference, which this gate does not resolve`);
  if (isNonRegistrySpecifier(spec)) return { kind: "exempt", name, spec };
  if (spec.startsWith("npm:")) {
    const rest = spec.slice("npm:".length);
    const at = rest.indexOf("@", 1);
    const target = at > 0 ? rest.slice(0, at) : rest;
    const sub = at > 0 ? rest.slice(at + 1) || "*" : "*";
    if (!PACKAGE_NAME_RE.test(target)) return refused(`"${spec}" does not alias a registry package`);
    const subClass = sub === "*" ? { kind: "range" } : classifyRegistrySpec(target, sub);
    if (subClass.kind === "exact") return subClass;
    if (subClass.kind === "range") return { kind: "range", name, spec };
    return refused(`"${spec}": ${subClass.reason}`);
  }
  return classifyRegistrySpec(name, spec);
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const describeType = (v) => (v === null ? "null" : Array.isArray(v) ? "an array" : `a ${typeof v}`);

/**
 * Classify every rule in one manifest's `overrides` value, nested rules
 * included. Each rule is { path, kind, ... } where `path` is the list of keys
 * from the top of `overrides` and `kind` is one of:
 * - "exact": `name`@`version` installs (an alias reports its target);
 * - "range": `name` is overridden with the range `spec`;
 * - "exempt": `spec` names no registry version (workspace:, file:, link:, git+, github:);
 * - "none": the rule overrides nothing (a "*" or "" value);
 * - "refused": a form this gate does not support, with a `reason`.
 */
export function classifyOverrides(overrides) {
  const rules = [];
  if (!isPlainObject(overrides)) {
    rules.push({ path: [], ...refused(`"overrides" must be an object, not ${describeType(overrides)}`) });
    return rules;
  }
  const walk = (obj, parentPath) => {
    for (const [key, value] of Object.entries(obj)) {
      const path = [...parentPath, key];
      if (key === ".") {
        // The enclosing rule's own value; at the top level it names no package.
        if (parentPath.length === 0) rules.push({ path, ...refused(`a "." key at the top level names no package`) });
        continue;
      }
      const parsed = parseOverrideKey(key);
      if (!parsed) {
        rules.push({ path, ...refused(`the key "${key}" does not name a package`) });
        continue;
      }
      if (typeof value === "string") {
        rules.push({ path, ...classifyOverrideValue(parsed.name, value) });
      } else if (isPlainObject(value)) {
        const own = Object.hasOwn(value, ".") ? value["."] : parsed.selector;
        rules.push({
          path,
          ...(typeof own === "string"
            ? classifyOverrideValue(parsed.name, own)
            : refused(`its "." value must be a string, not ${describeType(own)}`)),
        });
        walk(value, path);
      } else {
        rules.push({ path, ...refused(`the value must be a string or an object, not ${describeType(value)}`) });
      }
    }
  };
  walk(overrides, []);
  return rules;
}

/** `overrides["a"]["b"]` — where a rule sits in its manifest. */
function formatOverridePath(path) {
  return `overrides${path.map((k) => `[${JSON.stringify(k)}]`).join("")}`;
}

/**
 * Collect external, exact-pinned dep pairs to age-check from a list of
 * package objects. Checks `dependencies`, `optionalDependencies` and
 * `overrides`, nested override rules included; refused override forms are
 * not collected here (collectUnsupportedOverrides lists them).
 *
 * Exemptions: `@tpsdev-ai/*`, keep-current list, `workspace:`, `file:`/`link:`,
 * `git+`/`github:`, and ranges (in `dependencies` and `optionalDependencies`,
 * a version not starting with a digit).
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
    // Only check exact-pinned. This gate reads manifests, not the lockfile;
    // the version a range resolves to is outside its scope.
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
    if (pkg.overrides !== undefined) {
      for (const rule of classifyOverrides(pkg.overrides)) {
        if (rule.kind === "exact") record(rule.name, rule.version, path);
      }
    }
  }

  return toCheck;
}

/**
 * The override rules the bake-time gate does not age-check because they are
 * ranges. The CLI prints them; the gate does not fail on them.
 *
 * @param pkgs — package objects with paths
 * @returns Array<{ name, spec, declaredIn }>
 */
export function collectNonExactOverrides(pkgs) {
  const gaps = [];
  for (const { pkg, path } of pkgs) {
    if (pkg.overrides === undefined) continue;
    for (const rule of classifyOverrides(pkg.overrides)) {
      if (rule.kind === "range") gaps.push({ name: rule.name, spec: rule.spec, declaredIn: path });
    }
  }
  return gaps;
}

/**
 * The override rules in a form this gate does not support. The CLI refuses to
 * run while any exist.
 *
 * @param pkgs — package objects with paths
 * @returns Array<{ declaredIn, at, reason }>
 */
export function collectUnsupportedOverrides(pkgs) {
  const unsupported = [];
  for (const { pkg, path } of pkgs) {
    if (pkg.overrides === undefined) continue;
    for (const rule of classifyOverrides(pkg.overrides)) {
      if (rule.kind === "refused") {
        unsupported.push({ declaredIn: path, at: formatOverridePath(rule.path), reason: rule.reason });
      }
    }
  }
  return unsupported;
}
