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

/**
 * Returns 403 message if agent tries to read another agent's PRIVATE memory,
 * null otherwise (within-org-read-open — mirrors resources/memory-read-
 * scope.ts's resolveReadScope().isAllowed()). Originally (the original
 * grant-gated read model) this also required a MemoryGrant for any
 * cross-agent read of a non-private memory; that grant gate is GONE now —
 * see resources/memory-read-scope.ts's module doc for the full model
 * (Kern-approved security-boundary change). `private` is the ONLY remaining
 * owner-only exception; `shared` or a no-visibility-field (legacy) record is
 * readable by ANY verified agent, no grant needed. (Not to be confused with
 * the UNRELATED, earlier `visibility === "office"` global bypass — the
 * office-visibility read leak — that was an accidental leak fixed by the
 * grant-gated model; this is a deliberate, later design decision that
 * supersedes the grant gate itself.)
 */
function checkMemoryReadScope(
  authenticatedAgent: string,
  memoryOwner: string,
  memoryVisibility: string | undefined,
  isAdmin: boolean,
): string | null {
  if (isAdmin) return null;
  if (memoryOwner === authenticatedAgent) return null;
  if (memoryVisibility === "private") return `forbidden: cannot read memory owned by ${memoryOwner}`;
  return null;
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
  it("allows reading own memory, any visibility (even private)", () => {
    expect(checkMemoryReadScope("anvil", "anvil", "standard", false)).toBeNull();
    expect(checkMemoryReadScope("anvil", "anvil", "private", false)).toBeNull();
  });

  it("within-org-read-open: reading another agent's SHARED memory is allowed — no grant needed at all", () => {
    expect(checkMemoryReadScope("anvil", "flint", "shared", false)).toBeNull();
  });

  it("within-org-read-open: reading another agent's memory with NO visibility field is allowed (migration invariant: absent reads as non-private)", () => {
    expect(checkMemoryReadScope("anvil", "flint", undefined, false)).toBeNull();
  });

  it("blocks reading another agent's PRIVATE memory — the ONE remaining private-exclusion invariant", () => {
    const err = checkMemoryReadScope("anvil", "flint", "private", false);
    expect(err).not.toBeNull();
    expect(err).toContain("flint");
  });

  it("within-org-read-open: another agent's 'standard'-durability memory (no visibility field) is readable too — durability only affects the WRITE-time default, not read scoping", () => {
    expect(checkMemoryReadScope("anvil", "flint", "standard", false)).toBeNull();
  });

  it("allows admin to read any memory, including another agent's private one", () => {
    expect(checkMemoryReadScope("admin", "flint", "standard", true)).toBeNull();
    expect(checkMemoryReadScope("admin", "flint", "private", true)).toBeNull();
  });

  it("kern reading sherlock's memory (no grant relationship at all) is allowed unless it's private", () => {
    expect(checkMemoryReadScope("kern", "sherlock", undefined, false)).toBeNull();
    const err = checkMemoryReadScope("kern", "sherlock", "private", false);
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

  it("within-org-read-open: a SHARED memory is readable by every other agent on the instance, no grant needed — but a PRIVATE one never is", () => {
    for (const reader of ["anvil", "flint", "kern", "pulse", "sherlock"]) {
      if (reader === "flint") continue; // owner reading its own — not a cross-agent case
      expect(checkMemoryReadScope(reader, "flint", "shared", false)).toBeNull();
      expect(checkMemoryReadScope(reader, "flint", "private", false)).not.toBeNull();
    }
  });

  it("a standard-durability memory with no visibility field is readable org-wide too — only an explicit 'private' visibility gates a cross-agent read", () => {
    for (const reader of ["anvil", "kern", "pulse", "sherlock"]) {
      expect(checkMemoryReadScope(reader, "flint", "standard", false)).toBeNull();
    }
  });
});

// ── Collection search scoping helpers (mirrors Memory.search / WorkspaceState.search) ──

/**
 * Simulates the agentId injection logic in Memory.search() and
 * WorkspaceState.search() without actually calling Harper.
 *
 * Returns the effective conditions that would be passed to super.search().
 */
function buildScopedSearchConditions(
  authAgent: string | undefined,
  isAdminAgent: boolean,
  grantedOwners: string[],
  userQuery: any,
): { filtered: boolean; allowedOwners?: string[]; query?: any } {
  if (!authAgent || isAdminAgent) {
    return { filtered: false };
  }

  const allowedOwners = [authAgent, ...grantedOwners];

  const agentIdCondition =
    allowedOwners.length === 1
      ? { attribute: "agentId", comparator: "equals", value: allowedOwners[0] }
      : allowedOwners.map((id, i) => {
          const cond = { attribute: "agentId", comparator: "equals", value: id };
          return i === 0 ? cond : ["or", cond];
        });

  let scopedQuery: any;
  if (!userQuery || (Array.isArray(userQuery) && userQuery.length === 0)) {
    scopedQuery = Array.isArray(agentIdCondition) ? agentIdCondition : [agentIdCondition];
  } else {
    scopedQuery = { conditions: [agentIdCondition], and: userQuery };
  }

  return { filtered: true, allowedOwners, query: scopedQuery };
}

describe("Memory.search() / WorkspaceState.search() — collection scoping", () => {
  it("unfiltered for admin agents", () => {
    const r = buildScopedSearchConditions("admin", true, [], undefined);
    expect(r.filtered).toBe(false);
  });

  it("unfiltered when no auth context (internal call)", () => {
    const r = buildScopedSearchConditions(undefined, false, [], undefined);
    expect(r.filtered).toBe(false);
  });

  it("scoped to own agentId for non-admin with no grants", () => {
    const r = buildScopedSearchConditions("anvil", false, [], undefined);
    expect(r.filtered).toBe(true);
    expect(r.allowedOwners).toEqual(["anvil"]);
    // Single-owner condition is a plain object
    expect(Array.isArray(r.query)).toBe(true);
    expect(JSON.stringify(r.query)).toContain("anvil");
  });

  it("includes granted owners in allowed set", () => {
    const r = buildScopedSearchConditions("kern", false, ["flint", "anvil"], undefined);
    expect(r.filtered).toBe(true);
    expect(r.allowedOwners).toEqual(["kern", "flint", "anvil"]);
    expect(JSON.stringify(r.query)).toContain("flint");
    expect(JSON.stringify(r.query)).toContain("anvil");
  });

  it("wraps user query in outer and (injection prevention)", () => {
    const userQ = [{ attribute: "type", comparator: "equals", value: "lesson" }];
    const r = buildScopedSearchConditions("anvil", false, [], userQ);
    expect(r.filtered).toBe(true);
    // Result must be an object with both conditions and and fields
    expect(r.query).toHaveProperty("conditions");
    expect(r.query).toHaveProperty("and");
    // agentId condition is at top level — user query is nested under and
    expect(JSON.stringify(r.query.conditions)).toContain("anvil");
    expect(r.query.and).toEqual(userQ);
  });

  it("boolean injection cannot escape agentId scope", () => {
    // Attacker tries to pass an "or all" user query — must be trapped under and
    const attackerQuery = [
      { attribute: "agentId", comparator: "equals", value: "attacker" },
      "or",
      { attribute: "id", comparator: "starts_with", value: "" },
    ];
    const r = buildScopedSearchConditions("attacker", false, [], attackerQuery);
    expect(r.filtered).toBe(true);
    // The malicious query is nested under .and — it cannot affect the outer agentId filter
    expect(r.query).toHaveProperty("conditions");
    expect(r.query).toHaveProperty("and");
    expect(r.query.and).toEqual(attackerQuery);
    // Top-level conditions only contain attacker's own agentId constraint
    expect(JSON.stringify(r.query.conditions)).toContain("attacker");
    expect(JSON.stringify(r.query.conditions)).not.toContain("starts_with");
  });

  // URL-param-to-conditions translation has been removed from Memory.search() in
  // favor of search_by_conditions. The paramsToConditions helper and its test
  // are no longer relevant.
});

describe("SQL/GraphQL endpoint blocking (non-admin)", () => {
  function checkRawEndpoint(pathname: string, isAdminAgent: boolean): string | null {
    if (isAdminAgent) return null;
    const lower = pathname.toLowerCase();
    if (
      lower === "/sql" || lower.startsWith("/sql/") ||
      lower === "/graphql" || lower.startsWith("/graphql/")
    ) {
      return "forbidden: raw query endpoints require admin access";
    }
    return null;
  }

  it("blocks /sql for non-admin", () => {
    expect(checkRawEndpoint("/sql", false)).not.toBeNull();
    expect(checkRawEndpoint("/SQL", false)).not.toBeNull();
  });

  it("blocks /graphql for non-admin", () => {
    expect(checkRawEndpoint("/graphql", false)).not.toBeNull();
    expect(checkRawEndpoint("/GraphQL", false)).not.toBeNull();
  });

  it("blocks /sql/query subpath for non-admin", () => {
    expect(checkRawEndpoint("/sql/execute", false)).not.toBeNull();
  });

  it("allows admin to access raw endpoints", () => {
    expect(checkRawEndpoint("/sql", true)).toBeNull();
    expect(checkRawEndpoint("/graphql", true)).toBeNull();
  });

  it("does not block regular resource endpoints", () => {
    for (const path of ["/Memory", "/Memory/abc", "/Soul", "/WorkspaceState"]) {
      expect(checkRawEndpoint(path, false)).toBeNull();
    }
  });
});
