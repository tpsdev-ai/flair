#!/usr/bin/env node
/**
 * check-plugin-mcp-unpinned.mjs — public plugin mcp.json must not pin
 * `@tpsdev-ai/flair-mcp` to a version or npm dist-tag.
 *
 * Why: directory listings scrape packages/cursor-flair/mcp.json. A pin
 * like `@tpsdev-ai/flair-mcp@0.44.13` froze that listing while npm latest
 * moved on (0.46.0). Public plugin manifests must stay unpinned
 * (`npx -y @tpsdev-ai/flair-mcp`) so a listing refresh always resolves
 * latest. flair#1307.
 *
 * User-local `flair init` wiring and docs/examples are a different
 * surface and are not scanned here.
 *
 * Discovery, not inventory: every tracked mcp.json / .mcp.json under
 * packages/ is scanned, so a future Claude Code / Grok / OpenClaw
 * plugin manifest is covered the PR that adds it. Zero matches is a
 * failure — this check must not pass silently.
 *
 * Usage:
 *   node scripts/check-plugin-mcp-unpinned.mjs
 *
 * Exit codes:
 *   0 — every public plugin mcp.json is unpinned (and at least one was found)
 *   1 — a pin was found, or the check could not run
 */

import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `@` after the package name is the pin — version *or* dist-tag (`latest`, `next`). */
const PIN = "@tpsdev-ai/flair-mcp@";

function isPluginMcpJson(path) {
  if (!path.startsWith("packages/")) return false;
  const name = basename(path);
  return name === "mcp.json" || name === ".mcp.json";
}

function trackedFiles() {
  let out;
  try {
    out = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-z"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    console.error(`❌ Could not list tracked files (git ls-files failed: ${err.message.trim()}).`);
    console.error("   The plugin mcp.json pin scan cannot run, and must not pass silently.");
    process.exit(1);
  }
  return out.split("\0").filter(Boolean);
}

function pinnedSpec(text) {
  const idx = text.indexOf(PIN);
  if (idx === -1) return null;
  const rest = text.slice(idx);
  const m = rest.match(/@tpsdev-ai\/flair-mcp@[^\s"'\\]+/);
  return m ? m[0] : PIN;
}

const files = trackedFiles();
if (files.length === 0) {
  console.error("❌ git ls-files returned nothing — this check cannot run, and must not pass silently.");
  process.exit(1);
}

const targets = files.filter(isPluginMcpJson);
if (targets.length === 0) {
  console.error("❌ No packages/**/mcp.json (or .mcp.json) files found.");
  console.error("   A public plugin manifest is expected (packages/cursor-flair/mcp.json).");
  console.error("   This check must not pass silently.");
  process.exit(1);
}

const violations = [];
for (const path of targets) {
  let text;
  try {
    text = readFileSync(join(REPO_ROOT, path), "utf8");
  } catch (err) {
    console.error(`❌ Could not read ${path}: ${err.message}`);
    process.exit(1);
  }
  const spec = pinnedSpec(text);
  if (spec) violations.push({ path, spec });
}

if (violations.length > 0) {
  console.error("");
  console.error("❌ Public plugin mcp.json pins @tpsdev-ai/flair-mcp (flair#1307):");
  console.error("");
  for (const v of violations) {
    console.error(`  ${v.path}: ${v.spec}`);
  }
  console.error("");
  console.error("Public plugin configs must use unpinned `npx -y @tpsdev-ai/flair-mcp`");
  console.error("so directory listings do not rot. Unpinning is the policy; do not bump the pin.");
  process.exit(1);
}

console.log(`✓ ${targets.length} public plugin mcp.json file(s) use unpinned @tpsdev-ai/flair-mcp`);
for (const path of targets) {
  console.log(`  ${path}`);
}
