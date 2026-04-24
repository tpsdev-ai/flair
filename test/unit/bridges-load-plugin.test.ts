import { describe, test, expect } from "bun:test";
import { loadCodePlugin } from "../../src/bridges/runtime/load-plugin";
import type { DiscoveredBridge, MemoryBridge } from "../../src/bridges/types";
import { BridgeRuntimeError } from "../../src/bridges/types";

const discovered = (overrides: Partial<DiscoveredBridge> = {}): DiscoveredBridge => ({
  name: "example",
  kind: "api",
  source: "npm-package",
  path: "/fake/path/flair-bridge-example",
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
  });

  test("rejects when module has no bridge export", async () => {
    let thrown: any = null;
    try {
      await loadCodePlugin(discovered(), { importer: async () => ({ notABridge: true }) });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
    expect(thrown.detail.field).toBe("exports");
  });

  test("rejects when bridge.name mismatches the package name", async () => {
    const mod = { bridge: { ...validBridge, name: "different-name" } };
    let thrown: any = null;
    try {
      await loadCodePlugin(discovered(), { importer: async () => mod });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
    expect(thrown.detail.field).toBe("name");
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
  });

  test("rejects a bridge with neither import nor export methods (surfaces as no-bridge-export)", async () => {
    // When a module's bridge candidate has no import/export, isBridgeLike
    // returns false — we can't tell it apart from "not a bridge at all" —
    // so we surface as the exports error. Either field is acceptable;
    // what matters is the operator sees *something* with enough context.
    const mod = { bridge: { name: "example", version: 1, kind: "api" } };
    let thrown: any = null;
    try {
      await loadCodePlugin(discovered(), { importer: async () => mod as any });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
    expect(thrown.detail.field).toBe("exports");
  });
});
