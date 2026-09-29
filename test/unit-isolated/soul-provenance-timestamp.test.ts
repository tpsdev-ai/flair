/**
 * soul-provenance-timestamp.test.ts — flair#1960 r2 direct timestamp
 * assertions for the Soul/AgentSeed provenance builder.
 *
 * `resources/soul-write-policy.ts`'s `soulProvenance()` wraps the shared
 * `buildProvenance` (resources/provenance.ts) and is the ONE builder both
 * `resources/Soul.ts` and `resources/AgentSeed.ts` use for their Soul writes.
 * This pins that `verified.timestamp` there is the SERVER write instant (never
 * the caller/`now` argument, which is only the creation-time CLAIM recorded
 * under `claimed.createdAt`), that `verified.*` is server-derived, and that the
 * `sourceClass` marker stays server-classified.
 *
 * Isolated: owns the harper mock for soul-write-policy.ts.
 */
import { describe, it, expect, mock } from "bun:test";

mock.module("harper", () => ({
  databases: { flair: {} },
  Resource: class {},
  server: { http: () => {}, getUser: async () => null },
}));

const { soulProvenance } = await import("../../resources/soul-write-policy.ts");

describe("flair#1960 r2 — Soul/AgentSeed provenance timestamps are server-derived", () => {
  it("verified.timestamp is the server clock, NOT the caller-supplied `now` (which is only claimed.createdAt)", () => {
    const before = Date.now();
    const past = "2001-01-01T00:00:00.000Z";
    const prov = JSON.parse(soulProvenance({ kind: "internal" } as any, "internal", past));
    expect(prov.v).toBe(1);
    expect(prov.verified.agentId).toBeNull();
    expect(prov.verified.timestamp).not.toBe(past);
    const stamped = Date.parse(prov.verified.timestamp);
    expect(stamped).toBeGreaterThanOrEqual(before - 5000);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 5000);
    // one clock read shared with receivedAt
    expect(prov.verified.timestamp).toBe(prov.verified.receivedAt);
    // the `now` argument is the claim, sanitized like the others
    expect(prov.claimed.createdAt).toBe(past);
  });

  it("keeps the server-classified sourceClass marker and never lets it leak into verified.agentId", () => {
    const prov = JSON.parse(soulProvenance({ kind: "agent", agentId: "agent-op", isAdmin: true } as any, "operator", "2026-07-18T00:00:00.000Z"));
    expect(prov.verified.sourceClass).toBe("operator");
    expect(prov.verified.agentId).toBe("agent-op");
  });
});
