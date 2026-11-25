import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, readLlamaNativeVersion } from "../../scripts/ci/llama-native-version.mjs";
import { readLlamaInstalledPackage, readLlamaInstalledVersion } from "../../scripts/ci/llama-installed-version.mjs";
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
  return realpathSync(dir);
}

function packageFiles(root: string, name: string, version: string) {
  const base = `${root}node_modules/${name}`;
  return {
    [`${base}/package.json`]: JSON.stringify({ name, version, main: "index.js", exports: "./index.js" }),
    [`${base}/index.js`]: "",
  };
}

const native = "@node-llama-cpp/linux-x64";
const flair = "node_modules/@tpsdev-ai/flair/";
const nested = `${flair}node_modules/harper-fabric-embeddings/`;
const hoisted = "node_modules/harper-fabric-embeddings/";

describe("llama-native-version", () => {
  test("reads the resolution in the repository lockfile", () => {
    const lock = readFileSync(join(ROOT, "bun.lock"), "utf8");
    const resolved = lock.match(/"node-llama-cpp": \["node-llama-cpp@([^"]+)"/)?.[1];
    expect(resolved).toBeDefined();
    expect(readLlamaNativeVersion(lock)).toBe(resolved as string);
  });

  test("rejects a missing packages map with a named error", () => {
    expect(() => readLlamaNativeVersion('{}')).toThrow(/llama-native-version: missing or malformed packages map/);
  });

  test("rejects a missing packages entry despite a lookalike elsewhere", () => {
    const text = '{"packages": {}, "elsewhere": {\n"node-llama-cpp": ["node-llama-cpp@9.9.9"]}}';
    expect(() => readLlamaNativeVersion(text)).toThrow(/llama-native-version: missing packages\["node-llama-cpp"\]/);
  });

  test("reads the packages entry despite a lookalike elsewhere", () => {
    const text = '{"packages": {\n"node-llama-cpp": ["node-llama-cpp@3.22.3"]}, "elsewhere": {\n"node-llama-cpp": ["node-llama-cpp@9.9.9"]}}';
    expect(readLlamaNativeVersion(text)).toBe("3.22.3");
  });

  for (const entry of [null, {}, [], "node-llama-cpp@3.22.3", [1], ["other@3.22.3"], ["node-llama-cpp@3"], ["node-llama-cpp@3.22.3\n"]]) {
    test(`rejects malformed packages entry ${JSON.stringify(entry)}`, () => {
      const text = JSON.stringify({ packages: { "node-llama-cpp": entry } });
      expect(() => readLlamaNativeVersion(text)).toThrow(/llama-native-version: malformed packages\["node-llama-cpp"\]/);
    });
  }

  test("preserves comma and closing brace inside a string while removing trailing commas", () => {
    const note = JSON.stringify('escaped " quote,} and slash \\,}');
    const text = `{"note": ${note}, "packages": {"node-llama-cpp": ["node-llama-cpp@3.22.3",],},}`;
    expect(readLlamaNativeVersion(text)).toBe("3.22.3");
  });
});

describe("llama-installed-version real manifests", () => {
  for (const [label, root, name, version] of [
    ["native at install root", "", native, "3.18.1"],
    ["native under installed Flair", flair, native, "3.17.2"],
    ["family without native", "", "node-llama-cpp", "3.16.1"],
    ["hoisted embeddings", hoisted, native, "3.15.2"],
    ["nested embeddings", nested, native, "3.14.1"],
  ]) {
    test(label, () => {
      const dir = fixture(packageFiles(root, name, version));
      expect(readLlamaInstalledPackage(dir)).toEqual({
        version,
        source: join(dir, root, "node_modules", name, "package.json"),
      });
      expect(readLlamaInstalledVersion(dir)).toBe(version);
      const result = spawnSync("node", ["--input-type=module", "-e", `
        import { readLlamaInstalledPackage } from ${JSON.stringify(join(ROOT, "scripts/ci/llama-installed-version.mjs"))};
        console.log(JSON.stringify(readLlamaInstalledPackage(${JSON.stringify(dir)})));
      `], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        version, source: join(dir, root, "node_modules", name, "package.json"),
      });
    });
  }

  test("reads the package manifest when the entry point has a nested manifest", () => {
    const dir = fixture({
      [`node_modules/${native}/package.json`]: JSON.stringify({ name: native, version: "3.18.1", exports: "./dist/index.js" }),
      [`node_modules/${native}/dist/index.js`]: "",
      [`node_modules/${native}/dist/package.json`]: JSON.stringify({ name: native, version: "9.9.9" }),
    });
    const result = spawnSync("node", [join(ROOT, "scripts/ci/llama-installed-version.mjs"), dir], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("3.18.1");
  });

  test("rejects a scope manifest when the scoped package's own manifest is missing", () => {
    const dir = fixture({
      [`node_modules/${native}/index.js`]: "",
      "node_modules/@node-llama-cpp/package.json": JSON.stringify({ name: native, version: "9.9.9" }),
    });
    expect(() => readLlamaInstalledPackage(dir)).toThrow(/llama-installed-version: could not read .*own manifest/);
    const result = spawnSync("node", [join(ROOT, "scripts/ci/llama-installed-version.mjs"), dir], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("llama-installed-version: could not read");
  });

  test("absence names the searched directory and packages", () => {
    const dir = fixture({});
    expect(() => readLlamaInstalledPackage(dir)).toThrow(
      `llama-installed-version: ${native} and node-llama-cpp are not installed under ${dir}`,
    );
    const result = spawnSync("node", [join(ROOT, "scripts/ci/llama-installed-version.mjs"), dir], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`llama-installed-version: ${native} and node-llama-cpp are not installed under ${dir}`);
  });

  test("native precedes family; install root precedes Flair", () => {
    const dir = fixture({
      ...packageFiles("", "node-llama-cpp", "3.10.0"),
      ...packageFiles("", native, "3.11.0"),
      ...packageFiles(flair, native, "3.12.0"),
    });
    expect(readLlamaInstalledPackage(dir)).toEqual({
      version: "3.11.0", source: join(dir, "node_modules", native, "package.json"),
    });
  });

  test("native under Flair precedes root family; nested embeddings precede hoisted", () => {
    const dir = fixture({
      ...packageFiles("", "node-llama-cpp", "3.10.0"),
      ...packageFiles(nested, native, "3.12.0"),
      ...packageFiles(hoisted, native, "3.13.0"),
    });
    expect(readLlamaInstalledPackage(dir)).toEqual({
      version: "3.12.0", source: join(dir, nested, "node_modules", native, "package.json"),
    });
  });
});

describe("check-llama-native-pin", () => {
  for (const spec of ["@3", "@3.22.3", "@${VAR}", ""]) {
    test(`rejects direct spec ${spec || "(bare)"} with file:line`, () => {
      const dir = fixture({ "test.yml": `steps:\n  - run: bun add --no-save ${native}${spec}\n` });
      expect(checkWorkflows(dir)).toEqual([{ file: join(dir, "test.yml"), line: 2 }]);
      const result = spawnSync("node", [join(ROOT, "scripts/ci/check-llama-native-pin.mjs"), dir], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${join(dir, "test.yml")}:2:`);
    });
  }

  test("accepts a comment line", () => {
    const dir = fixture({ "test.yaml": `  # ${native}@3\n` });
    expect(checkWorkflows(dir)).toEqual([]);
  });

  test("accepts the repository workflows", () => {
    expect(checkWorkflows(join(ROOT, ".github/workflows"))).toEqual([]);
  });
});
