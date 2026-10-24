// check-cli-spawn-budgets-jsx-2808.test.ts — JSX text is masked before the gate
// matches spawns and reads deadlines (flair#2808). Each fixture is written to a
// real `test/` tree and scanned through `scanTree`, so the gate sees the same
// file name (and therefore the same TypeScript script kind) as a test file. The
// gate masks JSX text in every file kind TypeScript parses JSX in and that it
// scans: .tsx and .jsx (ScriptKind.TSX / JSX) plus .js, .mjs and .cjs
// (ScriptKind.JS). Each JsxText node is masked from pos to end, every character
// except \n, \r, U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR)
// replaced by a space, so length and line/column positions stay aligned.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { findSpawnCalls, maskJsxText, maskLiteralsAndComments, scanTree } from "../../scripts/ci/check-cli-spawn-budgets.mjs";

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

/** The script kind the gate parses a file name with. */
function scriptKindFor(fileName: string): ts.ScriptKind {
  const ext = fileName.split(".").pop()?.toLowerCase();
  if (ext === "tsx") return ts.ScriptKind.TSX;
  if (ext === "jsx") return ts.ScriptKind.JSX;
  if (ext === "js" || ext === "mjs" || ext === "cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** The fixture parses with the script kind its file name selects. */
function expectParses(source: string, fileName: string): void {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  expect((sf as any).parseDiagnostics.length).toBe(0);
}

/** TypeScript's line and character for `index`, parsed the way the gate parses `fileName`. */
function positionAt(source: string, fileName: string, index: number): ts.LineAndCharacter {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  return sf.getLineAndCharacterOfPosition(index);
}

// The two separators TypeScript's line map counts as a line break besides \n and \r.
const SEPARATORS = ["\u2028", "\u2029"] as const;
const SEPARATOR_NAMES: Record<string, string> = { "\u2028": "U+2028", "\u2029": "U+2029" };

/** Write one fixture under a fresh tree's `test/` and scan the tree. */
function scanFixture(fileName: string, source: string) {
  expectParses(source, fileName);
  const dir = mkdtempSync(join(tmpdir(), "spawn-jsx-2808-"));
  dirs.push(dir);
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "test", fileName), source, "utf8");
  return scanTree(dir);
}

// JSX text with an apostrophe, a brace expression and a `timeout: 5000` string;
// the options object holds the same prose, so an unmasked apostrophe breaks the
// spawn's own argument walk.
const OPTIONS_FIXTURE = `import { test, expect } from "bun:test";

test("jsx in options", () => {
  const label = <span title="it's a 'label' - timeout: 5000">It's {value} timeout: 5000</span>;
  const p = Bun.spawn(["bun", "src/cli.ts", "status"], {
    env: { LABEL: <span>it's {value} timeout: 5000</span> },
  });
  expect(label).toBeDefined();
});
`;

// The same prose in the case body, before the spawn; an unmasked apostrophe runs
// the case's bracket walk past its closing paren.
const CASE_FIXTURE = `import { test, expect } from "bun:test";

test("jsx in case", () => {
  const el = <p title="it's a 'label' - timeout: 5000">It's {value} timeout: 5000</p>;
  const p = Bun.spawn(["bun", "src/cli.ts"], {});
  expect(el).toBeDefined();
});
`;

// A bounded spawn whose options hold the same JSX prose: the deadline is still
// read from the inline literal.
const BOUNDED_FIXTURE = `import { test, expect } from "bun:test";

test("bounded beside jsx", () => {
  const p = Bun.spawn(["bun", "src/cli.ts"], {
    timeout: 5000,
    env: { LABEL: <span title="it's a 'label' - timeout: 5000">It's {value} timeout: 5000</span> },
  });
  expect(p).toBeDefined();
}, 30_000);
`;

// Every extension the gate scans in which TypeScript parses JSX.
const JSX_EXTENSIONS = ["tsx", "jsx", "js", "mjs", "cjs"] as const;

describe("JSX text is masked before matching (flair#2808)", () => {
  for (const ext of JSX_EXTENSIONS) {
    it(`reports an unbounded spawn whose options contain JSX text (.${ext})`, () => {
      const { spawnOffenders, caseOffenders } = scanFixture(`jsx-options.test.${ext}`, OPTIONS_FIXTURE);
      expect(spawnOffenders.map((o: any) => o.kind)).toEqual(["spawn-no-timeout"]);
      expect(caseOffenders.map((o: any) => o.kind)).toEqual(["case-no-budget"]);
    });

    it(`reports an unbounded spawn whose case contains JSX text (.${ext})`, () => {
      const { spawnOffenders, caseOffenders } = scanFixture(`jsx-case.test.${ext}`, CASE_FIXTURE);
      expect(spawnOffenders.map((o: any) => o.kind)).toEqual(["spawn-no-timeout"]);
      expect(caseOffenders.map((o: any) => o.kind)).toEqual(["case-no-budget"]);
    });

    it(`still reads a bounded inline-literal deadline beside JSX text (.${ext})`, () => {
      const { spawnOffenders } = scanFixture(`jsx-bounded.test.${ext}`, BOUNDED_FIXTURE);
      expect(spawnOffenders).toEqual([]);
      const calls = findSpawnCalls(BOUNDED_FIXTURE, `jsx-bounded.test.${ext}`).calls;
      expect(calls.length).toBe(1);
      expect(calls[0].timeoutMs).toBe(5000);
    });
  }
});

describe("JSX text masks exactly its own span (flair#2808)", () => {
  it("masks leading tabs and the whole text with spaces on a lone \\r", () => {
    const src = "const x=<p>\t hi\rtext</p>;";
    const masked = maskJsxText(src, "fixture.js");
    expect(masked).toBe("const x=<p>    \r    </p>;");
    expect(masked.length).toBe(src.length);
    expect(masked.replace(/[^\r\n]/g, "")).toBe(src.replace(/[^\r\n]/g, ""));
  });

  it("keeps a \\r\\n pair intact", () => {
    const src = "const y=<p>a\r\nb</p>;";
    const masked = maskJsxText(src, "fixture.mjs");
    expect(masked).toBe("const y=<p> \r\n </p>;");
    expect(masked.length).toBe(src.length);
    expect(masked.replace(/[^\r\n]/g, "")).toBe(src.replace(/[^\r\n]/g, ""));
  });

  for (const ext of ["tsx", "js"] as const) {
    for (const sep of SEPARATORS) {
      it(`keeps ${SEPARATOR_NAMES[sep]} inside JSX text (.${ext})`, () => {
        const src = `const el = <p>alpha${sep}omega</p>;\nconst after = 1;\n`;
        const fileName = `fixture.${ext}`;
        const masked = maskJsxText(src, fileName);
        expect(masked.length).toBe(src.length);
        const index = src.indexOf("after");
        const original = positionAt(src, fileName, index);
        expect(original.line).toBeGreaterThan(positionAt(src, fileName, src.indexOf("alpha")).line);
        expect(positionAt(masked, fileName, index)).toEqual(original);
      });
    }
  }
});

describe("literal text keeps every line break TypeScript counts (flair#2808)", () => {
  for (const sep of SEPARATORS) {
    it(`keeps ${SEPARATOR_NAMES[sep]} inside a string literal (.ts)`, () => {
      const src = `const label = "alpha${sep}omega";\nconst after = 1;\n`;
      const fileName = "fixture.ts";
      const masked = maskLiteralsAndComments(src, fileName);
      expect(masked.length).toBe(src.length);
      const index = src.indexOf("after");
      const original = positionAt(src, fileName, index);
      expect(original.line).toBeGreaterThan(positionAt(src, fileName, src.indexOf("alpha")).line);
      expect(positionAt(masked, fileName, index)).toEqual(original);
    });
  }
});
