import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// flair#1940 — the client carries a host source on writes and keeps the
// author, host source and session on reads (provenance on get()/list()). Unit-level (mocked
// fetch); the real-Harper round trip lives in
// test/integration/host-source-client-roundtrip-1940.test.ts.

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;
const CLIENT_ENV = ["FLAIR_URL", "FLAIR_AGENT_ID", "FLAIR_CLIENT", "FLAIR_ADMIN_USER", "FLAIR_ADMIN_PASSWORD"];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of CLIENT_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  mockFetch = mock(() => Promise.resolve(new Response("{}", { status: 200 })));
  globalThis.fetch = mockFetch as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of CLIENT_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const { FlairClient } = await import("../src/client.js");

function lastBody(): Record<string, unknown> {
  const call = (mockFetch as any).mock.calls.at(-1);
  return JSON.parse(call[1].body);
}

describe("flair#1940 — hostSource on a client write", () => {
  test("write() forwards hostSource (v: 1 when v is omitted),hostSourceScope and sessionId when supplied", async () => {
    const client = new FlairClient({ agentId: "agent-a" });
    await client.memory.write("a sourced note", {
      hostSource: { host: "host-a", kind: "run", id: "run-1a2b3c4d" },
      hostSourceScope: "record",
      sessionId: "sess-1",
    });
    const body = lastBody();
    // The caller supplied the pointer without `v`, so write() sends `v: 1`.
    expect(body.hostSource).toEqual({ host: "host-a", kind: "run", id: "run-1a2b3c4d", v: 1 });
    expect(body.hostSourceScope).toBe("record");
    expect(body.sessionId).toBe("sess-1");
  });

  test("write() keeps a caller-supplied v: 1", async () => {
    const client = new FlairClient({ agentId: "agent-a" });
    await client.memory.write("a sourced note", {
      hostSource: { v: 1, host: "host-a", kind: "run", id: "run-1a2b3c4d" },
    });
    expect(lastBody().hostSource).toEqual({ v: 1, host: "host-a", kind: "run", id: "run-1a2b3c4d" });
  });

  test("write() sends a caller-supplied v unchanged, including one the server refuses", async () => {
    const client = new FlairClient({ agentId: "agent-a" });
    await client.memory.write("a sourced note", {
      hostSource: { v: 2 as any, host: "host-a", kind: "run", id: "run-1a2b3c4d" },
    });
    expect(lastBody().hostSource).toEqual({ v: 2, host: "host-a", kind: "run", id: "run-1a2b3c4d" });
  });

  test("write() without hostSource/hostSourceScope/sessionId sends none of them", async () => {
    const client = new FlairClient({ agentId: "agent-a" });
    await client.memory.write("a plain note");
    const body = lastBody();
    expect("hostSource" in body).toBe(false);
    expect("hostSourceScope" in body).toBe(false);
    expect("sessionId" in body).toBe(false);
  });
});

describe("flair#1940 — results carry author, hostSource and sessionId", () => {
  test("search() keeps author, the joined hostSource and sessionId, and maps provenance when present", async () => {
    mockFetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            results: [
              {
                id: "mem-1",
                content: "first",
                _score: 0.9,
                agentId: "agent-a",
                hostSource: { v: 1, host: "host-a", kind: "run", id: "run-1a2b3c4d" },
                sessionId: "sess-1",
                provenance: '{"v":1}',
              },
              { id: "mem-2", content: "second", _score: 0.5, agentId: "agent-b", hostSource: "withheld" },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "agent-a" });
    const results = await client.memory.search("q");
    expect(results).toHaveLength(2);
    expect(results[0].author).toBe("agent-a");
    expect(results[0].hostSource).toEqual({ v: 1, host: "host-a", kind: "run", id: "run-1a2b3c4d" });
    expect(results[0].sessionId).toBe("sess-1");
    expect(results[0].provenance).toBe('{"v":1}');
    // A reader the server withholds the pointer from still sees the marker.
    expect(results[1].hostSource).toBe("withheld");
  });

  test("get() returns the joined hostSource, sessionId and provenance", async () => {
    mockFetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "mem-1",
            agentId: "agent-a",
            content: "c",
            hostSource: "withheld",
            sessionId: "sess-1",
            provenance: '{"v":1}',
          }),
          { status: 200 },
        ),
      ),
    );
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "agent-a" });
    const memory = await client.memory.get("mem-1");
    expect(memory?.hostSource).toBe("withheld");
    expect(memory?.sessionId).toBe("sess-1");
    expect(memory?.provenance).toBe('{"v":1}');
  });

  test("list() returns rows with the joined hostSource, sessionId and provenance", async () => {
    mockFetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify([
            {
              id: "mem-1",
              agentId: "agent-a",
              content: "c",
              createdAt: "2026-01-01T00:00:00.000Z",
              hostSource: { v: 1, host: "host-a", kind: "run", id: "run-1a2b3c4d" },
              sessionId: "sess-1",
              provenance: '{"v":1}',
            },
          ]),
          { status: 200 },
        ),
      ),
    );
    globalThis.fetch = mockFetch as any;

    const client = new FlairClient({ agentId: "agent-a" });
    const rows = await client.memory.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].hostSource).toEqual({ v: 1, host: "host-a", kind: "run", id: "run-1a2b3c4d" });
    expect(rows[0].sessionId).toBe("sess-1");
    expect(rows[0].provenance).toBe('{"v":1}');
  });
});
