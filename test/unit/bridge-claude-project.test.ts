import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeProjectMemoryBridge } from "../../src/bridges/builtins/claude-project";

// Minimal stub of BridgeContext
function fakeCtx() {
  const logs: Array<{ level: string; msg: string; meta?: any }> = [];
  return {
    fetch: globalThis.fetch,
    log: {
      debug: (msg: string, meta?: any) => logs.push({ level: "debug", msg, meta }),
      info:  (msg: string, meta?: any) => logs.push({ level: "info",  msg, meta }),
      warn:  (msg: string, meta?: any) => logs.push({ level: "warn",  msg, meta }),
      error: (msg: string, meta?: any) => logs.push({ level: "error", msg, meta }),
    },
    cache: {
      get: async () => null,
      set: async () => {},
      del: async () => {},
    },
    logs,
  };
}

async function collectMemories(opts: any, ctx: any) {
  const out: any[] = [];
  for await (const m of claudeProjectMemoryBridge.import!(opts, ctx)) {
    out.push(m);
  }
  return out;
}

describe("claude-project bridge: import", () => {
  it("imports memories from { memories: [...] } wrapper", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-claude-test-"));
    try {
      writeFileSync(join(dir, "memory.json"), JSON.stringify({
        memories: [
          { id: "abc", content: "User prefers dark mode", created_at: "2026-04-15T00:00:00Z" },
          { id: "def", content: "Project uses Bun runtime" },
        ],
      }));
      const ctx = fakeCtx();
      const out = await collectMemories({ source: dir }, ctx);
      expect(out).toHaveLength(2);
      expect(out[0].content).toBe("User prefers dark mode");
      expect(out[0].foreignId).toBe("claude-project:unknown:abc");
      expect(out[0].createdAt).toBe("2026-04-15T00:00:00Z");
      expect(out[0].tags).toContain("source:claude-project");
      expect(out[0].tags).toContain("import:claude-project");
      expect(out[0].durability).toBe("persistent");
      expect(out[1].foreignId).toBe("claude-project:unknown:def");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("uses project.json name for subject and foreignId", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-claude-test-"));
    try {
      writeFileSync(join(dir, "project.json"), JSON.stringify({
        name: "my-cool-project",
        description: "A test project",
      }));
      writeFileSync(join(dir, "memory.json"), JSON.stringify({
        memories: [
          { id: "x", content: "important fact about my-cool-project" },
        ],
      }));
      const out = await collectMemories({ source: dir }, fakeCtx());
      expect(out).toHaveLength(1);
      expect(out[0].content).toBe("important fact about my-cool-project");
      expect(out[0].foreignId).toBe("claude-project:my-cool-project:x");
      expect(out[0].subject).toBe("my-cool-project");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("imports from a top-level array (no wrapper)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-claude-test-"));
    try {
      writeFileSync(join(dir, "memory.json"), JSON.stringify([
        { id: "x", content: "raw array shape" },
      ]));
      const out = await collectMemories({ source: dir }, fakeCtx());
      expect(out).toHaveLength(1);
      expect(out[0].content).toBe("raw array shape");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("skips entries with empty/missing content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-claude-test-"));
    try {
      writeFileSync(join(dir, "memory.json"), JSON.stringify({
        memories: [
          { id: "good", content: "real content" },
          { id: "empty", content: "" },
          { id: "no-content-field" },
          { id: "whitespace", content: "   \n\t  " },
        ],
      }));
      const out = await collectMemories({ source: dir }, fakeCtx());
      expect(out).toHaveLength(1);
      expect(out[0].foreignId).toBe("claude-project:unknown:good");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("supports `text` field fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-claude-test-"));
    try {
      writeFileSync(join(dir, "memory.json"), JSON.stringify({
        memories: [
          { id: "1", text: "older export shape uses 'text'" },
        ],
      }));
      const out = await collectMemories({ source: dir }, fakeCtx());
      expect(out).toHaveLength(1);
      expect(out[0].content).toBe("older export shape uses 'text'");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("accepts a direct file path (not just a directory)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-claude-test-"));
    try {
      const filePath = join(dir, "custom-name.json");
      writeFileSync(filePath, JSON.stringify({ memories: [{ id: "1", content: "from custom path" }] }));
      const out = await collectMemories({ source: filePath }, fakeCtx());
      expect(out).toHaveLength(1);
      expect(out[0].content).toBe("from custom path");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("throws a helpful error when --source is missing", async () => {
    await expect(collectMemories({}, fakeCtx())).rejects.toThrow(/--source/);
  });

  it("throws a helpful error when source path does not exist", async () => {
    await expect(collectMemories({ source: "/nonexistent/path/that/should/not/exist" }, fakeCtx()))
      .rejects.toThrow(/could not resolve source/);
  });

  it("throws a helpful error when JSON is malformed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-claude-test-"));
    try {
      writeFileSync(join(dir, "memory.json"), "not valid json {");
      await expect(collectMemories({ source: dir }, fakeCtx())).rejects.toThrow(/JSON parse failed/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("throws a helpful error when document shape is unexpected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-claude-test-"));
    try {
      writeFileSync(join(dir, "memory.json"), JSON.stringify({ unrelated_field: "value" }));
      await expect(collectMemories({ source: dir }, fakeCtx())).rejects.toThrow(/unexpected shape/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("throws a friendly error when .zip path is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-claude-test-"));
    try {
      writeFileSync(join(dir, "export.zip"), "fake zip contents");
      await expect(collectMemories({ source: join(dir, "export.zip") }, fakeCtx()))
        .rejects.toThrow(/extract the .zip first/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("throws when memory.json is missing from directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-claude-test-"));
    try {
      // Dir exists but has no memory.json
      writeFileSync(join(dir, "other.json"), "{}");
      await expect(collectMemories({ source: dir }, fakeCtx()))
        .rejects.toThrow(/could not read source file/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("claude-project bridge: metadata", () => {
  it("registers as a 'file' kind builtin", () => {
    expect(claudeProjectMemoryBridge.name).toBe("claude-project");
    expect(claudeProjectMemoryBridge.kind).toBe("file");
    expect(claudeProjectMemoryBridge.version).toBe(1);
  });

  it("declares a `source` option", () => {
    expect(claudeProjectMemoryBridge.options?.source).toBeDefined();
    expect(claudeProjectMemoryBridge.options?.source.required).toBe(true);
  });

  it("does NOT declare an export side (one-way bridge)", () => {
    expect(claudeProjectMemoryBridge.export).toBeUndefined();
  });
});
