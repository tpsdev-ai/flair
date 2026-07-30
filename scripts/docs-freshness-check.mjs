#!/usr/bin/env node
// Docs-freshness gate (flair#618).
//
// Catches the doc-rot classes an adopter audit keeps surfacing — stale version
// pins, port drift, package-name drift, no unreleased changelog entry despite
// merged work, and CLI commands shipping with no help text. Each check fails
// independently with a `file:line` pointer so a contributor knows exactly what
// to fix. Runnable locally (`node scripts/docs-freshness-check.mjs`) and in CI.
//
// Design note on ACCURACY: this gate must never block a legitimate PR. Where a
// naive rule would false-positive on legitimate historical / example / external
// references (e.g. "changed in v0.4.0", `git tag v0.11.0`, `nvm v0.40.1`, the
// documented legacy 9926 port), the check is scoped or context-aware, and every
// context-sensitive check honors an inline `docs-freshness-allow` escape hatch.
//
// Facts are derived from CODE, not hardcoded, so the gate tracks the source of
// truth: current version + package name from package.json, default port from
// src/cli.ts, the CLI command tree from the built dist/cli.js.
//
// Design note on SKIPS (flair#953): a check that could not run must never render
// as a check that passed. See the "Check results" section below — `pass`,
// `skipped` and `fail` are three distinct states in the output, in the tally and
// in the exit code, and a check that examined zero items is automatically a skip.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CATEGORIES,
  FRAGMENT_DIR_REL,
  locateUnreleased,
  readFragments,
  strayUnreleasedEntries,
} from "./changelog-fragments.mjs";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const IN_CI = !!process.env.GITHUB_ACTIONS;
const ALLOW_MARKER = "docs-freshness-allow";

// ─── Source-of-truth facts ────────────────────────────────────────────────────

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const CURRENT_VERSION = pkg.version; // e.g. "0.21.0"
const PKG_NAME = pkg.name; // e.g. "@tpsdev-ai/flair"
const PKG_SCOPE = PKG_NAME.startsWith("@") ? PKG_NAME.split("/")[0] : null; // "@tpsdev-ai"

// Default REST port lives in src/cli.ts as `const DEFAULT_PORT = <n>;`.
function readDefaultPort() {
  const src = readFileSync(join(ROOT, "src", "cli.ts"), "utf8");
  const m = src.match(/const\s+DEFAULT_PORT\s*=\s*(\d+)\s*;/);
  if (!m) throw new Error("could not find `const DEFAULT_PORT = <n>;` in src/cli.ts");
  return Number(m[1]);
}
const DEFAULT_PORT = readDefaultPort();
// Pre-bump defaults, retired to avoid Harper port collisions. Immutable history:
// docs may reference these ONLY in an explicit legacy/historical context.
const LEGACY_PORTS = [9926, 9925];

// ─── Doc corpus ────────────────────────────────────────────────────────────────

// Adopter-facing prose docs. docs/notes/** is internal design scratch — excluded.
function collectProseDocs() {
  const out = [];
  for (const rootFile of ["README.md", "SECURITY.md", "CONTRIBUTING.md"]) {
    if (existsSync(join(ROOT, rootFile))) out.push(rootFile);
  }
  const docsDir = join(ROOT, "docs");
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = relative(ROOT, full);
      if (statSync(full).isDirectory()) {
        if (rel === join("docs", "notes")) continue; // internal
        walk(full);
      } else if (name.endsWith(".md")) {
        out.push(rel);
      }
    }
  };
  if (existsSync(docsDir)) walk(docsDir);
  return out.sort();
}
const PROSE_DOCS = collectProseDocs();

// Getting-started docs must not hardcode a concrete Flair version at all — every
// version there should be a `vX.Y.Z` placeholder or an external tool's version.
const GETTING_STARTED_DOCS = ["docs/quickstart.md"].filter((f) => existsSync(join(ROOT, f)));

const fileLines = new Map();
function linesOf(relPath) {
  if (!fileLines.has(relPath)) {
    fileLines.set(relPath, readFileSync(join(ROOT, relPath), "utf8").split("\n"));
  }
  return fileLines.get(relPath);
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

// A version occurrence is exempt if its line (or the line above it) carries the
// inline allow marker — the escape hatch for a genuinely-intentional reference.
function hasAllow(lines, idx) {
  return (lines[idx] && lines[idx].includes(ALLOW_MARKER)) ||
    (idx > 0 && lines[idx - 1] && lines[idx - 1].includes(ALLOW_MARKER));
}

const EXTERNAL_TOOL_RE = /\b(nvm|node|nodejs\.org|npmjs|homebrew|brew|harper|python|docker|semver)\b/i;
const LEGACY_MARKER_RE = /(legacy|old default|\bold\b|changed from|changed to|predate|before the|before that|was on|migrat|used to|prior to|pre-bump|no longer|formerly|historic)/i;

// ─── Check results: pass, SKIPPED, fail ───────────────────────────────────────
//
// A skip is not a pass (flair#953). This gate spent its whole life printing
// `✓ cli-command-descriptions` on every machine where `dist/cli.js` had not been
// built, under a summary line reading "All docs-freshness checks passed" —
// nothing about the CLI's command descriptions had been verified. The defect was
// never in the checking logic; it was in what the gate does when a check cannot
// execute. Three states, carried through the per-check line, the summary tally
// and the exit code:
//
//   ✓ pass     — the check ran over a non-empty corpus and found nothing
//   ⊘ skipped  — the check could not run; NOTHING it covers has been verified
//   ✗ N        — the check ran and found N problems
//
// Exit: 1 if anything failed, 2 if nothing failed but something did not run,
// 0 only when every check ran and passed.
//
// A check returns either an array of failures (the terse form, still supported)
// or `{ failures, skips, scanned }`:
//   failures — [{ file, line, msg }]
//   skips    — [{ reason, remedy }], each an unmet prerequisite
//   scanned  — how many items the check actually examined, or null when the
//              check has no item corpus. **scanned === 0 is promoted to a skip
//              automatically**: a loop that never entered its body reports the
//              same thing as a loop that examined four hundred files and found
//              nothing, which is the silent variant of this same bug. Every
//              glob, filter and `existsSync` filter in this file is one rename
//              away from producing it.
function skip(reason, remedy) {
  return { reason, remedy };
}

function normalizeResult(r) {
  if (Array.isArray(r)) return { failures: r, skips: [], scanned: null };
  return {
    failures: r?.failures ?? [],
    skips: r?.skips ?? [],
    scanned: r?.scanned ?? null,
  };
}

// ─── Check runner ─────────────────────────────────────────────────────────────

const checks = [];
// `unit` names what the check counts, for the "scanned N units" line and for the
// zero-corpus skip message. Pass null when the check has no item corpus.
function defineCheck(name, unit, fn) {
  checks.push({ name, unit, fn });
}

// A gate that runs zero checks reports success just as loudly as a gate that runs
// six — the same defect one level up. This manifest is the contract: if a check
// stops registering (renamed, thrown out by a bad merge, lost to a refactor of
// `defineCheck`), the gate fails instead of quietly shrinking. Removing a check
// is a deliberate act; deleting its name from here is how you say so.
const EXPECTED_CHECKS = [
  "stale-install-pin",
  "getting-started-version-placeholder",
  "port-drift",
  "package-name-drift",
  "changelog-unreleased",
  "cli-command-descriptions",
  "broken-backup-restore-docs",
];

// ── Check 1: stale install pin of the root package ──────────────────────────────
// FAILS on any `npm install`/`bun add`/etc. that pins `@tpsdev-ai/flair@<v>` to a
// version other than the current one. (Sub-packages version independently, so
// only the root package — validatable from this package.json — is checked.)
defineCheck("stale-install-pin", "prose doc", () => {
  const failures = [];
  if (!PKG_NAME) {
    return { failures, scanned: null, skips: [skip(
      "package.json has no `name`, so there is no package spec to look for in install commands — no doc was checked for a stale pin.",
      "restore `name` in package.json",
    )] };
  }
  const installRe = /\b(npm\s+(?:install|i|add)|pnpm\s+add|yarn\s+add|bun\s+add|bunx)\b/;
  const escName = PKG_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pinRe = new RegExp(`${escName}@(\\d+\\.\\d+\\.\\d+)`, "g");
  for (const doc of PROSE_DOCS) {
    const lines = linesOf(doc);
    lines.forEach((line, i) => {
      if (!installRe.test(line)) return;
      for (const m of line.matchAll(pinRe)) {
        if (m[1] !== CURRENT_VERSION && !hasAllow(lines, i)) {
          failures.push({
            file: doc, line: i + 1,
            msg: `install command pins ${PKG_NAME}@${m[1]} but current version is ${CURRENT_VERSION}. Drop the pin (install latest) or bump it.`,
          });
        }
      }
    });
  }
  return { failures, scanned: PROSE_DOCS.length };
});

// ── Check 2: getting-started version placeholder discipline ─────────────────────
// FAILS on any concrete Flair-style version (v0.0.0) in a getting-started doc.
// These docs should use the `vX.Y.Z` placeholder so example output never rots.
// External-tool version lines (node/nvm/brew/harper) are exempt.
defineCheck("getting-started-version-placeholder", "getting-started doc", () => {
  const failures = [];
  const verRe = /v(\d+)\.(\d+)\.(\d+)/g;
  for (const doc of GETTING_STARTED_DOCS) {
    const lines = linesOf(doc);
    lines.forEach((line, i) => {
      if (EXTERNAL_TOOL_RE.test(line) || hasAllow(lines, i)) return;
      for (const m of line.matchAll(verRe)) {
        const ver = `${m[1]}.${m[2]}.${m[3]}`;
        if (ver === CURRENT_VERSION) continue; // exact current is acceptable
        failures.push({
          file: doc, line: i + 1,
          msg: `getting-started doc hardcodes version v${ver}. Use the 'vX.Y.Z' placeholder instead so it never goes stale (or add a '${ALLOW_MARKER}' comment if intentional).`,
        });
      }
    });
  }
  // GETTING_STARTED_DOCS is an existsSync filter over a hardcoded path list, so
  // renaming docs/quickstart.md empties it — and before flair#953 that rendered
  // as `✓ pass`, indistinguishable from a clean scan.
  return { failures, scanned: GETTING_STARTED_DOCS.length };
});

// ── Check 3: port drift ─────────────────────────────────────────────────────────
// FAILS when a doc references a retired legacy Flair port (9926/9925) as if it
// were current. A reference inside an explicit legacy/historical context — the
// same line, the 3 preceding lines, or the nearest preceding heading — is exempt.
defineCheck("port-drift", "prose doc", () => {
  const failures = [];
  const legacyRe = new RegExp(`(?<!\\d)(${LEGACY_PORTS.join("|")})(?!\\d)`);
  for (const doc of PROSE_DOCS) {
    const lines = linesOf(doc);
    // Precompute nearest preceding heading for each line.
    let lastHeading = "";
    lines.forEach((line, i) => {
      if (/^#{1,6}\s/.test(line)) lastHeading = line;
      const m = line.match(legacyRe);
      if (!m) return;
      const windowText = [
        lastHeading,
        lines[i - 3] ?? "", lines[i - 2] ?? "", lines[i - 1] ?? "", line,
      ].join("\n");
      if (LEGACY_MARKER_RE.test(windowText) || hasAllow(lines, i)) return;
      failures.push({
        file: doc, line: i + 1,
        msg: `references retired Flair port ${m[1]} as current; the default is now ${DEFAULT_PORT} (src/cli.ts DEFAULT_PORT). Update it, or mark the surrounding context legacy/historical (or add a '${ALLOW_MARKER}' comment).`,
      });
    });
  }
  return { failures, scanned: PROSE_DOCS.length };
});

// ── Check 4: package-name / scope drift ─────────────────────────────────────────
// FAILS on any scoped package whose name contains "flair" but whose scope is not
// our scope (e.g. a typo'd `@tpsdev/flair` missing the `-ai`).
defineCheck("package-name-drift", "prose doc", () => {
  const failures = [];
  if (!PKG_SCOPE) {
    return { failures, scanned: null, skips: [skip(
      `the root package '${PKG_NAME}' is unscoped, so there is no expected scope to compare doc references against — no doc was checked for scope drift.`,
      "publish the root package under a scope, or delete this check deliberately",
    )] };
  }
  // Placeholder scopes used in naming-convention docs ("publish under @scope/…").
  const PLACEHOLDER_SCOPES = new Set(["scope", "your-scope", "yourscope", "org", "myorg", "example"]);
  const scopedRe = /@([a-z0-9][a-z0-9-]*)\/([a-z0-9-]*flair[a-z0-9-]*)/gi;
  for (const doc of PROSE_DOCS) {
    const lines = linesOf(doc);
    lines.forEach((line, i) => {
      if (hasAllow(lines, i)) return;
      for (const m of line.matchAll(scopedRe)) {
        const scope = `@${m[1]}`;
        // Skip naming-convention placeholders: a placeholder scope word, or a
        // glob/placeholder pattern (`@scope/flair-bridge-*`, `@org/flair-<name>`).
        if (PLACEHOLDER_SCOPES.has(m[1].toLowerCase())) continue;
        const after = line[m.index + m[0].length];
        if (after === "*" || after === "<") continue;
        if (scope.toLowerCase() !== PKG_SCOPE.toLowerCase()) {
          failures.push({
            file: doc, line: i + 1,
            msg: `package '${m[0]}' uses scope '${scope}' but Flair packages are published under '${PKG_SCOPE}'. Fix the scope.`,
          });
        }
      }
    });
  }
  return { failures, scanned: PROSE_DOCS.length };
});

// ── Check 5: unreleased changelog entries exist when work has landed ────────────
// FAILS when feat/fix commits exist since the latest v* tag but no changelog
// fragment is staged under .changelog/unreleased/. Degrades to a skip (never a
// false fail) when there is no tag or git history to compare against.
//
// Entries moved out of CHANGELOG.md's [Unreleased] block and into one file per
// change (flair#835) — concurrent PRs were conflicting on those lines every time,
// and resolving a conflict dismisses approvals. The gate's power is unchanged:
// work landed + nothing written down is still a hard failure. It gains two
// failure modes it could not previously have, both of them silent-loss vectors:
// a fragment that cannot be parsed (fail rather than skip it), and a hand-written
// entry left in [Unreleased] (the release step overwrites that body).
// `scanned` is null: this check reads one file rather than a corpus, so a
// zero-item guard says nothing useful about it. Its did-not-run condition is the
// git skip below, which is stated explicitly.
defineCheck("changelog-unreleased", null, () => {
  const changelogPath = join(ROOT, "CHANGELOG.md");
  if (!existsSync(changelogPath)) {
    return { failures: [], scanned: null, skips: [skip(
      "CHANGELOG.md does not exist, so no changelog discipline was verified at all.",
      "restore CHANGELOG.md, or delete this check deliberately",
    )] };
  }
  const lines = readFileSync(changelogPath, "utf8").split("\n");
  const loc = locateUnreleased(lines);
  if (!loc) {
    return [{ file: "CHANGELOG.md", line: 1, msg: "no '## [Unreleased]' section found. Add one so in-flight work is recorded." }];
  }

  // A malformed fragment is a failure, never a skip. Silently ignoring a file it
  // could not place is exactly how an entry disappears without anyone noticing.
  let fragments;
  try {
    fragments = readFragments();
  } catch (err) {
    return [{ file: `${FRAGMENT_DIR_REL}/`, line: 1, msg: `${err?.message ?? err}` }];
  }
  const hasContent = fragments.length > 0;

  const failures = [];

  // The release step REPLACES the [Unreleased] body, so an entry written there by
  // hand is lost at the version cut. Catch it while it is still cheap to move.
  const stray = strayUnreleasedEntries(loc.body);
  if (stray.length > 0) {
    failures.push({
      file: "CHANGELOG.md", line: loc.start + 2,
      msg: `[Unreleased] has ${stray.length} hand-written entr${stray.length === 1 ? "y" : "ies"}; the release step replaces this section's body, so ${stray.length === 1 ? "it" : "they"} would be silently dropped. Move ${stray.length === 1 ? "it" : "them"} to ${FRAGMENT_DIR_REL}/<category>-<slug>.md.`,
    });
  }

  // How much work has landed since the last release?
  let commitsSinceTag = null;
  try {
    const tag = execFileSync("git", ["describe", "--tags", "--abbrev=0", "--match", "v*"],
      { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    // `git describe --match v*` exits non-zero when nothing matches, so an empty
    // string here means git succeeded and told us nothing. Treated as unmet, not
    // as "zero commits since the tag" — the difference is a dark check.
    if (!tag) throw new Error("git describe returned no v* tag");
    const subjects = execFileSync("git", ["log", `${tag}..HEAD`, "--pretty=%s"],
      { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    commitsSinceTag = subjects
      ? subjects.split("\n").filter((s) => /^(feat|fix)(\(|!|:)/.test(s)).length
      : 0;
  } catch (err) {
    // No tags, shallow clone, or not a git repo. The stray-entry rule above DID
    // run; the "work landed with nothing written down" rule did not — which is
    // the whole point of this check. Report the partial coverage rather than
    // absorbing it into the pass tally (flair#953). CI passes fetch-depth: 0
    // specifically so this path is never taken there; if it is, the workflow has
    // drifted away from the gate and that is worth failing over.
    return { failures, scanned: null, skips: [skip(
      `could not resolve the last v* tag (${err?.message ?? err}), so 'feat/fix commits landed since the release with no changelog fragment' was NOT checked.`,
      "git fetch --tags --unshallow  (CI uses actions/checkout with fetch-depth: 0)",
    )] };
  }

  // Release-PR exception: an empty fragment directory is correct when its content
  // was just PROMOTED to a `## [X.Y.Z]` section for the release being cut — the
  // CHANGELOG carries a section matching package.json's current version while no
  // v<version> tag exists yet, so the since-tag work is recorded there.
  if (!hasContent) {
    try {
      const pkgVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
      // Static regex + captured-group comparison — never build a RegExp from
      // file-sourced data (CodeQL js/regex-injection, caught on this PR).
      const hasVersionSection = lines.some((l) => {
        const m = /^##\s+\[([^\]]+)\]/.exec(l);
        return m !== null && m[1] === pkgVersion;
      });
      const tagExists = execFileSync("git", ["tag", "-l", `v${pkgVersion}`],
        { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim().length > 0;
      if (hasVersionSection && !tagExists) return failures;
    } catch {
      // package.json unreadable or git unavailable — fall through to the normal
      // rule. This swallow is deliberately fail-CLOSED: losing the exception
      // only costs us the release-PR amnesty, so the strict rule below still
      // runs. Not a skip; the check's coverage is unreduced.
    }
  }

  if (commitsSinceTag !== null && commitsSinceTag > 0 && !hasContent) {
    failures.push({
      file: `${FRAGMENT_DIR_REL}/`, line: 1,
      msg: `no changelog fragments staged, but ${commitsSinceTag} feat/fix commit(s) have landed since the last release tag. Add ${FRAGMENT_DIR_REL}/<category>-<slug>.md describing what changed (categories: ${CATEGORIES.join(", ")}).`,
    });
  }
  return failures;
});

// ── Check 6: every CLI command has help text ────────────────────────────────────
// FAILS on any command/subcommand with an empty .description(). Introspects the
// real command tree from the built dist/cli.js (accurate, no source-regex guessing).
// Requires a build. THIS IS THE CHECK FROM flair#953: it used to print
// "skipping" and return no failures when dist/cli.js was absent, which the
// runner then rendered as `✓ pass` under an "All docs-freshness checks passed"
// summary. It now reports a skip, which is not a pass and does not exit 0.
defineCheck("cli-command-descriptions", "CLI command", async () => {
  const distCli = join(ROOT, "dist", "cli.js");
  if (!existsSync(distCli)) {
    return { failures: [], scanned: null, skips: [skip(
      "dist/cli.js is not built, so the command tree could not be introspected — no CLI command was checked for help text.",
      "bun run build:cli",
    )] };
  }
  const mod = await import(pathToFileURL(distCli).href);
  const program = mod.program;
  if (!program) {
    return [{ file: "dist/cli.js", line: 1, msg: "dist/cli.js does not export `program` — cannot introspect commands." }];
  }
  const failures = [];
  let scanned = 0;
  const walk = (cmd, path) => {
    for (const sub of cmd.commands ?? []) {
      const name = sub.name();
      if (name === "help") continue; // commander's auto-generated help command
      const full = [...path, name].join(" ");
      scanned++;
      const desc = (typeof sub.description === "function" ? sub.description() : "") || "";
      if (desc.trim().length === 0) {
        failures.push({
          file: "src/cli.ts", line: 1,
          msg: `CLI command 'flair ${full}' has no .description() — add help text so it shows in --help.`,
        });
      }
      walk(sub, [...path, name]);
    }
  };
  walk(program, []);
  // A `program` that exports cleanly but registers no subcommands walks zero
  // commands and finds zero problems — identical output to a healthy scan. The
  // runner promotes scanned === 0 to a skip.
  return { failures, scanned };
});

// ── Check 7: broken backup/restore commands in docs ────────────────────────────
// FAILS on `flair backup >` (backup writes to --output, not stdout) and
// `flair restore <` (restore reads argv, not stdin). Both produce exit 0 with a
// plausible-looking file that is not a backup — a silent false success.
// flair#968, flair#977.
defineCheck("broken-backup-restore-docs", "prose doc", () => {
  const failures = [];
  const brokenBackupRe = /flair backup\s*>/;
  const brokenRestoreRe = /flair restore\s*</;
  for (const doc of PROSE_DOCS) {
    const lines = linesOf(doc);
    lines.forEach((line, i) => {
      if (hasAllow(lines, i)) return;
      if (brokenBackupRe.test(line)) {
        failures.push({
          file: doc, line: i + 1,
          msg: `'flair backup >' redirects stdout, but backup writes the archive to --output (default ~/.flair/backups/). Use 'flair backup --output <path> --admin-pass-file ~/.flair/admin-pass' instead.`,
        });
      }
      if (brokenRestoreRe.test(line)) {
        failures.push({
          file: doc, line: i + 1,
          msg: `'flair restore <' pipes stdin, but restore reads a positional path from argv. Use 'flair restore <path>' instead.`,
        });
      }
    });
  }
  return { failures, scanned: PROSE_DOCS.length };
});

// ─── Run ────────────────────────────────────────────────────────────────────────

function emit(file, line, msg) {
  console.log(`  ✗ ${file}:${line}  ${msg}`);
  if (IN_CI) console.log(`::error file=${file},line=${line}::${msg}`);
}

// Skips get the same CI annotation weight as failures. A skip that only appears
// in the raw log is a skip nobody reads. No comma in `title=` — GitHub parses
// commas there as property separators.
function emitSkip(name, s) {
  console.log(`  ⊘ DID NOT RUN — ${s.reason}`);
  console.log(`             remedy: ${s.remedy}`);
  if (IN_CI) {
    console.log(`::error title=docs-freshness check did not run::[${name}] ${s.reason} — remedy: ${s.remedy}`);
  }
}

// Refuse to report on a gate that lost checks between edit and run.
const registered = new Set(checks.map((c) => c.name));
const unregistered = EXPECTED_CHECKS.filter((n) => !registered.has(n));
if (unregistered.length > 0) {
  console.error(`\n✗ docs-freshness gate is incomplete — expected check(s) never registered: ${unregistered.join(", ")}`);
  console.error(`  Nothing below would have covered them. Restore them, or remove them from EXPECTED_CHECKS deliberately.`);
  process.exit(1);
}

const summary = [];
let totalFailures = 0;
let totalSkips = 0;
let passedChecks = 0;
let skippedChecks = 0;
let failedChecks = 0;

for (const { name, unit, fn } of checks) {
  console.log(`\n▶ ${name}`);
  let failures, skips, scanned;
  try {
    ({ failures, skips, scanned } = normalizeResult(await fn()));
  } catch (err) {
    console.error(`  ! check '${name}' crashed: ${err?.message ?? err}`);
    failures = [{ file: name, line: 0, msg: `check crashed: ${err?.message ?? err}` }];
    skips = [];
    scanned = null;
  }

  // Zero items examined is a skip, not a pass — see the "Check results" note.
  if (skips.length === 0 && scanned === 0) {
    skips = [skip(
      `examined 0 ${unit ?? "item"}s — the input set was empty, so nothing was verified.`,
      `check that the ${unit ?? "item"} corpus this check reads still exists at the path it expects`,
    )];
  }

  for (const s of skips) emitSkip(name, s);
  for (const f of failures) emit(f.file, f.line, f.msg);

  totalFailures += failures.length;
  totalSkips += skips.length;

  const scannedNote = scanned !== null && unit ? ` (${scanned} ${unit}${scanned === 1 ? "" : "s"} scanned)` : "";
  if (failures.length === 0 && skips.length === 0) {
    console.log(`  ✓ pass${scannedNote}`);
    summary.push(`✓ ${name}${scannedNote}`);
    passedChecks++;
  } else if (failures.length === 0) {
    summary.push(`⊘ ${name} — DID NOT RUN`);
    skippedChecks++;
  } else {
    summary.push(`✗ ${name} (${failures.length})${skips.length > 0 ? ` + ${skips.length} did not run` : ""}`);
    failedChecks++;
  }
}

console.log(`\n─── docs-freshness summary ───`);
for (const s of summary) console.log(`  ${s}`);

// The tally can never read "all passed" while something did not run: the counts
// are computed from disjoint buckets and the skip bucket is printed whenever it
// is non-empty. This line is the one flair#953 was actually about.
console.log(
  `\n  ${passedChecks}/${checks.length} checks passed` +
  (skippedChecks > 0 ? ` · ${skippedChecks} DID NOT RUN` : "") +
  (failedChecks > 0 ? ` · ${failedChecks} failed (${totalFailures} issue${totalFailures === 1 ? "" : "s"})` : ""),
);

if (totalFailures > 0) {
  console.log(`\n${totalFailures} docs-freshness issue(s) found. Fix the files above, or annotate intentional cases with a '${ALLOW_MARKER}' comment.`);
}
if (totalSkips > 0) {
  console.log(
    `\n${skippedChecks} check(s) could not run. A check that did not run is not a check that passed —` +
    ` nothing they cover has been verified. Resolve the prerequisites above and re-run.`,
  );
}
if (totalFailures === 0 && totalSkips === 0) {
  console.log(`\nAll ${checks.length} docs-freshness checks ran and passed.`);
}

// Distinct exit codes so a wrapper can tell "your docs are stale" (1) from "your
// environment is wrong" (2). Both are non-zero, so CI treats them identically.
process.exit(totalFailures > 0 ? 1 : totalSkips > 0 ? 2 : 0);
