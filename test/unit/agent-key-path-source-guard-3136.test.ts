/**
 * flair#3136 item 1: regression guard for literal `.key`, `-priv.key` and `.pub`
 * suffix spellings outside src/lib/key-dir.ts: plain strings, template text and
 * concatenated suffix literals, including inside `${...}`, with a named allowlist.
 * It does not detect escaped/cooked spellings such as `"\x2ekey"` or a suffix
 * split across literals, or prove that no source file assembles an agent key name.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const SRC = join(ROOT, "src");
const HELPER = join(SRC, "lib", "key-dir.ts");
const KEY_SUFFIXES = [".key", "-priv.key", ".pub"];

/** Named non-agent uses that genuinely need such a literal. `expression` must
 *  contain the flagged literal's own span, so another literal on the same line
 *  still fails. */
const ALLOWLIST: Array<{ name: string; file: string; expression: string; reason: string }> = [
  {
    name: "prune-discovered-filenames",
    file: "src/commands/keys.ts",
    expression: 'slice(0, -".key".length)',
    reason: "keys prune classifies discovered file names before any id check; no id-derived path",
  },
  {
    name: "key-file-readdir-filter",
    file: "src/cli.ts",
    expression: 'endsWith(".key")',
    reason: "readdir filter over discovered file names, not an id-derived path",
  },
  {
    name: "key-file-readdir-filter",
    file: "src/lib/auth-resolve.ts",
    expression: 'endsWith(".key")',
    reason: "readdir filter over discovered file names, not an id-derived path",
  },
  {
    name: "key-file-readdir-filter",
    file: "src/lib/doctor-run.ts",
    expression: 'endsWith(".key")',
    reason: "readdir filter over discovered file names, not an id-derived path",
  },
  {
    name: "placeholder-remedy",
    file: "src/lib/auth-resolve.ts",
    expression: '"<agent-id>.key"',
    reason: "operator remedy names a placeholder path, not built from an id",
  },
  {
    name: "custody-key-filename",
    file: "src/lib/integrity-state.ts",
    expression: '"custody.key"',
    reason: "integrity custody file name, not an agent key path",
  },
];

interface Literal {
  text: string;
  line: number;
  index: number;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ""))
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function lineCounter(source: string): (index: number) => number {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  return (index) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= index) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

/** Each string literal and template-literal text chunk in `source`, with
 *  `${...}` expressions scanned recursively so a literal inside one is found
 *  too. */
function literals(source: string): Literal[] {
  const found: Literal[] = [];
  const lineAt = lineCounter(source);
  scan(source, 0, source.length);
  return found;

  function scan(text: string, start: number, end: number): void {
    let i = start;
    while (i < end) {
      const ch = text[i];
      if (ch === '"' || ch === "'") {
        const stop = Math.min(skipQuoted(text, i), end);
        let literalText = "";
        for (let j = i + 1; j < stop - 1; j++) {
          if (text[j] === "\\") {
            literalText += text[j + 1] ?? "";
            j++;
            continue;
          }
          literalText += text[j];
        }
        found.push({ text: literalText, line: lineAt(i), index: i });
        i = stop;
        continue;
      }
      if (ch === "`") {
        let j = i + 1;
        let textStart = i + 1;
        let chunk = "";
        while (j < end) {
          if (text[j] === "\\") {
            chunk += text[j + 1] ?? "";
            j += 2;
            continue;
          }
          if (text[j] === "`") break;
          if (text[j] === "$" && text[j + 1] === "{") {
            found.push({ text: chunk, line: lineAt(textStart), index: textStart });
            const close = matchingBrace(text, j + 1);
            if (close === -1) {
              j = end;
              break;
            }
            scan(text, j + 2, close);
            j = close + 1;
            textStart = j;
            chunk = "";
            continue;
          }
          chunk += text[j];
          j++;
        }
        found.push({ text: chunk, line: lineAt(textStart), index: textStart });
        i = j + 1;
        continue;
      }
      i++;
    }
  }
}

/** The index of the `}` that closes the `{` at `openIndex`, or -1. Braces inside
 *  quoted strings and template literals do not count. */
function matchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  let i = openIndex;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = skipQuoted(text, i);
      continue;
    }
    if (ch === "`") {
      i = skipTemplate(text, i);
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function skipQuoted(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text[i] !== text[start] && text[i] !== "\n") {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    i++;
  }
  return i + 1;
}

function skipTemplate(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === "`") return i + 1;
    if (text[i] === "$" && text[i + 1] === "{") {
      const close = matchingBrace(text, i + 1);
      if (close === -1) return text.length;
      i = close + 1;
      continue;
    }
    i++;
  }
  return text.length;
}

function keyLiterals(source: string): Literal[] {
  return literals(stripComments(source)).filter((literal) =>
    KEY_SUFFIXES.some((suffix) => literal.text.endsWith(suffix)),
  );
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out.sort();
}

function allowed(file: string, source: string, literal: Literal): boolean {
  return ALLOWLIST.some((entry) => {
    if (entry.file !== file) return false;
    for (let at = source.indexOf(entry.expression); at !== -1; at = source.indexOf(entry.expression, at + 1)) {
      if (literal.index >= at && literal.index < at + entry.expression.length) return true;
    }
    return false;
  });
}

/** Offenders in one file's source, with `relativeFile` only labelling the hits. */
function offendersIn(relativeFile: string, source: string): string[] {
  const stripped = stripComments(source);
  const lines = stripped.split("\n");
  const found: string[] = [];
  for (const literal of keyLiterals(stripped)) {
    const lineText = lines[literal.line - 1]?.trim() ?? "";
    if (allowed(relativeFile, stripped, literal)) continue;
    found.push(`${relativeFile}:${literal.line}: ${lineText}`);
  }
  return found;
}

function offenders(): string[] {
  const found: string[] = [];
  for (const file of sourceFiles(SRC)) {
    if (file === HELPER) continue;
    found.push(...offendersIn(relative(ROOT, file), readFileSync(file, "utf8")));
  }
  return found;
}

test("the detector sees string, concatenation and nested template-literal shapes (self-proof)", () => {
  const samples = [
    "join(dir, `${agentId}.key`)",
    'join(dir, agentId.concat(".key"))',
    'join(dir, agentId + "-priv.key")',
    'join(dir, agentId + ".pub")',
    'join(dir, `${agentId}${".key"}`)',
  ];
  for (const sample of samples) {
    expect(keyLiterals(sample).length, sample).toBeGreaterThan(0);
  }
  expect(keyLiterals('join(dir, `${agentId}.json`)')).toEqual([]);
  expect(keyLiterals('join(dir, agentId + ".pubx")')).toEqual([]);
});

test("an ID-derived .key join beside an allowlisted expression on the same line still fails", () => {
  const line = 'const safe = names.filter((n) => n.endsWith(".key")); const bad = join(dir, `${agentId}.key`);';
  expect(offendersIn("src/lib/auth-resolve.ts", line))
    .toEqual([`src/lib/auth-resolve.ts:1: ${line}`]);
});

test("the helper builds the private and public paths (the guard is not vacuous)", () => {
  const helper = readFileSync(HELPER, "utf8");
  expect(helper).toContain("export function agentKeyPath(");
  expect(helper).toContain("join(keysDir, `${agentId}.key`)");
  expect(helper).toContain("export function agentPubKeyPath(");
  expect(helper).toContain("join(keysDir, `${agentId}.pub`)");
  expect(helper).toContain("export function keyPathIn(");
});

test("no unallowlisted literal .key, -priv.key or .pub suffix in src outside the key-path module (plain, template text, concatenated, including inside ${...})", () => {
  expect(offenders()).toEqual([]);
});
