import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadBridge } from "../../src/bridges/runtime/load-bridge";
import { allow } from "../../src/bridges/runtime/allow-list";
import { BridgeRuntimeError } from "../../src/bridges/types";
import type { DiscoveredBridge, MemoryBridge } from "../../src/bridges/types";

function sandbox(): { dir: string; cleanup: () => void; makePackage: (name: string) => string } {
  const dir = realpathSync(tmpdir());
  const root = join(dir, `flair-loadbridge-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  return {
    dir: root,
    makePackage: (name: string) => {
      const pkgDir = join(root, `pkg-${name}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({ name: `flair-bridge-${name}`, version: "1.0.0" }, null, 2),
      );
      return pkgDir;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const codePlugin: MemoryBridge = {
  name: "mem0",
  version: 1,
  kind: "api",
  async *import() { yield { content: "hi" }; },
};

describe("loadBridge: dispatch by source", () => {
  let sb: ReturnType<typeof sandbox>;
  beforeEach(() => { sb = sandbox(); });
  afterEach(() => sb.cleanup());

  test("builtin → kind=yaml + descriptor from registry", async () => {
    const d: DiscoveredBridge = { name: "agentic-stack", kind: "file", source: "builtin", path: "(builtin:agentic-stack)" };
    const loaded = await loadBridge(d);
    expect(loaded.kind).toBe("yaml");
    if (loaded.kind === "yaml") expect(loaded.descriptor.name).toBe("agentic-stack");
  });

  test("project-yaml → kind=yaml + parsed descriptor", async () => {
    const p = join(sb.dir, "b.yaml");
    writeFileSync(p, `name: project\nversion: 1\nkind: file\nimport:\n  sources:\n    - {path: a, format: jsonl, map: {content: "$.c"}}\n`);
    const d: DiscoveredBridge = { name: "project", kind: "file", source: "project-yaml", path: p };
    const loaded = await loadBridge(d);
    expect(loaded.kind).toBe("yaml");
    if (loaded.kind === "yaml") expect(loaded.descriptor.name).toBe("project");
  });

  test("npm-package without allow-list entry → BridgeRuntimeError pointing at `flair bridge allow`", async () => {
    const pkg = sb.makePackage("mem0");
    const d: DiscoveredBridge = { name: "mem0", kind: "api", source: "npm-package", path: pkg };
    const allowPath = join(sb.dir, "bridges-allowed.json");
    let thrown: any = null;
    try {
      await loadBridge(d, { allowListPath: allowPath });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
    expect(thrown.detail.hint).toMatch(/flair bridge allow mem0/);
    expect(thrown.detail.got).toBe("not-allowed");
  });

  test("npm-package with matching allow-list entry → kind=code + loaded plugin", async () => {
    const pkg = sb.makePackage("mem0");
    const allowPath = join(sb.dir, "bridges-allowed.json");
    await allow("mem0", pkg, { path: allowPath });
    const d: DiscoveredBridge = { name: "mem0", kind: "api", source: "npm-package", path: pkg };
    const loaded = await loadBridge(d, { allowListPath: allowPath, importer: async () => ({ bridge: codePlugin }) });
    expect(loaded.kind).toBe("code");
    if (loaded.kind === "code") expect(loaded.plugin.name).toBe("mem0");
  });

  test("npm-package with allow entry but squatted path → refused with path-mismatch hint", async () => {
    const real = sb.makePackage("mem0");
    const squat = sb.makePackage("mem0"); // different dir, same short name
    const allowPath = join(sb.dir, "bridges-allowed.json");
    await allow("mem0", real, { path: allowPath });
    const d: DiscoveredBridge = { name: "mem0", kind: "api", source: "npm-package", path: squat };
    let thrown: any = null;
    try {
      await loadBridge(d, { allowListPath: allowPath, importer: async () => ({ bridge: codePlugin }) });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
    expect(thrown.detail.got).toBe("path-mismatch");
    expect(thrown.detail.hint).toMatch(/squatting/);
    expect(thrown.detail.hint).toMatch(/flair bridge allow mem0/);
  });

  test("npm-package with allow entry but modified package.json → refused with digest-mismatch hint", async () => {
    const pkg = sb.makePackage("mem0");
    const allowPath = join(sb.dir, "bridges-allowed.json");
    await allow("mem0", pkg, { path: allowPath });
    // Tamper with package.json after approval
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "flair-bridge-mem0", version: "9.9.9", backdoor: true }, null, 2));
    const d: DiscoveredBridge = { name: "mem0", kind: "api", source: "npm-package", path: pkg };
    let thrown: any = null;
    try {
      await loadBridge(d, { allowListPath: allowPath, importer: async () => ({ bridge: codePlugin }) });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
    expect(thrown.detail.got).toBe("digest-mismatch");
    expect(thrown.detail.hint).toMatch(/package\.json contents changed/);
  });

  test("skipAllowCheck=true bypasses the allow-list (used by `bridge list`)", async () => {
    const pkg = sb.makePackage("mem0");
    const d: DiscoveredBridge = { name: "mem0", kind: "api", source: "npm-package", path: pkg };
    const loaded = await loadBridge(d, { skipAllowCheck: true, importer: async () => ({ bridge: codePlugin }) });
    expect(loaded.kind).toBe("code");
  });

  test("builtin with an unknown name (registry drift) throws", async () => {
    const d: DiscoveredBridge = { name: "ghost", kind: "file", source: "builtin", path: "(builtin:ghost)" };
    let thrown: any = null;
    try { await loadBridge(d); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
  });
});
