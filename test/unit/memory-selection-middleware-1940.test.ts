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
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { generateKeyPairSync, randomUUID, sign as edSign } from "node:crypto";
import { agentStore, middlewareCapture } from "../helpers/harper-mock.js";
import { createFakeReplayNonceTable, ensureGlobalHarperTransaction } from "../helpers/fake-replay-store.ts";

let memoryGetCalls = 0;

// The factory is registered here and re-asserted in loadMiddleware() below:
// bun's mock.module is process-global, so when another test file that mocks
// `harper` (e.g. memory-integrity.test.ts) shares this process, its mock can be
// the one in effect at the moment auth-middleware is imported. Re-registering
// immediately before that import pins the mock this file needs (flair#2307
// item 6).
function harperMock() {
  return {
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
        // Every signed request records its nonce here (flair#2061).
        ReplayNonce: createFakeReplayNonceTable(),
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
  };
}

mock.module("harper", harperMock);

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
    // Re-assert this file's harper mock right before auth-middleware is
    // imported, so a competing mock from another file in this process does not
    // win the race (flair#2307 item 6).
    mock.module("harper", harperMock);
    await import("../../resources/auth-middleware.ts");
    authMiddleware = middlewareCapture.value;
  }
  return authMiddleware;
}

// replay-store.ts reads Harper's transaction() from the global, as Harper
// assigns it; install a stand-in for this file only.
let restoreTransaction: () => void = () => {};
beforeAll(() => {
  restoreTransaction = ensureGlobalHarperTransaction();
});
afterAll(() => restoreTransaction());

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

  it("drops an ENCODED dotted declared suffix — Harper decides on the DECODED path", async () => {
    const mw = await loadMiddleware();
    for (const given of ["/Memory/x%2Econtent", "/Memory/x%2econtent", "/Memory/x%2Econtent?limit=5"] as const) {
      const req = makeRequest(given);
      await mw(req, nextLayer);
      expect(req.url, given).toBe(given.includes("?") ? "/Memory/x?limit=5" : "/Memory/x"); // assertion: `%2E` is a dot to Harper too
    }
  });

  it("drops the selection on a COLLECTION read too", async () => {
    const mw = await loadMiddleware();
    const req = makeRequest("/Memory/?select(id)&offset=1&limit=2");
    await mw(req, nextLayer);
    expect(req.url).toBe("/Memory/?offset=1&limit=2"); // assertion: collection select stripped, options kept
  });

  it("leaves a POST request untouched", async () => {
    const mw = await loadMiddleware();
    const req = makeRequest("/Memory/x?select(id)", "POST");
    await mw(req, nextLayer);
    expect(req.url).toBe("/Memory/x?select(id)"); // assertion: a write is not a read
  });

  it("flair#2307: refuses a malformed percent-encoded `.content` id segment with the named 400", async () => {
    const mw = await loadMiddleware();
    const req = makeRequest("/Memory/a%ZZ.content", "PUT");
    const res: Response = await mw(req, nextLayer);
    expect(res.status).toBe(400); // assertion: not Harper's 500 from its own path decode
    expect((await res.json()).error).toBe("memory_id_content_suffix");
  });

  it("flair#2307: the malformed `.content` refusal does not depend on the request's credential", async () => {
    const mw = await loadMiddleware();
    const savedPass = process.env.HDB_ADMIN_PASSWORD;
    process.env.HDB_ADMIN_PASSWORD = "unit-admin-pass";
    try {
      const callers: Array<[string, () => any]> = [
        ["a Basic admin", () => {
          const req = makeRequest("/Memory/a%ZZ.content", "GET");
          req.headers.set("authorization", "Basic " + Buffer.from("admin:unit-admin-pass").toString("base64"));
          return req;
        }],
        ["a super_user Harper already authorized", () => {
          const req = makeRequest("/Memory/a%ZZ.content", "GET");
          req.headers.set("authorization", "Basic " + Buffer.from("root:other-pass").toString("base64"));
          req.user = { username: "root", role: { permission: { super_user: true } } };
          return req;
        }],
        ["an anonymous", () => {
          const req = makeRequest("/Memory/a%ZZ.content", "GET");
          req.headers.set("authorization", "");
          return req;
        }],
      ];
      for (const [who, build] of callers) {
        for (const method of ["GET", "PUT", "DELETE"]) {
          const req = build();
          req.method = method;
          const next = mock(nextLayer);
          const res: Response = await mw(req, next);
          expect(res.status, `${who} ${method}`).toBe(400);
          expect((await res.json()).error, `${who} ${method}`).toBe("memory_id_content_suffix");
          expect(next, `${who} ${method} reached the next layer`).not.toHaveBeenCalled();
        }
      }
      // CONTROL: the same callers on a well-formed path reach the next layer.
      for (const [who, build] of callers) {
        const req = build();
        req.url = "/Memory/a.content";
        const next = mock(nextLayer);
        await mw(req, next);
        expect(next, `${who} on a well-formed path`).toHaveBeenCalled();
      }
    } finally {
      if (savedPass === undefined) delete process.env.HDB_ADMIN_PASSWORD;
      else process.env.HDB_ADMIN_PASSWORD = savedPass;
    }
  });

  it("flair#2199: refuses an encoded-slash id segment before a declared suffix", async () => {
    const mw = await loadMiddleware();
    for (const given of ["/Memory/a%2Fb.content", "/Memory/a%2fb.content", "/Memory/a%2Fb%2Econtent", "/Memory/a%2Fb.agentId", "/Memory/a%252Fb.content"] as const) {
      const req = makeRequest(given);
      const res: Response = await mw(req, nextLayer);
      expect(res.status, given).toBe(400); // assertion: the ambiguous read is refused, not rewritten
      const body = await res.json();
      expect(body.error, given).toBe("ambiguous_memory_id");
    }
  });

  it("flair#2199: HEAD refuses an encoded-slash id before a declared suffix with no body", async () => {
    const mw = await loadMiddleware();
    const next = mock(nextLayer);
    const req = makeRequest("/Memory/a%2Fb.content", "HEAD");
    const res: Response = await mw(req, next);
    expect(res.status).toBe(400);
    expect(res.body).toBeNull();
    expect(req.url).toBe("/Memory/a%2Fb.content");
    expect(memoryGetCalls).toBe(0);
    expect(next).not.toHaveBeenCalled();
  });

  it("flair#2199: still routes an encoded-slash id with no declared suffix, dropping the selection", async () => {
    const mw = await loadMiddleware();
    for (const [given, want] of [
      ["/Memory/a%2Fb", "/Memory/a%2Fb"],
      ["/Memory/a%2Fb?select(id)", "/Memory/a%2Fb"],
      ["/Memory/a%2Fb.notAnAttribute", "/Memory/a%2Fb.notAnAttribute"],
    ] as const) {
      const req = makeRequest(given);
      const res: Response = await mw(req, nextLayer);
      expect(res.status, given).toBe(200); // assertion: routed, not refused
      expect(req.url, given).toBe(want); // assertion: path kept as sent, only the selection dropped
    }
  });

  // An admin read keeps its selection; the admin control is covered end-to-end by
  // the real-Harper integration test (host-source-selected-reads-1940.test.ts),
  // which does not depend on the per-process admin cache.
});
