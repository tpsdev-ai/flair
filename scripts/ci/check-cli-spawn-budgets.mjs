#!/usr/bin/env node
// check-cli-spawn-budgets.mjs — flair#1807's class gate.
//
// WHAT IT IS FOR. flair#1807 is one class of test defect: a test spawns the
// flair CLI with NO bound on the child, so a hung child is killed by bun's
// per-test timer and reported as a bare "timed out after 5000ms" that discards
// the child's name and its output — you cannot tell WHICH spawn hung or what it
// printed. The fix is per spawn, and a per-spawn fix does not hold the line by
// itself: the next new test spawns the CLI the same way. This gate is the line.
//
// TWO ARMS, both scoped to `test/**` (the root test tree) and both about one
// thing — a spawned CLI ENTRY:
//
//   ARM 1 (spawn-level): a spawn of the CLI entry whose options carry NO
//     `timeout`. The child must carry its OWN deadline, so that a hung child is
//     reported by the deadline, by name, with its output.
//
//   ARM 2 (case-level): an `it()`/`test()` that REACHES such a spawn (directly,
//     or through a file-local helper that spawns, transitively) and carries no
//     per-case budget. Without a budget the case itself is killed by bun's 5 s
//     default long before a 20 s child deadline could fire — the deadline would
//     never be reached and the named message would never be produced.
//
// THE CLI ENTRY. A spawn is a CLI-entry spawn when its command/argv names the
// entry point: the literal `src/cli.ts` / `dist/cli.js`, or a FILE-LOCAL
// identifier assigned by a `join(…, "cli.ts" | "cli.js")` (`const cliPath =
// join(root, "dist", "cli.js")`). Everything else is a different class and is
// neither flagged nor counted: a bare `spawnSync(process.execPath,
// ["scripts/thing.mjs"])`, a `spawn("harper", …)`, or `execSync("bun run
// build:cli")` are all fine — note "build:cli" is not the entry point. The gate
// is about the CLI entry because that is the child whose hang cost flair#1807
// its evidence.
//
// THE ALLOW-LIST IS EMPTY ON PURPOSE and must stay empty. A padded allow-list
// turns this into a check that cannot fire: the files it skips are exactly the
// ones nobody budgets, and the gate reports green over them. There is no skip
// flag for the same reason. If a genuine exception appears, budget the spawn or
// change the rule — do not add an entry here.
//
// SCANNING. Test files are read as TEXT, not parsed: no AST dependency, so the
// gate runs before `bun install`. That makes one thing load-bearing — the
// scanner must not confuse code with prose. Comments are masked (an apostrophe
// in "it's not in stderr" otherwise opens a string that swallows the case's
// closing paren), and string / template / regex literals are skipped when
// matching brackets (a regex like `/required option '--agent/` does the same).
// A case the scanner cannot see is a case it reports as fine.
//
// USAGE
//   node scripts/ci/check-cli-spawn-budgets.mjs [--root <dir>]
// `--root` re-points the scan at another checkout, to audit an older tree (e.g.
// to show the offenders this gate exists to catch). It is not a skip flag: the
// scan and the exit code are identical, only the tree differs.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOW_LIST = [];

const SPAWN_FNS = new Set([
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
  "exec",
  "execSync",
  "fork",
]);
// Which argument (0-based) is the options object, per spawn family.
const OPTIONS_ARG_INDEX = new Map([
  ["spawn", 2],
  ["spawnSync", 2],
  ["execFile", 2],
  ["execFileSync", 2],
  ["fork", 1],
  ["exec", 1],
  ["execSync", 1],
]);
// Which arguments can carry the command / argv.
const ARGV_ARG_INDICES = new Map([
  ["spawn", [0, 1]],
  ["spawnSync", [0, 1]],
  ["execFile", [0, 1]],
  ["execFileSync", [0, 1]],
  ["fork", [0, 1]],
  ["exec", [0]],
  ["execSync", [0]],
]);

/** Last non-whitespace character before `i`, or "" at the start. */
function prevSignificant(src, i) {
  for (let j = i - 1; j >= 0; j--) {
    if (!/\s/.test(src[j])) return src[j];
  }
  return "";
}

/** Standard heuristic: `/` after an operator/opener is a regex, after a value is division. */
function regexCanStart(src, i) {
  const prev = prevSignificant(src, i);
  if (prev === "") return true;
  if ("([{,;:=!&|?+-*%~^<>".includes(prev)) return true;
  return /\b(?:return|typeof|instanceof|case|in|of|new|delete|void|do|else|yield|await)$/.test(
    src.slice(Math.max(0, i - 12), i),
  );
}

function skipRegex(src, i) {
  let j = i + 1;
  let inClass = false;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "\n") return i; // never closed on this line — treat as division
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return j;
    j++;
  }
  return i;
}

/**
 * If `i` starts a string, template, comment or regex literal, the index just
 * past it; otherwise `i` unchanged. Every bracket/argument walk goes through
 * this, so none of them can mistake literal content for code.
 */
function skipNonCode(src, i) {
  const ch = src[i];
  if (ch === '"' || ch === "'" || ch === "`") {
    let j = i + 1;
    while (j < src.length) {
      if (src[j] === "\\") j += 2;
      else if (src[j] === ch) return j + 1;
      else j++;
    }
    return src.length;
  }
  if (ch === "/" && src[i + 1] === "/") {
    const nl = src.indexOf("\n", i);
    return nl === -1 ? src.length : nl;
  }
  if (ch === "/" && src[i + 1] === "*") {
    const end = src.indexOf("*/", i + 2);
    return end === -1 ? src.length : end + 2;
  }
  if (ch === "/" && regexCanStart(src, i)) {
    const j = skipRegex(src, i);
    if (j !== i) return j + 1;
  }
  return i;
}

/**
 * The source with every COMMENT body replaced by spaces (same length, so every
 * index still points at the same character). String and regex literals are left
 * alone — the CLI-entry and `timeout:` checks are literal text checks — but the
 * bracket walks skip their contents via `skipNonCode`.
 */
function maskComments(src) {
  const out = src.split("");
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    // Skip string/template/regex CONTENTS first: a URL in a string
    // (`"http://127.0.0.1:99999"`) contains `//`, and masking from there
    // blanks the rest of the line — including the `)` that closes the case.
    if (ch === '"' || ch === "'" || ch === "`") {
      const next = skipNonCode(src, i);
      i = next > i ? next : i + 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") {
        out[i] = " ";
        i++;
      }
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < src.length) {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
      }
      continue;
    }
    if (ch === "/" && regexCanStart(src, i)) {
      const j = skipRegex(src, i);
      if (j !== i) {
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return out.join("");
}

/** Index of the `)` matching the `(` at `open`, or -1. */
function matchParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; ) {
    const next = skipNonCode(src, i);
    if (next > i) {
      i = next;
      continue;
    }
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** Index of the `}` matching the `{` at `open`, or -1. */
function matchBrace(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; ) {
    const next = skipNonCode(src, i);
    if (next > i) {
      i = next;
      continue;
    }
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** Top-level (depth-0) comma-separated spans between `(` at `open` and its `)`. */
export function topLevelArgs(src, open) {
  const close = matchParen(src, open);
  if (close === -1) return null;
  const spans = [];
  let start = open + 1;
  for (let i = open + 1; i < close; ) {
    const next = skipNonCode(src, i);
    if (next > i) {
      i = next;
      continue;
    }
    const ch = src[i];
    if (ch === "(" || ch === "[" || ch === "{") {
      const closeIdx = ch === "(" ? matchParen(src, i) : ch === "[" ? matchSquare(src, i) : matchBrace(src, i);
      if (closeIdx === -1) return null;
      i = closeIdx + 1;
      continue;
    }
    if (ch === ",") {
      spans.push({ start, end: i, text: src.slice(start, i) });
      start = i + 1;
    }
    i++;
  }
  if (src.slice(start, close).trim().length > 0) spans.push({ start, end: close, text: src.slice(start, close) });
  return { spans, close };
}

function matchSquare(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; ) {
    const next = skipNonCode(src, i);
    if (next > i) {
      i = next;
      continue;
    }
    if (src[i] === "[") depth++;
    else if (src[i] === "]") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function looksLikeCliEntry(text) {
  return (
    /["'`]src\/cli\.ts["'`]/.test(text) ||
    /["'`]dist\/cli\.js["'`]/.test(text) ||
    /["'`]cli\.(ts|js)["'`]/.test(text)
  );
}

/** File-local identifiers assigned by a `join(…, "cli.ts" | "cli.js")`. */
export function cliEntryIdentifiers(source) {
  const src = maskComments(source);
  const ids = new Set();
  // Matched by the join's BALANCED call, not a `[^;]+` sweep: a multi-line
  // object literal initializer (`const dir = makeRepo({ files: ["dist/cli.js"] })`)
  // otherwise runs on to the next `;` and names `dir` a CLI-entry identifier,
  // which then matches ordinary argv text and flags a spawn of an unrelated
  // script. That false positive is how a gate starts needing an allow-list.
  for (const m of src.matchAll(/\bjoin\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const args = topLevelArgs(src, open);
    if (!args) continue;
    if (!args.spans.some((s) => /^["'`](cli\.(ts|js))["'`]$/.test(s.text.trim()))) continue;
    const assigned = src.slice(Math.max(0, m.index - 140), m.index).match(/([A-Za-z_$][\w$]*)\s*=\s*$/);
    if (assigned) ids.add(assigned[1]);
  }
  return ids;
}

/**
 * A single character that can appear inside a JS identifier (or the `$` of one).
 * The test is a literal regex over ONE character — no RegExp is ever built from
 * data in this file (the class Semgrep's detect-non-literal-regexp blocks, and
 * the one that blocked #1809).
 */
export function isIdentChar(ch) {
  return /[A-Za-z0-9_$]/.test(ch);
}

/**
 * Index of the next occurrence of `id` in `text` at or after `from` that is a
 * WHOLE identifier — neither the character before it nor the one after it is an
 * identifier character. Returns -1 when there is none.
 *
 * This replaces a regex built from the identifier. The identifiers here come from
 * `[A-Za-z_$][\w$]*` captures, so they cannot carry a backslash TODAY — but this
 * scanner is a CONTROL, and a control must not depend on that. Building a RegExp
 * from captured data is exactly what a backslash would silently change, so the
 * match is plain string scanning instead (flair#1809).
 */
export function findIdentifier(text, id, from = 0) {
  if (id === "") return -1;
  const last = text.length - id.length;
  for (let i = from; i <= last; ) {
    const at = text.indexOf(id, i);
    if (at === -1) return -1;
    const before = at === 0 ? "" : text[at - 1];
    const after = text[at + id.length] ?? "";
    if (!isIdentChar(before) && !isIdentChar(after)) return at;
    i = at + 1;
  }
  return -1;
}

/**
 * `idx` points just past an identifier. True when the next non-whitespace
 * character is `(` — i.e. the identifier is CALLED. This replaces a regex built
 * from the identifier; the match is string scanning, never a RegExp built from
 * it (flair#1809).
 */
export function identifierCallFollows(text, idx) {
  let i = idx;
  while (i < text.length && /\s/.test(text[i])) i++;
  return text[i] === "(";
}

/**
 * The helper-detection predicate: does `text` contain `id` as a whole
 * identifier followed by optional whitespace and `(`? Any occurrence counts —
 * the old `.test()` asked the same question — so a whole-word hit that is not a
 * call does not end the search.
 */
function identifierCalled(text, id) {
  for (let from = 0; ; ) {
    const at = findIdentifier(text, id, from);
    if (at === -1) return false;
    if (identifierCallFollows(text, at + id.length)) return true;
    from = at + 1;
  }
}

function textNamesCliEntry(text, ids) {
  if (looksLikeCliEntry(text)) return true;
  for (const id of ids) {
    if (findIdentifier(text, id, 0) !== -1) return true;
  }
  return false;
}

/** All spawn-family calls in the file, with whether each targets the CLI entry. */
export function findSpawnCalls(source) {
  const src = maskComments(source);
  const ids = cliEntryIdentifiers(source);
  const constDecls = new Map();
  for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g)) {
    const after = m.index + m[0].length;
    const lineEnd = src.indexOf("\n", after);
    constEnd: {
      constDecls.set(m[1], src.slice(after, lineEnd === -1 ? src.length : lineEnd));
    }
  }
  const calls = [];
  for (const m of src.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const fn = m[2];
    if (!SPAWN_FNS.has(fn)) continue;
    const open = m.index + m[0].length - 1;
    const args = topLevelArgs(src, open);
    if (!args) continue;
    const argvText = (ARGV_ARG_INDICES.get(fn) ?? [0, 1]).map((i) => args.spans[i]?.text ?? "").join(" ");
    const optSpan = args.spans[OPTIONS_ARG_INDEX.get(fn)];
    let optText = optSpan?.text ?? "";
    if (optSpan && /^[A-Za-z_$][\w$]*$/.test(optSpan.text.trim())) {
      optText = constDecls.get(optSpan.text.trim()) ?? "";
    }
    calls.push({
      fn,
      index: m.index,
      line: src.slice(0, m.index).split("\n").length,
      isCliEntry: textNamesCliEntry(argvText, ids),
      hasTimeout: /(^|[^\w$.])timeout\s*[:=]/.test(optText),
    });
  }
  return { calls, ids };
}

/**
 * The `{` that opens a declaration's body: the first brace that ends its own
 * line. A naive `indexOf("{")` lands inside the RETURN-TYPE annotation of these
 * helpers (`): Promise<{ stdout: string; … }> {`) and bounds the body before the
 * spawn, so the helper looks like it never spawns and every case calling it
 * looks budgeted.
 */
function bodyBraceFrom(src, from) {
  const limit = Math.min(src.length, from + 800);
  for (let i = from; i < limit; ) {
    const next = skipNonCode(src, i);
    if (next > i) {
      i = next;
      continue;
    }
    if (src[i] === "{") {
      const lineEnd = src.indexOf("\n", i);
      if (src.slice(i + 1, lineEnd === -1 ? src.length : lineEnd).trim() === "") return i;
    }
    i++;
  }
  return -1;
}

/** File-local functions whose body contains a CLI-entry spawn, transitively. */
export function localHelpersThatSpawn(source, calls) {
  const src = maskComments(source);
  const spawnIdx = calls.filter((c) => c.isCliEntry).map((c) => c.index);
  const helpers = new Set();
  if (spawnIdx.length === 0) return helpers;
  const bodies = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const open = src.indexOf("(", m.index);
    const bodyOpen = bodyBraceFrom(src, open);
    if (bodyOpen === -1) continue;
    const bodyClose = matchBrace(src, bodyOpen);
    if (bodyClose === -1) continue;
    bodies.push({ name: m[1], start: bodyOpen, end: bodyClose });
  }
  for (const m of src.matchAll(
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
  )) {
    const arrowEnd = m.index + m[0].length;
    const bodyOpen = bodyBraceFrom(src, arrowEnd);
    if (bodyOpen !== -1 && src.slice(arrowEnd, bodyOpen).trim() === "") {
      const bodyClose = matchBrace(src, bodyOpen);
      if (bodyClose === -1) continue;
      bodies.push({ name: m[1], start: bodyOpen, end: bodyClose });
    } else {
      const lineEnd = src.indexOf("\n", arrowEnd);
      bodies.push({ name: m[1], start: arrowEnd, end: lineEnd === -1 ? src.length : lineEnd });
    }
  }
  let added = true;
  while (added) {
    added = false;
    for (const body of bodies) {
      const text = src.slice(body.start, body.end);
      const direct = spawnIdx.some((i) => i > body.start && i < body.end);
      const via = [...helpers].some((h) => identifierCalled(text, h));
      if ((direct || via) && !helpers.has(body.name)) {
        helpers.add(body.name);
        added = true;
      }
    }
  }
  return helpers;
}

/** `it()` / `test()` cases, with whether each reaches a CLI-entry spawn. */
export function findCases(source, calls, helpers) {
  const src = maskComments(source);
  const cases = [];
  const cliSpawnRanges = calls.filter((c) => c.isCliEntry).map((c) => c.index);
  // `test.skipIf(!isDarwin)("name", fn, budget)` is a case too: the modifier is
  // a call of its own, and the CASE's arguments are those of the call that
  // follows it. Without this the darwin-gated files — the ones whose spawns are
  // hardest to bound and so most worth seeing — are invisible.
  for (const m of src.matchAll(/(^|[^\w$.])(it|test)((?:\.[A-Za-z]+)+)?\s*\(/g)) {
    let open = m.index + m[0].length - 1;
    if (m[3]) {
      const modifierClose = matchParen(src, open);
      if (modifierClose === -1) continue;
      const nextOpen = src.indexOf("(", modifierClose + 1);
      if (nextOpen === -1) continue;
      open = nextOpen;
    }
    const args = topLevelArgs(src, open);
    if (!args) continue;
    const body = src.slice(open + 1, args.close);
    let reaches = cliSpawnRanges.some((i) => i > open && i < args.close);
    if (!reaches) {
      for (const helper of helpers) {
        if (identifierCalled(body, helper)) {
          reaches = true;
          break;
        }
      }
    }
    cases.push({
      fn: m[2],
      line: src.slice(0, m.index).split("\n").length,
      name: (args.spans[0]?.text.trim() ?? "").replace(/^["'`]|["'`]$/g, ""),
      argCount: args.spans.length,
      reachesSpawn: reaches,
      hasBudget: args.spans.length >= 3,
    });
  }
  return cases;
}

export function analyzeTestFile(source) {
  const { calls, ids } = findSpawnCalls(source);
  const helpers = localHelpersThatSpawn(source, calls);
  const cases = findCases(source, calls, helpers);
  return { calls, ids, helpers, cases };
}

function existsDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function testFilesUnder(root) {
  const testDir = join(root, "test");
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.test\.[jt]sx?$/.test(entry.name)) out.push(path);
    }
  };
  if (existsDir(testDir)) walk(testDir);
  return out.sort();
}

export function scanTree(root) {
  const spawnOffenders = [];
  const caseOffenders = [];
  const files = testFilesUnder(root);
  for (const file of files) {
    const rel = relative(root, file);
    if (ALLOW_LIST.includes(rel)) continue;
    const src = readFileSync(file, "utf8");
    const { calls, cases } = analyzeTestFile(src);
    for (const call of calls) {
      if (call.isCliEntry && !call.hasTimeout) {
        spawnOffenders.push({ file: rel, line: call.line, kind: "spawn-no-timeout", detail: `${call.fn}()` });
      }
    }
    for (const c of cases) {
      if (c.reachesSpawn && !c.hasBudget) {
        caseOffenders.push({
          file: rel,
          line: c.line,
          kind: "case-no-budget",
          detail: `${c.fn}("${c.name.slice(0, 60)}")`,
        });
      }
    }
  }
  return { files: files.map((f) => relative(root, f)), spawnOffenders, caseOffenders };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  let root = resolve(fileURLToPath(import.meta.url), "../../..");
  const rootFlag = argv.indexOf("--root");
  if (rootFlag !== -1) {
    if (!argv[rootFlag + 1]) {
      process.stderr.write("check-cli-spawn-budgets: --root needs a directory\n");
      process.exit(2);
    }
    root = resolve(argv[rootFlag + 1]);
  }
  const { files, spawnOffenders, caseOffenders } = scanTree(root);
  const offenders = [...spawnOffenders, ...caseOffenders];
  process.stdout.write(`check-cli-spawn-budgets: scanned ${files.length} test file(s) under ${join(root, "test")}\n`);
  if (files.length === 0) {
    process.stderr.write(
      "check-cli-spawn-budgets: no test files found — the scan saw nothing, which is not a pass.\n",
    );
    process.exit(1);
  }
  for (const o of offenders) process.stdout.write(`  ${o.file}:${o.line}  ${o.kind}  ${o.detail}\n`);
  process.stdout.write(
    `check-cli-spawn-budgets: ${spawnOffenders.length} CLI-entry spawn(s) with no timeout, ` +
      `${caseOffenders.length} CLI-spawning case(s) with no budget — ${offenders.length} offender(s).\n`,
  );
  process.exit(offenders.length === 0 ? 0 : 1);
}
