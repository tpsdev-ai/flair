/**
 * admin-decision-verified-row.test.ts — the admin decision for a verified
 * agent uses the Agent row the verifier reads, plus FLAIR_ADMIN_AGENTS.
 *
 * Drives the REAL request gate (resources/auth-middleware.ts) and the REAL
 * per-resource verifier (resources/agent-auth.ts verifyAgentRequest) with REAL
 * Ed25519-signed requests against a mocked `harper` whose Agent table answers
 * each read from a scripted sequence of rows. A case scripts the FIRST read (the
 * row the signature is verified against) and every LATER read differently, so
 * the decision can only match the expectation when it comes from the verified
 * row itself.
 *
 * Also pins resources/agent-auth.ts annotatedCallerIsAdmin(), the decision the
 * handlers that identify a caller by its `tpsAgent` annotation use.
 *
 * Isolated: this file owns its `harper` and embeddings-provider mocks, as
 * test/unit-isolated/request-target-middleware.test.ts does.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { generateKeyPairSync, randomUUID, sign as edSign } from "node:crypto";
import { createFakeReplayNonceTable, ensureGlobalHarperTransaction } from "../helpers/fake-replay-store.ts";
import { HarperRequestTarget } from "../helpers/memory-route-registry.ts";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
delete (process.env as any).FLAIR_PUBLIC;
const savedAdminAgents = process.env.FLAIR_ADMIN_AGENTS;
delete (process.env as any).FLAIR_ADMIN_AGENTS;

mock.module("../../resources/embeddings-provider.ts", () => ({
  getEmbedding: async () => null,
  getModelId: () => "mock-embedding-model",
  getMode: () => "local",
  EMBEDDING_ENGINE: "gguf",
}));

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_B64 = Buffer.from((publicKey.export({ format: "jwk" }) as any).x, "base64url").toString("base64");
const OTHER = generateKeyPairSync("ed25519");
const OTHER_PUBLIC_B64 = Buffer.from((OTHER.publicKey.export({ format: "jwk" }) as any).x, "base64url").toString("base64");
const AGENT = "decision-agent";

/** The row the first Agent read returns, and the row every later read returns. */
let firstRow: any = null;
let laterRow: any = null;
let agentGets = 0;
let agentGetThrows = false;

const agentTable = {
  get: async (id: string) => {
    agentGets++;
    if (agentGetThrows) throw new Error("simulated read failure");
    if (id !== AGENT) return null;
    return agentGets === 1 ? firstRow : laterRow;
  },
  // Every row this table holds after the first read.
  search: async function* () {
    if (laterRow) yield laterRow;
  },
};

function table() {
  return { get: async () => null, search: async function* () {} };
}

let captured: any = null;
const harperServer: any = {
  getUser: async () => null,
  http: (fn: any) => { captured = fn; },
};
mock.module("harper", () => ({
  databases: {
    flair: {
      Agent: agentTable,
      Memory: table(),
      OrgEvent: table(),
      WorkspaceState: table(),
      ReplayNonce: createFakeReplayNonceTable(),
    },
  },
  server: harperServer,
  Resource: class {},
  RequestTarget: HarperRequestTarget,
  logger: { warn: () => {}, error: () => {}, info: () => {} },
}));

await import("../../resources/auth-middleware.ts");
const gate = captured as (request: any, next: any) => Promise<Response>;
const { verifyAgentRequest, annotatedCallerIsAdmin, agentIsAdmin } = await import("../../resources/agent-auth.ts");

let restoreTransaction: () => void = () => {};
beforeAll(() => { restoreTransaction = ensureGlobalHarperTransaction(); });
afterAll(() => {
  restoreTransaction();
  if (savedAdminAgents === undefined) delete (process.env as any).FLAIR_ADMIN_AGENTS;
  else process.env.FLAIR_ADMIN_AGENTS = savedAdminAgents;
});

function signedRequest(method: string, path: string): any {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${AGENT}:${ts}:${nonce}:${method}:${path}`;
  const sig = edSign(null, Buffer.from(payload), privateKey).toString("base64");
  const headers = new Map<string, string>([
    ["host", "localhost"],
    ["authorization", `TPS-Ed25519 ${AGENT}:${ts}:${nonce}:${sig}`],
  ]);
  return {
    url: path,
    method,
    headers: {
      get: (n: string) => headers.get(n.toLowerCase()) ?? null,
      set: (n: string, v: string) => { headers.set(n.toLowerCase(), v); },
      asObject: {},
    },
  };
}

/** Run a signed GET through the gate; return the request the next layer saw. */
async function throughGate(path = "/AgentKeyRegistration/"): Promise<{ status: number; seen: any }> {
  let seen: any = null;
  const res = await gate(signedRequest("GET", path), (req: any) => {
    seen = req;
    return new Response("ok", { status: 200 });
  });
  return { status: res.status, seen };
}

const row = (role: string, key = PUBLIC_B64) => ({ id: AGENT, publicKey: key, status: "active", role, admin: role === "admin" });

beforeEach(() => {
  firstRow = null;
  laterRow = null;
  agentGets = 0;
  agentGetThrows = false;
  delete (process.env as any).FLAIR_ADMIN_AGENTS;
});
afterEach(() => { delete (process.env as any).FLAIR_ADMIN_AGENTS; });

describe("agentIsAdmin: the configured ids plus the row's role", () => {
  it("admits a row whose role is admin, and an id the configuration names with any row", () => {
    expect(agentIsAdmin(AGENT, row("admin"))).toBe(true);
    expect(agentIsAdmin(AGENT, row("agent"))).toBe(false);
    expect(agentIsAdmin(AGENT, null)).toBe(false);
    // The admin Boolean alone is a mirror and does not admit.
    expect(agentIsAdmin(AGENT, { id: AGENT, role: "agent", admin: true })).toBe(false);
    process.env.FLAIR_ADMIN_AGENTS = `someone-else, ${AGENT}`;
    expect(agentIsAdmin(AGENT, row("agent"))).toBe(true);
    expect(agentIsAdmin(AGENT, null)).toBe(true);
    expect(agentIsAdmin("not-configured", row("agent"))).toBe(false);
  });
});

describe("the request gate decides admin from the row it verified the signature against", () => {
  it("a verified non-admin row is not an admin, even when a later read of the id returns an admin row", async () => {
    firstRow = row("agent");
    laterRow = row("admin", OTHER_PUBLIC_B64);
    const { seen } = await throughGate();
    expect(seen, "the signed request reached the next layer").not.toBeNull();
    expect(seen.tpsAgent).toBe(AGENT);
    expect(seen.tpsAgentIsAdmin).toBe(false);
    expect(seen.tpsAgentAdminFromVerifiedRow).toBe(true);
    expect(agentGets, "one Agent read: the decision reuses the verified row").toBe(1);
  });

  it("a verified admin row is an admin, even when a later read of the id returns a non-admin row", async () => {
    firstRow = row("admin");
    laterRow = row("agent", OTHER_PUBLIC_B64);
    const { seen } = await throughGate();
    expect(seen.tpsAgentIsAdmin).toBe(true);
    expect(seen.tpsAgentAdminFromVerifiedRow).toBe(true);
    expect(agentGets).toBe(1);
  });

  it("an id named in FLAIR_ADMIN_AGENTS is an admin with a non-admin row", async () => {
    process.env.FLAIR_ADMIN_AGENTS = AGENT;
    firstRow = row("agent");
    laterRow = row("agent");
    const { seen } = await throughGate();
    expect(seen.tpsAgentIsAdmin).toBe(true);
  });

  it("the gate's own admin-only refusal follows the same decision", async () => {
    firstRow = row("agent");
    laterRow = row("admin", OTHER_PUBLIC_B64);
    const refused = await throughGate("/sql");
    expect(refused.status).toBe(403);
    expect(refused.seen).toBeNull();

    agentGets = 0;
    firstRow = row("admin");
    laterRow = row("agent", OTHER_PUBLIC_B64);
    const admitted = await throughGate("/sql");
    expect(admitted.status).toBe(200);
    expect(admitted.seen?.tpsAgentIsAdmin).toBe(true);
  });
});

describe("the per-resource verifier decides admin from the row it verified the signature against", () => {
  it("a verified non-admin row is not an admin, even when a later read of the id returns an admin row", async () => {
    firstRow = row("agent");
    laterRow = row("admin", OTHER_PUBLIC_B64);
    const auth = await verifyAgentRequest(signedRequest("GET", "/AgentKeyRegistration/"));
    expect(auth).toEqual({ agentId: AGENT, isAdmin: false });
    expect(agentGets, "one Agent read: the decision reuses the verified row").toBe(1);
  });

  it("a verified admin row is an admin, even when a later read of the id returns a non-admin row", async () => {
    firstRow = row("admin");
    laterRow = row("agent", OTHER_PUBLIC_B64);
    const auth = await verifyAgentRequest(signedRequest("GET", "/AgentKeyRegistration/"));
    expect(auth).toEqual({ agentId: AGENT, isAdmin: true });
    expect(agentGets).toBe(1);
  });

  it("an id named in FLAIR_ADMIN_AGENTS is an admin with a non-admin row", async () => {
    process.env.FLAIR_ADMIN_AGENTS = AGENT;
    firstRow = row("agent");
    laterRow = row("agent");
    const auth = await verifyAgentRequest(signedRequest("GET", "/AgentKeyRegistration/"));
    expect(auth).toEqual({ agentId: AGENT, isAdmin: true });
  });
});

describe("annotatedCallerIsAdmin: the decision for a handler that reads the tpsAgent annotation", () => {
  it("a gate-verified request returns the gate's decision and reads no Agent row", async () => {
    firstRow = row("admin");
    laterRow = row("admin");
    expect(await annotatedCallerIsAdmin({ tpsAgent: AGENT, tpsAgentIsAdmin: false, tpsAgentAdminFromVerifiedRow: true })).toBe(false);
    process.env.FLAIR_ADMIN_AGENTS = AGENT;
    expect(await annotatedCallerIsAdmin({ tpsAgent: AGENT, tpsAgentIsAdmin: false, tpsAgentAdminFromVerifiedRow: true })).toBe(false);
    expect(await annotatedCallerIsAdmin({ tpsAgent: AGENT, tpsAgentIsAdmin: true, tpsAgentAdminFromVerifiedRow: true })).toBe(true);
    expect(agentGets).toBe(0);
  });

  it("any other annotated caller is decided from its Agent row read at the time of the call", async () => {
    firstRow = row("admin");
    laterRow = row("agent");
    expect(await annotatedCallerIsAdmin({ tpsAgent: AGENT, tpsAgentIsAdmin: false })).toBe(true);
    expect(await annotatedCallerIsAdmin({ tpsAgent: AGENT, tpsAgentIsAdmin: false })).toBe(false);
    expect(agentGets, "each call reads the row").toBe(2);
  });

  it("a configured id is admitted, and a failed read admits only a configured id", async () => {
    agentGetThrows = true;
    expect(await annotatedCallerIsAdmin({ tpsAgent: AGENT })).toBe(false);
    process.env.FLAIR_ADMIN_AGENTS = AGENT;
    expect(await annotatedCallerIsAdmin({ tpsAgent: AGENT })).toBe(true);
  });

  it("a request with no tpsAgent is not an admin", async () => {
    firstRow = row("admin");
    expect(await annotatedCallerIsAdmin({})).toBe(false);
    expect(await annotatedCallerIsAdmin({ tpsAgentIsAdmin: true })).toBe(false);
    expect(await annotatedCallerIsAdmin(undefined)).toBe(false);
    expect(agentGets).toBe(0);
  });
});
