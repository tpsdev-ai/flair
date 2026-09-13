#!/usr/bin/env node
/**
 * check-dist-esm-require.mjs — fail when the emitted ESM build uses the
 * CommonJS `require()` global, which is the shape behind flair#1653.
 *
 * WHY THIS EXISTS
 * `package.json` is `"type": "module"`, so every `dist/**` `*.js` file is
 * loaded by Node as an ES module. In that scope `require` is not defined, and
 * Node has a specific, misleading failure mode when the module graph also has
 * top-level await:
 *
 *   ReferenceError: Cannot determine intended module format because both
 *   require() and top-level await are present. ...
 *       code: 'ERR_AMBIGUOUS_MODULE_SYNTAX'
 *
 * Node throws the *plain* `require is not defined` when the require error does
 * not escape to a top-level-await frame, and the `ERR_AMBIGUOUS_MODULE_SYNTAX`
 * rewrite only when it does (Node's explainCommonJSGlobalLikeNotDefinedError,
 * keyed on the top-level-await state of the module whose evaluation catches the
 * error). Both are crashes of a shipped CLI; the rewrite is just the confusing
 * version operators reported in flair#1653.
 *
 * flair#1653 shipped because nothing checked the compiled output:
 *   - `src/commands/session.ts` compiled `require("node:fs")` into
 *     `dist/commands/session.js`, an ESM module.
 *   - The source-level unit suite runs under bun, which tolerates `require` in
 *     ESM, so it stayed green.
 *   - The crash only fires when the snapshots dir exists, and only against the
 *     real Node loader, so no snapshot/unit lane executed it either.
 *
 * WHAT IT CHECKS
 * Walk every emitted `dist/**` `*.js` / `*.mjs` ESM module, parse it with the
 * TypeScript parser, and record each module's `require(...)` call sites and
 * top-level `await` (including `for await`, excluding awaits inside functions).
 * A `require()` in ESM is always a latent crash; it is reported as
 * `ERR_AMBIGUOUS_MODULE_SYNTAX` when the build also has top-level await, so the
 * guard fails when BOTH hold across the shipped build:
 *
 *   - "mixed"  — one module contains both `require()` and its own top-level
 *                await. This is the literal condition in the issue.
 *   - "escape" — a module calls `require()` and the build contains top-level
 *                await elsewhere; that await's evaluation frame is where
 *                Node rewrites the error. This is exactly the flair#1653
 *                shape: `dist/commands/session.js` had the `require()`, while
 *                `dist/cli.js` (its entry) had the top-level await. Without
 *                this case the guard would go green the moment #1618 extracts
 *                cli.ts's requires — and miss the very bug it exists to stop.
 *
 * Both cases name file + line for the `require()` and for the top-level await.
 *
 * DELIBERATE LIMITS
 * - `.cjs` files are CommonJS by definition and are skipped.
 * - Detection is structural (AST), not textual: a comment or string that merely
 *   mentions `require()` does not trip it.
 * - `createRequire(...)` is not a `require(...)` call and is not flagged.
 * - `require()` + top-level await in *different builds* is fine; this scans one
 *   dist tree at a time.
 *
 * CORPUS SAFETY
 * A guard that scans nothing must not pass. A missing/non-directory target, or
 * a target with zero `.js`/`.mjs` modules, exits non-zero with a clear message —
 * that is how a stale or skipped build stays red instead of vacuously green.
 *
 * Usage: node scripts/check-dist-esm-require.mjs [distDir]   (default: dist)
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

/** Every `.js` / `.mjs` module under `dir`, recursively (`.cjs` is CommonJS). */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(?:js|mjs)$/.test(name)) out.push(full);
  }
  return out.sort();
}

function positionOf(sourceFile, node) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: line + 1, column: character + 1 };
}

/** Every call whose callee is the bare identifier `require`. */
function collectRequireCalls(sourceFile) {
  const hits = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      hits.push(positionOf(sourceFile, node.expression));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return hits;
}

/**
 * The first `await` in the module's top-level scope, or null. `await` nested in
 * any function (including an arrow) is not top-level and does not count.
 */
function findTopLevelAwait(sourceFile) {
  let found = null;
  const visit = (node, insideFunction) => {
    if (found) return;
    if (!insideFunction) {
      if (ts.isAwaitExpression(node)) {
        found = positionOf(sourceFile, node);
        return;
      }
      // `for await (const x of y)` is also top-level await.
      if (ts.isForOfStatement(node) && node.awaitModifier) {
        found = positionOf(sourceFile, node);
        return;
      }
    }
    const entersFunction = ts.isFunctionLike(node);
    ts.forEachChild(node, (child) => visit(child, insideFunction || entersFunction));
  };
  visit(sourceFile, false);
  return found;
}

const target = resolve(process.argv[2] ?? "dist");

if (!existsSync(target) || !statSync(target).isDirectory()) {
  console.error(`FAIL: target directory not found: ${target}`);
  console.error("Build the dist output before running this check (bun run build && bun run build:cli).");
  process.exit(1);
}

const files = walk(target);
if (files.length === 0) {
  console.error(`FAIL: no .js/.mjs modules under ${target} — refusing to pass vacuously.`);
  console.error("A missing or skipped build is not a clean dist.");
  process.exit(1);
}

const modules = files.map((file) => {
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return { file, requireCalls: collectRequireCalls(sourceFile), topLevelAwait: findTopLevelAwait(sourceFile) };
});

// Top-level await anywhere in the build is what upgrades a require() crash to
// the ERR_AMBIGUOUS_MODULE_SYNTAX operators saw in flair#1653.
const awaitModule = modules.find((m) => m.topLevelAwait) ?? null;
const buildHasTopLevelAwait = awaitModule !== null;

const violations = [];
for (const m of modules) {
  if (m.requireCalls.length === 0) continue;
  if (m.topLevelAwait) {
    violations.push({ ...m, kind: "mixed", awaitAt: { file: m.file, ...m.topLevelAwait } });
  } else if (buildHasTopLevelAwait) {
    violations.push({
      ...m,
      kind: "escape",
      awaitAt: { file: awaitModule.file, ...awaitModule.topLevelAwait },
    });
  }
}

for (const v of violations) {
  const rel = relative(process.cwd(), v.file) || v.file;
  const awaitRel = relative(process.cwd(), v.awaitAt.file) || v.awaitAt.file;
  const requireLines = v.requireCalls.map((p) => `${rel}:${p.line}`).join(", ");
  const detail =
    v.kind === "mixed"
      ? "mixes require() with its own top-level await"
      : "calls require() in an ESM build that has top-level await";
  console.error(`FAIL ${rel}: ${detail} (ERR_AMBIGUOUS_MODULE_SYNTAX)`);
  for (const p of v.requireCalls) console.error(`  require() at ${rel}:${p.line}:${p.column}`);
  console.error(`  top-level await at ${awaitRel}:${v.awaitAt.line}:${v.awaitAt.column}`);
  // GitHub Actions annotation, on stdout (that is where the runner reads it).
  console.log(
    `::error file=${rel},line=${v.requireCalls[0].line}::` +
      `ESM module ${detail} (require at ${requireLines}; await at ` +
      `${awaitRel}:${v.awaitAt.line}); Node rejects this with ` +
      `ERR_AMBIGUOUS_MODULE_SYNTAX. Replace require() with an ESM import.`,
  );
}

if (violations.length > 0) {
  console.error(
    `\n${violations.length} module(s) use require() in a build with top-level await ` +
      `(${modules.length} module(s) scanned).`,
  );
  console.error(
    "Node rejects these at runtime with ERR_AMBIGUOUS_MODULE_SYNTAX (flair#1653). " +
      "Replace require() with an ESM import.",
  );
  process.exit(1);
}

console.log(
  `${modules.length} module(s) checked; no require() in a build with top-level await.`,
);
