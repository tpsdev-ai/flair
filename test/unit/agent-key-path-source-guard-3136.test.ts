/**
 * flair#3136 item 1: every ID-derived key path in src/ is built by a validated
 * helper in src/lib/key-dir.ts, which applies the shared agent-ID rule before
 * joining. The guard fails on any string literal or template-literal text
 * outside that module that is, or ends with, `.key`, `-priv.key` or `.pub`,
 * however it is assembled. A named allowlist covers non-agent literals.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const SRC = join(ROOT, "src");
const HELPER = join(SRC, "lib", "key-dir.ts");
const KEY_SUFFIXES = [".key", "-priv.key", ".pub"];

/** Named non-agent uses that genuinely need such a literal. `markers` must
 *  appear on the offending line, so a new literal in the same file still fails. */
const ALLOWLIST: Array<{ name: string; file: string; markers: string[]; reason: string }> = [
  {
    name: "prune-discovered-filenames",
    file: "src/commands/keys.ts",
    markers: ['slice(0, -".key".length)'],
    reason: "keys prune classifies discovered file names before any id check; no id-derived path",
  },
  {
    name: "key-file-readdir-filter",
    file: "src/cli.ts",
    markers: ['endsWith(".key")'],
    reason: "readdir filter over discovered file names, not an id-derived path",
  },
  {
    name: "key-file-readdir-filter",
    file: "src/lib/auth-resolve.ts",
    markers: ['endsWith(".key")'],
    reason: "readdir filter over discovered file names, not an id-derived path",
  },
  {
    name: "key-file-readdir-filter",
    file: "src/lib/doctor-run.ts",
    markers: ['endsWith(".key")'],
    reason: "readdir filter over discovered file names, not an id-derived path",
  },
  {
    name: "placeholder-remedy",
    file: "src/lib/auth-resolve.ts",
    markers: ['"<agent-id>.key"'],
    reason: "operator remedy names a placeholder path, not built from an id",
  },
  {
    name: "custody-key-filename",
    file: "src/lib/integrity-state.ts",
    markers: ['"custody.key"'],
    reason: "integrity custody file name, not an agent key path",
  },
];

interface Literal {
  text: string;
  line: number;
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
 *  `${...}` expressions skipped so the text around them stays separate. */
function literals(source: string): Literal[] {
  const found: Literal[] = [];
  const lineAt = lineCounter(source);
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let text = "";
      while (j < source.length && source[j] !== ch && source[j] !== "\n") {
        if (source[j] === "\\") {
          text += source[j + 1] ?? "";
          j += 2;
          continue;
        }
        text += source[j];
        j++;
      }
      found.push({ text, line: lineAt(i) });
      i = j + 1;
      continue;
    }
    if (ch === "`") {
      let j = i + 1;
      let text = "";
      let textStart = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          text += source[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (source[j] === "`") break;
        if (source[j] === "$" && source[j + 1] === "{") {
          found.push({ text, line: lineAt(textStart) });
          let depth = 1;
          j += 2;
          while (j < source.length && depth > 0) {
            if (source[j] === "{") depth++;
            else if (source[j] === "}") depth--;
            j++;
          }
          text = "";
          textStart = j;
          continue;
        }
        text += source[j];
        j++;
      }
      found.push({ text, line: lineAt(textStart) });
      i = j + 1;
      continue;
    }
    i++;
  }
  return found;
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

function allowed(file: string, lineText: string): boolean {
  return ALLOWLIST.some((entry) => entry.file === file && entry.markers.some((marker) => lineText.includes(marker)));
}

function offenders(): string[] {
  const found: string[] = [];
  for (const file of sourceFiles(SRC)) {
    if (file === HELPER) continue;
    const source = readFileSync(file, "utf8");
    const lines = stripComments(source).split("\n");
    const relativeFile = relative(ROOT, file);
    for (const literal of keyLiterals(source)) {
      const lineText = lines[literal.line - 1]?.trim() ?? "";
      if (allowed(relativeFile, lineText)) continue;
      found.push(`${relativeFile}:${literal.line}: ${lineText}`);
    }
  }
  return found;
}

test("the detector sees each guarded assembly shape (self-proof)", () => {
  const samples = [
    "join(dir, `${agentId}.key`)",
    'join(dir, agentId.concat(".key"))',
    'join(dir, agentId + "-priv.key")',
    'join(dir, agentId + ".pub")',
  ];
  for (const sample of samples) {
    expect(keyLiterals(sample).length, sample).toBeGreaterThan(0);
  }
  expect(keyLiterals('join(dir, `${agentId}.json`)')).toEqual([]);
  expect(keyLiterals('join(dir, agentId + ".pubx")')).toEqual([]);
});

test("the helper builds the private and public paths (the guard is not vacuous)", () => {
  const helper = readFileSync(HELPER, "utf8");
  expect(helper).toContain("export function agentKeyPath(");
  expect(helper).toContain("join(keysDir, `${agentId}.key`)");
  expect(helper).toContain("export function agentPubKeyPath(");
  expect(helper).toContain("join(keysDir, `${agentId}.pub`)");
  expect(helper).toContain("export function keyPathIn(");
});

test("no src file outside the key-path module assembles an agent key name", () => {
  expect(offenders()).toEqual([]);
});
