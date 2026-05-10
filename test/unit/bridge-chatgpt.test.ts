import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chatgptMemoryBridge } from "../../src/bridges/builtins/chatgpt";

// Minimal stub of BridgeContext.
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
  for await (const m of chatgptMemoryBridge.import!(opts, ctx)) {
    out.push(m);
  }
  return out;
}

// ─── Plain-text path (primary user workflow) ──────────────────────────────────

describe("chatgpt bridge: plain-text input (primary user workflow)", () => {
  it("imports a bullet-list (- prefix) — the migration-prompt output shape", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-chatgpt-test-"));
    try {
      const path = join(dir, "memories.txt");
      writeFileSync(path,
        "- User prefers TypeScript\n" +
        "- User runs newton on M3 Ultra\n" +
        "- User's coffee order is a flat white\n",
      );
      const out = await collectMemories({ source: path }, fakeCtx());
      expect(out).toHaveLength(3);
      expect(out[0].content).toBe("User prefers TypeScript");
      expect(out[0].foreignId).toBe("chatgpt:idx-0");
      expect(out[0].tags).toContain("source:chatgpt");
      expect(out[0].durability).toBe("persistent");
      expect(out[2].content).toBe("User's coffee order is a flat white");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("imports a numbered list (1. / 1) prefix)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-chatgpt-test-"));
    try {
      const path = join(dir, "memories.txt");
      writeFileSync(path,
        "1. First memory\n" +
        "2. Second memory\n" +
        "3) Third with paren\n",
      );
      const out = await collectMemories({ source: path }, fakeCtx());
      expect(out).toHaveLength(3);
      expect(out[0].content).toBe("First memory");
      expect(out[1].content).toBe("Second memory");
      expect(out[2].content).toBe("Third with paren");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("handles unicode bullets (•) and asterisk (*)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-chatgpt-test-"));
    try {
      const path = join(dir, "memories.txt");
      writeFileSync(path,
        "• Unicode bullet memory\n" +
        "* Asterisk bullet memory\n",
      );
      const out = await collectMemories({ source: path }, fakeCtx());
      expect(out).toHaveLength(2);
      expect(out[0].content).toBe("Unicode bullet memory");
      expect(out[1].content).toBe("Asterisk bullet memory");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("imports raw lines without bullet prefixes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-chatgpt-test-"));
    try {
      const path = join(dir, "memories.txt");
      writeFileSync(path,
        "First memory line\n" +
        "Second memory line\n",
      );
      const out = await collectMemories({ source: path }, fakeCtx());
      expect(out).toHaveLength(2);
      expect(out[0].content).toBe("First memory line");
      expect(out[1].content).toBe("Second memory line");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("skips empty lines and trims whitespace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-chatgpt-test-"));
    try {
      const path = join(dir, "memories.txt");
      writeFileSync(path,
        "- First\n" +
        "\n" +
        "  \n" +
        "- Second\n" +
        "\n",
      );
      const out = await collectMemories({ source: path }, fakeCtx());
      expect(out).toHaveLength(2);
      expect(out[0].content).toBe("First");
      expect(out[1].content).toBe("Second");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("handles CRLF line endings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-chatgpt-test-"));
    try {
      const path = join(dir, "memories.txt");
      writeFileSync(path, "- One\r\n- Two\r\n");
      const out = await collectMemories({ source: path }, fakeCtx());
      expect(out).toHaveLength(2);
      expect(out[0].content).toBe("One");
      expect(out[1].content).toBe("Two");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("works with .md extension (markdown bullets)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-chatgpt-test-"));
    try {
      const path = join(dir, "memories.md");
      writeFileSync(path,
        "# My ChatGPT memories\n" +
        "\n" +
        "- markdown one\n" +
        "- markdown two\n",
      );
      const out = await collectMemories({ source: path }, fakeCtx());
      // The h1 line is treated as content (no bullet stripping for #).
      // Operator can clean it before import; for now we keep it lenient.
      expect(out.length).toBeGreaterThanOrEqual(2);
      expect(out.find((m) => m.content === "markdown one")).toBeDefined();
      expect(out.find((m) => m.content === "markdown two")).toBeDefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ─── JSON fallback path (third-party tool exports) ────────────────────────────

describe("chatgpt bridge: JSON fallback (third-party tool exports)", () => {
  it("imports memories from { memories: [...] } wrapper", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-chatgpt-test-"));
    try {
      const path = join(dir, "memories.json");
      writeFileSync(path, JSON.stringify({
        memories: [
          { id: "abc", content: "User uses TypeScript", created_at: "2026-04-15T00:00:00Z" },
          { id: "def", content: "User runs newton on M3 Ultra" },
        ],
      }));
      const out = await collectMemories({ source: path }, fakeCtx());
      expect(out).toHaveLength(2);
      expect(out[0].content).toBe("User uses TypeScript");
      expect(out[0].foreignId).toBe("chatgpt:abc");
      expect(out[0].createdAt).toBe("2026-04-15T00:00:00Z");
      expect(out[1].foreignId).toBe("chatgpt:def");
      expect(out[1].createdAt).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("imports from a top-level array (no wrapper)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-chatgpt-test-"));
    try {
      const path = join(dir, "memories.json");
      writeFileSync(path, JSON.stringify([
        { id: "x", content: "raw array shape" },
      ]));
      const out = await collectMemories({ source: path }, fakeCtx());
      expect(out).toHaveLength(1);
      expect(out[0].content).toBe("raw array shape");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("supports `text` and `body` field-name fallbacks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-chatgpt-test-"));
    try {
      const path = join(dir, "memories.json");
      writeFileSync(path, JSON.stringify({
        memories: [
          { id: "1", text: "older shape uses 'text'" },
          { id: "2", body: "even older 'body'" },
        ],
      }));
      const out = await collectMemories({ source: path }, fakeCtx());
      expect(out).toHaveLength(2);
      expect(out[0].content).toBe("older shape uses 'text'");
      expect(out[1].content).toBe("even older 'body'");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("accepts a bare-string memory entry inside JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-chatgpt-test-"));
    try {
      const path = join(dir, "memories.json");
      writeFileSync(path, JSON.stringify(["bare string memory"]));
      const out = await collectMemories({ source: path }, fakeCtx());
      expect(out).toHaveLength(1);
      expect(out[0].content).toBe("bare string memory");
      expect(out[0].foreignId).toBe("chatgpt:idx-0");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("skips JSON entries with empty/missing content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-chatgpt-test-"));
    try {
      const path = join(dir, "memories.json");
      writeFileSync(path, JSON.stringify({
        memories: [
          { id: "good", content: "real content" },
          { id: "empty", content: "" },
          { id: "no-content-field" },
          { id: "whitespace", content: "   \n\t  " },
        ],
      }));
      const out = await collectMemories({ source: path }, fakeCtx());
      expect(out).toHaveLength(1);
      expect(out[0].foreignId).toBe("chatgpt:good");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ─── Error paths ──────────────────────────────────────────────────────────────

describe("chatgpt bridge: error paths", () => {
  it("throws when --source is missing", async () => {
    await expect(collectMemories({}, fakeCtx())).rejects.toThrow(/--source/);
  });

  it("throws when source path does not exist", async () => {
    await expect(
      collectMemories({ source: "/nonexistent/path/that/should/not/exist" }, fakeCtx()),
    ).rejects.toThrow(/could not resolve source/);
  });

  it("throws a helpful error when source is a directory", async () => {
    // OpenAI's data export directory contains no memories file. We must
    // reject directories explicitly with the correct workflow guidance.
    const dir = mkdtempSync(join(tmpdir(), "flair-chatgpt-test-"));
    try {
      await expect(collectMemories({ source: dir }, fakeCtx()))
        .rejects.toThrow(/extraction prompt|UI-only|memories file/i);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("throws when .json file has malformed JSON (no fallback to text)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-chatgpt-test-"));
    try {
      const path = join(dir, "memories.json");
      writeFileSync(path, "not valid json {");
      await expect(collectMemories({ source: path }, fakeCtx()))
        .rejects.toThrow(/JSON parse failed/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("throws when JSON document has unexpected shape", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-chatgpt-test-"));
    try {
      const path = join(dir, "memories.json");
      writeFileSync(path, JSON.stringify({ unrelated_field: "value" }));
      await expect(collectMemories({ source: path }, fakeCtx()))
        .rejects.toThrow(/unexpected/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ─── Metadata ─────────────────────────────────────────────────────────────────

describe("chatgpt bridge: metadata", () => {
  it("registers as a 'file' kind builtin", () => {
    expect(chatgptMemoryBridge.name).toBe("chatgpt");
    expect(chatgptMemoryBridge.kind).toBe("file");
    expect(chatgptMemoryBridge.version).toBe(1);
  });
  it("declares a `source` option", () => {
    expect(chatgptMemoryBridge.options?.source).toBeDefined();
    expect(chatgptMemoryBridge.options?.source?.required).toBe(true);
  });
  it("does NOT declare an export side (one-way bridge)", () => {
    expect(chatgptMemoryBridge.export).toBeUndefined();
  });
});
