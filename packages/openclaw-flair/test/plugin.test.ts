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
  _handler: (hook: string) => MockFn;
  _warnText: () => string;
  _statusLine: () => string;
  _fire: (hook: string, event: any, ctx: ToolCtx) => Promise<string[]>;
  _runTurn: (ctx: ToolCtx, payload: { runId?: string; success?: boolean; messages?: any[]; prompt?: string; assistantTexts?: string[] }) => Promise<void>;
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
    /** The first registered handler for a hook (for firing it directly). */
    _handler(hook: string): MockFn {
      const list = hooks.get(hook);
      if (!list || list.length === 0) throw new Error(`no handler registered for ${hook}`);
      return list[0];
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
    async _runTurn(ctx: ToolCtx, payload: { runId?: string; success?: boolean; messages?: any[]; prompt?: string; assistantTexts?: string[] }) {
      const runId = payload.runId ?? "r";
      await this._fire("llm_input", { runId, sessionId: "s", provider: "p", model: "m", prompt: payload.prompt ?? "" }, ctx);
      await this._fire("agent_end", { runId, messages: payload.messages ?? [], success: payload.success ?? true }, ctx);
      await this._fire("llm_output", { runId, sessionId: "s", provider: "p", model: "m", assistantTexts: payload.assistantTexts ?? [] }, ctx);
    },
  };
  return api as unknown as MockApi;
}

// ── network stub ─────────────────────────────────────────────────────────────

interface Call { url: string; method: string; authorization: string | null; signal: AbortSignal | null }

function installFetchStub(
  handler?: (call: Call) => { status?: number; body?: unknown },
  opts: { deferUntil?: Promise<unknown> } = {},
) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: any = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url: String(url),
      method: init.method ?? "GET",
      authorization: headers["Authorization"] ?? null,
      signal: (init.signal as AbortSignal | undefined) ?? null,
    };
    calls.push(call);
    const out = handler ? handler(call) : {};
    // A deferred stub holds the response open so a test can observe/act on a
    // write that is genuinely IN FLIGHT (and, if it ignores the signal, one
    // whose result resolves after an abort).
    if (opts.deferUntil) await opts.deferUntil;
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
  // Restore the injectable key probes and clock (a prior test may have
  // substituted them).
  signingKeyProbe.resolve = (a, kp) => resolveKeyPath(a, kp);
  signingKeyProbe.load = (f) => loadPrivateKey(f);
  captureClock.now = () => Date.now();
  Object.assign(captureBounds, CAPTURE_BOUNDS_DEFAULTS);
  captureProbe.detectEntities = REAL_DETECT_ENTITIES;
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

// The injectable clock for the per-run retirement rule (D10). On a build without
// it, substitutions below are inert (which is how the retirement test goes red).
let captureClock: { now: () => number };
try {
  captureClock = (await import("../index.ts") as any).captureClock ?? { now: () => Date.now() };
} catch {
  captureClock = { now: () => Date.now() };
}

// The bounds and the size introspection added in round 2 (F1/F2). On a build
// without them, substitutions are inert and the F2 tests go red.
const CAPTURE_BOUNDS_DEFAULTS = {
  idleRunRetireMs: 30 * 60_000,
  capacityCap: 10_000,
  tombstoneMinAgeMs: 60 * 60_000,
  abortOverflowCap: 1_000,
  logOnceCap: 10_000,
  sweepIntervalMs: 30_000,
};
let captureBounds: typeof CAPTURE_BOUNDS_DEFAULTS;
try {
  captureBounds = (await import("../index.ts") as any).captureBounds ?? { ...CAPTURE_BOUNDS_DEFAULTS };
} catch {
  captureBounds = { ...CAPTURE_BOUNDS_DEFAULTS };
}
// Round 5: the ONE run map's introspection. Every member is declared and given
// a fallback, so a build without it fails the round-5 assertions rather than a
// TypeError (and the fallbacks stay type-correct).
type RunRecordLike = {
  agentId: string;
  runId: string;
  phase: string;
  inFlight: number;
  endedAt: number | null;
  retiredAt: number | null;
};
let captureInternals: {
  runCount: () => number;
  budgetUsed: () => number;
  stateCount: () => number;
  tombstoneCount: () => number;
  logOnceCount: () => number;
  recordOf: (agentId: string, runId: string) => RunRecordLike | undefined;
};
const CAPTURE_INTERNALS_FALLBACK = {
  runCount: () => 0,
  budgetUsed: () => 0,
  stateCount: () => 0,
  tombstoneCount: () => 0,
  logOnceCount: () => 0,
  recordOf: () => undefined as RunRecordLike | undefined,
};
try {
  captureInternals = (await import("../index.ts") as any).captureInternals ?? CAPTURE_INTERNALS_FALLBACK;
} catch {
  captureInternals = CAPTURE_INTERNALS_FALLBACK;
}

// Round 6: the injectable entity scan. A build without it leaves the
// substitution below inert — the round-6 (f) test then fails on its "the throw
// was injected" and "no write started" assertions instead of passing silently.
type CaptureProbe = { detectEntities: (text: string) => unknown[] };
let captureProbe: CaptureProbe;
const CAPTURE_PROBE_FALLBACK: CaptureProbe = { detectEntities: (_text: string) => [] as unknown[] };
try {
  captureProbe = (await import("../index.ts") as any).captureProbe ?? CAPTURE_PROBE_FALLBACK;
} catch {
  captureProbe = CAPTURE_PROBE_FALLBACK;
}
// The real scan, saved at import time so `beforeEach` can restore it.
const REAL_DETECT_ENTITIES = captureProbe.detectEntities;

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
    expect(api._services.size).toBe(0);
    expect(api._contextEngines.size).toBe(0);
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
    expect(api._services.size).toBe(0);
    expect(api._contextEngines.size).toBe(0);
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
    expect(api._services.size).toBe(0);
    expect(api._contextEngines.size).toBe(0);
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
    expect(api._services.size).toBe(0);
    expect(api._contextEngines.size).toBe(0);
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
    expect(api._services.size).toBe(0);
    expect(api._contextEngines.size).toBe(0);
    expect(api._warnText()).toMatch(/identity cannot be guaranteed/);
  });

  test("R2b: an unreadable config -> registers nothing", async () => {
    writeKey("a");
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi({ config: null as unknown as Record<string, unknown> });
    plugin.register(api as any);
    expect(api._tools.size).toBe(0);
    expect(api._services.size).toBe(0);
    expect(api._contextEngines.size).toBe(0);
    expect(api._warnText()).toMatch(/identity cannot be guaranteed/);
  });

  test("S1: explicit keyPath binds ONLY the allowed agent — a second roster agent with no key of its own does not read as shared", async () => {
    // The design sanctions an explicit keyPath together with a single ALLOWED
    // agent. Applying that keyPath to EVERY roster agent made a second agent
    // "resolve" to the allowed agent's key, both read as readable, and the gate
    // refused with the SHARED-USER reason. Each agent's OWN key must decide.
    writeKey("A");
    // B has NO key of its own.
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi({
      config: { agents: { entries: { A: {}, B: {} } } },
      pluginConfig: { agentId: "A", keyPath: join(keyDir, "A.key") },
    });
    plugin.register(api as any);
    expect(api._tools.size).toBe(3);
    expect(api._warnText()).not.toMatch(/agents share an OS user/);
  });

  test("S1: same roster, but the second agent's OWN key is readable -> still refuses (two readable keys)", async () => {
    writeKey("A");
    writeKey("B");
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi({
      config: { agents: { entries: { A: {}, B: {} } } },
      pluginConfig: { agentId: "A", keyPath: join(keyDir, "A.key") },
    });
    plugin.register(api as any);
    expect(api._tools.size).toBe(0);
    expect(api._warnText()).toMatch(/agents share an OS user; identity cannot be guaranteed/);
  });

  test("S1: keyPath without an allowed agent is refused for THAT reason, before the readability check", async () => {
    writeKey("A");
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi({
      config: { agents: { entries: { A: {}, B: {} } } },
      pluginConfig: { keyPath: join(keyDir, "A.key") },
    });
    plugin.register(api as any);
    expect(api._tools.size).toBe(0);
    expect(api._warnText()).toMatch(/keyPath is only valid with a single allowed agent/);
    expect(api._warnText()).not.toMatch(/agents share an OS user/);
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

  test("capture is OFF by default: permission granted, no autoCapture config -> no capture hooks and zero reads", async () => {
    writeKey("A");
    const plugin = await loadPlugin();
    const calls = installFetchStub();
    const api = createMockApi({ config: cfgWith({ allowConversationAccess: true }) });
    plugin.register(api as any);
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

// ── slice 2 — capture done right (D5 / D11 / D14) ─────────────────────────────

describe("slice 2 — capture normalisation, ids and outcomes", () => {
  test("D5: a string and an equivalent text-block array normalise to the same capture text", async () => {
    const { captureText } = await loadModule();
    expect(captureText("hello world")).toBe("hello world");
    expect(captureText([{ type: "text", text: "hello world" }])).toBe("hello world");
    expect(captureText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("ab");
    expect(captureText([{ type: "text", text: "hello " }, { type: "text", text: "world" }])).toBe(captureText("hello world"));
  });

  test("D5: image, thinking and tool blocks contribute nothing and never leak their contents", async () => {
    const { captureText } = await loadModule();
    const text = captureText([
      { type: "text", text: "keep me" },
      { type: "image", image_url: "https://x/secret.png", text: "LEAK-IMAGE" },
      { type: "thinking", thinking: "LEAK-THINK" },
      { type: "tool_use", input: { secret: "LEAK-TOOL" }, text: "LEAK-TOOL-TEXT" },
      { type: "tool_result", content: "LEAK-RESULT" },
    ]);
    expect(text).toBe("keep me");
    for (const leak of ["LEAK-IMAGE", "LEAK-THINK", "LEAK-TOOL", "LEAK-RESULT"]) {
      expect(text).not.toContain(leak);
    }
  });

  test("D5: a block-shaped agent_end message is captured (mixed blocks contribute nothing)", async () => {
    writeKey("A");
    const plugin = await loadPlugin();
    const api = createMockApi({
      pluginConfig: { autoCapture: true },
      config: { plugins: { slots: { memory: "openclaw-flair" }, entries: { "openclaw-flair": { hooks: { allowConversationAccess: true } } } } },
    });
    const calls = installFetchStub();
    plugin.register(api as any);
    await api._fire("agent_end", {
      runId: "r",
      success: true,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "remember this: the block message is captured" },
          { type: "image", image_url: "https://x/secret.png" },
          { type: "thinking", thinking: "LEAKTHINK" },
        ],
      }],
    }, { agentId: "A" });
    const memPuts = calls.filter((c) => c.method === "PUT" && /\/Memory\//.test(c.url));
    expect(memPuts.length).toBe(1);
  });

  test("D11: 100 stores in a tight loop produce 100 distinct ids and 100 records", async () => {
    writeKey("A");
    const plugin = await loadPlugin();
    const calls = installFetchStub();
    const api = createMockApi();
    plugin.register(api as any);
    const store = api._resolveTool("memory_store", { agentId: "A" });
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const res = await store.execute(String(i), { text: `memory ${i}` });
      expect(res.details.written).toBe(true);
      ids.add(String(res.details.id));
    }
    expect(ids.size).toBe(100);
    const memPuts = calls.filter((c) => c.method === "PUT" && /\/Memory\//.test(c.url));
    expect(memPuts.length).toBe(100);
    expect(new Set(memPuts.map((c) => c.url)).size).toBe(100);
  });

  test("D14: a successful store reports written/id/supersedeClosed/errors", async () => {
    writeKey("A");
    const plugin = await loadPlugin();
    installFetchStub();
    const api = createMockApi();
    plugin.register(api as any);
    const store = api._resolveTool("memory_store", { agentId: "A" });
    const res = await store.execute("1", { text: "remember this" });
    expect(res.details.written).toBe(true);
    expect(typeof res.details.id).toBe("string");
    expect(res.details.supersedeClosed).toBe(false);
    expect(res.details.errors).toEqual([]);
  });

  test("D14: an unresolved identity returns a refusal outcome, never written:true", async () => {
    writeKey("A");
    const plugin = await loadPlugin();
    const calls = installFetchStub();
    const api = createMockApi();
    plugin.register(api as any);
    const store = api._resolveTool("memory_store", {});
    const res = await store.execute("1", { text: "remember this" });
    expect(calls.length).toBe(0);
    expect(res.details.written).toBe(false);
    expect(res.details.reason).toBe("no-identity");
  });

  test("D14: a partial success (memory written, supersede-close failed) is reported as exactly that", async () => {
    writeKey("A");
    const plugin = await loadPlugin();
    const oldId = "A-old-target";
    installFetchStub((call) => {
      if (call.method === "GET" && call.url.includes(`/Memory/${oldId}`)) {
        return { status: 200, body: { id: oldId, content: "old", agentId: "A" } };
      }
      if (call.method === "PUT" && call.url.includes(`/Memory/${oldId}`)) {
        return { status: 500, body: { error: "boom" } };
      }
      return { status: 200, body: {} };
    });
    const api = createMockApi();
    plugin.register(api as any);
    const store = api._resolveTool("memory_store", { agentId: "A" });
    const res = await store.execute("1", { text: "remember this", supersedes: oldId });
    expect(res.details.written).toBe(true);
    expect(res.details.supersedeClosed).toBe(false);
    expect(res.details.errors.length).toBe(1);
  });
});

// ── slice 2 — per-run state, reservation, retirement and abort (D10 / item 5) ──

/** Capture-enabled host: conversation permission granted, autoCapture on. */
const cfgCapture = () => ({
  agents: { entries: { A: {} } },
  plugins: {
    slots: { memory: "openclaw-flair" },
    entries: { "openclaw-flair": { hooks: { allowConversationAccess: true } } },
  },
});
const apiForCapture = (plugin: any) => {
  writeKey("A");
  const api = createMockApi({ pluginConfig: { autoCapture: true }, config: cfgCapture() });
  plugin.register(api as any);
  return api;
};
const puts = (calls: Call[]) => calls.filter((c) => c.method === "PUT" && /\/Memory\//.test(c.url));
const TRIGGER = "remember this: the per-run capture target is staging";
const waitFor = async (cond: () => boolean, ms = 1000): Promise<void> => {
  const start = Date.now();
  while (!cond() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 1));
};
const defer = () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = () => r(); });
  return { gate, release: () => release() };
};

describe("slice 2 — per-run capture state, retirement and abort", () => {
  test("D10 (mutation: reservation removed): a reservation taken before the await prevents a double write", async () => {
    const plugin = await loadPlugin();
    const d = defer();
    const calls = installFetchStub(undefined, { deferUntil: d.gate });
    const api = apiForCapture(plugin);
    const llmOut = api._handler("llm_output");
    const first = llmOut({ runId: "r", assistantTexts: [TRIGGER] }, { agentId: "A" });
    // A second callback for the SAME run and text while the first write is still
    // in flight: the synchronously-taken reservation must dedup it.
    const second = llmOut({ runId: "r", assistantTexts: [TRIGGER] }, { agentId: "A" });
    d.release();
    await Promise.all([first, second]);
    expect(puts(calls).length).toBe(1);
  });

  test("D10 (mutation: state keyed by agent only): two runs of one agent do not share a budget or dedup set", async () => {
    const plugin = await loadPlugin();
    const d = defer();
    const calls = installFetchStub(undefined, { deferUntil: d.gate });
    const api = apiForCapture(plugin);
    const llmOut = api._handler("llm_output");
    const first = llmOut({ runId: "run-1", assistantTexts: [TRIGGER] }, { agentId: "A" });
    const second = llmOut({ runId: "run-2", assistantTexts: [TRIGGER] }, { agentId: "A" });
    d.release();
    await Promise.all([first, second]);
    expect(puts(calls).length).toBe(2);
  });

  test("D10: a successful agent_end before llm_output does not retire the run — the llm_output capture still lands", async () => {
    const plugin = await loadPlugin();
    const calls = installFetchStub();
    const api = apiForCapture(plugin);
    await api._fire("agent_end", { runId: "r", success: true, messages: [] }, { agentId: "A" });
    await api._handler("llm_output")({ runId: "r", assistantTexts: [TRIGGER] }, { agentId: "A" });
    expect(puts(calls).length).toBe(1);
    expect(api._statusLine()).toMatch(/auto-captured 1 memory from live turn \(llm_output\)/);
  });

  test("D10: a callback 31 s after agent_end, with no in-flight writes, is dropped with a log naming the run", async () => {
    const plugin = await loadPlugin();
    const calls = installFetchStub();
    const api = apiForCapture(plugin);
    const base = 1_000_000;
    captureClock.now = () => base;
    await api._fire("agent_end", { runId: "r", success: true, messages: [] }, { agentId: "A" });
    captureClock.now = () => base + 31_000;
    await api._handler("llm_output")({ runId: "r", assistantTexts: [TRIGGER] }, { agentId: "A" });
    expect(puts(calls).length).toBe(0);
    expect(api._warnText()).toMatch(/dropped a callback for retired run r/);
  });

  test("D10: a callback that carries no runId is refused, with a ONE-TIME log", async () => {
    const plugin = await loadPlugin();
    const calls = installFetchStub();
    const api = apiForCapture(plugin);
    const llmOut = api._handler("llm_output");
    await llmOut({ assistantTexts: [TRIGGER] }, { agentId: "A" });
    await llmOut({ assistantTexts: [TRIGGER] }, { agentId: "A" });
    expect(puts(calls).length).toBe(0);
    const lines = api._warnText().split("\n").filter((l) => /no runId/.test(l));
    expect(lines.length).toBe(1);
  });

  test("item 5 (mutation: abort dropped): a failed agent_end starts no new write and discards a late result", async () => {
    const plugin = await loadPlugin();
    const d = defer();
    const calls = installFetchStub(undefined, { deferUntil: d.gate });
    const api = apiForCapture(plugin);
    const llmOut = api._handler("llm_output");
    const inFlight = llmOut({ runId: "r", assistantTexts: [TRIGGER] }, { agentId: "A" });
    await waitFor(() => puts(calls).length === 1);
    const fetchCall = puts(calls)[0]!;
    expect(fetchCall.signal).not.toBeNull();
    expect(fetchCall.signal!.aborted).toBe(false);
    // A FAILED agent_end for the run aborts it (item 5a).
    await api._fire("agent_end", { runId: "r", success: false, messages: [] }, { agentId: "A" });
    expect(fetchCall.signal!.aborted).toBe(true); // the run's signal reached the fetch
    d.release();
    await inFlight; // the result resolves AFTER the abort — it must be discarded
    const before = calls.length;
    await llmOut({ runId: "r", assistantTexts: [TRIGGER] }, { agentId: "A" });
    expect(calls.length).toBe(before); // no NEW write starts after the abort (a receipt already received may land)
    expect(api._warnText()).toMatch(/discarded a capture for run r/);
    expect(api._warnText()).toMatch(/dropped a callback for retired run r/);
  });

  test("item 5(b): gateway_stop aborts an in-flight capture", async () => {
    const plugin = await loadPlugin();
    const d = defer();
    const calls = installFetchStub(undefined, { deferUntil: d.gate });
    const api = apiForCapture(plugin);
    const inFlight = api._handler("llm_output")({ runId: "r", assistantTexts: [TRIGGER] }, { agentId: "A" });
    await waitFor(() => puts(calls).length === 1);
    const fetchCall = puts(calls)[0]!;
    await api._fire("gateway_stop", { reason: "shutdown" }, {});
    expect(fetchCall.signal!.aborted).toBe(true);
    d.release();
    await inFlight;
    expect(puts(calls).length).toBe(1); // no second write; the late result is discarded
    expect(api._warnText()).toMatch(/discarded a capture for run r/);
  });

  test("item 5(c): model_call_ended with failureKind 'aborted' aborts the run", async () => {
    const plugin = await loadPlugin();
    const d = defer();
    const calls = installFetchStub(undefined, { deferUntil: d.gate });
    const api = apiForCapture(plugin);
    const inFlight = api._handler("llm_output")({ runId: "r", assistantTexts: [TRIGGER] }, { agentId: "A" });
    await waitFor(() => puts(calls).length === 1);
    const fetchCall = puts(calls)[0]!;
    await api._fire(
      "model_call_ended",
      { runId: "r", callId: "c", provider: "p", model: "m", durationMs: 1, outcome: "error", failureKind: "aborted" },
      { agentId: "A" },
    );
    expect(fetchCall.signal!.aborted).toBe(true);
    d.release();
    await inFlight;
    expect(api._warnText()).toMatch(/discarded a capture for run r/);
  });
});

// ── round 2 — tombstone (F1), bounds (F2) and failed primary writes (F4) ──────

describe("slice 2 round 2 — tombstone, bounds and failed primary writes", () => {
  const TRIGGER2 = "remember this: the round two bound test target is staging";

  test("F1: a callback 31 s after a successful agent_end is dropped (tombstoned), never recreating the run", async () => {
    const plugin = await loadPlugin();
    const api = apiForCapture(plugin);
    const base = 2_000_000;
    captureClock.now = () => base;
    await api._fire("agent_end", { runId: "r", success: true, messages: [] }, { agentId: "A" });
    expect(captureInternals.stateCount()).toBe(1);
    captureClock.now = () => base + 31_000;
    const calls = installFetchStub();
    await api._handler("llm_output")({ runId: "r", assistantTexts: [TRIGGER2] }, { agentId: "A" });
    expect(puts(calls).length).toBe(0);
    expect(api._warnText()).toMatch(/dropped a callback for retired run r/);
    expect(captureInternals.stateCount()).toBe(0);
    expect(captureInternals.tombstoneCount()).toBe(1);
  });

  test("F1: a callback after an abort is dropped even after a later sweep", async () => {
    const plugin = await loadPlugin();
    const api = apiForCapture(plugin);
    const d = defer();
    const calls = installFetchStub(undefined, { deferUntil: d.gate });
    const llmOut = api._handler("llm_output");
    const inFlight = llmOut({ runId: "r", assistantTexts: [TRIGGER2] }, { agentId: "A" });
    await waitFor(() => puts(calls).length === 1);
    await api._fire("agent_end", { runId: "r", success: false, messages: [] }, { agentId: "A" });
    d.release();
    await inFlight;
    // A later sweep — the idle bound is reached and another run's callback runs it.
    const t = captureClock.now();
    captureClock.now = () => t + captureBounds.idleRunRetireMs + 1;
    await llmOut({ runId: "other", assistantTexts: ["a plain note"] }, { agentId: "A" });
    await llmOut({ runId: "r", assistantTexts: [TRIGGER2] }, { agentId: "A" });
    expect(puts(calls).length).toBe(1); // the aborted run starts no NEW write
    expect(api._warnText()).toMatch(/dropped a callback for retired run r/);
  });

  test("F2: 1,000 runs that never send agent_end are all retired after the idle bound", async () => {
    const plugin = await loadPlugin();
    const api = apiForCapture(plugin);
    installFetchStub();
    const base = 5_000_000;
    captureClock.now = () => base;
    const llmOut = api._handler("llm_output");
    for (let i = 0; i < 1000; i++) {
      await llmOut({ runId: `r${i}`, assistantTexts: [`plain note number ${i}`] }, { agentId: "A" });
    }
    expect(captureInternals.stateCount()).toBe(1000);
    captureClock.now = () => base + captureBounds.idleRunRetireMs + 1;
    await llmOut({ runId: "fresh", assistantTexts: ["another plain note"] }, { agentId: "A" });
    expect(captureInternals.stateCount()).toBe(1); // all 1,000 idle-retired; only "fresh" lives
    await llmOut({ runId: "r0", assistantTexts: ["another plain note"] }, { agentId: "A" });
    expect(api._warnText()).toMatch(/dropped a callback for retired run r0/);
  }, 30000);

  test("F2/round 4/round 5: the budget cap refuses new runs and never evicts a live record", async () => {
    captureBounds.capacityCap = 8;
    const plugin = await loadPlugin();
    const api = apiForCapture(plugin);
    installFetchStub();
    const llmOut = api._handler("llm_output");
    const admitted: Array<unknown> = [];
    for (let i = 0; i < 8; i++) {
      await llmOut({ runId: `r${i}`, assistantTexts: [`plain note number ${i}`] }, { agentId: "A" });
      admitted.push(captureInternals.recordOf("A", `r${i}`));
    }
    for (let i = 8; i < 20; i++) {
      await llmOut({ runId: `r${i}`, assistantTexts: [`plain note number ${i}`] }, { agentId: "A" });
    }
    // Round 5: the ONE budget (the map's size) is capped; the surplus runs are
    // refused, and no live record is ever evicted.
    expect(captureInternals.stateCount()).toBe(8);
    expect(captureInternals.budgetUsed()).toBe(8);
    expect(api._warnText()).toMatch(/capture-capacity: full/);
    expect(api._warnText()).not.toMatch(/evicted capture state/);
    // BY IDENTITY, not counts (round 5 (d)): a refused admission leaves the
    // ORIGINAL live runs intact — the SAME records, still live, none replaced —
    // and the refused run has no record at all.
    for (let i = 0; i < 8; i++) {
      const kept = captureInternals.recordOf("A", `r${i}`);
      expect(kept).toBe(admitted[i]);
      expect(kept!.phase).toBe("live");
    }
    expect(captureInternals.recordOf("A", "r19")).toBeUndefined();
  });

  test("F2: the one-time-log set is bounded", async () => {
    captureBounds.logOnceCap = 2;
    const plugin = await loadPlugin();
    const api = apiForCapture(plugin);
    installFetchStub();
    const llmOut = api._handler("llm_output");
    for (let i = 0; i < 6; i++) {
      // A key per agent, so `clientFor` resolves and the no-runId gate actually
      // runs `logOnce` (without it `captureGate` is never reached).
      writeKey(`agent${i}`);
      await llmOut({ assistantTexts: ["plain note"] }, { agentId: `agent${i}` });
    }
    expect(captureInternals.logOnceCount()).toBe(2);
  });

  test("F2: the sweep timer is unref'd and cleared on gateway_stop", async () => {
    const timers: any[] = [];
    const cleared: any[] = [];
    const origSI = globalThis.setInterval;
    const origCI = globalThis.clearInterval;
    (globalThis as any).setInterval = (fn: any, ms: any) => {
      const t: any = { fn, ms, unref: mock(() => {}) };
      timers.push(t);
      return t;
    };
    (globalThis as any).clearInterval = (t: any) => {
      cleared.push(t);
    };
    try {
      const plugin = await loadPlugin();
      const api = apiForCapture(plugin);
      const sweepTimer = timers.find((t) => t.ms === captureBounds.sweepIntervalMs);
      expect(sweepTimer).toBeTruthy();
      expect(sweepTimer.unref).toHaveBeenCalled();
      await api._fire("gateway_stop", { reason: "shutdown" }, {});
      expect(cleared).toContain(sweepTimer);
    } finally {
      (globalThis as any).setInterval = origSI;
      (globalThis as any).clearInterval = origCI;
    }
  });

  test("F4: a non-2xx primary write reports written:false and never attempts a supersede-close", async () => {
    writeKey("A");
    const plugin = await loadPlugin();
    const calls = installFetchStub((call) => {
      if (call.method === "PUT" && /\/Memory\//.test(call.url)) return { status: 500, body: { error: "boom" } };
      return { status: 200, body: { id: "old-target", content: "old", agentId: "A" } };
    });
    const api = createMockApi();
    plugin.register(api as any);
    const store = api._resolveTool("memory_store", { agentId: "A" });
    const res = await store.execute("1", { text: "remember this", supersedes: "old-target" });
    expect(res.details.written).toBe(false);
    expect(res.details.errors.length).toBe(1);
    expect(res.details.supersedeClosed).toBe(false);
    expect(calls.filter((c) => c.method === "PUT" && c.url.includes("/Memory/old-target")).length).toBe(0);
  });

  test("F4: a THROWING primary write reports written:false with the error, and no supersede-close", async () => {
    writeKey("A");
    const plugin = await loadPlugin();
    const calls = installFetchStub((call) => {
      if (call.method === "PUT" && /\/Memory\//.test(call.url)) throw new Error("network down");
      return { status: 200, body: { id: "old-target", content: "old", agentId: "A" } };
    });
    const api = createMockApi();
    plugin.register(api as any);
    const store = api._resolveTool("memory_store", { agentId: "A" });
    const res = await store.execute("1", { text: "remember this", supersedes: "old-target" });
    expect(res.details.written).toBe(false);
    expect(res.details.errors.join(" ")).toMatch(/network down/);
    expect(calls.filter((c) => c.method === "PUT" && c.url.includes("/Memory/old-target")).length).toBe(0);
  });
});

// ── round 3 — caps FAIL CLOSED; they never break a guarantee ─────────────────

describe("slice 2 round 3 — at capacity, capture fails closed", () => {
  const TRIGGER3 = "remember this: the round three capacity target is staging";

  test("item 1 (round 4): a full budget of YOUNG tombstones refuses a new run; old retired runs are not re-admitted", async () => {
    captureBounds.capacityCap = 3;
    const plugin = await loadPlugin();
    const api = apiForCapture(plugin);
    const base = 10_000_000;
    captureClock.now = () => base;
    // Fill the tombstone with three YOUNG entries.
    for (let i = 0; i < 3; i++) {
      await api._fire("agent_end", { runId: `old${i}`, success: false, messages: [] }, { agentId: "A" });
    }
    expect(captureInternals.tombstoneCount()).toBe(3);

    const calls = installFetchStub();
    const llmOut = api._handler("llm_output");
    // A NEW run is REFUSED (fail closed), not admitted by evicting a tombstone.
    await llmOut({ runId: "new", assistantTexts: [TRIGGER3] }, { agentId: "A" });
    expect(puts(calls).length).toBe(0);
    expect(api._warnText()).toMatch(/capture-capacity: full/);
    expect(captureInternals.stateCount()).toBe(0);
    // A previously retired run is STILL not re-admitted.
    await llmOut({ runId: "old0", assistantTexts: [TRIGGER3] }, { agentId: "A" });
    expect(puts(calls).length).toBe(0);
    expect(api._warnText()).toMatch(/dropped a callback for retired run old0/);
    expect(captureInternals.tombstoneCount()).toBe(3);

    // Past the minimum age every aged record is removable, so admission purges
    // them and admits (round 5: ONE predicate, shared with the sweep).
    captureClock.now = () => base + captureBounds.tombstoneMinAgeMs + 1;
    await llmOut({ runId: "new2", assistantTexts: ["a plain note"] }, { agentId: "A" });
    expect(captureInternals.stateCount()).toBe(1);
    expect(captureInternals.tombstoneCount()).toBe(0);
    expect(captureInternals.budgetUsed()).toBe(1);
  });

  test("item 2 (round 4): the budget cap never evicts an in-flight state; a new run is refused instead", async () => {
    captureBounds.capacityCap = 2;
    const plugin = await loadPlugin();
    const api = apiForCapture(plugin);
    const d = defer();
    const calls = installFetchStub(undefined, { deferUntil: d.gate });
    const llmOut = api._handler("llm_output");
    const p1 = llmOut({ runId: "r1", assistantTexts: [TRIGGER3] }, { agentId: "A" });
    const p2 = llmOut({ runId: "r2", assistantTexts: [TRIGGER3] }, { agentId: "A" });
    await waitFor(() => puts(calls).length === 2);
    expect(captureInternals.stateCount()).toBe(2);

    // Both states have a write in flight → a THIRD run is refused.
    await llmOut({ runId: "r3", assistantTexts: [TRIGGER3] }, { agentId: "A" });
    expect(captureInternals.stateCount()).toBe(2);
    expect(puts(calls).length).toBe(2); // no third write
    expect(api._warnText()).toMatch(/capture-capacity: full/);

    // The in-flight writes still COMPLETE (nothing was dropped to make room).
    d.release();
    await Promise.all([p1, p2]);
    expect(puts(calls).length).toBe(2);
    expect(captureInternals.stateCount()).toBe(2);
  });

  test("item 3: a failed agent_end ABORTS a run that was idle-retired with a write in flight", async () => {
    const plugin = await loadPlugin();
    const api = apiForCapture(plugin);
    const d = defer();
    const calls = installFetchStub(undefined, { deferUntil: d.gate });
    const llmOut = api._handler("llm_output");
    const p = llmOut({ runId: "r", assistantTexts: [TRIGGER3] }, { agentId: "A" });
    await waitFor(() => puts(calls).length === 1);

    // Idle-retire r while its write is in flight (another run's callback runs
    // the sweep). Round 5: r is retired IN PLACE and KEPT — the SAME record, with
    // inFlight 1 — so it still holds its slot.
    const t = captureClock.now();
    captureClock.now = () => t + captureBounds.idleRunRetireMs + 1;
    await llmOut({ runId: "other", assistantTexts: ["a plain note"] }, { agentId: "A" });
    expect(captureInternals.tombstoneCount()).toBe(1);
    expect(captureInternals.stateCount()).toBe(1); // only `other` can still capture
    expect(captureInternals.budgetUsed()).toBe(2); // r holds its slot while in flight

    // The tombstone gates ADMISSION only: the failed agent_end still ABORTS r.
    await api._fire("agent_end", { runId: "r", success: false, messages: [] }, { agentId: "A" });
    expect(puts(calls)[0]!.signal!.aborted).toBe(true);
    d.release();
    await p; // the late result is discarded — nothing captured
    expect(api._warnText()).toMatch(/discarded a capture for run r/);
    expect(api._statusLine()).not.toMatch(/auto-captured/);
  });
});

// ── round 4 — ONE combined capacity budget (live states + tombstones) ────────

describe("slice 2 round 4 — one combined capacity budget", () => {
  const PLAIN = "a plain note";

  test("(a) repeated aborts of NEVER-admitted runs are bounded by the cap PLUS the abort overflow", async () => {
    captureBounds.capacityCap = 3;
    captureBounds.abortOverflowCap = 1;
    const plugin = await loadPlugin();
    const api = apiForCapture(plugin);
    installFetchStub();
    for (let i = 0; i < 6; i++) {
      await api._fire("agent_end", { runId: `n${i}`, success: false, messages: [] }, { agentId: "A" });
    }
    // Round 5: an abort for a run with no record IS recorded (so no later
    // callback can re-admit the failed run), but only within the small overflow
    // above the cap; the rest record nothing and say so ONCE.
    expect(captureInternals.tombstoneCount()).toBe(4); // 3 in the budget + 1 overflow
    expect(captureInternals.budgetUsed()).toBe(4);
    const lines = api._warnText().split("\n").filter((l) => /capture-capacity: abort-overflow/.test(l));
    expect(lines.length).toBe(1);
  });

  test("(b) at a full budget of live states AND young tombstones, a new run is refused and NOTHING is evicted or tombstoned", async () => {
    captureBounds.capacityCap = 4;
    const plugin = await loadPlugin();
    const api = apiForCapture(plugin);
    installFetchStub();
    const llmOut = api._handler("llm_output");
    // Two live states …
    await llmOut({ runId: "live1", assistantTexts: [PLAIN] }, { agentId: "A" });
    await llmOut({ runId: "live2", assistantTexts: [PLAIN] }, { agentId: "A" });
    // … plus two young tombstones (never-admitted aborts) → budget 4 = full.
    await api._fire("agent_end", { runId: "ab1", success: false, messages: [] }, { agentId: "A" });
    await api._fire("agent_end", { runId: "ab2", success: false, messages: [] }, { agentId: "A" });
    expect(captureInternals.stateCount()).toBe(2);
    expect(captureInternals.tombstoneCount()).toBe(2);
    expect(captureInternals.budgetUsed()).toBe(4);

    await llmOut({ runId: "new", assistantTexts: [PLAIN] }, { agentId: "A" });
    // Refused, and NOTHING was mutated: no live state evicted, no tombstone added.
    expect(api._warnText()).toMatch(/capture-capacity: full/);
    expect(captureInternals.stateCount()).toBe(2);
    expect(captureInternals.tombstoneCount()).toBe(2);
    expect(captureInternals.budgetUsed()).toBe(4);
    expect(api._warnText()).not.toMatch(/evicted capture state/);
  });

  test("(c) retire or abort of an ADMITTED run at a full budget converts IN PLACE, without eviction", async () => {
    captureBounds.capacityCap = 2;
    const plugin = await loadPlugin();
    const api = apiForCapture(plugin);
    installFetchStub();
    const base = 30_000_000;
    captureClock.now = () => base;
    const llmOut = api._handler("llm_output");
    await llmOut({ runId: "r1", assistantTexts: [PLAIN] }, { agentId: "A" });
    await llmOut({ runId: "r2", assistantTexts: [PLAIN] }, { agentId: "A" });
    expect(captureInternals.budgetUsed()).toBe(2); // full

    // Retire r1 (a successful agent_end) IN PLACE — triggered by the next sweep.
    await api._fire("agent_end", { runId: "r1", success: true, messages: [] }, { agentId: "A" });
    captureClock.now = () => base + 31_000;
    await llmOut({ runId: "r2", assistantTexts: [PLAIN] }, { agentId: "A" }); // runs the sweep
    expect(captureInternals.budgetUsed()).toBe(2);
    expect(captureInternals.stateCount()).toBe(1);
    expect(captureInternals.tombstoneCount()).toBe(1);

    // Abort r2 IN PLACE too: the same slot becomes its tombstone.
    await api._fire("agent_end", { runId: "r2", success: false, messages: [] }, { agentId: "A" });
    expect(captureInternals.budgetUsed()).toBe(2);
    expect(captureInternals.stateCount()).toBe(0);
    expect(captureInternals.tombstoneCount()).toBe(2);
    expect(api._warnText()).not.toMatch(/evicted capture state/);
  });

  test("(d) once tombstones age past the minimum, admission frees exactly ONE aged tombstone and admits", async () => {
    captureBounds.capacityCap = 2;
    const plugin = await loadPlugin();
    const api = apiForCapture(plugin);
    installFetchStub();
    const base = 40_000_000;
    captureClock.now = () => base;
    for (let i = 0; i < 2; i++) {
      await api._fire("agent_end", { runId: `old${i}`, success: false, messages: [] }, { agentId: "A" });
    }
    expect(captureInternals.budgetUsed()).toBe(2); // full of YOUNG tombstones

    const llmOut = api._handler("llm_output");
    await llmOut({ runId: "x", assistantTexts: [PLAIN] }, { agentId: "A" });
    expect(api._warnText()).toMatch(/capture-capacity: full/);
    expect(captureInternals.stateCount()).toBe(0);

    // Past the minimum age every aged record is removable, so admission purges
    // both and admits (round 5's ONE predicate, shared with the sweep).
    captureClock.now = () => base + captureBounds.tombstoneMinAgeMs + 1;
    await llmOut({ runId: "y", assistantTexts: [PLAIN] }, { agentId: "A" });
    expect(captureInternals.stateCount()).toBe(1);
    expect(captureInternals.tombstoneCount()).toBe(0);
    expect(captureInternals.budgetUsed()).toBe(1);
  });
});

// ── round 5 — ONE run map, ONE removal predicate ─────────────────────────────
//
// The shape is the fix: one record per run, the budget is the map's size, and
// one predicate (`removable`) is the only thing that frees a slot. These four
// tests assert the law, not the patch:
//   (a) an aged record with a write in flight is NOT removable and frees nothing;
//   (b) a full budget with an aged record cannot re-admit a failed run — the
//       abort is recorded (overflow) and its later callback is dropped;
//   (c) when even the abort overflow is full, the abort records nothing ONCE;
//   (d) the earlier capacity tests re-expressed on the single map: a refused
//       admission leaves the ORIGINAL runs intact, by identity, not counts.

describe("slice 2 round 5 — one run map, one removal predicate", () => {
  const PLAIN5 = "a plain note";
  const TRIGGER5 = "remember this: the round five capacity target is staging";

  test("(a) an aged record with a write in flight is NOT removed and does not free admission", async () => {
    captureBounds.capacityCap = 1;
    const plugin = await loadPlugin();
    const api = apiForCapture(plugin);
    const d = defer();
    const calls = installFetchStub(undefined, { deferUntil: d.gate });
    const base = 50_000_000;
    captureClock.now = () => base;
    const llmOut = api._handler("llm_output");
    const inFlight = llmOut({ runId: "r", assistantTexts: [TRIGGER5] }, { agentId: "A" });
    await waitFor(() => puts(calls).length === 1);
    const held = captureInternals.recordOf("A", "r");
    expect(held).toBeTruthy();
    expect(held!.inFlight).toBe(1);

    // Retire r IN PLACE (the idle rule, run by another callback), then age it
    // past `tombstoneMinAgeMs`: with no write in flight it would be removable
    // now, so ONLY `inFlight` keeps it in the map.
    const t1 = base + captureBounds.idleRunRetireMs + 1;
    captureClock.now = () => t1;
    await llmOut({ runId: "primer", assistantTexts: [PLAIN5] }, { agentId: "A" });
    expect(held!.phase).toBe("retired");
    expect(captureInternals.runCount()).toBe(1);

    captureClock.now = () => t1 + captureBounds.tombstoneMinAgeMs + 1;
    const pNew = llmOut({ runId: "new", assistantTexts: [TRIGGER5] }, { agentId: "A" });
    // Give a SECOND write every chance to start before asserting it did not.
    await waitFor(() => puts(calls).length > 1, 250);

    // The record survived BY IDENTITY and still holds the whole budget, so the
    // new run was refused: an in-flight write never frees a slot.
    expect(captureInternals.recordOf("A", "r")).toBe(held);
    expect(captureInternals.recordOf("A", "new")).toBeUndefined();
    expect(captureInternals.runCount()).toBe(1);
    expect(puts(calls).length).toBe(1); // and no new write started
    expect(api._warnText()).toMatch(/capture-capacity: full/);

    d.release();
    await pNew;
    await inFlight;
  });

  test("(b) a full budget with an aged record: an abort for a never-seen run IS recorded (overflow) and its later callback is dropped", async () => {
    captureBounds.capacityCap = 1;
    const plugin = await loadPlugin();
    const api = apiForCapture(plugin);
    const base = 60_000_000;
    captureClock.now = () => base;
    // Fill the ONE budget with a never-admitted abort, then age it past the
    // minimum: it IS removable, but nothing has purged it yet.
    await api._fire("agent_end", { runId: "old", success: false, messages: [] }, { agentId: "A" });
    expect(captureInternals.runCount()).toBe(1);
    captureClock.now = () => base + captureBounds.tombstoneMinAgeMs + 1;

    // A failed run that was never seen still gets a record, using the overflow —
    // otherwise its next callback evicts `old` and is admitted, and a failed run
    // captures again (the round-4 finding). Assert THAT first: the law is the
    // drop, not the record.
    await api._fire("agent_end", { runId: "ghost", success: false, messages: [] }, { agentId: "A" });

    const calls = installFetchStub();
    await api._handler("llm_output")({ runId: "ghost", assistantTexts: [TRIGGER5] }, { agentId: "A" });
    expect(puts(calls).length).toBe(0); // dropped, never re-admitted
    expect(api._warnText()).toMatch(/dropped a callback for retired run ghost/);

    // And the drop is structural: the callback's own sweep purged the now-aged
    // `old`, so the ONLY record left is the one the abort inserted.
    const ghost = captureInternals.recordOf("A", "ghost");
    expect(ghost).toBeTruthy();
    expect(ghost!.phase).toBe("aborted");
    expect(captureInternals.recordOf("A", "old")).toBeUndefined();
    expect(captureInternals.runCount()).toBe(1);
  });

  test("(c) with the budget AND its abort overflow full, an abort records nothing and logs once", async () => {
    captureBounds.capacityCap = 1;
    captureBounds.abortOverflowCap = 1;
    const plugin = await loadPlugin();
    const api = apiForCapture(plugin);
    const base = 70_000_000;
    captureClock.now = () => base;
    await api._fire("agent_end", { runId: "a", success: false, messages: [] }, { agentId: "A" }); // the budget
    // Round 6: both fills must be UNREMOVABLE. The abort path now purges aged
    // records before it asks for room, so an aged fill would free a slot instead
    // of holding one; the aged case is (e) in the round-6 block.
    await api._fire("agent_end", { runId: "ghost", success: false, messages: [] }, { agentId: "A" }); // the overflow
    await api._fire("agent_end", { runId: "ghost2", success: false, messages: [] }, { agentId: "A" }); // nothing left
    await api._fire("agent_end", { runId: "ghost3", success: false, messages: [] }, { agentId: "A" });

    // The residual is a ONE-TIME line, and the assertion that matters most is
    // that the line exists at all (a build without the overflow says nothing).
    const lines = api._warnText().split("\n").filter((l) => /capture-capacity: abort-overflow/.test(l));
    expect(lines.length).toBe(1); // logged ONCE, however many aborts arrive
    expect(captureInternals.runCount()).toBe(2); // the budget (1) + the overflow (1)
    expect(captureInternals.recordOf("A", "ghost")).toBeTruthy();
    expect(captureInternals.recordOf("A", "ghost2")).toBeUndefined();
    expect(captureInternals.recordOf("A", "ghost3")).toBeUndefined();
  });

  test("(d) re-expressed on the single map: a refused admission leaves the original records intact, by identity", async () => {
    captureBounds.capacityCap = 3;
    const plugin = await loadPlugin();
    const api = apiForCapture(plugin);
    installFetchStub();
    const llmOut = api._handler("llm_output");
    const base = 80_000_000;
    captureClock.now = () => base;
    const admitted: Array<unknown> = [];
    for (let i = 0; i < 3; i++) {
      await llmOut({ runId: `r${i}`, assistantTexts: [PLAIN5] }, { agentId: "A" });
      admitted.push(captureInternals.recordOf("A", `r${i}`));
    }
    // A fourth run is refused: nothing evicted, nothing replaced, nothing added.
    await llmOut({ runId: "r3", assistantTexts: [PLAIN5] }, { agentId: "A" });
    expect(api._warnText()).toMatch(/capture-capacity: full/);
    expect(captureInternals.runCount()).toBe(3);
    expect(captureInternals.recordOf("A", "r3")).toBeUndefined();
    for (let i = 0; i < 3; i++) {
      const kept = captureInternals.recordOf("A", `r${i}`);
      expect(kept).toBe(admitted[i]); // the SAME record, by identity
      expect(kept!.phase).toBe("live");
    }

    // Retire them IN PLACE (a successful agent_end + the 30 s rule): the records
    // are the SAME ones, and the budget is unchanged because the phase changed.
    for (let i = 0; i < 3; i++) {
      await api._fire("agent_end", { runId: `r${i}`, success: true, messages: [] }, { agentId: "A" });
    }
    captureClock.now = () => base + 31_000;
    await llmOut({ runId: "warm", assistantTexts: [PLAIN5] }, { agentId: "A" }); // runs the sweep
    expect(captureInternals.runCount()).toBe(3);
    expect(captureInternals.stateCount()).toBe(0);
    expect(captureInternals.tombstoneCount()).toBe(3);
    expect(captureInternals.recordOf("A", "r0")).toBe(admitted[0]); // still the same record

    // Age them: now the ONE predicate frees all three, and a new run is admitted.
    captureClock.now = () => base + 31_000 + captureBounds.tombstoneMinAgeMs + 1;
    await llmOut({ runId: "r4", assistantTexts: [PLAIN5] }, { agentId: "A" });
    expect(captureInternals.stateCount()).toBe(1);
    expect(captureInternals.tombstoneCount()).toBe(0);
    expect(captureInternals.runCount()).toBe(1);
  });
});

// ── round 6 — every room-asking path purges, no throw strands a reservation, stop clears the map ──
//
// Three leftovers from round 5, each a place where the code asked a question and
// did the wrong thing with the answer:
//   (e) the abort path asks "is there room" without purging first, so a map full
//       at cap + overflow — nothing removable at the abort's instant, the aged
//       records one age-tick later — refuses an abort that must be recorded, and
//       the run's next callback is then admitted by admission's own purge;
//   (f) the entity scan sits between the reservation and the `try` that releases
//       it, so a throw strands `inFlight` above 0 and the record is never
//       removable (a slot held for the life of the process);
//   (g) `gateway_stop` aborts the records but never clears the map.

describe("slice 2 round 6 — purge before the room check, no stranded reservation, stop clears the map", () => {
  const TRIGGER6 = "remember this: the round six abort target is staging";
  const PLAIN6 = "a plain note";

  test("(e) a never-admitted abort in a map full at cap + overflow is RECORDED, and its callback is dropped with zero writes", async () => {
    captureBounds.capacityCap = 3;
    captureBounds.abortOverflowCap = 1;
    const plugin = await loadPlugin();
    const api = apiForCapture(plugin);
    const calls = installFetchStub();
    const base = 90_000_000;

    // t0: three never-admitted aborts fill the budget. They are young here.
    captureClock.now = () => base;
    for (let i = 0; i < 3; i++) {
      await api._fire("agent_end", { runId: `aged${i}`, success: false, messages: [] }, { agentId: "A" });
    }
    expect(captureInternals.runCount()).toBe(captureBounds.capacityCap);

    // D — the abort that takes the overflow — arrives one tick BEFORE the three
    // reach the minimum age. At this instant the map is full at cap + overflow
    // with NOTHING removable: A-C are a tick short of the age, D is young.
    captureClock.now = () => base + captureBounds.tombstoneMinAgeMs - 1;
    await api._fire("agent_end", { runId: "young", success: false, messages: [] }, { agentId: "A" });
    expect(captureInternals.recordOf("A", "young")).toBeTruthy();
    expect(captureInternals.runCount()).toBe(captureBounds.capacityCap + captureBounds.abortOverflowCap);

    // The clock passes A-C's minimum age; D is still young (its age is 2 ms), so
    // the map is STILL full at cap + overflow. This is the state the next abort
    // must find room in: full, and full of records that are only just removable.
    captureClock.now = () => base + captureBounds.tombstoneMinAgeMs + 1;
    expect(captureInternals.runCount()).toBe(captureBounds.capacityCap + captureBounds.abortOverflowCap);

    // The abort path ASKS FOR ROOM and purges FIRST: A-C qualify now, so the
    // purge frees three slots, there IS room, and the abort IS recorded. A path
    // that asks WITHOUT purging reads the full map, records nothing, and the
    // run's next callback is then admitted by admission's own purge — a capture
    // write starting AFTER the abort.
    await api._fire("agent_end", { runId: "unknown", success: false, messages: [] }, { agentId: "A" });
    const rec = captureInternals.recordOf("A", "unknown");
    expect(rec).toBeTruthy();
    expect(rec!.phase).toBe("aborted");

    // And that record is what makes the run's next callback a no-op: zero writes.
    await api._handler("llm_output")({ runId: "unknown", assistantTexts: [TRIGGER6] }, { agentId: "A" });
    expect(puts(calls).length).toBe(0);
    expect(api._warnText()).toMatch(/dropped a callback for retired run unknown/);
  });

  test("(f) a THROW from the entity scan leaves inFlight at 0 and its record removable", async () => {
    captureBounds.capacityCap = 1;
    const plugin = await loadPlugin();
    const api = apiForCapture(plugin);
    const calls = installFetchStub();
    const base = 100_000_000;
    captureClock.now = () => base;
    const real = captureProbe.detectEntities;
    captureProbe.detectEntities = () => {
      throw new Error("entity scan exploded");
    };
    try {
      await api._handler("llm_output")({ runId: "r", assistantTexts: [TRIGGER6] }, { agentId: "A" });
    } finally {
      captureProbe.detectEntities = real;
    }
    // The throw was injected AND reported, and no write started.
    expect(api._warnText()).toMatch(/entity scan exploded/);
    expect(puts(calls).length).toBe(0);
    // Nothing may sit between the reservation and the `try` that releases it, so
    // the record carries NO in-flight write.
    const rec = captureInternals.recordOf("A", "r");
    expect(rec).toBeTruthy();
    expect(rec!.inFlight).toBe(0);

    // So the record IS removable: abort it, age it, and let admission purge it.
    // A stranded `inFlight` would hold the whole budget instead.
    captureClock.now = () => base + 1;
    await api._fire("agent_end", { runId: "r", success: false, messages: [] }, { agentId: "A" });
    captureClock.now = () => base + 1 + captureBounds.tombstoneMinAgeMs + 1;
    await api._handler("llm_output")({ runId: "next", assistantTexts: [PLAIN6] }, { agentId: "A" });
    expect(captureInternals.recordOf("A", "r")).toBeUndefined();
    expect(captureInternals.recordOf("A", "next")).toBeTruthy();
  });

  test("(g) gateway_stop clears the run map (after aborting the live controllers)", async () => {
    const plugin = await loadPlugin();
    const api = apiForCapture(plugin);
    const d = defer();
    const calls = installFetchStub(undefined, { deferUntil: d.gate });
    const llmOut = api._handler("llm_output");
    const inFlight = llmOut({ runId: "r1", assistantTexts: [TRIGGER6] }, { agentId: "A" });
    await waitFor(() => puts(calls).length === 1);
    const settled = llmOut({ runId: "r2", assistantTexts: [PLAIN6] }, { agentId: "A" });
    await waitFor(() => puts(calls).length === 2);
    expect(captureInternals.runCount()).toBe(2);

    await api._fire("gateway_stop", { reason: "shutdown" }, {});
    // The controllers were aborted on the way out AND the map is empty — the
    // records are not left reachable until the next registration.
    expect(puts(calls)[0]!.signal!.aborted).toBe(true);
    expect(captureInternals.runCount()).toBe(0);
    expect(captureInternals.stateCount()).toBe(0);
    expect(captureInternals.tombstoneCount()).toBe(0);

    d.release();
    await Promise.all([inFlight, settled]);
  });
});
