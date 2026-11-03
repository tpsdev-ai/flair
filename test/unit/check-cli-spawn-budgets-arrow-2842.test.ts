// check-cli-spawn-budgets-arrow-2842.test.ts — the spawn-budget gate attributes
// a spawn in a directly assigned, unannotated variable arrow with simple parameters
// to that arrow (flair#2842), however the body is laid out: on the `=>` line, on the next
// line, or parenthesized across lines. It also reports a case's line as the
// line its `test(`/`it(` starts on.
// Each fixture is written to a real `test/` tree and scanned through `scanTree`,
// so the gate sees the same file name (and therefore the same TypeScript script
// kind) as a test file.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { scanTree } from "../../scripts/ci/check-cli-spawn-budgets.mjs";

let dirs: string[] = [];

beforeEach(() => {
  dirs = [];
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

/** Write one fixture under a fresh tree's `test/` and scan the tree. */
function scanFixture(fileName: string, source: string) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  expect((sf as any).parseDiagnostics.length).toBe(0);
  const dir = mkdtempSync(join(tmpdir(), "spawn-arrow-2842-"));
  dirs.push(dir);
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "test", fileName), source, "utf8");
  return scanTree(dir);
}

// The arrow's body starts with the spawn itself.
const EXPRESSION_ARROW_FIXTURE = `import { test } from "bun:test";

const f = () => Bun.spawn(["bun", "src/cli.ts"]);

test("calls an expression-bodied arrow", () => {
  f();
});
`;

// The same helper written with a block body.
const BLOCK_ARROW_FIXTURE = `import { test } from "bun:test";

const f = () => {
  return Bun.spawn(["bun", "src/cli.ts"]);
};

test("calls a block-bodied arrow", () => {
  f();
});
`;

// The same helper with its body on the line after the `=>`.
const NEXT_LINE_ARROW_FIXTURE = `import { test } from "bun:test";

const f = () =>
  Bun.spawn(["bun", "src/cli.ts"]);

test("calls a next-line arrow", () => {
  f();
});
`;

// The same helper with a parenthesized body spanning lines.
const PARENTHESIZED_ARROW_FIXTURE = `import { test } from "bun:test";

const f = () => (
  Bun.spawn(["bun", "src/cli.ts"])
);

test("calls a parenthesized arrow", () => {
  f();
});
`;

// The same helper with a `void` expression before the spawn.
const VOID_ARROW_FIXTURE = `import { test } from "bun:test";

const f = () => void Bun.spawn(["bun", "src/cli.ts"]);

test("calls a void arrow", () => {
  f();
});
`;

describe("a spawn in a directly assigned, unannotated variable arrow with simple parameters belongs to it (flair#2842)", () => {
  it("attributes a same-line spawn to the arrow and reports the case that calls it", () => {
    const { spawnOffenders, caseOffenders } = scanFixture("arrow-expression.test.ts", EXPRESSION_ARROW_FIXTURE);
    expect(spawnOffenders.map((o) => [o.kind, o.scope])).toEqual([["spawn-no-timeout", "f"]]);
    expect(caseOffenders.map((o) => [o.kind, o.scope])).toEqual([["case-no-budget", "calls an expression-bodied arrow"]]);
  });

  it("attributes a next-line spawn to the arrow and reports the case that calls it", () => {
    const { spawnOffenders, caseOffenders } = scanFixture("arrow-next-line.test.ts", NEXT_LINE_ARROW_FIXTURE);
    expect(spawnOffenders.map((o) => [o.kind, o.scope])).toEqual([["spawn-no-timeout", "f"]]);
    expect(caseOffenders.map((o) => [o.kind, o.scope])).toEqual([["case-no-budget", "calls a next-line arrow"]]);
  });

  it("attributes a parenthesized multi-line spawn to the arrow and reports the case that calls it", () => {
    const { spawnOffenders, caseOffenders } = scanFixture("arrow-parenthesized.test.ts", PARENTHESIZED_ARROW_FIXTURE);
    expect(spawnOffenders.map((o) => [o.kind, o.scope])).toEqual([["spawn-no-timeout", "f"]]);
    expect(caseOffenders.map((o) => [o.kind, o.scope])).toEqual([["case-no-budget", "calls a parenthesized arrow"]]);
  });

  it("still attributes a block-bodied arrow's spawn", () => {
    const { spawnOffenders, caseOffenders } = scanFixture("arrow-block.test.ts", BLOCK_ARROW_FIXTURE);
    expect(spawnOffenders.map((o) => [o.kind, o.scope])).toEqual([["spawn-no-timeout", "f"]]);
    expect(caseOffenders.map((o) => [o.kind, o.scope])).toEqual([["case-no-budget", "calls a block-bodied arrow"]]);
  });

  it("still attributes a spawn after `() => void`", () => {
    const { spawnOffenders, caseOffenders } = scanFixture("arrow-void.test.ts", VOID_ARROW_FIXTURE);
    expect(spawnOffenders.map((o) => [o.kind, o.scope])).toEqual([["spawn-no-timeout", "f"]]);
    expect(caseOffenders.map((o) => [o.kind, o.scope])).toEqual([["case-no-budget", "calls a void arrow"]]);
  });
});

describe("a case's line is the line its test(/it( starts on (flair#2842)", () => {
  it("reports the line of the `test(` token, not the line before it", () => {
    const source = `import { test } from "bun:test";\n\ntest("starts its own line", () => {\n  Bun.spawn(["bun", "src/cli.ts"], {});\n});\n`;
    const { caseOffenders } = scanFixture("case-line.test.ts", source);
    expect(caseOffenders.map((o) => o.kind)).toEqual(["case-no-budget"]);
    const sf = ts.createSourceFile("case-line.test.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const line = sf.getLineAndCharacterOfPosition(source.indexOf('test("')).line + 1;
    expect(caseOffenders[0].line).toBe(line);
  });
});
