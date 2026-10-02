// cli-message-flags.test.ts — flair#2116: flags named in src/ string literals are
// declared by the command they are checked against, within the limits below.
//
// `flair mcp enable` told operators to pass `--admin-pass-file` and `--ops-url`,
// and the command has neither. Nothing failed: a flag named in an error message,
// a hint or a help text is only prose to the compiler, so a rename, a removal or
// a flag that never existed ships green and the operator finds out by typing it.
//
// This guard checks the prose against commander's own registry:
//
//   1. THE REGISTRY — the real `program` from src/cli.ts, walked recursively.
//      A command accepts its own `.options[].long`, commander's built-in
//      `--help`, and every ancestor's options (commander consumes a parent's
//      option wherever it appears, which is what `showGlobalOptions` prints as
//      "Global Options").
//   2. THE PROSE — every string literal and template literal in src/, read with
//      the TypeScript parser (comments are not strings, so they never count),
//      scanned for `--[a-z][a-z0-9-]+`.
//   3. WHICH COMMAND a flag is checked against, most specific first:
//        a. a mention in the same literal: `flair <command path> … --flag`, or a
//           backtick span opening with a command path (`memory search --x`).
//           The mention covers the flags that follow it up to the end of that
//           command text: a backtick, newline, `;`, `(`, `)`, `|`, ", ", ". " or " — ";
//        b. the `.command("…")` chain the literal sits in (its description,
//           option help texts and action body), resolved to the full path;
//        c. a literal outside any chain in a module that registers commands:
//           any command that module registers;
//        d. a module that registers none: any command registered by the nearest
//           modules that import it (transitively, through non-registering ones);
//        e. nothing imports it: any command at all.
//      c–e are deliberately looser than a–b: a helper's string is shared by the
//      commands that call it, and this test does not follow calls. They still
//      catch a flag that no command in reach declares, which is what #2116's --ops-url was.
//
// What this does NOT check:
//   - a flag's own declaration (`.option("--x <v>")`);
//   - a literal that is nothing but one flag (`"--user"`, `"--omit=dev"`): an
//     argv element for another program or an argument to a hint builder, whose
//     sentence is assembled elsewhere at runtime;
//   - the flags after a FOREIGN_TOOLS name (another program's flags);
//   - text outside string and template literals (comments), and a message built
//     from several literals or from constants: each literal is read on its own,
//     and `${…}` stands in for every substitution;
//   - at tiers c–e, that the command showing the message declares the flag:
//     only that some command in reach does;
//   - the findings bound by OTHER_COMMAND_REFERENCES (another flair command's
//     flag, checked against that command) and KNOWN_DEFECTS (defects already on
//     main when this guard landed, outside #2116).
// Each exemption binds to exactly one finding by file, flag, context and literal
// text, and the one-to-one test fails when an entry matches no finding or more
// than one, or a finding matches more than one entry. So a second message with an exempted flag is
// not covered by the first one's entry, and a fixed defect's entry has to go.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { Command } from "commander";
import { program } from "../../src/cli";

const REPO = join(import.meta.dir, "..", "..");
const SRC_DIR = join(REPO, "src");

/**
 * Other programs whose flags appear in flair's prose. A literal that names one
 * of these makes the flags after it (up to the end of that command text) its
 * flags, not flair's.
 */
const FOREIGN_TOOLS: Array<{ tool: string; why: string }> = [
  // Repair hints on Linux: "Run: systemctl --user daemon-reload" and
  // "systemctl --user restart <unit>" address the per-user service manager.
  { tool: "systemctl", why: "systemd's control CLI; `--user` selects the per-user manager" },
  // "the systemd --user instance may not be running" names that manager itself.
  { tool: "systemd", why: "prose naming the per-user systemd instance (`systemd --user`)" },
  // `flair upgrade` prints "openclaw plugins install <pkg>@<ver> --force --pin"
  // as the manual fallback when openclaw is not on PATH.
  { tool: "openclaw", why: "OpenClaw's plugin installer flags in a manual fallback line" },
];

/**
 * An exemption binds to ONE finding: the same file, flag, context (see
 * `Finding.context`) and literal text. Line numbers are not part of it, so an
 * unrelated edit above the message does not break it; a second message with the
 * same flag in the same file is a new finding that no entry covers (or, if it is
 * an exact copy, a second match for one entry), and both fail the one-to-one test.
 */
interface Exemption {
  file: string;
  flag: string;
  context: string;
  literal: string;
}

/**
 * Another flair command's flag, named where no mention in the same literal says
 * which command. Each entry names that command, and the test checks that the
 * command really declares the flag, so an entry cannot hide a bogus one.
 */
const OTHER_COMMAND_REFERENCES: Array<Exemption & { command: string; why: string }> = [
  {
    // "Fix: flair init && flair restart (… — pass --ops-bind for deliberate
    // remote admin)": the parenthetical is about the `flair init` re-run, but it
    // follows the `flair restart` mention, whose span ends at the "(".
    file: "src/lib/ops-api-bind.ts",
    flag: "--ops-bind",
    context: "*",
    literal: "safe on a running install — pass --ops-bind for deliberate remote admin)",
    command: "init",
    why: "the remedy re-runs `flair init`, which declares --ops-bind",
  },
  {
    // `${PRINCIPAL_ADD_ADMIN_COMMAND} ${agentId} --admin`: the command comes from
    // a constant ("flair principal add"), and this scan does not substitute
    // identifiers into template literals.
    file: "src/lib/federation-pair-access.ts",
    flag: "--admin",
    context: "*",
    literal: "${…} ${…} --admin",
    command: "principal add",
    why: "the invocation is `flair principal add <id> --admin`, built from a constant",
  },
];

/**
 * Pre-existing on main when this guard landed (flair#2116), outside that
 * issue's scope. Each entry is a real defect: the flag is not declared by the
 * command the message sends the operator to. Fix the message, then delete the
 * entry — the one-to-one test fails while an entry matches nothing.
 */
const KNOWN_DEFECTS: Array<Exemption & { defect: string }> = [
  {
    file: "src/bridges/builtins/mem0.ts",
    flag: "--user",
    context: "*",
    literal: "pass --user <id>; example: flair bridge import mem0 --user <id> --api-key <key> --agent <flair-id>",
    defect: "mem0 import hint (\"pass --user\"); `flair bridge import` declares no --user and commander rejects it as an unknown option",
  },
  {
    file: "src/bridges/builtins/mem0.ts",
    flag: "--user",
    context: "bridge import",
    literal: "pass --user <id>; example: flair bridge import mem0 --user <id> --api-key <key> --agent <flair-id>",
    defect: "mem0 import hint (the example); `flair bridge import` declares no --user",
  },
  {
    file: "src/bridges/builtins/mem0.ts",
    flag: "--api-key",
    context: "bridge import",
    literal: "pass --user <id>; example: flair bridge import mem0 --user <id> --api-key <key> --agent <flair-id>",
    defect: "mem0 import hint (the example); `flair bridge import` declares no --api-key",
  },
  {
    file: "src/bridges/builtins/mem0.ts",
    flag: "--api-key",
    context: "*",
    literal: "pass --api-key <token> or set MEM0_API_KEY in the environment",
    defect: "mem0 API-key hint; `flair bridge import` declares no --api-key",
  },
];

const EXEMPTIONS: Exemption[] = [...OTHER_COMMAND_REFERENCES, ...KNOWN_DEFECTS];

function exemptionMatches(e: Exemption, f: Finding): boolean {
  return e.file === f.file && e.flag === f.flag && e.context === f.context && e.literal === f.literal;
}

/**
 * Apply the exemptions one-to-one. `unexempted` is every finding no entry
 * covers; `problems` names every entry that does not match exactly one finding
 * and every finding that more than one entry matches.
 */
function applyExemptions(findings: Finding[], exemptions: Exemption[]): { unexempted: Finding[]; problems: string[] } {
  const problems: string[] = [];
  for (const e of exemptions) {
    const n = findings.filter((f) => exemptionMatches(e, f)).length;
    if (n !== 1) problems.push(`${e.file} ${e.flag} [${e.context}] «${e.literal}» matches ${n} findings, not exactly one`);
  }
  const unexempted: Finding[] = [];
  for (const f of findings) {
    const n = exemptions.filter((e) => exemptionMatches(e, f)).length;
    if (n === 0) unexempted.push(f);
    if (n > 1) problems.push(`${f.file}:${f.line} ${f.flag} is matched by ${n} exemptions`);
  }
  return { unexempted, problems };
}

// ─── The registry ──────────────────────────────────────────────────────────

/** Command path ("" for the root, "mcp enable", …) → every long flag it accepts. */
type Registry = Map<string, Set<string>>;

function buildRegistry(root: Command): Registry {
  const reg: Registry = new Map();
  const walk = (cmd: Command, path: string[], inherited: Set<string>): void => {
    // `cmd.options` is every declared option, hidden ones included;
    // `visibleOptions` adds commander's built-in help option.
    const own = [...cmd.options, ...cmd.createHelp().visibleOptions(cmd)]
      .map((o) => o.long)
      .filter((l): l is string => typeof l === "string");
    const accepted = new Set([...inherited, ...own]);
    reg.set(path.join(" "), accepted);
    for (const sub of cmd.commands) walk(sub, [...path, sub.name()], accepted);
  };
  walk(root, [], new Set());
  return reg;
}

// ─── The scan ──────────────────────────────────────────────────────────────

const FLAG_TOKEN = /(?<![A-Za-z0-9_-])--[a-z](?:[a-z0-9-]*[a-z0-9])?/g;
const BARE_FLAG = /^--[a-z][a-z0-9-]*(?:=\S*)?$/;
// Every pattern here is a fixed literal. A mention's first word is matched by
// the pattern; the words after it are read in code (NEXT_WORD) and resolved
// against the registry's command names, never interpolated into a pattern.
const FLAIR_MENTION = /\bflair[ \t]+([a-z][a-z0-9-]*)/g;
const BACKTICK_MENTION = /`([a-z][a-z0-9-]*)/g;
const NEXT_WORD = /[ \t]+([a-z][a-z0-9-]*)/y;
const WORD_CHAR = /\w/;
const MENTION_END = /[`\n;()|]|, |\. | — /g;

interface Finding {
  file: string;
  line: number;
  flag: string;
  /**
   * The command the flag was checked against: its path when a mention or a
   * `.command()` chain decided it (tiers a–b), "*" for the looser module tiers
   * (c–e). With file, flag and literal, this is the finding's line-independent
   * identity, which is what an exemption binds to.
   */
  context: string;
  /** The whole literal, `${…}` for each substitution. */
  literal: string;
  /** The command(s) the flag was checked against, for the failure message. */
  checkedAgainst: string;
  excerpt: string;
}

interface ModuleFacts {
  /** Command paths registered by `.command()` chains in this module. */
  commands: string[];
  /** Chains that could not be resolved to a registered path (file:line). */
  unresolved: string[];
}

interface Chain {
  start: number;
  end: number;
  receiverStart: number;
  receiverEnd: number;
  path: string | null;
}

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return e;
}

function isCommandCall(n: ts.Node): n is ts.CallExpression {
  return (
    ts.isCallExpression(n)
    && ts.isPropertyAccessExpression(n.expression)
    && n.expression.name.text === "command"
    && n.arguments.length > 0
    && ts.isStringLiteralLike(n.arguments[0])
  );
}

/** A plain call that takes a command chain first, e.g. `addSharedCredentialOptions(x.command("list"))`. */
function isWrapperCall(n: ts.Node): n is ts.CallExpression {
  return ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.arguments.length > 0;
}

function commandName(c: ts.CallExpression): string {
  return (c.arguments[0] as ts.StringLiteralLike).text.trim().split(/\s+/)[0];
}

/** The declaration `name` refers to at `from`, by lexical scope. */
function lookup(name: string, from: ts.Node): ts.VariableDeclaration | ts.ParameterDeclaration | undefined {
  for (let p: ts.Node | undefined = from.parent; p; p = p.parent) {
    const statements = (p as { statements?: ts.NodeArray<ts.Statement> }).statements;
    if (statements) {
      for (const s of statements) {
        if (!ts.isVariableStatement(s)) continue;
        for (const d of s.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === name) return d;
        }
      }
    }
    if (ts.isFunctionLike(p)) {
      for (const prm of p.parameters) if (ts.isIdentifier(prm.name) && prm.name.text === name) return prm;
    }
  }
  return undefined;
}

/** The command path an expression evaluates to: [] for the root program, null if unknown. */
function pathOf(e: ts.Expression): string[] | null {
  e = unwrap(e);
  if (ts.isIdentifier(e)) {
    const d = lookup(e.text, e);
    // `register(program: Command)` in every command module receives the root.
    if (!d || ts.isParameter(d)) return e.text === "program" ? [] : null;
    return d.initializer ? pathOf(d.initializer) : null;
  }
  if (ts.isNewExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "Command") return [];
  if (isCommandCall(e)) {
    const base = pathOf((e.expression as ts.PropertyAccessExpression).expression);
    return base === null ? null : [...base, commandName(e)];
  }
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) return pathOf(e.expression.expression);
  if (isWrapperCall(e)) return pathOf(e.arguments[0]);
  return null;
}

function chainsIn(sf: ts.SourceFile, registry: Registry): { chains: Chain[]; unresolved: string[] } {
  const chains: Chain[] = [];
  const unresolved: string[] = [];
  const visit = (n: ts.Node): void => {
    if (isCommandCall(n)) {
      // Climb to the end of the chain: `.description().option().action()`, and
      // through a wrapper that returns the command it was given.
      let top: ts.Node = n;
      for (;;) {
        const p = top.parent;
        if (p && ts.isPropertyAccessExpression(p) && p.expression === top && ts.isCallExpression(p.parent) && p.parent.expression === p) {
          top = p.parent;
        } else if (p && isWrapperCall(p) && p.arguments[0] === top) {
          top = p;
        } else break;
      }
      const receiver = (n.expression as ts.PropertyAccessExpression).expression;
      const base = pathOf(receiver);
      const path = base === null ? null : [...base, commandName(n)].join(" ");
      if (path === null || !registry.has(path)) {
        unresolved.push(`${sf.fileName}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} (${path ?? "?"})`);
      }
      chains.push({
        start: top.getStart(),
        end: top.getEnd(),
        receiverStart: receiver.getStart(),
        receiverEnd: receiver.getEnd(),
        path: path !== null && registry.has(path) ? path : null,
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { chains, unresolved };
}

function moduleFacts(file: string, text: string, registry: Registry): ModuleFacts {
  const { chains, unresolved } = chainsIn(parse(file, text), registry);
  return { commands: [...new Set(chains.map((c) => c.path).filter((p): p is string => p !== null))], unresolved };
}

/** The literal's text, with `${…}` standing in for each substitution. */
function literalText(n: ts.Node): string | undefined {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s) => "${…}" + s.literal.text).join("");
  return undefined;
}

function isFlagDeclaration(n: ts.Node): boolean {
  const p = n.parent;
  if (!ts.isCallExpression(p) || !ts.isPropertyAccessExpression(p.expression)) return false;
  const method = p.expression.name.text;
  if (method === "option" || method === "requiredOption") return p.arguments[0] === n;
  if (method === "version") return p.arguments[1] === n;
  return false;
}

/** A mention's words: the first one, then each `[ \t]+word` that follows it, and where they end. */
function wordsFrom(text: string, first: string, firstEnd: number): { words: string[]; end: number } {
  const words = [first];
  let end = firstEnd;
  for (;;) {
    NEXT_WORD.lastIndex = end;
    const m = NEXT_WORD.exec(text);
    if (!m) break;
    words.push(m[1]);
    end = NEXT_WORD.lastIndex;
  }
  return { words, end };
}

/** Longest registered command path at the start of `parts`. */
function resolveWords(parts: string[], registry: Registry): string | null {
  for (let k = parts.length; k >= 1; k--) {
    const p = parts.slice(0, k).join(" ");
    if (registry.has(p)) return p;
  }
  return null;
}

type Mention = { start: number; end: number; command: string | null /* null = another program */ };

function mentionsIn(text: string, registry: Registry): Mention[] {
  const out: Mention[] = [];
  const spanEnd = (from: number): number => {
    MENTION_END.lastIndex = from;
    const m = MENTION_END.exec(text);
    return m ? m.index : text.length;
  };
  // Each search resumes after the whole command text, as one match over all
  // its words would.
  FLAIR_MENTION.lastIndex = 0;
  for (let m = FLAIR_MENTION.exec(text); m !== null; m = FLAIR_MENTION.exec(text)) {
    const { words, end } = wordsFrom(text, m[1], m.index + m[0].length);
    FLAIR_MENTION.lastIndex = end;
    const command = resolveWords(words, registry);
    if (command !== null) out.push({ start: m.index, end: spanEnd(end), command });
  }
  BACKTICK_MENTION.lastIndex = 0;
  for (let m = BACKTICK_MENTION.exec(text); m !== null; m = BACKTICK_MENTION.exec(text)) {
    const { words, end } = wordsFrom(text, m[1], m.index + m[0].length);
    BACKTICK_MENTION.lastIndex = end;
    const command = resolveWords(words, registry);
    if (command !== null) out.push({ start: m.index + 1, end: spanEnd(m.index + 1), command });
  }
  // A tool name counts only as a whole word: the characters on both sides of
  // it are not word characters (a regex `\b<tool>\b`, without building one).
  for (const { tool } of FOREIGN_TOOLS) {
    let i = text.indexOf(tool);
    while (i !== -1) {
      const whole = !WORD_CHAR.test(text[i - 1] ?? "") && !WORD_CHAR.test(text[i + tool.length] ?? "");
      if (whole) out.push({ start: i, end: spanEnd(i + tool.length), command: null });
      i = text.indexOf(tool, whole ? i + tool.length : i + 1);
    }
  }
  return out;
}

interface ScanScope {
  registry: Registry;
  /** Commands a literal outside any chain is checked against (tiers c–e). */
  fallback: string[];
}

function scanSource(file: string, text: string, scope: ScanScope): { findings: Finding[]; checked: number } {
  const { registry } = scope;
  const sf = parse(file, text);
  const { chains } = chainsIn(sf, registry);
  const findings: Finding[] = [];
  let checked = 0;
  const accepts = (paths: string[], flag: string): boolean => paths.some((p) => registry.get(p)?.has(flag));

  const visit = (n: ts.Node): void => {
    const lit = literalText(n);
    if (lit === undefined) {
      ts.forEachChild(n, visit);
      return;
    }
    if (ts.isTemplateExpression(n)) n.templateSpans.forEach((s) => visit(s.expression));
    if (isFlagDeclaration(n) || BARE_FLAG.test(lit.trim())) return;

    const at = n.getStart();
    const chain = chains
      .filter((c) => c.path !== null && at >= c.start && at < c.end && !(at >= c.receiverStart && at < c.receiverEnd))
      .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
    const lexical = chain ? [chain.path!] : scope.fallback;
    const mentions = mentionsIn(lit, registry);

    for (const m of lit.matchAll(FLAG_TOKEN)) {
      const i = m.index!;
      const flag = m[0];
      const mention = mentions.filter((x) => x.start <= i && i < x.end).sort((a, b) => b.start - a.start)[0];
      if (mention && mention.command === null) continue; // another program's flag
      checked++;
      const against = mention ? [mention.command!] : lexical;
      if (accepts(against, flag)) continue;
      findings.push({
        file,
        line: sf.getLineAndCharacterOfPosition(at).line + 1,
        flag,
        context: mention ? mention.command! : chain ? chain.path! : "*",
        literal: lit,
        checkedAgainst: against.length === 1 ? `flair ${against[0]}`.trim() : `${against.length} commands in reach`,
        excerpt: lit.slice(Math.max(0, i - 70), i + 50).replace(/\s+/g, " "),
      });
    }
  };
  visit(sf);
  return { findings, checked };
}

// ─── The tree ──────────────────────────────────────────────────────────────

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...srcFiles(full));
    else if (/\.(ts|cts|mts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out.sort();
}

/** Relative module specifiers a file imports (static, re-export, dynamic, require), resolved to src files. */
function importsOf(file: string, text: string, known: Set<string>): string[] {
  const specs: string[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      specs.push(n.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(n)
      && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))
      && n.arguments.length > 0
      && ts.isStringLiteralLike(n.arguments[0])
    ) {
      specs.push(n.arguments[0].text);
    }
    ts.forEachChild(n, visit);
  };
  visit(parse(file, text));
  const out: string[] = [];
  for (const spec of specs) {
    if (!spec.startsWith(".")) continue;
    const base = resolve(dirname(file), spec);
    const candidates = [
      base,
      base.replace(/\.js$/, ".ts"),
      base.replace(/\.cjs$/, ".cts"),
      base.replace(/\.mjs$/, ".mts"),
      `${base}.ts`,
      join(base, "index.ts"),
    ];
    const hit = candidates.find((c) => known.has(c));
    if (hit) out.push(hit);
  }
  return out;
}

interface TreeScan {
  findings: Finding[];
  /** Tiers c–e for one src file (repo-relative path). */
  fallbackFor: (rel: string) => string[];
  unresolved: string[];
  commandsCovered: Set<string>;
  filesScanned: number;
  flagsChecked: number;
}

function scanTree(registry: Registry): TreeScan {
  const files = srcFiles(SRC_DIR);
  const known = new Set(files);
  const text = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
  const facts = new Map(files.map((f) => [f, moduleFacts(relative(REPO, f), text.get(f)!, registry)]));
  const importers = new Map<string, string[]>();
  for (const f of files) {
    for (const dep of importsOf(f, text.get(f)!, known)) importers.set(dep, [...(importers.get(dep) ?? []), f]);
  }
  const everyCommand = [...registry.keys()];

  const fallbackOf = (f: string): string[] => {
    const own = facts.get(f)!.commands;
    if (own.length > 0) return own;
    const reached = new Set<string>();
    const seen = new Set<string>([f]);
    const queue = [...(importers.get(f) ?? [])];
    while (queue.length > 0) {
      const g = queue.shift()!;
      if (seen.has(g)) continue;
      seen.add(g);
      const cmds = facts.get(g)!.commands;
      if (cmds.length > 0) cmds.forEach((c) => reached.add(c));
      else queue.push(...(importers.get(g) ?? []));
    }
    return reached.size > 0 ? [...reached] : everyCommand;
  };

  const findings: Finding[] = [];
  const unresolved: string[] = [];
  const commandsCovered = new Set<string>();
  let flagsChecked = 0;
  for (const f of files) {
    const rel = relative(REPO, f);
    facts.get(f)!.unresolved.forEach((u) => unresolved.push(u));
    facts.get(f)!.commands.forEach((c) => commandsCovered.add(c));
    const scanned = scanSource(rel, text.get(f)!, { registry, fallback: fallbackOf(f) });
    findings.push(...scanned.findings);
    flagsChecked += scanned.checked;
  }
  return {
    findings,
    fallbackFor: (rel) => fallbackOf(join(REPO, rel)),
    unresolved,
    commandsCovered,
    filesScanned: files.length,
    flagsChecked,
  };
}

function describeFindings(fs: Finding[]): string {
  return fs
    .map((f) => `  ${f.file}:${f.line}  ${f.flag} is not declared by ${f.checkedAgainst}\n      «${f.excerpt}»`)
    .join("\n");
}

// ─── The rule, on a synthetic tree ─────────────────────────────────────────

describe("flair#2116 — the rule, on a synthetic tree", () => {
  const root = new Command();
  root.name("flair").option("--verbose");
  const grp = root.command("grp");
  grp.command("one").option("--alpha <v>").option("--no-beta");
  grp.command("two").option("--gamma");
  const reg = buildRegistry(root);
  const scan = (body: string): string[] =>
    scanSource("synthetic.ts", body, { registry: reg, fallback: ["grp one", "grp two"] }).findings.map((f) => f.flag);

  const chainSrc = (message: string): string => `
    export function register(program) {
      const grp = program.command("grp");
      grp.command("one").option("--alpha <v>").option("--no-beta").action(() => {
        console.error(${JSON.stringify(message)});
      });
    }`;

  test("the registry holds own, inherited and built-in flags", () => {
    expect([...reg.get("grp one")!].sort()).toEqual(["--alpha", "--help", "--no-beta", "--verbose"]);
    expect(reg.get("grp two")!.has("--alpha")).toBe(false);
  });

  test("a declared flag passes; an undeclared one is found (positive control)", () => {
    expect(scan(chainSrc("pass --alpha <v> or --no-beta"))).toEqual([]);
    expect(scan(chainSrc("pass --alpha-file <path>"))).toEqual(["--alpha-file"]);
  });

  test("an ancestor's option and commander's --help count as the command's", () => {
    expect(scan(chainSrc("re-run with --verbose, or see --help"))).toEqual([]);
  });

  test("the chain is the command: another command's flag in this action is found", () => {
    expect(scan(chainSrc("pass --gamma"))).toEqual(["--gamma"]);
  });

  test("a mention switches the command for the flags after it, up to the end of that command text", () => {
    expect(scan(chainSrc("run `flair grp two --gamma` first"))).toEqual([]);
    expect(scan(chainSrc("see `grp two --gamma`"))).toEqual([]);
    // The backtick closes the mention; --gamma is back in `grp one`'s context.
    expect(scan(chainSrc("run `flair grp two` then pass --gamma"))).toEqual(["--gamma"]);
    expect(scan(chainSrc("run flair grp two --alpha"))).toEqual(["--alpha"]);
  });

  test("another program's flags are not flair's", () => {
    expect(scan(chainSrc("Run: systemctl --user daemon-reload"))).toEqual([]);
    expect(scan(chainSrc("Run: npm --user"))).toEqual(["--user"]);
    // A tool name counts only as a whole word.
    expect(scan(chainSrc("Run: xsystemctl --user"))).toEqual(["--user"]);
  });

  test("declarations and bare single-flag literals are not prose", () => {
    expect(scan(`program.command("grp").command("two").option("--undeclared-looking <x>", "help text")`)).toEqual([]);
    expect(scan(`spawn("systemctl", ["--user", "--omit=dev"]);`)).toEqual([]);
    expect(scan(`program.command("grp").command("two").option("--gamma", "see --nope")`)).toEqual(["--nope"]);
  });

  test("outside a chain, the fallback commands decide", () => {
    expect(scan(`export const hint = "pass --alpha or --gamma";`)).toEqual([]);
    expect(scan(`export const hint = "pass --delta";`)).toEqual(["--delta"]);
  });

  test("comments are not prose", () => {
    expect(scan(`// pass --delta\n/* --epsilon */\nexport const x = 1;`)).toEqual([]);
  });

  test("template literals are read whole, substitutions included", () => {
    expect(scan("export const t = (x) => `pass --alpha ${x} and --delta`;")).toEqual(["--delta"]);
  });
});

// ─── The tree ──────────────────────────────────────────────────────────────

describe("flair#2116 — flags named in src/ literals are declared by the command they are checked against", () => {
  const registry = buildRegistry(program);
  const tree = scanTree(registry);

  test("the walk covers the CLI (guard the guard)", () => {
    expect(registry.size).toBeGreaterThan(100);
    expect(tree.filesScanned).toBeGreaterThan(100);
    expect(tree.flagsChecked).toBeGreaterThan(500);
    expect(registry.get("mcp enable")!.has("--admin-pass")).toBe(true);
  });

  test("every .command() call resolves to a registered command", () => {
    expect(tree.unresolved).toEqual([]);
  });

  test("every registered command's registration was found in src/", () => {
    const missing = [...registry.keys()].filter((p) => p !== "" && !tree.commandsCovered.has(p));
    expect(missing).toEqual([]);
  });

  test("every OTHER_COMMAND_REFERENCES entry names a command that declares the flag", () => {
    for (const r of OTHER_COMMAND_REFERENCES) {
      expect(`${r.command} ${r.flag}: ${registry.get(r.command)?.has(r.flag) ?? "no such command"}`).toBe(`${r.command} ${r.flag}: true`);
    }
  });

  test("exemptions are one-to-one: each matches exactly one finding, and no finding matches more than one", () => {
    expect(applyExemptions(tree.findings, EXEMPTIONS).problems).toEqual([]);
  });

  test("no scanned flag is undeclared by the command it is checked against, apart from the exempted findings", () => {
    const { unexempted } = applyExemptions(tree.findings, EXEMPTIONS);
    if (unexempted.length > 0) {
      throw new Error(
        `${unexempted.length} flag(s) named in messages are not declared by the command they are checked against:\n`
          + `${describeFindings(unexempted)}\n`
          + "Name a flag the command has, or a mention (`flair <command> --flag`) if it is another command's. "
          + "Another program's flags go on FOREIGN_TOOLS with a reason.",
      );
    }
  });

  // Exemptions bind to one finding each. A second message naming an exempted
  // flag in the same file must fail, whether it copies the original literal
  // exactly (the entry then matches two findings) or words it differently (a
  // finding no entry covers). The unmutated file is the control.
  // flair#2124: the deploy next-steps example must name only flags `agent add`
  // declares, and carry the positional agent id (the exemption that used to
  // cover this line is gone, so the message-flags check owns it now).
  test("flair#2124: the deploy next-steps example names only flags `agent add` declares", () => {
    const line = readFileSync(join(REPO, "src/commands/deploy.ts"), "utf8")
      .split("\n")
      .find((l) => l.includes("flair agent add"));
    expect(line).toBeTruthy();
    expect(line!).toMatch(/flair agent add [^\s-]\S*\s+--target /);
    const accepted = registry.get("agent add");
    expect(accepted).toBeTruthy();
    for (const flag of line!.match(FLAG_TOKEN) ?? []) expect(accepted!.has(flag)).toBe(true);
  });

  // A mutation run against the real sources: one bogus flag put back into one
  // message must be found, in the command it belongs to; the unmutated file is
  // the control. One row per tier that #2116's strings sat in.
  const mutationRows: Array<{ file: string; from: string; to: string; expected: string }> = [
    {
      // tier b — `mcp enable`'s own action (#2116's --admin-pass-file sat here).
      file: "src/commands/mcp.ts",
      from: "Error: --instance is required (or set FLAIR_URL) — `flair mcp enable`",
      to: "Error: --instance-url is required (or set FLAIR_URL) — `flair mcp enable`",
      expected: "--instance-url → flair mcp enable",
    },
    {
      // tier d — the enable library, reached through the `mcp` module (#2116's --ops-url sat here).
      file: "src/lib/mcp-enable.ts",
      from: "Environment, then re-run with --confirm-secrets-applied.",
      to: "Environment, then re-run with --confirm-secrets-applied-now.",
      expected: "--confirm-secrets-applied-now → 8 commands in reach",
    },
  ];
  for (const row of mutationRows) {
    test(`mutation: a bogus flag put back into ${row.file} is found`, () => {
      const original = readFileSync(join(REPO, row.file), "utf8");
      expect(original.split(row.from)).toHaveLength(2); // the anchor exists, once
      const scope = { registry, fallback: tree.fallbackFor(row.file) };
      expect(scanSource(row.file, original, scope).findings).toEqual([]);
      const found = scanSource(row.file, original.replace(row.from, row.to), scope).findings;
      expect(found.map((f) => `${f.flag} → ${f.checkedAgainst}`)).toEqual([row.expected]);
    });
  }
});
