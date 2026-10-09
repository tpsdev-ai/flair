// basic-auth-lookup-fail-closed-2403.test.ts — flair#2403.
//
// Injected Agent.get throws exercise the shared helper, resolveAgentAuth,
// and the reachable middleware Basic branches.
// The flair_pair_initiator site is covered only through its shared helper.
//
// Lives in test/unit-isolated/ because mock.module is process-global: this file
// mocks the Agent read to THROW on demand, so it must not race a sibling file's
// harper mock (harper-mock.ts's own header says the same).

import { mock, describe, it, expect, beforeEach } from "bun:test";

// ─── harper mock ─────────────────────────────────────────────────────────────
//
// Same shape as test/unit/principal-deactivation.test.ts (agentStore / serverStore
// / middlewareCapture), plus a per-id failure toggle: Agent.get THROWS for any id
// in `failIds`, modelling the failed read this issue is about.

const agentStore = new Map<string, any>();
const serverStore = { getUserResult: null as any, getUserError: false };
const middlewareCapture = { value: null as any };
const failIds = new Set<string>();

mock.module("harper", () => ({
  databases: {
    flair: {
      Agent: {
        get: async (id: string) => {
          if (failIds.has(id)) throw new Error("injected Agent lookup failure");
          return agentStore.get(id) ?? null;
        },
        search: async function* () {},
      },
    },
  },
  server: {
    getUser: async () => {
      if (serverStore.getUserError) throw new Error("getUser failed");
      return serverStore.getUserResult;
    },
    http: (fn: any) => { middlewareCapture.value = fn; },
  },
  Resource: class {},
}));

const {
  resolveAgentAuth,
  readCredentialedPrincipal,
  AGENT_LOOKUP_FAILED,
} = await import("../../resources/agent-auth.ts");
await import("../../resources/auth-middleware.ts");
const authMiddleware = middlewareCapture.value;

// ─── fixtures ────────────────────────────────────────────────────────────────

const BASIC = "Basic dXNlcjpwYXNz";
const superUser = { username: "admin", role: { permission: { super_user: true } } };
const perAgentUser = (username: string) => ({ username, role: { permission: {} } });
const activeAgent = (id: string) => ({ id, status: "active" });

function getShape(header?: string): any {
  return {
    headers: { get: (n: string) => (n === "authorization" ? header : undefined) },
    url: "/x",
    method: "GET",
  };
}

function makeRequest(overrides: any = {}) {
  const headers = new Map<string, string>();
  if (overrides.authorization) headers.set("authorization", overrides.authorization);
  headers.set("host", "localhost");
  return {
    url: overrides.url ?? "/Memory",
    method: overrides.method ?? "GET",
    headers: {
      get: (name: string) => headers.get(name.toLowerCase()) ?? null,
      set: (name: string, value: string) => { headers.set(name.toLowerCase(), value); },
      asObject: {},
    },
    user: overrides.user ?? undefined,
  } as Record<string, any>;
}

const nextLayer = (_req?: any) => new Response("ok", { status: 200 });
const bodyOf = async (res: Response) => JSON.parse(await res.text());

beforeEach(() => {
  agentStore.clear();
  failIds.clear();
  serverStore.getUserResult = null;
  serverStore.getUserError = false;
});

// ─── the read itself: failed vs. absent are distinct ─────────────────────────

describe("readCredentialedPrincipal — a failed read is not an absent row", () => {
  it("a THROWING read → { ok: false }", async () => {
    failIds.add("agent-x");
    const read = await readCredentialedPrincipal("agent-x");
    expect(read.ok).toBe(false);
  });

  it("a successful read with no row → { ok: true, agent: null }", async () => {
    const read = await readCredentialedPrincipal("no-such-agent");
    expect(read).toEqual({ ok: true, agent: null });
  });

  it("a successful read with a row → { ok: true, agent: <row> }", async () => {
    agentStore.set("agent-y", activeAgent("agent-y"));
    const read = await readCredentialedPrincipal("agent-y");
    expect(read).toEqual({ ok: true, agent: activeAgent("agent-y") });
  });
});

// ─── site 1/2: resolveAgentAuth's two credentialed Basic branches ────────────

describe("resolveAgentAuth — a failed Agent read on the Basic path is REFUSED by name", () => {
  it("super_user branch: read throws → anonymous, agent_lookup_failed", async () => {
    failIds.add("admin");
    const v = await resolveAgentAuth({ user: superUser, ...getShape(BASIC) });
    expect(v).toEqual({ kind: "anonymous", error: AGENT_LOOKUP_FAILED });
  });

  it("per-agent branch: read throws → anonymous, agent_lookup_failed", async () => {
    failIds.add("agent-3");
    const v = await resolveAgentAuth({ user: perAgentUser("agent-3"), ...getShape(BASIC) });
    expect(v).toEqual({ kind: "anonymous", error: AGENT_LOOKUP_FAILED });
  });
});

describe("resolveAgentAuth — a successful read decides exactly as before", () => {
  it("active super_user → admitted admin", async () => {
    agentStore.set("admin", activeAgent("admin"));
    const v = await resolveAgentAuth({ user: superUser, ...getShape(BASIC) });
    expect(v).toEqual({ kind: "agent", agentId: "admin", isAdmin: true });
  });

  it("active per-agent user → admitted non-admin", async () => {
    agentStore.set("agent-3", activeAgent("agent-3"));
    const v = await resolveAgentAuth({ user: perAgentUser("agent-3"), ...getShape(BASIC) });
    expect(v).toEqual({ kind: "agent", agentId: "agent-3", isAdmin: false });
  });

  it("an ABSENT row is unchanged: super_user still admitted (not a failed read)", async () => {
    // No agentStore entry and no failIds entry → the read SUCCEEDS, finds nothing,
    // exactly as on origin/main.
    const v = await resolveAgentAuth({ user: superUser, ...getShape(BASIC) });
    expect(v).toEqual({ kind: "agent", agentId: "admin", isAdmin: true });
  });
});

// ─── reachable middleware Basic lookup sites ───────────────────────────────

describe("authMiddleware — a failed Agent read REFUSES (500, agent_lookup_failed)", () => {
  it("Branch 1 (Harper ambient super_user): read throws → refusal, no tpsAgent stamped", async () => {
    failIds.add("admin");
    const req = makeRequest({
      authorization: "Basic YWRtaW46cGFzcw==",
      user: { username: "admin", role: { permission: { super_user: true } } },
    });
    const res = await authMiddleware(req, nextLayer);
    expect(res.status).toBe(500);
    expect(await bodyOf(res)).toMatchObject({ error: AGENT_LOOKUP_FAILED });
    expect(req.tpsAgent).toBeUndefined();
  });

  it("Path 1 (env-var admin fast-path): read throws → refusal", async () => {
    const saved = process.env.HDB_ADMIN_PASSWORD;
    process.env.HDB_ADMIN_PASSWORD = "testpw";
    try {
      failIds.add("admin");
      const req = makeRequest({ authorization: "Basic " + btoa("admin:testpw") });
      const res = await authMiddleware(req, nextLayer);
      expect(res.status).toBe(500);
      expect(await bodyOf(res)).toMatchObject({ error: AGENT_LOOKUP_FAILED });
      expect(req.tpsAgent).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.HDB_ADMIN_PASSWORD = saved;
      else delete process.env.HDB_ADMIN_PASSWORD;
    }
  });

  it("Path 2 (Harper super_user check): read throws → refusal", async () => {
    serverStore.getUserResult = { username: "superguy", role: { permission: { super_user: true } } };
    const saved = process.env.HDB_ADMIN_PASSWORD;
    delete process.env.HDB_ADMIN_PASSWORD;
    try {
      failIds.add("superguy");
      const req = makeRequest({ authorization: "Basic " + btoa("superguy:pass") });
      const res = await authMiddleware(req, nextLayer);
      expect(res.status).toBe(500);
      expect(await bodyOf(res)).toMatchObject({ error: AGENT_LOOKUP_FAILED });
      expect(req.tpsAgent).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.HDB_ADMIN_PASSWORD = saved;
    }
  });
});

describe("authMiddleware — a successful read decides exactly as before", () => {
  it("Branch 1 with an ACTIVE super_user → tpsAgent stamped (200)", async () => {
    agentStore.set("admin", activeAgent("admin"));
    const req = makeRequest({
      authorization: "Basic YWRtaW46cGFzcw==",
      user: { username: "admin", role: { permission: { super_user: true } } },
    });
    const res = await authMiddleware(req, nextLayer);
    expect(res.status).toBe(200);
    expect(req.tpsAgent).toBe("admin");
    expect(req.tpsAgentIsAdmin).toBe(true);
  });

  it("Branch 1 with an ABSENT row is unchanged: tpsAgent still stamped (200)", async () => {
    // No failIds entry → the read succeeds and finds no row; origin/main admitted.
    const req = makeRequest({
      authorization: "Basic YWRtaW46cGFzcw==",
      user: { username: "admin", role: { permission: { super_user: true } } },
    });
    const res = await authMiddleware(req, nextLayer);
    expect(res.status).toBe(200);
    expect(req.tpsAgent).toBe("admin");
  });

  it("Path 2 with an ACTIVE super_user → tpsAgent stamped (200)", async () => {
    serverStore.getUserResult = { username: "superguy", role: { permission: { super_user: true } } };
    const saved = process.env.HDB_ADMIN_PASSWORD;
    delete process.env.HDB_ADMIN_PASSWORD;
    try {
      agentStore.set("superguy", activeAgent("superguy"));
      const req = makeRequest({ authorization: "Basic " + btoa("superguy:pass") });
      const res = await authMiddleware(req, nextLayer);
      expect(res.status).toBe(200);
      expect(req.tpsAgent).toBe("superguy");
    } finally {
      if (saved !== undefined) process.env.HDB_ADMIN_PASSWORD = saved;
    }
  });
});
