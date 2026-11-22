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
 * This gate checks external entries in `dependencies`, `devDependencies`,
 * `optionalDependencies` AND `overrides` (the root package.json and each
 * packages/<name>/package.json, the manifests the CLI reads; the CLI fails on a
 * bun.lock workspace outside those): ranges in all four, exact pins in all but
 * `devDependencies`.
 * - `dependencies` / `optionalDependencies`: npm and bun install
 *   optionalDependencies by default (a failed install is non-fatal, not
 *   skipped), so they install just like any other dep and represent the same
 *   supply-chain risk. An entry is classified by classifyDependencySpec,
 *   which is the override value classifier (classifyOverrideValue) except
 *   that "" and "*" are ranges (as overrides they override nothing): an exact
 *   version is age-checked, a range is age-checked at the version bun.lock
 *   resolves it to (resolveRangedDeps), a form the classifier refuses fails
 *   the gate (collectUnsupportedDeps), and an exact `npm:` alias is checked at
 *   its target's version.
 * - `devDependencies`: ranges are age-checked at their lock resolution, like
 *   dependencies; exact pins are not age-checked, as before; a form the
 *   classifier refuses fails the gate (collectUnsupportedDeps).
 * - `overrides`: exact declarations are age-checked, including conditional
 *   rules, an exact `npm:` alias at its target's version; range declarations
 *   are age-checked at the copies in the rule's scope (resolveRangedDeps).
 *   Nested override objects are read too.
 *
 * Exemptions, in every checked field: `@tpsdev-ai/*` and the keep-current
 * list, matched on the package a declaration installs (an `npm:` alias's
 * target, never its key), and `workspace:`, `file:`/`link:`, `git+`/`github:`
 * specifiers.
 *
 * `peerDependencies` are NOT checked: a peer declaration states what a
 * consumer's project must provide, and the consumer's own install picks that
 * version. This repository's frozen install does install a required peer, at
 * the version bun.lock records, and the gate does not age-check that version
 * on account of the peer declaration (a stated limit).
 *
 * Trust boundary: the gate reads bun.lock as written. For checked ranged
 * declarations, the gate age-checks the versions selected from bun.lock. The
 * same CI job then runs `bun install
 * --frozen-lockfile`, which with bun 1.3.10 refused a `workspaces` array, a
 * workspace entry with no `name`, a missing workspace entry and a wrong
 * workspace `name` (exit 1), and, for a lock recording a workspace's range at
 * a version outside that range, installed the recorded version, the one the
 * gate checks; it does not check a recorded version against its declared
 * range, nor a recorded peer (flair#1936). The test suite "bun install
 * --frozen-lockfile on the locks the gate reads" measures these cases.
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
// A value is classified into a supported subset of npm registry specs: an exact
// version, a range, or something else. Some spellings npm accepts as versions
// ("v1.0.0", build metadata) are deliberately not treated as exact here, so the
// gate refuses them rather than guessing. classifyOverrides refuses, with a
// reason, every rule it cannot classify as exact, range, exempt or none.
// test/unit/check-dep-ages-npm-conformance.test.ts checks this against a
// recording of npm's own parser.

/** A canonical exact version: MAJOR.MINOR.PATCH with an optional prerelease. */
const EXACT_VERSION_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;
/** A conservative regex for common loose version spellings ("v1.0.0", "=1.0.0", "1.0.0+build"); not a full copy of semver's loose grammar. */
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
    if (subClass.kind === "range") return { kind: "range", name, spec, target };
    return refused(`"${spec}": ${subClass.reason}`);
  }
  return classifyRegistrySpec(name, spec);
}

/** Classify a `dependencies` / `devDependencies` / `optionalDependencies` specifier: as an override value, except that "" and "*" are ranges (as overrides they override nothing). */
function classifyDependencySpec(name, spec) {
  if (spec === "" || spec === "*") return { kind: "range", name, spec };
  return classifyOverrideValue(name, spec);
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const describeType = (v) => (v === null ? "null" : Array.isArray(v) ? "an array" : `a ${typeof v}`);

/**
 * Classify every rule in one manifest's `overrides` value, nested rules
 * included. Each rule is { path, kind, ... } where `path` is the list of keys
 * from the top of `overrides` and `kind` is one of:
 * - "exact": declares an exact target (an alias reports its target);
 * - "range": `name` is overridden with the range `spec` (an `npm:` alias
 *   carries its target package in `target`);
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
 * `git+`/`github:`. A `dependencies` / `optionalDependencies` entry is
 * classified by classifyDependencySpec (the override value classifier, except
 * that "" and "*" are ranges); only an exact version is collected here
 * (collectRangedDeps collects ranges).
 *
 * `peerDependencies` are NOT checked (see the module comment).
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
    const key = `${name}@${version}`;
    if (!toCheck.has(key)) {
      toCheck.set(key, { name, version, declaredIn: [] });
    }
    const entry = toCheck.get(key);
    if (!entry.declaredIn.includes(declaredIn)) entry.declaredIn.push(declaredIn);
  }

  function recordDeps(deps, declaredIn) {
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== "string") continue;
      // Only exact versions are collected here; collectRangedDeps collects
      // ranges, which resolveRangedDeps resolves through bun.lock.
      const classified = classifyDependencySpec(name, spec);
      if (classified.kind === "exact") record(classified.name, classified.version, declaredIn);
    }
  }

  for (const { pkg, path } of pkgs) {
    // Exact `devDependencies` pins are deliberately not age-checked, so that
    // field is not read here; its ranges are (collectRangedDeps) and its
    // refused forms fail the gate (collectUnsupportedDeps).
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
 * Every ranged declaration the bake-time gate resolves through the lockfile:
 * ranges in `dependencies`, `devDependencies` and `optionalDependencies` of
 * every manifest, and every ranged `overrides` rule, nested rules included.
 * Each entry is { kind, name, target, spec, declaredIn, at, workspaceDir }
 * where `name` is the declared key (the name the package is installed under),
 * `target` the registry package it installs (an `npm:` alias differs), `at`
 * where the declaration sits (`dependencies["x"]`, `overrides["a"]["b"]`)
 * and `workspaceDir` the manifest's directory ("" for the root). An override
 * entry also carries `path`, its full key path as { name, selector } pairs.
 *
 * Exemptions match collectDeps: `@tpsdev-ai/*` and the keep-current list,
 * matched on `target`, so an `npm:` alias is exempt only when its target is.
 * `workspace:`, `file:`/`link:` and `git+`/`github:` specifiers are not ranges
 * and are not collected.
 */
export function collectRangedDeps(pkgs, keepCurrent) {
  const out = [];
  const seen = new Set();
  function add(entry) {
    if (entry.target.startsWith("@tpsdev-ai/")) return;
    if (keepCurrent.has(entry.target)) return;
    const key = [entry.kind, entry.spec, entry.declaredIn, entry.at].join("\u0000");
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  }
  const workspaceDirOf = (path) => (path === "package.json" ? "" : path.replace(/\/package\.json$/, ""));
  for (const { pkg, path } of pkgs) {
    const workspaceDir = workspaceDirOf(path);
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const deps = pkg[field];
      // A non-object field, a non-string specifier and a refused form are
      // skipped here because collectUnsupportedDeps fails the gate on each
      // first, in the same three fields.
      if (!isPlainObject(deps)) continue;
      for (const [name, spec] of Object.entries(deps)) {
        if (typeof spec !== "string") continue;
        const classified = classifyDependencySpec(name, spec);
        if (classified.kind !== "range") continue;
        add({
          kind: "dependency",
          field,
          name,
          target: classified.target ?? name,
          spec,
          declaredIn: path,
          at: `${field}[${JSON.stringify(name)}]`,
          workspaceDir,
          manifestName: typeof pkg.name === "string" ? pkg.name : undefined,
        });
      }
    }
    if (pkg.overrides === undefined) continue;
    for (const rule of classifyOverrides(pkg.overrides)) {
      if (rule.kind !== "range") continue;
      // classifyOverrides refuses a key that names no package, so every key
      // on a classified rule's path parses.
      add({
        kind: "override",
        name: rule.name,
        target: rule.target ?? rule.name,
        spec: rule.spec,
        declaredIn: path,
        at: formatOverridePath(rule.path),
        workspaceDir,
        path: rule.path.map((key) => parseOverrideKey(key)),
      });
    }
  }
  return out;
}

/**
 * bun.lock is JSON with trailing commas (the text lockfile Bun writes). Parse
 * it; an unparsable lock is an error, never an empty tree.
 */
export function parseBunLockText(text) {
  try {
    return JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
  } catch (err) {
    throw new Error(`bun.lock is not parsable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * A lock `packages` key is the node_modules path of one installed copy: the
 * package names it is nested under, then its own installed name. Split it
 * into those names (`a/@s/b/c` is a, @s/b, c); null for a malformed key.
 */
function lockKeySegments(key) {
  const parts = key.split("/");
  const segments = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "") return null;
    if (!parts[i].startsWith("@")) {
      segments.push(parts[i]);
      continue;
    }
    if (i + 1 >= parts.length || parts[i + 1] === "") return null;
    segments.push(`${parts[i]}/${parts[i + 1]}`);
    i++;
  }
  return segments.length > 0 ? segments : null;
}

/** The registry package and version in a lock entry's `name@version` spec, or null. */
function lockEntryResolution(entry) {
  if (!Array.isArray(entry) || typeof entry[0] !== "string") return null;
  const at = entry[0].lastIndexOf("@");
  if (at <= 0 || at === entry[0].length - 1) return null;
  return { registryName: entry[0].slice(0, at), version: entry[0].slice(at + 1) };
}

/**
 * The names of the dependencies a lock entry declares (dependencies, optional
 * and peer dependencies), or null when the lock does not record them. A
 * workspace entry carries no metadata; its dependencies are in `workspaces`.
 */
function lockEntryDependencyNames(entry, version, workspaces) {
  let meta = entry.slice(1).find(isPlainObject);
  // An installed package's devDependencies are not installed with it, so they
  // are not edges of the tree; a workspace's are, so they count for one.
  const fields = ["dependencies", "optionalDependencies", "peerDependencies"];
  if (meta === undefined && version.startsWith("workspace:")) {
    meta = workspaces[version.slice("workspace:".length)];
    fields.push("devDependencies");
  }
  if (!isPlainObject(meta)) return null;
  const names = [];
  for (const field of fields) {
    if (meta[field] === undefined) continue;
    if (!isPlainObject(meta[field])) return null;
    names.push(...Object.keys(meta[field]));
  }
  return names;
}

/** A lock `workspaces` key: "" (the root) or a relative path with no empty, "." or ".." segment. */
function isWorkspacePath(key) {
  if (key === "") return true;
  if (key.startsWith("/") || key.includes("\\")) return false;
  return key.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * The lock's `workspaces` map, validated: an object whose keys are workspace
 * paths and whose values are objects with a non-empty string `name` and, when
 * present, object `dependencies`, `devDependencies`, `optionalDependencies`
 * and `peerDependencies`. Anything else throws, so a workspace's resolution
 * never falls back to a hoisted copy on a map the gate cannot read.
 */
export function lockWorkspaces(lock) {
  const workspaces = lock?.workspaces;
  if (workspaces === undefined) throw new Error(`bun.lock has no "workspaces" object`);
  if (!isPlainObject(workspaces)) throw new Error(`bun.lock "workspaces" must be an object, not ${describeType(workspaces)}`);
  for (const [key, workspace] of Object.entries(workspaces)) {
    const where = `bun.lock workspaces[${JSON.stringify(key)}]`;
    if (!isWorkspacePath(key)) throw new Error(`${where}: the key is not a relative workspace path`);
    if (!isPlainObject(workspace)) throw new Error(`${where} must be an object, not ${describeType(workspace)}`);
    if (typeof workspace.name !== "string" || workspace.name === "") throw new Error(`${where} must have a non-empty string "name"`);
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      if (workspace[field] !== undefined && !isPlainObject(workspace[field])) {
        throw new Error(`${where}.${field} must be an object, not ${describeType(workspace[field])}`);
      }
    }
  }
  return workspaces;
}

/**
 * Index a parsed lockfile's `packages` by key and by installed name. Each copy
 * is { key, name, segments, registryName, version, dependencies } where `name`
 * is the name it is installed under (the last key segment), `registryName` the
 * package its entry resolves (an `npm:` alias differs) and `dependencies` the
 * dependency names it declares (null when the lock does not record them).
 * An unreadable `packages` map or entry, or `workspaces` map, throws.
 */
export function lockCopies(lock) {
  const byKey = new Map();
  const byName = new Map();
  const packages = lock?.packages;
  // A copy the gate cannot read could be one a range covers: refuse, never skip it.
  if (!isPlainObject(packages)) throw new Error(`bun.lock "packages" must be an object, not ${describeType(packages)}`);
  const workspaces = lockWorkspaces(lock);
  for (const [key, entry] of Object.entries(packages)) {
    const resolution = lockEntryResolution(entry);
    const segments = lockKeySegments(key);
    if (resolution === null || segments === null) {
      throw new Error(`bun.lock packages[${JSON.stringify(key)}] does not name a package and version`);
    }
    const copy = {
      key,
      name: segments[segments.length - 1],
      segments,
      ...resolution,
      dependencies: lockEntryDependencyNames(entry, resolution.version, workspaces),
    };
    byKey.set(key, copy);
    if (!byName.has(copy.name)) byName.set(copy.name, []);
    byName.get(copy.name).push(copy);
  }
  return { byKey, byName };
}

/**
 * The copy a dependency named `dep` of `from` resolves to, by node_modules
 * lookup: nested under `from` first, then under each enclosing package, then
 * hoisted. null when none is installed.
 */
function resolveDependencyCopy(from, dep, byKey) {
  for (let i = from.segments.length; i >= 0; i--) {
    const copy = byKey.get([...from.segments.slice(0, i), dep].join("/"));
    if (copy) return copy;
  }
  return null;
}

/**
 * Every copy installed below `starts` (their dependencies, transitively). A
 * copy whose dependencies the lock does not record is returned as `unknown`:
 * what lies below it cannot be decided. A key is queued at most once below the
 * starts, so the walk is bounded by the size of the lock.
 */
function copiesBelow(starts, byKey) {
  const below = new Map();
  const queue = [...starts];
  for (let i = 0; i < queue.length; i++) {
    const copy = queue[i];
    if (copy.dependencies === null) return { below: [], unknown: copy };
    for (const dep of copy.dependencies) {
      const child = resolveDependencyCopy(copy, dep, byKey);
      if (child && !below.has(child.key)) {
        below.set(child.key, child);
        queue.push(child);
      }
    }
  }
  return { below: [...below.values()], unknown: null };
}

/**
 * The copies an override rule covers. A top-level rule covers every copy of
 * its package. A nested rule, `overrides["a"]["b"]["c"]`, covers the copies of
 * c installed below a copy of b that is installed below a copy of a (npm
 * applies a nested override anywhere under its enclosing package). Returns
 * { copies } or { reason } when the scope cannot be decided.
 */
function overrideScope(entry, byKey, byName) {
  const selected = entry.path.find((segment) => segment.selector !== "*");
  if (selected) {
    return {
      reason: `the key "${selected.name}@${selected.selector}" has a version selector, which this gate does not evaluate, so the copies the rule covers cannot be decided`,
    };
  }
  let scope = byName.get(entry.path[0].name) ?? [];
  for (const segment of entry.path.slice(1)) {
    const { below, unknown } = copiesBelow(scope, byKey);
    if (unknown) {
      return { reason: `bun.lock does not record the dependencies of ${unknown.key}, so the copies below it cannot be decided` };
    }
    scope = below.filter((copy) => copy.name === segment.name);
  }
  return { copies: scope };
}

/**
 * Resolve every ranged declaration to the lockfile entries it installs:
 * - a dependency range resolves through its workspace's own entry
 *   (`<workspace name>/<declared name>`) when the lock carries one, else the
 *   hoisted entry (`<declared name>`); a root range through the hoisted entry;
 *   an `npm:` alias is installed under its alias, so it is looked up by the
 *   alias. The declaring manifest must have an entry in the lock's
 *   `workspaces` map (lockWorkspaces validates it), and for a workspace other
 *   than the root that entry's `name` must be the manifest's, or the range is
 *   unresolved;
 * - an overrides range covers the copies in its scope (overrideScope).
 * Each entry found must resolve the registry package the declaration names
 * (an alias's target); a different package is unresolved.
 *
 * Returns `unresolved` for a declaration the gate cannot resolve (the CLI
 * fails closed on each) and `uninstalled` for an overrides range with no
 * installed copy in its scope, which has no version to check (the CLI names
 * each). Neither is silently skipped.
 *
 * @returns {{ resolved: Array<{name, version, spec, declaredIn, at, kind}>, unresolved: Array<{kind, name, spec, declaredIn, at, reason}>, uninstalled: Array<{kind, name, spec, declaredIn, at}> }}
 */
export function resolveRangedDeps(entries, lock) {
  const { byKey, byName } = lockCopies(lock);
  const workspaces = lockWorkspaces(lock);
  const resolved = [];
  const unresolved = [];
  const uninstalled = [];
  const seen = new Set();
  for (const entry of entries) {
    const where = { kind: entry.kind, name: entry.name, spec: entry.spec, declaredIn: entry.declaredIn, at: entry.at };
    let copies;
    if (entry.kind === "override") {
      const scope = overrideScope(entry, byKey, byName);
      if (scope.reason) {
        unresolved.push({ ...where, reason: scope.reason });
        continue;
      }
      if (scope.copies.length === 0) {
        uninstalled.push(where);
        continue;
      }
      copies = scope.copies;
    } else {
      // The manifest declaring this range must be a workspace the lock
      // records; without its name the gate cannot find the workspace's own
      // copy, and the hoisted one may be a different version.
      const workspace = Object.hasOwn(workspaces, entry.workspaceDir) ? workspaces[entry.workspaceDir] : undefined;
      if (workspace === undefined) {
        unresolved.push({
          ...where,
          reason: `bun.lock "workspaces" has no entry for ${JSON.stringify(entry.workspaceDir)}, the manifest that declares this range`,
        });
        continue;
      }
      // The root's dependencies are installed at the top level, so a root range
      // resolves through the hoisted entry alone. A workspace's own copies sit
      // under its name, so the lock's name must be the declaring manifest's:
      // a wrong name would hide the workspace's copy behind the hoisted one.
      let copy;
      if (entry.workspaceDir === "") {
        copy = byKey.get(entry.name);
      } else {
        if (workspace.name !== entry.manifestName) {
          const declared = entry.manifestName === undefined ? "has no name" : `names ${JSON.stringify(entry.manifestName)}`;
          unresolved.push({
            ...where,
            reason: `bun.lock workspaces[${JSON.stringify(entry.workspaceDir)}] names ${JSON.stringify(workspace.name)}, but ${entry.declaredIn} ${declared}`,
          });
          continue;
        }
        copy = byKey.get(`${workspace.name}/${entry.name}`) ?? byKey.get(entry.name);
      }
      if (!copy) {
        unresolved.push({ ...where, reason: `bun.lock has no entry for ${entry.name}` });
        continue;
      }
      copies = [copy];
    }
    const other = copies.find((copy) => copy.registryName !== entry.target);
    if (other) {
      unresolved.push({
        ...where,
        reason: `bun.lock's ${other.key} entry installs ${other.registryName}@${other.version}, not ${entry.target}`,
      });
      continue;
    }
    for (const copy of copies) {
      const key = [entry.target, copy.version, entry.spec, entry.declaredIn, entry.at].join("\u0000");
      if (seen.has(key)) continue;
      seen.add(key);
      resolved.push({
        name: entry.target,
        version: copy.version,
        spec: entry.spec,
        declaredIn: entry.declaredIn,
        at: entry.at,
        kind: entry.kind,
      });
    }
  }
  return { resolved, unresolved, uninstalled };
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

/**
 * The dependencies, devDependencies and optionalDependencies entries in a form
 * this gate does not support, a non-string specifier or a field that is not an
 * object. The CLI refuses to run while any exist.
 *
 * @param pkgs — package objects with paths
 * @returns Array<{ declaredIn, field, name, spec, reason }>
 */
export function collectUnsupportedDeps(pkgs) {
  const unsupported = [];
  for (const { pkg, path } of pkgs) {
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const deps = pkg[field];
      if (deps === undefined) continue;
      if (!isPlainObject(deps)) {
        unsupported.push({ declaredIn: path, field, name: field, spec: "", reason: `it must be an object, not ${describeType(deps)}` });
        continue;
      }
      for (const [name, spec] of Object.entries(deps)) {
        if (typeof spec !== "string") {
          unsupported.push({ declaredIn: path, field, name, spec: String(spec), reason: `the specifier must be a string, not ${describeType(spec)}` });
          continue;
        }
        const classified = classifyDependencySpec(name, spec);
        if (classified.kind === "refused") unsupported.push({ declaredIn: path, field, name, spec, reason: classified.reason });
      }
    }
  }
  return unsupported;
}
