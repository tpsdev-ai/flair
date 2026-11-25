// The @node-llama-cpp native-binary pin gate (flair#3133).
//
// Every workflow install must read its version at run time: from bun.lock in
// this checkout, or from the node-llama-cpp install in an npm-installed
// directory. These tests cover the version readers and the scan; the gate
// itself runs over the repository's real workflows.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, readLlamaNativeVersion } from "../../scripts/ci/llama-native-version.mjs";
import { readLlamaInstalledVersion } from "../../scripts/ci/llama-installed-version.mjs";
import { checkWorkflows } from "../../scripts/ci/check-llama-native-pin.mjs";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "flair-llama-pin-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const realLock = () => readFileSync(join(ROOT, "bun.lock"), "utf8");

describe("llama-native-version", () => {
  test("reads the version node-llama-cpp resolves to in the real bun.lock", () => {
    const lock = realLock();
    const resolved = lock.match(/"node-llama-cpp": \["node-llama-cpp@([^"]+)"/)?.[1];
    expect(resolved).toBeDefined();
    expect(readLlamaNativeVersion(lock)).toBe(resolved as string);
    expect(readLlamaNativeVersion(lock)).toMatch(/^\d+\.\d+\.\d+$/);
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

describe("llama-installed-version", () => {
  const native = (version: string) => ({
    [`node_modules/@node-llama-cpp/linux-x64/package.json`]: JSON.stringify({
      name: "@node-llama-cpp/linux-x64",
      version,
      main: "index.js",
    }),
    "node_modules/@node-llama-cpp/linux-x64/index.js": "",
  });

  test("reads the platform package installed in the directory", () => {
    const dir = fixture(native("3.18.1"));
    expect(readLlamaInstalledVersion(dir)).toBe("3.18.1");
  });

  test("reads a platform package nested under the installed flair", () => {
    const dir = fixture({
      "node_modules/@tpsdev-ai/flair/package.json": JSON.stringify({ name: "@tpsdev-ai/flair", version: "0.62.0" }),
      "node_modules/@tpsdev-ai/flair/node_modules/@node-llama-cpp/linux-x64/package.json": JSON.stringify({
        name: "@node-llama-cpp/linux-x64",
        version: "3.17.2",
        main: "index.js",
      }),
      "node_modules/@tpsdev-ai/flair/node_modules/@node-llama-cpp/linux-x64/index.js": "",
    });
    expect(readLlamaInstalledVersion(dir)).toBe("3.17.2");
  });

  test("fails with a named error when nothing is installed there", () => {
    const dir = fixture({ "node_modules/@tpsdev-ai/flair/package.json": JSON.stringify({ name: "@tpsdev-ai/flair" }) });
    expect(() => readLlamaInstalledVersion(dir)).toThrow(
      /llama-installed-version: @node-llama-cpp\/linux-x64 and node-llama-cpp are not installed under/,
    );
  });
});

describe("check-llama-native-pin", () => {
  const single = (install: string) =>
    `name: fixture\njobs:\n  build:\n    steps:\n      - name: install\n        run: ${install}\n`;
  const block = (lines: string[]) =>
    `name: fixture\njobs:\n  build:\n    steps:\n      - name: install\n        run: |\n${lines
      .map(line => `          ${line}`)
      .join("\n")}\n`;

  for (const [label, version] of [
    ["a literal lockfile version (@3.22.3)", "@3.22.3"],
    ["a floating major (@3)", "@3"],
    ["a range (@^3.22.0)", "@^3.22.0"],
    ["the latest tag (@latest)", "@latest"],
  ] as const) {
    test(`flags ${label} with file:line`, () => {
      const dir = fixture({ "test.yml": single(`bun add --no-save @node-llama-cpp/linux-x64${version}`) });
      const result = checkWorkflows(dir);
      expect(result.installs).toBe(1);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].file.endsWith("test.yml")).toBe(true);
      expect(result.violations[0].line).toBe(6);
      expect(result.violations[0].version).toBe(version.slice(1));
    });
  }

  test("flags a bare package name with file:line", () => {
    const dir = fixture({ "test.yml": single("bun add --no-save @node-llama-cpp/linux-x64") });
    const result = checkWorkflows(dir);
    expect(result.installs).toBe(1);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].line).toBe(6);
    expect(result.violations[0].version).toBeNull();
  });

  test("accepts the checkout form: variable from llama-native-version, format-checked", () => {
    const dir = fixture({
      "test.yml": block([
        'LLAMA_NATIVE_VERSION="$(node scripts/ci/llama-native-version.mjs)"',
        '[[ "$LLAMA_NATIVE_VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]] || { echo "::error::bad"; exit 1; }',
        'bun add --no-save "@node-llama-cpp/linux-x64@${LLAMA_NATIVE_VERSION}"',
      ]),
    });
    expect(checkWorkflows(dir)).toEqual({ installs: 1, violations: [] });
  });

  test("accepts the npm-directory form: variable from llama-installed-version, format-checked", () => {
    const dir = fixture({
      "test.yml": block([
        'LLAMA_NATIVE_VERSION="$(node "$GITHUB_WORKSPACE/scripts/ci/llama-installed-version.mjs" "$BASE_DIR")"',
        '[[ "$LLAMA_NATIVE_VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]] || { echo "::error::bad"; exit 1; }',
        '( cd "$BASE_DIR" && npm install --no-save "@node-llama-cpp/linux-x64@${LLAMA_NATIVE_VERSION}" )',
      ]),
    });
    expect(checkWorkflows(dir)).toEqual({ installs: 1, violations: [] });
  });

  test("accepts either script inline", () => {
    const dir = fixture({
      "a.yml": single('bun add --no-save "@node-llama-cpp/linux-x64@$(node scripts/ci/llama-native-version.mjs)"'),
      "b.yml": single(
        'npm install --no-save "@node-llama-cpp/linux-x64@$(node scripts/ci/llama-installed-version.mjs \"$BASE_DIR\")"',
      ),
    });
    const result = checkWorkflows(dir);
    expect(result.installs).toBe(2);
    expect(result.violations).toEqual([]);
  });

  test("flags a variable that is not format-checked before the install", () => {
    const dir = fixture({
      "test.yml": block([
        'LLAMA_NATIVE_VERSION="$(node scripts/ci/llama-native-version.mjs)"',
        'bun add --no-save "@node-llama-cpp/linux-x64@${LLAMA_NATIVE_VERSION}"',
      ]),
    });
    const result = checkWorkflows(dir);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].reason).toMatch(/not checked against \^x\.y\.z\$/);
  });

  test("flags a variable set from a command other than the version scripts", () => {
    const dir = fixture({
      "test.yml": block([
        'LLAMA_NATIVE_VERSION="$(npm view node-llama-cpp version)"',
        '[[ "$LLAMA_NATIVE_VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]] || { echo "::error::bad"; exit 1; }',
        'bun add --no-save "@node-llama-cpp/linux-x64@${LLAMA_NATIVE_VERSION}"',
      ]),
    });
    const result = checkWorkflows(dir);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].reason).toMatch(/not set from a version script in this step/);
  });

  test("flags a variable assigned in an earlier step", () => {
    const dir = fixture({
      "test.yml": `name: fixture\njobs:\n  build:\n    steps:\n      - name: version\n        run: |\n          LLAMA_NATIVE_VERSION="$(node scripts/ci/llama-native-version.mjs)"\n          [[ "$LLAMA_NATIVE_VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]] || exit 1\n      - name: install\n        run: bun add --no-save "@node-llama-cpp/linux-x64@\${LLAMA_NATIVE_VERSION}"\n`,
    });
    const result = checkWorkflows(dir);
    expect(result.violations).toHaveLength(1);
  });

  test("counts every install in a line", () => {
    const dir = fixture({
      "test.yml": single(
        'bun add --no-save "@node-llama-cpp/linux-x64@$(node scripts/ci/llama-native-version.mjs)" "@node-llama-cpp/mac-arm64-metal@3.22.3"',
      ),
    });
    const result = checkWorkflows(dir);
    expect(result.installs).toBe(2);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].platform).toBe("mac-arm64-metal");
  });

  test("the repository's real workflows are all run-time reads", () => {
    const result = checkWorkflows(join(ROOT, ".github/workflows"));
    expect(result.installs).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  });
});
