/**
 * openclaw-flair — identity core (slice 1) tests.
 *
 * The mock models the REAL host registration contract:
 *   - tools are registered as FACTORIES `(ctx) => tool`, resolved per call with
 *     an immutable `ctx.agentId`;
 *   - prompt/context policy and conversation access are host config gates
 *     (`plugins.entries.<id>.hooks.allowPromptInjection` /
 *     `allowConversationAccess`);
 *   - the host version is read at load time, and outside the tested set the
 *     plugin registers NOTHING.
 *
 * Network is stubbed at `globalThis.fetch`, so "a refusal makes zero outgoing
 * requests" is asserted directly, and the signer id is read off the
 * `Authorization` header of anything that IS sent.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// ── mock host api ────────────────────────────────────────────────────────────

type ToolCtx = { agentId?: string };

function createMockApi(opts: {
  pluginConfig?: Record<string, unknown>;
  config?: Record<string, unknown>;
  hostVersion?: string;
} = {}) {
  const tools = new Map<string, unknown>();
  const hooks = new Map<string, Function[]>();
  const contextEngines = new Map<string, Function>();

  const api: any = {
    id: "openclaw-flair",
    name: "openclaw-flair",
    version: "0.55.2",
    registrationMode: "full",
    config: opts.config ?? {},
    pluginConfig: { url: "http://127.0.0.1:19926", ...(opts.pluginConfig ?? {}) },
    logger: {
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    },
    registerTool(toolOrFactory: unknown, o?: { name?: string }) {
      const name = o?.name ?? (toolOrFactory as any)?.name;
      tools.set(name, toolOrFactory);
    },
    on(event: string, handler: Function) {
      const list = hooks.get(event) ?? [];
      list.push(handler);
      hooks.set(event, list);
    },
    registerContextEngine(id: string, factory: Function) {
      contextEngines.set(id, factory);
    },
    _tools: tools,
    _hooks: hooks,
    _contextEngines: contextEngines,
    _resolveTool(name: string, ctx: ToolCtx) {
      const entry = tools.get(name);
      if (entry === undefined) return null;
      return typeof entry === "function" ? (entry as any)(ctx) : entry;
    },
    _warnText(): string {
      return (api.logger.warn as any).mock.calls.map((c: any[]) => String(c[0])).join("\n");
    },
  };
  return api;
}

// ── network stub ─────────────────────────────────────────────────────────────

interface Call {
  url: string;
  method: string;
  authorization: string | null;
  body: string | undefined;
}

function installFetchStub(handler?: (call: Call) => { status?: number; body?: unknown }) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: any = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url: String(url),
      method: init.method ?? "GET",
      authorization: headers["Authorization"] ?? null,
      body: typeof init.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    const out = handler ? handler(call) : {};
    const status = out.status ?? 200;
    const body = out.body === undefined ? { results: [] } : out.body;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return calls;
}

function signerOf(call: Call): string | null {
  const m = (call.authorization ?? "").match(/^TPS-Ed25519\s+([^:]+):/);
  return m ? m[1] : null;
}

// ── per-test HOME + key dir ──────────────────────────────────────────────────

let home: string;
let keyDir: string;
let savedEnv: Record<string, string | undefined>;

function writeKey(agentId: string, bytes: Buffer = randomBytes(32)): void {
  writeFileSync(join(keyDir, `${agentId}.key`), bytes);
  chmodSync(join(keyDir, `${agentId}.key`), 0o600);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocf-id-"));
  keyDir = join(home, "keys");
  mkdirSync(keyDir, { recursive: true });
  savedEnv = {
    HOME: process.env.HOME,
    FLAIR_KEY_DIR: process.env.FLAIR_KEY_DIR,
    OPENCLAW_VERSION: process.env.OPENCLAW_VERSION,
    OPENCLAW_COMPATIBILITY_HOST_VERSION: process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION,
    FLAIR_AGENT_ID: process.env.FLAIR_AGENT_ID,
  };
  process.env.HOME = home;
  process.env.FLAIR_KEY_DIR = keyDir;
  process.env.OPENCLAW_VERSION = "2026.8.1";
  delete process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
  delete process.env.FLAIR_AGENT_ID; // env identity must be ignored entirely
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete (process.env as any)[k];
    else (process.env as any)[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

async function loadPlugin() {
  return (await import("../index.ts")).default;
}

// ── A. host version gate ─────────────────────────────────────────────────────

describe("host version gate", () => {
  test("out-of-set host: registers NOTHING and reports the line", async () => {
    process.env.OPENCLAW_VERSION = "2026.5.7";
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi();
    plugin.register(api);
    expect(api._tools.size).toBe(0);
    expect(api._hooks.size).toBe(0);
    expect(api._contextEngines.size).toBe(0);
    expect(api._warnText()).toMatch(/openclaw-flair disabled: host 2026\.5\.7 not in tested set/);
  });

  test("undetermined host version: registers nothing (fail closed)", async () => {
    delete process.env.OPENCLAW_VERSION;
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi();
    plugin.register(api);
    expect(api._tools.size).toBe(0);
    expect(api._warnText()).toMatch(/not in tested set/);
  });

  test("in-set host: registers the three factory tools", async () => {
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi();
    plugin.register(api);
    expect(api._tools.has("memory_search")).toBe(true);
    expect(api._tools.has("memory_store")).toBe(true);
    expect(api._tools.has("memory_get")).toBe(true);
    // Every tool is a FACTORY, not a prebuilt object.
    expect(typeof api._tools.get("memory_store")).toBe("function");
  });

  test("no context-engine slot is selected (slice 1 slot safety)", async () => {
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi();
    plugin.register(api);
    expect(api._contextEngines.size).toBe(0);
    expect(api._hooks.has("before_agent_start")).toBe(false);
  });
});

// ── B. shared-OS-user detection ──────────────────────────────────────────────

describe("shared-OS-user detection (fail closed)", () => {
  test("more than one agent under one OS user: registers nothing", async () => {
    writeKey("a");
    writeKey("b");
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi({ config: { agents: { list: [{ id: "a" }, { id: "b" }] } } });
    plugin.register(api);
    expect(api._tools.size).toBe(0);
    expect(api._warnText()).toMatch(/agents share an OS user; identity cannot be guaranteed/);
  });

  test("a single agent on the gateway is served", async () => {
    writeKey("a");
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi({ config: { agents: { list: [{ id: "a" }] } } });
    plugin.register(api);
    expect(api._tools.size).toBe(3);
  });
});

// ── C. identity: allow-list, mismatch, missing ───────────────────────────────

describe("identity is taken from host context only", () => {
  test("configured agentId is an ALLOW-LIST: serving another agent refuses (0 requests)", async () => {
    writeKey("A");
    writeKey("B");
    const plugin = await loadPlugin();
    const calls = installFetchStub();
    const api = createMockApi({ pluginConfig: { agentId: "A" } });
    plugin.register(api);
    const store = api._resolveTool("memory_store", { agentId: "B" });
    const res = await store.execute("1", { text: "hello" });
    expect(calls.length).toBe(0);
    expect(res.content[0].text).toContain("unavailable");
  });

  test("missing identity refuses rather than inheriting (0 requests)", async () => {
    writeKey("A");
    const plugin = await loadPlugin();
    const calls = installFetchStub();
    const api = createMockApi();
    plugin.register(api);
    const store = api._resolveTool("memory_store", {});
    const res = await store.execute("1", { text: "hello" });
    expect(calls.length).toBe(0);
    expect(res.content[0].text).toContain("unavailable");
  });

  test("env identity is never used as a fallback", async () => {
    process.env.FLAIR_AGENT_ID = "A"; // must be ignored
    writeKey("A");
    const plugin = await loadPlugin();
    const calls = installFetchStub();
    const api = createMockApi();
    plugin.register(api);
    const store = api._resolveTool("memory_store", {}); // no ctx.agentId
    const res = await store.execute("1", { text: "hello" });
    expect(calls.length).toBe(0);
    expect(res.content[0].text).toContain("unavailable");
  });

  test("interleaved agents sign as themselves, in both orders", async () => {
    writeKey("A");
    writeKey("B");
    const plugin = await loadPlugin();
    const callsA = installFetchStub();
    const api = createMockApi();
    plugin.register(api);
    const storeA = api._resolveTool("memory_store", { agentId: "A" });
    const storeB = api._resolveTool("memory_store", { agentId: "B" });
    await storeA.execute("1", { text: "from A" });
    await storeB.execute("1", { text: "from B" });
    expect(callsA.map(signerOf)).toEqual(["A", "B"]);
    const callsB = installFetchStub();
    await storeB.execute("1", { text: "from B again" });
    await storeA.execute("1", { text: "from A again" });
    expect(callsB.map(signerOf)).toEqual(["B", "A"]);
  });
});

// ── D. credential matrix ─────────────────────────────────────────────────────

describe("credential matrix", () => {
  test("explicit keyPath with an allow-list refuses a non-listed agent (0 requests)", async () => {
    writeKey("A");
    writeKey("B");
    const plugin = await loadPlugin();
    const calls = installFetchStub();
    const api = createMockApi({ pluginConfig: { agentId: "A", keyPath: join(keyDir, "A.key") } });
    plugin.register(api);
    const store = api._resolveTool("memory_store", { agentId: "B" });
    const res = await store.execute("1", { text: "hello" });
    expect(calls.length).toBe(0);
    expect(res.content[0].text).toContain("unavailable");
  });

  test("keyPath without a single allowed agent is refused at startup", async () => {
    writeKey("A");
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi({ pluginConfig: { keyPath: join(keyDir, "A.key") } });
    plugin.register(api);
    expect(api._tools.size).toBe(0);
    expect(api._warnText()).toMatch(/keyPath is only valid with a single allowed agent/);
  });

  test("missing key refuses (0 requests)", async () => {
    const plugin = await loadPlugin();
    const calls = installFetchStub();
    const api = createMockApi({ pluginConfig: { agentId: "A" } });
    plugin.register(api);
    const store = api._resolveTool("memory_store", { agentId: "A" });
    const res = await store.execute("1", { text: "hello" });
    expect(calls.length).toBe(0);
    expect(res.content[0].text).toMatch(/unavailable/);
  });

  test("malformed key refuses (0 requests)", async () => {
    writeKey("A", Buffer.from([1, 2, 3])); // not a 32-byte seed
    const plugin = await loadPlugin();
    const calls = installFetchStub();
    const api = createMockApi();
    plugin.register(api);
    const store = api._resolveTool("memory_store", { agentId: "A" });
    const res = await store.execute("1", { text: "hello" });
    expect(calls.length).toBe(0);
    expect(res.content[0].text).toContain("unavailable");
  });

  test("no Basic or unsigned fallback: any request carries the agent's Ed25519 signature", async () => {
    writeKey("A");
    const plugin = await loadPlugin();
    const calls = installFetchStub();
    const api = createMockApi();
    plugin.register(api);
    const store = api._resolveTool("memory_store", { agentId: "A" });
    await store.execute("1", { text: "hello" });
    expect(calls.length).toBe(1);
    expect(calls[0].authorization).toMatch(/^TPS-Ed25519 A:/);
    expect(calls[0].authorization).not.toMatch(/^Basic /i);
  });
});

// ── E. permission matrix ─────────────────────────────────────────────────────

describe("permission matrix", () => {
  test("capture withheld: status line, no capture hooks, zero reads", async () => {
    writeKey("A");
    const plugin = await loadPlugin();
    const calls = installFetchStub();
    const api = createMockApi({ pluginConfig: { agentId: "A", autoCapture: true }, config: {} });
    plugin.register(api);
    expect(api._warnText()).toMatch(/capture disabled \(permission\)/);
    expect(api._hooks.has("agent_end")).toBe(false);
    expect(api._hooks.has("llm_input")).toBe(false);
    expect(api._hooks.has("llm_output")).toBe(false);
    expect(calls.length).toBe(0);
  });

  test("prompt policy withheld: status line, no before_prompt_build hook", async () => {
    writeKey("A");
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi({ pluginConfig: { agentId: "A", autoRecall: true }, config: {} });
    plugin.register(api);
    expect(api._warnText()).toMatch(/prompt context disabled: policy/);
    expect(api._hooks.has("before_prompt_build")).toBe(false);
  });

  test("capture OFF by default (no capture hooks, no status line)", async () => {
    writeKey("A");
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi({ pluginConfig: { agentId: "A" } });
    plugin.register(api);
    expect(api._hooks.has("agent_end")).toBe(false);
    expect(api._warnText()).not.toMatch(/capture disabled/);
  });
});

// ── F. real prompt contract + one bootstrap fetch ────────────────────────────

describe("prompt contract (host-shaped events, no injectContext)", () => {
  function configWith(hooks: Record<string, boolean>, agentId = "A") {
    return { plugins: { entries: { "openclaw-flair": { hooks } } }, agents: { list: [{ id: agentId }] } };
  }

  test("returns prependContext via before_prompt_build, never injectContext", async () => {
    writeKey("A");
    const plugin = await loadPlugin();
    const calls = installFetchStub((c) =>
      c.url.includes("/BootstrapMemories") ? { body: { context: "recalled context" } } : {},
    );
    const api = createMockApi({
      pluginConfig: { agentId: "A", autoRecall: true },
      config: configWith({ allowPromptInjection: true }),
    });
    plugin.register(api);
    const hooks = api._hooks.get("before_prompt_build") ?? [];
    expect(hooks.length).toBe(1);
    // Host-shaped event: { prompt, messages } — and NO injectContext field exists.
    const event: any = { prompt: "hi", messages: [] };
    expect(event.injectContext).toBeUndefined();
    const result: any = await hooks[0](event, { agentId: "A" });
    expect(typeof result?.prependContext).toBe("string");
    expect(result.prependContext).toContain("recalled context");
    expect(result).not.toHaveProperty("injectContext");
    expect(calls.filter((c) => c.url.includes("/BootstrapMemories")).length).toBe(1);
  });

  test("one run makes exactly one bootstrap fetch", async () => {
    writeKey("A");
    const plugin = await loadPlugin();
    const calls = installFetchStub((c) =>
      c.url.includes("/BootstrapMemories") ? { body: { context: "ctx" } } : {},
    );
    const api = createMockApi({
      pluginConfig: { agentId: "A", autoRecall: true },
      config: configWith({ allowPromptInjection: true }),
    });
    plugin.register(api);
    const hooks = api._hooks.get("before_prompt_build") ?? [];
    await hooks[0]({ prompt: "hi", messages: [] }, { agentId: "A" });
    expect(calls.filter((c) => c.url.includes("/BootstrapMemories")).length).toBe(1);
    // There is no legacy before_agent_start re-run that could fetch a second time.
    expect(api._hooks.has("before_agent_start")).toBe(false);
  });
});

// ── G. still-relevant units ──────────────────────────────────────────────────

describe("isValidAgentId / assertValidAgentId", () => {
  test("accepts standard ids; rejects traversal/absolute/empty", async () => {
    const { isValidAgentId, assertValidAgentId } = await import("../index.ts");
    expect(isValidAgentId("flint")).toBe(true);
    expect(isValidAgentId("a-b_c")).toBe(true);
    expect(isValidAgentId("../etc")).toBe(false);
    expect(isValidAgentId("/abs")).toBe(false);
    expect(isValidAgentId("")).toBe(false);
    expect(isValidAgentId(null)).toBe(false);
    expect(() => assertValidAgentId("../etc")).toThrow(/invalid agentId/);
  });
});

describe("evaluateAutoCapture", () => {
  test("returns null without a trigger or under length; returns excerpt+hash otherwise", async () => {
    const { evaluateAutoCapture } = await import("../index.ts");
    expect(evaluateAutoCapture("nothing important here", { count: 0, hashes: new Set() })).toBeNull();
    expect(evaluateAutoCapture("remember this", { count: 0, hashes: new Set() })).toBeNull();
    const d = evaluateAutoCapture("please remember this: the deploy target is staging", { count: 0, hashes: new Set() });
    expect(d?.excerpt).toContain("remember this");
    expect(typeof d?.hash).toBe("string");
  });

  test("respects the session cap", async () => {
    const { evaluateAutoCapture } = await import("../index.ts");
    const state = { count: 3, hashes: new Set<string>() };
    expect(evaluateAutoCapture("please remember this: the deploy target is staging", state, 3)).toBeNull();
  });
});
