import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We import from the dist'd plugin to mirror how the bridge runtime loads
// it at runtime. That said, the parsing logic is pure — we exercise it
// directly via the same code path.
import { chatgptMemoryBridge } from "../../src/bridges/builtins/chatgpt";

// Minimal stub of BridgeContext. The chatgpt bridge only uses ctx.log and
// ctx.fetch (transitively, via no actual external HTTP — chatgpt is file-only).
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
    logs, // exposed for assertions
  };
}

async function collectMemories(opts: any, ctx: any) {
  const out: any[] = [];
  for await (const m of chatgptMemoryBridge.import!(opts, ctx)) {
    out.push(m);
  }
  return out;
}

describe("chatgpt bridge: import", () => {
  it("imports memories from { memories: [...] } wrapper", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-chatgpt-test-"));
    try {
      writeFileSync(join(dir, "memory.json"), JSON.stringify({
        memories: [
          { id: "abc", content: "User uses TypeScript", created_at: "2026-04-15T00:00:00Z" },
          { id: "def", content: "User runs newton on M3 Ultra" },
        ],
      }));
      const ctx = fakeCtx();
      const out = await collectMemories({ source: dir }, ctx);
      expect(out).toHaveLength(2);
      expect(out[0].content).toBe("User uses TypeScript");
      expect(out[0].foreignId).toBe("chatgpt:abc");
      expect(out[0].createdAt).toBe("2026-04-15T00:00:00Z");
      expect(out[0].tags).toContain("source:chatgpt");
      expect(out[0].tags).toContain("import:chatgpt");
      expect(out[0].durability).toBe("persistent");
      expect(out[1].foreignId).toBe("chatgpt:def");
      expect(out[1].createdAt).toBeUndefined(); // missing in fixture
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("imports from a top-level array (no wrapper)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-chatgpt-test-"));
    try {
      writeFileSync(join(dir, "memory.json"), JSON.stringify([
        { id: "x", content: "raw array shape" },
      ]));
      const out = await collectMemories({ source: dir }, fakeCtx());
      expect(out).toHaveLength(1);
      expect(out[0].content).toBe("raw array shape");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("supports `text` and `body` field-name fallbacks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-chatgpt-test-"));
    try {
      writeFileSync(join(dir, "memory.json"), JSON.stringify({
        memories: [
          { id: "1", text: "older export shape uses 'text'" },
          { id: "2", body: "even older 'body'" },
        ],
      }));
      const out = await collectMemories({ source: dir }, fakeCtx());
      expect(out).toHaveLength(2);
      expect(out[0].content).toBe("older export shape uses 'text'");
      expect(out[1].content).toBe("even older 'body'");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("accepts a bare-string memory entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-chatgpt-test-"));
    try {
      writeFileSync(join(dir, "memory.json"), JSON.stringify(["bare string memory"]));
      const out = await collectMemories({ source: dir }, fakeCtx());
      expect(out).toHaveLength(1);
      expect(out[0].content).toBe("bare string memory");
      // bare-string entries get an idx-based foreignId
      expect(out[0].foreignId).toBe("chatgpt:idx-0");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("skips entries with empty/missing content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-chatgpt-test-"));
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
      expect(out[0].foreignId).toBe("chatgpt:good");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("accepts a direct file path (not just a directory)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-chatgpt-test-"));
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
    const dir = mkdtempSync(join(tmpdir(), "flair-chatgpt-test-"));
    try {
      writeFileSync(join(dir, "memory.json"), "not valid json {");
      await expect(collectMemories({ source: dir }, fakeCtx())).rejects.toThrow(/JSON parse failed/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("throws a helpful error when document shape is unexpected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-chatgpt-test-"));
    try {
      writeFileSync(join(dir, "memory.json"), JSON.stringify({ unrelated_field: "value" }));
      await expect(collectMemories({ source: dir }, fakeCtx())).rejects.toThrow(/unexpected shape/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("chatgpt bridge: metadata", () => {
  it("registers as a 'file' kind builtin", () => {
    expect(chatgptMemoryBridge.name).toBe("chatgpt");
    expect(chatgptMemoryBridge.kind).toBe("file");
    expect(chatgptMemoryBridge.version).toBe(1);
  });
  it("declares a `source` option", () => {
    expect(chatgptMemoryBridge.options?.source).toBeDefined();
  });
  it("does NOT declare an export side (one-way bridge)", () => {
    expect(chatgptMemoryBridge.export).toBeUndefined();
  });
});
