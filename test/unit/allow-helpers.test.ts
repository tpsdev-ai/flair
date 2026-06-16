import { mock, describe, it, expect } from "bun:test";

// agent-auth.ts imports `databases` from @harperfast/harper (throws outside a
// Harper runtime). Mock it — the annotation/internal/anonymous paths exercised
// here never reach databases (they return before any Agent.get).
mock.module("@harperfast/harper", () => ({ databases: {} }));

const { allowVerified, allowAdmin } = await import("../../resources/agent-auth.ts");

// Belt-and-suspenders for auth: the two allow* helpers every agent-facing /
// admin-only resource delegates to. resolveAgentAuth's verdict logic is covered
// in resolve-agent-auth.test.ts; here we pin the AUTHORIZATION truth table the
// resources actually depend on — especially that admin-only (allowAdmin) DENIES a
// non-admin agent (privilege-escalation guard) and that BOTH deny anonymous.

const reqNoAuth = { headers: { get: () => undefined } };

const CONTEXTS = {
  internal:          undefined,                                              // no request → trusted in-process
  anonymousMarker:   { tpsAnonymous: true },                                 // non-rejecting gate marked it anon
  anonymousNoAuth:   reqNoAuth,                                              // raw request, no valid agent
  agentNonAdmin:     { tpsAgent: "agent-x", tpsAgentIsAdmin: false },        // verified non-admin agent
  agentAdmin:        { tpsAgent: "admin-x", tpsAgentIsAdmin: true },         // verified admin agent
  superUser:         { user: { username: "admin", role: { permission: { super_user: true } } } }, // Basic super_user
  perAgentUser:      { user: { username: "agent-y", role: { permission: {} } } }, // de-elevated per-agent user
} as const;

describe("allowVerified — agent-facing gate (deny anonymous, permit verified/admin/internal)", () => {
  it("permits trusted internal calls", async () => {
    expect(await allowVerified(CONTEXTS.internal)).toBe(true);
  });
  it("DENIES anonymous (explicit marker)", async () => {
    expect(await allowVerified(CONTEXTS.anonymousMarker)).toBe(false);
  });
  it("DENIES anonymous (request with no valid agent)", async () => {
    expect(await allowVerified(CONTEXTS.anonymousNoAuth)).toBe(false);
  });
  it("permits a verified non-admin agent", async () => {
    expect(await allowVerified(CONTEXTS.agentNonAdmin)).toBe(true);
  });
  it("permits a verified admin agent", async () => {
    expect(await allowVerified(CONTEXTS.agentAdmin)).toBe(true);
  });
  it("permits Basic super_user", async () => {
    expect(await allowVerified(CONTEXTS.superUser)).toBe(true);
  });
  it("permits a de-elevated per-agent user", async () => {
    expect(await allowVerified(CONTEXTS.perAgentUser)).toBe(true);
  });
});

describe("allowAdmin — admin-only gate (deny anonymous AND non-admin agents)", () => {
  it("permits trusted internal calls", async () => {
    expect(await allowAdmin(CONTEXTS.internal)).toBe(true);
  });
  it("DENIES anonymous (explicit marker)", async () => {
    expect(await allowAdmin(CONTEXTS.anonymousMarker)).toBe(false);
  });
  it("DENIES anonymous (request with no valid agent)", async () => {
    expect(await allowAdmin(CONTEXTS.anonymousNoAuth)).toBe(false);
  });
  it("DENIES a verified NON-admin agent (privilege-escalation guard)", async () => {
    expect(await allowAdmin(CONTEXTS.agentNonAdmin)).toBe(false);
  });
  it("DENIES a de-elevated per-agent (non-admin) user", async () => {
    expect(await allowAdmin(CONTEXTS.perAgentUser)).toBe(false);
  });
  it("permits a verified admin agent", async () => {
    expect(await allowAdmin(CONTEXTS.agentAdmin)).toBe(true);
  });
  it("permits Basic super_user", async () => {
    expect(await allowAdmin(CONTEXTS.superUser)).toBe(true);
  });
});
