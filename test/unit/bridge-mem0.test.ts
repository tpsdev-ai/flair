import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

import { mem0MemoryBridge } from "../../src/bridges/builtins/mem0";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fakeCtx() {
  const logs: Array<{ level: string; msg: string; meta?: any }> = [];
  return {
    fetch: globalThis.fetch,
    log: {
      debug: (msg: string, meta?: any) => logs.push({ level: "debug", msg, meta }),
      info:  (msg: string, meta?: any) => logs.push({ level: "info",  msg, meta }),
      warn:  (msg: string, meta?: any) => logs.push({ level: "warn",  msg, meta }),
      error: (msg: string, meta?: any) => logs.push({ level: "error", msg, meta }),
    },
    cache: {
      get: async () => null,
      set: async () => {},
      del: async () => {},
    },
    logs,
  };
}

async function collectMemories(opts: any, ctx: any) {
  const out: any[] = [];
  for await (const m of mem0MemoryBridge.import!(opts, ctx)) {
    out.push(m);
  }
  return out;
}

// ─── Mini HTTP server for mocked Mem0 API ─────────────────────────────────────

let server: Server;
let port: number;
let baseUrl: string;
let handler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (handler) handler(req, res);
    else {
      res.writeHead(500);
      res.end('{"error":"no handler set"}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  port = (server.address() as any).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

function mockCtx() {
  const base = fakeCtx();
  return { ...base, fetch: (url: string, init?: RequestInit) => fetch(url, init) };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("mem0 bridge: import", () => {
  it("imports a single page of memories", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        memories: [
          { id: "m1", memory: "User prefers TypeScript", user_id: "u1", created_at: "2026-04-01T00:00:00Z" },
          { id: "m2", memory: "User works at a startup", user_id: "u1" },
        ],
        next_page: null,
      }));
    };

    const ctx = mockCtx();
    const out = await collectMemories(
      { user: "u1", apiKey: "test-key", baseUrl },
      ctx,
    );

    expect(out).toHaveLength(2);
    expect(out[0].foreignId).toBe("mem0:m1");
    expect(out[0].content).toBe("User prefers TypeScript");
    expect(out[0].createdAt).toBe("2026-04-01T00:00:00Z");
    expect(out[0].tags).toContain("source:mem0");
    expect(out[0].tags).toContain("import:mem0");
    expect(out[0].durability).toBe("persistent");
    expect(out[1].foreignId).toBe("mem0:m2");
    expect(out[1].createdAt).toBeUndefined();
  });

  it("paginates across multiple pages", async () => {
    let callCount = 0;
    handler = (_req, res) => {
      callCount++;
      res.writeHead(200, { "Content-Type": "application/json" });
      if (callCount === 1) {
        res.end(JSON.stringify({
          memories: [{ id: "p1", memory: "page-1 item", user_id: "u1" }],
          next_page: `${baseUrl}/v1/memories?user_id=u1&page=2&page_size=100`,
        }));
      } else {
        res.end(JSON.stringify({
          memories: [{ id: "p2", memory: "page-2 item", user_id: "u1" }],
          next_page: null,
        }));
      }
    };

    const ctx = mockCtx();
    const out = await collectMemories(
      { user: "u1", apiKey: "test-key", baseUrl },
      ctx,
    );

    expect(out).toHaveLength(2);
    expect(out[0].content).toBe("page-1 item");
    expect(out[1].content).toBe("page-2 item");
    expect(callCount).toBe(2);
  });

  it("stops at maxPages when set", async () => {
    let callCount = 0;
    handler = (_req, res) => {
      callCount++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        memories: [{ id: `m${callCount}`, memory: `memory-${callCount}`, user_id: "u1" }],
        next_page: `${baseUrl}/v1/memories?user_id=u1&page=${callCount + 1}&page_size=100`,
      }));
    };

    const ctx = mockCtx();
    const out = await collectMemories(
      { user: "u1", apiKey: "test-key", baseUrl, maxPages: 2 },
      ctx,
    );

    expect(out).toHaveLength(2);
    expect(callCount).toBe(2);
  });

  it("skips empty or whitespace-only memory content", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        memories: [
          { id: "good", memory: "real memory", user_id: "u1" },
          { id: "empty-str", memory: "", user_id: "u1" },
          { id: "whitespace", memory: "   \n\t  ", user_id: "u1" },
          { id: "also-good", memory: "another real one", user_id: "u1" },
        ],
        next_page: null,
      }));
    };

    const ctx = mockCtx();
    const out = await collectMemories(
      { user: "u1", apiKey: "test-key", baseUrl },
      ctx,
    );

    expect(out).toHaveLength(2);
    expect(out[0].foreignId).toBe("mem0:good");
    expect(out[1].foreignId).toBe("mem0:also-good");
  });

  it("throws when --user is missing", async () => {
    await expect(
      collectMemories({ apiKey: "test-key" }, mockCtx()),
    ).rejects.toThrow(/--user/);
  });

  it("throws when --api-key is missing and not in env", async () => {
    await expect(
      collectMemories({ user: "u1" }, mockCtx()),
    ).rejects.toThrow(/--api-key/);
  });

  it("throws on HTTP 401 (invalid key)", async () => {
    handler = (_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: "Invalid token." }));
    };

    await expect(
      collectMemories({ user: "u1", apiKey: "bad-key", baseUrl }, mockCtx()),
    ).rejects.toThrow(/API key was rejected/);
  });

  it("throws on HTTP 403 (forbidden)", async () => {
    handler = (_req, res) => {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: "You do not have permission." }));
    };

    await expect(
      collectMemories({ user: "u1", apiKey: "test-key", baseUrl }, mockCtx()),
    ).rejects.toThrow(/doesn't have permission/);
  });

  it("throws on HTTP 404 (user not found)", async () => {
    handler = (_req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: "Not found." }));
    };

    await expect(
      collectMemories({ user: "u1", apiKey: "test-key", baseUrl }, mockCtx()),
    ).rejects.toThrow(/was not found/);
  });

  it("throws on a non-200, non-401/403/404 error (e.g. 500)", async () => {
    handler = (_req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    };

    await expect(
      collectMemories({ user: "u1", apiKey: "test-key", baseUrl }, mockCtx()),
    ).rejects.toThrow(/unexpected response/);
  });

  it("throws on a malformed (non-JSON) response", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>nginx error</html>");
    };

    await expect(
      collectMemories({ user: "u1", apiKey: "test-key", baseUrl }, mockCtx()),
    ).rejects.toThrow(/could not parse/);
  });

  it("throws on an empty response body", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("");
    };

    await expect(
      collectMemories({ user: "u1", apiKey: "test-key", baseUrl }, mockCtx()),
    ).rejects.toThrow(/empty body/);
  });

  it("throws on a response missing the `memories` array", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, not_memories: [] }));
    };

    await expect(
      collectMemories({ user: "u1", apiKey: "test-key", baseUrl }, mockCtx()),
    ).rejects.toThrow(/memories/);
  });

  it("throws on a network error (unreachable host)", async () => {
    const ctx = mockCtx();
    await expect(
      collectMemories(
        { user: "u1", apiKey: "test-key", baseUrl: "http://127.0.0.1:1" },
        ctx,
      ),
    ).rejects.toThrow(/base URL is reachable/);
  });

  it("handles an empty memories array gracefully (zero imports)", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ memories: [], next_page: null }));
    };

    const ctx = mockCtx();
    const out = await collectMemories(
      { user: "u1", apiKey: "test-key", baseUrl },
      ctx,
    );
    expect(out).toHaveLength(0);
  });

  it("uses the default base URL when --base-url is not set (validates option spec)", async () => {
    // We only validate the option spec exists with the right env fallback, not the URL default.
    // The actual URL is hardcoded in the plugin; we verify the option is declared.
    expect(mem0MemoryBridge.options?.baseUrl).toBeDefined();
    expect(mem0MemoryBridge.options?.baseUrl?.description).toContain("https://api.mem0.ai");
  });

  it("respects the Authorization: Token header format", async () => {
    let receivedAuth = "";
    handler = (req, res) => {
      receivedAuth = req.headers.authorization ?? "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ memories: [], next_page: null }));
    };

    const ctx = mockCtx();
    await collectMemories(
      { user: "u1", apiKey: "my-secret-token", baseUrl },
      ctx,
    );

    expect(receivedAuth).toBe("Token my-secret-token");
  });
});

describe("mem0 bridge: metadata", () => {
  it("registers as an 'api' kind builtin", () => {
    expect(mem0MemoryBridge.name).toBe("mem0");
    expect(mem0MemoryBridge.kind).toBe("api");
    expect(mem0MemoryBridge.version).toBe(1);
  });

  it("declares user and apiKey options", () => {
    expect(mem0MemoryBridge.options?.user).toBeDefined();
    expect(mem0MemoryBridge.options?.apiKey).toBeDefined();
  });

  it("declares apiKey with MEM0_API_KEY env fallback", () => {
    expect(mem0MemoryBridge.options?.apiKey?.env).toBe("MEM0_API_KEY");
  });

  it("declares user as required", () => {
    expect(mem0MemoryBridge.options?.user?.required).toBe(true);
  });

  it("declares apiKey as required", () => {
    expect(mem0MemoryBridge.options?.apiKey?.required).toBe(true);
  });

  it("does NOT declare an export side (one-way bridge)", () => {
    expect(mem0MemoryBridge.export).toBeUndefined();
  });
});
