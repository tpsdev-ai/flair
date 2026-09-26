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
// THE EXCEPTION LIST IS A TRUSTED BASELINE FILE, not an in-script allow-list
// (flair#1825). `scripts/ci/cli-spawn-budgets.baseline.json` holds entries that
// cannot be budgeted yet, and it cannot be gamed: each entry is keyed on file +
// enclosing helper/case + a normalized call fingerprint + the violation kind
// (plus an occurrence ordinal — never `file:line`); keys are unique, so one
// entry covers exactly one call; the run is DIFFED against the committed
// baseline, so a PR cannot add an offender together with its own exception; and
// an entry that no longer offends FAILS, so the list can only shrink. There is
// no skip flag and no whole-file skip.
//
// SCOPE — EVERY SPAWN FAMILY THIS REPO USES (flair#1825). The node
// `child_process` family (spawn / spawnSync / exec / execFile / fork and their
// Sync forms) — bare, or via a NAMED ALIAS import — AND `Bun.spawn` /
// `Bun.spawnSync`. Bun's signature is `(argvArray, options)`, options SECOND;
// node's is `(cmd, argv, options)`. A namespace import (`cp.spawn`) is not seen.
// The scanner masks string/template/regex CONTENTS for call matching, so a
// `Bun.spawn(...)` quoted in a string is not mistaken for a call.
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
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The trusted baseline of exceptions (flair#1825). It replaces the old in-script
 * allow-list: a PR cannot add an offender together with its own exception here,
 * because this file is the reviewed copy and the run is diffed against it.
 */
export const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), "cli-spawn-budgets.baseline.json");

/**
 * The ONE commit whose base legitimately has no baseline file: the origin/main
 * sha this gate's baseline was introduced from (flair#1825). The seed path is
 * taken ONLY when the base ref resolves to exactly this sha. Any OTHER base with
 * no baseline file is a hard failure — a base ref repointed at any pre-baseline
 * commit must not be enough. Full 40-char sha, read with `git merge-base`.
 */
export const SEED_INTRODUCTION_BASE = "4904699d80b55d9f299fe8e061aa80e4de8e9edc";

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

// Bun's spawn forms (flair#1825): the argv ARRAY comes FIRST and the options
// object SECOND — `Bun.spawn(cmd, opts)`, unlike node's `(cmd, argv, opts)`.
const BUN_SPAWN_FNS = new Set(["Bun.spawn", "Bun.spawnSync"]);
const BUN_OPTIONS_ARG_INDEX = 1;
const BUN_ARGV_ARG_INDICES = [0];

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
 * Like maskComments, but ALSO blanks the CONTENTS of string / regex literals and
 * the literal TEXT of template literals (same length). Used for spawn-CALL
 * matching, so a `Bun.spawn(...)` mentioned inside a plain string is not
 * mistaken for a call. A template's `${…}` EXPRESSIONS are left as CODE — a
 * `Bun.spawn(...)` of the CLI entry there IS a real call (flair#1825). The
 * argv/options TEXT a call reports is sliced from the ORIGINAL source, so the
 * CLI-entry and timeout checks still read real literal text.
 */
function maskLiteralsAndComments(src) {
  const out = src.split("");
  const blank = (from, to) => {
    for (let j = from; j < to && j < src.length; j++) if (src[j] !== "\n") out[j] = " ";
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      const end = skipNonCode(src, i);
      blank(i, end);
      i = end > i ? end : i + 1;
      continue;
    }
    if (ch === "`") {
      // Template: blank the literal TEXT, but leave `${…}` expressions as code.
      out[i] = " "; // opening backtick
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
          blank(j, j + 2);
          j += 2;
          continue;
        }
        if (src[j] === "`") {
          out[j] = " "; // closing backtick
          j++;
          break;
        }
        if (src[j] === "$" && src[j + 1] === "{") {
          j += 2;
          let depth = 1;
          while (j < src.length && depth > 0) {
            if (src[j] === "{") depth++;
            else if (src[j] === "}") {
              depth--;
              if (depth === 0) {
                j++;
                break;
              }
            }
            j++;
          }
          continue;
        }
        if (src[j] !== "\n") out[j] = " ";
        j++;
      }
      i = j;
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
        blank(i, j + 1);
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return out.join("");
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
 * Named aliases of the node `child_process` spawn functions, from a
 * `import { spawn as run } from "node:child_process"` (flair#1825). Maps the
 * alias (the name CALLED) to the original function, which fixes the arg shape.
 * A namespace import (`import * as cp` / `cp.spawn`) is NOT covered — name the
 * function as a named import, or call `Bun.spawn`.
 */
export function aliasedSpawnFns(source) {
  const src = maskComments(source);
  const aliases = new Map();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](?:node:)?child_process["']/g)) {
    for (const item of m[1].split(",")) {
      const parts = item.trim().split(/\s+as\s+/);
      const orig = parts[0].trim();
      const alias = (parts[1] ?? parts[0]).trim();
      if (SPAWN_FNS.has(orig) && alias && alias !== orig) aliases.set(alias, orig);
    }
  }
  return aliases;
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

/** All spawn-family calls in the file (node forms + Bun forms), with CLI-entry targeting. */
export function findSpawnCalls(source) {
  const scan = maskLiteralsAndComments(source);
  const ids = cliEntryIdentifiers(source);
  const aliases = aliasedSpawnFns(source);
  const constDecls = new Map();
  for (const m of scan.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g)) {
    const after = m.index + m[0].length;
    const lineEnd = source.indexOf("\n", after);
    constDecls.set(m[1], source.slice(after, lineEnd === -1 ? source.length : lineEnd));
  }
  const calls = [];
  const lineOf = (index) => source.slice(0, index).split("\n").length;
  const textAt = (span) => (span ? source.slice(span.start, span.end) : "");
  const resolveOptText = (optSpan) => {
    const own = textAt(optSpan);
    const trimmed = own.trim();
    if (optSpan && /^[A-Za-z_$][\w$]*$/.test(trimmed)) return constDecls.get(trimmed) ?? "";
    return own;
  };
  // Bun.spawn / Bun.spawnSync — argv array FIRST, options SECOND (flair#1825).
  for (const m of scan.matchAll(/(^|[^\w$.])Bun\.(spawn|spawnSync)\s*\(/g)) {
    const fn = `Bun.${m[2]}`;
    const open = m.index + m[0].length - 1;
    const args = topLevelArgs(scan, open);
    if (!args) continue;
    const argvText = BUN_ARGV_ARG_INDICES.map((i) => textAt(args.spans[i])).join(" ");
    const optText = resolveOptText(args.spans[BUN_OPTIONS_ARG_INDEX]);
    calls.push({
      fn,
      index: m.index,
      line: lineOf(m.index),
      text: `${argvText} ; ${optText}`,
      isCliEntry: textNamesCliEntry(argvText, ids),
      hasTimeout: /(^|[^\w$.])timeout\s*[:=]/.test(optText),
    });
  }
  // node child_process forms — bare, or via a named alias (flair#1825).
  for (const m of scan.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const raw = m[2];
    const fn = SPAWN_FNS.has(raw) ? raw : aliases.get(raw);
    if (!fn) continue;
    const open = m.index + m[0].length - 1;
    const args = topLevelArgs(scan, open);
    if (!args) continue;
    const argvText = (ARGV_ARG_INDICES.get(fn) ?? [0, 1]).map((i) => textAt(args.spans[i])).join(" ");
    const optText = resolveOptText(args.spans[OPTIONS_ARG_INDEX.get(fn)]);
    calls.push({
      fn: raw,
      index: m.index,
      line: lineOf(m.index),
      text: `${argvText} ; ${optText}`,
      isCliEntry: textNamesCliEntry(argvText, ids),
      hasTimeout: /(^|[^\w$.])timeout\s*[:=]/.test(optText),
    });
  }
  // A numeric `timeout:` value, so a case budget can be checked against the sum
  // of the waits inside it (flair#1825).
  for (const call of calls) {
    const m = call.text.match(/(?:^|[^\w$.])timeout\s*[:=]\s*([0-9][0-9_]*)/);
    const n = m ? Number(m[1].replace(/_/g, "")) : NaN;
    // ONLY a positive finite value is a deadline: `timeout: 0` (node and Bun)
    // means NO timeout, so it is unbounded (flair#1825).
    call.timeoutMs = Number.isFinite(n) && n > 0 ? n : null;
    call.hasTimeout = call.timeoutMs !== null;
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

/** File-local function/arrow bodies `{ name, start, end }` (for scope attribution). */
export function functionBodies(source) {
  const src = maskComments(source);
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
  return bodies;
}

/** File-local functions whose body contains a CLI-entry spawn, transitively. */
export function localHelpersThatSpawn(source, calls) {
  const src = maskComments(source);
  const spawnIdx = calls.filter((c) => c.isCliEntry).map((c) => c.index);
  const helpers = new Set();
  if (spawnIdx.length === 0) return helpers;
  const bodies = functionBodies(source);
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
/** Parse a per-case budget: a numeric literal (`30_000`) or `{ timeout: N }`. */
export function parseBudgetMs(text) {
  const t = (text ?? "").trim().replace(/_/g, "");
  let m = t.match(/^([0-9]+)$/);
  if (m) return Number(m[1]);
  m = t.match(/timeout\s*[:=]\s*([0-9]+)/);
  return m ? Number(m[1]) : null;
}

/** Sum of every bounded wait inside a case: spawn `timeout:` + fetch timeouts.
 *  `extraBodies` are the file-local helper bodies the case reaches (transitively),
 *  so a wait held in a helper the case CALLS counts too (flair#1825). */
export function sumWaitsMs(body, calls, open, close, extraBodies = []) {
  let sum = 0;
  for (const c of calls) {
    if (!c.timeoutMs) continue;
    const inside = (c.index > open && c.index < close) || extraBodies.some((b) => c.index > b.start && c.index < b.end);
    if (inside) sum += c.timeoutMs;
  }
  for (const m of body.matchAll(/AbortSignal\.timeout\s*\(\s*([0-9][0-9_]*)/g)) {
    sum += Number(m[1].replace(/_/g, ""));
  }
  return sum;
}

/** The bodies of every helper (transitively) a case body calls. */
export function reachableHelperBodies(body, src, helpers, bodies) {
  const out = [];
  const seen = new Set();
  const stack = [...helpers].filter((h) => identifierCalled(body, h));
  while (stack.length) {
    const name = stack.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const b = bodies.find((x) => x.name === name);
    if (!b) continue;
    out.push(b);
    const text = src.slice(b.start, b.end);
    for (const h of helpers) if (!seen.has(h) && identifierCalled(text, h)) stack.push(h);
  }
  return out;
}

/** First `fetch(` in a case with no deadline in its argument list, or null. */
export function firstUnboundedFetch(body) {
  for (const m of body.matchAll(/(^|[^\w$.])fetch\s*\(/g)) {
    const seg = body.slice(m.index, m.index + 400);
    // `signal:` must carry a REAL deadline — `{ signal: undefined }` is
    // present-but-undefined and is NOT bounded (flair#1825).
    if (!/AbortSignal\.timeout\s*\(/.test(seg) && !/signal\s*:\s*(?!undefined\b)\S/.test(seg)) {
      return `fetch(${body.slice(m.index, m.index + 40).replace(/\s+/g, " ").trim()})`;
    }
  }
  return null;
}

export function findCases(source, calls, helpers, bodies = []) {
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
    const caseBody = src.slice(open + 1, args.close);
    const reach = reachableHelperBodies(caseBody, src, helpers, bodies);
    const waitsText = caseBody + "\n" + reach.map((b) => src.slice(b.start, b.end)).join("\n");
    // The CLI-entry calls this case reaches (directly, or through a helper).
    const reached = calls.filter(
      (c) => c.isCliEntry && ((c.index > open && c.index < args.close) || reach.some((b) => c.index > b.start && c.index < b.end)),
    );
    const budgetText = args.spans[2]?.text ?? "";
    cases.push({
      fn: m[2],
      line: src.slice(0, m.index).split("\n").length,
      name: (args.spans[0]?.text.trim() ?? "").replace(/^["'`]|["'`]$/g, ""),
      argCount: args.spans.length,
      reachesSpawn: reaches,
      budgetMs: parseBudgetMs(budgetText),
      hasBudget: parseBudgetMs(budgetText) !== null,
      sumWaitsMs: sumWaitsMs(waitsText, calls, open, args.close, reach),
      unboundedFetch: firstUnboundedFetch(waitsText),
      reachedFingerprints: reached.map((c) => normalizeFingerprint(c.text ?? c.fn)),
      open,
      close: args.close,
    });
  }
  return cases;
}

/**
 * Normalize call text so a fingerprint survives whitespace and line moves.
 * Whitespace inside brackets/parens/after commas is removed too, so
 * `["bun", "src/cli.ts"]` and `["bun","src/cli.ts"]` share one key (flair#1825).
 */
export function normalizeFingerprint(text) {
  return text
    .replace(/\s+/g, " ")
    .replace(/\[\s+/g, "[")
    .replace(/\s+\]/g, "]")
    .replace(/,\s+/g, ",")
    .replace(/\s+,/g, ",")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s*,\s*$/, "")
    .trim();
}

/**
 * The stable key of an offender: file + scope + normalized fingerprint + kind +
 * an occurrence ordinal. NEVER file:line. The ordinal distinguishes two
 * otherwise-identical calls in one scope, so one entry covers exactly one call.
 */
export function offenderKey(o) {
  return [o.file, o.scope, o.fingerprint, o.kind, String(o.occurrence ?? 0)].join(" | ");
}

/** Innermost enclosing helper (or case) name for a call index, else "<module>". */
function scopeOf(index, bodies, cases) {
  let best = null;
  for (const b of bodies) {
    if (index > b.start && index < b.end && (!best || b.start >= best.start)) best = b;
  }
  if (best) return best.name;
  let bestCase = null;
  for (const c of cases) {
    if (index > c.open && index < c.close && (!bestCase || c.open >= bestCase.open)) bestCase = c;
  }
  return bestCase ? bestCase.name : "<module>";
}

export function analyzeTestFile(source) {
  const { calls, ids } = findSpawnCalls(source);
  const helpers = localHelpersThatSpawn(source, calls);
  const bodies = functionBodies(source);
  const cases = findCases(source, calls, helpers, bodies);
  for (const call of calls) call.scope = scopeOf(call.index, bodies, cases);
  return { calls, ids, helpers, cases, bodies };
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
    const src = readFileSync(file, "utf8");
    const { calls, cases } = analyzeTestFile(src);
    for (const call of calls) {
      if (call.isCliEntry && !call.hasTimeout) {
        spawnOffenders.push({
          file: rel,
          line: call.line,
          kind: "spawn-no-timeout",
          detail: `${call.fn}()`,
          scope: call.scope ?? "<module>",
          fingerprint: normalizeFingerprint(call.text ?? `${call.fn}(...)`),
        });
      }
    }
    for (const c of cases) {
      if (!c.reachesSpawn) continue;
      const base = { file: rel, line: c.line, scope: c.name };
      if (!c.hasBudget) {
        // One entry PER reached CLI-entry call, identified by the CALL, not just
        // the case name (flair#1825 round 4).
        const fps = c.reachedFingerprints && c.reachedFingerprints.length ? c.reachedFingerprints : [normalizeFingerprint(c.name)];
        for (const fp of fps) {
          caseOffenders.push({ ...base, kind: "case-no-budget", detail: `${c.fn}("${c.name.slice(0, 60)}")`, fingerprint: fp });
        }
      } else if (c.unboundedFetch) {
        caseOffenders.push({ ...base, kind: "case-unbounded-fetch", detail: `unbounded ${c.unboundedFetch}`, fingerprint: normalizeFingerprint(c.name) });
      } else if (c.budgetMs <= c.sumWaitsMs) {
        caseOffenders.push({ ...base, kind: "case-budget-too-small", detail: `budget ${c.budgetMs} <= sum of waits ${c.sumWaitsMs} in ${c.fn}("${c.name.slice(0, 40)}")`, fingerprint: normalizeFingerprint(c.name) });
      }
    }
  }
  const assignOccurrence = (list) => {
    const counts = new Map();
    for (const o of list) {
      const base = [o.file, o.scope, o.fingerprint, o.kind].join(" | ");
      const n = counts.get(base) ?? 0;
      o.occurrence = n;
      counts.set(base, n + 1);
    }
  };
  assignOccurrence(spawnOffenders);
  assignOccurrence(caseOffenders);
  return { files: files.map((f) => relative(root, f)), spawnOffenders, caseOffenders };
}

/** A baseline entry keyed on file:line (or carrying a `line`) is rejected. */
export function isLineKey(entry) {
  if (entry && typeof entry === "object" && "line" in entry) return true;
  const file = entry && typeof entry.file === "string" ? entry.file : "";
  return /:\d+$/.test(file);
}

/** Validate a baseline entry list: shape, no line keys, no duplicate keys. */
export function validateBaseline(entries) {
  const errors = [];
  const seen = new Map();
  if (!Array.isArray(entries)) return ["baseline must be an array of entries"];
  entries.forEach((e, i) => {
    const where = `entry[${i}]`;
    if (!e || typeof e !== "object") {
      errors.push(`${where}: not an object`);
      return;
    }
    if (isLineKey(e)) errors.push(`${where}: keyed on file:line — use file + scope + fingerprint + kind`);
    for (const f of ["file", "scope", "fingerprint", "kind"]) {
      if (typeof e[f] !== "string" || e[f].length === 0) errors.push(`${where}: missing string "${f}"`);
    }
    if (!["spawn-no-timeout", "case-no-budget", "case-unbounded-fetch", "case-budget-too-small"].includes(e.kind)) {
      errors.push(`${where}: unknown kind "${e.kind}"`);
    }
    if (typeof e.reason !== "string" || e.reason.length === 0) errors.push(`${where}: missing "reason"`);
    if (e.occurrence !== undefined && (!Number.isInteger(e.occurrence) || e.occurrence < 0)) {
      errors.push(`${where}: "occurrence" must be a non-negative integer`);
    }
    if (
      typeof e.file === "string" &&
      typeof e.scope === "string" &&
      typeof e.fingerprint === "string" &&
      typeof e.kind === "string"
    ) {
      const key = offenderKey(e);
      if (seen.has(key)) errors.push(`${where}: duplicate fingerprint/key of ${seen.get(key)}`);
      else seen.set(key, where);
    }
  });
  return errors;
}

/** Compare current offenders to the trusted baseline. The baseline is authoritative. */
export function diffAgainstBaseline(spawnOffenders, caseOffenders, baselineEntries) {
  const current = [...spawnOffenders, ...caseOffenders];
  const baselineKeys = new Set(baselineEntries.map((e) => offenderKey(e)));
  const currentCounts = new Map();
  for (const o of current) {
    const k = offenderKey(o);
    currentCounts.set(k, (currentCounts.get(k) ?? 0) + 1);
  }
  const newOffenders = [];
  const seen = new Set();
  for (const o of current) {
    const k = offenderKey(o);
    // Every entry covers exactly one call: the first match is the allowed one,
    // a second identical call is a new offender (multiplicity enforced).
    if (baselineKeys.has(k) && !seen.has(k)) {
      seen.add(k);
      continue;
    }
    newOffenders.push(o);
  }
  const staleEntries = baselineEntries.filter((e) => !currentCounts.has(offenderKey(e)));
  return { newOffenders, staleEntries, ok: newOffenders.length === 0 && staleEntries.length === 0 };
}

/** Read a baseline file from disk (the PR copy; API kept for the unit tests). */
export function loadBaseline(path = BASELINE_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * The TRUSTED base ref the baseline is read from (flair#1825). CI supplies it via
 * the environment (`CLI_SPAWN_BUDGETS_BASE_REF`: the PR's base sha, or the
 * previous commit on a push). The baseline is read from THAT ref with
 * `git show <ref>:scripts/ci/cli-spawn-budgets.baseline.json`, so a PR cannot add
 * an exception by editing its own copy of the file. Locally the base defaults to
 * `origin/main` and the run says so.
 */
export function gateBaseRef(env = process.env) {
  const v = env.CLI_SPAWN_BUDGETS_BASE_REF || env.CLI_SPAWN_BUDGET_BASE_REF;
  return v && v.trim().length > 0 ? v.trim() : "origin/main";
}

const BASELINE_REL = "scripts/ci/cli-spawn-budgets.baseline.json";

/** Resolve a ref to its full 40-char commit sha in `root`; hard-fail if invalid. */
export function resolveRef(ref, root) {
  const r = spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `invalid base ref '${ref}': cannot resolve it in ${root}` +
        `${(r.stderr || "").trim() ? ` (${r.stderr.trim()})` : ""}. ` +
        `Set CLI_SPAWN_BUDGETS_BASE_REF to a ref that exists.`,
    );
  }
  return r.stdout.trim();
}

/**
 * True when `ancestor` is an ancestor of `descendant` in `root`. Exit 1 →
 * false; any other non-zero (e.g. a missing object) is a HARD failure naming
 * both shas — never a silent "not an ancestor".
 */
export function isAncestor(ancestor, descendant, root) {
  const r = spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", ancestor, descendant], { encoding: "utf8" });
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  throw new Error(
    `cannot decide whether ${ancestor} is an ancestor of ${descendant} in ${root}: ` +
      `${(r.stderr || r.stdout || "").trim()} (is an object missing from the local store? flair#1825).`,
  );
}

/** Read the baseline at `ref` from `root`'s git object store.
 *
 * FAIL CLOSED (flair#1825): an invalid/unreadable ref is a hard error naming the
 * ref; a VALID ref with no baseline file returns null (the base baseline is
 * EMPTY). Nothing else may be treated as "no baseline". */
export function loadBaselineAtRef(ref, root) {
  resolveRef(ref, root);
  const res = spawnSync("git", ["-C", root, "show", `${ref}:${BASELINE_REL}`], { encoding: "utf8" });
  if (res.status === 0) return JSON.parse(res.stdout);
  // A valid ref whose tree has no baseline file → the base baseline is EMPTY.
  if (/does not exist|exists on disk, but not in/i.test(res.stderr ?? "")) return null;
  throw new Error(
    `cannot read the baseline at '${ref}:${BASELINE_REL}' (git show exit ${res.status}): ${(res.stderr || "").trim()}`,
  );
}

/** The PR tree's copy of the baseline — used ONLY to reject ADDED exceptions. */
export function readPrBaseline(root) {
  return JSON.parse(readFileSync(join(root, BASELINE_REL), "utf8"));
}

/** Entries a PR ADDED relative to the trusted base. A PR may only REMOVE. */
export function addedExceptions(baseEntries, prEntries) {
  const baseKeys = new Set(baseEntries.map(offenderKey));
  return prEntries.filter((e) => !baseKeys.has(offenderKey(e)));
}

/**
 * End-to-end check: scan `root`, diff against the baseline read from `baseRef`.
 *
 * The effective allow-list is the BASE copy. When the base has no baseline file
 * (the PR that first introduces it), the PR copy is the initial list and no
 * "added exception" is computed — there is nothing to add relative to. Once the
 * base has the file, an entry in the PR copy but not the base is a failure.
 * `stale` is computed against the PR copy, so removing a now-budgeted entry is
 * allowed.
 */
export function runGate({ root, baseRef = gateBaseRef(), env = process.env, seedBase = SEED_INTRODUCTION_BASE } = {}) {
  const { files, spawnOffenders, caseOffenders } = scanTree(root);
  const defaulted = !(env.CLI_SPAWN_BUDGETS_BASE_REF || env.CLI_SPAWN_BUDGET_BASE_REF);
  const prEntries = readPrBaseline(root);
  const baseEntries = loadBaselineAtRef(baseRef, root); // throws on an invalid ref
  const basePresent = baseEntries !== null;
  const baseSha = resolveRef(baseRef, root);
  const errors = [
    ...validateBaseline(prEntries).map((e) => `pr: ${e}`),
    ...(basePresent ? validateBaseline(baseEntries).map((e) => `base: ${e}`) : []),
  ];
  // The PR copy is the working list: new offenders, multiplicity, and stale
  // entries are measured against it.
  const diff = diffAgainstBaseline(spawnOffenders, caseOffenders, prEntries);
  // Added exceptions: the PR copy may only REMOVE relative to the base. When the
  // base has NO baseline file the base baseline is EMPTY, so EVERY PR entry is an
  // addition → fail — UNLESS the base DESCENDS from the seed-introduction anchor
  // (flair#1825). An exact-sha equality can never survive main moving. The anchor
  // is resolved/checked ONLY on this seed path: when the base HAS the file it is
  // dead code (a follow-up removes it — first slice of #1921).
  let anchored = false;
  let added;
  if (basePresent) {
    added = addedExceptions(baseEntries, prEntries);
  } else {
    let anchorSha;
    try {
      anchorSha = resolveRef(seedBase, root);
    } catch {
      throw new Error(
        `the seed-introduction base ${seedBase} is missing from the local object store in ${root} ` +
          `— the CI step must fetch it (git fetch origin ${seedBase}) (flair#1825).`,
      );
    }
    if (!isAncestor(anchorSha, baseSha, root)) {
      throw new Error(
        `the base '${baseRef}' resolves to ${baseSha}, which has no baseline file and does not descend from the ` +
          `seed-introduction base ${seedBase} — refusing to treat the PR's copy as the baseline (flair#1825).`,
      );
    }
    anchored = true;
    added = [];
  }
  return {
    files,
    spawnOffenders,
    caseOffenders,
    baseRef,
    baseSha,
    basePresent,
    defaulted,
    anchored,
    seedAccepted: anchored && !basePresent,
    allowEntries: prEntries,
    prEntries,
    baseEntries: baseEntries ?? [],
    errors,
    added,
    ...diff,
    ok: errors.length === 0 && diff.ok && added.length === 0,
  };
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
  const baseFlag = argv.indexOf("--base");
  if (baseFlag !== -1 && argv[baseFlag + 1]) process.env.CLI_SPAWN_BUDGETS_BASE_REF = argv[baseFlag + 1];
  let result;
  try {
    result = runGate({ root });
  } catch (err) {
    process.stderr.write(`check-cli-spawn-budgets: ${err.message}\n`);
    process.exit(1);
  }
  const { files, spawnOffenders, caseOffenders, baseRef, basePresent, defaulted, seedAccepted, allowEntries, errors, added, newOffenders, staleEntries, ok } = result;
  if (seedAccepted) {
    process.stdout.write(
      "check-cli-spawn-budgets: SEED — the base resolves to the seed-introduction commit " +
        `${SEED_INTRODUCTION_BASE}, which has no baseline file; the PR copy is the initial list. ` +
        "Any other base without the file is refused.\n",
    );
  }
  process.stdout.write(
    `check-cli-spawn-budgets: scanned ${files.length} test file(s) under ${join(root, "test")}; base ref ${baseRef}` +
      `${defaulted ? " (defaulted — set CLI_SPAWN_BUDGETS_BASE_REF to pin it)" : ""}` +
      `${basePresent ? "" : " — base has no baseline; the PR copy is the initial list"}\n`,
  );
  if (files.length === 0) {
    process.stderr.write(
      "check-cli-spawn-budgets: no test files found — the scan saw nothing, which is not a pass.\n",
    );
    process.exit(1);
  }
  for (const e of errors) process.stderr.write(`check-cli-spawn-budgets: bad baseline — ${e}\n`);
  for (const o of newOffenders) process.stdout.write(`  NEW      ${o.file}:${o.line}  ${o.kind}  ${o.detail}\n`);
  for (const o of staleEntries) {
    process.stdout.write(`  STALE    ${o.file}  ${o.scope}  ${o.kind}  ${o.fingerprint.slice(0, 50)}\n`);
  }
  for (const o of added) {
    process.stdout.write(`  ADDED-EX ${o.file}  ${o.scope}  ${o.kind}  ${o.fingerprint.slice(0, 50)}  (a PR may only REMOVE baseline entries)\n`);
  }
  process.stdout.write(
    `check-cli-spawn-budgets: ${spawnOffenders.length} spawn(s) with no timeout, ${caseOffenders.length} case(s) offending, ` +
      `${allowEntries.length} allowed at ${baseRef} — ${newOffenders.length} new, ${staleEntries.length} stale, ${added.length} added-exception.\n`,
  );
  process.exit(ok ? 0 : 1);
}
