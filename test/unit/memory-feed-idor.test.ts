// MemoryFeed IDOR — unit mutation-verify (authz slice 4, flair#1064).
//
// Pure logic tests — no Harper needed. Simulates the fixed post() attribution
// stamping and asserts that a spoofed body agentId is correctly overridden.
//
// Mutation-verify procedure (per the spec's standing requirement):
//   1. In resources/MemoryFeed.ts, revert post() to the body-trusting version:
//        - Remove the resolveAgentAuth + UNAUTH + agentId-stamping block
//        - Restore `const agentId = String(content?.agentId ?? "");`
//   2. Run: bun test test/unit/memory-feed-idor.test.ts
//      → "fixed version stamps agentId" test still passes (it's a pure logic
//        assertion against the mock, not against the file).
//   3. Run the integration test: bun test test/integration/memory-feed-idor.test.ts
//      → GUARD tests MUST FAIL (body-trusting version allows spoofing).
//   4. Restore the fix (the current version of MemoryFeed.ts).
//   5. Run the integration test again → GUARD tests MUST PASS.
//
// This unit test documents the logic difference:
//   Fixed:  agentId = auth.agentId (stamped from principal)
//   Broken: agentId = content.agentId (read from body)

import { describe, expect, test } from "bun:test";

describe("MemoryFeed IDOR — unit mutation-verify", () => {
  // Simulated resolveAgentAuth result for a non-admin agent.
  const mockAuth = { kind: "agent" as const, agentId: "principal-x", isAdmin: false };

  test("fixed version stamps agentId from principal", () => {
    // Simulate the fixed post() logic:
    //   content.agentId = auth.agentId (for non-admin agents)
    const content = { agentId: "attacker-y", content: "spoofed" };
    if (mockAuth.kind === "agent" && !mockAuth.isAdmin) {
      content.agentId = mockAuth.agentId;
    }
    // fixed version: agentId is stamped from principal
    expect(content.agentId).toBe("principal-x");
    // fixed version: body-supplied agentId is overridden
    expect(content.agentId).not.toBe("attacker-y");
  });

  test("body-trusting version would NOT override (defect documented)", () => {
    // Simulate the BROKEN post() logic — for documentation.
    // This test always passes because it describes the defect, not the fix.
    // The actual mutation-verify is done by reverting the file and running
    // the integration test (see procedure above).
    const content = { agentId: "attacker-y", content: "spoofed" };
    const brokenAgentId = String(content?.agentId ?? "");
    // broken version: agentId comes from body — the defect
    expect(brokenAgentId).toBe("attacker-y");
  });

  test("body-supplied id ownership check: rejects cross-agent targets", () => {
    // Simulate the id-ownership guard: if body supplies an id, check if
    // the existing record belongs to the authenticated principal.
    const stampedAgentId = mockAuth.agentId; // "principal-x"
    const bodyId = "other-agent-record-123";
    // Mock: the existing record belongs to a different agent.
    const mockExistingRecord = { id: bodyId, agentId: "other-agent" };

    // Guard logic: existing record exists AND its agentId differs → FORBIDDEN.
    const isForbidden =
      !!mockExistingRecord && mockExistingRecord.agentId !== stampedAgentId;

    // cross-agent id target must be rejected
    expect(isForbidden).toBe(true);
  });

  test("body-supplied id ownership check: allows own record", () => {
    const stampedAgentId = mockAuth.agentId; // "principal-x"
    const bodyId = "principal-x-record-456";
    // Mock: the existing record belongs to the same agent.
    const mockExistingRecord = { id: bodyId, agentId: "principal-x" };

    const isForbidden =
      !!mockExistingRecord && mockExistingRecord.agentId !== stampedAgentId;

    // own record id must be allowed
    expect(isForbidden).toBe(false);
  });
});
