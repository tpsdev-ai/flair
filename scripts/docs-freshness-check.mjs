#!/usr/bin/env node
// Docs-freshness gate (flair#618).
//
// Catches the doc-rot classes an adopter audit keeps surfacing — stale version
// pins, port drift, package-name drift, an empty CHANGELOG [Unreleased] despite
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

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

// ─── Check runner ─────────────────────────────────────────────────────────────

const checks = [];
function defineCheck(name, fn) {
  checks.push({ name, fn });
}

// ── Check 1: stale install pin of the root package ──────────────────────────────
// FAILS on any `npm install`/`bun add`/etc. that pins `@tpsdev-ai/flair@<v>` to a
// version other than the current one. (Sub-packages version independently, so
// only the root package — validatable from this package.json — is checked.)
defineCheck("stale-install-pin", () => {
  const failures = [];
  if (!PKG_NAME) return failures;
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
  return failures;
});

// ── Check 2: getting-started version placeholder discipline ─────────────────────
// FAILS on any concrete Flair-style version (v0.0.0) in a getting-started doc.
// These docs should use the `vX.Y.Z` placeholder so example output never rots.
// External-tool version lines (node/nvm/brew/harper) are exempt.
defineCheck("getting-started-version-placeholder", () => {
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
  return failures;
});

// ── Check 3: port drift ─────────────────────────────────────────────────────────
// FAILS when a doc references a retired legacy Flair port (9926/9925) as if it
// were current. A reference inside an explicit legacy/historical context — the
// same line, the 3 preceding lines, or the nearest preceding heading — is exempt.
defineCheck("port-drift", () => {
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
  return failures;
});

// ── Check 4: package-name / scope drift ─────────────────────────────────────────
// FAILS on any scoped package whose name contains "flair" but whose scope is not
// our scope (e.g. a typo'd `@tpsdev/flair` missing the `-ai`).
defineCheck("package-name-drift", () => {
  const failures = [];
  if (!PKG_SCOPE) return failures;
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
  return failures;
});

// ── Check 5: CHANGELOG [Unreleased] populated when work has landed ──────────────
// FAILS when feat/fix commits exist since the latest v* tag but the CHANGELOG's
// [Unreleased] section is empty. Degrades to a skip (never a false fail) when
// there is no tag or git history to compare against.
defineCheck("changelog-unreleased", () => {
  const changelogPath = join(ROOT, "CHANGELOG.md");
  if (!existsSync(changelogPath)) return [];
  const text = readFileSync(changelogPath, "utf8");
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^##\s+\[Unreleased\]/i.test(l));
  if (start === -1) {
    return [{ file: "CHANGELOG.md", line: 1, msg: "no '## [Unreleased]' section found. Add one so in-flight work is recorded." }];
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+\[/.test(lines[i])) { end = i; break; }
  }
  const body = lines.slice(start + 1, end);
  const hasContent = body.some((l) => {
    const t = l.trim();
    if (t.length === 0) return false;
    if (/^(_?nothing[^\n]*_?|n\/?a|tbd|none|—|-)$/i.test(t)) return false; // placeholder
    return true;
  });

  // How much work has landed since the last release?
  let commitsSinceTag = null;
  try {
    const tag = execFileSync("git", ["describe", "--tags", "--abbrev=0", "--match", "v*"],
      { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (tag) {
      const subjects = execFileSync("git", ["log", `${tag}..HEAD`, "--pretty=%s"],
        { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      commitsSinceTag = subjects
        ? subjects.split("\n").filter((s) => /^(feat|fix)(\(|!|:)/.test(s)).length
        : 0;
    }
  } catch {
    // No tags, shallow clone, or not a git repo — can't compare; skip gracefully.
    console.warn("  (changelog-unreleased: no v* tag / git history available — skipping commit comparison)");
    return [];
  }

  // Release-PR exception: an empty [Unreleased] is correct when its content was
  // just PROMOTED to a `## [X.Y.Z]` section for the release being cut — the
  // CHANGELOG carries a section matching package.json's current version while
  // no v<version> tag exists yet, so the since-tag work is recorded there.
  if (!hasContent) {
    try {
      const pkgVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
      const hasVersionSection = new RegExp(`^##\\s+\\[${pkgVersion.replace(/\./g, "\\.")}\\]`, "m").test(text);
      const tagExists = execFileSync("git", ["tag", "-l", `v${pkgVersion}`],
        { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim().length > 0;
      if (hasVersionSection && !tagExists) return [];
    } catch {
      // package.json unreadable or git unavailable — fall through to the normal rule.
    }
  }

  if (commitsSinceTag !== null && commitsSinceTag > 0 && !hasContent) {
    return [{
      file: "CHANGELOG.md", line: start + 1,
      msg: `[Unreleased] is empty but ${commitsSinceTag} feat/fix commit(s) have landed since the last release tag. Document what changed.`,
    }];
  }
  return [];
});

// ── Check 6: every CLI command has help text ────────────────────────────────────
// FAILS on any command/subcommand with an empty .description(). Introspects the
// real command tree from the built dist/cli.js (accurate, no source-regex guessing).
// Requires a build; skips with a warning locally if dist/cli.js is absent.
defineCheck("cli-command-descriptions", async () => {
  const distCli = join(ROOT, "dist", "cli.js");
  if (!existsSync(distCli)) {
    console.warn("  (cli-command-descriptions: dist/cli.js not built — run `bun run build:cli` to include this check; skipping)");
    return [];
  }
  const mod = await import(pathToFileURL(distCli).href);
  const program = mod.program;
  if (!program) {
    return [{ file: "dist/cli.js", line: 1, msg: "dist/cli.js does not export `program` — cannot introspect commands." }];
  }
  const failures = [];
  const walk = (cmd, path) => {
    for (const sub of cmd.commands ?? []) {
      const name = sub.name();
      if (name === "help") continue; // commander's auto-generated help command
      const full = [...path, name].join(" ");
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
  return failures;
});

// ─── Run ────────────────────────────────────────────────────────────────────────

function emit(file, line, msg) {
  console.log(`  ✗ ${file}:${line}  ${msg}`);
  if (IN_CI) console.log(`::error file=${file},line=${line}::${msg}`);
}

const summary = [];
let totalFailures = 0;
for (const { name, fn } of checks) {
  console.log(`\n▶ ${name}`);
  let failures;
  try {
    failures = await fn();
  } catch (err) {
    console.error(`  ! check '${name}' crashed: ${err?.message ?? err}`);
    failures = [{ file: name, line: 0, msg: `check crashed: ${err?.message ?? err}` }];
  }
  if (failures.length === 0) {
    console.log("  ✓ pass");
    summary.push(`✓ ${name}`);
  } else {
    for (const f of failures) emit(f.file, f.line, f.msg);
    summary.push(`✗ ${name} (${failures.length})`);
    totalFailures += failures.length;
  }
}

console.log(`\n─── docs-freshness summary ───`);
for (const s of summary) console.log(`  ${s}`);
console.log(
  totalFailures === 0
    ? `\nAll docs-freshness checks passed.`
    : `\n${totalFailures} docs-freshness issue(s) found. Fix the files above, or annotate intentional cases with a '${ALLOW_MARKER}' comment.`,
);
process.exit(totalFailures > 0 ? 1 : 0);
