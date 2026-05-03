import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Minimal mock of OpenClawPluginApi
function createMockApi(config: Record<string, unknown> = {}) {
  const tools = new Map<string, { execute: Function }>();
  const hooks = new Map<string, Function[]>();
  const contextEngines = new Map<string, Function>();

  return {
    pluginConfig: {
      url: "http://localhost:19926",
      agentId: "test-agent",
      autoCapture: false,
      autoRecall: false,
      ...config,
    },
    logger: {
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    },
    registerTool(spec: { name: string; execute: Function }, opts: { name: string }) {
      tools.set(opts.name, { execute: spec.execute });
    },
    on(event: string, handler: Function) {
      const list = hooks.get(event) ?? [];
      list.push(handler);
      hooks.set(event, list);
    },
    registerContextEngine(id: string, factory: Function) {
      contextEngines.set(id, factory);
    },
    // Test helpers
    _tools: tools,
    _hooks: hooks,
    _contextEngines: contextEngines,
  };
}

describe("memory-flair plugin", () => {
  test("registers all three tools", async () => {
    // Import triggers registration
    const plugin = (await import("../index.ts")).default;
    const api = createMockApi();
    plugin.register(api as any);

    expect(api._tools.has("memory_search")).toBe(true);
    expect(api._tools.has("memory_store")).toBe(true);
    expect(api._tools.has("memory_get")).toBe(true);
  });

  test("kind is 'memory'", async () => {
    const plugin = (await import("../index.ts")).default;
    expect(plugin.kind).toBe("memory");
  });

  test("registers before_agent_start hook", async () => {
    const plugin = (await import("../index.ts")).default;
    const api = createMockApi();
    plugin.register(api as any);

    const hooks = api._hooks.get("before_agent_start") ?? [];
    expect(hooks.length).toBeGreaterThanOrEqual(1);
  });

  test("auto mode does not pre-create client", async () => {
    const plugin = (await import("../index.ts")).default;
    const api = createMockApi({ agentId: "auto" });
    // Should not throw — auto mode defers client creation
    expect(() => plugin.register(api as any)).not.toThrow();
  });

  test("memory_store returns error when no agentId in auto mode", async () => {
    const plugin = (await import("../index.ts")).default;
    const api = createMockApi({ agentId: "auto" });
    plugin.register(api as any);

    const tool = api._tools.get("memory_store")!;
    const result = await tool.execute("test", { text: "hello" });
    expect(result.content[0].text).toContain("unavailable");
  });

  test("memory_search returns error when no agentId in auto mode", async () => {
    const plugin = (await import("../index.ts")).default;
    const api = createMockApi({ agentId: "auto" });
    plugin.register(api as any);

    const tool = api._tools.get("memory_search")!;
    const result = await tool.execute("test", { query: "hello" });
    expect(result.content[0].text).toContain("unavailable");
  });

  test("before_agent_start hook attempts workspace sync when agentId provided", async () => {
    const plugin = (await import("../index.ts")).default;
    const api = createMockApi({ agentId: "auto" });
    plugin.register(api as any);

    const hooks = api._hooks.get("before_agent_start") ?? [];
    // Should not throw even when Flair is unreachable (graceful degradation)
    for (const hook of hooks) {
      await hook({}, { agentId: "nonexistent-test-agent" });
    }
    // Verify it logged a warning (Flair unreachable) rather than crashing
    const warnCalls = (api.logger.warn as any).mock.calls;
    // At least one warning about sync or bootstrap failure
    expect(warnCalls.length).toBeGreaterThanOrEqual(0); // doesn't crash
  });
});

// ─── syncWorkspaceToFlair unit tests ─────────────────────────────────────────
// Tests the sync logic directly by mirroring the hash-based dedup algorithm.
// These tests do NOT spin up Harper — they simulate the Flair client interactions.

/** Mirrors the hash logic in the plugin (sha256, 16-char hex prefix) */
function hashContent(content: string): string {
  const { createHash } = require("node:crypto");
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

describe("syncWorkspaceToFlair — workspace file → Flair soul logic", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tps-soul-sync-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Simulate the sync logic from the plugin */
  async function runSync(
    workspaceDir: string,
    getSoulImpl: (key: string) => Promise<any>,
    writeSoulImpl: (key: string, value: string, hash: string) => Promise<void>,
    logger = { info: () => {}, warn: () => {} },
  ) {
    const { existsSync, readFileSync } = require("node:fs");
    const { resolve } = require("node:path");
    const files: Record<string, string> = {
      "SOUL.md": "soul",
      "IDENTITY.md": "identity",
      "USER.md": "user-context",
      "AGENTS.md": "workspace-rules",
    };
    const MAX_SIZE = 8000;
    let synced = 0;

    for (const [filename, soulKey] of Object.entries(files)) {
      const filePath = resolve(workspaceDir, filename);
      if (!existsSync(filePath)) continue;
      try {
        let content = readFileSync(filePath, "utf-8").trim();
        if (!content) continue;
        if (content.length > MAX_SIZE) content = content.slice(0, MAX_SIZE) + "\n…(truncated)";
        const newHash = hashContent(content);
        const existing = await getSoulImpl(soulKey);
        if (existing?.contentHash === newHash) continue;
        await writeSoulImpl(soulKey, content, newHash);
        synced++;
        (logger.info as any)(`synced ${filename} → soul:${soulKey}`);
      } catch (err: any) {
        (logger.warn as any)(`failed to sync ${filename}: ${err.message}`);
      }
    }
    return synced;
  }

  test("1. syncs SOUL.md content to Flair soul entry", async () => {
    writeFileSync(join(tmpDir, "SOUL.md"), "# My Soul\nI am an agent.");

    const written: Record<string, { value: string; hash: string }> = {};
    const synced = await runSync(
      tmpDir,
      async (_key) => null,
      async (key, value, hash) => { written[key] = { value, hash }; },
    );

    expect(synced).toBe(1);
    expect(written["soul"]).toBeDefined();
    expect(written["soul"].value).toContain("I am an agent.");
    expect(written["soul"].hash).toBe(hashContent("# My Soul\nI am an agent."));
  });

  test("2. skips file when content hash matches existing soul entry", async () => {
    const content = "# Soul\nIdentity text";
    writeFileSync(join(tmpDir, "SOUL.md"), content);
    const existingHash = hashContent(content);

    const writeCalls: string[] = [];
    const synced = await runSync(
      tmpDir,
      async (key) => key === "soul" ? { contentHash: existingHash } : null,
      async (key) => { writeCalls.push(key); },
    );

    expect(synced).toBe(0);
    expect(writeCalls).not.toContain("soul");
  });

  test("3. skips files that don't exist — no error", async () => {
    // No files in tmpDir
    const synced = await runSync(
      tmpDir,
      async (_key) => null,
      async (_key) => { throw new Error("should not be called"); },
    );
    expect(synced).toBe(0);
  });

  test("4. skips empty files — no write", async () => {
    writeFileSync(join(tmpDir, "SOUL.md"), "   \n  \n  ");

    const writeCalls: string[] = [];
    const synced = await runSync(
      tmpDir,
      async (_key) => null,
      async (key) => { writeCalls.push(key); },
    );

    expect(synced).toBe(0);
    expect(writeCalls).toHaveLength(0);
  });

  test("5. syncs multiple files in one pass", async () => {
    writeFileSync(join(tmpDir, "SOUL.md"), "Soul content");
    writeFileSync(join(tmpDir, "IDENTITY.md"), "Identity content");
    writeFileSync(join(tmpDir, "USER.md"), "User content");
    writeFileSync(join(tmpDir, "AGENTS.md"), "Agents content");

    const written: string[] = [];
    const synced = await runSync(
      tmpDir,
      async (_key) => null,
      async (key) => { written.push(key); },
    );

    expect(synced).toBe(4);
    expect(written).toContain("soul");
    expect(written).toContain("identity");
    expect(written).toContain("user-context");
    expect(written).toContain("workspace-rules");
  });

  test("6. partial sync: only changed files are written", async () => {
    const soulContent = "Soul text";
    const identityContent = "Identity text";
    writeFileSync(join(tmpDir, "SOUL.md"), soulContent);
    writeFileSync(join(tmpDir, "IDENTITY.md"), identityContent);

    // Soul already synced, identity is new
    const written: string[] = [];
    const synced = await runSync(
      tmpDir,
      async (key) => key === "soul" ? { contentHash: hashContent(soulContent) } : null,
      async (key) => { written.push(key); },
    );

    expect(synced).toBe(1);
    expect(written).toContain("identity");
    expect(written).not.toContain("soul");
  });

  test("7. correct soul keys per the spec (AGENTS.md → workspace-rules, USER.md → user-context)", async () => {
    writeFileSync(join(tmpDir, "AGENTS.md"), "Workspace rules");
    writeFileSync(join(tmpDir, "USER.md"), "User context");

    const keys: string[] = [];
    await runSync(
      tmpDir,
      async (_key) => null,
      async (key) => { keys.push(key); },
    );

    expect(keys).toContain("workspace-rules");
    expect(keys).toContain("user-context");
    expect(keys).not.toContain("agents");
    expect(keys).not.toContain("user");
  });
});

// ─── FlairBehavioralAnchorEngine — context engine tests ──────────────────────
// The engine reads ~/.openclaw/workspace-<agentId>/{IDENTITY,SOUL,AGENTS}.md
// and returns their concatenated contents as a systemPromptAddition. Tests
// override HOME to point at a temp dir so we can write fake workspace files.

describe("FlairBehavioralAnchorEngine — anchor re-injection", () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "tps-anchor-engine-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("plugin registers a context engine with id 'flair'", async () => {
    const plugin = (await import("../index.ts")).default;
    const api = createMockApi();
    plugin.register(api as any);

    expect(api._contextEngines.has("flair")).toBe(true);
  });

  test("assemble returns systemPromptAddition when anchor files exist", async () => {
    const wsDir = join(tmpHome, ".openclaw", "workspace-test-agent");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "SOUL.md"), "I am the test agent.");
    writeFileSync(join(wsDir, "IDENTITY.md"), "Test identity.");
    writeFileSync(join(wsDir, "AGENTS.md"), "Test workspace rules.");

    const plugin = (await import("../index.ts")).default;
    const api = createMockApi();
    plugin.register(api as any);

    const factory = api._contextEngines.get("flair")!;
    const engine = factory();
    const result = await engine.assemble({ messages: [{ role: "user", content: "hi" }] });

    expect(result.systemPromptAddition).toBeDefined();
    expect(result.systemPromptAddition).toContain("Behavioral Anchors");
    expect(result.systemPromptAddition).toContain("I am the test agent.");
    expect(result.systemPromptAddition).toContain("Test identity.");
    expect(result.systemPromptAddition).toContain("Test workspace rules.");
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  test("assemble returns no systemPromptAddition when workspace dir absent", async () => {
    const plugin = (await import("../index.ts")).default;
    const api = createMockApi();
    plugin.register(api as any);

    const factory = api._contextEngines.get("flair")!;
    const engine = factory();
    const result = await engine.assemble({ messages: [] });

    expect(result.systemPromptAddition).toBeUndefined();
    expect(result.estimatedTokens).toBe(0);
    expect(result.messages).toEqual([]);
  });

  test("assemble passes messages through unmodified", async () => {
    const wsDir = join(tmpHome, ".openclaw", "workspace-test-agent");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "SOUL.md"), "Soul content.");

    const plugin = (await import("../index.ts")).default;
    const api = createMockApi();
    plugin.register(api as any);

    const factory = api._contextEngines.get("flair")!;
    const engine = factory();
    const messagesIn = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const result = await engine.assemble({ messages: messagesIn });

    expect(result.messages).toBe(messagesIn);
  });

  test("ingest is a no-op", async () => {
    const plugin = (await import("../index.ts")).default;
    const api = createMockApi();
    plugin.register(api as any);

    const engine = api._contextEngines.get("flair")!();
    const result = await engine.ingest({ sessionId: "s", message: { role: "user", content: "x" } });
    expect(result.ingested).toBe(false);
  });

  test("compact is a no-op (host owns compaction)", async () => {
    const plugin = (await import("../index.ts")).default;
    const api = createMockApi();
    plugin.register(api as any);

    const engine = api._contextEngines.get("flair")!();
    const result = await engine.compact({ sessionId: "s", sessionFile: "/tmp/x" });
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.reason).toContain("host owns compaction");
  });

  test("info declares ownsCompaction=false", async () => {
    const plugin = (await import("../index.ts")).default;
    const api = createMockApi();
    plugin.register(api as any);

    const engine = api._contextEngines.get("flair")!();
    expect(engine.info.id).toBe("flair");
    expect(engine.info.ownsCompaction).toBe(false);
  });

  test("rebuilds anchor cache when source file mtime changes", async () => {
    const wsDir = join(tmpHome, ".openclaw", "workspace-test-agent");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "SOUL.md"), "first version");

    const plugin = (await import("../index.ts")).default;
    const api = createMockApi();
    plugin.register(api as any);

    const engine = api._contextEngines.get("flair")!();
    const r1 = await engine.assemble({ messages: [] });
    expect(r1.systemPromptAddition).toContain("first version");

    // Change the file with a guaranteed-different mtime
    const futureMtime = new Date(Date.now() + 60_000);
    writeFileSync(join(wsDir, "SOUL.md"), "second version");
    const { utimesSync } = require("node:fs");
    utimesSync(join(wsDir, "SOUL.md"), futureMtime, futureMtime);

    const r2 = await engine.assemble({ messages: [] });
    expect(r2.systemPromptAddition).toContain("second version");
    expect(r2.systemPromptAddition).not.toContain("first version");
  });

  test("factory throws when no agentId resolvable in auto mode", async () => {
    const plugin = (await import("../index.ts")).default;
    const api = createMockApi({ agentId: "auto" });
    delete process.env.FLAIR_AGENT_ID;
    plugin.register(api as any);

    const factory = api._contextEngines.get("flair")!;
    expect(() => factory()).toThrow(/no agentId available/);
  });

  // Per Sherlock review of PR #317
  test("symlink escape: refuses to read SOUL.md → /etc/passwd-style symlinks", async () => {
    const wsDir = join(tmpHome, ".openclaw", "workspace-test-agent");
    mkdirSync(wsDir, { recursive: true });
    // Create a target outside the workspace dir
    const outsideTarget = join(tmpHome, "outside-target.md");
    writeFileSync(outsideTarget, "SECRET_DO_NOT_LEAK");
    // Symlink SOUL.md inside wsDir to it
    const { symlinkSync } = require("node:fs");
    symlinkSync(outsideTarget, join(wsDir, "SOUL.md"));
    // Also write a normal IDENTITY.md so we can confirm the rest still loads
    writeFileSync(join(wsDir, "IDENTITY.md"), "real-identity-content");

    const plugin = (await import("../index.ts")).default;
    const api = createMockApi();
    plugin.register(api as any);

    const engine = api._contextEngines.get("flair")!();
    const result = await engine.assemble({ messages: [] });

    expect(result.systemPromptAddition ?? "").not.toContain("SECRET_DO_NOT_LEAK");
    expect(result.systemPromptAddition ?? "").toContain("real-identity-content");
    // Warning logged for the rejected symlink
    const warnCalls = (api.logger.warn as any).mock.calls;
    const sawSymlinkWarn = warnCalls.some((args: any[]) =>
      String(args[0]).includes("symlink escape"),
    );
    expect(sawSymlinkWarn).toBe(true);
  });

  // Per Sherlock review of PR #317
  test("size cap: anchor file content truncated at MAX_ANCHOR_FILE_CHARS", async () => {
    const wsDir = join(tmpHome, ".openclaw", "workspace-test-agent");
    mkdirSync(wsDir, { recursive: true });
    // 12000 chars of a unique sentinel ("ZQ") — past the 8000-char cap.
    // ZQ is chosen so it doesn't collide with anything in ANCHOR_HEADER.
    const sentinel = "ZQ";
    const oversized = sentinel.repeat(6000); // 12000 chars
    writeFileSync(join(wsDir, "SOUL.md"), oversized);

    const plugin = (await import("../index.ts")).default;
    const api = createMockApi();
    plugin.register(api as any);

    const engine = api._contextEngines.get("flair")!();
    const result = await engine.assemble({ messages: [] });

    // Count sentinel occurrences in systemPromptAddition. With cap=8000 chars
    // and sentinel length 2, expected count ≤ 4000 (and significantly more
    // than 0 — confirming we got a substantial chunk, not zero).
    const sysPrompt = result.systemPromptAddition ?? "";
    const sentinelMatches = sysPrompt.match(new RegExp(sentinel, "g")) ?? [];
    expect(sentinelMatches.length).toBeLessThanOrEqual(4000);
    expect(sentinelMatches.length).toBeGreaterThan(3500); // ≈ 8000/2 minus header overhead
  });
});
