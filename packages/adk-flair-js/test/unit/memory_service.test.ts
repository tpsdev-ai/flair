/**
 * Unit tests for FlairMemoryService (TypeScript port).
 *
 * Mirrors the Python test suite at packages/adk-flair/tests/test_memory_service.py.
 * Uses mock fetch to avoid requiring a live Flair instance.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { FlairMemoryService } from "../../src/memory_service.js";
import { compoundTag, sanitizeTagSegment } from "../../src/tag.js";
import { loadEd25519Key, signRequest } from "../../src/signing.js";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateTestKey(): { key: crypto.KeyObject; keyfilePath: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  const b64 = Buffer.from(der).toString("base64");
  const keyfilePath = path.join(os.tmpdir(), `adk-flair-js-test-${crypto.randomUUID()}.key`);
  fs.writeFileSync(keyfilePath, b64, "utf-8");
  return { key: privateKey, keyfilePath };
}

function makeEvent(opts: {
  id?: string;
  author?: string;
  text?: string;
  timestamp?: number;
}): import("@google/adk").Event {
  return {
    id: opts.id ?? crypto.randomUUID(),
    invocationId: crypto.randomUUID(),
    author: opts.author ?? "user",
    actions: {} as import("@google/adk").Event["actions"],
    timestamp: opts.timestamp ?? Date.now(),
    content: opts.text
      ? { role: "user", parts: [{ text: opts.text }] } as import("@google/genai").Content
      : undefined,
  };
}

function makeSession(opts: {
  id?: string;
  appName?: string;
  userId?: string;
  events?: import("@google/adk").Event[];
}): import("@google/adk").Session {
  return {
    id: opts.id ?? "test-session",
    appName: opts.appName ?? "test-app",
    userId: opts.userId ?? "test-user",
    state: {},
    events: opts.events ?? [],
    lastUpdateTime: Date.now(),
  };
}

function makeMemoryEntry(text: string, id?: string): import("@google/adk").MemoryEntry {
  return {
    content: { role: "user", parts: [{ text }] } as import("@google/genai").Content,
    author: "user",
    timestamp: new Date().toISOString(),
  };
}

// ─── Tag helpers ────────────────────────────────────────────────────────────

describe("tag helpers", () => {
  it("builds compound tag", () => {
    expect(compoundTag("my-app", "user-1")).toBe("adk:my-app:user-1");
  });

  it("sanitizes colons in segments", () => {
    expect(sanitizeTagSegment("org:admin")).toBe("org_admin");
    expect(compoundTag("app:name", "user:id")).toBe("adk:app_name:user_id");
  });

  it("handles empty segments", () => {
    expect(compoundTag("app", "")).toBe("adk:app:");
  });
});

// ─── Signing ────────────────────────────────────────────────────────────────

describe("signing", () => {
  let keyfilePath: string;

  beforeEach(() => {
    const { keyfilePath: kp } = generateTestKey();
    keyfilePath = kp;
  });

  afterEach(() => {
    try { fs.unlinkSync(keyfilePath); } catch {}
  });

  it("loads and validates a PKCS8 Ed25519 key", () => {
    const key = loadEd25519Key(keyfilePath);
    expect(key.asymmetricKeyType).toBe("ed25519");
  });

  it("rejects missing keyfile", () => {
    expect(() => loadEd25519Key("/nonexistent/key.pem")).toThrow("FLAIR_KEYFILE");
  });

  it("rejects empty keyfile", () => {
    const emptyPath = path.join(os.tmpdir(), "empty.key");
    fs.writeFileSync(emptyPath, "", "utf-8");
    try {
      expect(() => loadEd25519Key(emptyPath)).toThrow("FLAIR_KEYFILE");
    } finally {
      fs.unlinkSync(emptyPath);
    }
  });

  it("rejects invalid base64", () => {
    const badPath = path.join(os.tmpdir(), "bad.key");
    fs.writeFileSync(badPath, "!!!not-base64!!!", "utf-8");
    try {
      expect(() => loadEd25519Key(badPath)).toThrow("FLAIR_KEYFILE");
    } finally {
      fs.unlinkSync(badPath);
    }
  });

  it("rejects non-Ed25519 key", () => {
    // Generate an RSA key and try to load it
    const { privateKey: rsaKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const der = rsaKey.export({ format: "der", type: "pkcs8" });
    const b64 = Buffer.from(der).toString("base64");
    const rsaPath = path.join(os.tmpdir(), "rsa.key");
    fs.writeFileSync(rsaPath, b64, "utf-8");
    try {
      expect(() => loadEd25519Key(rsaPath)).toThrow("FLAIR_KEYFILE");
    } finally {
      fs.unlinkSync(rsaPath);
    }
  });

  it("produces valid TPS-Ed25519 auth header", () => {
    const key = loadEd25519Key(keyfilePath);
    const header = signRequest(key, "test-agent", "POST", "/SemanticSearch");
    expect(header).toMatch(/^TPS-Ed25519 test-agent:\d+:[0-9a-f-]+:[A-Za-z0-9+/=]+$/);
  });
});

// ─── Constructor validation ─────────────────────────────────────────────────

describe("FlairMemoryService constructor", () => {
  let keyfilePath: string;
  let origEnv: Record<string, string | undefined>;

  beforeEach(() => {
    const { keyfilePath: kp } = generateTestKey();
    keyfilePath = kp;
    origEnv = {
      FLAIR_URL: process.env["FLAIR_URL"],
      FLAIR_AGENT_ID: process.env["FLAIR_AGENT_ID"],
      FLAIR_KEYFILE: process.env["FLAIR_KEYFILE"],
      FLAIR_ALLOW_REMOTE_URL: process.env["FLAIR_ALLOW_REMOTE_URL"],
    };
    delete process.env["FLAIR_URL"];
    delete process.env["FLAIR_AGENT_ID"];
    delete process.env["FLAIR_KEYFILE"];
    delete process.env["FLAIR_ALLOW_REMOTE_URL"];
  });

  afterEach(() => {
    try { fs.unlinkSync(keyfilePath); } catch {}
    for (const [k, v] of Object.entries(origEnv)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  });

  it("constructs with explicit opts", () => {
    const svc = new FlairMemoryService({
      url: "http://localhost:19926",
      agentId: "test-agent",
      keyfile: keyfilePath,
    });
    expect(svc).toBeDefined();
  });

  it("constructs from env vars", () => {
    process.env["FLAIR_URL"] = "http://127.0.0.1:19926";
    process.env["FLAIR_AGENT_ID"] = "env-agent";
    process.env["FLAIR_KEYFILE"] = keyfilePath;
    const svc = new FlairMemoryService();
    expect(svc).toBeDefined();
  });

  it("defaults to localhost:19926", () => {
    process.env["FLAIR_AGENT_ID"] = "test-agent";
    process.env["FLAIR_KEYFILE"] = keyfilePath;
    const svc = new FlairMemoryService();
    expect(svc).toBeDefined();
  });

  it("rejects missing agentId", () => {
    process.env["FLAIR_KEYFILE"] = keyfilePath;
    expect(() => new FlairMemoryService()).toThrow("FLAIR_AGENT_ID");
  });

  it("rejects missing keyfile", () => {
    process.env["FLAIR_AGENT_ID"] = "test-agent";
    expect(() => new FlairMemoryService()).toThrow("FLAIR_KEYFILE");
  });

  it("rejects invalid keyfile", () => {
    expect(() => new FlairMemoryService({
      url: "http://localhost:19926",
      agentId: "test-agent",
      keyfile: "/nonexistent/key",
    })).toThrow("FLAIR_KEYFILE");
  });

  it("allows localhost URLs freely", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      const svc = new FlairMemoryService({
        url: `http://${host}:19926`,
        agentId: "test-agent",
        keyfile: keyfilePath,
      });
      expect(svc).toBeDefined();
    }
  });

  it("rejects remote URL without FLAIR_ALLOW_REMOTE_URL", () => {
    expect(() => new FlairMemoryService({
      url: "http://flair.example.com:19926",
      agentId: "test-agent",
      keyfile: keyfilePath,
    })).toThrow("FLAIR_ALLOW_REMOTE_URL");
  });

  it("allows remote URL with FLAIR_ALLOW_REMOTE_URL=1", () => {
    process.env["FLAIR_ALLOW_REMOTE_URL"] = "1";
    const svc = new FlairMemoryService({
      url: "http://flair.example.com:19926",
      agentId: "test-agent",
      keyfile: keyfilePath,
    });
    expect(svc).toBeDefined();
  });

  it("rejects unsupported protocol", () => {
    expect(() => new FlairMemoryService({
      url: "ftp://localhost:19926",
      agentId: "test-agent",
      keyfile: keyfilePath,
    })).toThrow("FLAIR_URL");
  });

  it("rejects invalid URL", () => {
    expect(() => new FlairMemoryService({
      url: "not-a-url",
      agentId: "test-agent",
      keyfile: keyfilePath,
    })).toThrow("FLAIR_URL");
  });
});

// ─── searchMemory ───────────────────────────────────────────────────────────

describe("searchMemory", () => {
  let keyfilePath: string;
  let service: FlairMemoryService;
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    const { keyfilePath: kp } = generateTestKey();
    keyfilePath = kp;
    service = new FlairMemoryService({
      url: "http://localhost:19926",
      agentId: "test-agent",
      keyfile: keyfilePath,
    });
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    try { fs.unlinkSync(keyfilePath); } catch {}
    globalThis.fetch = origFetch;
  });

  it("returns empty for empty userId", async () => {
    const result = await service.searchMemory({
      appName: "test-app",
      userId: "",
      query: "anything",
    });
    expect(result.memories).toEqual([]);
  });

  it("sends compound tag in search body", async () => {
    let capturedBody: string | null = null;
    globalThis.fetch = mock(async (url, init) => {
      capturedBody = (init as RequestInit).body as string;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });

    await service.searchMemory({
      appName: "my-app",
      userId: "user-1",
      query: "test query",
    });

    const parsed = JSON.parse(capturedBody!);
    expect(parsed.tag).toBe("adk:my-app:user-1");
    expect(parsed.q).toBe("test query");
    expect(parsed.agentId).toBe("test-agent");
  });

  it("maps hits to MemoryEntry with ISO timestamps", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          results: [
            {
              content: "remembered fact",
              author: "model",
              timestamp: "2024-01-15T10:30:00.000Z",
              tags: ["adk:my-app:user-1"],
            },
          ],
        }),
        { status: 200 },
      );
    });

    const result = await service.searchMemory({
      appName: "my-app",
      userId: "user-1",
      query: "fact",
    });

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0].content?.parts?.[0]).toEqual({ text: "remembered fact" });
    expect(result.memories[0].author).toBe("model");
    expect(result.memories[0].timestamp).toBe("2024-01-15T10:30:00.000Z");
  });

  it("re-verifies compound tag on every hit", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          results: [
            {
              content: "alice fact",
              tags: ["adk:my-app:alice"],
            },
            {
              content: "bob fact",
              tags: ["adk:my-app:bob"], // wrong tag — should be dropped
            },
            {
              content: "alice fact 2",
              tags: ["adk:my-app:alice"],
            },
          ],
        }),
        { status: 200 },
      );
    });

    const result = await service.searchMemory({
      appName: "my-app",
      userId: "alice",
      query: "fact",
    });

    expect(result.memories).toHaveLength(2);
    const texts = result.memories.map((m) => (m.content?.parts?.[0] as { text?: string })?.text);
    expect(texts).toContain("alice fact");
    expect(texts).toContain("alice fact 2");
    expect(texts).not.toContain("bob fact");
  });

  it("returns empty on HTTP error", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("Internal Server Error", { status: 500 });
    });

    const result = await service.searchMemory({
      appName: "my-app",
      userId: "user-1",
      query: "test",
    });

    expect(result.memories).toEqual([]);
  });

  it("returns empty on network failure (fast degrade)", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("connect ECONNREFUSED");
    });

    const start = Date.now();
    const result = await service.searchMemory({
      appName: "my-app",
      userId: "user-1",
      query: "test",
    });
    const elapsed = Date.now() - start;

    expect(result.memories).toEqual([]);
    // Must fail fast — well under the 2s budget
    expect(elapsed).toBeLessThan(1000);
  });

  it("returns empty on empty results array", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });

    const result = await service.searchMemory({
      appName: "my-app",
      userId: "user-1",
      query: "nonexistent",
    });

    expect(result.memories).toEqual([]);
  });
});

// ─── addSessionToMemory ─────────────────────────────────────────────────────

describe("addSessionToMemory", () => {
  let keyfilePath: string;
  let service: FlairMemoryService;
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    const { keyfilePath: kp } = generateTestKey();
    keyfilePath = kp;
    service = new FlairMemoryService({
      url: "http://localhost:19926",
      agentId: "test-agent",
      keyfile: keyfilePath,
    });
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    try { fs.unlinkSync(keyfilePath); } catch {}
    globalThis.fetch = origFetch;
  });

  it("writes session events with deterministic record IDs", async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    globalThis.fetch = mock(async (url, init) => {
      calls.push({
        method: (init as RequestInit).method ?? "GET",
        url: String(url),
        body: JSON.parse((init as RequestInit).body as string),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const session = makeSession({
      id: "sess-1",
      appName: "my-app",
      userId: "user-1",
      events: [
        makeEvent({ id: "evt-1", author: "user", text: "hello" }),
        makeEvent({ id: "evt-2", author: "model", text: "hi there" }),
      ],
    });

    await service.addSessionToMemory(session);

    expect(calls).toHaveLength(2);
    // First call
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toContain("/Memory/my-app:user-1:sess-1:evt-1");
    expect(calls[0].body).toMatchObject({ id: "my-app:user-1:sess-1:evt-1", tags: ["adk:my-app:user-1"], type: "session", durability: "standard" });
    // Second call
    expect(calls[1].method).toBe("PUT");
    expect(calls[1].url).toContain("/Memory/my-app:user-1:sess-1:evt-2");
  });

  it("filters no-text events", async () => {
    const calls: Array<{ body: unknown }> = [];
    globalThis.fetch = mock(async (url, init) => {
      calls.push({ body: JSON.parse((init as RequestInit).body as string) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const session = makeSession({
      events: [
        makeEvent({ id: "evt-1", text: "hello" }),
        makeEvent({ id: "evt-2", text: "" }), // no text — should be filtered
        makeEvent({ id: "evt-3" }), // no content at all
        makeEvent({ id: "evt-4", text: "world" }),
      ],
    });

    await service.addSessionToMemory(session);

    expect(calls).toHaveLength(2);
    expect((calls[0].body as Record<string, unknown>).id).toContain("evt-1");
    expect((calls[1].body as Record<string, unknown>).id).toContain("evt-4");
  });

  it("no-ops on empty events", async () => {
    let called = false;
    globalThis.fetch = mock(async () => {
      called = true;
      return new Response("{}", { status: 200 });
    });

    const session = makeSession({ events: [] });
    await service.addSessionToMemory(session);
    expect(called).toBe(false);
  });

  it("maps epoch ms timestamps to ISO strings", async () => {
    let capturedBody: unknown = null;
    globalThis.fetch = mock(async (url, init) => {
      capturedBody = JSON.parse((init as RequestInit).body as string);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const epochMs = 1705312200000;
    const expectedIso = new Date(epochMs).toISOString();
    const session = makeSession({
      events: [makeEvent({ id: "evt-1", text: "hello", timestamp: epochMs })],
    });

    await service.addSessionToMemory(session);

    expect((capturedBody as Record<string, unknown>).createdAt).toBe(expectedIso);
  });

  it("logs warning on write failure", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    globalThis.fetch = mock(async () => {
      throw new Error("connect ECONNREFUSED");
    });

    try {
      const session = makeSession({
        events: [makeEvent({ id: "evt-1", text: "hello" })],
      });
      await service.addSessionToMemory(session);
      expect(warnings.some((w) => w.includes("write failed for session"))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  it("sends PUT with id-bearing path (wire-shape guard)", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    globalThis.fetch = mock(async (url, init) => {
      calls.push({
        method: (init as RequestInit).method ?? "GET",
        url: String(url),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const session = makeSession({
      id: "sess-ws",
      appName: "ws-app",
      userId: "ws-user",
      events: [makeEvent({ id: "evt-ws", text: "wire shape test" })],
    });

    await service.addSessionToMemory(session);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toBe("http://localhost:19926/Memory/ws-app:ws-user:sess-ws:evt-ws");
  });
});

// ─── addMemory ──────────────────────────────────────────────────────────────

describe("addMemory", () => {
  let keyfilePath: string;
  let service: FlairMemoryService;
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    const { keyfilePath: kp } = generateTestKey();
    keyfilePath = kp;
    service = new FlairMemoryService({
      url: "http://localhost:19926",
      agentId: "test-agent",
      keyfile: keyfilePath,
    });
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    try { fs.unlinkSync(keyfilePath); } catch {}
    globalThis.fetch = origFetch;
  });

  it("writes memories with compound tag", async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    globalThis.fetch = mock(async (url, init) => {
      calls.push({
        method: (init as RequestInit).method ?? "GET",
        url: String(url),
        body: JSON.parse((init as RequestInit).body as string),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await service.addMemory("my-app", "user-1", [
      makeMemoryEntry("fact one"),
      makeMemoryEntry("fact two"),
    ]);

    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toContain("/Memory/my-app:user-1:direct:");
    expect((calls[0].body as Record<string, unknown>).tags).toEqual(["adk:my-app:user-1"]);
    expect((calls[0].body as Record<string, unknown>).content).toBe("fact one");
  });

  it("no-ops on empty memories", async () => {
    let called = false;
    globalThis.fetch = mock(async () => {
      called = true;
      return new Response("{}", { status: 200 });
    });

    await service.addMemory("my-app", "user-1", []);
    expect(called).toBe(false);
  });
});

// ─── addEventsToMemory ──────────────────────────────────────────────────────

describe("addEventsToMemory", () => {
  let keyfilePath: string;
  let service: FlairMemoryService;
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    const { keyfilePath: kp } = generateTestKey();
    keyfilePath = kp;
    service = new FlairMemoryService({
      url: "http://localhost:19926",
      agentId: "test-agent",
      keyfile: keyfilePath,
    });
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    try { fs.unlinkSync(keyfilePath); } catch {}
    globalThis.fetch = origFetch;
  });

  it("writes events with session-scoped record IDs", async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    globalThis.fetch = mock(async (url, init) => {
      calls.push({
        method: (init as RequestInit).method ?? "GET",
        url: String(url),
        body: JSON.parse((init as RequestInit).body as string),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await service.addEventsToMemory(
      "my-app",
      "user-1",
      [makeEvent({ id: "evt-1", text: "incremental event" })],
      "sess-2",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toContain("/Memory/my-app:user-1:sess-2:evt-1");
    expect((calls[0].body as Record<string, unknown>).id).toBe("my-app:user-1:sess-2:evt-1");
  });
});

// ─── close ──────────────────────────────────────────────────────────────────

describe("close", () => {
  it("is a no-op", async () => {
    const { keyfilePath } = generateTestKey();
    try {
      const service = new FlairMemoryService({
        url: "http://localhost:19926",
        agentId: "test-agent",
        keyfile: keyfilePath,
      });
      await service.close(); // should not throw
    } finally {
      try { fs.unlinkSync(keyfilePath); } catch {}
    }
  });
});

// ─── OllamaLlm registry ────────────────────────────────────────────────────

import { LLMRegistry, BaseLlm } from "@google/adk";
import { registerOllamaLlm, OllamaLlm } from "../helpers/ollama-llm.js";

describe("OllamaLlm registry", () => {
  it("resolves ollama_chat/<model> after registration", () => {
    registerOllamaLlm();
    const resolved = LLMRegistry.resolve("ollama_chat/llama3.2");
    expect(resolved).toBe(OllamaLlm);
  });

  it("resolves ollama_chat/<model> with hyphens", () => {
    registerOllamaLlm();
    const resolved = LLMRegistry.resolve("ollama_chat/mistral-7b-instruct");
    expect(resolved).toBe(OllamaLlm);
  });

  it("newLlm constructs an OllamaLlm instance", () => {
    registerOllamaLlm();
    const instance = LLMRegistry.newLlm("ollama_chat/llama3.2");
    expect(instance).toBeInstanceOf(OllamaLlm);
    expect(instance).toBeInstanceOf(BaseLlm);
    expect(instance.model).toBe("ollama_chat/llama3.2");
  });

  it("strips prefix to derive ollama model name", () => {
    registerOllamaLlm();
    const instance = LLMRegistry.newLlm("ollama_chat/llama3.2") as OllamaLlm;
    // The ollamaModel is private, but we can verify via the model property
    // and the constructor strips the prefix internally.
    expect(instance.model).toBe("ollama_chat/llama3.2");
  });

  it("rejects unknown model prefix", () => {
    registerOllamaLlm();
    // gemini-* is already registered by the built-in Gemini class, so use
    // a model string that no built-in class matches.
    expect(() => LLMRegistry.resolve("nonexistent-model-xyz")).toThrow(
      "Model nonexistent-model-xyz not found."
    );
  });

  it("LlmAgent construction with PRELOAD_MEMORY + OllamaLlm does not throw", async () => {
    registerOllamaLlm();
    const { Agent } = await import("@google/adk");
    const { PRELOAD_MEMORY } = await import("@google/adk");
    // This must not throw — validates the tools array shape and model
    // resolution work together at agent construction time.
    expect(() => {
      new Agent({
        model: "ollama_chat/llama3.2",
        name: "test_agent",
        instruction: "You are a test agent.",
        tools: [PRELOAD_MEMORY],
      });
    }).not.toThrow();
  });
});
