#!/usr/bin/env node
// Reject direct native-package names in workflow lines outside comments.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function scanWorkflowPins(text) {
  return text.split(/\r?\n/).flatMap((line, index) =>
    !line.trim().startsWith("#") && line.includes("@node-llama-cpp/")
      ? [{ line: index + 1 }]
      : [],
  );
}

export function workflowFiles(dir) {
  return readdirSync(dir)
    .filter(name => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map(name => join(dir, name));
}

export function checkWorkflows(dir) {
  return workflowFiles(dir).flatMap(file =>
    scanWorkflowPins(readFileSync(file, "utf8")).map(violation => ({ file, ...violation })),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const violations = checkWorkflows(process.argv[2] ? resolve(process.argv[2]) : join(ROOT, ".github/workflows"));
    for (const { file, line } of violations) {
      process.stderr.write(`${file}:${line}: llama-native-pin: direct @node-llama-cpp/ reference\n`);
    }
    if (violations.length) process.exitCode = 1;
    else process.stdout.write("llama-native-pin: no direct native-package references outside comment lines\n");
  } catch (error) {
    process.stderr.write(`llama-native-pin: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
