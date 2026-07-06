/**
 * cross-agent-isolation.test.ts — NECESSITY tests for the cross-agent read-isolation P0 fix.
 *
 * flair-agent-deelevation.test.ts (integration) only asserts SUFFICIENCY: an
 * agent CAN read its own WorkspaceLatest / OrgEventCatchup (`not.toContain([401,403])`).
 * It never asserts NECESSITY — that an agent is DENIED another agent's data.
 * That coverage gap is exactly why the fail-open cross-agent-read bug shipped
 * and stayed CI-green:
 *
 *   - WorkspaceLatest.ts:20 read `(this as any).context?.request ?? (this as
 *     any).request`, which Harper v5 never populates on Resource subclasses.
 *     callerAgent was always undefined, so `if (callerAgent && ...)` never
 *     ran — any verified agent could read any OTHER agent's workspace state.
 *   - OrgEventCatchup.ts:27 had the identical bug via `(this as any).request`.
 *
 * Same mocking technique as coordination-write-auth.test.ts: mock
 * @harperfast/harper (databases + Resource) so the resource classes can be
 * imported and invoked directly with a synthetic context, outside a running
 * Harper instance.
 */

import { mock, describe, it, expect, beforeEach } from "bun:test";

// ─── Fixtures ─────────────────────────────────────────────────────────────

let workspaceStateRecords: any[] = [];
let orgEventRecords: any[] = [];
let authCodePut: any = null;

class BaseWorkspaceState {
  static search(query: any) {
    async function* gen() {
      const cond = query?.conditions?.find((c: any) => c.attribute === "agentId");
      for (const r of workspaceStateRecords) {
        if (cond && r.agentId !== cond.value) continue;
        yield r;
      }
    }
    return gen();
  }
}

class BaseOrgEvent {
  static search(_query?: any) {
    async function* gen() {
      for (const r of orgEventRecords) yield r;
    }
    return gen();
  }
}

// Minimal stand-in for Harper's runtime-injected `Resource` base class.
// WorkspaceLatest / OrgEventCatchup / OAuth extend this directly (unlike
// WorkspaceState / OrgEvent, which extend databases.flair.X).
class MockResourceBase {
  getContext() { return {}; }
  getId() { return undefined; }
}

// Generic constructable stand-in for tables that other resources merely
// `extends databases.flair.X` at module-load time — OAuth.ts imports XAA.ts
// (for the jwt-bearer grant), and XAA.ts declares `class IdpConfig extends
// (databases as any).flair.IdpConfig`. That class body never runs in these
// tests, but the module-level `extends` needs a real constructor or the
// import throws "superclass is not a constructor".
class GenericTable {
  static async get() { return null; }
  static async put(rec: any) { return rec; }
  static async delete() { return true; }
  static async *search() {}
}

const databasesMock = {
  flair: {
    WorkspaceState: BaseWorkspaceState,
    OrgEvent: BaseOrgEvent,
    OAuthAuthCode: {
      put: async (rec: any) => { authCodePut = rec; return rec; },
    },
    OAuthClient: { get: async () => null },
    Agent: { get: async () => null, search: async function* () {} },
    IdpConfig: GenericTable,
    IdJagReplay: GenericTable,
    Credential: GenericTable,
    OAuthToken: GenericTable,
  },
};

mock.module("@harperfast/harper", () => ({
  databases: databasesMock,
  Resource: MockResourceBase,
}));

const { WorkspaceLatest } = await import("../../resources/WorkspaceLatest.ts");
const { OrgEventCatchup } = await import("../../resources/OrgEventCatchup.ts");
const { OAuthAuthorize } = await import("../../resources/OAuth.ts");

// ─── Helpers ──────────────────────────────────────────────────────────────

// ctxRequest === undefined simulates a true internal call: getContext() itself
// returns undefined, which resolveAgentAuth(undefined) resolves to
// { kind: "internal" } (see resolve-agent-auth.test.ts). Any other value is
// wrapped as { request: ctxRequest } — the gate's actual shape.
function makeInstance<T>(Cls: any, ctxRequest: any | undefined): T {
  const r: any = new Cls();
  r.getContext = () => (ctxRequest === undefined ? undefined : { request: ctxRequest });
  return r as T;
}

const agentCtx = (agentId: string, isAdmin = false) => ({ tpsAgent: agentId, tpsAgentIsAdmin: isAdmin });
const anonCtx = () => ({ tpsAnonymous: true });

beforeEach(() => {
  workspaceStateRecords = [
    { id: "ws-1", agentId: "agent-alpha", timestamp: "2026-01-01T00:00:00.000Z", ref: "main" },
    { id: "ws-2", agentId: "agent-victim", timestamp: "2026-01-01T00:00:00.000Z", ref: "main" },
  ];
  orgEventRecords = [
    { id: "ev-1", authorId: "agent-alpha", kind: "status", summary: "x", createdAt: "2026-01-01T00:00:01.000Z", targetIds: [] },
  ];
  authCodePut = null;
});

// ─── WorkspaceLatest ────────────────────────────────────────────────────────

describe("WorkspaceLatest.get() — cross-agent isolation (fail-open cross-agent-read fix)", () => {
  it("agent requesting OWN id → allowed (reaches the query, not 403)", async () => {
    const ws = makeInstance<any>(WorkspaceLatest, agentCtx("agent-alpha"));
    const res = await ws.get("agent-alpha");
    expect(res).not.toBeInstanceOf(Response);
    expect(res.agentId).toBe("agent-alpha");
  });

  it("NECESSITY: agent requesting ANOTHER agent's id → 403 (MUST fail on unpatched main)", async () => {
    const ws = makeInstance<any>(WorkspaceLatest, agentCtx("agent-alpha"));
    const res = await ws.get("agent-victim");
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(403);
  });

  it("admin requesting another agent's id → allowed", async () => {
    const ws = makeInstance<any>(WorkspaceLatest, agentCtx("admin-1", true));
    const res = await ws.get("agent-victim");
    expect(res).not.toBeInstanceOf(Response);
    expect(res.agentId).toBe("agent-victim");
  });

  it("internal call (no request context) → allowed", async () => {
    const ws = makeInstance<any>(WorkspaceLatest, undefined);
    const res = await ws.get("agent-victim");
    expect(res).not.toBeInstanceOf(Response);
    expect(res.agentId).toBe("agent-victim");
  });

  it("anonymous → 403", async () => {
    const ws = makeInstance<any>(WorkspaceLatest, anonCtx());
    const res = await ws.get("agent-alpha");
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(403);
  });
});

// ─── OrgEventCatchup ────────────────────────────────────────────────────────

describe("OrgEventCatchup.get() — cross-agent isolation (fail-open cross-agent-read fix)", () => {
  const pathFor = (participantId: string) => ({
    id: participantId,
    conditions: [{ attribute: "since", value: "2020-01-01T00:00:00.000Z", comparator: "equals" }],
  });

  it("agent requesting OWN id → allowed (reaches the query, not 403)", async () => {
    const oe = makeInstance<any>(OrgEventCatchup, agentCtx("agent-alpha"));
    const res = await oe.get(pathFor("agent-alpha"));
    expect(res).not.toBeInstanceOf(Response);
    expect(Array.isArray(res)).toBe(true);
  });

  it("NECESSITY: agent requesting ANOTHER agent's id → 403 (MUST fail on unpatched main)", async () => {
    const oe = makeInstance<any>(OrgEventCatchup, agentCtx("agent-alpha"));
    const res = await oe.get(pathFor("agent-victim"));
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(403);
  });

  it("admin requesting another agent's id → allowed", async () => {
    const oe = makeInstance<any>(OrgEventCatchup, agentCtx("admin-1", true));
    const res = await oe.get(pathFor("agent-victim"));
    expect(res).not.toBeInstanceOf(Response);
    expect(Array.isArray(res)).toBe(true);
  });

  it("internal call (no request context) → allowed", async () => {
    const oe = makeInstance<any>(OrgEventCatchup, undefined);
    const res = await oe.get(pathFor("agent-victim"));
    expect(res).not.toBeInstanceOf(Response);
    expect(Array.isArray(res)).toBe(true);
  });

  it("anonymous → 403", async () => {
    const oe = makeInstance<any>(OrgEventCatchup, anonCtx());
    const res = await oe.get(pathFor("agent-alpha"));
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(403);
  });
});

// ─── OAuthAuthorize — resolved principal (identity spoof fix) ──────────────

describe("OAuthAuthorize.post() — resolved principal, not hardcoded admin (identity spoof fix)", () => {
  const approveBody = (extra: Record<string, any> = {}) => ({
    action: "approve",
    client_id: "cl1",
    redirect_uri: "https://claude.com/api/mcp/auth_callback",
    scope: "memory:read",
    state: "st1",
    code_challenge: "cc",
    code_challenge_method: "S256",
    ...extra,
  });

  it("approving principal is the authenticated agent (from the gate annotation, not a hardcoded 'admin')", async () => {
    const oa = makeInstance<any>(OAuthAuthorize, agentCtx("agent-alpha", false));
    const res = await oa.post(approveBody());
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(302);
    expect(authCodePut?.principalId).toBe("agent-alpha");
    expect(authCodePut?.principalId).not.toBe("admin");
  });

  it("Basic super_user resolves via resolveAgentAuth to agentId=username (not the hardcoded literal)", async () => {
    const oa: any = new (OAuthAuthorize as any)();
    oa.getContext = () => ({ user: { username: "admin", role: { permission: { super_user: true } } } });
    const res = await oa.post(approveBody());
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(302);
    // Coincidentally also "admin" here because the super_user's username IS
    // "admin" — the point is it's DERIVED from the authenticated user, not a
    // hardcoded fallback. See the next test for the case that tells them apart.
    expect(authCodePut?.principalId).toBe("admin");
  });

  it("a different super_user username is preserved (proves it's not a hardcoded literal)", async () => {
    const oa: any = new (OAuthAuthorize as any)();
    oa.getContext = () => ({ user: { username: "nathan-basic", role: { permission: { super_user: true } } } });
    await oa.post(approveBody());
    expect(authCodePut?.principalId).toBe("nathan-basic");
  });

  it("no resolvable principal (anonymous) → 401, no auth code minted (fail closed, not admin grant)", async () => {
    const oa = makeInstance<any>(OAuthAuthorize, anonCtx());
    const res = await oa.post(approveBody());
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(401);
    expect(authCodePut).toBeNull();
  });
});
