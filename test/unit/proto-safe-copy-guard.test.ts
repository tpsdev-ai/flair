/**
 * proto-safe-copy-guard.test.ts — the source scanner for flair#2235.
 *
 * Fails when source code copies an object's own keys into a PLAIN object
 * literal, the shapes that can lose or re-home an own `__proto__` key
 * (flair#2225, #2233):
 *
 *   - `Object.assign(<object literal>, …)`;
 *   - an own-key copy loop (`for … in`, or `for … of Object.keys(x)` /
 *     `Object.entries(x)`) that assigns `target[key] = …` where `target` starts
 *     as an object literal;
 *   - an object-literal spread `{ …x }` of a value that is a `JSON.parse`
 *     result.
 *
 * The remedy is src/lib/proto-safe-record.ts (protoSafeRecord). A site whose
 * source keys can never be `__proto__` is listed in ALLOWLIST below with a
 * reason; anything else must use the helper.
 *
 * Scanned: the root source tree (`src/`, `resources/`). The published packages
 * under `packages/*` are separate npm artifacts that cannot import a root
 * helper; they are out of scope for this guard.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** Root source trees this guard scans. */
export const SCAN_ROOTS = ["src", "resources"] as const;

export interface ProtoCopyHit {
  file: string;
  line: number;
  rule: "object-assign" | "own-key-loop" | "spread-json-parse";
  /** The offending expression's source text, used to key ALLOWLIST entries. */
  text: string;
}

/**
 * Sites whose copied keys can never be `__proto__`. Each entry is matched by
 * file + a substring of the offending expression, so a NEW copy in the same
 * file still fails the guard.
 */
export const ALLOWLIST: ReadonlyArray<{ file: string; contains: string; reason: string }> = [
  {
    file: "resources/Presence.ts",
    contains: "out[key] = record[key]",
    reason: "key is filtered through ROSTER_ALLOWLIST (a fixed set), so it cannot be `__proto__`",
  },
  {
    file: "resources/MemoryFeed.ts",
    contains: "request[option] = value",
    reason: "iterates SUBSCRIPTION_OPTIONS (a fixed set), not the caller object's keys",
  },
  {
    file: "src/lib/doctor-federation-driver.ts",
    contains: "out[key] = value",
    reason: "key is filtered to the FLAIR_FEDERATION_ prefix, so it cannot be `__proto__`",
  },
  {
    file: "src/commands/bridge.ts",
    contains: "pluginOpts[key] = process.env[spec.env]",
    reason: "key is a descriptor-declared option name and the value is a string, so it cannot set a prototype",
  },
];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(path));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

function propAccessName(node: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Object") {
    return node.name.text;
  }
  return null;
}

/** The `Object.keys(x)` / `Object.entries(x)` call behind a `for … of`. */
function ownKeyCall(expr: ts.Expression): ts.CallExpression | null {
  let e = expr;
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "sort") {
    e = e.expression.expression;
  }
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
    const name = propAccessName(e.expression);
    if (name === "keys" || name === "entries") return e;
  }
  return null;
}

/** Scan one source text and return its hits. */
export function detectProtoCopies(file: string, text: string): ProtoCopyHit[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits: ProtoCopyHit[] = [];
  const lineOf = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const initBy = new Map<string, ts.Expression>();
  const collectInits = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      initBy.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectInits);
  };
  collectInits(sf);

  const isJsonParse = (expr: ts.Expression): boolean => {
    let e = expr;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)
      && ts.isIdentifier(e.expression.expression) && e.expression.expression.text === "JSON"
      && e.expression.name.text === "parse") return true;
    if (ts.isConditionalExpression(e)) return isJsonParse(e.whenTrue) || isJsonParse(e.whenFalse);
    if (ts.isIdentifier(e) && initBy.has(e.text)) return isJsonParse(initBy.get(e.text)!);
    return false;
  };
  const isObjectLiteral = (expr: ts.Expression): boolean => ts.isObjectLiteralExpression(expr);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && propAccessName(node.expression) === "assign"
      && node.arguments.length >= 2 && isObjectLiteral(node.arguments[0])) {
      hits.push({ file, line: lineOf(node), rule: "object-assign", text: node.getText(sf) });
    }

    if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (ts.isSpreadAssignment(prop) && isJsonParse(prop.expression)) {
          hits.push({ file, line: lineOf(prop), rule: "spread-json-parse", text: prop.getText(sf) });
        }
      }
    }

    let loopStatement: ts.Statement | null = null;
    if (ts.isForInStatement(node)) loopStatement = node.statement;
    else if (ts.isForOfStatement(node) && ownKeyCall(node.expression)) loopStatement = node.statement;

    if (loopStatement) {
      const scanBody = (n: ts.Node): void => {
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && ts.isElementAccessExpression(n.left) && ts.isIdentifier(n.left.expression)) {
          const init = initBy.get(n.left.expression.text);
          if (init && isObjectLiteral(init)) {
            hits.push({ file, line: lineOf(n), rule: "own-key-loop", text: n.getText(sf) });
          }
        }
        ts.forEachChild(n, scanBody);
      };
      scanBody(loopStatement);
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/** Scan the whole tree this guard covers. */
export function detectTreeViolations(): ProtoCopyHit[] {
  const files = SCAN_ROOTS.flatMap((root) => listTsFiles(join(REPO_ROOT, root))).sort();
  const hits: ProtoCopyHit[] = [];
  for (const abs of files) {
    const rel = relative(REPO_ROOT, abs).split("\\").join("/");
    hits.push(...detectProtoCopies(rel, readFileSync(abs, "utf8")));
  }
  return hits;
}

function allowlisted(hit: ProtoCopyHit): boolean {
  return ALLOWLIST.some((entry) => entry.file === hit.file && hit.text.includes(entry.contains));
}

describe("proto-safe copy guard (flair#2235)", () => {
  test("no un-allowlisted plain-object copy of a source record's keys", () => {
    const hits = detectTreeViolations();
    const unexpected = hits.filter((hit) => !allowlisted(hit));
    if (unexpected.length > 0) {
      const lines = unexpected.map((h) => `  ${h.file}:${h.line} [${h.rule}] ${h.text.slice(0, 100)}`);
      throw new Error(
        `Plain-object copy of an untrusted record (use protoSafeRecord from src/lib/proto-safe-record.ts):\n${lines.join("\n")}`,
      );
    }
    expect(unexpected).toEqual([]);
  });

  test("every ALLOWLIST entry still matches a real hit (no stale entry)", () => {
    const hits = detectTreeViolations();
    const stale = ALLOWLIST.filter((entry) => !hits.some((h) => h.file === entry.file && h.text.includes(entry.contains)));
    expect(stale.map((s) => s.file)).toEqual([]);
  });

  test("fires on a planted Object.assign copy", () => {
    const planted = 'const copy = Object.assign({}, JSON.parse(input));';
    const hits = detectProtoCopies("planted.ts", planted);
    expect(hits.map((h) => h.rule)).toContain("object-assign");
  });

  test("fires on a planted own-key copy loop into {}", () => {
    const planted = "const out = {};\nfor (const key of Object.keys(src)) out[key] = src[key];";
    const hits = detectProtoCopies("planted.ts", planted);
    expect(hits.map((h) => h.rule)).toContain("own-key-loop");
  });

  test("fires on a planted spread of a JSON.parse value", () => {
    const planted = "const parsed = JSON.parse(input);\nconst copy = { ...parsed };";
    const hits = detectProtoCopies("planted.ts", planted);
    expect(hits.map((h) => h.rule)).toContain("spread-json-parse");
  });

  test("does not fire on the helper or on a null-prototype build", () => {
    const safe = [
      "const out = Object.create(null);",
      "for (const key of Object.keys(src)) out[key] = src[key];",
      "const merged = { ...existing, extra: 1 };",
    ].join("\n");
    expect(detectProtoCopies("safe.ts", safe)).toEqual([]);
  });
});
