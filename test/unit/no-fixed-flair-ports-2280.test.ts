/** flair#2280 — scan listener port arguments for 9925/9926/19925/19926. */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const TEST_ROOT = join(import.meta.dirname, "..");
const EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const PROTECTED_PORTS = new Set([9925, 9926, 19925, 19926]);

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...testFiles(path));
    else if (EXTS.has(name.slice(name.lastIndexOf(".")))) out.push(path);
  }
  return out;
}

export function portBinds(text: string, fileName = "fixture.ts"): string[] {
  const kind = fileName.endsWith(".tsx") || fileName.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, allowJs: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => name === source.fileName ? source : undefined;
  const checker = ts.createProgram([source.fileName], options, host).getTypeChecker();
  const writes = new Map<ts.Symbol, { at: number; value: ts.Expression }[]>();
  const record = (name: ts.Identifier, value: ts.Expression, at: number) => {
    const symbol = checker.getSymbolAtLocation(name);
    if (!symbol) return;
    const values = writes.get(symbol) ?? [];
    values.push({ at, value });
    writes.set(symbol, values);
  };
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      record(node.name, node.initializer, node.getStart(source));
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      record(node.left, node.right, node.getStart(source));
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const valueOf = (expr: ts.Expression, at: number, seen = new Set<ts.Symbol>()): ts.Expression => {
    if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isNonNullExpression(expr)) {
      return valueOf(expr.expression, at, seen);
    }
    if (!ts.isIdentifier(expr)) return expr;
    const symbol = checker.getSymbolAtLocation(expr);
    if (!symbol || seen.has(symbol)) return expr;
    seen.add(symbol);
    const latest = writes.get(symbol)?.filter((write) => write.at < at).sort((a, b) => b.at - a.at)[0];
    return latest ? valueOf(latest.value, latest.at, seen) : expr;
  };
  const portOf = (arg: ts.Expression, at: number): ts.Expression | undefined => {
    const value = valueOf(arg, at);
    if (!ts.isObjectLiteralExpression(value)) return value;
    const property = value.properties.find((item) => item.name &&
      (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === "port");
    if (property && ts.isPropertyAssignment(property)) return valueOf(property.initializer, value.getStart(source));
    if (property && ts.isShorthandPropertyAssignment(property)) {
      const symbol = checker.getShorthandAssignmentValueSymbol(property);
      const latest = symbol && writes.get(symbol)?.filter((write) => write.at < value.getStart(source)).sort((a, b) => b.at - a.at)[0];
      return latest ? valueOf(latest.value, latest.at) : undefined;
    }
    return undefined;
  };
  const found: string[] = [];
  const add = (node: ts.Node, bind: string) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    found.push(`${line}: ${bind}`);
  };
  const embedded = (node: ts.Node, code: string) => {
    if (!code.includes("listen") && !code.includes("serve")) return;
    for (const bind of portBinds(code)) add(node, bind);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : "";
      if (["listen", "serve", "startStub"].includes(name) && node.arguments[0]) {
        const port = portOf(node.arguments[0], node.getStart(source));
        if (port && ts.isNumericLiteral(port) && PROTECTED_PORTS.has(Number(port.text))) add(node, node.getText(source));
      }
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "join" && ts.isArrayLiteralExpression(callee.expression) &&
          callee.expression.elements.every(ts.isStringLiteralLike)) {
        const separator = node.arguments[0];
        if (separator && ts.isStringLiteralLike(separator)) {
          embedded(node, callee.expression.elements.map((item) => (item as ts.StringLiteralLike).text).join(separator.text));
          return;
        }
      }
    }
    if (ts.isStringLiteralLike(node)) embedded(node, node.text);
    else if (ts.isTemplateExpression(node)) {
      const code = node.head.text + node.templateSpans.map((span) => {
        const value = valueOf(span.expression, node.getStart(source));
        return (ts.isNumericLiteral(value) || ts.isStringLiteralLike(value) ? value.text : value.getText(source)) + span.literal.text;
      }).join("");
      embedded(node, code);
      for (const span of node.templateSpans) ts.forEachChild(span.expression, visit);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...new Set(found)];
}

describe("listener arguments for 9925/9926/19925/19926 (flair#2280)", () => {
  for (const port of PROTECTED_PORTS) {
    test(`${port}: literal, identifier, typed declaration, and later assignment binds`, () => {
      for (const code of [
        `server.listen(${port})`,
        `serve(${port})`,
        `createServer(() => {}).listen(${port})`,
        `const $port = ${port}; server.listen($port)`,
        `const port: number = ${port}; server.listen(port)`,
        `const $port: number = ${port}; server.listen($port)`,
        `let port: number; port = ${port}; server.listen(port)`,
        `let $port: number; $port = ${port}; server.listen($port)`,
        `const port = ${port}; const alias = port; server.listen(alias)`,
        `server.listen({ port: ${port} })`,
        `Bun.serve({\n port: ${port},\n fetch() {}\n})`,
        `const port = ${port}; Bun.serve({ port })`,
        `const config = { port: ${port} }; Bun.serve(config)`,
        `let port = ${port}; const config = { port }; port = 0; Bun.serve(config)`,
        `let port = ${port}; const config = { port: port }; port = 0; Bun.serve(config)`,
        `const script = 'server.listen(${port})'`,
        `const script = ['const port = ${port};', 'server.listen(port)'].join('\\n')`,
      ]) expect(portBinds(code), code).toHaveLength(1);
    });
    test(`${port}: non-bind literals and distinct identifier boundaries`, () => {
      for (const code of [
        `server.listen(0); const expected = ${port}`,
        `server.listen(0, () => log(${port}))`,
        `const config = { port: ${port} }; fetch('http://localhost:' + config.port)`,
        `const $port = ${port}; server.listen(port)`,
        `const port = ${port}; server.listen($port)`,
        `const port: number = ${port}; server.listen(portSuffix)`,
        `let port; port = ${port}; server.listen(otherport)`,
        `let $port: number; $port = ${port}; server.listen($portSuffix)`,
        `let port = ${port}; port = 0; server.listen(port)`,
        `const port = ${port}; function start() { const port = 0; server.listen(port) }`,
        `server.listen({ port: 0, expected: ${port} })`,
        `Bun.serve({ port: 0, expected: ${port} })`,
        `let port = 0; const config = { port }; port = ${port}; Bun.serve(config)`,
        `let port = 0; const config = { port: port }; port = ${port}; Bun.serve(config)`,
        `// server.listen(${port})`,
        `server.listen(${port}0)`,
      ]) expect(portBinds(code), code).toEqual([]);
    });
  }
  test("test/ has no detected 9925/9926/19925/19926 listener arguments", () => {
    const offenders: string[] = [];
    for (const file of testFiles(TEST_ROOT)) {
      for (const bind of portBinds(readFileSync(file, "utf-8"), file)) offenders.push(`${relative(TEST_ROOT, file)}:${bind}`);
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  }, 60_000);
});
