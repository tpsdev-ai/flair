import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeProjectMemoryBridge } from "../../src/bridges/builtins/claude-project";

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

// ─── Plain-text path (primary user workflow) ──────────────────────────────────

describe("claude-project bridge: plain-text input (primary workflow)", () => {
  it("imports a bullet-list .txt file (Settings → Capabilities copy-paste)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-claude-test-"));
    try {
      const path = join(dir, "memory.txt");
      writeFileSync(path,
        "- User prefers dark mode\n" +
        "- User runs Bun for all TS projects\n" +
        "- User's primary editor is Helix\n",
      );
      const out = await collectMemories({ source: path }, fakeCtx());
      expect(out).toHaveLength(3);
      expect(out[0].content).toBe("User prefers dark mode");
      expect(out[0].foreignId).toBe("claude-project:unknown:idx-0");
      expect(out[0].tags).toContain("source:claude-project");
      expect(out[0].durability).toBe("persistent");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("imports a numbered list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-claude-test-"));
    try {
      const path = join(dir, "memory.txt");
      writeFileSync(path, "1. First memory\n2. Second memory\n");
      const out = await collectMemories({ source: path }, fakeCtx());
      expect(out).toHaveLength(2);
      expect(out[0].content).toBe("First memory");
      expect(out[1].content).toBe("Second memory");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("imports raw lines (no bullets)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-claude-test-"));
    try {
      const path = join(dir, "memory.txt");
      writeFileSync(path, "Line one memory\nLine two memory\n");
      const out = await collectMemories({ source: path }, fakeCtx());
      expect(out).toHaveLength(2);
      expect(out[0].content).toBe("Line one memory");
      expect(out[1].content).toBe("Line two memory");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("works with .md extension", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-claude-test-"));
    try {
      const path = join(dir, "memory.md");
      writeFileSync(path, "- markdown one\n- markdown two\n");
      const out = await collectMemories({ source: path }, fakeCtx());
      expect(out.find((m) => m.content === "markdown one")).toBeDefined();
      expect(out.find((m) => m.content === "markdown two")).toBeDefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("uses project.json from sibling directory for subject + foreignId (text source)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-claude-test-"));
    try {
      writeFileSync(join(dir, "project.json"), JSON.stringify({ name: "my-cool-project" }));
      writeFileSync(join(dir, "memory.txt"), "- shared fact\n");
      const out = await collectMemories({ source: dir }, fakeCtx());
      expect(out).toHaveLength(1);
      expect(out[0].content).toBe("shared fact");
      expect(out[0].subject).toBe("my-cool-project");
      expect(out[0].foreignId).toBe("claude-project:my-cool-project:idx-0");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("auto-discovers memory.txt in directory source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-claude-test-"));
    try {
      writeFileSync(join(dir, "memory.txt"), "- single fact\n");
      const out = await collectMemories({ source: dir }, fakeCtx());
      expect(out).toHaveLength(1);
      expect(out[0].content).toBe("single fact");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("auto-discovers memory.md when memory.txt absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-claude-test-"));
    try {
      writeFileSync(join(dir, "memory.md"), "- md content\n");
      const out = await collectMemories({ source: dir }, fakeCtx());
      expect(out).toHaveLength(1);
      expect(out[0].content).toBe("md content");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("auto-discovers memories.json (Anthropic-export hedge) when other names absent", async () => {
    // Hedges against the unverified question of whether Anthropic's
    // data-export ZIP contains a memories.json file. If it does, we handle
    // it; if it doesn't, no harm done.
    const dir = mkdtempSync(join(tmpdir(), "flair-claude-test-"));
    try {
      writeFileSync(join(dir, "memories.json"), JSON.stringify({
        memories: [{ id: "anth-1", content: "from anthropic export" }],
      }));
      const out = await collectMemories({ source: dir }, fakeCtx());
      expect(out).toHaveLength(1);
      expect(out[0].content).toBe("from anthropic export");
      expect(out[0].foreignId).toBe("claude-project:unknown:anth-1");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("memory.txt takes precedence over memories.json when both are present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-claude-test-"));
    try {
      writeFileSync(join(dir, "memory.txt"), "- user-staged text wins\n");
      writeFileSync(join(dir, "memories.json"), JSON.stringify({
        memories: [{ id: "json", content: "this should NOT be picked" }],
      }));
      const out = await collectMemories({ source: dir }, fakeCtx());
      expect(out).toHaveLength(1);
      expect(out[0].content).toBe("user-staged text wins");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ─── JSON fallback path ───────────────────────────────────────────────────────

describe("claude-project bridge: JSON fallback (third-party tools)", () => {
  it("imports memories from { memories: [...] } wrapper", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-claude-test-"));
    try {
      writeFileSync(join(dir, "memory.json"), JSON.stringify({
        memories: [
          { id: "abc", content: "User prefers dark mode", created_at: "2026-04-15T00:00:00Z" },
          { id: "def", content: "Project uses Bun runtime" },
        ],
      }));
      const out = await collectMemories({ source: dir }, fakeCtx());
      expect(out).toHaveLength(2);
      expect(out[0].content).toBe("User prefers dark mode");
      expect(out[0].foreignId).toBe("claude-project:unknown:abc");
      expect(out[0].createdAt).toBe("2026-04-15T00:00:00Z");
      expect(out[1].foreignId).toBe("claude-project:unknown:def");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("uses project.json name for subject/foreignId in JSON path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-claude-test-"));
    try {
      writeFileSync(join(dir, "project.json"), JSON.stringify({ name: "my-cool-project" }));
      writeFileSync(join(dir, "memory.json"), JSON.stringify({
        memories: [{ id: "x", content: "important fact" }],
      }));
      const out = await collectMemories({ source: dir }, fakeCtx());
      expect(out).toHaveLength(1);
      expect(out[0].foreignId).toBe("claude-project:my-cool-project:x");
      expect(out[0].subject).toBe("my-cool-project");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("imports from a top-level array", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-claude-test-"));
    try {
      writeFileSync(join(dir, "memory.json"), JSON.stringify([{ id: "x", content: "raw array" }]));
      const out = await collectMemories({ source: dir }, fakeCtx());
      expect(out).toHaveLength(1);
      expect(out[0].content).toBe("raw array");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("supports `text` field fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-claude-test-"));
    try {
      writeFileSync(join(dir, "memory.json"), JSON.stringify({
        memories: [{ id: "1", text: "older shape" }],
      }));
      const out = await collectMemories({ source: dir }, fakeCtx());
      expect(out).toHaveLength(1);
      expect(out[0].content).toBe("older shape");
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
        ],
      }));
      const out = await collectMemories({ source: dir }, fakeCtx());
      expect(out).toHaveLength(1);
      expect(out[0].foreignId).toBe("claude-project:unknown:good");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("accepts a direct .json file path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-claude-test-"));
    try {
      const filePath = join(dir, "custom-name.json");
      writeFileSync(filePath, JSON.stringify({ memories: [{ id: "1", content: "from custom path" }] }));
      const out = await collectMemories({ source: filePath }, fakeCtx());
      expect(out).toHaveLength(1);
      expect(out[0].content).toBe("from custom path");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ─── Error paths ──────────────────────────────────────────────────────────────

describe("claude-project bridge: error paths", () => {
  it("throws when --source is missing", async () => {
    await expect(collectMemories({}, fakeCtx())).rejects.toThrow(/--source/);
  });

  it("throws when source path does not exist", async () => {
    await expect(
      collectMemories({ source: "/nonexistent/path/that/should/not/exist" }, fakeCtx()),
    ).rejects.toThrow(/could not resolve source/);
  });

  it("throws on .json file with malformed JSON (no fallback to text)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-claude-test-"));
    try {
      const path = join(dir, "memory.json");
      writeFileSync(path, "not valid json {");
      await expect(collectMemories({ source: path }, fakeCtx()))
        .rejects.toThrow(/JSON parse failed/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("throws on JSON document with unexpected shape", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-claude-test-"));
    try {
      const path = join(dir, "memory.json");
      writeFileSync(path, JSON.stringify({ unrelated_field: "value" }));
      await expect(collectMemories({ source: path }, fakeCtx()))
        .rejects.toThrow(/unexpected/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("throws a friendly error on .zip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-claude-test-"));
    try {
      const path = join(dir, "export.zip");
      writeFileSync(path, "fake zip");
      await expect(collectMemories({ source: path }, fakeCtx()))
        .rejects.toThrow(/extract the .zip first/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("throws when directory has no memory file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-claude-test-"));
    try {
      writeFileSync(join(dir, "other.json"), "{}");
      await expect(collectMemories({ source: dir }, fakeCtx()))
        .rejects.toThrow(/no memory file|UI-only|memory\.txt/i);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ─── Metadata ─────────────────────────────────────────────────────────────────

describe("claude-project bridge: metadata", () => {
  it("registers as a 'file' kind builtin", () => {
    expect(claudeProjectMemoryBridge.name).toBe("claude-project");
    expect(claudeProjectMemoryBridge.kind).toBe("file");
    expect(claudeProjectMemoryBridge.version).toBe(1);
  });

  it("declares a `source` option", () => {
    expect(claudeProjectMemoryBridge.options?.source).toBeDefined();
    expect(claudeProjectMemoryBridge.options?.source?.required).toBe(true);
  });

  it("does NOT declare an export side (one-way bridge)", () => {
    expect(claudeProjectMemoryBridge.export).toBeUndefined();
  });
});
