import { describe, test, expect, mock, beforeEach, spyOn } from "bun:test";

// Mock fetch globally
const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;

beforeEach(() => {
  mockFetch = mock(() => Promise.resolve(new Response("{}", { status: 200 })));
  globalThis.fetch = mockFetch as any;
});

// Import after mock setup
const { FlairClient, FlairError } = await import("../src/client.js");
const authMod = await import("../src/auth.js");
import { generateKeyPairSync } from "node:crypto";

describe("FlairClient", () => {
  test("constructor uses default URL when none provided", () => {
    const client = new FlairClient({ agentId: "test" });
    expect(client.url).toBe("http://localhost:19926");
  });

  test("constructor uses provided URL", () => {
    const client = new FlairClient({ agentId: "test", url: "http://custom:1234" });
    expect(client.url).toBe("http://custom:1234");
  });

  test("constructor strips trailing slash from URL", () => {
    const client = new FlairClient({ agentId: "test", url: "http://example.com/" });
    expect(client.url).toBe("http://example.com");
  });

  test("constructor uses FLAIR_URL env var", () => {
    process.env.FLAIR_URL = "http://envvar:5555";
    const client = new FlairClient({ agentId: "test" });
    expect(client.url).toBe("http://envvar:5555");
    delete process.env.FLAIR_URL;
  });

  test("agentId is set from config", () => {
    const client = new FlairClient({ agentId: "mybot" });
    expect(client.agentId).toBe("mybot");
  });
});

describe("MemoryApi", () => {
  test("write returns constructed record with ID", async () => {
    // Harper PUT returns {}
    mockFetch = mock(() => Promise.resolve(new Response("{}", { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    const result = await client.memory.write("hello world");

    expect(result.id).toMatch(/^test-/);
    expect(result.content).toBe("hello world");
    expect(result.agentId).toBe("test");
    expect(result.type).toBe("session");
    expect(result.durability).toBe("standard");
  });

  test("write with custom options", async () => {
    mockFetch = mock(() => Promise.resolve(new Response("{}", { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    const result = await client.memory.write("important decision", {
      type: "decision",
      durability: "persistent",
      tags: ["project-x"],
    });

    expect(result.type).toBe("decision");
    expect(result.durability).toBe("persistent");
    expect(result.tags).toEqual(["project-x"]);
  });

  test("write with custom ID", async () => {
    mockFetch = mock(() => Promise.resolve(new Response("{}", { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    const result = await client.memory.write("hello", { id: "custom-id-123" });

    expect(result.id).toBe("custom-id-123");
  });

  test("search maps _score from response", async () => {
    const searchResponse = {
      results: [
        { id: "mem-1", content: "first result", _score: 0.85, type: "fact", createdAt: "2026-03-21" },
        { id: "mem-2", content: "second result", _score: 0.72, type: "lesson" },
      ],
    };
    mockFetch = mock(() => Promise.resolve(new Response(JSON.stringify(searchResponse), { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    const results = await client.memory.search("test query");

    expect(results).toHaveLength(2);
    expect(results[0].score).toBe(0.85);
    expect(results[0].id).toBe("mem-1");
    expect(results[0].content).toBe("first result");
    expect(results[1].score).toBe(0.72);
  });

  test("search with minScore filters results", async () => {
    const searchResponse = {
      results: [
        { id: "mem-1", content: "high", _score: 0.85 },
        { id: "mem-2", content: "low", _score: 0.3 },
      ],
    };
    mockFetch = mock(() => Promise.resolve(new Response(JSON.stringify(searchResponse), { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    const results = await client.memory.search("test", { minScore: 0.5 });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("mem-1");
  });

  test("search returns empty array when no results", async () => {
    mockFetch = mock(() => Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    const results = await client.memory.search("nothing");

    expect(results).toHaveLength(0);
  });

  test("get returns null on 404", async () => {
    mockFetch = mock(() => Promise.resolve(new Response('{"error":"not found"}', { status: 404 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    const result = await client.memory.get("nonexistent");

    expect(result).toBeNull();
  });

  test("delete calls DELETE method", async () => {
    mockFetch = mock(() => Promise.resolve(new Response("{}", { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    await client.memory.delete("mem-1");

    expect(mockFetch).toHaveBeenCalled();
    const call = (mockFetch as any).mock.calls[0];
    expect(call[0]).toContain("/Memory/mem-1");
    expect(call[1].method).toBe("DELETE");
  });

  test("dedup skips for short content", async () => {
    // Short content should NOT trigger a search
    mockFetch = mock(() => Promise.resolve(new Response("{}", { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    const result = await client.memory.write("short", { dedup: true });

    // Should have made only 1 call (PUT), not 2 (search + PUT)
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.content).toBe("short");
  });

  test("list POSTs conditions body with agentId scope", async () => {
    mockFetch = mock(() => Promise.resolve(new Response("[]", { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "testAgentId" });
    await client.memory.list();

    expect(mockFetch).toHaveBeenCalled();
    const call = (mockFetch as any).mock.calls[0];
    expect(call[0]).toBe("http://localhost:19926/Memory/search_by_conditions");
    expect(call[1].method).toBe("POST");
    const body = JSON.parse(call[1].body);
    expect(body.operator).toBe("and");
    expect(body.get_attributes).toEqual(["*"]);
    expect(body.conditions).toEqual([
      { search_attribute: "agentId", search_type: "equals", search_value: "testAgentId" },
    ]);
  });

  test("list with subject adds equals condition", async () => {
    mockFetch = mock(() => Promise.resolve(new Response("[]", { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    await client.memory.list({ subject: "project-x" });

    const body = JSON.parse((mockFetch as any).mock.calls[0][1].body);
    expect(body.conditions).toEqual([
      { search_attribute: "agentId", search_type: "equals", search_value: "test" },
      { search_attribute: "subject", search_type: "equals", search_value: "project-x" },
    ]);
  });

  test("list with tags creates separate contains condition per tag", async () => {
    mockFetch = mock(() => Promise.resolve(new Response("[]", { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    await client.memory.list({ tags: ["foo", "bar"] });

    const body = JSON.parse((mockFetch as any).mock.calls[0][1].body);
    expect(body.conditions).toEqual([
      { search_attribute: "agentId", search_type: "equals", search_value: "test" },
      { search_attribute: "tags", search_type: "contains", search_value: "foo" },
      { search_attribute: "tags", search_type: "contains", search_value: "bar" },
    ]);
  });

  test("list with type adds equals condition", async () => {
    mockFetch = mock(() => Promise.resolve(new Response("[]", { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    await client.memory.list({ type: "session" });

    const body = JSON.parse((mockFetch as any).mock.calls[0][1].body);
    expect(body.conditions).toEqual([
      { search_attribute: "agentId", search_type: "equals", search_value: "test" },
      { search_attribute: "type", search_type: "equals", search_value: "session" },
    ]);
  });

  test("list with durability adds equals condition", async () => {
    mockFetch = mock(() => Promise.resolve(new Response("[]", { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    await client.memory.list({ durability: "ephemeral" });

    const body = JSON.parse((mockFetch as any).mock.calls[0][1].body);
    expect(body.conditions).toEqual([
      { search_attribute: "agentId", search_type: "equals", search_value: "test" },
      { search_attribute: "durability", search_type: "equals", search_value: "ephemeral" },
    ]);
  });

  test("list with limit puts it in body.limit field", async () => {
    mockFetch = mock(() => Promise.resolve(new Response("[]", { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    await client.memory.list({ limit: 10 });

    const body = JSON.parse((mockFetch as any).mock.calls[0][1].body);
    expect(body.limit).toBe(10);
    // No limit in body when not specified
    const client2 = new FlairClient({ agentId: "test2" });
    await client2.memory.list();
    const body2 = JSON.parse((mockFetch as any).mock.calls[1][1].body);
    expect(body2.limit).toBeUndefined();
  });

  test("list with order sorts client-side (asc)", async () => {
    const memories = [
      { id: "a", agentId: "test", content: "first", type: "session", durability: "standard", tags: [], createdAt: "2026-01-01T00:00:00Z" },
      { id: "b", agentId: "test", content: "second", type: "session", durability: "standard", tags: [], createdAt: "2026-03-01T00:00:00Z" },
      { id: "c", agentId: "test", content: "third", type: "session", durability: "standard", tags: [], createdAt: "2026-02-01T00:00:00Z" },
    ];
    mockFetch = mock(() => Promise.resolve(new Response(JSON.stringify(memories), { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    const result = await client.memory.list({ order: "createdAt-asc" });

    expect(result[0].id).toBe("a");
    expect(result[1].id).toBe("c");
    expect(result[2].id).toBe("b");
  });

  test("list with order sorts client-side (desc)", async () => {
    const memories = [
      { id: "a", agentId: "test", content: "first", type: "session", durability: "standard", tags: [], createdAt: "2026-01-01T00:00:00Z" },
      { id: "b", agentId: "test", content: "second", type: "session", durability: "standard", tags: [], createdAt: "2026-03-01T00:00:00Z" },
    ];
    mockFetch = mock(() => Promise.resolve(new Response(JSON.stringify(memories), { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    const result = await client.memory.list({ order: "createdAt-desc" });

    expect(result[0].id).toBe("b");
    expect(result[1].id).toBe("a");
  });

  test("list handles { results: [...] } response shape", async () => {
    const results = {
      results: [
        { id: "m1", agentId: "test", content: "x", type: "session", durability: "standard", tags: [], createdAt: "2026-01-01T00:00:00Z" },
      ],
    };
    mockFetch = mock(() => Promise.resolve(new Response(JSON.stringify(results), { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    const result = await client.memory.list();

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m1");
  });

  test("list combines all filters in one conditions array", async () => {
    mockFetch = mock(() => Promise.resolve(new Response("[]", { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    await client.memory.list({
      limit: 10,
      type: "lesson",
      durability: "persistent",
      subject: "chat:abc",
      tags: ["important", "urgent"],
    });

    const body = JSON.parse((mockFetch as any).mock.calls[0][1].body);
    expect(body.limit).toBe(10);
    expect(body.conditions).toEqual([
      { search_attribute: "agentId", search_type: "equals", search_value: "test" },
      { search_attribute: "subject", search_type: "equals", search_value: "chat:abc" },
      { search_attribute: "tags", search_type: "contains", search_value: "important" },
      { search_attribute: "tags", search_type: "contains", search_value: "urgent" },
      { search_attribute: "type", search_type: "equals", search_value: "lesson" },
      { search_attribute: "durability", search_type: "equals", search_value: "persistent" },
    ]);
  });

  test("list with empty tags array produces no tag conditions", async () => {
    mockFetch = mock(() => Promise.resolve(new Response("[]", { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    await client.memory.list({ tags: [] });

    const body = JSON.parse((mockFetch as any).mock.calls[0][1].body);
    expect(body.conditions).toEqual([
      { search_attribute: "agentId", search_type: "equals", search_value: "test" },
    ]);
  });

});

describe("SoulApi", () => {
  test("set sends correct request", async () => {
    mockFetch = mock(() => Promise.resolve(new Response("{}", { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    await client.soul.set("role", "Security reviewer");

    expect(mockFetch).toHaveBeenCalled();
    const call = (mockFetch as any).mock.calls[0];
    expect(call[0]).toContain("/Soul/");
    expect(call[1].method).toBe("PUT");
  });

  test("get returns null on 404", async () => {
    mockFetch = mock(() => Promise.resolve(new Response('{"error":"not found"}', { status: 404 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    const result = await client.soul.get("nonexistent");

    expect(result).toBeNull();
  });
});

describe("FlairError", () => {
  test("includes method, path, status in message", () => {
    const err = new FlairError("GET", "/test", 500, "internal error");
    expect(err.message).toContain("GET");
    expect(err.message).toContain("/test");
    expect(err.message).toContain("500");
    expect(err.status).toBe(500);
  });
});

describe("bootstrap", () => {
  test("calls BootstrapMemories endpoint", async () => {
    const bootstrapResponse = { context: "## Identity\nrole: test", memoryCount: 5, soulCount: 2, tokenEstimate: 500 };
    mockFetch = mock(() => Promise.resolve(new Response(JSON.stringify(bootstrapResponse), { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    const result = await client.bootstrap({ maxTokens: 2000 });

    expect(result.context).toContain("Identity");
    const call = (mockFetch as any).mock.calls[0];
    expect(call[0]).toContain("/BootstrapMemories");
  });
});

describe("privateKey config option", () => {
  let resolveKeyPathSpy: ReturnType<typeof spyOn>;
  let loadPrivateKeySpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Prevent any actual file reads when privateKey is supplied
    resolveKeyPathSpy = spyOn(authMod, "resolveKeyPath").mockImplementation(() => null);
    loadPrivateKeySpy = spyOn(authMod, "loadPrivateKey").mockImplementation(() => {
      throw new Error("loadPrivateKey should not be called when privateKey is set");
    });
  });

  test("privateKey as PEM string resolves to KeyObject without reading files", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ format: "pem", type: "pkcs8" });

    const client = new FlairClient({ agentId: "test", privateKey: pem as any });

    // Trigger lazy resolution via health() call
    await client.health();
    // fetch was called — signing succeeded with the PEM key
    expect(mockFetch).toHaveBeenCalled();
    // resolveKeyPath and loadPrivateKey must never be called
    expect(resolveKeyPathSpy).toHaveBeenCalledTimes(0);
    expect(loadPrivateKeySpy).toHaveBeenCalledTimes(0);
  });

  test("privateKey as KeyObject is used directly without reading files", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");

    const client = new FlairClient({ agentId: "test", privateKey: privateKey });

    await client.health();
    expect(mockFetch).toHaveBeenCalled();
    expect(resolveKeyPathSpy).toHaveBeenCalledTimes(0);
    expect(loadPrivateKeySpy).toHaveBeenCalledTimes(0);
  });

  test("privateKey wins when both privateKey and keyPath are supplied", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ format: "pem", type: "pkcs8" });

    const client = new FlairClient({
      agentId: "test",
      privateKey: pem as any,
      keyPath: "/nonexistent/path/to/key.key",
    });

    await client.health();
    expect(mockFetch).toHaveBeenCalled();
    // resolveKeyPath should never be called — privateKey short-circuits
    expect(resolveKeyPathSpy).toHaveBeenCalledTimes(0);
  });

  test("without privateKey, falls back to keyPath resolution (existing behavior)", async () => {
    // Restore original implementation, then spy again to count calls
    resolveKeyPathSpy.mockRestore();
    loadPrivateKeySpy.mockRestore();

    const resolveSpy = spyOn(authMod, "resolveKeyPath").mockImplementation(() => null);

    const client = new FlairClient({ agentId: "test" });
    await client.health();

    // resolveKeyPath SHOULD be called (no privateKey → file fallback)
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(resolveSpy).toHaveBeenCalledWith("test", undefined);

    resolveSpy.mockRestore();
  });
});
