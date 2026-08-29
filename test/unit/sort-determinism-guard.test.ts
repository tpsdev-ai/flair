/**
 * sort-determinism-guard.test.ts — AST guard for flair#1412 / flair#1415.
 *
 * Grep cannot tell a real `.sort` from a comment mentioning one, and cannot
 * see comparator shape. This walks the TypeScript AST and flags a `.sort()`
 * whose comparator is a single key with no `||` tie-break tail.
 *
 * Scoped ONLY to the paths this PR fixes. Shipping it repo-wide would fail
 * ~13 pre-existing display/admin sorts and bury the site that matters.
 * Widen the list as those follow-ups land.
 *
 * Opt-out (exact marker, not any comment): `// deterministic: key is unique`
 *
 * flair#1415 also pins the `_rank` push-site count in
 * semantic-retrieval-core.ts. Kern counted four; Sherlock counted three.
 * Current main has four (no-signal listing, candidate-union RRF, HNSW
 * embedding leg, keyword-only fallback). Adding or dropping a site must
 * fail this pin — do not re-derive the number from the file.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import type { RetrievalRankedRow } from "../../resources/semantic-retrieval-core.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** Paths this PR fixed. Do not widen here — that is the follow-up sweep. */
export const SCOPED_PATHS = [
  "resources/semantic-retrieval-core.ts",
  "packages/flair-bench/src/cosine.ts",
] as const;

const OPT_OUT = "deterministic: key is unique";

export type BareSortHit = { line: number; excerpt: string };

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) {
    e = e.expression;
  }
  return e;
}

function comparatorBody(fn: ts.ArrowFunction | ts.FunctionExpression): ts.Expression | undefined {
  if (!ts.isBlock(fn.body)) return fn.body;
  const returns = fn.body.statements.filter(ts.isReturnStatement);
  if (returns.length !== 1 || !returns[0].expression) return undefined;
  return returns[0].expression;
}

function isLocaleCompareCall(expr: ts.Expression): boolean {
  const e = unwrap(expr);
  return ts.isCallExpression(e)
    && ts.isPropertyAccessExpression(e.expression)
    && e.expression.name.text === "localeCompare";
}

/** `-1` / `0` / `1` — the leaves of `a < b ? -1 : a > b ? 1 : 0`. */
function isComparatorConstant(expr: ts.Expression): boolean {
  const e = unwrap(expr);
  if (ts.isNumericLiteral(e)) return true;
  return ts.isPrefixUnaryExpression(e)
    && (e.operator === ts.SyntaxKind.MinusToken || e.operator === ts.SyntaxKind.PlusToken)
    && ts.isNumericLiteral(e.operand);
}

function isSingleKeyComparator(expr: ts.Expression): boolean {
  const e = unwrap(expr);
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return false;
  }
  if (ts.isConditionalExpression(e)) {
    // `a.id < b.id ? -1 : a.id > b.id ? 1 : 0` is a single-key id compare.
    // Constants are valid LEAVES (the ±1/0 the comparator returns), not a
    // second key. A branch that itself has `||` is not single-key.
    const leaf = (x: ts.Expression) => isComparatorConstant(x) || isSingleKeyComparator(x);
    return leaf(e.whenTrue) && leaf(e.whenFalse) && isSingleKeyComparator(e.condition);
  }
  if (isLocaleCompareCall(e)) return true;
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    return op === ts.SyntaxKind.MinusToken
      || op === ts.SyntaxKind.LessThanToken
      || op === ts.SyntaxKind.GreaterThanToken
      || op === ts.SyntaxKind.LessThanEqualsToken
      || op === ts.SyntaxKind.GreaterThanEqualsToken;
  }
  return false;
}

function commentHasOptOut(text: string): boolean {
  return text.includes(OPT_OUT);
}

function nodeHasOptOut(sf: ts.SourceFile, node: ts.Node): boolean {
  const full = sf.getFullText();
  const ranges = [
    ...(ts.getLeadingCommentRanges(full, node.getFullStart()) ?? []),
    ...(ts.getTrailingCommentRanges(full, node.getEnd()) ?? []),
  ];
  // The statement containing the call (so a line-above comment counts).
  let stmt: ts.Node = node;
  while (stmt.parent && !ts.isSourceFile(stmt.parent) && !ts.isBlock(stmt.parent) && !ts.isSourceFile(stmt)) {
    if (ts.isExpressionStatement(stmt) || ts.isVariableStatement(stmt) || ts.isReturnStatement(stmt)) break;
    stmt = stmt.parent;
  }
  ranges.push(...(ts.getLeadingCommentRanges(full, stmt.getFullStart()) ?? []));
  if (ranges.some((r) => commentHasOptOut(full.slice(r.pos, r.end)))) return true;
  // Same-line trailing comment after the statement.
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
  const lineStart = sf.getPositionOfLineAndCharacter(line, 0);
  const nextLineStart = line + 1 < sf.getLineStarts().length
    ? sf.getLineStarts()[line + 1]!
    : full.length;
  return commentHasOptOut(full.slice(lineStart, nextLineStart));
}

export function findBareSingleKeySorts(filePath: string, source: string): BareSortHit[] {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits: BareSortHit[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "sort"
      && node.arguments.length >= 1) {
      const arg = node.arguments[0]!;
      if ((ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) {
        const body = comparatorBody(arg);
        if (body && isSingleKeyComparator(body) && !nodeHasOptOut(sf, node)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          hits.push({
            line: line + 1,
            excerpt: source.slice(node.getStart(sf), Math.min(node.getEnd(), node.getStart(sf) + 80)).replace(/\s+/g, " "),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function scanRepoFile(rel: string): BareSortHit[] {
  const abs = join(REPO_ROOT, rel);
  return findBareSingleKeySorts(rel, readFileSync(abs, "utf8"));
}

export type RankPushHit = { line: number; excerpt: string };

/**
 * Pinned count of `pushRanked` call sites in semantic-retrieval-core.ts
 * (flair#1415). Four on current main: no-signal listing, candidate-union
 * RRF, HNSW embedding leg, keyword-only fallback. A fifth (or a dropped)
 * site must fail CI rather than be re-counted by a reader.
 */
export const EXPECTED_RANK_PUSH_SITES = 4;

const RETRIEVAL_CORE = "resources/semantic-retrieval-core.ts";

function callExcerpt(sf: ts.SourceFile, source: string, node: ts.Node): string {
  return source.slice(node.getStart(sf), Math.min(node.getEnd(), node.getStart(sf) + 80)).replace(/\s+/g, " ");
}

/** Sites that supply `_rank` via `pushRanked(rows, row, rank)`. */
export function findPushRankedCalls(filePath: string, source: string): RankPushHit[] {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits: RankPushHit[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "pushRanked") {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      hits.push({ line: line + 1, excerpt: callExcerpt(sf, source, node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/**
 * Raw `results.push(...)` — a bypass of `pushRanked` that can omit `_rank`
 * because Harper rows are `any` and `...any` swallows a missing property.
 */
export function findResultsPushes(filePath: string, source: string): RankPushHit[] {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits: RankPushHit[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "push"
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === "results"
    ) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      hits.push({ line: line + 1, excerpt: callExcerpt(sf, source, node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/** Property / shorthand assignments of `_rank` (the helper's `{ ...row, _rank }`). */
export function findRankAssignments(filePath: string, source: string): RankPushHit[] {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits: RankPushHit[] = [];
  const visit = (node: ts.Node) => {
    const isAssign = ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node);
    if (isAssign && ts.isIdentifier(node.name) && node.name.text === "_rank") {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      hits.push({ line: line + 1, excerpt: callExcerpt(sf, source, node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

// Compile-time pin (flair#1415). Evaluated by `tsc -p tsconfig.test.check.json`.
// A row-shaped object that omits `_rank` must be a type error. If `_rank` is
// ever made optional, this unused `@ts-expect-error` fails CI.
// @ts-expect-error _rank is required on the internal retrieval row
const _rowOmittingRank: RetrievalRankedRow = { id: "x", createdAt: "2024-01-01T00:00:00.000Z" };
void _rowOmittingRank;

describe("sort-determinism guard scope (flair#1412)", () => {
  test("is scoped to the two paths this PR fixes — not repo-wide", () => {
    expect([...SCOPED_PATHS].sort()).toEqual([
      "packages/flair-bench/src/cosine.ts",
      "resources/semantic-retrieval-core.ts",
    ]);
    for (const p of SCOPED_PATHS) {
      expect(existsSync(join(REPO_ROOT, p))).toBe(true);
    }
  });

  test("the scoped paths have no bare single-key sort", () => {
    const hits = SCOPED_PATHS.flatMap((p) => scanRepoFile(p).map((h) => `${p}:${h.line} ${h.excerpt}`));
    expect(hits).toEqual([]);
  });
});

describe("sort-determinism guard detector", () => {
  test("FAILS on a newly added bare single-key sort", () => {
    const src = `
      const xs = [{ n: 1 }, { n: 2 }];
      xs.sort((a, b) => b.n - a.n);
    `;
    const hits = findBareSingleKeySorts("scratch.ts", src);
    expect(hits.length).toBe(1);
    expect(hits[0]!.excerpt).toContain("b.n - a.n");
  });

  test("FAILS on a bare localeCompare", () => {
    const src = `rows.sort((a, b) => a.ts.localeCompare(b.ts));`;
    expect(findBareSingleKeySorts("scratch.ts", src).length).toBe(1);
  });

  test("does not flag a comment that merely mentions .sort", () => {
    const src = `
      // rows.sort((a, b) => b.score - a.score)
      const x = 1;
    `;
    expect(findBareSingleKeySorts("scratch.ts", src)).toEqual([]);
  });

  test("passes when a || tie-break tail is present", () => {
    const src = `rows.sort((a, b) => (b._rank - a._rank) || byRecencyThenId(a, b));`;
    expect(findBareSingleKeySorts("scratch.ts", src)).toEqual([]);
  });

  test("FAILS on the classic a<b ? -1 : a>b ? 1 : 0 ternary (no || tail)", () => {
    // Constants are the comparator's return values, not a second key.
    // If this were not flagged, the opt-out test below would pass with the
    // marker removed and could not catch a broken opt-out path.
    const src = `names.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);`;
    const hits = findBareSingleKeySorts("scratch.ts", src);
    expect(hits.length).toBe(1);
    expect(hits[0]!.excerpt).toContain("a.name < b.name");
  });

  test("opt-out marker // deterministic: key is unique suppresses the flag", () => {
    const src = `
      // deterministic: key is unique
      names.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    `;
    expect(findBareSingleKeySorts("scratch.ts", src)).toEqual([]);
  });

  test("a generic comment is not an opt-out", () => {
    const src = `
      // this sort is fine, trust me
      xs.sort((a, b) => b.n - a.n);
    `;
    expect(findBareSingleKeySorts("scratch.ts", src).length).toBe(1);
  });
});

describe("retrieval _rank push-site pin (flair#1415)", () => {
  test(`semantic-retrieval-core.ts has exactly ${EXPECTED_RANK_PUSH_SITES} pushRanked sites`, () => {
    const src = readFileSync(join(REPO_ROOT, RETRIEVAL_CORE), "utf8");
    const hits = findPushRankedCalls(RETRIEVAL_CORE, src);
    expect(hits.map((h) => `${RETRIEVAL_CORE}:${h.line} ${h.excerpt}`)).toHaveLength(EXPECTED_RANK_PUSH_SITES);
    expect(hits).toHaveLength(EXPECTED_RANK_PUSH_SITES);
  });

  test("ranked rows cannot enter via raw results.push (would swallow a missing _rank)", () => {
    const src = readFileSync(join(REPO_ROOT, RETRIEVAL_CORE), "utf8");
    const hits = findResultsPushes(RETRIEVAL_CORE, src);
    expect(hits.map((h) => `${RETRIEVAL_CORE}:${h.line} ${h.excerpt}`)).toEqual([]);
  });

  test("the helper is the single _rank assignment site", () => {
    const src = readFileSync(join(REPO_ROOT, RETRIEVAL_CORE), "utf8");
    const hits = findRankAssignments(RETRIEVAL_CORE, src);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.excerpt).toContain("_rank");
  });

  test("FAILS when a new results.push bypasses pushRanked", () => {
    const src = `const results = []; results.push({ id: "x", _score: 1 });`;
    const hits = findResultsPushes("scratch.ts", src);
    expect(hits.length).toBe(1);
    expect(hits[0]!.excerpt).toContain("results.push");
  });

  test("finder counts each pushRanked call", () => {
    const src = `
      pushRanked(results, { id: "a" }, 1);
      pushRanked(results, { id: "b" }, 2);
      pushRanked(results, { id: "c" }, 3);
    `;
    expect(findPushRankedCalls("scratch.ts", src).length).toBe(3);
  });

  test("does not count a comment that merely mentions pushRanked or _rank", () => {
    const src = `
      // pushRanked(results, row, _rank)
      const x = 1;
    `;
    expect(findPushRankedCalls("scratch.ts", src)).toEqual([]);
    expect(findRankAssignments("scratch.ts", src)).toEqual([]);
    expect(findResultsPushes("scratch.ts", src)).toEqual([]);
  });
});
