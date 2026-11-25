// The @node-llama-cpp native-binary pin gate (flair#3133).
//
// Every workflow install must name the exact version `node-llama-cpp` resolves
// to in bun.lock. These tests cover the version reader and the scan; the gate
// itself runs over the repository's real workflows.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, readLlamaNativeVersion } from "../../scripts/ci/llama-native-version.mjs";
import { checkWorkflows } from "../../scripts/ci/check-llama-native-pin.mjs";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "flair-llama-pin-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

const realLock = () => readFileSync(join(ROOT, "bun.lock"), "utf8");

describe("llama-native-version", () => {
  test("reads the version node-llama-cpp resolves to in the real bun.lock", () => {
    const lock = realLock();
    const resolved = lock.match(/"node-llama-cpp": \["node-llama-cpp@([^"]+)"/)?.[1];
    expect(resolved).toBeDefined();
    expect(readLlamaNativeVersion(lock)).toBe(resolved as string);
    expect(readLlamaNativeVersion(lock)).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("fails with a named error when no resolved entry exists", () => {
    // A workspace declaration is not a resolution.
    const text = '{\n  "workspaces": { "": { "dependencies": { "node-llama-cpp": "3.22.3" } } },\n}\n';
    expect(() => readLlamaNativeVersion(text)).toThrow(/expected exactly one resolved "node-llama-cpp" entry/);
    expect(() => readLlamaNativeVersion(text)).toThrow(/found 0/);
  });

  test("fails with a named error when two resolved entries exist", () => {
    const entry = (version: string) => `    "node-llama-cpp": ["node-llama-cpp@${version}", "", {}, "sha512-x"],`;
    const text = `{\n  "packages": {\n${entry("3.22.3")}\n${entry("3.21.0")}\n  },\n}\n`;
    expect(() => readLlamaNativeVersion(text)).toThrow(/found 2/);
  });
});

describe("check-llama-native-pin", () => {
  const expected = "3.22.3";
  const workflow = (install: string) =>
    `name: fixture\njobs:\n  build:\n    steps:\n      - run: ${install}\n`;

  for (const [label, version] of [
    ["a floating major (@3)", "@3"],
    ["a range (@^3.22.0)", "@^3.22.0"],
    ["the latest tag (@latest)", "@latest"],
  ] as const) {
    test(`flags ${label} with file:line`, () => {
      const dir = fixture({ "test.yml": workflow(`bun add --no-save @node-llama-cpp/linux-x64${version}`) });
      const result = checkWorkflows(dir, expected);
      expect(result.installs).toBe(1);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].file.endsWith("test.yml")).toBe(true);
      expect(result.violations[0].line).toBe(5);
      expect(result.violations[0].version).toBe(version.slice(1));
    });
  }

  test("flags a bare package name with file:line", () => {
    const dir = fixture({ "test.yml": workflow("bun add --no-save @node-llama-cpp/linux-x64") });
    const result = checkWorkflows(dir, expected);
    expect(result.installs).toBe(1);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].line).toBe(5);
    expect(result.violations[0].version).toBeNull();
  });

  test("accepts the lockfile-pinned form", () => {
    const dir = fixture({ "test.yml": workflow(`npm install --no-save @node-llama-cpp/linux-x64@${expected}`) });
    const result = checkWorkflows(dir, expected);
    expect(result.installs).toBe(1);
    expect(result.violations).toEqual([]);
  });

  test("the repository's real workflows are all pinned", () => {
    const result = checkWorkflows(join(ROOT, ".github/workflows"), readLlamaNativeVersion(realLock()));
    expect(result.installs).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  });
});
