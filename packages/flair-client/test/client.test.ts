import { describe, test, expect, mock, beforeEach } from "bun:test";

// Mock fetch globally
const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;

beforeEach(() => {
  mockFetch = mock(() => Promise.resolve(new Response("{}", { status: 200 })));
  globalThis.fetch = mockFetch as any;
});

// Import after mock setup
const { FlairClient, FlairError } = await import("../src/client.js");

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

  test("list defaults include agentId, no other params", async () => {
    mockFetch = mock(() => Promise.resolve(new Response("[]", { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    await client.memory.list();

    const url = (mockFetch as any).mock.calls[0][0] as string;
    expect(url).toContain("/Memory?");
    expect(url).toContain("agentId=test");
    expect(url).not.toContain("limit=");
    expect(url).not.toContain("type=");
    expect(url).not.toContain("subject=");
  });

  test("list passes subject filter through to URL", async () => {
    mockFetch = mock(() => Promise.resolve(new Response("[]", { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    await client.memory.list({ subject: "project-x" });

    const url = (mockFetch as any).mock.calls[0][0] as string;
    expect(url).toContain("subject=project-x");
  });

  test("list combines all filters in URL", async () => {
    mockFetch = mock(() => Promise.resolve(new Response("[]", { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    await client.memory.list({
      limit: 10,
      type: "session",
      durability: "ephemeral",
      subject: "chat:abc",
    });

    const url = (mockFetch as any).mock.calls[0][0] as string;
    expect(url).toContain("limit=10");
    expect(url).toContain("type=session");
    expect(url).toContain("durability=ephemeral");
    expect(url).toContain("subject=chat%3Aabc");
  });

  test("list URL-encodes subject special characters", async () => {
    mockFetch = mock(() => Promise.resolve(new Response("[]", { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    await client.memory.list({ subject: "n8n workflow & test" });

    const url = (mockFetch as any).mock.calls[0][0] as string;
    expect(url).toContain("subject=n8n+workflow+%26+test");
  });
  test("list with empty tags array has no tags param", async () => {
    mockFetch = mock(() => Promise.resolve(new Response("[]", { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    await client.memory.list({ tags: [] });

    const url = (mockFetch as any).mock.calls[0][0] as string;
    expect(url).not.toContain("tags=");
  });

  test("list with one tag appends tags param", async () => {
    mockFetch = mock(() => Promise.resolve(new Response("[]", { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    await client.memory.list({ tags: ["foo"] });

    const url = (mockFetch as any).mock.calls[0][0] as string;
    expect(url).toContain("tags=foo");
  });

  test("list with multiple tags appends repeated tags params (not comma-joined)", async () => {
    mockFetch = mock(() => Promise.resolve(new Response("[]", { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    await client.memory.list({ tags: ["foo", "bar"] });

    const url = (mockFetch as any).mock.calls[0][0] as string;
    expect(url).toMatch(/tags=foo.*tags=bar/);
    expect(url).not.toContain("tags=foo,bar");
  });

  test("list with order asc contains sort(createdAt) param", async () => {
    mockFetch = mock(() => Promise.resolve(new Response("[]", { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    await client.memory.list({ order: "createdAt-asc" });

    const url = (mockFetch as any).mock.calls[0][0] as string;
    // URLSearchParams encodes parens: sort(createdAt) → sort%28createdAt%29
    expect(url).toContain("sort%28createdAt%29=");
  });

  test("list with order desc contains sort(createdAt,desc) param", async () => {
    mockFetch = mock(() => Promise.resolve(new Response("[]", { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    await client.memory.list({ order: "createdAt-desc" });

    const url = (mockFetch as any).mock.calls[0][0] as string;
    // URLSearchParams encodes parens + comma: sort(createdAt,desc) → sort%28createdAt%2Cdesc%29
    expect(url).toContain("sort%28createdAt%2Cdesc%29=");
  });

  test("list with no order has no sort param", async () => {
    mockFetch = mock(() => Promise.resolve(new Response("[]", { status: 200 })));
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "test" });
    await client.memory.list();

    const url = (mockFetch as any).mock.calls[0][0] as string;
    expect(url).not.toContain("sort");
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
