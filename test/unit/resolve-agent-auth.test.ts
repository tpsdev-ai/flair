import { mock, describe, it, expect } from "bun:test";

// agent-auth.ts imports `databases` from @harperfast/harper, whose module chain
// throws when loaded outside a Harper runtime. Mock it — resolveAgentAuth's
// internal/anonymous paths never touch databases (they return before Agent.get).
mock.module("@harperfast/harper", () => ({ databases: {}, Resource: class {} }));

const { resolveAgentAuth } = await import("../../resources/agent-auth.ts");

// The internal-vs-anonymous distinction is the security-critical part: a missing
// request = trusted in-process call; a request with no valid agent = anonymous
// HTTP caller that MUST be denied. (The "agent" verdict needs a real Agent record
// + signature, covered in the integration harness.)

function reqWithAuth(header: string) {
  return { headers: { get: (n: string) => (n === "authorization" ? header : undefined) } };
}

describe("resolveAgentAuth — internal vs anonymous", () => {
  it("no request context → internal (trusted in-process call)", async () => {
    expect(await resolveAgentAuth(undefined)).toEqual({ kind: "internal" });
    expect(await resolveAgentAuth(null)).toEqual({ kind: "internal" });
  });

  it("request with NO Authorization header → anonymous (deny)", async () => {
    expect(await resolveAgentAuth(reqWithAuth(""))).toEqual({ kind: "anonymous" });
  });

  it("request with a non-TPS scheme → anonymous (deny)", async () => {
    expect(await resolveAgentAuth(reqWithAuth("Basic dXNlcjpwYXNz"))).toEqual({ kind: "anonymous" });
  });

  it("request with a malformed TPS-Ed25519 header → anonymous (deny)", async () => {
    expect(await resolveAgentAuth(reqWithAuth("TPS-Ed25519 garbage-no-colons"))).toEqual({ kind: "anonymous" });
  });
});

describe("resolveAgentAuth — gate annotations + context.user (handler phase)", () => {
  it("gate tpsAgent annotation → agent (handler path; no header re-verify needed)", async () => {
    expect(await resolveAgentAuth({ tpsAgent: "agent-1", tpsAgentIsAdmin: false }))
      .toEqual({ kind: "agent", agentId: "agent-1", isAdmin: false });
    expect(await resolveAgentAuth({ tpsAgent: "admin-1", tpsAgentIsAdmin: true }))
      .toEqual({ kind: "agent", agentId: "admin-1", isAdmin: true });
  });

  it("annotation reachable via context.request (the ctx.request ?? ctx fallback)", async () => {
    expect(await resolveAgentAuth({ request: { tpsAgent: "agent-2", tpsAgentIsAdmin: false } }))
      .toEqual({ kind: "agent", agentId: "agent-2", isAdmin: false });
  });

  it("explicit tpsAnonymous marker → anonymous (set by the non-rejecting gate)", async () => {
    expect(await resolveAgentAuth({ tpsAnonymous: true })).toEqual({ kind: "anonymous" });
  });

  it("per-agent context.user (de-elevated) → agent via username", async () => {
    expect(await resolveAgentAuth({ user: { username: "agent-3", role: { permission: {} } } }))
      .toEqual({ kind: "agent", agentId: "agent-3", isAdmin: false });
  });

  it("super_user context.user → admin agent", async () => {
    const v = await resolveAgentAuth({ user: { username: "admin", role: { permission: { super_user: true } } } });
    expect(v.kind).toBe("agent");
    expect((v as any).isAdmin).toBe(true);
  });

  it("shared flair-agent user with no other signal → internal (not mistaken for an agent)", async () => {
    expect(await resolveAgentAuth({ user: { username: "flair-agent", role: { permission: {} } } }))
      .toEqual({ kind: "internal" });
  });
});
