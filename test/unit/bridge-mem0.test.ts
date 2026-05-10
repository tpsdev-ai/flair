import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

import { mem0MemoryBridge } from "../../src/bridges/builtins/mem0";

// Schema reference: api.mem0.ai/openapi.json
//   GET /v1/memories/?user_id=<id>&page=<n>&page_size=<n>
//   Response shape A (v1, bare array — self-hosted + cloud v1):
//     [ { id, memory, created_at, ... }, ... ]
//     Pagination: end on empty array (or short page).
//   Response shape B (v3 / DRF paginated envelope):
//     { count, next, previous, results: [...] }
//     Pagination: end when `next === null`.

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

// ─── Mini HTTP server for stub Mem0 API ───────────────────────────────────────

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

// ─── Tests: shape A (v1 bare array) ───────────────────────────────────────────

describe("mem0 bridge: import — v1 bare-array response", () => {
  it("imports a single page of memories", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([
        { id: "m1", memory: "User prefers TypeScript", created_at: "2026-04-01T00:00:00Z" },
        { id: "m2", memory: "User works at a startup" },
      ]));
    };

    const out = await collectMemories({ user: "u1", apiKey: "test-key", baseUrl }, mockCtx());

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

  it("paginates with page+1 until short page (bare array)", async () => {
    let callCount = 0;
    const requestedPages: string[] = [];
    handler = (req, res) => {
      callCount++;
      const url = new URL(req.url ?? "/", `http://localhost`);
      requestedPages.push(url.searchParams.get("page") ?? "");
      res.writeHead(200, { "Content-Type": "application/json" });
      if (callCount === 1) {
        // Full page (size 100) — has more pages.
        const items = Array.from({ length: 100 }, (_, i) => ({ id: `p1-${i}`, memory: `page-1 item ${i}` }));
        res.end(JSON.stringify(items));
      } else {
        // Short page — last one.
        res.end(JSON.stringify([{ id: "p2-0", memory: "page-2 final" }]));
      }
    };

    const out = await collectMemories({ user: "u1", apiKey: "test-key", baseUrl }, mockCtx());

    expect(out).toHaveLength(101);
    expect(requestedPages).toEqual(["1", "2"]);
    expect(out[0].foreignId).toBe("mem0:p1-0");
    expect(out[100].foreignId).toBe("mem0:p2-0");
  });

  it("stops on empty array even when first page", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([]));
    };

    const out = await collectMemories({ user: "u1", apiKey: "test-key", baseUrl }, mockCtx());
    expect(out).toHaveLength(0);
  });
});

// ─── Tests: shape B (v3 paginated envelope) ──────────────────────────────────

describe("mem0 bridge: import — v3 paginated-envelope response", () => {
  it("imports a single page when `next` is null", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        count: 2,
        next: null,
        previous: null,
        results: [
          { id: "v3-1", memory: "v3 first", created_at: "2026-04-01T00:00:00Z" },
          { id: "v3-2", memory: "v3 second" },
        ],
      }));
    };

    const out = await collectMemories({ user: "u1", apiKey: "test-key", baseUrl }, mockCtx());

    expect(out).toHaveLength(2);
    expect(out[0].foreignId).toBe("mem0:v3-1");
    expect(out[0].content).toBe("v3 first");
  });

  it("follows `next` URL across pages", async () => {
    let callCount = 0;
    handler = (_req, res) => {
      callCount++;
      res.writeHead(200, { "Content-Type": "application/json" });
      if (callCount === 1) {
        res.end(JSON.stringify({
          count: 2,
          next: `${baseUrl}/v1/memories/?user_id=u1&page=2&page_size=100`,
          previous: null,
          results: [{ id: "p1", memory: "page-1 item" }],
        }));
      } else {
        res.end(JSON.stringify({
          count: 2,
          next: null,
          previous: `${baseUrl}/v1/memories/?user_id=u1&page=1&page_size=100`,
          results: [{ id: "p2", memory: "page-2 item" }],
        }));
      }
    };

    const out = await collectMemories({ user: "u1", apiKey: "test-key", baseUrl }, mockCtx());

    expect(out).toHaveLength(2);
    expect(out[0].content).toBe("page-1 item");
    expect(out[1].content).toBe("page-2 item");
    expect(callCount).toBe(2);
  });

  it("handles empty results envelope", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ count: 0, next: null, previous: null, results: [] }));
    };

    const out = await collectMemories({ user: "u1", apiKey: "test-key", baseUrl }, mockCtx());
    expect(out).toHaveLength(0);
  });
});

// ─── Tests: shared behavior ───────────────────────────────────────────────────

describe("mem0 bridge: shared", () => {
  it("hits /v1/memories/ with trailing slash and pages 1-indexed", async () => {
    let receivedPath = "";
    handler = (req, res) => {
      receivedPath = req.url ?? "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([]));
    };

    await collectMemories({ user: "u1", apiKey: "test-key", baseUrl }, mockCtx());

    expect(receivedPath).toContain("/v1/memories/");
    expect(receivedPath).toContain("user_id=u1");
    expect(receivedPath).toContain("page=1");
    expect(receivedPath).toContain("page_size=100");
  });

  it("respects the Authorization: Token header format", async () => {
    let receivedAuth = "";
    handler = (req, res) => {
      receivedAuth = req.headers.authorization ?? "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([]));
    };

    await collectMemories({ user: "u1", apiKey: "my-secret-token", baseUrl }, mockCtx());
    expect(receivedAuth).toBe("Token my-secret-token");
  });

  it("stops at maxPages when set (bare-array shape)", async () => {
    let callCount = 0;
    handler = (_req, res) => {
      callCount++;
      res.writeHead(200, { "Content-Type": "application/json" });
      // Always full page → would page forever without maxPages
      const items = Array.from({ length: 100 }, (_, i) => ({ id: `c${callCount}-${i}`, memory: `item ${callCount}-${i}` }));
      res.end(JSON.stringify(items));
    };

    const out = await collectMemories(
      { user: "u1", apiKey: "test-key", baseUrl, maxPages: 2 },
      mockCtx(),
    );

    expect(out).toHaveLength(200);
    expect(callCount).toBe(2);
  });

  it("skips empty or whitespace-only memory content", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([
        { id: "good", memory: "real memory" },
        { id: "empty-str", memory: "" },
        { id: "whitespace", memory: "   \n\t  " },
        { id: "also-good", memory: "another real one" },
      ]));
    };

    const out = await collectMemories({ user: "u1", apiKey: "test-key", baseUrl }, mockCtx());

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

  it("throws on a 500", async () => {
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

  it("throws on a response that's neither array nor envelope", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, not_results: [] }));
    };

    await expect(
      collectMemories({ user: "u1", apiKey: "test-key", baseUrl }, mockCtx()),
    ).rejects.toThrow(/unexpected response shape/);
  });

  it("throws on a network error (unreachable host)", async () => {
    await expect(
      collectMemories(
        { user: "u1", apiKey: "test-key", baseUrl: "http://127.0.0.1:1" },
        mockCtx(),
      ),
    ).rejects.toThrow(/base URL is reachable/);
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
