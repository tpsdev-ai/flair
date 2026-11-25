#!/usr/bin/env node
// Every `@node-llama-cpp/<platform>` install in `.github/workflows/*.yml` must
// take its version at run time (flair#3133):
//
//   - in this checkout, from bun.lock via `scripts/ci/llama-native-version.mjs`;
//   - in an npm-installed directory, from the node-llama-cpp install that
//     directory already resolved, via
//     `scripts/ci/llama-installed-version.mjs <dir>`.
//
// A literal (`@3.22.3`), a bare name, `@3`, a range or `@latest` is not tied
// to the tree it installs into: a lockfile bump leaves the literal stale, and
// an npm-installed directory resolves its own tree, not this checkout's.
//
// Each form is accepted through a variable assigned from one of those scripts
// earlier in the same step, and that variable must be checked against
// `^[0-9]+\.[0-9]+\.[0-9]+$` between the assignment and the install, the way
// the migration baseline step checks its own version. An inline `$(node …)`
// is not accepted: when the script exits non-zero the shell still runs the
// install, with an empty version.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_VERSION_SCRIPT = "scripts/ci/llama-native-version.mjs";
export const INSTALLED_VERSION_SCRIPT = "scripts/ci/llama-installed-version.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const INSTALL = /@node-llama-cpp\/([A-Za-z0-9._-]+)/g;
const STEP = /^\s{0,8}- (?:name|run|uses|id):/;
const ASSIGN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=("?)\$\((.+)\)\2\s*$/;
// The shell text the baseline step uses; matched literally so a step that
// swaps it for a different test is not accepted as guarded.
const SEMVER_TEST = "=~ ^[0-9]+\\.[0-9]+\\.[0-9]+$";

/** Index just past the `)` matching the `$(` at `start`, or -1. */
function closeParen(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i + 1;
  }
  return -1;
}

/** The expression an install names after its `@`, or null for a bare name. */
function readExpression(rest) {
  if (rest === "" || /^[\s"'`),;#]/.test(rest)) return null;
  const after = rest.startsWith("@") ? rest.slice(1) : rest;
  const quoted = after.startsWith('"');
  const spec = quoted ? after.slice(1) : after;

  let text;
  if (spec.startsWith("$(")) {
    // A command substitution: skip to its matching `)`, so a nested quoted
    // argument or a space inside does not end the spec early.
    const close = closeParen(spec, 0);
    if (close === -1) return { kind: "literal", text: spec };
    text = spec.slice(0, close);
  } else if (quoted) {
    const close = spec.indexOf('"');
    text = close === -1 ? spec : spec.slice(0, close);
  } else {
    text = spec.match(/^[^\s"'`),;#]*/)[0];
  }

  if (text === "") return null;
  if (text.startsWith("$(") && text.endsWith(")")) {
    return { kind: "substitution", text, body: text.slice(2, -1) };
  }
  const variable = text.match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/);
  if (variable) return { kind: "variable", text, name: variable[1] ?? variable[2] };
  return { kind: "literal", text };
}

/** The version script a command substitution runs, or null. */
export function allowedScript(command) {
  const tokens = command.trim().split(/\s+/);
  if (tokens[0] !== "node" || !tokens[1]) return null;
  const script = tokens[1].replace(/^["']/, "").replace(/["']$/, "");
  if (script.endsWith(REPO_VERSION_SCRIPT)) return "repo";
  if (script.endsWith(INSTALLED_VERSION_SCRIPT)) return "installed";
  return null;
}

/** The assignment of `name` from an allowed script in lines [from, to). */
function findAssignment(lines, from, to, name) {
  for (let i = from; i < to; i++) {
    const match = lines[i].match(ASSIGN);
    if (match && match[1] === name && allowedScript(match[3])) return i;
  }
  return -1;
}

/** Whether lines [from, to) check `name` against the x.y.z pattern. */
function findGuard(lines, from, to, name) {
  const refs = ['"$' + name + '"', '"${' + name + '}"', '$' + name];
  for (let i = from; i < to; i++) {
    if (lines[i].includes(SEMVER_TEST) && refs.some(ref => lines[i].includes(ref))) return true;
  }
  return false;
}

function classify(expr, lines, stepStart, at) {
  if (expr === null) return { version: null, reason: "no version" };
  if (expr.kind === "substitution") {
    return { version: expr.text, reason: "inline substitution is not checked against ^x.y.z$ in the step" };
  }
  if (expr.kind === "variable") {
    const assigned = findAssignment(lines, stepStart, at, expr.name);
    if (assigned === -1) {
      return { version: expr.text, reason: `$${expr.name} is not set from a version script in this step` };
    }
    if (!findGuard(lines, assigned, at, expr.name)) {
      return { version: expr.text, reason: `$${expr.name} is not checked against ^x.y.z$ before use` };
    }
    return null;
  }
  return { version: expr.text, reason: "literal version" };
}

/**
 * The installs in one workflow's text that do not read their version at run
 * time. Line numbers are 1-based, so they read as `file:line` in CI output.
 */
export function scanWorkflowPins(text) {
  const lines = text.split(/\r?\n/);
  const steps = [];
  for (let i = 0; i < lines.length; i++) if (STEP.test(lines[i])) steps.push(i);

  const violations = [];
  let installs = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("@node-llama-cpp/")) continue;
    INSTALL.lastIndex = 0;
    let match;
    while ((match = INSTALL.exec(lines[i])) !== null) {
      installs++;
      let stepStart = 0;
      for (const start of steps) if (start <= i) stepStart = start;
      const found = classify(readExpression(lines[i].slice(INSTALL.lastIndex)), lines, stepStart, i);
      if (found) violations.push({ line: i + 1, platform: match[1], ...found });
    }
  }
  return { installs, violations };
}

/** Every `*.yml`/`*.yaml` in `dir`, in stable order. */
export function workflowFiles(dir) {
  return readdirSync(dir)
    .filter(name => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map(name => join(dir, name));
}

/** Scan every workflow file in `dir`; violations carry `file`. */
export function checkWorkflows(dir) {
  const violations = [];
  let installs = 0;
  for (const file of workflowFiles(dir)) {
    const result = scanWorkflowPins(readFileSync(file, "utf8"));
    installs += result.installs;
    violations.push(...result.violations.map(violation => ({ file, ...violation })));
  }
  return { installs, violations };
}

const isEntryPoint =
  process.argv[1] &&
  (() => {
    try {
      return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
    } catch {
      return false;
    }
  })();

if (isEntryPoint) {
  try {
    const dir = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, ".github/workflows");
    const { installs, violations } = checkWorkflows(dir);
    for (const violation of violations) {
      const found = violation.version === null ? "no version" : `@${violation.version}`;
      process.stderr.write(
        `${violation.file}:${violation.line}: @node-llama-cpp/${violation.platform} (${found}): ${violation.reason}\n`,
      );
    }
    if (violations.length) {
      process.stderr.write(
        `llama-native-pin: ${violations.length} of ${installs} @node-llama-cpp installs do not read their version at run time\n`,
      );
      process.exitCode = 1;
    } else {
      process.stdout.write(`llama-native-pin: ${installs} installs read their version at run time\n`);
    }
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
