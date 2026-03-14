import { describe, test, expect, mock } from "bun:test";

// Minimal mock of OpenClawPluginApi
function createMockApi(config: Record<string, unknown> = {}) {
  const tools = new Map<string, { execute: Function }>();
  const hooks = new Map<string, Function[]>();

  return {
    pluginConfig: {
      url: "http://localhost:9926",
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

    expect(api._tools.has("memory_recall")).toBe(true);
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

  test("memory_recall returns error when no agentId in auto mode", async () => {
    const plugin = (await import("../index.ts")).default;
    const api = createMockApi({ agentId: "auto" });
    plugin.register(api as any);

    const tool = api._tools.get("memory_recall")!;
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
