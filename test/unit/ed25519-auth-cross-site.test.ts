/**
 * ed25519-auth-cross-site.test.ts — REAL cross-module closure proof (bd
 * ops-c4op): agent-auth.ts's verifyAgentRequest() and Presence.ts's post()
 * fallback verification are two of the three independent TPS-Ed25519 call
 * sites that used to carry their OWN nonceSeen Map. This test imports BOTH
 * real modules under one @harperfast/harper mock (bun's module cache is
 * process-global, so both modules resolve the SAME `../../resources/
 * ed25519-auth.ts` singleton) and proves a nonce recorded via one site is
 * rejected as a replay via the OTHER — in both directions — using a real
 * Ed25519 keypair and a real signature, not a simulated header.
 *
 * (The third site, auth-middleware.ts, is covered together with
 * agent-auth.ts in auth-middleware-ed25519.test.ts — its registration model
 * via `server.http()` needs a slightly different mock shape.)
 *
 * Per the harness lesson (order-dependent CI failure): any test that mocks
 * @harperfast/harper MUST also export `Resource` in the mock object.
 */
import { mock, describe, it, expect, beforeEach } from "bun:test";
import nacl from "tweetnacl";

// ─── Fixtures ───────────────────────────────────────────────────────────────

let agentsById: Record<string, { publicKey: string }> = {};
let presenceRecords: Record<string, any> = {};

class BasePresence {
  static async get(id: string) {
    return presenceRecords[id] ?? null;
  }
  static async put(rec: any) {
    presenceRecords[rec.agentId] = rec;
    return rec;
  }
  static search() {
    async function* gen() {}
    return gen();
  }
}

const databasesMock = {
  flair: {
    Agent: {
      get: async (id: string) => agentsById[id] ?? null,
      search: async function* (_q?: any) {
        // No admin agents in this fixture set.
      },
    },
    Presence: BasePresence,
  },
};

// Minimal stand-in for Harper's runtime-injected `Resource` base class —
// required alongside `databases` any time @harperfast/harper is mocked, or a
// later-loaded test file in the same bun process fails with "Export named
// Resource not found" (bun mock.module is process-global).
class MockResourceBase {}

// `server` isn't used by this file's own imports (agent-auth.ts / Presence.ts
// don't import it), but auth-middleware-ed25519.test.ts's `import { server }`
// DOES need it — and because bun's mock.module is process-global, whichever
// mock is active when THAT file's import resolves wins, regardless of file
// order. A superset mock (server + databases + Resource) is the safe shape
// (same pattern as test/unit/mcp-oauth-register.test.ts).
mock.module("@harperfast/harper", () => ({
  server: { http: () => {}, getUser: async (name: string) => ({ username: name, role: { permission: {} } }) },
  databases: databasesMock,
  Resource: MockResourceBase,
}));

const { verifyAgentRequest } = await import("../../resources/agent-auth.ts");
const { Presence } = await import("../../resources/Presence.ts");

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeAgent(agentId: string): { secretKey: Uint8Array; publicKeyB64: string } {
  const kp = nacl.sign.keyPair();
  const publicKeyB64 = Buffer.from(kp.publicKey).toString("base64");
  agentsById[agentId] = { publicKey: publicKeyB64 };
  return { secretKey: kp.secretKey, publicKeyB64 };
}

/**
 * Signs `${agentId}:${ts}:${nonce}:POST:/Presence` — the canonical payload
 * BOTH agent-auth.ts's doVerify (via `new URL(request.url).pathname` on
 * "/Presence" with no query string) and Presence.ts's own fallback verify
 * (via `request.url.split("?")[0]`, method hardcoded "POST") compute
 * identically for this exact request shape. One signature, valid at both
 * sites — the point of the test.
 */
function signPresencePost(agentId: string, ts: number, nonce: string, secretKey: Uint8Array): string {
  const payload = `${agentId}:${ts}:${nonce}:POST:/Presence`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), secretKey);
  const sigB64 = Buffer.from(sig).toString("base64");
  return `TPS-Ed25519 ${agentId}:${ts}:${nonce}:${sigB64}`;
}

function reqFor(header: string): any {
  return {
    headers: { get: (n: string) => (n === "authorization" ? header : undefined) },
    url: "/Presence",
    method: "POST",
    // tpsAgent deliberately unset — forces Presence.post() to do its OWN
    // verification instead of trusting a middleware annotation.
  };
}

function makePresenceInstance(request: any): any {
  const p: any = new (Presence as any)();
  p.getContext = () => ({ request });
  return p;
}

beforeEach(() => {
  agentsById = {};
  presenceRecords = {};
});

// ─── Cross-path closure ─────────────────────────────────────────────────────

describe("cross-site nonce replay closure: agent-auth.ts -> Presence.ts", () => {
  it("a nonce recorded via verifyAgentRequest() is rejected as replay via Presence.post()", async () => {
    const agentId = "agent-cross-1";
    const { secretKey } = makeAgent(agentId);
    const ts = Date.now();
    const nonce = "cross-nonce-1";
    const header = signPresencePost(agentId, ts, nonce, secretKey);

    // 1) First use, via agent-auth.ts's verifyAgentRequest — succeeds, records the nonce.
    const first = await verifyAgentRequest(reqFor(header));
    expect(first).toEqual({ agentId, isAdmin: false });

    // 2) SAME header replayed via Presence.ts's OWN verification fallback.
    //    If the two sites still had independent nonceSeen Maps, this would
    //    succeed (Presence never saw the nonce). With the shared store, it
    //    must be rejected.
    const presence = makePresenceInstance(reqFor(header));
    const res = await presence.post({ activity: "idle" });
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("nonce_replay_detected");
  });
});

describe("cross-site nonce replay closure: Presence.ts -> agent-auth.ts", () => {
  it("a nonce recorded via Presence.post() is rejected as replay via verifyAgentRequest()", async () => {
    const agentId = "agent-cross-2";
    const { secretKey } = makeAgent(agentId);
    const ts = Date.now();
    const nonce = "cross-nonce-2";
    const header = signPresencePost(agentId, ts, nonce, secretKey);

    // 1) First use, via Presence.ts's own verify path — succeeds, records the nonce.
    const presence = makePresenceInstance(reqFor(header));
    const res = await presence.post({ activity: "coding" });
    expect(res).toEqual({ ok: true, agentId, lastHeartbeatAt: expect.any(Number), presenceStatus: "active" });

    // 2) SAME header replayed via agent-auth.ts's verifyAgentRequest — must be
    //    rejected (null) because the nonce is already recorded in the shared store.
    const second = await verifyAgentRequest(reqFor(header));
    expect(second).toBeNull();
  });
});

// ─── Per-site negative-path coverage (Steps item 4) ────────────────────────

describe("agent-auth.ts verifyAgentRequest — per-site negative paths", () => {
  it("rejects a tampered signature", async () => {
    const agentId = "agent-neg-1";
    const { secretKey } = makeAgent(agentId);
    const ts = Date.now();
    const nonce = "neg-nonce-1";
    // Sign a DIFFERENT payload than the one that will be verified.
    const wrongPayload = `${agentId}:${ts}:${nonce}:POST:/SomewhereElse`;
    const sig = nacl.sign.detached(new TextEncoder().encode(wrongPayload), secretKey);
    const header = `TPS-Ed25519 ${agentId}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;

    const result = await verifyAgentRequest(reqFor(header));
    expect(result).toBeNull();
  });

  it("rejects an unknown agent", async () => {
    const ts = Date.now();
    const header = `TPS-Ed25519 nobody:${ts}:some-nonce:c2ln`;
    const result = await verifyAgentRequest(reqFor(header));
    expect(result).toBeNull();
  });

  it("rejects an expired timestamp", async () => {
    const agentId = "agent-neg-2";
    const { secretKey } = makeAgent(agentId);
    const ts = Date.now() - 60_000; // 60s old, WINDOW_MS is 30s
    const nonce = "neg-nonce-2";
    const header = signPresencePost(agentId, ts, nonce, secretKey);
    const result = await verifyAgentRequest(reqFor(header));
    expect(result).toBeNull();
  });

  it("rejects an outright replay within the same site", async () => {
    const agentId = "agent-neg-3";
    const { secretKey } = makeAgent(agentId);
    const ts = Date.now();
    const nonce = "neg-nonce-3";
    const header = signPresencePost(agentId, ts, nonce, secretKey);

    const first = await verifyAgentRequest(reqFor(header));
    expect(first).toEqual({ agentId, isAdmin: false });

    const replay = await verifyAgentRequest(reqFor(header));
    expect(replay).toBeNull();
  });
});

describe("Presence.ts post() — per-site negative paths", () => {
  it("rejects a tampered signature with invalid_signature", async () => {
    const agentId = "agent-neg-4";
    const { secretKey } = makeAgent(agentId);
    const ts = Date.now();
    const nonce = "neg-nonce-4";
    const wrongPayload = `${agentId}:${ts}:${nonce}:POST:/SomewhereElse`;
    const sig = nacl.sign.detached(new TextEncoder().encode(wrongPayload), secretKey);
    const header = `TPS-Ed25519 ${agentId}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;

    const presence = makePresenceInstance(reqFor(header));
    const res = await presence.post({ activity: "idle" });
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("invalid_signature");
  });

  it("rejects an unknown agent with unknown_agent", async () => {
    const ts = Date.now();
    const header = `TPS-Ed25519 ghost-agent:${ts}:some-nonce:c2ln`;
    const presence = makePresenceInstance(reqFor(header));
    const res = await presence.post({ activity: "idle" });
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unknown_agent");
  });

  it("rejects a replay within the same site with nonce_replay_detected", async () => {
    const agentId = "agent-neg-5";
    const { secretKey } = makeAgent(agentId);
    const ts = Date.now();
    const nonce = "neg-nonce-5";
    const header = signPresencePost(agentId, ts, nonce, secretKey);

    const first = await makePresenceInstance(reqFor(header)).post({ activity: "idle" });
    expect((first as any).ok).toBe(true);

    const replay = await makePresenceInstance(reqFor(header)).post({ activity: "idle" });
    expect(replay).toBeInstanceOf(Response);
    expect(replay.status).toBe(401);
    const body = await replay.json();
    expect(body.error).toBe("nonce_replay_detected");
  });
});
