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
import {
  findSpawnCalls,
  maskComments,
  maskJsxText,
  maskLiteralsAndComments,
  scanTree,
  topLevelArgs,
} from "../../scripts/ci/check-cli-spawn-budgets.mjs";

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
        expect(positionAt(src, fileName, src.indexOf("omega")).line).toBeGreaterThan(positionAt(src, fileName, src.indexOf("alpha")).line);
        expect(positionAt(masked, fileName, index)).toEqual(original);
      });
    }
  }
});

describe("literal text keeps the U+2028 and U+2029 line breaks (flair#2808)", () => {
  for (const sep of SEPARATORS) {
    it(`keeps ${SEPARATOR_NAMES[sep]} inside a string literal (.ts)`, () => {
      const src = `const label = "alpha${sep}omega";\nconst after = 1;\n`;
      const fileName = "fixture.ts";
      const masked = maskLiteralsAndComments(src, fileName);
      expect(masked.length).toBe(src.length);
      const index = src.indexOf("after");
      const original = positionAt(src, fileName, index);
      expect(positionAt(src, fileName, src.indexOf("omega")).line).toBeGreaterThan(positionAt(src, fileName, src.indexOf("alpha")).line);
      expect(positionAt(masked, fileName, index)).toEqual(original);
    });
  }
});

// The three line terminators besides \n, listed here rather than read from the gate.
const TERMINATORS = ["\r", "\u2028", "\u2029"] as const;
const TERMINATOR_NAMES: Record<string, string> = { "\r": "CR", "\u2028": "U+2028", "\u2029": "U+2029" };

// A line comment, a const options object, a multi-line helper with an inner
// `{}`, a one-line helper, an arrow helper, a division read as a possible regex
// start, and a call followed by a block on the next line.
const LINE_BREAK_FIXTURE = `import { test } from "bun:test";
// a comment line
const opts = { env: {} };
function runCli() {
  const o = {};
  return Bun.spawn(["bun", "src/cli.ts"], opts);
}
function once() { return Bun.spawn(["bun", "src/cli.ts"], {}); }
const viaArrow = () => void Bun.spawn(["bun", "src/cli.ts"], {});
test("calls a helper", () => {
  runCli();
});
test("calls a one-line helper", () => {
  once();
});
test("calls an arrow helper", () => {
  viaArrow();
});
test("divides before a call", () => {
  let a = 1;
  const n = a++ / 2;
  void f(a / 2, n);
  Bun.spawn(["bun", "src/cli.ts"], {});
});
test("calls fetch before a block", async () => {
  Bun.spawn(["bun", "src/cli.ts"], { timeout: 1000 });
  await 0;
  fetch("http://127.0.0.1:1")
  {
  }
}, 30_000);
`;

const LINE_BREAK_FIXTURE_OFFENDERS = {
  spawn: [
    ["spawn-no-timeout", "runCli"],
    ["spawn-no-timeout", "once"],
    ["spawn-no-timeout", "viaArrow"],
    ["spawn-no-timeout", "divides before a call"],
  ],
  cases: [
    ["case-no-budget", "calls a helper"],
    ["case-no-budget", "calls a one-line helper"],
    ["case-no-budget", "calls an arrow helper"],
    ["case-no-budget", "divides before a call"],
    ["case-unbounded-fetch", "calls fetch before a block"],
  ],
};

function offenderSummary(result: ReturnType<typeof scanTree>) {
  return {
    spawn: result.spawnOffenders.map((o) => [o.kind, o.scope]),
    cases: result.caseOffenders.map((o) => [o.kind, o.scope]),
  };
}

describe("the comment masker and the line walks keep CR, U+2028 and U+2029 (flair#2808)", () => {
  for (const t of TERMINATORS) {
    it(`finds a case after a // comment ended by ${TERMINATOR_NAMES[t]}`, () => {
      const src = `import { test } from "bun:test";\n// note${t}test("after the comment", () => {\n  Bun.spawn(["bun", "src/cli.ts"], {});\n});\n`;
      const { caseOffenders } = scanFixture("line-comment.test.ts", src);
      expect(caseOffenders.map((o) => [o.kind, o.scope])).toEqual([["case-no-budget", "after the comment"]]);
    });

    it(`keeps ${TERMINATOR_NAMES[t]} inside a block comment`, () => {
      const src = `/* alpha${t}omega */\nconst p = Bun.spawn(["bun", "src/cli.ts"], {});\n`;
      const fileName = "fixture.ts";
      const masked = maskComments(src);
      expect(masked.length).toBe(src.length);
      expect(positionAt(src, fileName, src.indexOf("omega")).line).toBeGreaterThan(positionAt(src, fileName, src.indexOf("alpha")).line);
      const index = src.indexOf("Bun.spawn");
      expect(positionAt(masked, fileName, index)).toEqual(positionAt(src, fileName, index));
    });

    it(`ends a // comment at ${TERMINATOR_NAMES[t]} in an argument walk`, () => {
      expect(topLevelArgs(`f(a, // note${t} b)`, 1)?.spans.length).toBe(2);
    });

    it(`scans a file whose line breaks are all ${TERMINATOR_NAMES[t]} as it scans the \\n file`, () => {
      const lf = scanFixture("line-breaks.test.ts", LINE_BREAK_FIXTURE);
      expect(offenderSummary(lf)).toEqual(LINE_BREAK_FIXTURE_OFFENDERS);
      const other = scanFixture("line-breaks.test.ts", LINE_BREAK_FIXTURE.replaceAll("\n", t));
      expect(other.spawnOffenders).toEqual(lf.spawnOffenders);
      expect(other.caseOffenders).toEqual(lf.caseOffenders);
    });
  }
});
