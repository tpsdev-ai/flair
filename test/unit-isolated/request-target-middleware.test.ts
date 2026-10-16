/**
 * request-target-middleware.test.ts — the auth middleware decides only about a
 * canonical request target, and reads it the way Harper routes it.
 *
 * 1. A non-canonical raw target (a `.`/`..` segment, raw or percent-encoded; an
 *    empty segment; a raw backslash) is answered with the named 400
 *    `non_canonical_request_target` before any other request processing: no
 *    header read, no method check, no credential read, no next layer.
 * 2. Every path decision splits the RAW path on `/` first and decodes a segment
 *    only afterwards, so an id containing `/`, sent as `%2F`, is decided as ONE
 *    segment at each place the middleware reads a path.
 *
 * Isolated: this file owns its `harper` and embeddings-provider mocks and drives
 * the REAL middleware with REAL Ed25519-signed requests, as
 * test/unit-isolated/backfill-embedding-txn-order-2484.test.ts does.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { generateKeyPairSync, randomUUID, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeReplayNonceTable, ensureGlobalHarperTransaction } from "../helpers/fake-replay-store.ts";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
delete (process.env as any).FLAIR_PUBLIC;

mock.module("../../resources/embeddings-provider.ts", () => ({
  getEmbedding: async () => null,
  getModelId: () => "mock-embedding-model",
  getMode: () => "local",
  EMBEDDING_ENGINE: "gguf",
}));

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_B64 = Buffer.from((publicKey.export({ format: "jwk" }) as any).x, "base64url").toString("base64");
const AGENT = "canon-agent";

const agents = new Map<string, any>();
let agentGets = 0;
// Every id a table read was asked for, by table.
const tableGets: Record<string, Array<{ id: unknown; args: number }>> = {};
const tableRows: Record<string, Map<string, any>> = {};

function table(name: string) {
  tableGets[name] = [];
  tableRows[name] = new Map();
  return {
    get: async (...args: unknown[]) => {
      tableGets[name]!.push({ id: args[0], args: args.length });
      return tableRows[name]!.get(String(args[0])) ?? null;
    },
  };
}

let captured: any = null;
mock.module("harper", () => ({
  databases: {
    flair: {
      Agent: {
        get: async (id: string) => {
          agentGets++;
          return agents.get(id) ?? null;
        },
        search: async function* () {
          for (const a of agents.values()) yield a;
        },
      },
      Memory: table("Memory"),
      OrgEvent: table("OrgEvent"),
      WorkspaceState: table("WorkspaceState"),
      ReplayNonce: createFakeReplayNonceTable(),
    },
  },
  server: {
    getUser: async () => null,
    http: (fn: any) => { captured = fn; },
  },
  Resource: class {},
  RequestTarget: class {},
  logger: { warn: () => {}, error: () => {}, info: () => {} },
}));

await import("../../resources/auth-middleware.ts");
const mw = captured as (request: any, next: any) => Promise<Response>;

let restoreTransaction: () => void = () => {};
beforeAll(() => { restoreTransaction = ensureGlobalHarperTransaction(); });
afterAll(() => restoreTransaction());

function signedAuthorization(method: string, url: string): string {
  const u = new URL(url, "http://localhost");
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${AGENT}:${ts}:${nonce}:${method}:${u.pathname}${u.search}`;
  const sig = edSign(null, Buffer.from(payload), privateKey);
  return `TPS-Ed25519 ${AGENT}:${ts}:${nonce}:${sig.toString("base64")}`;
}

/** A request whose header reads are counted. */
function makeRequest(url: string, method: string, authorization?: string, user?: any) {
  const headers = new Map<string, string>([["host", "localhost"]]);
  if (authorization) headers.set("authorization", authorization);
  const req: any = {
    url,
    method,
    user,
    headerReads: 0,
    headers: {
      get: (n: string) => { req.headerReads++; return headers.get(n.toLowerCase()) ?? null; },
      set: (n: string, v: string) => { headers.set(n.toLowerCase(), v); },
      asObject: {},
    },
  };
  return req;
}

let nextCalls = 0;
const next = () => { nextCalls++; return new Response("ok", { status: 200 }); };

beforeEach(() => {
  agents.clear();
  agents.set(AGENT, { id: AGENT, publicKey: PUBLIC_B64, status: "active", role: "agent" });
  agentGets = 0;
  nextCalls = 0;
  for (const name of Object.keys(tableGets)) {
    tableGets[name]!.length = 0;
    tableRows[name]!.clear();
  }
});

const NON_CANONICAL: Array<[string, string]> = [
  ["a `..` segment", "/Memory/../Agent"],
  ["a `.` segment", "/Memory/./x"],
  ["an encoded `..` segment", "/Memory/%2e%2e/Agent"],
  ["an encoded `.` segment, upper case", "/Memory/%2E/x"],
  ["a mixed `.%2e` segment", "/Memory/.%2e/x?limit=1"],
  ["a trailing `..` segment", "/OrgEvent/x/.."],
  ["an empty segment after the leading slash", "//Memory"],
  ["an empty segment mid-path", "/Memory//x"],
  ["an absolute-form target", "http://localhost/Memory"],
  ["a raw backslash", "/Memory\\x"],
];

const ADMIN_BASIC = "Basic YWRtaW46cGFzcw==";
const superUser = { username: "admin", role: { permission: { super_user: true } } };

describe("a non-canonical target gets the named 400 before any other processing", () => {
  for (const [label, target] of NON_CANONICAL) {
    it(`${label}: ${JSON.stringify(target)}`, async () => {
      const callers: Array<[string, string | undefined, any]> = [
        ["anonymous", undefined, undefined],
        ["signed agent", "SIGNED", undefined],
        ["Basic admin", ADMIN_BASIC, superUser],
      ];
      for (const [caller, auth, user] of callers) {
        for (const method of ["GET", "PUT", "DELETE", "PROPFIND"]) {
          const authorization = auth === "SIGNED" ? signedAuthorization(method, target) : auth;
          const req = makeRequest(target, method, authorization, user);
          const res = await mw(req, next);
          const where = `${caller} ${method} ${target}`;
          // The named 400 — before the method check (PROPFIND is not a 405).
          expect(res.status, where).toBe(400);
          expect((await res.json()).error, where).toBe("non_canonical_request_target");
          // Nothing else ran: no header read, no credential read, no table
          // read, no annotation, no next layer.
          expect(req.headerReads, where).toBe(0);
          expect(agentGets, where).toBe(0);
          expect(Object.values(tableGets).every((calls) => calls.length === 0), where).toBe(true);
          expect(req.tpsAgent, where).toBeUndefined();
          expect(req.tpsAnonymous, where).toBeUndefined();
          expect(nextCalls, where).toBe(0);
        }
      }
    });
  }

  it("HEAD gets the 400 with no body", async () => {
    const res = await mw(makeRequest("/Memory/%2e%2e/x", "HEAD"), next);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("");
    expect(nextCalls).toBe(0);
  });
});

describe("canonical targets go on exactly as before", () => {
  it("the public /health passthrough", async () => {
    const res = await mw(makeRequest("/health", "GET"), next);
    expect(res.status).toBe(200);
    expect(nextCalls).toBe(1);
  });

  it("a disallowed method on a canonical target is still the 405", async () => {
    const res = await mw(makeRequest("/Memory/", "PROPFIND"), next);
    expect(res.status).toBe(405);
  });

  it("an encoded `\\` inside an id segment passes", async () => {
    const url = "/Memory/a%5Cb";
    const req = makeRequest(url, "GET", signedAuthorization("GET", url));
    const res = await mw(req, next);
    expect(res.status).toBe(200);
    expect(req.tpsAgent).toBe(AGENT);
    expect(req.url).toBe(url);
  });
});

describe("an id containing `/`, sent as `%2F`, is decided as ONE segment at every path decision", () => {
  it("the stored-owner rule and the embedding backfill read Memory id `a/b`", async () => {
    const url = "/Memory/a%2Fb";
    const req = makeRequest(url, "PUT", signedAuthorization("PUT", url));
    const res = await mw(req, next);
    expect(res.status).toBe(200);
    expect(nextCalls).toBe(1);
    // The backfill runs after the response; let it reach its read.
    await new Promise((r) => setTimeout(r, 10));
    const ids = tableGets.Memory!.map((c) => c.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(ids.every((id) => id === "a/b")).toBe(true);
    // One read by the owner rule (one argument), one by the backfill (two).
    expect(tableGets.Memory!.some((c) => c.args === 1)).toBe(true);
    expect(tableGets.Memory!.some((c) => c.args === 2)).toBe(true);
  });

  it("the stored-owner rule refuses a write to another agent's `a/b`", async () => {
    tableRows.Memory!.set("a/b", { id: "a/b", agentId: "someone-else" });
    const url = "/Memory/a%2Fb";
    const res = await mw(makeRequest(url, "PATCH", signedAuthorization("PATCH", url)), next);
    expect(res.status).toBe(403);
    expect(nextCalls).toBe(0);
  });

  it("the OrgEvent delete check reads event id `a/b`", async () => {
    const url = "/OrgEvent/a%2Fb";
    const res = await mw(makeRequest(url, "DELETE", signedAuthorization("DELETE", url)), next);
    expect(res.status).toBe(200);
    const ids = tableGets.OrgEvent!.map((c) => c.id);
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(ids.every((id) => id === "a/b")).toBe(true);
  });

  it("the WorkspaceState delete check reads id `ws/1`", async () => {
    const url = "/WorkspaceState/ws%2F1";
    const res = await mw(makeRequest(url, "DELETE", signedAuthorization("DELETE", url)), next);
    expect(res.status).toBe(200);
    const ids = tableGets.WorkspaceState!.map((c) => c.id);
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(ids.every((id) => id === "ws/1")).toBe(true);
  });

  it("the malformed `.content` check reads the whole last segment, encoded `/` included", async () => {
    const res = await mw(makeRequest("/Memory/a%2F%E0%A4.content", "GET"), next);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("memory_id_content_suffix");
    expect(nextCalls).toBe(0);
    // Control: the same segment without the suffix is not that refusal.
    const control = await mw(makeRequest("/Memory/a%2F%E0%A4", "GET"), next);
    expect(control.status).toBe(200);
  });

  it("the non-admin Memory read keeps `a%2Fb` as the id and refuses the ambiguous suffix", async () => {
    const plain = "/Memory/a%2Fb";
    const plainReq = makeRequest(plain, "GET", signedAuthorization("GET", plain));
    expect((await mw(plainReq, next)).status).toBe(200);
    expect(plainReq.url).toBe(plain);

    const selected = "/Memory/a%2Fb?select(id)&limit=1";
    const selectedReq = makeRequest(selected, "GET", signedAuthorization("GET", selected));
    expect((await mw(selectedReq, next)).status).toBe(200);
    expect(selectedReq.url).toBe("/Memory/a%2Fb?limit=1");

    const suffixed = "/Memory/a%2Fb.content";
    const res = await mw(makeRequest(suffixed, "GET", signedAuthorization("GET", suffixed)), next);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("ambiguous_memory_id");
  });

  it("the public-path decision keeps `a%2Fb` under /AgentCard/", async () => {
    const req = makeRequest("/AgentCard/a%2Fb", "GET");
    const res = await mw(req, next);
    expect(res.status).toBe(200);
    expect(nextCalls).toBe(1);
    // The public passthrough returns before the anonymous annotation.
    expect(req.tpsAnonymous).toBeUndefined();
  });
});

describe("no path decision reads the URL-normalized pathname", () => {
  it("the parsed URL's pathname is read once, for the signed payload only", () => {
    const src = readFileSync(join(import.meta.dir, "../../resources/auth-middleware.ts"), "utf8");
    const uses = src.split("\n").filter((line) => line.includes("url.pathname"));
    expect(uses).toHaveLength(1);
    expect(uses[0]).toContain("const payload = `${agentId}:${tsRaw}:${nonce}:${request.method}:${url.pathname}${url.search}`");
  });
});
