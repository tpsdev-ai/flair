#!/usr/bin/env node
// first-run-hostile-verdict.mjs — two-way xfail for the first-run-hostile lane
// (flair#1462).
//
// The detector (`docker/test-first-run-hostile.sh`) still exits non-zero while
// known first-run defects fire, and prints `FAIL (#NNNN)` for each. Before
// this wrapper, that non-zero *was* the lane verdict — so every PR that
// touched src/** / docker/** / package.json carried a decorative red until
// #1454 (and previously #1459) landed. A red everyone learns to read past is
// how a gate gets worked around.
//
// This script is the verdict. It compares observed FAIL markers against
// `docker/first-run-hostile.expected.json`:
//
//   RED  — a FAIL fires that is not in the file (new regression), OR an
//          entry in the file does not fire (fix landed, or the check went
//          blind). Marker match is per-issue, not a count: one defect fixed
//          and one new one introduced cannot cancel out. An xfail that
//          unexpectedly passes is an ERROR.
//   GREEN — observed failures == expected failures. Known defects are
//           printed loudly so they stay visible without making the check red.
//
// The container's exit code is not the verdict. A non-zero exit with no FAIL
// markers is an abort (init failed, hostile conditions not actually hostile)
// and is still RED.
//
// USAGE
//   node scripts/ci/first-run-hostile-verdict.mjs \
//     --expected docker/first-run-hostile.expected.json \
//     --log first-run-hostile.log \
//     [--container-status N]
//
//   --log - reads stdin. Exit 0 on exact match, 1 on mismatch, 2 on a
//   broken expected file or bad invocation.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FAIL_ISSUE_RE = /FAIL \(#(\d+)\)/g;
const FAIL_ISSUE_LINE_RE = /FAIL \(#\d+\)/;

/**
 * @typedef {{ issue: number, marker: string }} ExpectedEntry
 * @typedef {{
 *   ok: boolean,
 *   known: number[],
 *   missing: number[],
 *   unexpected: number[],
 *   unmarked: string[],
 *   abort: boolean,
 *   summary: string,
 * }} Verdict
 */

/**
 * Parse and validate an expected-failures document.
 * @param {string} raw
 * @param {string} [source]
 * @returns {ExpectedEntry[]}
 */
export function loadExpected(raw, source = "expected-failures") {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${source}: invalid JSON (${msg})`);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.expected)) {
    throw new Error(`${source}: top-level "expected" must be an array`);
  }

  /** @type {ExpectedEntry[]} */
  const entries = [];
  const seen = new Set();
  for (const [i, e] of parsed.expected.entries()) {
    const where = `${source}: expected[${i}]`;
    if (!e || typeof e !== "object") {
      throw new Error(`${where}: must be an object with issue and marker`);
    }
    if (!Number.isInteger(e.issue) || e.issue <= 0) {
      throw new Error(`${where}: issue must be a positive integer`);
    }
    if (typeof e.marker !== "string" || e.marker.trim() === "") {
      throw new Error(`${where}: marker must be a non-empty string`);
    }
    if (!e.marker.includes(`#${e.issue}`)) {
      throw new Error(
        `${where}: marker ${JSON.stringify(e.marker)} does not name issue #${e.issue}`,
      );
    }
    if (seen.has(e.issue)) {
      throw new Error(`${source}: duplicate expected issue #${e.issue}`);
    }
    seen.add(e.issue);
    entries.push({ issue: e.issue, marker: e.marker });
  }
  return entries;
}

/**
 * Extract every `FAIL (#NNNN)` issue number from detector output.
 * @param {string} log
 * @returns {number[]}
 */
export function observedFailIssues(log) {
  const issues = new Set();
  FAIL_ISSUE_RE.lastIndex = 0;
  for (const match of log.matchAll(FAIL_ISSUE_RE)) {
    issues.add(Number(match[1]));
  }
  return [...issues].sort((a, b) => a - b);
}

/**
 * FAIL lines that are not a `FAIL (#NNNN)` marker — a new failure shape
 * the inventory cannot name by issue.
 * @param {string} log
 * @returns {string[]}
 */
export function unmarkedFailLines(log) {
  const unmarked = [];
  for (const line of log.split(/\r?\n/)) {
    if (!/\bFAIL\b/.test(line)) continue;
    if (FAIL_ISSUE_LINE_RE.test(line)) continue;
    const trimmed = line.trim();
    if (trimmed) unmarked.push(trimmed);
  }
  return unmarked;
}

/**
 * @param {{ expected: ExpectedEntry[], log: string, containerStatus?: number | null }} args
 * @returns {Verdict}
 */
export function judge({ expected, log, containerStatus = null }) {
  const expectedIssues = expected.map((e) => e.issue);
  const expectedSet = new Set(expectedIssues);

  const known = [];
  const missing = [];
  for (const entry of expected) {
    if (log.includes(entry.marker)) known.push(entry.issue);
    else missing.push(entry.issue);
  }

  const observed = observedFailIssues(log);
  const unexpected = observed.filter((n) => !expectedSet.has(n));
  const unmarked = unmarkedFailLines(log);

  const status =
    containerStatus === null || containerStatus === undefined
      ? null
      : Number(containerStatus);
  const abort =
    status !== null &&
    Number.isFinite(status) &&
    status !== 0 &&
    observed.length === 0 &&
    known.length === 0;

  const ok = unexpected.length === 0 && missing.length === 0 && unmarked.length === 0 && !abort;
  const summary = formatSummary({ ok, known, missing, unexpected, unmarked, abort });
  return { ok, known, missing, unexpected, unmarked, abort, summary };
}

function formatIssueList(issues) {
  return issues.map((n) => `#${n}`).join(", ");
}

function formatSummary({ ok, known, missing, unexpected, unmarked, abort }) {
  const lines = [];
  if (ok) {
    if (known.length === 0) {
      lines.push("GREEN: no first-run defects (expected-failures file is empty).");
    } else {
      const noun = known.length === 1 ? "defect" : "defects";
      lines.push(`GREEN: ${known.length} known first-run ${noun} present: ${formatIssueList(known)}`);
    }
    lines.push("  Red means act on this PR. Update the expected-failures file in the same PR");
    lines.push("  that fixes a listed defect or that introduces a new FAIL (#NNNN) marker.");
    return lines.join("\n");
  }

  lines.push("RED: first-run-hostile two-way xfail mismatch.");
  if (unexpected.length > 0) {
    lines.push(`  unexpected (not in expected-failures file): ${formatIssueList(unexpected)}`);
  }
  if (missing.length > 0) {
    lines.push(
      `  missing (xfail passed or check went blind): ${formatIssueList(missing)}`,
    );
  }
  if (unmarked.length > 0) {
    lines.push("  unmarked FAIL (no issue number — cannot match the file):");
    for (const line of unmarked) lines.push(`    ${line}`);
  }
  if (abort) {
    lines.push("  abort: container exited non-zero with no FAIL (#NNNN) markers");
  }
  lines.push("  Update docker/first-run-hostile.expected.json in this PR if the inventory changed.");
  return lines.join("\n");
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {{ expected: string | null, log: string | null, containerStatus: string | null, help: boolean }} */
  const out = { expected: null, log: null, containerStatus: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--expected") {
      out.expected = argv[++i] ?? null;
    } else if (arg === "--log") {
      out.log = argv[++i] ?? null;
    } else if (arg === "--container-status") {
      out.containerStatus = argv[++i] ?? null;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

const HELP = `Usage: node scripts/ci/first-run-hostile-verdict.mjs --expected FILE --log FILE [--container-status N]
`;

/**
 * @param {string[]} argv
 * @param {{ readFile?: (path: string) => string, readStdin?: () => string, write?: (s: string) => void, writeErr?: (s: string) => void }} [io]
 * @returns {number}
 */
export function main(argv, io = {}) {
  const readFile = io.readFile ?? ((p) => readFileSync(p, "utf8"));
  const readStdin = io.readStdin ?? (() => readFileSync(0, "utf8"));
  const write = io.write ?? ((s) => process.stdout.write(s));
  const writeErr = io.writeErr ?? ((s) => process.stderr.write(s));

  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    writeErr(`${err instanceof Error ? err.message : String(err)}\n${HELP}`);
    return 2;
  }
  if (args.help) {
    write(HELP);
    return 0;
  }
  if (!args.expected || !args.log) {
    writeErr(`--expected and --log are required\n${HELP}`);
    return 2;
  }

  let expected;
  try {
    expected = loadExpected(readFile(args.expected), args.expected);
  } catch (err) {
    writeErr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const log = args.log === "-" ? readStdin() : readFile(args.log);
  const containerStatus =
    args.containerStatus === null || args.containerStatus === ""
      ? null
      : Number(args.containerStatus);

  const verdict = judge({ expected, log, containerStatus });
  write("==============================================\n");
  write(`${verdict.summary}\n`);
  write("==============================================\n");
  return verdict.ok ? 0 : 1;
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  process.exit(main(process.argv.slice(2)));
}
