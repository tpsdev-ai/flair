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
 *   1 — at least one check failed (the install is broken; details on stderr)
 *   2 — DID NOT RUN (no --package, npm could not install at all, no tree) —
 *       never silently green. Mirrors check-install-weight.mjs.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
 * Floor for npm's "added N packages" line, read from the reviewed budget file
 * (`.github/install-weight-budget.json` → `minPackages`) rather than a literal
 * in this script, so the number is reviewed with the rest of the ratchet instead
 * of moving in a diff nobody reads.
 *
 * Measured baselines: 0.53.0 (the last good release, no bundleDependencies)
 * reported "added 543 packages" on npm 10.9.4 / node 22 (this file's Linux CI
 * box) and 560 on npm 11; the broken 0.54.1 reported 50 (npm 10) / 44 (npm 11
 * on macOS). 515 is 95% of the npm-10 baseline, below both healthy baselines and
 * above a 10% collapse (489). Re-measure and move the field with a comment if a
 * release legitimately changes the tree by >40 packages.
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
    harperJs: join(flair, "node_modules", "harper", "dist", "bin", "harper.js"),
    harperLoggingDir: join(flair, "node_modules", "harper", "dist", "utility", "logging"),
  };
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
 * Apply the four checks to a finished install. Pure — takes the captured log
 * and the on-disk tree, returns findings. Unit-tested in
 * test/unit/global-install-lockfile.test.ts.
 */
export function evaluateInstall({ log, paths, minPackages }) {
  if (!Number.isFinite(minPackages) || minPackages <= 0) {
    throw new Error("evaluateInstall requires a positive minPackages (see readMinPackages)");
  }
  const failures = [];

  if (hasDamagedLockfileWarning(log)) {
    failures.push(
      'install log contains "invalid or damaged lockfile" — npm reify could not resolve the tree ' +
        "(flair#1683: bundleDependencies vs. harper's npm-shrinkwrap.json)",
    );
  }

  const added = parseAddedCount(log);
  if (added === null) {
    failures.push('install log has no "added N packages" line — cannot confirm the tree was created');
  } else if (added < minPackages) {
    failures.push(
      `added ${added} packages, below the ${minPackages} floor ` +
        `(0.53.0 measured 543 on npm 10, 560 on npm 11) — dependency tree collapsed`,
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

  return { added, fsExtra, harper, failures, ok: failures.length === 0 };
}

function parseArgs(argv) {
  const opts = { pkg: null, registryVersion: null, keep: false, prefix: null, minPackages: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--package" || a === "--tarball") opts.pkg = argv[++i];
    else if (a === "--registry-version") opts.registryVersion = argv[++i];
    else if (a === "--prefix") opts.prefix = argv[++i];
    else if (a === "--min-packages") opts.minPackages = Number(argv[++i]);
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
        "       node scripts/check-global-install-lockfile.mjs --registry-version <ver> [--prefix <dir>] [--keep]",
    );
    process.exit(0);
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
      console.error(`DID NOT RUN: no installed tree at ${paths.flair} (npm exit ${run.status})`);
      console.error(log.trim().split("\n").slice(-20).join("\n"));
      process.exit(2);
    }

    const result = evaluateInstall({
      log,
      paths,
      minPackages: opts.minPackages ?? readMinPackages(),
    });
    console.error(
      `[global-install] added=${result.added ?? "(none)"} fs-extra=${result.fsExtra.ok ? "ok" : "FAIL"} ` +
        `harper version=${result.harper.ok ? result.harper.version : "FAIL"}`,
    );
    if (!result.ok) {
      console.error(`[global-install] FAILED ${result.failures.length} check(s):`);
      for (const f of result.failures) console.error(`  ✗ ${f}`);
      if (opts.keep) console.error(`[global-install] tree kept at ${prefix}`);
      process.exit(1);
    }
    console.error(`[global-install] OK — harper ${result.harper.version}, ${result.added} packages`);
    if (opts.keep) console.error(`[global-install] tree kept at ${prefix}`);
  } finally {
    cleanup();
  }
}

const invoked = process.argv[1] ? process.argv[1] : "";
if (invoked.endsWith("check-global-install-lockfile.mjs")) {
  main();
}
