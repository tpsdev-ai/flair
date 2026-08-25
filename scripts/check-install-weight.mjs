#!/usr/bin/env node
/**
 * check-install-weight.mjs — bound the installed tree of a global install (flair#1004).
 *
 * A clean `npm i -g @tpsdev-ai/flair` is hundreds of megabytes. The published
 * tarball is a few. Typecheck, lint, unit tests, integration tests and the
 * install-from-tarball smoke all pass on either number. This gate is the thing
 * that notices when the installed tree grows.
 *
 * It measures the INSTALLED TREE, never the tarball. A tarball-size check is
 * how this issue's author stated a figure that was wrong by two orders of
 * magnitude.
 *
 * The budget is a ratchet, not a target: slightly above today's measured
 * number, lowered on purpose when weight drops. An aspirational budget fails
 * on day one and gets disabled.
 *
 * Exit codes:
 *   0 — measured, under budget
 *   1 — measured, over budget (delta + top contributors printed)
 *   2 — DID NOT RUN (missing tree, failed install, broken budget). Not 0.
 *
 * Usage:
 *   node scripts/check-install-weight.mjs --tree <node_modules>
 *   node scripts/check-install-weight.mjs --tarball <packed.tgz>
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const EXIT_OK = 0;
export const EXIT_OVER = 1;
export const EXIT_DID_NOT_RUN = 2;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BUDGET_PATH = join(REPO_ROOT, ".github", "install-weight-budget.json");

export function formatBytes(n) {
  if (!Number.isFinite(n)) return "NaN";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs < 1024) return `${sign}${Math.round(abs)} B`;
  const mb = abs / (1024 * 1024);
  if (mb < 1024) return `${sign}${mb.toFixed(1)} MB`;
  return `${sign}${(mb / 1024).toFixed(2)} GB`;
}

export function formatDeltaBytes(n) {
  const formatted = formatBytes(n);
  if (n > 0) return `up ${formatted}`;
  if (n < 0) return `down ${formatted.slice(1)}`;
  return "unchanged";
}

/** Apparent size. Block-allocated `du` varies by filesystem; this does not. */
export function dirSize(dir, { skipNodeModules = false } = {}) {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (skipNodeModules && e.name === "node_modules" && e.isDirectory()) continue;
    const p = join(dir, e.name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || st.isFile()) {
      total += st.size;
    } else if (st.isDirectory()) {
      total += dirSize(p, { skipNodeModules });
    }
  }
  return total;
}

function visitNodeModules(nm, visitPackage) {
  let entries;
  try {
    entries = readdirSync(nm, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (e.name.startsWith(".")) continue;
    const p = join(nm, e.name);
    if (e.name.startsWith("@")) {
      let scoped;
      try {
        scoped = readdirSync(p, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const inner of scoped) {
        if (inner.isDirectory() || inner.isSymbolicLink()) {
          visitPackage(join(p, inner.name));
        }
      }
    } else {
      visitPackage(p);
    }
  }
}

export function collectPackages(nodeModulesDir) {
  const packages = [];
  function visitPackage(pkgDir) {
    const pkgJson = join(pkgDir, "package.json");
    if (!existsSync(pkgJson)) return;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
    } catch {
      return;
    }
    if (typeof pkg.name !== "string" || !pkg.name) return;
    packages.push({
      name: pkg.name,
      version: typeof pkg.version === "string" ? pkg.version : "",
      bytes: dirSize(pkgDir, { skipNodeModules: true }),
      path: pkgDir,
    });
    const nested = join(pkgDir, "node_modules");
    if (existsSync(nested)) visitNodeModules(nested, visitPackage);
  }
  visitNodeModules(nodeModulesDir, visitPackage);
  return packages;
}

function listInstallDirs(dir) {
  let children;
  try {
    children = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return children
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
    .map((e) => e.name);
}

/**
 * Heaviest folders a human would `du` after install.
 *
 * A local `npm install` hoists onto node_modules/. A global
 * `npm install --prefix` of a scoped package nests every dep under
 * `@scope/name/node_modules`. Listing only the outer `@scope` then reports
 * "the whole tree grew" and cannot name `foo@1.2.3`. Unwrap that one layout.
 */
export function collectTopLevelEntries(nodeModulesDir) {
  const top = listInstallDirs(nodeModulesDir);
  if (top.length === 1 && top[0].startsWith("@")) {
    const scope = top[0];
    const scoped = listInstallDirs(join(nodeModulesDir, scope));
    if (scoped.length === 1) {
      const pkgDir = join(nodeModulesDir, scope, scoped[0]);
      const pkgName = `${scope}/${scoped[0]}`;
      const own = dirSize(pkgDir, { skipNodeModules: true });
      const nested = join(pkgDir, "node_modules");
      const inner = existsSync(nested) ? collectTopLevelEntries(nested) : [];
      return [{ name: pkgName, bytes: own }, ...inner].sort((a, b) => b.bytes - a.bytes);
    }
  }
  const entries = top.map((name) => ({ name, bytes: dirSize(join(nodeModulesDir, name)) }));
  entries.sort((a, b) => b.bytes - a.bytes);
  return entries;
}

export function measureInstalledTree(nodeModulesDir) {
  if (!nodeModulesDir || !existsSync(nodeModulesDir)) {
    return { didNotRun: true, reason: `installed tree not found: ${nodeModulesDir || "(empty path)"}` };
  }
  let st;
  try {
    st = lstatSync(nodeModulesDir);
  } catch (err) {
    return { didNotRun: true, reason: `cannot stat installed tree: ${err.message}` };
  }
  if (!st.isDirectory()) {
    return { didNotRun: true, reason: `installed tree is not a directory: ${nodeModulesDir}` };
  }
  const bytes = dirSize(nodeModulesDir);
  const packages = collectPackages(nodeModulesDir);
  const entries = collectTopLevelEntries(nodeModulesDir);
  if (bytes <= 0 || packages.length === 0) {
    return {
      didNotRun: true,
      reason: `installed tree at ${nodeModulesDir} is empty (${bytes} bytes, ${packages.length} packages)`,
    };
  }
  return {
    didNotRun: false,
    bytes,
    packages: packages.length,
    packageList: packages,
    entries,
  };
}

export function loadBudget(path = DEFAULT_BUDGET_PATH) {
  if (!existsSync(path)) {
    return { ok: false, reason: `budget file not found: ${path}` };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { ok: false, reason: `budget file is not JSON: ${err.message}` };
  }
  const maxBytes = Number(raw.maxBytes);
  const maxPackages = Number(raw.maxPackages);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || !Number.isFinite(maxPackages) || maxPackages <= 0) {
    return { ok: false, reason: "budget file missing a positive maxBytes / maxPackages" };
  }
  const baseline = raw.baseline && typeof raw.baseline === "object" ? raw.baseline : {};
  return {
    ok: true,
    maxBytes,
    maxPackages,
    baseline: {
      bytes: Number(baseline.bytes) || 0,
      packages: Number(baseline.packages) || 0,
      entries: baseline.entries && typeof baseline.entries === "object" ? baseline.entries : {},
    },
    path,
  };
}

export function diffEntries(current, baselineEntries) {
  const grown = [];
  for (const e of current) {
    const prev = Number(baselineEntries[e.name]);
    if (!Number.isFinite(prev)) {
      grown.push({ name: e.name, bytes: e.bytes, delta: e.bytes, kind: "new" });
    } else if (e.bytes > prev) {
      grown.push({ name: e.name, bytes: e.bytes, delta: e.bytes - prev, kind: "grew", previous: prev });
    }
  }
  grown.sort((a, b) => b.delta - a.delta);
  return grown;
}

export function evaluateWeight({ measured, budget }) {
  if (!budget || budget.ok === false) {
    return {
      status: "did-not-run",
      reason: budget?.reason ?? "budget was not loaded",
    };
  }
  if (!measured || measured.didNotRun) {
    return {
      status: "did-not-run",
      reason: measured?.reason ?? "no measurement",
    };
  }
  const contributors = diffEntries(measured.entries ?? [], budget.baseline?.entries ?? {});
  const deltaBytes = measured.bytes - (budget.baseline?.bytes ?? 0);
  const deltaPackages = measured.packages - (budget.baseline?.packages ?? 0);
  const overBytes = measured.bytes > budget.maxBytes;
  const overPackages = measured.packages > budget.maxPackages;
  if (overBytes || overPackages) {
    return {
      status: "over",
      overBytes,
      overPackages,
      deltaBytes,
      deltaPackages,
      contributors,
      measured,
      budget,
    };
  }
  return {
    status: "ok",
    deltaBytes,
    deltaPackages,
    contributors,
    measured,
    budget,
  };
}

export function formatReport(result) {
  const lines = [];
  if (result.status === "did-not-run") {
    lines.push("DID NOT RUN — install-weight gate did not measure an installed tree.");
    lines.push(result.reason);
    lines.push("Refusing to pass: a skipped weight check is how a 462 MB tree shipped unnoticed (flair#1004).");
    return lines.join("\n");
  }

  const m = result.measured;
  const b = result.budget;
  lines.push(
    `Installed tree: ${formatBytes(m.bytes)} (${m.bytes} bytes) / ${m.packages} packages` +
      `  (budget ${formatBytes(b.maxBytes)} / ${b.maxPackages} packages)`,
  );
  if (b.baseline?.bytes) {
    lines.push(
      `Baseline:       ${formatBytes(b.baseline.bytes)} / ${b.baseline.packages} packages` +
        `  (${formatDeltaBytes(result.deltaBytes)}, packages ${result.deltaPackages >= 0 ? "+" : ""}${result.deltaPackages})`,
    );
  }

  if (result.status === "over") {
    const bits = [];
    if (result.overBytes) {
      bits.push(
        `${formatBytes(m.bytes)} exceeds ${formatBytes(b.maxBytes)}` +
          ` (${formatDeltaBytes(result.deltaBytes)} from baseline ${formatBytes(b.baseline.bytes)})`,
      );
    }
    if (result.overPackages) {
      bits.push(
        `${m.packages} packages exceed ${b.maxPackages}` +
          ` (${result.deltaPackages >= 0 ? "+" : ""}${result.deltaPackages} from baseline ${b.baseline.packages})`,
      );
    }
    lines.push("");
    lines.push(`OVER BUDGET — ${bits.join("; ")}`);
    const top = (result.contributors ?? []).slice(0, 8);
    if (top.length) {
      lines.push("");
      lines.push("Largest new or grown entries:");
      for (const c of top) {
        if (c.kind === "new") {
          lines.push(`  ${formatBytes(c.delta).padStart(10)}  ${c.name}  (new)`);
        } else {
          lines.push(
            `  ${formatBytes(c.delta).padStart(10)}  ${c.name}  (was ${formatBytes(c.previous)}, now ${formatBytes(c.bytes)})`,
          );
        }
      }
    }
    const heaviest = (m.entries ?? []).slice(0, 8);
    if (heaviest.length) {
      lines.push("");
      lines.push("Heaviest entries in this tree:");
      for (const e of heaviest) {
        lines.push(`  ${formatBytes(e.bytes).padStart(10)}  ${e.name}`);
      }
    }
    lines.push("");
    lines.push(
      "This budget is a ratchet. If the growth is intentional, raise maxBytes / maxPackages " +
        "in .github/install-weight-budget.json slightly above the new measured number and " +
        "update baseline.entries so the next failure names the next change. Do not disable the gate.",
    );
  } else {
    lines.push("UNDER BUDGET");
    const heaviest = (m.entries ?? []).slice(0, 8);
    if (heaviest.length) {
      lines.push("");
      lines.push("Heaviest entries:");
      for (const e of heaviest) {
        lines.push(`  ${formatBytes(e.bytes).padStart(10)}  ${e.name}`);
      }
    }
  }
  return lines.join("\n");
}

export function parseArgs(argv) {
  const out = { tree: null, tarball: null, budget: DEFAULT_BUDGET_PATH };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tree") out.tree = argv[++i];
    else if (a === "--tarball") out.tarball = argv[++i];
    else if (a === "--budget") out.budget = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

export function installTarball(tarball, prefix = mkdtempSync(join(tmpdir(), "flair-install-weight-"))) {
  if (!tarball || !existsSync(tarball)) {
    return { didNotRun: true, reason: `tarball not found: ${tarball || "(empty path)"}`, prefix };
  }
  const npm = spawnSync(
    "npm",
    ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", tarball],
    { encoding: "utf8" },
  );
  if (npm.status !== 0) {
    const detail = (npm.stderr || npm.stdout || "").trim() || `exit ${npm.status}`;
    return {
      didNotRun: true,
      reason: `npm install --global failed — the gate did not measure a tree. ${detail}`,
      prefix,
    };
  }
  const tree = join(prefix, "lib", "node_modules");
  return { didNotRun: false, prefix, tree };
}

export function run(argv = process.argv.slice(2), io = { log: console.log, err: console.error }) {
  const args = parseArgs(argv);
  if (args.help || (!args.tree && !args.tarball)) {
    io.err(
      "Usage: node scripts/check-install-weight.mjs --tree <node_modules> | --tarball <packed.tgz> [--budget <file>]",
    );
    return EXIT_DID_NOT_RUN;
  }

  const budget = loadBudget(args.budget);
  if (!budget.ok) {
    io.err(formatReport({ status: "did-not-run", reason: budget.reason }));
    return EXIT_DID_NOT_RUN;
  }

  let measured;
  let prefixToClean = null;
  if (args.tarball) {
    const installed = installTarball(args.tarball);
    prefixToClean = installed.prefix;
    if (installed.didNotRun) {
      io.err(formatReport({ status: "did-not-run", reason: installed.reason }));
      if (prefixToClean) rmSync(prefixToClean, { recursive: true, force: true });
      return EXIT_DID_NOT_RUN;
    }
    measured = measureInstalledTree(installed.tree);
  } else {
    measured = measureInstalledTree(args.tree);
  }

  const result = evaluateWeight({ measured, budget });
  const report = formatReport(result);
  if (result.status === "ok") io.log(report);
  else io.err(report);

  if (prefixToClean) rmSync(prefixToClean, { recursive: true, force: true });

  if (result.status === "ok") return EXIT_OK;
  if (result.status === "over") return EXIT_OVER;
  return EXIT_DID_NOT_RUN;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(run());
}
