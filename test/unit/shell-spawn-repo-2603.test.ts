import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { checkTestSpawn } from "../helpers/bun-harper-spawn-guard.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const root = resolve(import.meta.dir, "../..");
const guardFixtures = "test/unit/cli-runtime-node-guard-2570.test.ts";
const unknown = Symbol("dynamic expression");
type Value = string | boolean | Value[] | { [key: string]: Value } | typeof unknown;
type ShellCall = { site: string; command: Value; args: Value[]; shell: Value; options: Value; node: ts.CallExpression };

function collect(source: string, file: string, substitutions: Record<string, string> = {}): ShellCall[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports = new Map<string, string>();
  const namespaces = new Set(["Bun"]);
  const declarations = new Map<string, ts.Expression[]>();
  function index(node: ts.Node) {
    if (ts.isImportDeclaration(node) && /^(?:node:)?child_process$/.test((node.moduleSpecifier as ts.StringLiteral).text)) {
      const clause = node.importClause;
      if (clause?.name) namespaces.add(clause.name.text);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) namespaces.add(clause.namedBindings.name.text);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const item of clause.namedBindings.elements) imports.set(item.name.text, item.propertyName?.text ?? item.name.text);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const values = declarations.get(node.name.text) ?? [];
      values.push(node.initializer);
      declarations.set(node.name.text, values);
      if (/(?:require\(|createRequire[\s\S]*\()["'](?:node:)?child_process["']\)/.test(node.initializer.getText(ast))) namespaces.add(node.name.text);
    }
    ts.forEachChild(node, index);
  }
  index(ast);
  function value(node: ts.Expression | undefined, seen = new Set<string>()): Value {
    if (!node) return unknown;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return value(node.expression, seen);
    if (ts.isIdentifier(node)) {
      if (Object.hasOwn(substitutions, node.text)) return substitutions[node.text];
      if (seen.has(node.text)) return unknown;
      const candidates = declarations.get(node.text)?.filter(item => item.getStart() < node.getStart());
      if (candidates?.length) return value(candidates[candidates.length - 1], new Set([...seen, node.text]));
    }
    if (ts.isTemplateExpression(node)) {
      let result = node.head.text;
      for (const span of node.templateSpans) {
        const part = value(span.expression, seen);
        if (typeof part !== "string") return unknown;
        result += part + span.literal.text;
      }
      return result;
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(item => value(item as ts.Expression, seen));
    if (ts.isObjectLiteralExpression(node)) {
      const result: Record<string, Value> = {};
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) result[property.name.getText(ast).replaceAll(/["']/g, "")] = value(property.initializer, seen);
        else if (ts.isShorthandPropertyAssignment(property)) result[property.name.text] = value(property.name, seen);
        else if (ts.isSpreadAssignment(property)) {
          const spread = value(property.expression, seen);
          if (spread !== unknown && typeof spread === "object" && !Array.isArray(spread)) Object.assign(result, spread);
        }
      }
      return result;
    }
    return unknown;
  }
  function property(item: Value, key: string): Value {
    return item !== unknown && typeof item === "object" && !Array.isArray(item) ? item[key] ?? unknown : unknown;
  }
  const result: ShellCall[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const api = ts.isIdentifier(expression) ? imports.get(expression.text)
        : ts.isPropertyAccessExpression(expression) && namespaces.has(expression.expression.getText(ast)) ? expression.name.text
        : ts.isCallExpression(expression) && expression.expression.getText(ast) === "promisify" && ts.isIdentifier(expression.arguments[0])
          ? imports.get(expression.arguments[0].text) : undefined;
      if (api && /^(?:exec|execSync|spawn|spawnSync|execFile|execFileSync)$/.test(api)) {
        const bun = ts.isPropertyAccessExpression(expression) && expression.expression.getText(ast) === "Bun";
        let command = value(node.arguments[0]);
        let args: Value[] = [];
        let options = value(node.arguments[1]);
        if (bun) {
          const argv = Array.isArray(command) ? command : property(command, "cmd");
          if (!Array.isArray(command)) options = command;
          command = Array.isArray(argv) ? argv[0] : unknown;
          args = Array.isArray(argv) ? argv.slice(1) : [];
        } else if (Array.isArray(options)) {
          args = options;
          options = value(node.arguments[2]);
        }
        const shell = /^(?:exec|execSync)$/.test(api) ? true : property(options, "shell");
        const commandFlag = args.some(arg => typeof arg === "string" && /^-[^-]*c/.test(arg));
        const shellExecutable = typeof command === "string" && /(?:^|\/)(?:sh|bash)$/.test(command);
        const dynamicShell = /\b(?:shell|executableShell|form\.command)\b/.test(node.arguments[0]?.getText(ast) ?? "");
        if (shell === true || typeof shell === "string" || (shellExecutable || dynamicShell) && commandFlag ||
            options !== unknown && typeof options === "object" && !Array.isArray(options) && Object.hasOwn(options, "shell") ||
            file === guardFixtures && (dynamicShell || /\bshell\b/.test(node.getText(ast)))) {
          const line = ast.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          result.push({ site: `${file}:${line}`, command, args, shell, options, node });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  // Resolve a shell-spawning helper's string parameter at every local call.
  for (const call of [...result]) {
    if (call.command !== unknown || !ts.isIdentifier(call.node.arguments[0])) continue;
    let parent: ts.Node | undefined = call.node.parent;
    while (parent && !ts.isFunctionDeclaration(parent)) parent = parent.parent;
    if (!parent?.name) continue;
    const parameter = parent.parameters.findIndex(item => item.name.getText(ast) === call.node.arguments[0].getText(ast));
    if (parameter < 0) continue;
    const helper = parent.name.text;
    const expanded: ShellCall[] = [];
    function callers(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === helper) {
        const line = ast.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        expanded.push({ ...call, site: `${call.site} via ${file}:${line}`, command: value(node.arguments[parameter]) });
      }
      ts.forEachChild(node, callers);
    }
    callers(ast);
    if (expanded.length) result.splice(result.indexOf(call), 1, ...expanded);
  }
  return result;
}

function check(call: ShellCall) {
  const options = call.options !== unknown && typeof call.options === "object" && !Array.isArray(call.options) ? call.options : {};
  const env = options.env;
  const childEnv: Record<string, string> = {};
  if (env !== unknown && typeof env === "object" && !Array.isArray(env)) {
    for (const [key, value] of Object.entries(env)) {
      expect(typeof value, `${call.site}: resolve child env.${key}`).toBe("string");
      childEnv[key] = value as string;
    }
  }
  checkTestSpawn(call.site, call.command, call.args, {
    shell: call.shell === unknown ? undefined : call.shell as boolean | string,
    cwd: typeof options.cwd === "string" ? options.cwd : undefined,
    env: Object.keys(childEnv).length ? childEnv : undefined,
  });
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(item => {
    const path = join(dir, item.name);
    return item.isDirectory() ? files(path) : /\.[cm]?[jt]s$/.test(path) ? [path] : [];
  });
}

test("shell scan recognizes child_process aliases, namespaces and Bun command forms", () => {
  const source = `
    import { execSync as run, exec, spawnSync } from "node:child_process";
    import * as cp from "node:child_process";
    run("cp -al source target"); exec("rm -f target"); promisify(exec)("rm -f target");
    spawnSync("cp source target", { shell: true });
    cp.spawn("cp source target", [], { shell: "/bin/sh" });
    Bun.spawnSync(["sh", "-ec", "cp source target"]);
    Bun.spawn({ cmd: ["bash", "-lc", "rm -f target"] });
  `;
  const calls = collect(source, "fixture.ts");
  expect(calls).toHaveLength(7);
  for (const call of calls) {
    expect(() => check(call)).not.toThrow();
  }
});

test("shell scan preserves child reasons and exported Bash functions", () => {
  const source = `
    import { spawnSync } from "node:child_process";
    const env = { "BASH_FUNC_node%%": "() { bun \\\"$@\\\"; }" };
    spawnSync("/bin/bash", ["-c", "node ./dist/cli.js --version"], { env });
    spawnSync("/bin/bash", ["-c", "node ./dist/cli.js --version"], {
      env: { ...env, FLAIR_TEST_ALLOW_BUN_HARPER: "exercise exported node function" },
    });
  `;
  const calls = collect(source, "fixture.ts");
  expect(calls).toHaveLength(2);
  expect(() => check(calls[0])).toThrow("shell string launching dist/cli.js");
  expect(() => check(calls[1])).not.toThrow();
});

test("test tree shell-string spawns are allowed or assert their guard decision in the runtime fixtures", () => {
  const substitutions = { REPO_ROOT: root, tempDir: tempDir("flair-shell-scan-") };
  const calls = files(join(root, "test")).flatMap(file => collect(readFileSync(file, "utf8"), relative(root, file), substitutions));
  expect(calls.length).toBeGreaterThan(0);
  let fixtures = 0;
  for (const call of calls) {
    console.log(`shell spawn: ${call.site}`);
    if (call.site.startsWith(`${guardFixtures}:`)) {
      fixtures++;
      continue;
    }
    expect(typeof call.command, `${call.site}: resolve the command string`).toBe("string");
    expect(call.args.every(arg => typeof arg === "string"), `${call.site}: resolve argv`).toBe(true);
    expect(() => check(call), call.site).not.toThrow();
  }
  expect(fixtures).toBeGreaterThan(0);
  // Dynamic runtime fixtures exercise both acceptance and deliberate refusal through real shells.
  const output = execFileSync(process.execPath, ["test", guardFixtures], {
    cwd: root, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
  });
  expect(output).toContain("bun test");
}, 70_000);
