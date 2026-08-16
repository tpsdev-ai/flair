/**
 * Unit tests for FlairMemoryService (TypeScript port).
 *
 * Mirrors the Python test suite at packages/adk-flair/tests/test_memory_service.py.
 * Uses mock fetch to avoid requiring a live Flair instance.
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { FlairMemoryService } from "../../src/memory_service.js";
import { compoundTag, sanitizeTagSegment, desanitizeTagSegment } from "../../src/tag.js";
import { loadEd25519Key, signRequest, expandHome } from "../../src/signing.js";
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
    // Colons are percent-encoded (%3A) so the compound-tag delimiter ':'
    // remains the only literal colon in the tag.
    expect(sanitizeTagSegment("org:admin")).toBe("org%3Aadmin");
    expect(compoundTag("app:name", "user:id")).toBe("adk:app%3Aname:user%3Aid");
  });

  it("handles empty segments", () => {
    expect(compoundTag("app", "")).toBe("adk:app:");
  });

  it("does not collide ':' and '_' (regression #1205, Sherlock)", () => {
    // The old ':' -> '_' scheme mapped 'alice:admin' and 'alice_admin' to the
    // SAME tag. They must now differ — the compound tag is the per-user
    // access-control boundary. (Mirrors the Python suite.)
    expect(sanitizeTagSegment("alice:admin")).not.toBe(sanitizeTagSegment("alice_admin"));
    expect(compoundTag("app", "alice:admin")).not.toBe(compoundTag("app", "alice_admin"));
    expect(sanitizeTagSegment("alice:admin")).toBe("alice%3Aadmin");
    expect(sanitizeTagSegment("alice_admin")).toBe("alice%5Fadmin");
  });

  it("encoding is injective, incl. the literal-escape trap", () => {
    // 'alice%3Aadmin' (literal) must not collide with 'alice:admin' (encoded).
    const tricky = [
      "alice:admin", "alice_admin", "alice%3Aadmin", "alice%5Fadmin",
      "alice%admin", "alice", "a:b_c", "a_b:c", "%25", ":", "_", "%",
    ];
    const encoded = tricky.map(sanitizeTagSegment);
    expect(new Set(encoded).size).toBe(new Set(tricky).size);
  });

  it("round-trips through desanitize for every reserved-char combination", () => {
    const inputs = [
      "", "normal", "alice:admin", "alice_admin", "a:b_c:d",
      "%", "%25", "%3A", "%5F", "%253A", "::__%%", "user@host:1_2",
    ];
    for (const x of inputs) {
      expect(desanitizeTagSegment(sanitizeTagSegment(x))).toBe(x);
    }
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

  it("loads a raw 32-byte seed keyfile (the `flair agent add` format)", () => {
    // `flair agent add <id>` writes the private key as a raw 32-byte Ed25519
    // seed (src/cli.ts), NOT PKCS8 base64. A cold user following the README
    // points FLAIR_KEYFILE straight at ~/.flair/keys/<id>.key, so the adapter
    // must read that format — otherwise the documented quickstart never works.
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }); // 48 bytes
    const seed = pkcs8.subarray(16); // raw 32-byte seed
    expect(seed.length).toBe(32);
    const seedPath = path.join(os.tmpdir(), `adk-flair-seed-${crypto.randomUUID()}.key`);
    fs.writeFileSync(seedPath, seed); // binary, exactly like the CLI
    try {
      const key = loadEd25519Key(seedPath);
      expect(key.asymmetricKeyType).toBe("ed25519");
    } finally {
      fs.unlinkSync(seedPath);
    }
  });

  it("expands a leading ~/ to the home directory", () => {
    // Point os.homedir() at a temp dir and drop a keyfile under ~/.flair/keys/.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "adk-flair-home-"));
    const keysDir = path.join(fakeHome, ".flair", "keys");
    fs.mkdirSync(keysDir, { recursive: true });
    fs.copyFileSync(keyfilePath, path.join(keysDir, "agent.key"));
    const homedirSpy = spyOn(os, "homedir").mockReturnValue(fakeHome);
    try {
      expect(expandHome("~/.flair/keys/agent.key")).toBe(
        path.join(fakeHome, ".flair", "keys", "agent.key"),
      );
      const key = loadEd25519Key("~/.flair/keys/agent.key");
      expect(key.asymmetricKeyType).toBe("ed25519");
    } finally {
      homedirSpy.mockRestore();
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("throws a clear error naming the expanded path when a ~ keyfile is missing", () => {
    const homedirSpy = spyOn(os, "homedir").mockReturnValue("/fake/home");
    try {
      // Never a bare ENOENT — the message must name the resolved path and stay
      // FLAIR_KEYFILE-tagged so the constructor's error contract holds.
      expect(() => loadEd25519Key("~/.flair/keys/missing.key")).toThrow("FLAIR_KEYFILE");
      expect(() => loadEd25519Key("~/.flair/keys/missing.key")).toThrow(
        "/fake/home/.flair/keys/missing.key",
      );
    } finally {
      homedirSpy.mockRestore();
    }
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

  it("re-verification matches the escaped compound tag on read", async () => {
    // A userId that requires escaping still matches on read: the encoded
    // compound tag written on ingest is the one re-verified on search, and a
    // neighbour that COLLIDED under the old scheme ('alice_admin') is NOT
    // accepted for userId='alice:admin'. (Mirrors the Python suite.)
    const wanted = compoundTag("my-app", "alice:admin");     // adk:my-app:alice%3Aadmin
    const neighbour = compoundTag("my-app", "alice_admin");  // adk:my-app:alice%5Fadmin
    expect(wanted).not.toBe(neighbour);

    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          results: [
            { content: "mine", tags: [wanted] },
            { content: "neighbour", tags: [neighbour] },
          ],
        }),
        { status: 200 },
      );
    });

    const result = await service.searchMemory({
      appName: "my-app",
      userId: "alice:admin",
      query: "fact",
    });

    const texts = result.memories.map((m) => (m.content?.parts?.[0] as { text?: string })?.text);
    expect(texts).toEqual(["mine"]);
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

  it("generateContentAsync terminates and yields exactly one final response", async () => {
    registerOllamaLlm();

    // Mock fetch to return a valid Ollama chat response
    const originalFetch = globalThis.fetch;
    const mockFetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            model: "llama3.2",
            created_at: "2026-01-01T00:00:00Z",
            message: { role: "assistant", content: "Hello from Ollama!" },
            done: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const instance = LLMRegistry.newLlm("ollama_chat/llama3.2") as OllamaLlm;
      const request: LlmRequest = {
        contents: [{ role: "user", parts: [{ text: "Hi" }] }],
      };

      const responses: LlmResponse[] = [];
      for await (const r of instance.generateContentAsync(request)) {
        responses.push(r);
      }

      // Must yield exactly one response
      expect(responses).toHaveLength(1);

      const resp = responses[0];
      // Must have content with the model's reply
      expect(resp.content?.role).toBe("model");
      expect(resp.content?.parts?.[0]?.text).toBe("Hello from Ollama!");
      // Must have finishReason (mirrors Gemini non-streaming shape)
      expect(resp.finishReason).toBe("STOP");
      // Must NOT have partial flag (signals turn completion)
      expect(resp.partial).toBeUndefined();
      // Must NOT have error fields
      expect(resp.errorCode).toBeUndefined();
      expect(resp.errorMessage).toBeUndefined();

      // Verify fetch was called with stream:false and keep_alive
      const fetchCall = mockFetch.mock.calls[0] as [string, RequestInit];
      const fetchBody = JSON.parse(fetchCall[1].body as string);
      expect(fetchBody.stream).toBe(false);
      expect(fetchBody.keep_alive).toBe("10m");
      expect(fetchBody.model).toBe("llama3.2");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("generateContentAsync yields error on non-ok response", async () => {
    registerOllamaLlm();

    const originalFetch = globalThis.fetch;
    const mockFetch = mock(() =>
      Promise.resolve(
        new Response("model not found", { status: 404 }),
      ),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const instance = LLMRegistry.newLlm("ollama_chat/llama3.2") as OllamaLlm;
      const request: LlmRequest = {
        contents: [{ role: "user", parts: [{ text: "Hi" }] }],
      };

      const responses: LlmResponse[] = [];
      for await (const r of instance.generateContentAsync(request)) {
        responses.push(r);
      }

      expect(responses).toHaveLength(1);
      expect(responses[0].errorCode).toBe("404");
      expect(responses[0].errorMessage).toContain("Ollama API error 404");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("generateContentAsync throws on abort — never yields empty content", async () => {
    registerOllamaLlm();

    const originalFetch = globalThis.fetch;
    // Simulate a fetch that never resolves (aborted by timeout)
    const mockFetch = mock(
      (_url: string, init?: RequestInit) =>
        new Promise<never>((_, reject) => {
          // Listen for abort on the signal and reject with AbortError
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              const err = new DOMException("The operation was aborted", "AbortError");
              reject(err);
              return;
            }
            signal.addEventListener("abort", () => {
              const err = new DOMException("The operation was aborted", "AbortError");
              reject(err);
            }, { once: true });
          }
        }),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    // Override timeout to 100ms for fast test
    process.env["ADK_TEST_OLLAMA_TIMEOUT_MS"] = "100";

    try {
      // Must re-register to pick up the new timeout (the class reads
      // the env var at the module level, but the timeout is read inside
      // generateContentAsync each call — actually it's a module-level
      // const, so we need to re-import.  Instead, we just test that the
      // abort path throws by passing our own AbortController.
      const instance = LLMRegistry.newLlm("ollama_chat/llama3.2") as OllamaLlm;
      const request: LlmRequest = {
        contents: [{ role: "user", parts: [{ text: "Hi" }] }],
      };

      // Pass a pre-aborted signal to force the abort path
      const abortedController = new AbortController();
      abortedController.abort();

      // The generator must throw, not yield empty content
      await expect(
        (async () => {
          for await (const _r of instance.generateContentAsync(
            request,
            undefined,
            abortedController.signal,
          )) {
            // If we get here, the test fails — abort should throw, not yield
            throw new Error("generator yielded instead of throwing on abort");
          }
        })(),
      ).rejects.toThrow(/aborted|timeout/i);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env["ADK_TEST_OLLAMA_TIMEOUT_MS"];
    }
  });

  it("string systemInstruction lands as a system-role message", async () => {
    registerOllamaLlm();

    const originalFetch = globalThis.fetch;
    const mockFetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            model: "llama3.2",
            message: { role: "assistant", content: "ok" },
            done: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const instance = LLMRegistry.newLlm("ollama_chat/llama3.2") as OllamaLlm;
      const request: LlmRequest = {
        contents: [{ role: "user", parts: [{ text: "Hi" }] }],
        config: {
          systemInstruction: "You are a helpful assistant.",
        },
      };

      const responses: LlmResponse[] = [];
      for await (const r of instance.generateContentAsync(request)) {
        responses.push(r);
      }

      expect(responses).toHaveLength(1);

      // Verify the system message was included in the Ollama body
      const fetchCall = mockFetch.mock.calls[0] as [string, RequestInit];
      const fetchBody = JSON.parse(fetchCall[1].body as string);
      const systemMsg = fetchBody.messages.find(
        (m: { role: string }) => m.role === "system",
      );
      expect(systemMsg).toBeDefined();
      expect(systemMsg.content).toBe("You are a helpful assistant.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("appendInstructions string concat survives round-trip to system message", async () => {
    registerOllamaLlm();

    // adk-js appendInstructions writes config.systemInstruction as a
    // plain string (+= concat).  Simulate what the agent loop produces
    // after PreloadMemoryTool injects PAST_CONVERSATIONS.

    const originalFetch = globalThis.fetch;
    const mockFetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            model: "llama3.2",
            message: { role: "assistant", content: "ok" },
            done: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const instance = LLMRegistry.newLlm("ollama_chat/llama3.2") as OllamaLlm;

      // Simulate what appendInstructions produces: a plain string with
      // the original instruction + "\n\n" + appended instructions.
      const request: LlmRequest = {
        contents: [{ role: "user", parts: [{ text: "Hi" }] }],
        config: {
          systemInstruction:
            "You are a helpful assistant.\n\n" +
            "Remember: always be polite.\n\n" +
            "PAST_CONVERSATIONS:\nUser previously said hello.",
        },
      };

      const responses: LlmResponse[] = [];
      for await (const r of instance.generateContentAsync(request)) {
        responses.push(r);
      }

      expect(responses).toHaveLength(1);

      const fetchCall = mockFetch.mock.calls[0] as [string, RequestInit];
      const fetchBody = JSON.parse(fetchCall[1].body as string);
      const systemMsg = fetchBody.messages.find(
        (m: { role: string }) => m.role === "system",
      );
      expect(systemMsg).toBeDefined();
      // Must contain the original instruction AND the appended text
      expect(systemMsg.content).toContain("You are a helpful assistant.");
      expect(systemMsg.content).toContain("Remember: always be polite.");
      expect(systemMsg.content).toContain("PAST_CONVERSATIONS");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
