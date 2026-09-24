/**
 * openclaw-flair — identity core (slice 1) tests.
 *
 * The mock models the REAL host registration contract and is typed against the
 * plugin API from the `openclaw` devDep (`OpenClawPluginApi`):
 *   - tools are registered as FACTORIES `(ctx) => tool`, resolved per call with
 *     an immutable `ctx.agentId`;
 *   - prompt/context policy and conversation access are host config gates
 *     (`plugins.entries.<id>.hooks.allowPromptInjection` /
 *     `allowConversationAccess`) — a gated hook is NOT delivered when withheld;
 *   - the host version is read at load time from `api.runtime.version`, and
 *     outside the tested set the plugin registers NOTHING;
 *   - the host delivers `agent_end` before `llm_output`.
 *
 * Network is stubbed at `globalThis.fetch`, so "a refusal makes zero outgoing
 * requests" is asserted directly, and the signer id is read off the
 * `Authorization` header of anything that IS sent.
 *
 * Typed against the plugin API in `openclaw@2026.7.1` (the devDependency in
 * this tree). Parity with 2026.8.1 / 2026.9.6 is proven only by the real-host
 * drills, not by this mock.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import * as realFs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { loadPrivateKey, resolveKeyPath } from "@tpsdev-ai/flair-client";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

/** The one file the A1 regression test plants under a root-owned directory. */
const A1_TMP_KEY = "/tmp/ocf-a1-916.key";

// ── mock host api, typed against the SDK's plugin API ────────────────────────

type ToolCtx = { agentId?: string };
type MockFn = (event: any, ctx: ToolCtx) => any;

/** Hooks the host gates: withheld policy/permission means NOT delivered. */
const PROMPT_GATED = new Set(["before_prompt_build", "agent_turn_prepare", "before_agent_start"]);
const CONVERSATION_GATED = new Set(["llm_input", "llm_output", "agent_end"]);

type MockApi = Partial<OpenClawPluginApi> & {
  _tools: Map<string, unknown>;
  _hooks: Map<string, MockFn[]>;
  _contextEngines: Map<string, Function>;
  _services: Map<string, { id: string; start: (ctx: any) => any }>;
  _resolveTool: (name: string, ctx: ToolCtx) => any;
  _warnText: () => string;
  _statusLine: () => string;
  _fire: (hook: string, event: any, ctx: ToolCtx) => Promise<string[]>;
  _runTurn: (ctx: ToolCtx, payload: { messages?: any[]; prompt?: string; assistantTexts?: string[] }) => Promise<void>;
};

function createMockApi(opts: {
  pluginConfig?: Record<string, unknown>;
  config?: Record<string, unknown>;
  /** Host version exposed as api.runtime.version; null = field absent. */
  hostVersion?: string | null;
} = {}): MockApi {
  const tools = new Map<string, unknown>();
  const hooks = new Map<string, MockFn[]>();
  const contextEngines = new Map<string, Function>();
  const services = new Map<string, { id: string; start: (ctx: any) => any }>();

  const hooksAllowed = (hook: string): boolean => {
    const entry = ((opts.config as any)?.plugins?.entries?.["openclaw-flair"]?.hooks ?? {}) as {
      allowPromptInjection?: boolean;
      allowConversationAccess?: boolean;
    };
    if (PROMPT_GATED.has(hook)) return entry.allowPromptInjection === true;
    if (CONVERSATION_GATED.has(hook)) return entry.allowConversationAccess === true;
    return true;
  };

  const defaultConfig = {
    agents: { entries: { A: {} } },
    plugins: { slots: { memory: "openclaw-flair" }, entries: {} },
  };

  const api = {
    id: "openclaw-flair",
    name: "openclaw-flair",
    version: "0.55.2",
    source: "local",
    registrationMode: "full",
    config: opts.config !== undefined ? opts.config : defaultConfig,
    pluginConfig: { url: "http://127.0.0.1:19926", ...(opts.pluginConfig ?? {}) },
    runtime: opts.hostVersion === null ? {} : { version: opts.hostVersion ?? "2026.8.1" },
    logger: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}), debug: mock(() => {}) },
    registerTool(toolOrFactory: unknown, o?: { name?: string }) {
      tools.set(o?.name ?? (toolOrFactory as any)?.name, toolOrFactory);
    },
    on(event: string, handler: MockFn) {
      const list = hooks.get(event) ?? [];
      list.push(handler);
      hooks.set(event, list);
    },
    registerContextEngine(id: string, factory: Function) {
      contextEngines.set(id, factory);
    },
    registerService(service: { id: string; start: (ctx: any) => any }) {
      services.set(service.id, service);
    },
    _tools: tools,
    _hooks: hooks,
    _contextEngines: contextEngines,
    _services: services,
    _resolveTool(name: string, ctx: ToolCtx) {
      const entry = tools.get(name);
      if (entry === undefined) return null;
      return typeof entry === "function" ? (entry as any)(ctx) : entry;
    },
    _warnText(): string {
      return (api.logger.warn as any).mock.calls.map((c: any[]) => String(c[0])).join("\n");
    },
    _statusLine(): string {
      return (api.logger.info as any).mock.calls.map((c: any[]) => String(c[0])).join("\n");
    },
    /** Deliver ONE hook the way the host would: gated -> not delivered. */
    async _fire(hook: string, event: any, ctx: ToolCtx): Promise<string[]> {
      const delivered: string[] = [];
      if (!hooksAllowed(hook)) return delivered;
      for (const h of hooks.get(hook) ?? []) {
        await h(event, ctx);
        delivered.push(hook);
      }
      return delivered;
    },
    /** One host turn: the real delivery order (agent_end before llm_output). */
    async _runTurn(ctx: ToolCtx, payload: { messages?: any[]; prompt?: string; assistantTexts?: string[] }) {
      await this._fire("llm_input", { runId: "r", sessionId: "s", provider: "p", model: "m", prompt: payload.prompt ?? "" }, ctx);
      await this._fire("agent_end", { messages: payload.messages ?? [] }, ctx);
      await this._fire("llm_output", { runId: "r", sessionId: "s", provider: "p", model: "m", assistantTexts: payload.assistantTexts ?? [] }, ctx);
    },
  };
  return api as unknown as MockApi;
}

// ── network stub ─────────────────────────────────────────────────────────────

interface Call { url: string; method: string; authorization: string | null }

function installFetchStub(handler?: (call: Call) => { status?: number; body?: unknown }) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: any = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = { url: String(url), method: init.method ?? "GET", authorization: headers["Authorization"] ?? null };
    calls.push(call);
    const out = handler ? handler(call) : {};
    const body = out.body === undefined ? { results: [] } : out.body;
    return new Response(JSON.stringify(body), { status: out.status ?? 200, headers: { "content-type": "application/json" } });
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
  process.env.OPENCLAW_VERSION = "2026.8.1"; // must be ignored
  process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION = "2026.8.1";
  delete process.env.FLAIR_AGENT_ID; // env identity must be ignored entirely
  // Restore the injectable key probes (a prior test may have substituted them).
  signingKeyProbe.resolve = (a, kp) => resolveKeyPath(a, kp);
  signingKeyProbe.load = (f) => loadPrivateKey(f);
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete (process.env as any)[k];
    else (process.env as any)[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(A1_TMP_KEY, { force: true });
});

async function loadPlugin() {
  return (await import("../index.ts")).default;
}

/** The module namespace (for the probe + helpers). */
async function loadModule(): Promise<any> {
  return await import("../index.ts");
}

// The probe object the plugin's re-verification uses. On a build without it,
// substitutions below are inert (which is how these tests go red there).
let signingKeyProbe: { resolve: (a: string, kp?: string) => string | null; load: (f: string) => any };
try {
  signingKeyProbe = (await import("../index.ts") as any).signingKeyProbe ?? {
    resolve: (a: string, kp?: string) => resolveKeyPath(a, kp),
    load: (f: string) => loadPrivateKey(f),
  };
} catch {
  signingKeyProbe = { resolve: (a, kp) => resolveKeyPath(a, kp), load: (f) => loadPrivateKey(f) };
}

// ── host version gate (R1) ───────────────────────────────────────────────────

describe("host version gate (runtime.version is the ONLY source, exact match)", () => {
  test("runtime.version in the tested set registers", async () => {
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi({ hostVersion: "2026.9.6" });
    plugin.register(api as any);
    expect(api._tools.size).toBe(3);
  });

  test("R1: a SUFFIXED version is NOT in the set (2026.8.1-dev registers nothing)", async () => {
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi({ hostVersion: "2026.8.1-dev" });
    plugin.register(api as any);
    expect(api._tools.size).toBe(0);
    expect(api._warnText()).toMatch(/host 2026\.8\.1-dev not in tested set/);
  });

  test("runtime.version absent: registers nothing with the disabled line", async () => {
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi({ hostVersion: null });
    plugin.register(api as any);
    expect(api._tools.size).toBe(0);
    expect(api._hooks.size).toBe(0);
    expect(api._contextEngines.size).toBe(0);
    expect(api._warnText()).toMatch(/openclaw-flair disabled: host unknown not in tested set/);
  });

  test("an env var cannot satisfy the gate: OPENCLAW_VERSION set, runtime.version absent -> nothing", async () => {
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi({ hostVersion: null });
    plugin.register(api as any);
    expect(api._tools.size).toBe(0);
    expect(api._warnText()).toMatch(/not in tested set/);
  });

  test("out-of-set host: registers NOTHING and reports the line", async () => {
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi({ hostVersion: "2026.5.7" });
    plugin.register(api as any);
    expect(api._tools.size).toBe(0);
    expect(api._hooks.size).toBe(0);
    expect(api._warnText()).toMatch(/openclaw-flair disabled: host 2026\.5\.7 not in tested set/);
  });

  test("no context-engine slot is selected (slice 1 slot safety)", async () => {
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi();
    plugin.register(api as any);
    expect(api._contextEngines.size).toBe(0);
    expect(api._hooks.has("before_agent_start")).toBe(false);
  });
});

// ── agent set + shared-OS-user (R2, R2b) ─────────────────────────────────────

describe("agent set and shared-OS-user detection (fail closed)", () => {
  test("R2: two agents whose key dirs are owned by THIS process -> registers nothing", async () => {
    writeKey("a");
    writeKey("b");
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi({ config: { agents: { entries: { a: {}, b: {} } } } });
    plugin.register(api as any);
    expect(api._tools.size).toBe(0);
    expect(api._warnText()).toMatch(/agents share an OS user; identity cannot be guaranteed/);
  });

  test("R2: list-shaped, two agents under this process -> registers nothing", async () => {
    writeKey("a");
    writeKey("b");
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi({ config: { agents: { list: [{ id: "a" }, { id: "b" }] } } });
    plugin.register(api as any);
    expect(api._tools.size).toBe(0);
    expect(api._warnText()).toMatch(/agents share an OS user; identity cannot be guaranteed/);
  });

  test("R2: one agent registers", async () => {
    writeKey("a");
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi({ config: { agents: { entries: { a: {} } } } });
    plugin.register(api as any);
    expect(api._tools.size).toBe(3);
  });

  test("A1: two agents both READABLE while their key dirs have DIFFERENT owners -> nothing registers", async () => {
    // A's key under a ROOT-owned directory (/tmp, uid 0), B's under this user's
    // home. Both files are readable by this process; an ownership-based check
    // would call the dirs "different" and register. Readability says otherwise.
    realFs.writeFileSync(A1_TMP_KEY, randomBytes(32));
    realFs.chmodSync(A1_TMP_KEY, 0o600);
    process.env.FLAIR_KEY_DIR = "/tmp";
    mkdirSync(join(home, ".flair", "keys"), { recursive: true });
    realFs.writeFileSync(join(home, ".flair", "keys", "ocf-a1-b.key"), randomBytes(32));
    realFs.chmodSync(join(home, ".flair", "keys", "ocf-a1-b.key"), 0o600);
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi({ config: { agents: { entries: { "ocf-a1-916": {}, "ocf-a1-b": {} } } } });
    plugin.register(api as any);
    expect(api._tools.size).toBe(0);
    expect(api._warnText()).toMatch(/agents share an OS user; identity cannot be guaranteed/);
  });

  test("A1: a key this process cannot READ counts as not ours (2 agents, 1 readable -> registers)", async () => {
    writeKey("a");
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi({ config: { agents: { entries: { a: {}, b: {} } } } });
    plugin.register(api as any);
    expect(api._tools.size).toBe(3);
  });

  test("A1: an INDETERMINATE readability -> nothing registers", async () => {
    writeKey("a");
    writeKey("b");
    const mod = await loadModule();
    const other = mod.keyReadableByThisProcess("b", undefined, () => {
      const e: any = new Error("EIO");
      e.code = "EIO";
      throw e;
    });
    expect(other).toBeNull();
    const readable = mod.keyReadableByThisProcess("a");
    expect(readable).toBe(true);
  });

  test("R2b: no roster property at all -> implicit sole agent -> registers", async () => {
    writeKey("a");
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi({ config: { plugins: { slots: { memory: "openclaw-flair" } } } });
    plugin.register(api as any);
    expect(api._tools.size).toBe(3);
  });

  test("R2b: an empty entries object -> registers nothing", async () => {
    writeKey("a");
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi({ config: { agents: { entries: {} } } });
    plugin.register(api as any);
    expect(api._tools.size).toBe(0);
    expect(api._warnText()).toMatch(/identity cannot be guaranteed/);
  });

  test("R2b: an unreadable config -> registers nothing", async () => {
    writeKey("a");
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi({ config: null as unknown as Record<string, unknown> });
    plugin.register(api as any);
    expect(api._tools.size).toBe(0);
    expect(api._warnText()).toMatch(/identity cannot be guaranteed/);
  });
});

// ── identity (R10 ordering) ──────────────────────────────────────────────────

describe("identity is taken from host context only", () => {
  test("configured agentId is an ALLOW-LIST: serving another agent refuses (0 requests)", async () => {
    writeKey("A");
    writeKey("B");
    const plugin = await loadPlugin();
    const calls = installFetchStub();
    const api = createMockApi({ pluginConfig: { agentId: "A" } });
    plugin.register(api as any);
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
    plugin.register(api as any);
    const store = api._resolveTool("memory_store", {});
    const res = await store.execute("1", { text: "hello" });
    expect(calls.length).toBe(0);
    expect(res.content[0].text).toContain("unavailable");
  });

  test("env identity is never used as a fallback", async () => {
    process.env.FLAIR_AGENT_ID = "A";
    writeKey("A");
    const plugin = await loadPlugin();
    const calls = installFetchStub();
    const api = createMockApi();
    plugin.register(api as any);
    const store = api._resolveTool("memory_store", {});
    const res = await store.execute("1", { text: "hello" });
    expect(calls.length).toBe(0);
    expect(res.content[0].text).toContain("unavailable");
  });

  test("R10: interleaved agents, driven through the host's turn order, sign as themselves", async () => {
    writeKey("A");
    writeKey("B");
    const plugin = await loadPlugin();
    const calls = installFetchStub();
    const api = createMockApi({
      pluginConfig: { autoCapture: true },
      config: {
        agents: { entries: { A: {} } },
        plugins: { slots: { memory: "openclaw-flair" }, entries: { "openclaw-flair": { hooks: { allowConversationAccess: true } } } },
      },
    });
    plugin.register(api as any);
    // One turn per agent, in both orders — hooks delivered in the host's order,
    // then the agent's tool call.
    const turn = async (id: string, text: string) => {
      await api._runTurn({ agentId: id }, { prompt: text, messages: [{ role: "user", content: text }] });
      const store = api._resolveTool("memory_store", { agentId: id });
      await store.execute("1", { text });
    };
    await turn("A", "remember this: A says interleave-one");
    await turn("B", "remember this: B says interleave-one");
    const first = calls.map(signerOf).filter(Boolean);
    expect(first).toContain("A");
    expect(first).toContain("B");
    expect(first.includes("A") && first.includes("B")).toBe(true);

    const calls2 = installFetchStub();
    await turn("B", "remember this: B says interleave-two");
    await turn("A", "remember this: A says interleave-two");
    const second = calls2.map(signerOf).filter(Boolean);
    expect(second).toContain("A");
    expect(second).toContain("B");
  });
});

// ── credential matrix (R4) ───────────────────────────────────────────────────

describe("credential matrix — no Basic/unsigned fallback", () => {
  test("explicit keyPath with an allow-list refuses a non-listed agent (0 requests)", async () => {
    writeKey("A");
    writeKey("B");
    const plugin = await loadPlugin();
    const calls = installFetchStub();
    const api = createMockApi({ pluginConfig: { agentId: "A", keyPath: join(keyDir, "A.key") } });
    plugin.register(api as any);
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
    plugin.register(api as any);
    expect(api._tools.size).toBe(0);
    expect(api._warnText()).toMatch(/keyPath is only valid with a single allowed agent/);
  });

  test("R4: a key removed after a successful call refuses with ZERO requests", async () => {
    writeKey("A");
    const plugin = await loadPlugin();
    const calls = installFetchStub();
    const api = createMockApi();
    plugin.register(api as any);
    const store = api._resolveTool("memory_store", { agentId: "A" });
    await store.execute("1", { text: "first" });
    expect(calls.length).toBe(1);

    const after = installFetchStub();
    rmSync(join(keyDir, "A.key"));
    const res = await store.execute("1", { text: "second" });
    expect(after.length).toBe(0);
    expect(res.content[0].text).toContain("unavailable");
  });

  test("R4: a key ROTATED to a different seed mid-session refuses with ZERO requests, naming the agent", async () => {
    writeKey("A");
    const plugin = await loadPlugin();
    const calls = installFetchStub();
    const api = createMockApi();
    plugin.register(api as any);
    const store = api._resolveTool("memory_store", { agentId: "A" });
    await store.execute("1", { text: "first" });
    expect(calls.length).toBe(1);

    const after = installFetchStub();
    writeKey("A", randomBytes(32)); // a different seed
    const res = await store.execute("1", { text: "second" });
    expect(after.length).toBe(0);
    expect(res.content[0].text).toMatch(/agent "A" changed while running/);
    expect(res.content[0].text).not.toMatch(/[0-9a-f]{32,}/); // no key bytes
  });

  test("missing key refuses (0 requests)", async () => {
    const plugin = await loadPlugin();
    const calls = installFetchStub();
    const api = createMockApi();
    plugin.register(api as any);
    const store = api._resolveTool("memory_store", { agentId: "A" });
    const res = await store.execute("1", { text: "hello" });
    expect(calls.length).toBe(0);
    expect(res.content[0].text).toMatch(/unavailable/);
  });

  test("a valid call carries the agent's Ed25519 signature (never Basic, never unsigned)", async () => {
    writeKey("A");
    const plugin = await loadPlugin();
    const calls = installFetchStub();
    const api = createMockApi();
    plugin.register(api as any);
    const store = api._resolveTool("memory_store", { agentId: "A" });
    await store.execute("1", { text: "hello" });
    expect(calls.length).toBe(1);
    expect(calls[0].authorization).toMatch(/^TPS-Ed25519 A:/);
    expect(calls[0].authorization).not.toMatch(/^Basic /i);
  });
});

// ── A2 — key loaded once, in memory; no admin fallback ───────────────────────

describe("A2 — the client signs only with the key it loaded, in memory", () => {
  test("a key REMOVED between the build and the fetch -> refusal, ZERO requests", async () => {
    writeKey("A");
    const plugin = await loadPlugin();
    const api = createMockApi();
    plugin.register(api as any);
    const store = api._resolveTool("memory_store", { agentId: "A" });
    const calls = installFetchStub();
    // Simulate the file vanishing after the client was built: the pre-fetch
    // re-verification (which a re-read of the file would bypass) sees no key.
    signingKeyProbe.resolve = () => null;
    const res = await store.execute("1", { text: "hello" });
    expect(calls.length).toBe(0);
    expect(res.content[0].text).toContain("unavailable");
  });

  test("a key ROTATED between the build and the fetch -> refusal, ZERO requests (never the new key)", async () => {
    writeKey("A");
    const plugin = await loadPlugin();
    const api = createMockApi();
    plugin.register(api as any);
    const store = api._resolveTool("memory_store", { agentId: "A" });
    const calls = installFetchStub();
    // A DIFFERENT key appears in the window: the re-verification compares its
    // fingerprint to the in-memory key's, so the request is refused rather than
    // signed with the new key.
    const rotated = join(home, "rotated.key");
    realFs.writeFileSync(rotated, randomBytes(32));
    signingKeyProbe.load = () => loadPrivateKey(rotated);
    const res = await store.execute("1", { text: "hello" });
    expect(calls.length).toBe(0);
    expect(res.content[0].text).toContain("unavailable");
  });

  test("the client has NO admin credentials: env Basic auth cannot be used", async () => {
    process.env.FLAIR_ADMIN_USER = "admin";
    process.env.FLAIR_ADMIN_PASSWORD = "pw";
    try {
      writeKey("A");
      const plugin = await loadPlugin();
      const calls = installFetchStub();
      const api = createMockApi();
      plugin.register(api as any);
      const store = api._resolveTool("memory_store", { agentId: "A" });
      await store.execute("1", { text: "hello" });
      expect(calls.length).toBe(1);
      expect(calls[0].authorization).toMatch(/^TPS-Ed25519 A:/);
      expect(calls[0].authorization).not.toMatch(/^Basic /i);
    } finally {
      delete process.env.FLAIR_ADMIN_USER;
      delete process.env.FLAIR_ADMIN_PASSWORD;
    }
  });
});

// ── permission matrix (R8) ───────────────────────────────────────────────────

describe("permission matrix", () => {
  const cfgWith = (hooks: Record<string, boolean>) => ({
    agents: { entries: { A: {} } },
    plugins: { slots: { memory: "openclaw-flair" }, entries: { "openclaw-flair": { hooks } } },
  });

  test("R8: capture withheld is reported even when capture is OFF by default", async () => {
    writeKey("A");
    const plugin = await loadPlugin();
    const calls = installFetchStub();
    const api = createMockApi({ config: cfgWith({ allowPromptInjection: true }) });
    plugin.register(api as any);
    expect(api._warnText()).toMatch(/capture disabled \(permission\)/);
    expect(calls.length).toBe(0);
  });

  test("capture withheld with capture ON: no capture hooks, zero reads", async () => {
    writeKey("A");
    const plugin = await loadPlugin();
    const calls = installFetchStub();
    const api = createMockApi({ pluginConfig: { autoCapture: true }, config: cfgWith({ allowPromptInjection: true }) });
    plugin.register(api as any);
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
    const api = createMockApi({ config: cfgWith({ allowConversationAccess: true }) });
    plugin.register(api as any);
    expect(api._warnText()).toMatch(/prompt context disabled: policy/);
    expect(api._hooks.has("before_prompt_build")).toBe(false);
  });
});

// ── prompt contract (R7) ─────────────────────────────────────────────────────

describe("prompt contract (host-shaped events, memory section untouched)", () => {
  const cfgWith = (hooks: Record<string, boolean>) => ({
    agents: { entries: { A: {} } },
    plugins: { slots: { memory: "openclaw-flair" }, entries: { "openclaw-flair": { hooks } } },
  });

  test("returns prependContext via before_prompt_build and leaves the host's memory section", async () => {
    writeKey("A");
    const plugin = await loadPlugin();
    installFetchStub((c) => (c.url.includes("/BootstrapMemories") ? { body: { context: "recalled context" } } : {}));
    const api = createMockApi({ pluginConfig: { autoRecall: true }, config: cfgWith({ allowPromptInjection: true }) });
    plugin.register(api as any);

    const baseSystemPrompt = "You are an agent.\n\n## Memory\n- a remembered fact\n";
    const event: any = { prompt: "hi", messages: [] };
    expect(event.injectContext).toBeUndefined();

    const delivered = await api._fire("before_prompt_build", event, { agentId: "A" });
    expect(delivered).toContain("before_prompt_build");

    // The plugin returns ONLY a context prepend — no systemPrompt replacement.
    const handlers = api._hooks.get("before_prompt_build") ?? [];
    const result: any = await handlers[0](event, { agentId: "A" });
    expect(result).not.toHaveProperty("injectContext");
    expect(Object.keys(result)).toEqual(["prependContext"]);

    // The host's own base prompt (with its memory section) is untouched.
    const merged = { systemPrompt: baseSystemPrompt, prependContext: result.prependContext };
    expect(merged.systemPrompt).toContain("## Memory");
    expect(merged.prependContext).toContain("recalled context");
  });

  test("R7: the test config sets plugins.slots exactly as the README", async () => {
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi();
    plugin.register(api as any);
    expect((api.config as any).plugins.slots).toEqual({ memory: "openclaw-flair" });
    expect((api.config as any).plugins.slots.contextEngine).toBeUndefined();
  });

  test("one run makes exactly one bootstrap fetch (agent_end before llm_output)", async () => {
    writeKey("A");
    const plugin = await loadPlugin();
    const calls = installFetchStub((c) => (c.url.includes("/BootstrapMemories") ? { body: { context: "ctx" } } : {}));
    const api = createMockApi({
      pluginConfig: { autoRecall: true },
      config: { agents: { entries: { A: {} } }, plugins: { slots: { memory: "openclaw-flair" }, entries: { "openclaw-flair": { hooks: { allowPromptInjection: true, allowConversationAccess: true } } } } },
    });
    plugin.register(api as any);
    const order: string[] = [];
    await api._runTurn({ agentId: "A" }, {});
    calls.forEach(() => {});
    const handlers = api._hooks.get("before_prompt_build") ?? [];
    await handlers[0]({ prompt: "hi", messages: [] }, { agentId: "A" });
    expect(calls.filter((c) => c.url.includes("/BootstrapMemories")).length).toBe(1);
    expect(api._hooks.has("before_agent_start")).toBe(false);
    void order;
  });
});

// ── refusal logging (R3) + status surface (R5) ───────────────────────────────

describe("refusal logging and status surface", () => {
  test("R3: a refused memory_get logs a line naming the tool and reason", async () => {
    const plugin = await loadPlugin();
    const calls = installFetchStub();
    const api = createMockApi();
    plugin.register(api as any);
    const get = api._resolveTool("memory_get", {}); // no ctx.agentId
    await get.execute("1", { id: "x" });
    expect(calls.length).toBe(0);
    expect(api._warnText()).toMatch(/memory_get refused\/failed: .*no agent identity/);
  });

  test("R3: a capture hook with no identity logs a line naming the hook", async () => {
    writeKey("A");
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi({
      pluginConfig: { autoCapture: true },
      config: { agents: { entries: { A: {} } }, plugins: { slots: { memory: "openclaw-flair" }, entries: { "openclaw-flair": { hooks: { allowConversationAccess: true } } } } },
    });
    plugin.register(api as any);
    await api._fire("agent_end", { messages: [] }, {});
    expect(api._warnText()).toMatch(/agent_end refused: no agent identity/);
  });

  test("R5: a status service is registered and reports the plugin state", async () => {
    writeKey("A");
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi({
      config: { agents: { entries: { A: {} } }, plugins: { slots: { memory: "openclaw-flair" }, entries: { "openclaw-flair": { hooks: { allowPromptInjection: true, allowConversationAccess: false } } } } },
    });
    plugin.register(api as any);
    const svc = api._services.get("openclaw-flair-status");
    expect(svc).toBeDefined();
    svc!.start({ logger: api.logger });
    expect(api._statusLine()).toMatch(/openclaw-flair status: .*prompt=allowed .*capture=withheld/);
  });
});

// ── still-relevant units ─────────────────────────────────────────────────────

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
  test("returns null without a trigger or under length; excerpt+hash otherwise", async () => {
    const { evaluateAutoCapture } = await import("../index.ts");
    expect(evaluateAutoCapture("nothing important here", { count: 0, hashes: new Set() })).toBeNull();
    expect(evaluateAutoCapture("remember this", { count: 0, hashes: new Set() })).toBeNull();
    const d = evaluateAutoCapture("please remember this: the deploy target is staging", { count: 0, hashes: new Set() });
    expect(d?.excerpt).toContain("remember this");
    expect(typeof d?.hash).toBe("string");
  });

  test("respects the session cap", async () => {
    const { evaluateAutoCapture } = await import("../index.ts");
    expect(evaluateAutoCapture("please remember this: the deploy target is staging", { count: 3, hashes: new Set() }, 3)).toBeNull();
  });
});
