import { describe, expect, it } from "bun:test";

function checkSoulWriteScope(authenticatedAgent: string, bodyAgentId: string, isAdmin: boolean): string | null {
  if (isAdmin) return null;
  if (!bodyAgentId || bodyAgentId === authenticatedAgent) return null;
  return "forbidden: cannot write another agent's soul";
}

function checkMemoryPutScope(authenticatedAgent: string, bodyAgentId: string, isAdmin: boolean): string | null {
  if (isAdmin) return null;
  if (!bodyAgentId || bodyAgentId === authenticatedAgent) return null;
  return "forbidden: cannot write memories for another agent";
}

function checkSoulReadScope(_authenticatedAgent: string, _soulOwner: string, _isAdmin: boolean): string | null {
  return null;
}

describe("auth scoping helpers", () => {
  it("blocks non-admin soul writes for another agent", () => {
    expect(checkSoulWriteScope("anvil", "flint", false)).toBe("forbidden: cannot write another agent's soul");
  });

  it("allows admin soul writes for another agent", () => {
    expect(checkSoulWriteScope("admin", "flint", true)).toBeNull();
  });

  it("blocks non-admin memory PUT for another agent", () => {
    expect(checkMemoryPutScope("anvil", "flint", false)).toBe("forbidden: cannot write memories for another agent");
  });

  it("allows cross-agent soul reads", () => {
    expect(checkSoulReadScope("anvil", "flint", false)).toBeNull();
  });
});
