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
 * When a file legitimately declares a constant whose name matches the version
 * pattern (e.g. a minimum server version capability) and whose value happens to
 * match the target release, it can be listed in NON_RELEASE_VERSION_CONSTANTS
 * with a documented rationale so it is not treated as a release declaration site.
 * Listed constants are guarded against staleness: an entry whose identifier no
 * longer exists in its file fails the check.
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

import { readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  readProjectVersion,
  replaceProjectVersion,
} from "./ci/pyproject-version.mjs";

// cli#1890 condition 6: the release tagger extracts the WHOLE candidate commit
// as DATA (`git archive <sha>` into a scratch dir) and runs THIS file — the
// default branch's checker — over that tree. `--root <dir>` (or
// VERSION_SYNC_ROOT) points the checker at it, and because the tree carries
// every file of the candidate, the discovery scan keeps its full scope: a
// version declaration the inventory does not list is still found. `--list`
// prints the inventory (the release PR's shape check, condition 7b, uses it as
// the allowed set). An extracted tree has no `.git`, so the discovery file list
// falls back to a recursive walk of the root — every file of the candidate.
const ARGV = process.argv.slice(2);
function argValue(name) {
  for (let i = 0; i < ARGV.length; i++) {
    if (ARGV[i] === name) return ARGV[i + 1];
    if (ARGV[i].startsWith(`${name}=`)) return ARGV[i].slice(name.length + 1);
  }
  return undefined;
}
const ROOT_ARG = argValue("--root") ?? process.env.VERSION_SYNC_ROOT;
const NON_RELEASE_ARG = argValue("--non-release-constants") ?? process.env.VERSION_SYNC_NON_RELEASE_CONSTANTS;
const LIST_ONLY = ARGV.includes("--list");
const REPO_ROOT = ROOT_ARG ? resolve(ROOT_ARG) : join(dirname(fileURLToPath(import.meta.url)), "..");

// --- Inventory ---------------------------------------------------------------

// The workspace package.json files release.sh bumps. Their `version`
// field is read and written by release.sh itself; listed here so discovery
// knows they are accounted for.
const PACKAGE_JSONS = [
  "package.json",
  "packages/flair-client/package.json",
  "packages/flair-tool-descriptors/package.json",
  "packages/flair-mcp/package.json",
  "packages/openclaw-flair/package.json",
  "packages/pi-flair/package.json",
  "packages/n8n-nodes-flair/package.json",
  "packages/langgraph-flair/package.json",
  "packages/adk-flair-js/package.json",
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
    // Global so occurrences can be counted; see readDeclared.
    pattern: /(\bTOOL_VERSION\s*=\s*")([^"]*)(")/g,
  },
  {
    path: "packages/adk-flair/pyproject.toml",
    label: "version",
    // The `[project]` table's own `version = "X.Y.Z"` (TOML string), read and
    // written through the SHARED helper (scripts/ci/pyproject-version.mjs) the
    // auto-tagger uses — a `[tool.x]` version line above `[project]` must not be
    // mistaken for the package version.
    // The adk-flair package tracks flair's minor while 0.x (compat-signal
    // policy), so this must be bumped in lockstep with every release.
    project: true,
  },
];

const INVENTORY = new Set([...PACKAGE_JSONS, ...SOURCE_VERSION_FILES.map((f) => f.path)]);

// --- Non-release version constants -------------------------------------------

/**
 * Constants whose names look like version declarations (matching
 * VERSION_DECLARATION) but are not release version declarations — e.g. a
 * minimum server version capability or protocol minimum.
 *
 * Each entry names:
 *   - file: repo-relative path (forward slashes)
 *   - identifier: the exact constant/variable name
 *   - reason: documented rationale explaining why this is not a release site
 *
 * An entry whose identifier is not found in its file fails the check (staleness
 * guard), so this list cannot drift or accumulate dead entries.
 */
export const NON_RELEASE_VERSION_CONSTANTS = [];

export function loadNonReleaseConstants(customArg = NON_RELEASE_ARG) {
  if (!customArg) {
    return NON_RELEASE_VERSION_CONSTANTS;
  }
  try {
    const trimmed = customArg.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [parsed];
    }
    const absPath = resolve(REPO_ROOT, trimmed);
    const content = readFileSync(absPath, "utf8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    console.error(`❌ Could not load non-release constants from "${customArg}": ${err.message}`);
    process.exit(1);
  }
}

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

/**
 * A version *declaration*: an identifier ending in "version" (case-insensitive,
 * so both `version` and `TOOL_VERSION` match), optionally quoted, then `:` or
 * `=`, then a semver. Capture group 1 is the identifier name; capture group 2
 * is the declared version.
 *
 * This is a fixed literal rather than a pattern built around the version we are
 * looking for. Interpolating the version would mean escaping it, and would
 * build a RegExp from a non-literal — which Semgrep blocks, correctly. Matching
 * every declaration and comparing the captured value with `===` is both safer
 * and more exact: no escaping, no regex metacharacter surface, and no chance of
 * "0.30.0" matching inside "0.30.01".
 */
export const VERSION_DECLARATION =
  /(?:^|\W)['"]?([\w$]*version[\w$]*)['"]?\s*[:=]\s*['"]?(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)(?![\d.])/gi;

export function declaresVersion(path, text, expected, nonReleaseConstants = []) {
  const normPath = path.replace(/\\/g, "/");
  const allowed = nonReleaseConstants.filter(
    (entry) => entry.file.replace(/\\/g, "/") === normPath,
  );

  for (const m of text.matchAll(VERSION_DECLARATION)) {
    const identifier = m[1];
    const declared = m[2];
    if (declared !== expected) continue;

    // A documented non-release constant in this file is skipped
    const isAllowed = allowed.some((entry) => entry.identifier === identifier);
    if (!isAllowed) {
      return true;
    }
  }
  return false;
}

function walkFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, base, out);
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join("/"));
  }
  return out;
}

function trackedFiles() {
  if (ROOT_ARG) {
    // A materialised tree (no .git): the files present ARE the list to scan.
    try {
      return walkFiles(REPO_ROOT).sort();
    } catch (err) {
      console.error(`❌ Could not walk ${REPO_ROOT} (${err.message.trim()}).`);
      console.error("   The discovery scan cannot run, and must not pass silently.");
      process.exit(1);
    }
  }
  let out;
  try {
    out = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-z"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    console.error(`❌ Could not list tracked files (git ls-files failed: ${err.message.trim()}).`);
    console.error("   The discovery scan cannot run, and must not pass silently.");
    process.exit(1);
  }
  return out.split("\0").filter(Boolean);
}

/**
 * Decode as UTF-8 unconditionally. There is deliberately NO binary sniff: the
 * obvious one — "contains a NUL byte" — excluded `src/mcp-client-assertion.ts`,
 * a real TypeScript file that embeds literal NULs as a cache-key delimiter.
 * A source file quietly dropped from the scan is precisely the failure this
 * script exists to prevent. Binary files are harmless to scan: a GIF cannot
 * accidentally contain the ASCII text of a version declaration. Only the size
 * cap skips anything, and skips are reported.
 */
function readTextOrNull(abs) {
  try {
    if (statSync(abs).size > MAX_SCAN_BYTES) return null;
    return readFileSync(abs).toString("utf8");
  } catch {
    return null;
  }
}

// --- Modes -------------------------------------------------------------------

/**
 * Both callers require EXACTLY ONE declaration per listed file. A file carrying
 * two is ambiguous: `readDeclared` would have to pick one to report, and the
 * discovery scan would not catch a disagreement between them — it only asks
 * whether a file is in the inventory, not whether every declaration inside it
 * agrees. Refusing beats guessing.
 */
function matchesIn(src, pattern) {
  return [...src.matchAll(pattern)];
}

function readDeclared(file) {
  const abs = join(REPO_ROOT, file.path);
  const src = readFileSync(abs, "utf8");
  if (file.project) {
    // Round 7, item 4: report the READER's actual reason — a present but
    // unsupported file is a different message from no declaration.
    const r = readProjectVersion(src);
    if (r.kind === "version") return { ok: true, version: r.version };
    if (r.kind === "unsupported") {
      return { ok: false, reason: `${file.path}: present but unsupported: ${r.reason}` };
    }
    if (r.reason === "dynamic") {
      return { ok: false, reason: `${file.path}: [project] declares version as dynamic, which this checker refuses (a dynamic version cannot be verified or rewritten)` };
    }
    return { ok: false, reason: `${file.path}: no [project].version declaration (${r.reason})` };
  }
  const m = matchesIn(src, file.pattern);
  if (m.length === 0) {
    return { ok: false, reason: `no ${file.label} declaration matched in ${file.path}` };
  }
  if (m.length > 1) {
    return {
      ok: false,
      reason: `${file.path} has ${m.length} ${file.label} declarations; expected exactly 1.`,
    };
  }
  return { ok: true, version: m[0][2] };
}

function write(version) {
  // ALL-OR-NOTHING (flair#1928 round 5, item 4): compute EVERY replacement
  // first; if ANY refuses, write NOTHING and exit non-zero naming the refusal.
  // A half-bumped tree (flair-bench bumped, the pyproject refused) is worse than
  // no bump at all.
  const edits = [];
  for (const file of SOURCE_VERSION_FILES) {
    const abs = join(REPO_ROOT, file.path);
    const src = readFileSync(abs, "utf8");
    if (file.project) {
      const next = replaceProjectVersion(src, version);
      if (next === null) {
        // A DECLARATION EXISTS but the rewrite was refused: say it could not be
        // safely rewritten, and why — not "no declaration".
        const r = readProjectVersion(src);
        const why =
          r.kind === "version"
            ? "a version declaration exists, but the rewrite would not change only [project].version (the tomllib re-verify refused)"
            : r.kind === "unsupported"
              ? `present but unsupported: ${r.reason}`
              : r.reason === "dynamic"
                ? "[project] declares version as dynamic, which this checker refuses to rewrite"
                : `no [project].version declaration (${r.reason})`;
        console.error(`❌ ${file.path}: the version could not be safely rewritten: ${why}`);
        process.exit(1);
      }
      edits.push({ abs, path: file.path, label: file.label, next });
      continue;
    }
    const n = matchesIn(src, file.pattern).length;
    if (n !== 1) {
      console.error(
        (n === 0
          ? `❌ ${file.path}: no ${file.label} declaration to rewrite. The pattern in scripts/check-version-sync.mjs no longer matches this file.`
          : `❌ ${file.path}: ${n} ${file.label} declarations, expected exactly 1. Refusing to rewrite an ambiguous file.`) +
          ` NOTHING was written.`,
      );
      process.exit(1);
    }
    edits.push({ abs, path: file.path, label: file.label, next: src.replace(file.pattern, `$1${version}$3`) });
  }
  // Every replacement is known-good: write them all.
  for (const e of edits) {
    writeFileSync(e.abs, e.next);
    console.log(`  ✓ ${e.path} ${e.label} → ${version}`);
  }
}

function hasIdentifier(text, identifier) {
  let index = text.indexOf(identifier);
  while (index !== -1) {
    const before = index > 0 ? text[index - 1] : "";
    const after = index + identifier.length < text.length ? text[index + identifier.length] : "";
    const isWordChar = (c) =>
      (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_" || c === "$";
    if (!isWordChar(before) && !isWordChar(after)) {
      return true;
    }
    index = text.indexOf(identifier, index + 1);
  }
  return false;
}

export function verify(expected, customNonReleaseConstants) {
  const nonReleaseConstants = customNonReleaseConstants ?? loadNonReleaseConstants();
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

  // 2. Non-release constants: staleness guard.
  // Every entry in nonReleaseConstants must exist in its file; if a constant was
  // removed, renamed, or its file deleted, fail closed so the list cannot drift.
  for (const entry of nonReleaseConstants) {
    const normFile = entry.file.replace(/\\/g, "/");
    const absPath = join(REPO_ROOT, normFile);
    const text = readTextOrNull(absPath);
    if (text === null) {
      problems.push(
        `non-release constant "${entry.identifier}" in ${normFile} could not be read or does not exist (${entry.reason})`,
      );
      continue;
    }
    if (!hasIdentifier(text, entry.identifier)) {
      problems.push(
        `stale non-release constant: "${entry.identifier}" was not found in ${normFile} (${entry.reason})`,
      );
    }
  }

  // 3. Discovery: nothing off-inventory may declare `expected`.
  const files = trackedFiles();
  if (files.length === 0) {
    console.error("❌ git ls-files returned nothing — this check cannot run, and must not pass silently.");
    process.exit(1);
  }

  const hits = [];
  const skipped = [];
  for (const path of files) {
    if (isExcluded(path)) continue;
    const text = readTextOrNull(join(REPO_ROOT, path));
    // Over the size cap, or unreadable. Report rather than skip silently — a
    // file the scan could not read is not a file the scan cleared. No tracked
    // file hits this today; if one starts to, it should be visible.
    if (text === null) {
      skipped.push(path);
      continue;
    }
    if (declaresVersion(path, text, expected, nonReleaseConstants)) hits.push(path);
  }

  // Positive control. The inventory files themselves declare `expected`, so a
  // scan that finds nothing at all did not run correctly — an unrun check must
  // not look like a pass.
  //
  // Conditioned on the inventory being clean, and that condition is load-bearing.
  // When `expected` comes from an argument rather than from package.json — the
  // tag-time gate, `--publish`, the post-bump re-check — a tree that simply is
  // not at that version ALSO produces zero hits. Reporting "the scan is broken"
  // there would send the operator after the instrument instead of the tag.
  // Tagging v0.99.0 against a 0.31.0 tree hit exactly that. If the inventory
  // check already found problems, those explain the zero hits; report them.
  if (hits.length === 0 && problems.length === 0) {
    console.error(`❌ Scanned ${files.length} tracked files and found no declaration of ${expected} anywhere,`);
    console.error(`   not even in package.json, yet every known site reported the right version.`);
    console.error(`   Those cannot both be true: the scan is broken, not the tree.`);
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

  if (skipped.length > 0) {
    console.log(`  note: ${skipped.length} unreadable (binary/oversized) file(s) not scanned:`);
    for (const p of skipped.slice(0, 10)) console.log(`    ${p}`);
  }
  console.log(
    `✓ Version ${expected} consistent across ${INVENTORY.size} declaration sites; ` +
      `no unknown sites in ${files.length} tracked files.`,
  );
}

// --- Entry -------------------------------------------------------------------

// Positional args, with `--root <dir>`, `--non-release-constants <arg>`, and `--list` removed.
const argv = [];
for (let i = 0; i < ARGV.length; i++) {
  if (ARGV[i] === "--root" || ARGV[i] === "--non-release-constants") {
    i++;
    continue;
  }
  if (ARGV[i].startsWith("--root=") || ARGV[i].startsWith("--non-release-constants=")) {
    continue;
  }
  if (ARGV[i] === "--list") continue;
  argv.push(ARGV[i]);
}

const thisFile = fileURLToPath(import.meta.url);
const invokedAs = process.argv[1] ? resolve(process.argv[1]) : null;
const isMain = invokedAs !== null && thisFile === invokedAs;

if (isMain) {
  if (LIST_ONLY) {
    // The inventory, one path per line. Condition 7b uses it as the allowed set
    // for the release PR's changed files; condition 6 no longer materialises from
    // it — the whole candidate tree is extracted as data and walked.
    for (const path of [...PACKAGE_JSONS, ...SOURCE_VERSION_FILES.map((f) => f.path)]) console.log(path);
    process.exit(0);
  } else if (argv[0] === "--write") {
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
}
