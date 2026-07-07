/**
 * ed25519-auth-cross-site.test.ts — REAL cross-module closure proof (shared
 * nonce-store consolidation): agent-auth.ts's verifyAgentRequest() and Presence.ts's post()
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
 *
 * Also hosts the #592 currentTask-content-gate tests for Presence.get()
 * (below the nonce-replay describe blocks) — this file already owns the
 * process-wide `resources/Presence.ts` import/mock in test/unit/, and bun
 * runs every file in test/unit/ in ONE process, so a second file re-mocking
 * @harperfast/harper and re-importing Presence.ts would race this one for
 * which mock "wins" for the shared module cache (see
 * memory-soul-read-gate.test.ts's header comment for the same footgun on
 * Memory.ts). Safer to extend this file than add a competing one.
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
    // #592 tests below seed `presenceRecords` directly and read it back via
    // Presence.get()'s roster scan. The pre-#592 nonce-replay tests above
    // never call .get() (only .post()), so yielding real rows here is a
    // no-op for them.
    async function* gen() {
      for (const rec of Object.values(presenceRecords)) yield rec;
    }
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

// ─── #592 — GET /Presence currentTask content gate ─────────────────────────
//
// currentTask is content-gated to VERIFIED IN-ORG AGENTS: only a caller
// presenting a valid TPS-Ed25519 signature gets the task text; everyone else
// (anonymous, Harper `authorizeLocal` loopback super_user, Basic-admin,
// in-process) gets currentTask=null.
//
// v1 of this fix keyed the gate off resolveAgentAuth().kind === "agent" and
// used `{ tpsAgent }` / `{ tpsAnonymous }` mock contexts. That PASSED the
// mocks but LEAKED against a real spawned Harper (integration test), because:
//   (a) /Presence is a public-passthrough in auth-middleware.ts — the
//       middleware early-returns and NEVER sets tpsAgent/tpsAnonymous, so those
//       annotation shapes don't occur for this path; and
//   (b) Harper's authorizeLocal (config default true) injects request.user =
//       super_user for any CREDENTIAL-LESS loopback GET (node .../server/http.js:
//       "pass the user ... Only applies when there is no Authorization header").
// resolveAgentAuth() then classified that credential-less super_user as
// `kind:"agent"` → currentTask leaked to an unauthenticated caller.
//
// The real gate keys off verifyAgentRequest() — a valid TPS-Ed25519 signature,
// which authorizeLocal cannot manufacture (a signature requires the
// Authorization header, whose presence suppresses the super_user injection).
// These tests therefore drive REAL request shapes (signed header / no header /
// super_user-without-header), NOT tpsAgent annotations. Reuses this file's
// existing Presence.ts import/mock (test/unit/ files that
// mock.module("@harperfast/harper") + dynamically import resources/Presence.ts
// share bun's process-global module cache — see memory-soul-read-gate.test.ts's
// header comment for the collision this avoids by NOT re-importing Presence.ts
// from a second file).

// A no-Authorization-header GET request (headers.get returns undefined).
// `extra` lets us layer on Harper's authorizeLocal super_user injection.
function unsignedGetReq(extra: Record<string, unknown> = {}): any {
  return {
    headers: { get: (_n: string) => undefined },
    url: "/Presence",
    method: "GET",
    ...extra,
  };
}

// A GET request carrying a real, valid TPS-Ed25519 signature for `agentId`
// (the agent must be registered via makeAgent so its pubkey verifies).
function signedGetReq(agentId: string, ts: number, nonce: string, secretKey: Uint8Array): any {
  const payload = `${agentId}:${ts}:${nonce}:GET:/Presence`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), secretKey);
  const sigB64 = Buffer.from(sig).toString("base64");
  const header = `TPS-Ed25519 ${agentId}:${ts}:${nonce}:${sigB64}`;
  return {
    headers: { get: (n: string) => (n === "authorization" ? header : undefined) },
    url: "/Presence",
    method: "GET",
  };
}

describe("Presence.get() — currentTask content gate (closes #592)", () => {
  it("anonymous reader (no Authorization header): currentTask is null, other roster fields ARE present", async () => {
    presenceRecords["agent-anon-1"] = {
      agentId: "agent-anon-1",
      currentTask: "investigating preprod-db-3: replication lag",
      activity: "coding",
      lastHeartbeatAt: Date.now(),
    };

    const presence = makePresenceInstance(unsignedGetReq());
    const roster: any[] = await presence.get();

    const entry = roster.find((r) => r.id === "agent-anon-1");
    expect(entry).toBeDefined();
    expect(entry.currentTask).toBeNull();
    // key is present-and-null, not omitted — schema-stable
    expect("currentTask" in entry).toBe(true);
    // roster metadata is unaffected by the gate
    expect(entry.activity).toBe("coding");
    expect(typeof entry.lastHeartbeatAt).toBe("number");
  });

  it("THE REGRESSION GUARD — authorizeLocal loopback super_user (request.user super_user, NO Authorization header) still gets currentTask=null", async () => {
    // This is the exact real-Harper shape that leaked in v1: a credential-less
    // loopback GET that Harper's authorizeLocal auto-authorizes as super_user.
    // resolveAgentAuth() calls this `kind:"agent"` and WOULD leak; the
    // signature-based gate treats it as unverified (no TPS-Ed25519 header) and
    // strips currentTask.
    presenceRecords["agent-loopback-1"] = {
      agentId: "agent-loopback-1",
      currentTask: "customer acme-corp: preprod incident detail",
      activity: "reviewing",
      lastHeartbeatAt: Date.now(),
    };

    const loopbackSuperUserReq = unsignedGetReq({
      user: { username: "admin", role: { permission: { super_user: true } } },
    });
    const presence = makePresenceInstance(loopbackSuperUserReq);
    const roster: any[] = await presence.get();

    const entry = roster.find((r) => r.id === "agent-loopback-1");
    expect(entry).toBeDefined();
    expect(entry.currentTask).toBeNull();
    // roster itself is still served (allowRead stays public) — only the field is gated
    expect(entry.activity).toBe("reviewing");
  });

  it("verified in-org agent (valid TPS-Ed25519 signature on the request): currentTask IS present, full text", async () => {
    const agentId = "agent-verified-1";
    const { secretKey } = makeAgent(agentId);
    // The RECORD owner differs from the READER — Presence has no per-agent
    // ownership scoping on read (the roster is a shared view), only a
    // verified-vs-unverified content gate. Any verified agent sees any agent's
    // currentTask, by design (#592's proposal).
    presenceRecords["agent-owner-x"] = {
      agentId: "agent-owner-x",
      currentTask: "investigating preprod-db-3: replication lag",
      activity: "coding",
      lastHeartbeatAt: Date.now(),
    };

    const ts = Date.now();
    const presence = makePresenceInstance(signedGetReq(agentId, ts, "get-nonce-verified-1", secretKey));
    const roster: any[] = await presence.get();

    const entry = roster.find((r) => r.id === "agent-owner-x");
    expect(entry).toBeDefined();
    expect(entry.currentTask).toBe("investigating preprod-db-3: replication lag");
  });

  it("no bypass: a garbage/invalid Authorization header (not a valid signature) → currentTask still stripped", async () => {
    presenceRecords["agent-badauth-1"] = {
      agentId: "agent-badauth-1",
      currentTask: "customer acme-corp: incident review",
      activity: "reviewing",
      lastHeartbeatAt: Date.now(),
    };

    const badReq = {
      headers: { get: (n: string) => (n === "authorization" ? "TPS-Ed25519 garbage-no-colons" : undefined) },
      url: "/Presence",
      method: "GET",
    };
    const presence = makePresenceInstance(badReq);
    const roster: any[] = await presence.get();

    const entry = roster.find((r) => r.id === "agent-badauth-1");
    expect(entry.currentTask).toBeNull();
  });

  it("no bypass: a Basic-admin Authorization header (no agent signature) → currentTask still stripped", async () => {
    // A real Basic-admin request carries `Authorization: Basic ...`, which is
    // NOT a TPS-Ed25519 signature — verifyAgentRequest returns null → stripped.
    // (Fails closed: even a privileged operator gets null via the public roster
    // endpoint; the observation-center admin view sources task text elsewhere.)
    presenceRecords["agent-basic-1"] = {
      agentId: "agent-basic-1",
      currentTask: "customer acme-corp: renewal risk",
      activity: "planning",
      lastHeartbeatAt: Date.now(),
    };

    const basicReq = {
      headers: { get: (n: string) => (n === "authorization" ? "Basic YWRtaW46dGVzdDEyMw==" : undefined) },
      url: "/Presence",
      method: "GET",
      user: { username: "admin", role: { permission: { super_user: true } } },
    };
    const presence = makePresenceInstance(basicReq);
    const roster: any[] = await presence.get();

    expect(roster.find((r) => r.id === "agent-basic-1").currentTask).toBeNull();
  });

  it("no bypass: an id-suffixed single-record GET routes through the SAME get() and is gated identically", async () => {
    // Harper's REST layer (dist/server/REST.js) has exactly ONE call site for
    // every GET — `resource.get(target, request)` — whether the URL carries
    // an id or not. Presence.get() ignores `target` and always returns the
    // full roster array, so there is no separate single-record return path
    // that could skip the gate. Passing a target argument here proves the
    // gate applies identically regardless of call shape.
    const agentId = "agent-reader-single";
    const { secretKey } = makeAgent(agentId);
    presenceRecords["agent-single-1"] = {
      agentId: "agent-single-1",
      currentTask: "should not leak to anonymous single-record GET",
      activity: "idle",
      lastHeartbeatAt: Date.now(),
    };

    const anonPresence = makePresenceInstance(unsignedGetReq());
    const anonRoster: any[] = await (anonPresence.get as any)("agent-single-1");
    expect(anonRoster.find((r) => r.id === "agent-single-1").currentTask).toBeNull();

    const ts = Date.now();
    const verifiedPresence = makePresenceInstance(signedGetReq(agentId, ts, "get-nonce-single-1", secretKey));
    const verifiedRoster: any[] = await (verifiedPresence.get as any)("agent-single-1");
    expect(verifiedRoster.find((r) => r.id === "agent-single-1").currentTask).toBe(
      "should not leak to anonymous single-record GET",
    );
  });

  it("allowRead() is unchanged — still true for both anonymous and verified (the roster itself stays public)", async () => {
    const anon = makePresenceInstance(unsignedGetReq());
    const verified = makePresenceInstance({ tpsAgent: "agent-x", tpsAgentIsAdmin: false });
    expect(await anon.allowRead()).toBe(true);
    expect(await verified.allowRead()).toBe(true);
  });
});
