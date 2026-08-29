#!/usr/bin/env node
/**
 * check-darwin-gated-tests.mjs — flair#1012.
 *
 * Darwin-gated unit tests (`test.skipIf(!isDarwin)` and friends) cover the
 * launchd branch that unloads production services. CI is Linux, so those
 * tests do not execute there. `release.sh` is the only place they used to
 * run — on macOS, at the last possible moment — and a `test.if` gate that
 * *omits* rather than *skips* made the gap look like coverage.
 *
 * This script is the Linux-visible half of the fix:
 *
 *   1. Inventory every darwin-gated test under test/. An empty inventory is
 *      a failure (the scan found nothing, so nothing was verified).
 *   2. Refuse `test.if(<darwin cond>)` / `it.if(...)`. Bun 1.3 reports those
 *      as skips today, but `if` means "do not define this test" — the form
 *      that went silent once already. `skipIf` is the form that cannot
 *      vanish from the tally.
 *   3. Unless `--inventory-only`, run the inventoried files and require:
 *        linux  — every inventoried title appears as skipped in the JUnit
 *                 report; print "0 darwin tests ran on this platform".
 *        darwin — every inventoried title appears as passed, never skip.
 *
 * Statuses come from `bun test --reporter=junit --reporter-outfile=`, not
 * from scraping human-readable stdout. Bun's console reporter is ambient-
 * environment-dependent (CLAUDECODE and friends collapse `(pass)`/`(skip)`
 * lines); the JUnit file names every case with its status (flair#1418).
 *
 * Usage:
 *   node scripts/check-darwin-gated-tests.mjs
 *   node scripts/check-darwin-gated-tests.mjs --inventory-only
 *   node scripts/check-darwin-gated-tests.mjs --inventory-only --json
 *
 * DARWIN_GATE_ROOT overrides the repo root (fixtures).
 *
 * Exit codes:
 *   0 — inventory is non-empty, every gate is skipIf, and (unless
 *       --inventory-only) this platform's skip/pass contract held
 *   1 — empty inventory, omit-form gate, skip-count mismatch, or a
 *       darwin-gated test failed / skipped on darwin
 */

import { readFileSync, readdirSync, appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.DARWIN_GATE_ROOT
  ? process.env.DARWIN_GATE_ROOT
  : join(SCRIPT_DIR, "..");

const args = new Set(process.argv.slice(2));
const inventoryOnly = args.has("--inventory-only");
const asJson = args.has("--json");

const CALL_KINDS = [
  { kind: "omit", needle: "test.if(" },
  { kind: "omit", needle: "it.if(" },
  { kind: "omit", needle: "describe.if(" },
  { kind: "skip", needle: "test.skipIf(" },
  { kind: "skip", needle: "it.skipIf(" },
  { kind: "skip", needle: "describe.skipIf(" },
];

function walkTestFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (ent.name === "node_modules" || ent.name === "dist") continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walkTestFiles(p, out);
    else if (ent.name.endsWith(".test.ts") || ent.name.endsWith(".test.js")) out.push(p);
  }
  return out;
}

/** True when `idx` is a statement-level call, not a comment or string mention. */
function isCallSite(src, idx) {
  let i = idx - 1;
  while (i >= 0 && src[i] !== "\n") {
    if (src[i] !== " " && src[i] !== "\t") return false;
    i--;
  }
  return true;
}

function matchingParen(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function condMentionsDarwin(cond) {
  return cond.toLowerCase().includes("darwin");
}

function extractTitle(src, afterClose) {
  const rest = src.slice(afterClose + 1);
  // `test.skipIf(cond)("title", ...)` — skipIf returns the test function.
  const call = rest.match(/^\s*\(\s*"((?:\\.|[^"\\])*)"/);
  if (call) return call[1].replace(/\\"/g, '"');
  // `test.skipIf(cond, "title")` — not used here; accepted so a one-arg
  // rewrite cannot silently drop the title from the inventory.
  const comma = rest.match(/^\s*,\s*"((?:\\.|[^"\\])*)"/);
  if (comma) return comma[1].replace(/\\"/g, '"');
  return null;
}

function inventoryDarwinGates(root) {
  const files = walkTestFiles(join(root, "test"));
  const tests = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const { kind, needle } of CALL_KINDS) {
      let from = 0;
      while (true) {
        const i = src.indexOf(needle, from);
        if (i < 0) break;
        if (!isCallSite(src, i)) {
          from = i + needle.length;
          continue;
        }
        const open = i + needle.length - 1;
        const close = matchingParen(src, open);
        if (close < 0) {
          from = i + needle.length;
          continue;
        }
        const cond = src.slice(open + 1, close);
        from = close + 1;
        if (!condMentionsDarwin(cond)) continue;
        const title = extractTitle(src, close);
        tests.push({
          file: relative(root, file).replaceAll("\\", "/"),
          title: title ?? "(untitled)",
          form: kind,
          cond: cond.trim(),
        });
      }
    }
  }
  tests.sort((a, b) => a.file.localeCompare(b.file) || a.title.localeCompare(b.title));
  return tests;
}

function printHuman(tests, extraLines = []) {
  const files = [...new Set(tests.map((t) => t.file))];
  console.log("Darwin-gated unit tests (flair#1012)");
  console.log(`platform: ${process.platform}`);
  console.log(`${tests.length} test(s) in ${files.length} file(s)`);
  console.log("");
  let current = "";
  for (const t of tests) {
    if (t.file !== current) {
      current = t.file;
      console.log(`  ${t.file}`);
    }
    console.log(`    - ${t.title}`);
  }
  for (const line of extraLines) console.log(line);
}

function fail(message, tests, extraLines = []) {
  if (!asJson) {
    printHuman(tests, extraLines);
    console.error("");
    console.error(`❌ ${message}`);
  } else {
    console.log(JSON.stringify({ ok: false, error: message, tests }, null, 2));
  }
  process.exit(1);
}

function writeStepSummary(text) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    appendFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
  } catch {
    /* summary is optional */
  }
}

const tests = inventoryDarwinGates(REPO_ROOT);

if (tests.length === 0) {
  fail(
    "scanned test/ and found 0 darwin-gated tests — the scan found nothing, so nothing was verified",
    tests,
  );
}

const omit = tests.filter((t) => t.form === "omit");
if (omit.length > 0) {
  fail(
    `${omit.length} darwin-gated test(s) use test.if / it.if / describe.if, which omit the test instead of skipping it. Use test.skipIf(!isDarwin) so Linux CI reports a skip count (flair#1012).`,
    tests,
    omit.map((t) => `    omit-form: ${t.file} — ${t.title}`),
  );
}

if (inventoryOnly) {
  if (asJson) {
    console.log(JSON.stringify({ ok: true, platform: process.platform, tests }, null, 2));
  } else {
    printHuman(tests, ["", "inventory-only: skip/pass contract not checked."]);
  }
  process.exit(0);
}

const files = [...new Set(tests.map((t) => t.file))];
const bun = process.env.BUN_BIN || "bun";
const junitDir = mkdtempSync(join(tmpdir(), "darwin-gate-junit-"));
const junitPath = join(junitDir, "junit.xml");
let ran = { status: 1 };
let output = "";
let junitXml = "";
try {
  ran = spawnSync(
    bun,
    ["test", "--reporter=junit", `--reporter-outfile=${junitPath}`, ...files],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: process.env,
    },
  );
  output = `${ran.stdout ?? ""}${ran.stderr ?? ""}`;
  if (existsSync(junitPath)) junitXml = readFileSync(junitPath, "utf8");
} finally {
  rmSync(junitDir, { recursive: true, force: true });
}

function decodeXmlEntities(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

const JUNIT_NAME_DQ = /(?:^|[\s])name="([^"]*)"/;
const JUNIT_NAME_SQ = /(?:^|[\s])name='([^']*)'/;

function junitCaseName(attrs) {
  const dq = attrs.match(JUNIT_NAME_DQ);
  if (dq) return decodeXmlEntities(dq[1]);
  const sq = attrs.match(JUNIT_NAME_SQ);
  if (sq) return decodeXmlEntities(sq[1]);
  return "";
}

function caseKind(inner) {
  if (inner == null) return "pass";
  if (/<failure\b|<error\b/.test(inner)) return "fail";
  if (/<skipped\b/.test(inner)) return "skip";
  return "pass";
}

function parseJunitCases(xml) {
  const cases = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    cases.push({
      name: junitCaseName(m[1]),
      kind: m[2] === "/>" ? "pass" : caseKind(m[3]),
    });
  }
  return cases;
}

function statusFor(title, cases) {
  // Prefer fail > skip > pass so a rerun summary cannot hide a failure.
  // Leaf match (endsWith the title) so a describe prefix cannot hide it,
  // and a shorter title cannot match a longer one.
  let seen = "absent";
  for (const c of cases) {
    const leaf = c.name;
    if (leaf !== title && !leaf.endsWith(`> ${title}`)) continue;
    if (c.kind === "fail") return "fail";
    if (c.kind === "skip") seen = "skip";
    else if (c.kind === "pass" && seen === "absent") seen = "pass";
  }
  return seen;
}

const junitCases = parseJunitCases(junitXml);
const results = tests.map((t) => ({ ...t, status: statusFor(t.title, junitCases) }));
const skipped = results.filter((t) => t.status === "skip");
const passed = results.filter((t) => t.status === "pass");
const failed = results.filter((t) => t.status === "fail");
const absent = results.filter((t) => t.status === "absent");

const isDarwin = process.platform === "darwin";

if (isDarwin) {
  const bad = results.filter((t) => t.status !== "pass");
  if (bad.length > 0 || ran.status !== 0) {
    fail(
      `darwin-gated tests must RUN on darwin (flair#1012). ${passed.length} passed, ${skipped.length} skipped, ${failed.length} failed, ${absent.length} absent from bun output.`,
      results,
      [
        "",
        output.trimEnd(),
        "",
        ...bad.map((t) => `    ${t.status}: ${t.file} — ${t.title}`),
      ],
    );
  }
  const summary = `${passed.length} darwin-gated unit tests ran on darwin (0 skipped).`;
  if (asJson) {
    console.log(JSON.stringify({ ok: true, platform: process.platform, tests: results }, null, 2));
  } else {
    printHuman(tests, ["", summary]);
  }
  writeStepSummary(`## Darwin-gated unit tests (flair#1012)\n\n${summary}\n`);
  process.exit(0);
}

// Linux (and any other non-darwin host): the tests must appear as skips.
// A universal quantifier over an empty skip list is the original defect.
if (absent.length > 0 || skipped.length !== tests.length) {
  fail(
    `linux must report every darwin-gated test as skipped, not omit it (flair#1012). ${skipped.length} skipped, ${passed.length} passed, ${failed.length} failed, ${absent.length} absent — expected ${tests.length} skipped.`,
    results,
    [
      "",
      ...results
        .filter((t) => t.status !== "skip")
        .map((t) => `    ${t.status}: ${t.file} — ${t.title}`),
    ],
  );
}

const summary = `${skipped.length} darwin-gated unit tests skipped on ${process.platform}. 0 darwin tests ran on this platform.`;
if (asJson) {
  console.log(JSON.stringify({ ok: true, platform: process.platform, tests: results }, null, 2));
} else {
  printHuman(tests, ["", summary]);
}
writeStepSummary(`## Darwin-gated unit tests (flair#1012)\n\n${summary}\n`);
process.exit(0);
