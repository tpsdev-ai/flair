import { beforeEach, describe, test, expect, mock } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tempDir } from "../helpers/temp-dir";
import { loadCodePlugin } from "../../src/bridges/runtime/load-plugin";
import type { DiscoveredBridge, MemoryBridge } from "../../src/bridges/types";
import { BridgeRuntimeError } from "../../src/bridges/types";

let packageDir: string;
beforeEach(() => {
  packageDir = tempDir("flair-bridge-loader-");
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(packageDir, "index.js"), "");
});

const discovered = (overrides: Partial<DiscoveredBridge> = {}): DiscoveredBridge => ({
  name: "example",
  kind: "api",
  source: "npm-package",
  path: packageDir,
  ...overrides,
});

const validBridge: MemoryBridge = {
  name: "example",
  version: 1,
  kind: "api",
  async *import() { yield { content: "hi" }; },
};

describe("loadCodePlugin: happy paths", () => {
  test("picks up a named `bridge` export", async () => {
    const mod = { bridge: validBridge };
    const result = await loadCodePlugin(discovered(), { importer: async () => mod });
    expect(result.name).toBe("example");
  });

  test("picks up a default export", async () => {
    const mod = { default: validBridge };
    const result = await loadCodePlugin(discovered(), { importer: async () => mod });
    expect(result.name).toBe("example");
  });

  test("picks up when the module itself is the bridge", async () => {
    const result = await loadCodePlugin(discovered(), { importer: async () => validBridge });
    expect(result.name).toBe("example");
  });
});

describe("loadCodePlugin: rejections", () => {
  test("rejects non-npm-package sources", async () => {
    let thrown: any = null;
    try {
      await loadCodePlugin(discovered({ source: "project-yaml" }));
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
    expect(thrown.detail.field).toBe("source");
    expect(thrown.detail.expected).toBe("npm-package");
    expect(thrown.detail.hint).toMatch(/Shape B/);
  });

  test("rejects when dynamic import fails (package missing)", async () => {
    let thrown: any = null;
    try {
      await loadCodePlugin(discovered(), {
        importer: async () => { throw new Error("ENOENT: no such package"); },
      });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
    expect(thrown.detail.field).toBe("(import)");
    expect(thrown.detail.expected).toBe("importable npm package");
    expect(thrown.detail.got).toBe("import error");
    expect(thrown.detail.hint).toContain("ENOENT: no such package");
  });

  test("rejects when module has no bridge export", async () => {
    let thrown: any = null;
    try {
      await loadCodePlugin(discovered(), { importer: async () => ({ notABridge: true }) });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
    expect(thrown.detail.field).toBe("exports");
    expect(thrown.detail.expected).toBe("named `bridge` export or default export implementing MemoryBridge");
    expect(thrown.detail.got).toBe("exports=notABridge");
  });

  test("rejects when bridge.name mismatches the package name", async () => {
    const mod = { bridge: { ...validBridge, name: "different-name" } };
    let thrown: any = null;
    try {
      await loadCodePlugin(discovered(), { importer: async () => mod });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
    expect(thrown.detail.field).toBe("name");
    expect(thrown.detail.expected).toBe('"example" (from package name flair-bridge-example)');
    expect(thrown.detail.got).toBe('"different-name"');
    expect(thrown.detail.hint).toMatch(/must match/);
  });

  test("rejects when kind is invalid", async () => {
    const mod = { bridge: { ...validBridge, kind: "unknown" } };
    let thrown: any = null;
    try {
      await loadCodePlugin(discovered(), { importer: async () => mod as any });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
    expect(thrown.detail.field).toBe("kind");
    expect(thrown.detail.expected).toBe('"file" | "api"');
    expect(thrown.detail.got).toBe('"unknown"');
  });

  test("rejects a bridge with neither import nor export methods (surfaces as no-bridge-export)", async () => {
    const mod = { bridge: { name: "example", version: 1, kind: "api" } };
    let thrown: any = null;
    try {
      await loadCodePlugin(discovered(), { importer: async () => mod as any });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
    expect(thrown.detail.field).toBe("exports");
    expect(thrown.detail.expected).toBe("named `bridge` export or default export implementing MemoryBridge");
    expect(thrown.detail.got).toBe("exports=bridge");
  });
});

describe("loadCodePlugin: package entry files", () => {
  test.each([
    ["exports string", { exports: "./entry.mjs", main: "wrong.mjs" }],
    ["exports dot string", { exports: { ".": "./entry.mjs" }, main: "wrong.mjs" }],
    ["exports import before default", { exports: { ".": { default: "./wrong.mjs", import: "./entry.mjs" } } }],
    ["exports nested import", { exports: { ".": { import: { default: "./entry.mjs" }, default: "./wrong.mjs" } } }],
    ["exports nested default", { exports: { ".": { require: "./wrong.cjs", default: { import: "./entry.mjs" } } } }],
    ["exports root conditions", { exports: { import: "./entry.mjs", default: "./wrong.mjs" } }],
    ["main only", { main: "entry.mjs" }],
  ])("loads %s", async (_name, metadata) => {
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ type: "module", ...metadata }));
    writeFileSync(join(packageDir, "entry.mjs"), `export const bridge = {
      name: "example", version: 1, kind: "api", async *import() {}
    };`);
    const bridge = await loadCodePlugin(discovered());
    expect(bridge.name).toBe("example");
  });

  test("uses index.js when exports and main are absent", async () => {
    let spec: string | undefined;
    await loadCodePlugin(discovered(), { importer: async (value) => {
      spec = value;
      return { bridge: validBridge };
    } });
    expect(spec).toBe(pathToFileURL(realpathSync(join(packageDir, "index.js"))).href);
  });

  test.each(["exports", "main"])("refuses an escaping %s entry before import", async (field) => {
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ [field]: "../outside.mjs" }));
    let imported = false;
    try {
      await loadCodePlugin(discovered(), { importer: async () => { imported = true; return { bridge: validBridge }; } });
      throw new Error("accepted escaping entry");
    } catch (error) {
      expect(error).toBeInstanceOf(BridgeRuntimeError);
      expect((error as BridgeRuntimeError).detail.field).toBe(field);
      expect((error as BridgeRuntimeError).detail.expected).toBe("entry inside package directory");
      expect((error as BridgeRuntimeError).detail.got).toBe("../outside.mjs");
    }
    expect(imported).toBe(false);
  });

  test("refuses an entry symlink outside the package", async () => {
    const outside = tempDir("flair-bridge-outside-");
    writeFileSync(join(outside, "entry.mjs"), `export const bridge = {
      name: "example", version: 1, kind: "api", async *import() {}
    };`);
    symlinkSync(join(outside, "entry.mjs"), join(packageDir, "linked.mjs"));
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ exports: "./linked.mjs" }));
    const importer = mock((spec: string) => import(spec));
    const error = await loadCodePlugin(discovered(), { importer }).catch((error) => error);
    expect(importer).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(BridgeRuntimeError);
    expect(error.detail.field).toBe("exports");
    expect(error.detail.expected).toBe("entry inside package directory");
    expect(error.detail.got).toBe("./linked.mjs");
  });

  test("loads a package discovered through a directory symlink", async () => {
    const parent = tempDir("flair-bridge-link-");
    mkdirSync(join(packageDir, "lib"));
    writeFileSync(join(packageDir, "lib", "entry.mjs"), `export default {
      name: "example", version: 1, kind: "api", async *import() {}
    };`);
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ main: "lib/entry.mjs" }));
    const link = join(parent, "plugin");
    symlinkSync(packageDir, link, "dir");
    expect((await loadCodePlugin(discovered({ path: link }))).name).toBe("example");
  });

  test("reports a missing entry with the import error shape", async () => {
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ main: "missing.mjs" }));
    try {
      await loadCodePlugin(discovered());
      throw new Error("accepted missing entry");
    } catch (error) {
      expect(error).toBeInstanceOf(BridgeRuntimeError);
      const detail = (error as BridgeRuntimeError).detail;
      expect(detail.field).toBe("(import)");
      expect(detail.expected).toBe("importable npm package");
      expect(detail.got).toBe("ENOENT");
      expect(detail.path).toBe(packageDir);
    }
  });
});
