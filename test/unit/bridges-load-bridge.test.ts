import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadBridge } from "../../src/bridges/runtime/load-bridge";
import { BridgeRuntimeError } from "../../src/bridges/types";
import type { DiscoveredBridge, MemoryBridge } from "../../src/bridges/types";

function sandbox(): { dir: string; cleanup: () => void } {
  const dir = join(tmpdir(), `flair-loadbridge-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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
    const d: DiscoveredBridge = { name: "mem0", kind: "api", source: "npm-package", path: "/fake" };
    const allowPath = join(sb.dir, "bridges-allowed.json");
    let thrown: any = null;
    try {
      await loadBridge(d, { allowListPath: allowPath });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
    expect(thrown.detail.hint).toMatch(/flair bridge allow mem0/);
  });

  test("npm-package with allow-list entry → kind=code + loaded plugin", async () => {
    const allowPath = join(sb.dir, "bridges-allowed.json");
    writeFileSync(allowPath, JSON.stringify({ allowed: [{ name: "mem0", allowedAt: new Date().toISOString() }] }));
    const d: DiscoveredBridge = { name: "mem0", kind: "api", source: "npm-package", path: "/fake" };
    const loaded = await loadBridge(d, { allowListPath: allowPath, importer: async () => ({ bridge: codePlugin }) });
    expect(loaded.kind).toBe("code");
    if (loaded.kind === "code") expect(loaded.plugin.name).toBe("mem0");
  });

  test("skipAllowCheck=true bypasses the allow-list (used by `bridge list`)", async () => {
    const d: DiscoveredBridge = { name: "mem0", kind: "api", source: "npm-package", path: "/fake" };
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
