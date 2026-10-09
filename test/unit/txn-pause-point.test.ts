/**
 * txn-pause-point.test.ts — flair#2307: the test-only pause inside an owned
 * transaction (resources/txn-pause-point.ts), claims an arm file and releases
 * on `go` or on its limit.
 * flair#2382 removes the shared union-list conflict; valid names keep their
 * pause behaviour, while malformed names throw before the gate.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { InvalidPausePointError, PAUSE_POINT_PATTERN, TEST_FAULT_INJECTION_ENV, TEST_PAUSE_DIR_ENV, txnPausePoint } from "../../resources/txn-pause-point.ts";

let dir: string;
const env = (overrides: Record<string, string | undefined> = {}) => ({
  [TEST_FAULT_INJECTION_ENV]: "1",
  [TEST_PAUSE_DIR_ENV]: dir,
  ...overrides,
}) as NodeJS.ProcessEnv;
const arm = () => writeFileSync(join(dir, "arm.supersede-close"), "");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flair-txn-pause-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it("logs filesystem refusals once", () => {
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    txnPausePoint("supersede-close", env({ [TEST_PAUSE_DIR_ENV]: "relative" }));
    txnPausePoint("supersede-close", env({ [TEST_PAUSE_DIR_ENV]: "relative" }));
    expect(warning.mock.calls.length).toBe(1);
  } finally {
    warning.mockRestore();
  }
});

describe("valid pause-point names are inert unless every condition holds", () => {
  it("no opt-in, a non-exact opt-in, or no pause dir → undefined, and the arm file is left alone", () => {
    arm();
    for (const e of [
      env({ [TEST_FAULT_INJECTION_ENV]: undefined }),
      env({ [TEST_FAULT_INJECTION_ENV]: "true" }),
      env({ [TEST_FAULT_INJECTION_ENV]: " 1" }),
      env({ [TEST_PAUSE_DIR_ENV]: undefined }),
      env({ [TEST_PAUSE_DIR_ENV]: "relative/dir" }),
      env({ [TEST_PAUSE_DIR_ENV]: "/" }),
    ]) {
      expect(txnPausePoint("supersede-close", e)).toBeUndefined();
    }
    expect(readdirSync(dir)).toEqual(["arm.supersede-close"]);
  });

  it("the production environment (neither variable set) → undefined", () => {
    expect(txnPausePoint("supersede-close", {} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("opted in but not armed → undefined, no file written", () => {
    expect(txnPausePoint("supersede-close", env())).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("an arm for another point does not pause this one", () => {
    writeFileSync(join(dir, "arm.embedding-stamp-content-suffix"), "");
    expect(txnPausePoint("supersede-close", env())).toBeUndefined();
  });
});

describe("an armed point releases on go or timeout", () => {
  it("claims the arm, marks paused, waits for go, and records the release", async () => {
    arm();
    const pause = txnPausePoint("supersede-close", env());
    expect(pause).toBeInstanceOf(Promise);
    expect(txnPausePoint("supersede-close", env())).toBeUndefined(); // the arm has been consumed
    let released = false;
    void pause!.then(() => { released = true; });
    await new Promise((r) => setTimeout(r, 100));
    expect(released).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(["claimed.supersede-close", "paused.supersede-close", "released.supersede-close"]);
    writeFileSync(join(dir, "go.supersede-close"), "");
    await pause;
    expect(readFileSync(join(dir, "released.supersede-close"), "utf8")).toBe("go");
  });

  it("releases itself at its limit and records a timeout", async () => {
    arm();
    const pause = txnPausePoint("supersede-close", env(), 60);
    await pause;
    expect(readFileSync(join(dir, "released.supersede-close"), "utf8")).toBe("timeout");
  });
});


describe("pause filesystem refusals", () => {
  it("refuses a symlinked directory", () => {
    arm();
    const link = join(dir, "alias");
    symlinkSync(dir, link);
    expect(txnPausePoint("supersede-close", env({ [TEST_PAUSE_DIR_ENV]: link }), 0)).toBeUndefined();
    expect(readFileSync(join(dir, "arm.supersede-close"), "utf8")).toBe("");
  });

  it("refuses a directory symlink that resolves outside the temp root", () => {
    arm();
    const saved = process.env.TMPDIR;
    const scopedTemp = mkdtempSync(join(dir, "scoped-"));
    const link = join(scopedTemp, "alias");
    symlinkSync(dir, link);
    process.env.TMPDIR = scopedTemp;
    try {
      expect(txnPausePoint("supersede-close", env({ [TEST_PAUSE_DIR_ENV]: link }), 0)).toBeUndefined();
      expect(readFileSync(join(dir, "arm.supersede-close"), "utf8")).toBe("");
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });

  it("refuses a directory whose owner differs from the current uid", () => {
    arm();
    const uid = process.getuid!();
    const uidSpy = spyOn(process, "getuid").mockReturnValue(uid + 1);
    try {
      expect(txnPausePoint("supersede-close", env(), 0)).toBeUndefined();
      expect(readdirSync(dir)).toEqual(["arm.supersede-close"]);
    } finally {
      uidSpy.mockRestore();
    }
  });

  for (const mode of [0o720, 0o702]) {
    it(`refuses directory write permissions ${mode.toString(8)}`, () => {
      arm();
      chmodSync(dir, mode);
      expect(txnPausePoint("supersede-close", env(), 0)).toBeUndefined();
      expect(readdirSync(dir)).toEqual(["arm.supersede-close"]);
    });
  }

  for (const marker of ["claimed", "paused", "released"]) {
    it(`refuses a pre-existing ${marker} marker`, () => {
      arm();
      const path = join(dir, `${marker}.supersede-close`);
      writeFileSync(path, "existing");
      expect(txnPausePoint("supersede-close", env(), 0)).toBeUndefined();
      expect(readFileSync(path, "utf8")).toBe("existing");
    });

    it(`refuses a symlink at the ${marker} marker path`, () => {
      arm();
      const target = join(dir, "marker-target");
      writeFileSync(target, "existing");
      symlinkSync(target, join(dir, `${marker}.supersede-close`));
      expect(txnPausePoint("supersede-close", env(), 0)).toBeUndefined();
      expect(readFileSync(target, "utf8")).toBe("existing");
    });
  }

});

describe("pause-point names (flair#2382)", () => {
  // The trees that may name a pause point. resources/ and src/ both compile
  // into the published dist/, so a name in either is a call site.
  const roots = ["resources", "src"].map((name) => fileURLToPath(new URL(`../../${name}`, import.meta.url)));

  function collectTs(source: string, found: string[] = []): string[] {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const full = join(source, entry.name);
      if (entry.isDirectory()) collectTs(full, found);
      else if (entry.name.endsWith(".ts")) found.push(full);
    }
    return found;
  }

  type Source = { file: string; text: string };

  function scanPausePoints(sources: Source[]): { name: string; where: string }[] {
    const calls: { name: string; where: string }[] = [];
    let forwardsProperty = false;
    let propertyCalls = 0;
    const add = (value: ts.Expression | undefined, where: string) => {
      if (!value || !(ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) {
        throw new Error(`unresolved pause point: ${where}`);
      }
      if (!PAUSE_POINT_PATTERN.test(value.text)) throw new Error(`malformed pause point: ${where}`);
      if (calls.some((call) => call.name === value.text)) throw new Error(`duplicate pause point: ${where}`);
      calls.push({ name: value.text, where });
    };
    for (const { file, text } of sources) {
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const pauseNames = new Set(["txnPausePoint"]);
      const deleteNames = new Set(["deleteOwnedRow"]);
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement)) continue;
        const bindings = statement.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) continue;
        for (const binding of bindings.elements) {
          const imported = (binding.propertyName ?? binding.name).text;
          if (imported === "txnPausePoint") pauseNames.add(binding.name.text);
          if (imported === "deleteOwnedRow") deleteNames.add(binding.name.text);
        }
      }
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && (pauseNames.has(node.text) || deleteNames.has(node.text))) {
          let reference: ts.Node = node;
          while (ts.isParenthesizedExpression(reference.parent) || ts.isAsExpression(reference.parent) ||
                 ts.isTypeAssertionExpression(reference.parent) || ts.isNonNullExpression(reference.parent) ||
                 ts.isSatisfiesExpression(reference.parent)) reference = reference.parent;
          const parent = reference.parent;
          if (!(ts.isCallExpression(parent) && parent.expression === reference) &&
              !ts.isImportSpecifier(parent) &&
              !(ts.isFunctionDeclaration(parent) && parent.name === reference)) {
            throw new Error(`unresolved pause point reference: ${file}:${node.getText(source)}`);
          }
        }
        if (ts.isCallExpression(node)) {
          let callee: ts.Expression = node.expression;
          while (ts.isParenthesizedExpression(callee) || ts.isAsExpression(callee) ||
                 ts.isTypeAssertionExpression(callee) || ts.isNonNullExpression(callee) ||
                 ts.isSatisfiesExpression(callee)) callee = callee.expression;
          const name = ts.isIdentifier(callee) ? callee.text
            : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
          const where = `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
          if (pauseNames.has(name)) {
            const argument = node.arguments[0];
            if (argument && ts.isPropertyAccessExpression(argument) &&
                ts.isIdentifier(argument.expression) && argument.expression.text === "spec" &&
                argument.name.text === "point") {
              let owner: ts.Node | undefined = node.parent;
              while (owner && !ts.isFunctionDeclaration(owner)) {
                if (ts.isFunctionLike(owner) && owner.parameters.some((parameter) => parameter.name.getText(source) === "spec")) {
                  throw new Error(`unresolved pause point: ${where}`);
                }
                owner = owner.parent;
              }
              if (!owner || !ts.isFunctionDeclaration(owner) || owner.name?.text !== "deleteOwnedRow" ||
                  owner.parameters[1]?.name.getText(source) !== "spec" ||
                  !file.endsWith("/resources/owner-delete-recheck.ts") || forwardsProperty) {
                throw new Error(`unresolved pause point: ${where}`);
              }
              forwardsProperty = true;
            } else add(argument, where);
          }
          if (deleteNames.has(name)) {
            const spec = node.arguments[1];
            if (!spec || !ts.isObjectLiteralExpression(spec) ||
                spec.properties.some((property) => ts.isSpreadAssignment(property))) {
              throw new Error(`unresolved pause point spec: ${where}`);
            }
            const points = spec.properties.filter((property) =>
              property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
              property.name.text === "point");
            if (points.length !== 1 || !ts.isPropertyAssignment(points[0])) {
              throw new Error(`unresolved pause point property: ${where}`);
            }
            add(points[0].initializer, where);
            propertyCalls++;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    if (forwardsProperty && propertyCalls === 0) throw new Error("unresolved pause point: spec.point");
    if (propertyCalls > 0 && !forwardsProperty) throw new Error("unresolved pause point helper: deleteOwnedRow");
    return calls;
  }

  const sources = () => roots.flatMap((root) => collectTs(root))
    .map((file) => ({ file, text: readFileSync(file, "utf8") }));

  it("direct literals and deleteOwnedRow point properties are well-formed and unique", () => {
    const calls = scanPausePoints(sources());
    expect(calls.length).toBeGreaterThan(0);
    for (const name of ["candidate-delete", "workspace-delete", "relationship-delete", "credential-delete", "grant-delete"]) {
      expect(calls.map((call) => call.name)).toContain(name);
    }
  });

  for (const [title, text, error] of [
    ["duplicate via point property", 'deleteOwnedRow(ctx, { point: "supersede-close" });', "duplicate pause point"],
    ["malformed name via point property", 'deleteOwnedRow(ctx, { point: "Bad Name" });', "malformed pause point"],
    ["unresolvable argument", "txnPausePoint(getPoint());", "unresolved pause point"],
    ["wrapped unresolvable call", "(txnPausePoint)(getPoint());", "unresolved pause point"],
    ["aliased unresolvable call", "const pause = txnPausePoint; pause(getPoint());", "unresolved pause point"],
    ["missing argument", "txnPausePoint();", "unresolved pause point"],
    ["unresolvable point property", "deleteOwnedRow(ctx, { point: getPoint() });", "unresolved pause point"],
    ["unscanned property argument", "txnPausePoint(other.point);", "unresolved pause point"],
    ["unresolvable spec", "deleteOwnedRow(ctx, spec);", "unresolved pause point"],
    ["spread override of point", 'deleteOwnedRow(ctx, { point: "fixture-delete", ...other });', "unresolved pause point"],
  ]) {
    it(`scan rejects ${title}`, () => {
      expect(() => scanPausePoints([...sources(), { file: "fixture.ts", text }])).toThrow(error);
    });
  }

  it("refuses a malformed name at call time with a named error", () => {
    for (const bad of ["Bad Name", "no_underscores", "-leading", "trailing-", "double--hyphen", ""]) {
      expect(() => txnPausePoint(bad, {} as NodeJS.ProcessEnv)).toThrow(InvalidPausePointError);
    }
  });
});
