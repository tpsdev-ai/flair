/**
 * migrations-lock-refusal-kind-2978.test.ts — every refusal the migration
 * lock returns carries a `kind` (flair#2978).
 *
 * The boot path reports a refused acquisition only when it is not
 * contention, so a return site without a kind would be misclassified. This
 * inventory scans resources/migrations/lock.ts and fails for any
 * `{ acquired: false }` object literal whose `kind` is not the literal
 * "held" or "error".
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const LOCK_SOURCE = fileURLToPath(new URL("../../resources/migrations/lock.ts", import.meta.url));

function propertyName(node: ts.PropertyAssignment): string {
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) return node.name.text;
  return "";
}

/** Returns the line and kind of every refusal literal, throwing when one has no literal kind. */
function scanRefusalKinds(text: string, file: string): { line: number; kind: string }[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const sites: { line: number; kind: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const properties = node.properties.filter(ts.isPropertyAssignment);
      const acquired = properties.find((property) => propertyName(property) === "acquired");
      if (acquired && acquired.initializer.kind === ts.SyntaxKind.FalseKeyword) {
        const kind = properties.find((property) => propertyName(property) === "kind");
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        if (!kind || !ts.isStringLiteral(kind.initializer) || (kind.initializer.text !== "held" && kind.initializer.text !== "error")) {
          throw new Error(`refusal site without a held/error kind at ${file}:${line}`);
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
  it("every acquired:false literal in lock.ts names a held or error kind", () => {
    const sites = scanRefusalKinds(readFileSync(LOCK_SOURCE, "utf-8"), LOCK_SOURCE);
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.some((site) => site.kind === "held")).toBe(true);
    expect(sites.some((site) => site.kind === "error")).toBe(true);
  });

  it("the scan rejects a new refusal site without a kind", () => {
    const text = `${readFileSync(LOCK_SOURCE, "utf-8")}\nfunction injected(): AcquireResult {\n  return { acquired: false, reason: "injected" };\n}\n`;
    expect(() => scanRefusalKinds(text, "lock.fixture.ts")).toThrow("refusal site without a held/error kind");
  });
});
