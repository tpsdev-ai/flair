/**
 * Acquired object literals in lock.ts must name a literal held/error kind.
 * Ambiguous acquired/kind properties, computed keys and spreads fail the scan.
 * TypeScript typing is a separate, additional check.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const LOCK_SOURCE = fileURLToPath(new URL("../../resources/migrations/lock.ts", import.meta.url));

function propertyName(node: ts.ObjectLiteralElementLike): string | undefined {
  if (node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) return node.name.text;
  return undefined;
}

function scanRefusalKinds(text: string, file: string): { line: number; kind: string }[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const sites: { line: number; kind: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const ambiguous = node.properties.some((property) =>
        ts.isSpreadAssignment(property) || (property.name && ts.isComputedPropertyName(property.name)),
      );
      const acquired = node.properties.filter((property) => propertyName(property) === "acquired");
      if (ambiguous || acquired.length > 0) {
        const kinds = node.properties.filter((property) => propertyName(property) === "kind");
        const kind = kinds[0];
        const value = acquired[0];
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        if (ambiguous || acquired.length !== 1 || !value || !ts.isPropertyAssignment(value) ||
          value.initializer.kind !== ts.SyntaxKind.FalseKeyword || kinds.length !== 1 ||
          !kind || !ts.isPropertyAssignment(kind) || !ts.isStringLiteral(kind.initializer) ||
          (kind.initializer.text !== "held" && kind.initializer.text !== "error")) {
          throw new Error(`unproven acquired/kind object at ${file}:${line}`);
        }
        sites.push({ line, kind: kind.initializer.text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

describe("migration lock refusal kinds (flair#2978)", () => {
  it("lock.ts acquired literals name a held or error kind", () => {
    const sites = scanRefusalKinds(readFileSync(LOCK_SOURCE, "utf-8"), LOCK_SOURCE);
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.some((site) => site.kind === "held")).toBe(true);
    expect(sites.some((site) => site.kind === "error")).toBe(true);
  });

  it.each([
    ["missing kind", '{ acquired: false }'],
    ["quoted acquired", '{ "acquired": false }'],
    ["shorthand acquired", '{ acquired, kind: "held" }'],
    ["computed acquired", '{ ["acquired"]: false, kind: "held" }'],
    ["unknown computed key", '{ [key]: false, kind: "held" }'],
    ["spread", '{ ...refusal, kind: "held" }'],
    ["spread override", '{ acquired: false, kind: "held", ...other }'],
    ["non-literal kind", '{ acquired: false, kind: classification }'],
    ["shorthand kind", '{ acquired: false, kind }'],
    ["computed kind", '{ acquired: false, ["kind"]: "held" }'],
    ["non-literal acquired", '{ acquired: result, kind: "held" }'],
    ["duplicate kind", '{ acquired: false, kind: "held", kind: "error" }'],
  ])("rejects %s at the fixture location", (_name, literal) => {
    expect(() => scanRefusalKinds(`const refusal =\n${literal};`, "lock.fixture.ts"))
      .toThrow("unproven acquired/kind object at lock.fixture.ts:2");
  });

  it("accepts quoted acquired and kind keys with literal values", () => {
    expect(scanRefusalKinds('({ "acquired": false, "kind": "error" })', "lock.fixture.ts"))
      .toEqual([{ line: 1, kind: "error" }]);
  });
});
