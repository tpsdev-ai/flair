#!/usr/bin/env node
/**
 * check-global-install-lockfile.mjs — flair#1683 regression lane.
 *
 * WHAT BROKE (0.54.1). `npm install -g --prefix <tmp> @tpsdev-ai/flair@0.54.1`
 * is a broken install, and nothing in CI noticed:
 *
 *   npm warn reify invalid or damaged lockfile detected        (×8)
 *   added 50 packages                                          (0.53.0 added 543)
 *   require.resolve('fs-extra', { paths: [<tree>/…/harper/dist/utility/logging] })
 *     → MODULE_NOT_FOUND (or, worse, a hit OUTSIDE the tree — see resolveFromLoggingDir)
 *   node <tree>/node_modules/harper/dist/bin/harper.js version
 *     → throws; the engine cannot start
 *
 * The package-count floor it enforces lives in the reviewed budget file
 * (.github/install-weight-budget.json → minPackages), not in this script.
 * The count it compares is Flair's installed dependency graph (countFlairTree):
 * starting from the installed @tpsdev-ai/flair package directory, each
 * dependency named in a package's dependencies/optionalDependencies is resolved
 * the way Node resolves it from that package's real directory, and each resolved
 * package directory is counted once. Bundled copies under a package's own
 * node_modules are reached that way; unrelated packages in the prefix are not.
 * npm's "added N packages" summary is printed for information only: harper
 * 5.3.3 (the version flair pins) bundles some of its dependencies,
 * and npm's summary line
 * does not count bundled copies, so the summary understates a healthy tree.
 *
 * Cause: 0.54.1's `bundleDependencies: ["@tpsdev-ai/flair-tool-descriptors"]`
 * (#1681) interacted with harper's own npm-shrinkwrap.json. npm's reify then
 * gave up on harper's subtree, so a global install "succeeded" (exit 0) with an
 * empty harper dependency tree. That is the failure this script exists to make
 * loud — and it is why a bare `npm install` exit code is NOT the check.
 *
 * WHAT IT DOES. Packs nothing itself: it takes a tarball (or any npm spec) and
 * does a real `npm install -g --prefix <throwaway>` into it, then asserts the
 * four symptoms above are absent. The CI lane (test.yml → install-weight job)
 * passes the tarball it already built and packed for the weight budget, so this
 * costs one throwaway install (~10s), not another build.
 *
 * FAILS-FIRST, VERIFIED. Run against the published 0.54.1 tarball it fails on
 * all four checks; against a build with the descriptors vendored it passes.
 * Both transcripts are in the flair#1683 PR body.
 *
 * Usage:
 *   node scripts/check-global-install-lockfile.mjs --package <tarball|spec>
 *   node scripts/check-global-install-lockfile.mjs --package ./tpsdev-ai-flair-0.54.2.tgz --keep
 *   node scripts/check-global-install-lockfile.mjs --registry-version 0.54.2   # flair#1686 canary
 *
 * flair#1686: `--registry-version <ver>` installs the published
 * `@tpsdev-ai/flair@<ver>` from the public registry into a throwaway prefix and
 * runs the SAME four assertions. It is the canary half of this script family —
 * the PR lane installs the tarball packed at HEAD, the canary installs exactly
 * what the registry serves a user, and both go through `evaluateInstall` so the
 * contract cannot drift into two implementations.
 *
 * Exit codes:
 *   0 — every check passed
 *   1 — at least one check failed (the install is broken, or npm exited nonzero
 *       while leaving a tree; details on stderr)
 *   2 — DID NOT RUN (no --package, npm could not install at all, no tree) —
 *       never silently green. Mirrors check-install-weight.mjs.
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

/** Repo-relative path of the reviewed weight/floor budget (see readMinPackages). */
export const BUDGET_REL = join(".github", "install-weight-budget.json");

/** The one package this regression lane knows how to install (flair#1683). */
export const FLAIR_PACKAGE = "@tpsdev-ai/flair";

/**
 * Exact-version registry spec for the canary (`--registry-version`). Never a
 * dist-tag: the canary must install the version it was dispatched for, not
 * whatever `latest`/`staged` happens to point at when the job runs (flair#1686).
 * Rejects anything that is not a plain semver so a malformed input fails closed
 * here rather than installing an unintended spec.
 */
export function registryInstallSpec(version) {
  const value = String(version ?? "").trim();
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/.test(value)) {
    throw new Error(`--registry-version must be a semver (e.g. 0.54.2), got '${version}'`);
  }
  return `${FLAIR_PACKAGE}@${value}`;
}

/** Repo root, resolved from this script's location (scripts/ → repo root). */
export function repoRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/**
 * Floor for the measured installed-package count, read from the reviewed budget
 * file (`.github/install-weight-budget.json` → `minPackages`) rather than a
 * literal in this script, so the number is reviewed with the rest of the ratchet
 * instead of moving in a diff nobody reads.
 */
export function readMinPackages(root = repoRoot()) {
  const raw = JSON.parse(readFileSync(join(root, BUDGET_REL), "utf8"));
  const value = Number(raw.minPackages);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${BUDGET_REL} is missing a positive minPackages`);
  }
  return value;
}

/** Harness paths inside a `--prefix <p>` global install. */
export function treePaths(prefix) {
  const flair = join(prefix, "lib", "node_modules", "@tpsdev-ai", "flair");
  return {
    flair,
    globalNodeModules: join(prefix, "lib", "node_modules"),
    harperJs: join(flair, "node_modules", "harper", "dist", "bin", "harper.js"),
    harperLoggingDir: join(flair, "node_modules", "harper", "dist", "utility", "logging"),
  };
}

/**
 * Hard bounds for the graph walk. They do not depend on what is installed: a
 * graph that exceeds either is a corrupt install, and the walk throws rather
 * than reporting a lower count as a measurement.
 */
const MAX_GRAPH_DEPTH = 64;
const MAX_GRAPH_PACKAGES = 250_000;

function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read a directory's package identity: `{name, version}` when its package.json
 * parses and carries both. A missing, unreadable or malformed manifest throws,
 * naming the path: a read failure must never lower the count (which would let a
 * broken tree pass the floor).
 */
function readPackageIdentity(dir) {
  const manifestPath = join(dir, "package.json");
  let text;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch (err) {
    throw new Error(`cannot read ${manifestPath}: ${messageOf(err)}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`cannot parse ${manifestPath}: ${messageOf(err)}`);
  }
  if (typeof raw?.name !== "string" || raw.name === "") {
    throw new Error(`${manifestPath} has no string name`);
  }
  if (typeof raw?.version !== "string" || raw.version === "") {
    throw new Error(`${manifestPath} has no string version`);
  }
  for (const field of ["dependencies", "optionalDependencies"]) {
    const value = raw[field];
    if (value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value))) {
      throw new Error(`${manifestPath} has a malformed ${field} field`);
    }
  }
  return raw;
}

/**
 * The `node_modules` directory the installed Flair package sits in. Resolution
 * stops at its parent so an ambient package above the install prefix can never
 * be counted as one of Flair's dependencies.
 */
function enclosingNodeModules(flairDir) {
  let dir = realpathSync(flairDir);
  for (;;) {
    if (dir.endsWith(`${sep}node_modules`)) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`cannot find a node_modules root above ${flairDir}`);
    }
    dir = parent;
  }
}

/**
 * Resolve `name` the way Node does from `fromDir`: `<dir>/node_modules/<name>`
 * for each ancestor directory, skipping directories already named node_modules.
 * Stops after the parent of `root`, so the search stays inside the install.
 * Returns the resolved real directory, or null when nothing is installed there.
 */
function resolveDependencyDir(fromDir, name, root) {
  if (!fromDir.startsWith(`${root}${sep}`)) {
    throw new Error(`package ${fromDir} is outside the install root ${root}`);
  }
  const last = dirname(root);
  let dir = fromDir;
  for (;;) {
    if (basename(dir) !== "node_modules") {
      const candidate = join(dir, "node_modules", name);
      let stat;
      try {
        stat = statSync(candidate);
      } catch (err) {
        if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") {
          throw new Error(`cannot stat ${candidate}: ${messageOf(err)}`);
        }
      }
      if (stat) {
        if (!stat.isDirectory()) {
          throw new Error(`dependency ${name} at ${candidate} is not a directory`);
        }
        return realpathSync(candidate);
      }
    }
    if (dir === last) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Count Flair's installed dependency graph, starting at the installed
 * @tpsdev-ai/flair package directory.
 *
 * The root package counts once, then every dependency named in a package's
 * `dependencies` or `optionalDependencies` is resolved by Node's search from
 * that package's real directory and counted once per resolved directory.
 * Bundled copies are reached because they sit in `node_modules` under the
 * package that declares them. Packages in the prefix that nothing in the graph
 * depends on are never visited; nor is anything above the install prefix.
 *
 * A required dependency that does not resolve, and a resolved directory whose
 * package.json is missing, unreadable or malformed, throws naming the path: a
 * failed read is never reported as a smaller tree. An optional dependency that
 * is not installed is skipped.
 */
export function countFlairTree(flairDir, root = enclosingNodeModules(flairDir)) {
  const flairReal = realpathSync(flairDir);
  const rootReal = realpathSync(root);
  const seen = new Set();
  let packages = 0;

  const visit = (dir, depth) => {
    if (depth > MAX_GRAPH_DEPTH) {
      throw new Error(`dependency graph is deeper than ${MAX_GRAPH_DEPTH} packages at ${dir}`);
    }
    if (seen.has(dir)) return;
    seen.add(dir);
    if (++packages > MAX_GRAPH_PACKAGES) {
      throw new Error(`dependency graph under ${rootReal} has more than ${MAX_GRAPH_PACKAGES} packages`);
    }
    const manifest = readPackageIdentity(dir);
    const required = Object.keys(manifest.dependencies ?? {});
    const optional = Object.keys(manifest.optionalDependencies ?? {});
    for (const name of [...required, ...optional]) {
      const isOptionalOnly = !required.includes(name);
      const resolved = resolveDependencyDir(dir, name, rootReal);
      if (resolved === null) {
        if (isOptionalOnly) continue;
        throw new Error(`dependency ${name} of ${manifest.name}@${manifest.version} did not resolve from ${dir}`);
      }
      if (!resolved.startsWith(`${rootReal}${sep}`)) {
        throw new Error(
          `dependency ${name} of ${manifest.name}@${manifest.version} resolves outside ${rootReal} (${resolved})`,
        );
      }
      visit(resolved, depth + 1);
    }
  };

  visit(flairReal, 0);
  return packages;
}

/** "added 543 packages" → 543; null when npm printed no such line. */
export function parseAddedCount(log) {
  const m = /^added (\d+) packages?/m.exec(log);
  return m ? Number(m[1]) : null;
}

/** True when the install log carries npm's reify damage warning. */
export function hasDamagedLockfileWarning(log) {
  return /invalid or damaged lockfile/.test(log);
}

/**
 * Resolve `fs-extra` the way harper's logging dir would at runtime, and require
 * the hit to be INSIDE the installed tree.
 *
 * The in-tree assertion is the whole point: if harper's subtree was never built, a
 * developer box whose TMPDIR sits under a tree with a node_modules/fs-extra would
 * otherwise resolve the AMBIENT copy and report the broken install green (flaky-on-
 * developer, green-on-CI). A hoisted/ambient hit is a failure, not a pass.
 */
export function resolveFromLoggingDir(paths) {
  const require = createRequire(import.meta.url);
  let resolved;
  try {
    resolved = require.resolve("fs-extra", { paths: [paths.harperLoggingDir] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Drop node's "Require stack:" tail — it names this script, not the tree.
    return { ok: false, error: message.split("\n")[0].trim() };
  }
  if (!resolved.startsWith(paths.flair)) {
    return {
      ok: false,
      resolved,
      error:
        `resolved outside the installed tree (${resolved}) — an ambient/hoisted copy ` +
        "hides harper's missing dependency tree",
    };
  }
  return { ok: true, resolved };
}

/** Run the engine's own version probe. */
export function harperVersion(paths) {
  if (!existsSync(paths.harperJs)) {
    return { ok: false, error: `no harper entrypoint at ${paths.harperJs}` };
  }
  const run = spawnSync(process.execPath, [paths.harperJs, "version"], { encoding: "utf8" });
  if (run.status !== 0) {
    return {
      ok: false,
      error: `exit ${run.status}: ${(run.stderr || run.stdout || "").trim().split("\n").slice(-1)[0] ?? ""}`,
    };
  }
  return { ok: true, version: run.stdout.trim() };
}

/**
 * Apply the checks to a finished install. Takes the npm exit status and the
 * captured log, returns findings. Unit-tested in
 * test/unit/global-install-lockfile.test.ts.
 *
 * A nonzero or missing status fails first: an install npm refused is not
 * rescued by whatever tree it left behind. `added` (npm's summary line) is
 * returned for reporting only; the floor is compared against `measured`, the
 * count taken from Flair's installed dependency graph.
 */
export function evaluateInstall({ status, log, paths, minPackages }) {
  if (!Number.isFinite(minPackages) || minPackages <= 0) {
    throw new Error("evaluateInstall requires a positive minPackages (see readMinPackages)");
  }
  if (typeof paths.globalNodeModules !== "string" || paths.globalNodeModules === "") {
    throw new Error("evaluateInstall requires paths.globalNodeModules (see treePaths)");
  }
  const added = parseAddedCount(log);

  if (status !== 0) {
    const shown = status === null || status === undefined ? "none (the process was killed)" : status;
    return {
      added,
      measured: null,
      fsExtra: { ok: false, error: "not evaluated: npm install failed" },
      harper: { ok: false, error: "not evaluated: npm install failed" },
      failures: [
        `npm install exited with status ${shown} — refusing the install before evaluating the tree it left behind`,
      ],
      ok: false,
    };
  }

  const failures = [];

  if (hasDamagedLockfileWarning(log)) {
    failures.push(
      'install log contains "invalid or damaged lockfile" — npm reify could not resolve the tree ' +
        "(flair#1683: bundleDependencies vs. harper's npm-shrinkwrap.json)",
    );
  }

  let measured = null;
  try {
    measured = countFlairTree(paths.flair, paths.globalNodeModules);
  } catch (err) {
    failures.push(`could not measure Flair's installed dependency graph: ${messageOf(err)}`);
  }
  if (measured !== null && measured < minPackages) {
    const reported = added === null ? "" : ` (npm reported "added ${added}")`;
    failures.push(
      `installed Flair tree has ${measured} packages (Flair and each package resolved from it), ` +
        `below the ${minPackages} floor${reported} — dependency tree collapsed`,
    );
  }

  const fsExtra = resolveFromLoggingDir(paths);
  if (!fsExtra.ok) {
    failures.push(`require.resolve('fs-extra') from harper's logging dir failed: ${fsExtra.error}`);
  }

  const harper = harperVersion(paths);
  if (!harper.ok) {
    failures.push(`node harper.js version failed: ${harper.error}`);
  }

  return { added, measured, fsExtra, harper, failures, ok: failures.length === 0 };
}

function parseArgs(argv) {
  const opts = { pkg: null, registryVersion: null, keep: false, prefix: null, minPackages: null, countRoot: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--package" || a === "--tarball") opts.pkg = argv[++i];
    else if (a === "--registry-version") opts.registryVersion = argv[++i];
    else if (a === "--prefix") opts.prefix = argv[++i];
    else if (a === "--min-packages") opts.minPackages = Number(argv[++i]);
    else if (a === "--count-root") opts.countRoot = argv[++i];
    else if (a === "--keep") opts.keep = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }
  if (opts.help) {
    console.error(
      "usage: node scripts/check-global-install-lockfile.mjs --package <tarball|spec> [--prefix <dir>] [--keep]\n" +
        "       node scripts/check-global-install-lockfile.mjs --registry-version <ver> [--prefix <dir>] [--keep]\n" +
        "       node scripts/check-global-install-lockfile.mjs --count-root <global lib/node_modules>",
    );
    process.exit(0);
  }
  if (opts.countRoot) {
    // Same measured count the floor compares, for callers that own an existing
    // global tree (scripts/ci/macos-launchd-upgrade-lane.sh).
    if (opts.pkg || opts.registryVersion) {
      console.error("DID NOT RUN: --count-root counts an existing tree; do not pass --package/--registry-version");
      process.exit(2);
    }
    try {
      console.log(countFlairTree(join(opts.countRoot, "@tpsdev-ai", "flair"), opts.countRoot));
    } catch (err) {
      console.error(`DID NOT RUN: ${messageOf(err)}`);
      process.exit(2);
    }
    return;
  }
  if (opts.pkg && opts.registryVersion) {
    console.error("DID NOT RUN: pass exactly one of --package / --registry-version, not both");
    process.exit(2);
  }
  if (opts.registryVersion) {
    try {
      opts.pkg = registryInstallSpec(opts.registryVersion);
    } catch (err) {
      console.error(`DID NOT RUN: ${err instanceof Error ? err.message : err}`);
      process.exit(2);
    }
  }
  if (!opts.pkg) {
    console.error("DID NOT RUN: --package <tarball|spec> or --registry-version <ver> is required (nothing to install)");
    process.exit(2);
  }
  if (opts.pkg.endsWith(".tgz") && !existsSync(opts.pkg)) {
    console.error(`DID NOT RUN: tarball not found: ${opts.pkg}`);
    process.exit(2);
  }

  const own = !opts.prefix;
  const prefix = opts.prefix ?? mkdtempSync(join(tmpdir(), "flair-global-install-"));
  const cleanup = () => {
    if (own && !opts.keep) rmSync(prefix, { recursive: true, force: true });
  };

  try {
    console.error(`[global-install] npm install -g --prefix ${prefix} ${opts.pkg}`);
    if (opts.registryVersion) console.error(`[global-install] source: public registry, exact version ${opts.registryVersion} (flair#1686 canary)`);
    const run = spawnSync("npm", ["install", "-g", "--prefix", prefix, opts.pkg], {
      encoding: "utf8",
      env: { ...process.env, npm_config_fund: "false", npm_config_audit: "false" },
    });
    const log = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;

    const paths = treePaths(prefix);
    if (!existsSync(paths.flair)) {
      const shown = run.status === null ? "none (the process was killed)" : run.status;
      console.error(`DID NOT RUN: no installed tree at ${paths.flair} (npm exit ${shown})`);
      console.error(log.trim().split("\n").slice(-20).join("\n"));
      process.exit(2);
    }

    const result = evaluateInstall({
      status: run.status,
      log,
      paths,
      minPackages: opts.minPackages ?? readMinPackages(),
    });
    console.error(
      `[global-install] npm-status=${run.status ?? "none"} npm-added=${result.added ?? "(no summary line)"} ` +
        `measured=${result.measured ?? "(not evaluated)"} packages ` +
        `fs-extra=${result.fsExtra.ok ? "ok" : "FAIL"} harper version=${result.harper.ok ? result.harper.version : "FAIL"}`,
    );
    if (!result.ok) {
      console.error(`[global-install] FAILED ${result.failures.length} check(s):`);
      for (const f of result.failures) console.error(`  ✗ ${f}`);
      if (opts.keep) console.error(`[global-install] tree kept at ${prefix}`);
      process.exit(1);
    }
    console.error(`[global-install] OK — harper ${result.harper.version}, ${result.measured} measured packages`);
    if (opts.keep) console.error(`[global-install] tree kept at ${prefix}`);
  } finally {
    cleanup();
  }
}

const invoked = process.argv[1] ? process.argv[1] : "";
if (invoked.endsWith("check-global-install-lockfile.mjs")) {
  main();
}
