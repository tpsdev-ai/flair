/**
 * flair#3136 item 1: regression guard for literal `.key`, `-priv.key` and `.pub`
 * suffix spellings outside src/lib/key-dir.ts: plain strings, template text and
 * concatenated suffix literals, including inside `${...}`, with a named allowlist.
 * It does not detect a suffix split across literals, or prove that no source
 * file assembles an agent key name.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

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

/** Reports the parse diagnostics of the SourceFile passed to getSyntacticDiagnostics. */
const PARSE_CHECK = ts.createProgram({ rootNames: [], options: { noLib: true, noResolve: true, types: [] } });

/** Comments are skipped because the parser classifies them; literals come from
 *  the AST, so no regex pass reads code as comment text. A source with a parse
 *  diagnostic fails before its AST is walked: error recovery can leave a literal
 *  out of the tree. */
function literals(source: string, fileName: string): Literal[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const [diagnostic] = PARSE_CHECK.getSyntacticDiagnostics(sourceFile);
  if (diagnostic) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    throw new Error(`${fileName}:${line + 1}:${character + 1}: ${message}`);
  }
  const found: Literal[] = [];
  visit(sourceFile);
  return found;

  function visit(node: ts.Node): void {
    if (isLiteralToken(node.kind)) {
      const index = node.getStart(sourceFile) + 1;
      found.push({
        text: (node as ts.TemplateLiteralLikeNode).text,
        index,
        line: sourceFile.getLineAndCharacterOfPosition(index).line + 1,
      });
    }
    node.forEachChild(visit);
  }
}

function isLiteralToken(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.StringLiteral ||
    kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
    kind === ts.SyntaxKind.TemplateHead ||
    kind === ts.SyntaxKind.TemplateMiddle ||
    kind === ts.SyntaxKind.TemplateTail
  );
}

function keyLiterals(source: string, fileName = "fixture.ts"): Literal[] {
  return literals(source, fileName).filter((literal) =>
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
  const lines = source.split("\n");
  const found: string[] = [];
  for (const literal of keyLiterals(source, relativeFile)) {
    const lineText = lines[literal.line - 1]?.trim() ?? "";
    if (allowed(relativeFile, source, literal)) continue;
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

for (const [kind, sample] of [
  ["StringLiteral", 'const path = "agent.key";'],
  ["NoSubstitutionTemplateLiteral", "const path = `agent.key`;"],
  ["TemplateHead", "const path = `agent.key${suffix}`;"],
  ["TemplateMiddle", "const path = `${agentId}.key${suffix}`;"],
  ["TemplateTail", "const path = `${agentId}.key`;"],
] as const) {
  test(`a ${kind} ending in .key is flagged`, () => {
    expect(offendersIn("src/lib/example.ts", sample)).toEqual([`src/lib/example.ts:1: ${sample}`]);
  });
}

test("a source with a parse diagnostic fails the guard, naming the file and location", () => {
  expect(() => offendersIn("src/lib/example.ts", "const x = ;"))
    .toThrow("src/lib/example.ts:1:11: Expression expected.");
  // Error recovery reads this unterminated template so that no literal ends in .key.
  const recovered = "const broken = `unterminated\nconst bad = join(dir, `${agentId}.key`);";
  expect(() => offendersIn("src/lib/example.ts", recovered))
    .toThrow("src/lib/example.ts:2:24: ',' expected.");
  const init = `${readFileSync(join(SRC, "commands", "init.ts"), "utf8")}\nconst x = ;`;
  expect(() => offendersIn("src/commands/init.ts", init))
    .toThrow(`src/commands/init.ts:${init.split("\n").length}:11: Expression expected.`);
});

test("a key-path literal after each comment-opener shape is still flagged", () => {
  const samples = [
    '// see assets/*.js\nconst bad = join(dir, `${agentId}.key`);\nconst tail = "*/";',
    "/* block comment */ const bad = join(dir, `${agentId}.key`);",
    'const a = "/*"; const bad = join(dir, `${agentId}.key`); const b = "*/";',
    "const a = `//`; const bad = join(dir, `${agentId}.key`);",
    'const re = /[/*]/; const bad = join(dir, `${agentId}.key`); const b = "*/";',
    "const re = /[//]/; const bad = join(dir, `${agentId}.key`);",
  ];
  for (const sample of samples) {
    expect(offendersIn("src/lib/example.ts", sample), sample).toHaveLength(1);
  }
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
