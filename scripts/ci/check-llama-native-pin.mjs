#!/usr/bin/env node
// Every `@node-llama-cpp/<platform>` install in `.github/workflows/*.yml` must
// name the exact version `node-llama-cpp` resolves to in `bun.lock`
// (flair#3133). A bare name, `@3`, `@latest` or any range floats past the
// lockfile and the repository's release-age gate for that package.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readLlamaNativeVersion, ROOT } from "./llama-native-version.mjs";

// `@node-llama-cpp/<platform>` with an optional `@<version>`; the version runs
// until whitespace or a shell/YAML delimiter.
const INSTALL = /@node-llama-cpp\/([A-Za-z0-9._-]+)(?:@([^\s"'`),;#]+))?/g;

/**
 * The installs in one workflow's text that are not pinned to `expected`.
 * Line numbers are 1-based, so they read as `file:line` in CI output.
 */
export function scanWorkflowPins(text, expected) {
  const violations = [];
  let installs = 0;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    INSTALL.lastIndex = 0;
    let match;
    while ((match = INSTALL.exec(lines[index])) !== null) {
      installs++;
      const [, platform, version] = match;
      if (version === undefined) {
        violations.push({ line: index + 1, platform, version: null });
      } else if (version !== expected) {
        violations.push({ line: index + 1, platform, version });
      }
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

/** Scan every workflow file in `dir` against `expected`; violations carry `file`. */
export function checkWorkflows(dir, expected) {
  const violations = [];
  let installs = 0;
  for (const file of workflowFiles(dir)) {
    const result = scanWorkflowPins(readFileSync(file, "utf8"), expected);
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
    const expected = readLlamaNativeVersion(readFileSync(join(ROOT, "bun.lock"), "utf8"));
    const dir = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, ".github/workflows");
    const { installs, violations } = checkWorkflows(dir, expected);
    for (const violation of violations) {
      const found = violation.version === null ? "no version" : `@${violation.version}`;
      process.stderr.write(
        `${violation.file}:${violation.line}: @node-llama-cpp/${violation.platform} (${found}) is not the lockfile version ${expected}\n`,
      );
    }
    if (violations.length) {
      process.stderr.write(
        `llama-native-pin: ${violations.length} of ${installs} @node-llama-cpp installs are not pinned to ${expected}\n`,
      );
      process.exitCode = 1;
    } else {
      process.stdout.write(`llama-native-pin: ${installs} installs all pinned to ${expected}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
