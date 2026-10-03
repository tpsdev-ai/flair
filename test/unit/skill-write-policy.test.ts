/**
 * unit coverage for resources/skill-write-policy.ts — the flair#1741 skill-write
 * credential class. Role is not source: only verified Basic admin auth is the
 * operator class; an admin AGENT key (Ed25519/OAuth) stays an agent.
 */
import { describe, expect, test, mock } from "bun:test";

mock.module("harper", () => ({
  server: { http: () => {}, getUser: async () => null },
  databases: { flair: { Agent: { get: async () => null, search: async () => [] } } },
  Resource: class {},
}));

const { skillWriteSource, authorizeSkillVersionWrite } = await import("../../resources/skill-write-policy.ts");

const agent = (overrides: Record<string, unknown> = {}) => ({ kind: "agent", agentId: "a1", isAdmin: false, ...overrides }) as any;

describe("skillWriteSource", () => {
  test("a verified Basic administrator is the operator class", () => {
    const ctx = { request: { tpsAgent: "admin", tpsAgentIsAdmin: true, headers: new Headers({ authorization: "Basic xyz" }) } };
    expect(skillWriteSource(ctx, agent({ agentId: "admin", isAdmin: true }))).toBe("operator");
  });

  test("an admin AGENT key (Ed25519) stays an agent, never operator", () => {
    const ctx = { request: { tpsAgent: "a1", tpsAgentIsAdmin: true, headers: new Headers({ authorization: "TPS-Ed25519 a1:1:n:sig" }) } };
    expect(skillWriteSource(ctx, agent({ isAdmin: true }))).toBe("agent");
  });

  test("an admin AGENT key with an OAuth Bearer header stays an agent", () => {
    const ctx = { request: { tpsAgent: "a1", tpsAgentIsAdmin: true, headers: new Headers({ authorization: "Bearer token" }) } };
    expect(skillWriteSource(ctx, agent({ isAdmin: true }))).toBe("agent");
  });

  test("a non-admin verified agent is an agent", () => {
    const ctx = { request: { tpsAgent: "a1", tpsAgentIsAdmin: false, headers: new Headers({ authorization: "TPS-Ed25519 a1:1:n:sig" }) } };
    expect(skillWriteSource(ctx, agent())).toBe("agent");
  });

  test("a deliberate internal call is the internal class", () => {
    expect(skillWriteSource({ __flairInternal: true }, { kind: "internal" } as any)).toBe("internal");
  });

  test("a context-less internal call is NOT internal (needs the deliberate marker)", () => {
    expect(skillWriteSource({}, { kind: "internal" } as any)).toBeNull();
  });

  test("anonymous is refused", () => {
    expect(skillWriteSource({ request: {} }, { kind: "anonymous" } as any)).toBeNull();
  });
});

describe("authorizeSkillVersionWrite", () => {
  test("an admin agent key is authorized as an agent (authz retained, class corrected)", async () => {
    const ctx = { request: { tpsAgent: "a1", tpsAgentIsAdmin: true, headers: new Headers({ authorization: "TPS-Ed25519 a1:1:n:sig" }) } };
    const { source, denied } = await authorizeSkillVersionWrite(ctx);
    expect(denied).toBeNull();
    expect(source).toBe("agent");
  });

  test("anonymous is refused with 401", async () => {
    const { denied } = await authorizeSkillVersionWrite({ request: { headers: new Headers() } });
    expect(denied?.status).toBe(401);
  });
});
