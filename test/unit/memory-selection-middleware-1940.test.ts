/**
 * memory-selection-middleware-1940.test.ts — flair#1940 slice 1, round 15.
 *
 * The auth middleware validates a non-admin `/Memory/<id>` REST selection
 * BEFORE its Memory pre-read (the scope read that answers 404 for another
 * agent's private row). Round 15 narrows what it accepts: a selection is ONLY
 * an array of plain Memory schema attribute names; every other REST shape
 * (`select(*)`, a scalar, an empty list, the `((a,b))` asArray form, a trailing
 * or doubled comma, an unknown name, a path property) is refused with 400
 * BEFORE the pre-read runs.
 *
 * `auth-middleware.ts` is a side-effect module that calls `server.http(fn)`; the
 * harper mock captures that callback so these tests invoke the middleware
 * directly with a REAL Ed25519-signed request and count
 * `databases.flair.Memory.get` calls — proving the refusal comes first.
 */
import { mock, describe, it, expect, beforeEach } from "bun:test";
import { generateKeyPairSync, sign as edSign, randomUUID } from "node:crypto";
import { agentStore, middlewareCapture } from "../helpers/harper-mock.js";

let memoryGetCalls = 0;

mock.module("harper", () => ({
  databases: {
    flair: {
      Agent: {
        get: async (id: string) => agentStore.get(id) ?? null,
        search: async function* () {},
      },
      Memory: {
        get: async (_id: string) => { memoryGetCalls++; return null; },
      },
    },
  },
  server: {
    getUser: async (_user: string, _pass: string | null, _request: any) => null,
    http: (fn: any, _opts?: any) => { middlewareCapture.value = fn; },
  },
  Resource: class {},
  RequestTarget: class {},
}));

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_B64 = Buffer.from((publicKey.export({ format: "jwk" }) as any).x, "base64url").toString("base64");

function authHeader(method: string, url: string): string {
  const u = new URL(url, "http://localhost");
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `agent-3:${ts}:${nonce}:${method}:${u.pathname}${u.search}`;
  const sig = edSign(null, Buffer.from(payload), privateKey);
  return `TPS-Ed25519 agent-3:${ts}:${nonce}:${sig.toString("base64")}`;
}

function makeRequest(url: string, method = "GET"): any {
  const headers = new Map<string, string>();
  headers.set("authorization", authHeader(method, url));
  headers.set("host", "localhost");
  return {
    url,
    method,
    headers: {
      get: (n: string) => headers.get(n.toLowerCase()) ?? null,
      set: (n: string, v: string) => { headers.set(n.toLowerCase(), v); },
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
  agentStore.set("agent-3", { id: "agent-3", publicKey: PUBLIC_B64, status: "active" });
  memoryGetCalls = 0;
});

describe("flair#1940 round 15 — the middleware refuses a non-array selection BEFORE its Memory pre-read", () => {
  it("an accepted array of Memory schema names runs the pre-read", async () => {
    const mw = await loadMiddleware();
    const res: Response = await mw(makeRequest("/Memory/x?select(id,agentId,content)"), nextLayer);
    expect(res.status).toBe(200); // assertion: an accepted selection reaches the handler
    expect(memoryGetCalls).toBe(1); // assertion: the middleware pre-read ran once
  });

  it("every other REST selection shape is a 400 with ZERO Memory reads", async () => {
    const mw = await loadMiddleware();
    const refused = [
      "/Memory/x?select(*)",                     // wildcard
      "/Memory/x?select(content)",               // scalar
      "/Memory/x?select()",                      // empty
      "/Memory/x?select((a,b))",                 // asArray option attached
      "/Memory/x?select(a,b,)",                  // trailing comma
      "/Memory/x?select(a,,b)",                  // doubled comma
      "/Memory/x?select(content,noSuchField)",   // name not in the schema
      "/Memory/x.hostSource",                    // path property
      "/Memory/x?select(id),select(*)",          // a successive select re-assigns to a wildcard
    ];
    for (const path of refused) {
      memoryGetCalls = 0;
      const res: Response = await mw(makeRequest(path), nextLayer);
      expect(res.status, path).toBe(400); // assertion: refused
      expect(memoryGetCalls, path).toBe(0); // assertion: the pre-read did NOT run
    }
  });
});
