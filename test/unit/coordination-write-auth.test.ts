/**
 * coordination-write-auth.test.ts — Handler-level no-forge tests for the
 * coordination write surface (ops-wmgx / Kris #510).
 *
 * Exercises WorkspaceState.post() and OrgEvent.post() directly, mocking
 * @harperfast/harper so the resource classes load + their writes are capturable
 * outside a Harper runtime (same technique as resolve-agent-auth.test.ts). These
 * are the security-critical assertions the integration harness can't make at the
 * unit level:
 *
 *   - An authenticated agent's write is attributed to ITS OWN id (from the auth
 *     context, i.e. the verified Ed25519 signature).
 *   - NO FORGING: a body that names a DIFFERENT agent is ignored — the persisted
 *     record carries the authenticated agent's id, not the forged one.
 *   - Anonymous writes are rejected (401).
 *   - Admin may write on behalf of another agent (body honored).
 *
 * The auth verdict is injected via getContext().request.tpsAgent /
 * tpsAgentIsAdmin — exactly what the non-rejecting gate sets after verifying the
 * signature (see auth-middleware.ts) and what resolveAgentAuth() reads.
 */

import { mock, describe, it, expect, beforeEach } from "bun:test";

// Capture what each resource ultimately persists.
let workspacePut: any = null;
let orgEventPut: any = null;

// Mock @harperfast/harper:
//   - databases.flair.WorkspaceState / OrgEvent are constructable base classes
//     (the resources do `class X extends databases.flair.X`).
//   - The base post()/put() capture their argument so we can assert attribution.
//   - resolveAgentAuth (in agent-auth.ts) also imports databases; its agent path
//     calls Agent.get / Agent.search, but our tests use the tpsAgent annotation
//     path which returns before touching those — so a thin stub is enough.
class BaseWorkspaceState {
  async post(content: any) { workspacePut = content; return { ok: true, ...content }; }
  async put(content: any) { workspacePut = content; return { ok: true, ...content }; }
  async get(_id: any) { return null; }
  async search(q: any) { return q; }
  async delete(_id: any) { return { ok: true }; }
}
class BaseOrgEvent {
  async put(content: any) { orgEventPut = content; return { ok: true, ...content }; }
  async get(_id: any) { return null; }
  async delete(_id: any) { return { ok: true }; }
}

const databasesMock = {
  flair: {
    WorkspaceState: BaseWorkspaceState,
    OrgEvent: Object.assign(BaseOrgEvent, {
      // OrgEvent.post() calls `databases.flair.OrgEvent.put(content)` directly
      // (Harper-5 upsert), so the static put must capture too.
      put: async (content: any) => { orgEventPut = content; return { ok: true, ...content }; },
    }),
    Agent: { get: async () => null, search: async () => [] },
  },
};

mock.module("@harperfast/harper", () => ({ databases: databasesMock }));

const { WorkspaceState } = await import("../../resources/WorkspaceState.ts");
const { OrgEvent } = await import("../../resources/OrgEvent.ts");

// Build a resource instance whose getContext() returns the given auth context.
function makeWorkspace(ctxRequest: any) {
  const r: any = new (WorkspaceState as any)();
  r.getContext = () => ({ request: ctxRequest });
  return r;
}
function makeOrgEvent(ctxRequest: any) {
  const r: any = new (OrgEvent as any)();
  r.getContext = () => ({ request: ctxRequest });
  return r;
}

const agentCtx = (agentId: string, isAdmin = false) => ({ tpsAgent: agentId, tpsAgentIsAdmin: isAdmin });
const anonCtx = () => ({ tpsAnonymous: true });

beforeEach(() => {
  workspacePut = null;
  orgEventPut = null;
});

describe("WorkspaceState.post() — agent-self attribution (no forging)", () => {
  it("attributes the record to the authenticated agent (from signature, not body)", async () => {
    const ws = makeWorkspace(agentCtx("agent-alpha"));
    await ws.post({ ref: "main", provider: "cli" });
    expect(workspacePut.agentId).toBe("agent-alpha");
  });

  it("NO FORGING: body agentId naming a DIFFERENT agent is overwritten with the authenticated id", async () => {
    const ws = makeWorkspace(agentCtx("agent-alpha"));
    await ws.post({ agentId: "agent-victim", ref: "main", provider: "cli" });
    // The forged agentId must NOT survive — persisted record is the real agent.
    expect(workspacePut.agentId).toBe("agent-alpha");
    expect(workspacePut.agentId).not.toBe("agent-victim");
  });

  it("anonymous write → 401 (and nothing persisted)", async () => {
    const ws = makeWorkspace(anonCtx());
    const res = await ws.post({ agentId: "agent-alpha", ref: "main", provider: "cli" });
    expect((res as Response).status).toBe(401);
    expect(workspacePut).toBeNull();
  });

  it("admin may write on behalf of another agent (body agentId honored)", async () => {
    const ws = makeWorkspace(agentCtx("admin-1", true));
    await ws.post({ agentId: "agent-beta", ref: "main", provider: "cli" });
    expect(workspacePut.agentId).toBe("agent-beta");
  });
});

describe("OrgEvent.post() — agent-self attribution (no forging)", () => {
  it("attributes the event to the authenticated agent (from signature, not body)", async () => {
    const oe = makeOrgEvent(agentCtx("agent-alpha"));
    await oe.post({ kind: "status", summary: "alive" });
    expect(orgEventPut.authorId).toBe("agent-alpha");
  });

  it("NO FORGING: body authorId naming a DIFFERENT agent is overwritten with the authenticated id", async () => {
    const oe = makeOrgEvent(agentCtx("agent-alpha"));
    await oe.post({ authorId: "agent-victim", kind: "coord.claim", summary: "spoof attempt" });
    // The forged authorId must NOT survive — event is attributed to the real agent.
    expect(orgEventPut.authorId).toBe("agent-alpha");
    expect(orgEventPut.authorId).not.toBe("agent-victim");
  });

  it("anonymous write → 401 (and nothing persisted)", async () => {
    const oe = makeOrgEvent(anonCtx());
    const res = await oe.post({ authorId: "agent-alpha", kind: "status", summary: "x" });
    expect((res as Response).status).toBe(401);
    expect(orgEventPut).toBeNull();
  });

  it("admin may publish on behalf of another agent (body authorId honored)", async () => {
    const oe = makeOrgEvent(agentCtx("admin-1", true));
    await oe.post({ authorId: "agent-beta", kind: "status", summary: "x" });
    expect(orgEventPut.authorId).toBe("agent-beta");
  });

  it("generated id embeds the authenticated author (not the forged one)", async () => {
    const oe = makeOrgEvent(agentCtx("agent-alpha"));
    await oe.post({ authorId: "agent-victim", kind: "status", summary: "x" });
    expect(String(orgEventPut.id).startsWith("agent-alpha-")).toBe(true);
  });
});
