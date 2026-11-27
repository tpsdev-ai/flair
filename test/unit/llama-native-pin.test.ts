import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
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
  test("reads the platform native version harper-fabric-embeddings declares", () => {
    const lock = readFileSync(join(ROOT, "bun.lock"), "utf8");
    const manifest = JSON.parse(readFileSync(join(ROOT, "node_modules/harper-fabric-embeddings/package.json"), "utf8"));
    const declared = manifest.optionalDependencies["@node-llama-cpp/linux-x64"];
    expect(declared).toBe("3.18.1");
    expect(readLlamaNativeVersion(lock)).toBe(declared);
  });

  test("rejects a missing packages map with a named error", () => {
    expect(() => readLlamaNativeVersion('{}')).toThrow(/llama-native-version: missing or malformed packages map/);
  });

  test("rejects a missing embeddings entry despite a lookalike elsewhere", () => {
    const text = '{"packages": {}, "elsewhere": {\n"harper-fabric-embeddings": ["harper-fabric-embeddings@0.5.0"]}}';
    expect(() => readLlamaNativeVersion(text)).toThrow(/llama-native-version: missing packages\["harper-fabric-embeddings"\]/);
  });

  test("reads the declared pin despite a benchmark lookalike elsewhere", () => {
    const text = '{"packages": {\n"harper-fabric-embeddings": ["harper-fabric-embeddings@0.5.0", "", {\n"optionalDependencies": {"@node-llama-cpp/linux-x64": "3.18.1"}}]}, "elsewhere": {\n"node-llama-cpp": ["node-llama-cpp@3.22.3"]}}';
    expect(readLlamaNativeVersion(text)).toBe("3.18.1");
  });

  for (const entry of [null, {}, [], "harper-fabric-embeddings@0.5.0", [1], ["other@0.5.0"], ["harper-fabric-embeddings@0.5"], ["harper-fabric-embeddings@0.5.0"], ["harper-fabric-embeddings@0.5.0", "", null]]) {
    test(`rejects malformed embeddings entry ${JSON.stringify(entry)}`, () => {
      const text = JSON.stringify({ packages: { "harper-fabric-embeddings": entry } });
      expect(() => readLlamaNativeVersion(text)).toThrow(/llama-native-version: malformed packages\["harper-fabric-embeddings"\]/);
    });
  }

  test("rejects an embeddings entry that does not declare the platform native", () => {
    const text = JSON.stringify({ packages: { "harper-fabric-embeddings": ["harper-fabric-embeddings@0.5.0", "", { optionalDependencies: { "@node-llama-cpp/win-x64": "3.18.1" } }] } });
    expect(() => readLlamaNativeVersion(text)).toThrow(/does not declare @node-llama-cpp\/linux-x64/);
  });

  test("rejects a declared version that is not x.y.z", () => {
    const text = JSON.stringify({ packages: { "harper-fabric-embeddings": ["harper-fabric-embeddings@0.5.0", "", { optionalDependencies: { "@node-llama-cpp/linux-x64": "^3.18.1" } }] } });
    expect(() => readLlamaNativeVersion(text)).toThrow(/declared @node-llama-cpp\/linux-x64 "\^3\.18\.1" in bun\.lock is not x\.y\.z/);
  });

  test("preserves comma and closing brace inside a string while removing trailing commas", () => {
    const note = JSON.stringify('escaped " quote,} and slash \\,}');
    const text = `{"note": ${note}, "packages": {"harper-fabric-embeddings": ["harper-fabric-embeddings@0.5.0", "", {"optionalDependencies": {"@node-llama-cpp/linux-x64": "3.18.1",},},],},}`;
    expect(readLlamaNativeVersion(text)).toBe("3.18.1");
  });
});

describe("llama-installed-version real manifests", () => {
  for (const [label, root, name, version] of [
    ["native at install root", "", native, "3.18.1"],
    ["native under installed Flair", flair, native, "3.17.2"],
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
    expect(() => readLlamaInstalledPackage(dir)).toThrow(/was not found under the selected install directory/);
    const result = spawnSync("node", [join(ROOT, "scripts/ci/llama-installed-version.mjs"), dir], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("was not found under the selected install directory");
  });

  test("absence names the searched directory and packages", () => {
    const dir = fixture({});
    expect(() => readLlamaInstalledPackage(dir)).toThrow(
      `llama-installed-version: ${native} is not installed under ${dir} and harper-fabric-embeddings was not found under the selected install directory`,
    );
    const result = spawnSync("node", [join(ROOT, "scripts/ci/llama-installed-version.mjs"), dir], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`llama-installed-version: ${native} is not installed under ${dir}`);
  });

  test("does not fall back to a full node-llama-cpp package", () => {
    const dir = fixture(packageFiles("", "node-llama-cpp", "3.16.1"));
    expect(() => readLlamaInstalledPackage(dir)).toThrow(/is not installed under .* and harper-fabric-embeddings was not found under the selected install directory/);
  });

  test("reports the platform version harper-fabric-embeddings declares when the native is absent", () => {
    const dir = fixture({
      ...packageFiles(flair, "harper-fabric-embeddings", "0.5.0"),
    });
    writeFileSync(join(dir, nested, "package.json"), JSON.stringify({
      name: "harper-fabric-embeddings",
      version: "0.5.0",
      main: "index.js",
      optionalDependencies: { [native]: "3.18.1", "@node-llama-cpp/win-x64": "3.18.1" },
    }));
    const source = join(dir, nested, "package.json");
    expect(readLlamaInstalledPackage(dir)).toEqual({ version: "3.18.1", source });
    expect(readLlamaInstalledVersion(dir)).toBe("3.18.1");
    const result = spawnSync("node", [join(ROOT, "scripts/ci/llama-installed-version.mjs"), dir], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("3.18.1");
  });

  test("ignores a native package resolved from a parent node_modules", () => {
    const parent = fixture({
      ...packageFiles("", native, "9.9.9"),
      ...packageFiles("app/", "harper-fabric-embeddings", "0.5.0"),
    });
    const embeddings = join(parent, "app/node_modules/harper-fabric-embeddings/package.json");
    writeFileSync(embeddings, JSON.stringify({
      name: "harper-fabric-embeddings",
      version: "0.5.0",
      main: "index.js",
      optionalDependencies: { [native]: "3.18.1" },
    }));
    const dir = join(parent, "app");
    expect(readLlamaInstalledPackage(dir)).toEqual({ version: "3.18.1", source: embeddings });
  });

  test("ignores a manifest symlinked outside the install tree", () => {
    const outside = fixture(packageFiles("", native, "9.9.9"));
    const dir = fixture({ [`node_modules/${native}/index.js`]: "" });
    symlinkSync(join(outside, "node_modules", native, "package.json"), join(dir, "node_modules", native, "package.json"));
    expect(() => readLlamaInstalledPackage(dir)).toThrow(/is not installed under .* and harper-fabric-embeddings was not found under the selected install directory/);
  });

  test("skips an outside manifest whose canonicalization fails before reading it", () => {
    const outside = fixture(packageFiles("", native, "9.9.9"));
    const dir = fixture({ [`node_modules/${native}/index.js`]: "" });
    const candidate = join(dir, "node_modules", native, "package.json");
    symlinkSync(join(outside, "node_modules", native, "package.json"), candidate);
    expect(JSON.parse(readFileSync(candidate, "utf8")).version).toBe("9.9.9");
    const result = spawnSync("node", ["--input-type=module", "-e", `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const candidate = ${JSON.stringify(candidate)};
      const realpath = fs.realpathSync;
      const read = fs.readFileSync;
      let attempts = 0;
      let reads = 0;
      fs.realpathSync = function(path, ...args) {
        if (path === candidate) {
          attempts++;
          throw new Error("injected canonicalization failure");
        }
        return realpath.call(this, path, ...args);
      };
      fs.readFileSync = function(path, ...args) {
        if (path === candidate) reads++;
        return read.call(this, path, ...args);
      };
      syncBuiltinESMExports();
      const { readLlamaInstalledPackage } = await import(${JSON.stringify(join(ROOT, "scripts/ci/llama-installed-version.mjs"))});
      try {
        console.log(JSON.stringify(readLlamaInstalledPackage(${JSON.stringify(dir)})));
      } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
      }
      console.log(JSON.stringify({ attempts, reads }));
    `], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("harper-fabric-embeddings was not found under the selected install directory");
    expect(result.stdout).not.toContain("9.9.9");
    const probe = JSON.parse(result.stdout.trim());
    expect(probe.attempts).toBeGreaterThan(0);
    expect(probe.reads).toBe(0);
  });

  test("refusal scopes missing embeddings to the selected tree despite a parent installation", () => {
    const parent = fixture(packageFiles("", "harper-fabric-embeddings", "0.5.0"));
    const dir = join(parent, "app");
    mkdirSync(dir);
    const result = spawnSync("node", [join(ROOT, "scripts/ci/llama-installed-version.mjs"), dir], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(
      `llama-installed-version: ${native} is not installed under ${dir} and harper-fabric-embeddings was not found under the selected install directory`,
    );
  });

  test("install root precedes Flair", () => {
    const dir = fixture({
      ...packageFiles("", native, "3.11.0"),
      ...packageFiles(flair, native, "3.12.0"),
    });
    expect(readLlamaInstalledPackage(dir)).toEqual({
      version: "3.11.0", source: join(dir, "node_modules", native, "package.json"),
    });
  });

  test("nested embeddings native precedes hoisted native", () => {
    const dir = fixture({
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

  test("pins installer calls per workflow and the lint gate step", () => {
    for (const [file, count] of Object.entries({
      "test.yml": 7,
      "migration-ci-lanes.yml": 5,
      "smoke.yml": 1,
      "federation-compat.yml": 1,
    })) {
      const text = readFileSync(join(ROOT, ".github/workflows", file), "utf8");
      const calls = text.split(/\r?\n/).filter(line =>
        !line.trim().startsWith("#") && /\bnode\s+(?:"\$GITHUB_WORKSPACE\/)?scripts\/ci\/install-llama-native\.mjs\b/.test(line),
      );
      expect({ file, count: calls.length }).toEqual({ file, count });
    }
    const workflow = load(readFileSync(join(ROOT, ".github/workflows/test.yml"), "utf8")) as {
      jobs: Record<string, { steps: { run?: string }[] }>;
    };
    expect(workflow.jobs["cli-spawn-budgets"].steps.some(step =>
      step.run?.trim() === "node scripts/ci/check-llama-native-pin.mjs",
    )).toBe(true);
  });
});

describe("llama script declarations", () => {
  test.each(["llama-native-version", "llama-installed-version"])("%s.d.mts declares only names the module exports", async (name) => {
    const declared = [...readFileSync(join(ROOT, "scripts/ci", `${name}.d.mts`), "utf8")
      .matchAll(/^export (?:declare )?(?:const|function|let|var|class) ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    const mod = await import(join(ROOT, "scripts/ci", `${name}.mjs`));
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((n) => !(n in mod))).toEqual([]);
  });
});
