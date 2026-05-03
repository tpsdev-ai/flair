import { describe, test, expect } from "bun:test";
import {
  BUILTINS,
  BUILTIN_BY_NAME,
  builtinDiscoveryRecords,
} from "../../src/bridges/builtins";
import { agenticStackDescriptor } from "../../src/bridges/builtins/agentic-stack";
import { loadDescriptor } from "../../src/bridges/runtime/load-bridge";
import { discover } from "../../src/bridges/discover";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";

describe("builtins: registry", () => {
  test("BUILTINS includes agentic-stack", () => {
    const names = BUILTINS.map((b) => b.discovered.name);
    expect(names).toContain("agentic-stack");
  });

  test("BUILTIN_BY_NAME maps by discovered name", () => {
    const builtin = BUILTIN_BY_NAME.get("agentic-stack");
    expect(builtin).toBeDefined();
    // For yaml bridges, descriptorOrPlugin is the descriptor
    expect((builtin?.descriptorOrPlugin as any)?.name).toBe("agentic-stack");
    expect(BUILTIN_BY_NAME.get("does-not-exist")).toBeUndefined();
  });

  test("builtinDiscoveryRecords returns DiscoveredBridge entries with source=builtin", () => {
    const records = builtinDiscoveryRecords();
    expect(records.length).toBe(BUILTINS.length);
    for (const r of records) {
      expect(r.source).toBe("builtin");
      expect(r.name).toBeDefined();
      expect(r.kind).toBeDefined();
      expect(r.path).toMatch(/^\(builtin:/);
    }
  });
});

describe("builtins: agentic-stack descriptor shape", () => {
  test("has required top-level fields", () => {
    const builtin = BUILTIN_BY_NAME.get("agentic-stack");
    expect(builtin).toBeDefined();
    const d = builtin?.descriptorOrPlugin as any;
    expect(d.name).toBe("agentic-stack");
    expect(d.version).toBe(1);
    expect(d.kind).toBe("file");
    expect(d.description).toBeDefined();
  });

  test("declares detection paths", () => {
    const builtin = BUILTIN_BY_NAME.get("agentic-stack");
    const d = builtin?.descriptorOrPlugin as any;
    expect(d.detect?.anyExists).toContain(".agent/AGENTS.md");
  });

  test("import.sources maps content from $.claim", () => {
    const builtin = BUILTIN_BY_NAME.get("agentic-stack");
    const d = builtin?.descriptorOrPlugin as any;
    const src = d.import?.sources[0];
    expect(src).toBeDefined();
    expect(src?.path).toMatch(/lessons\.jsonl$/);
    expect(src?.format).toBe("jsonl");
    expect(src?.map.content).toBe("$.claim");
    expect(src?.map.foreignId).toBe("$.id");
    expect(src?.map.durability).toBe("persistent");
    expect(src?.map.source).toBe("agentic-stack/lessons");
  });
});

describe("builtins: loadDescriptor returns the registered descriptor", () => {
  test("agentic-stack via discovered record", async () => {
    const records = builtinDiscoveryRecords();
    const agentic = records.find((r) => r.name === "agentic-stack")!;
    const loaded = await loadDescriptor(agentic);
    expect(loaded?.name).toBe("agentic-stack");
  });
});

describe("builtins: discover() surfaces builtins ahead of YAML/npm", () => {
  test("agentic-stack appears in discover() when builtins option is passed", async () => {
    // Empty sandbox — only built-ins should surface
    const sb = join(tmpdir(), `flair-builtins-disco-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(sb, { recursive: true });
    try {
      const found = await discover({
        cwd: sb,
        home: sb,
        moduleRoots: [],
        builtins: builtinDiscoveryRecords(),
      });
      const names = found.map((b) => b.name);
      expect(names).toContain("agentic-stack");
      const ag = found.find((b) => b.name === "agentic-stack")!;
      expect(ag.source).toBe("builtin");
    } finally {
      rmSync(sb, { recursive: true, force: true });
    }
  });
});
