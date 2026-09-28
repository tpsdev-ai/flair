/**
 * memory-selection-middleware-1940.test.ts — flair#1940 slice 1, round 17.
 *
 * Flint's round-17 design ruling: a non-admin HTTP Memory read does NOT honour a
 * caller `select(...)`/`property`. The auth middleware normalizes the request
 * URL — dropping `select(...)` and `property`, keeping conditions, operator,
 * sort, limit and offset — after authentication establishes the caller is not an
 * admin and BEFORE any Memory row is read or the next layer runs. Harper builds
 * its REST target from this URL afterwards, so the original selection cannot be
 * reapplied.
 *
 * `auth-middleware.ts` is a side-effect module that calls `server.http(fn)`; the
 * harper mock captures that callback so these tests invoke the middleware
 * directly with a REAL Ed25519-signed request and inspect the URL it passes on.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { generateKeyPairSync, randomUUID, sign as edSign } from "node:crypto";
import { agentStore, middlewareCapture } from "../helpers/harper-mock.js";

let memoryGetCalls = 0;

mock.module("harper", () => ({
  databases: {
    flair: {
      Agent: {
        get: async (id: string) => agentStore.get(id) ?? null,
        // isAdmin() reads the admin set from this search; yield the stored agents
        // so an agent seeded with role "admin" resolves as an admin.
        search: async function* () {
          for (const a of agentStore.values()) yield a;
        },
      },
      Memory: {
        get: async (_id: string) => {
          memoryGetCalls++;
          return null;
        },
      },
    },
  },
  server: {
    getUser: async (_user: string, _pass: string | null, _request: any) => null,
    http: (fn: any, _opts?: any) => {
      middlewareCapture.value = fn;
    },
  },
  Resource: class {},
  RequestTarget: class {},
}));

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_B64 = Buffer.from((publicKey.export({ format: "jwk" }) as any).x, "base64url").toString("base64");

function authHeader(agentId: string, method: string, url: string): string {
  const u = new URL(url, "http://localhost");
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agentId}:${ts}:${nonce}:${method}:${u.pathname}${u.search}`;
  const sig = edSign(null, Buffer.from(payload), privateKey);
  return `TPS-Ed25519 ${agentId}:${ts}:${nonce}:${sig.toString("base64")}`;
}

function makeRequest(url: string, method = "GET", agentId = "agent-3"): any {
  const headers = new Map<string, string>();
  headers.set("authorization", authHeader(agentId, method, url));
  headers.set("host", "localhost");
  return {
    url,
    method,
    headers: {
      get: (n: string) => headers.get(n.toLowerCase()) ?? null,
      set: (n: string, v: string) => {
        headers.set(n.toLowerCase(), v);
      },
      asObject: {},
    },
  };
}

const nextLayer = () => new Response("ok", { status: 200 });

let authMiddleware: any;
async function loadMiddleware() {
  if (!authMiddleware) {
    await import("../../resources/auth-middleware.ts");
    authMiddleware = middlewareCapture.value;
  }
  return authMiddleware;
}

beforeEach(() => {
  agentStore.clear();
  agentStore.set("agent-3", { id: "agent-3", publicKey: PUBLIC_B64, status: "active", role: "agent" });
  memoryGetCalls = 0;
});

describe("flair#1940 round 17 — a non-admin Memory read drops the caller's selection", () => {
  it("drops `select(...)` and keeps limit/sort; no Memory row is read", async () => {
    const mw = await loadMiddleware();
    const req = makeRequest("/Memory/x?select(id,content)&limit=5&sort=createdAt");
    const res: Response = await mw(req, nextLayer);
    expect(res.status).toBe(200); // assertion: passed to the next layer
    expect(req.url).toBe("/Memory/x?limit=5&sort=createdAt"); // assertion: select stripped, options kept
    expect(req.url).not.toContain("select("); // assertion: nothing for Harper to reapply
    expect(memoryGetCalls).toBe(0); // assertion: the middleware read NO Memory row
  });

  it("drops a wildcard `select(*)`, a `property` param, and a declared dotted suffix", async () => {
    const mw = await loadMiddleware();
    for (const [given, want] of [
      ["/Memory/x?select(*)", "/Memory/x"],
      ["/Memory/x?property=content", "/Memory/x"],
      ["/Memory/x?property=content&limit=3", "/Memory/x?limit=3"],
      ["/Memory/x.content", "/Memory/x"],
      ["/Memory/x?select(a),select(b)", "/Memory/x"],
    ] as const) {
      const req = makeRequest(given);
      await mw(req, nextLayer);
      expect(req.url, given).toBe(want); // assertion: the selection was stripped
    }
  });

  it("leaves an UNKNOWN dotted suffix in the id (Harper owns path interpretation)", async () => {
    const mw = await loadMiddleware();
    const req = makeRequest("/Memory/x.notAnAttribute");
    await mw(req, nextLayer);
    expect(req.url).toBe("/Memory/x.notAnAttribute"); // assertion: not a property, so not stripped
  });

  it("drops the selection on a COLLECTION read too", async () => {
    const mw = await loadMiddleware();
    const req = makeRequest("/Memory/?select(id)&offset=1&limit=2");
    await mw(req, nextLayer);
    expect(req.url).toBe("/Memory/?offset=1&limit=2"); // assertion: collection select stripped, options kept
  });

  it("leaves a non-GET request untouched", async () => {
    const mw = await loadMiddleware();
    const req = makeRequest("/Memory/x?select(id)", "POST");
    await mw(req, nextLayer);
    expect(req.url).toBe("/Memory/x?select(id)"); // assertion: a write is not a read
  });

  // An admin read keeps its selection; the admin control is covered end-to-end by
  // the real-Harper integration test (host-source-selected-reads-1940.test.ts),
  // which does not depend on the per-process admin cache.
});
