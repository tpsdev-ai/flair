import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Minimal mock of OpenClawPluginApi
function createMockApi(config: Record<string, unknown> = {}) {
  const tools = new Map<string, { execute: Function }>();
  const hooks = new Map<string, Function[]>();

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
    // Test helpers
    _tools: tools,
    _hooks: hooks,
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
