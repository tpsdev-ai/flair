/**
 * flair#3136 item 1: every `<id>.key` path in src/ is built by the one helper
 * in src/lib/key-dir.ts (agentKeyPath / keyPathIn), which applies the shared
 * agent-ID rule before joining. This guard fails when a src file outside that
 * module builds the name itself.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const SRC = join(ROOT, "src");
const HELPER = join(SRC, "lib", "key-dir.ts");

/** `<id>.key` inside a template literal, or `.key` concatenated onto an id. */
const KEY_PATH_PATTERNS = [/\$\{[^}\n]+\}\.key/, /\+\s*["'`]\.key["'`]/];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out.sort();
}

function offenders(): string[] {
  const found: string[] = [];
  for (const file of sourceFiles(SRC)) {
    if (file === HELPER) continue;
    const lines = stripComments(readFileSync(file, "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (KEY_PATH_PATTERNS.some((pattern) => pattern.test(line))) {
        found.push(`${relative(ROOT, file)}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  return found;
}

test("the detector sees both shapes it guards against (self-proof)", () => {
  for (const sample of ['join(dir, `${agentId}.key`)', 'join(dir, agentId + ".key")']) {
    expect(KEY_PATH_PATTERNS.some((pattern) => pattern.test(sample)), sample).toBe(true);
  }
});

test("the helper builds the `<id>.key` path (the guard is not vacuous)", () => {
  const helper = readFileSync(HELPER, "utf8");
  expect(helper).toContain("export function agentKeyPath(");
  expect(helper).toContain("join(keysDir, `${agentId}.key`)");
});

test("no src file outside the key-path helper builds an `<id>.key` path", () => {
  expect(offenders()).toEqual([]);
});
