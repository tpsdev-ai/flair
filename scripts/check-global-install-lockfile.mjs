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
 *     → MODULE_NOT_FOUND
 *   node <tree>/node_modules/harper/dist/bin/harper.js version
 *     → throws; the engine cannot start
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
 *
 * Exit codes:
 *   0 — every check passed
 *   1 — at least one check failed (the install is broken; details on stderr)
 *   2 — DID NOT RUN (no --package, npm could not install at all, no tree) —
 *       never silently green. Mirrors check-install-weight.mjs.
 */

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Minimum "added N packages" count for the installed tree.
 *
 * Measured baseline: 0.53.0 (the last good release, no bundleDependencies)
 * reported "added 543 packages" on 2026-09-15; the broken 0.54.1 reported
 * "added 50 packages" (npm 10.9.4 / node 22). The flair#1683 report measured
 * 560 and 44 respectively on a different npm — same shape, slightly different
 * counts. 500 sits above both broken shapes and below both healthy baselines,
 * so ordinary dependency-graph churn does not trip it while a collapsed harper
 * subtree does. Re-measure and move this with a comment if a release
 * legitimately changes the tree by >40 packages.
 */
export const MIN_PACKAGES = 500;

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

/** Resolve `fs-extra` the way harper's logging dir would at runtime. */
export function resolveFromLoggingDir(paths) {
  const require = createRequire(import.meta.url);
  try {
    return { ok: true, resolved: require.resolve("fs-extra", { paths: [paths.harperLoggingDir] }) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Drop Node's "Require stack:" tail — it names this script, not the tree.
    return { ok: false, error: message.split("\n")[0].trim() };
  }
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
export function evaluateInstall({ log, paths, minPackages = MIN_PACKAGES }) {
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
    failures.push(`added ${added} packages, below the ${minPackages} floor (0.53.0 measured 543) — dependency tree collapsed`);
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
  const opts = { pkg: null, keep: false, prefix: null, minPackages: MIN_PACKAGES };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--package" || a === "--tarball") opts.pkg = argv[++i];
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
    console.error("usage: node scripts/check-global-install-lockfile.mjs --package <tarball|spec> [--prefix <dir>] [--keep]");
    process.exit(0);
  }
  if (!opts.pkg) {
    console.error("DID NOT RUN: --package <tarball|spec> is required (nothing to install)");
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

    const result = evaluateInstall({ log, paths, minPackages: opts.minPackages });
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
