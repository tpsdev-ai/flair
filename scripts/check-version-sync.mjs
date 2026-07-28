#!/usr/bin/env node
/**
 * check-version-sync.mjs — the release version is declared in more than one
 * place. Keep every one of them in lockstep, and make it impossible to add a
 * new one without the release script learning about it.
 *
 * PROBLEM. `scripts/release.sh` bumped the eight `package.json` files and
 * nothing else. `packages/flair-bench/src/version.ts` also declares the
 * version — deliberately, as a plain constant rather than a runtime JSON
 * import — and a test asserts it equals its package.json. So every release
 * went red in CI until an operator remembered to hand-edit that constant.
 * Worse, release.sh's own local test step runs only `test/unit/`,
 * `test/integration/` and `test/unit-isolated/`; the flair-bench package
 * tests are a separate CI job. The release therefore built, tested and pushed
 * green locally and only failed after the branch, the changelog assembly and
 * the PR already existed. Recovering from a half-run release is the expensive
 * part.
 *
 * FIX, two halves:
 *
 *   1. INVENTORY — an explicit list of every file that must carry the release
 *      version, and the ability to both verify and rewrite it. release.sh
 *      calls `--write` to bump, and this same module owns the pattern used to
 *      do it, so the bumping regex and the checking regex cannot drift apart.
 *
 *   2. DISCOVERY — a scan for anything OUTSIDE the inventory that declares the
 *      reference version. Half 1 alone fixes today's file; half 2 is what
 *      stops the class, because the next version-bearing file someone adds
 *      fails this check at the PR that adds it rather than at a release
 *      months later.
 *
 * Discovery matches a version *declaration* (`version: "X.Y.Z"`,
 * `SOME_VERSION = "X.Y.Z"`), not a mention. That distinction is load-bearing:
 * `src/cli.ts` carries the current version in prose comments about a past
 * upgrade, and a naive substring scan flags it on every release.
 *
 * Discovery is also pinned to the reference version, not to "any semver".
 * Several files legitimately declare unrelated versions — an MCP `serverInfo`,
 * a scaffold template's default, `MIN_HARPER_VERSION`, the Hermes plugin
 * manifest at its own 0.1.0 — and an any-semver scan would need an allowlist
 * for all of them, which is one more thing to rot. A file that does not carry
 * the monorepo version is a file the release must not touch.
 *
 * Usage:
 *   node scripts/check-version-sync.mjs             verify against root package.json
 *   node scripts/check-version-sync.mjs 0.31.0      verify everything is at 0.31.0
 *   node scripts/check-version-sync.mjs --write 0.31.0
 *                                                   rewrite the non-package.json
 *                                                   inventory files to 0.31.0
 *
 * Exit codes:
 *   0 — every declaration agrees, and nothing declares it off-inventory
 *   1 — a mismatch, an unknown declaration site, or the check could not run
 */

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- Inventory ---------------------------------------------------------------

// The eight workspace package.json files release.sh bumps. Their `version`
// field is read and written by release.sh itself; listed here so discovery
// knows they are accounted for.
const PACKAGE_JSONS = [
  "package.json",
  "packages/flair-client/package.json",
  "packages/flair-mcp/package.json",
  "packages/openclaw-flair/package.json",
  "packages/pi-flair/package.json",
  "packages/n8n-nodes-flair/package.json",
  "packages/langgraph-flair/package.json",
  "packages/flair-bench/package.json",
];

// Version declarations that live in source rather than a package.json.
// `--write` rewrites these; release.sh has no separate copy of the pattern.
const SOURCE_VERSION_FILES = [
  {
    path: "packages/flair-bench/src/version.ts",
    label: "TOOL_VERSION",
    // Matches: export const TOOL_VERSION = "X.Y.Z";
    // Illustrative comments use a placeholder deliberately — a real version
    // here would be a declaration site, and discovery below would flag it.
    pattern: /(\bTOOL_VERSION\s*=\s*")([^"]*)(")/,
  },
];

const INVENTORY = new Set([...PACKAGE_JSONS, ...SOURCE_VERSION_FILES.map((f) => f.path)]);

// --- Discovery scope ---------------------------------------------------------

// Excluded from the scan, with the reason each is not a declaration site:
//   lockfiles      resolved dependency versions, not our declaration
//   CHANGELOG      the historical record; rewriting it would destroy history
//   .changelog/    unreleased fragments, prose about shipped versions
//   test fixtures  deliberately pin literal versions to reproduce past bugs
const isExcluded = (p) =>
  p === "bun.lock" ||
  p === "package-lock.json" ||
  p === "yarn.lock" ||
  p === "CHANGELOG.md" ||
  p.startsWith(".changelog/") ||
  p.startsWith("test/") ||
  p.includes("/test/") ||
  p.includes("node_modules/");

const MAX_SCAN_BYTES = 2 * 1024 * 1024;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A version *declaration* carrying `version`: an identifier ending in
 * "version" (case-insensitive, so both `version` and `TOOL_VERSION` match),
 * optionally quoted, then `:` or `=`, then the version. The trailing
 * lookahead stops "0.30.0" from matching inside "0.30.01".
 */
function declarationPattern(version) {
  return new RegExp(
    String.raw`(?:^|\W)['"]?[\w$]*version[\w$]*['"]?\s*[:=]\s*['"]?` +
      escapeRegExp(version) +
      String.raw`(?![\d.])`,
    "i",
  );
}

function trackedFiles() {
  const out = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean);
}

function readTextOrNull(abs) {
  try {
    if (statSync(abs).size > MAX_SCAN_BYTES) return null;
    const buf = readFileSync(abs);
    if (buf.includes(0)) return null; // binary
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

// --- Modes -------------------------------------------------------------------

/**
 * `--write` rewrites the FIRST match only, so a file carrying two declarations
 * would be half-bumped and the second left stale — invisible to the discovery
 * scan, which only asks whether a file is in the inventory, not whether every
 * declaration in it agrees. Require exactly one.
 */
function countMatches(src, pattern) {
  return (src.match(new RegExp(pattern.source, pattern.flags + "g")) ?? []).length;
}

function readDeclared(file) {
  const abs = join(REPO_ROOT, file.path);
  const src = readFileSync(abs, "utf8");
  const n = countMatches(src, file.pattern);
  if (n === 0) {
    return { ok: false, reason: `no ${file.label} declaration matched in ${file.path}` };
  }
  if (n > 1) {
    return {
      ok: false,
      reason: `${file.path} has ${n} ${file.label} declarations; --write rewrites only the first. Reduce it to one.`,
    };
  }
  return { ok: true, version: src.match(file.pattern)[2] };
}

function write(version) {
  for (const file of SOURCE_VERSION_FILES) {
    const abs = join(REPO_ROOT, file.path);
    const src = readFileSync(abs, "utf8");
    const n = countMatches(src, file.pattern);
    if (n !== 1) {
      console.error(
        n === 0
          ? `❌ ${file.path}: no ${file.label} declaration to rewrite. The pattern in scripts/check-version-sync.mjs no longer matches this file.`
          : `❌ ${file.path}: ${n} ${file.label} declarations, expected exactly 1. Rewriting would leave ${n - 1} stale.`,
      );
      process.exit(1);
    }
    writeFileSync(abs, src.replace(file.pattern, `$1${version}$3`));
    console.log(`  ✓ ${file.path} ${file.label} → ${version}`);
  }
}

function verify(expected) {
  const problems = [];

  // 1. Inventory: every listed declaration must be at `expected`.
  for (const path of PACKAGE_JSONS) {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, path), "utf8"));
    if (pkg.version !== expected) {
      problems.push(`${path}: "version" is ${pkg.version}, expected ${expected}`);
    }
  }
  for (const file of SOURCE_VERSION_FILES) {
    const got = readDeclared(file);
    if (!got.ok) {
      problems.push(got.reason);
    } else if (got.version !== expected) {
      problems.push(`${file.path}: ${file.label} is ${got.version}, expected ${expected}`);
    }
  }

  // 2. Discovery: nothing off-inventory may declare `expected`.
  const files = trackedFiles();
  if (files.length === 0) {
    console.error("❌ git ls-files returned nothing — this check cannot run, and must not pass silently.");
    process.exit(1);
  }

  const pattern = declarationPattern(expected);
  const hits = [];
  for (const path of files) {
    if (isExcluded(path)) continue;
    const text = readTextOrNull(join(REPO_ROOT, path));
    if (text === null) continue;
    if (pattern.test(text)) hits.push(path);
  }

  // Positive control. The inventory files themselves declare `expected`, so a
  // scan that finds nothing at all did not run correctly — an unrun check must
  // not look like a pass.
  if (hits.length === 0) {
    console.error(`❌ Scanned ${files.length} tracked files and found no declaration of ${expected} anywhere,`);
    console.error(`   not even in package.json. The scan is broken, not the tree.`);
    process.exit(1);
  }

  const unknown = hits.filter((p) => !INVENTORY.has(p));
  if (unknown.length > 0) {
    problems.push(
      `these files declare version ${expected} but the release script does not bump them:\n` +
        unknown.map((p) => `      ${p}`).join("\n"),
    );
  }

  if (problems.length > 0) {
    console.error("");
    console.error(`❌ Version declarations are not in sync (expected ${expected}):`);
    console.error("");
    for (const p of problems) console.error(`  - ${p}`);
    console.error("");
    console.error("  Fix: bump the file to match, or — if it is a new declaration site — add it to");
    console.error("  SOURCE_VERSION_FILES in scripts/check-version-sync.mjs so release.sh bumps it,");
    console.error("  and to the `git add` list in scripts/release.sh so the bump is committed.");
    console.error("");
    process.exit(1);
  }

  console.log(
    `✓ Version ${expected} consistent across ${INVENTORY.size} declaration sites; ` +
      `no unknown sites in ${files.length} tracked files.`,
  );
}

// --- Entry -------------------------------------------------------------------

const argv = process.argv.slice(2);

if (argv[0] === "--write") {
  const version = argv[1];
  if (!version) {
    console.error("Usage: check-version-sync.mjs --write <version>");
    process.exit(1);
  }
  write(version);
} else {
  const expected = argv[0] ?? JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;
  verify(expected);
}
