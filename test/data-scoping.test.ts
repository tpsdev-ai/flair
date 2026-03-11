/**
 * data-scoping.test.ts — Unit tests for agent-level data scoping logic
 *
 * Tests the scoping rules without spinning up a full Harper instance.
 * Validates the guard conditions that the middleware and resources enforce.
 */
import { describe, expect, it } from "bun:test";

// ── Scoping rule helpers (mirrors auth-middleware logic) ───────────────────────

/** Returns 403 message if agent tries to access another agent's data, null if allowed */
function checkAgentScope(
  authenticatedAgent: string,
  requestedAgent: string,
  isAdmin: boolean,
): string | null {
  if (isAdmin) return null;
  if (!requestedAgent) return null; // no agentId in body — resource validates
  if (requestedAgent === authenticatedAgent) return null;
  return "forbidden: agentId must match authenticated agent";
}

/** Returns 403 message if agent tries to read another agent's memory without grant */
function checkMemoryReadScope(
  authenticatedAgent: string,
  memoryOwner: string,
  memoryVisibility: string | undefined,
  hasGrant: boolean,
  isAdmin: boolean,
): string | null {
  if (isAdmin) return null;
  if (memoryOwner === authenticatedAgent) return null;
  if (memoryVisibility === "office") return null;
  if (hasGrant) return null;
  return `forbidden: cannot read memory owned by ${memoryOwner}`;
}

/** Soul reads are open to authenticated agents for cross-team coordination */
function checkSoulReadScope(
  _authenticatedAgent: string,
  _soulOwner: string,
  _isAdmin: boolean,
): string | null {
  return null;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("checkAgentScope (SemanticSearch / BootstrapMemories / Memory POST)", () => {
  it("allows own agentId", () => {
    expect(checkAgentScope("anvil", "anvil", false)).toBeNull();
  });

  it("blocks cross-agent access for non-admin", () => {
    const err = checkAgentScope("anvil", "flint", false);
    expect(err).not.toBeNull();
    expect(err).toContain("forbidden");
  });

  it("allows admin to access any agent", () => {
    expect(checkAgentScope("admin", "flint", true)).toBeNull();
    expect(checkAgentScope("admin", "anvil", true)).toBeNull();
  });

  it("allows missing agentId (resource validates separately)", () => {
    expect(checkAgentScope("anvil", "", false)).toBeNull();
  });

  it("blocks sherlock reading flint's memories via SemanticSearch", () => {
    const err = checkAgentScope("sherlock", "flint", false);
    expect(err).not.toBeNull();
    expect(err).toContain("forbidden");
  });
});

describe("checkMemoryReadScope (Memory GET by ID)", () => {
  it("allows reading own memory", () => {
    expect(checkMemoryReadScope("anvil", "anvil", "standard", false, false)).toBeNull();
  });

  it("allows reading office-wide memory", () => {
    expect(checkMemoryReadScope("anvil", "flint", "office", false, false)).toBeNull();
  });

  it("allows reading with MemoryGrant", () => {
    expect(checkMemoryReadScope("anvil", "flint", "standard", true, false)).toBeNull();
  });

  it("blocks reading another agent's standard memory without grant", () => {
    const err = checkMemoryReadScope("anvil", "flint", "standard", false, false);
    expect(err).not.toBeNull();
    expect(err).toContain("flint");
  });

  it("allows admin to read any memory", () => {
    expect(checkMemoryReadScope("admin", "flint", "standard", false, true)).toBeNull();
  });

  it("blocks kern reading sherlock's private memory", () => {
    const err = checkMemoryReadScope("kern", "sherlock", undefined, false, false);
    expect(err).not.toBeNull();
    expect(err).toContain("sherlock");
  });
});

describe("checkSoulReadScope (Soul GET)", () => {
  it("allows reading own soul", () => {
    expect(checkSoulReadScope("flint", "flint", false)).toBeNull();
  });

  it("allows reading another agent's soul", () => {
    expect(checkSoulReadScope("anvil", "flint", false)).toBeNull();
  });

  it("allows admin to read any soul", () => {
    expect(checkSoulReadScope("admin", "flint", true)).toBeNull();
    expect(checkSoulReadScope("admin", "ember", true)).toBeNull();
  });
});

describe("cross-agent scoping scenarios", () => {
  it("Pulse on remote VM cannot bootstrap as flint", () => {
    const err = checkAgentScope("pulse", "flint", false);
    expect(err).not.toBeNull();
  });

  it("Pulse can bootstrap as itself", () => {
    expect(checkAgentScope("pulse", "pulse", false)).toBeNull();
  });

  it("office memory is public to all agents", () => {
    for (const reader of ["anvil", "flint", "kern", "pulse", "sherlock"]) {
      expect(checkMemoryReadScope(reader, "flint", "office", false, false)).toBeNull();
    }
  });

  it("standard memory requires ownership or grant", () => {
    for (const reader of ["anvil", "kern", "pulse", "sherlock"]) {
      // Without grant
      const err = checkMemoryReadScope(reader, "flint", "standard", false, false);
      expect(err).not.toBeNull();
      // With grant
      expect(checkMemoryReadScope(reader, "flint", "standard", true, false)).toBeNull();
    }
  });
});
