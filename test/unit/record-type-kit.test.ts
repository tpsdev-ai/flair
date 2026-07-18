/**
 * record-type-kit.test.ts — unit coverage for resources/record-type-kit.ts
 * (record-types slice 1: kit extraction, flair#520).
 *
 * These tests exercise the KIT'S OWN parameterized primitives in isolation
 * (auth-gate dispatch, both read-scope modes, the by-id 404-never-403 read
 * gate, and every stampAttribution idiom) — NOT full resource-class
 * behavior. The five converted resource classes (Memory, Relationship,
 * WorkspaceState, OrgEvent, Soul) keep their own existing behavior tests
 * (relationship-read-gate.test.ts, memory-soul-read-gate.test.ts, etc.)
 * UNCHANGED as the acceptance bar for byte-identical runtime behavior; this
 * file is the kit-level complement, pinning the shared primitives those
 * classes now compose.
 *
 * Same mocking technique as allow-helpers.test.ts / relationship-read-
 * gate.test.ts: mock @harperfast/harper so record-type-kit.ts (which
 * transitively imports agent-auth.ts / memory-read-scope.ts / provenance.ts)
 * loads outside a real Harper runtime.
 */
import { describe, it, expect, mock } from "bun:test";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";

const databasesMock = {
  flair: {
    Agent: { get: async () => null, search: async () => [] },
    MemoryGrant: { search: () => (async function* () {})() },
  },
};

mock.module("@harperfast/harper", () => ({ databases: databasesMock, Resource: class {} }));

const {
  makeAuthGate,
  makeReadScope,
  makeByIdReadGate,
  resolveAuthGate,
  stampAttribution,
  buildProvenance,
  FORBIDDEN,
  UNAUTH,
  NOT_FOUND,
} = await import("../../resources/record-type-kit.ts");
const { buildProvenance: buildProvenanceDirect } = await import("../../resources/provenance.ts");

const agentCtx = (agentId: string, isAdmin = false) => ({ tpsAgent: agentId, tpsAgentIsAdmin: isAdmin });
const anonCtx = () => ({ tpsAnonymous: true });

// ─── Canonical response builders ───────────────────────────────────────────

describe("record-type-kit canonical error responses", () => {
  it("FORBIDDEN → 403 with the given message", async () => {
    const res = FORBIDDEN("nope");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "nope" });
  });

  it("UNAUTH → 401 with the standard body", async () => {
    const res = UNAUTH();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "authentication required" });
  });

  it("NOT_FOUND → 404 with the standard body", async () => {
    const res = NOT_FOUND();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});

// ─── Provenance wiring ──────────────────────────────────────────────────────

describe("record-type-kit re-exports buildProvenance unmodified", () => {
  it("is the exact same function reference as provenance.ts's export — not a wrapper", () => {
    expect(buildProvenance).toBe(buildProvenanceDirect);
  });
});

// ─── (a) makeAuthGate ───────────────────────────────────────────────────────

describe("makeAuthGate() — the allowRead() gate every table hand-wrote identically", () => {
  it("denies anonymous", async () => {
    const allowRead = makeAuthGate();
    const self = { getContext: () => ({ request: anonCtx() }) };
    expect(await allowRead.call(self)).toBe(false);
  });

  it("allows a verified non-admin agent", async () => {
    const allowRead = makeAuthGate();
    const self = { getContext: () => ({ request: agentCtx("agent-1") }) };
    expect(await allowRead.call(self)).toBe(true);
  });

  it("allows a verified admin agent", async () => {
    const allowRead = makeAuthGate();
    const self = { getContext: () => ({ request: agentCtx("agent-admin", true) }) };
    expect(await allowRead.call(self)).toBe(true);
  });

  it("allows a trusted internal call (no request context)", async () => {
    const allowRead = makeAuthGate();
    const self = { getContext: () => undefined };
    expect(await allowRead.call(self)).toBe(true);
  });
});

// ─── (b) makeReadScope ──────────────────────────────────────────────────────

describe("makeReadScope('owner-only') — the Relationship.ts/WorkspaceState.ts model", () => {
  it("condition scopes on ownerField (defaults to agentId)", async () => {
    const readScope = makeReadScope("owner-only");
    const scope = await readScope("agent-1");
    expect(scope.condition).toEqual({ attribute: "agentId", comparator: "equals", value: "agent-1" });
  });

  it("condition honors a non-default ownerField (forward-compat parameterization, e.g. authorId)", async () => {
    const readScope = makeReadScope("owner-only", "authorId");
    const scope = await readScope("agent-1");
    expect(scope.condition).toEqual({ attribute: "authorId", comparator: "equals", value: "agent-1" });
  });

  it("isAllowed is true only for the reader's own record — no visibility exception", async () => {
    const readScope = makeReadScope("owner-only");
    const scope = await readScope("agent-1");
    expect(scope.isAllowed({ agentId: "agent-1" })).toBe(true);
    expect(scope.isAllowed({ agentId: "agent-2" })).toBe(false);
    // Unlike open-within-org, a stranger's record is denied REGARDLESS of visibility.
    expect(scope.isAllowed({ agentId: "agent-2", visibility: "shared" })).toBe(false);
  });

  it("isAllowed is false for a null/undefined record (no existence oracle)", async () => {
    const readScope = makeReadScope("owner-only");
    const scope = await readScope("agent-1");
    expect(scope.isAllowed(null)).toBe(false);
    expect(scope.isAllowed(undefined)).toBe(false);
  });
});

// ─── makeReadScope's .mode/.ownerField tagging (record-types slice 2, flair#520) ──
//
// Pins the returned resolver's own construction parameters as introspectable
// own-properties, independent of any resource class or registry. See
// makeReadScope's doc in record-type-kit.ts for why this exists: it lets a
// future single-resource-file test assert `<table>ReadScope.mode ===
// RECORD_TYPES.<Table>.readScope` directly. test/unit/record-types-
// registry.test.ts's own drift tripwire uses a source-text scan instead (see
// that file's header) to avoid a cross-file Harper-mock module-cache
// collision, so this tagging is exercised here at the primitive level only.

describe("makeReadScope() — returned resolver is tagged with .mode/.ownerField", () => {
  it("'owner-only' tags .mode and the (defaulted) .ownerField", () => {
    const readScope = makeReadScope("owner-only");
    expect(readScope.mode).toBe("owner-only");
    expect(readScope.ownerField).toBe("agentId");
  });

  it("'owner-only' with an explicit ownerField tags that field (e.g. OrgEvent's authorId)", () => {
    const readScope = makeReadScope("owner-only", "authorId");
    expect(readScope.mode).toBe("owner-only");
    expect(readScope.ownerField).toBe("authorId");
  });

  it("'open-within-org' tags .mode; .ownerField reflects the passed-in value even though the resolver ignores it functionally", () => {
    const readScope = makeReadScope("open-within-org");
    expect(readScope.mode).toBe("open-within-org");
    expect(readScope.ownerField).toBe("agentId");
  });

  it("the tagged resolver is still callable — tagging never changes runtime behavior", async () => {
    const readScope = makeReadScope("owner-only", "authorId");
    const scope = await readScope("agent-1");
    expect(scope.condition).toEqual({ attribute: "authorId", comparator: "equals", value: "agent-1" });
  });
});

describe("makeReadScope('open-within-org') — delegates to the EXACT memory-read-scope.ts resolveReadScope", () => {
  it("condition is the OR(own agentId, visibility != private) shape", async () => {
    const readScope = makeReadScope("open-within-org");
    const scope = await readScope("agent-1");
    expect(scope.condition.operator).toBe("or");
    expect(scope.condition.conditions).toEqual([
      { attribute: "agentId", comparator: "equals", value: "agent-1" },
      { attribute: "visibility", comparator: "not_equal", value: "private" },
    ]);
  });

  it("isAllowed: own record, ANY visibility (including private)", async () => {
    const readScope = makeReadScope("open-within-org");
    const scope = await readScope("agent-1");
    expect(scope.isAllowed({ agentId: "agent-1", visibility: "private" })).toBe(true);
    expect(scope.isAllowed({ agentId: "agent-1", visibility: "shared" })).toBe(true);
  });

  it("isAllowed: another agent's non-private record is allowed (org-open)", async () => {
    const readScope = makeReadScope("open-within-org");
    const scope = await readScope("agent-1");
    expect(scope.isAllowed({ agentId: "agent-2", visibility: "shared" })).toBe(true);
  });

  it("isAllowed: the no-visibility-field migration invariant — a legacy record (no visibility field) reads as non-private", async () => {
    const readScope = makeReadScope("open-within-org");
    const scope = await readScope("agent-1");
    expect(scope.isAllowed({ agentId: "agent-2" })).toBe(true);
    expect(scope.isAllowed({ agentId: "agent-2", visibility: undefined })).toBe(true);
  });

  it("isAllowed: another agent's PRIVATE record is denied — the one owner-only exception", async () => {
    const readScope = makeReadScope("open-within-org");
    const scope = await readScope("agent-1");
    expect(scope.isAllowed({ agentId: "agent-2", visibility: "private" })).toBe(false);
  });
});

// ─── makeByIdReadGate ───────────────────────────────────────────────────────

describe("makeByIdReadGate — 404-never-403 by-id read gate (owner-only mode)", () => {
  const store = new Map<string, any>([["rec-1", { id: "rec-1", agentId: "owner" }]]);
  const superGet = async (t: any) => store.get(typeof t === "string" ? t : t?.id) ?? null;

  function makeSelf(ctxRequest: any, searchImpl?: (q: any) => any) {
    return {
      getContext: () => ({ request: ctxRequest }),
      search: mock(searchImpl ?? ((q: any) => ({ __searchCalledWith: q }))),
    };
  }

  it("a falsy or isCollection target delegates to this.search() — never touches superGet", async () => {
    const gate = makeByIdReadGate(makeReadScope("owner-only"));
    const self = makeSelf(agentCtx("owner"));
    await gate.call(self, { isCollection: true, conditions: [] }, superGet);
    expect(self.search).toHaveBeenCalledTimes(1);

    await gate.call(self, undefined, superGet);
    expect(self.search).toHaveBeenCalledTimes(2);
  });

  it("anonymous → 404, never 403 (no existence confirmation)", async () => {
    const gate = makeByIdReadGate(makeReadScope("owner-only"));
    const self = makeSelf(anonCtx());
    const res: any = await gate.call(self, "rec-1", superGet);
    expect(res instanceof Response).toBe(true);
    expect(res.status).toBe(404);
  });

  it("internal call (no request context) → unfiltered via superGet", async () => {
    const gate = makeByIdReadGate(makeReadScope("owner-only"));
    const self = { getContext: () => undefined, search: mock(() => null) };
    const res: any = await gate.call(self, "rec-1", superGet);
    expect(res).toEqual({ id: "rec-1", agentId: "owner" });
  });

  it("admin agent → unfiltered via superGet, no ownership check", async () => {
    const gate = makeByIdReadGate(makeReadScope("owner-only"));
    const self = makeSelf(agentCtx("agent-admin", true));
    const res: any = await gate.call(self, "rec-1", superGet);
    expect(res).toEqual({ id: "rec-1", agentId: "owner" });
  });

  it("non-admin owner → returns the real record", async () => {
    const gate = makeByIdReadGate(makeReadScope("owner-only"));
    const self = makeSelf(agentCtx("owner"));
    const res: any = await gate.call(self, "rec-1", superGet);
    expect(res).toEqual({ id: "rec-1", agentId: "owner" });
  });

  it("non-admin non-owner → 404, not 403 (can't be used to enumerate other agents' ids)", async () => {
    const gate = makeByIdReadGate(makeReadScope("owner-only"));
    const self = makeSelf(agentCtx("attacker"));
    const res: any = await gate.call(self, "rec-1", superGet);
    expect(res instanceof Response).toBe(true);
    expect(res.status).toBe(404);
  });

  it("a genuinely missing id for a non-admin agent → also 404 (same as denied)", async () => {
    const gate = makeByIdReadGate(makeReadScope("owner-only"));
    const self = makeSelf(agentCtx("owner"));
    const res: any = await gate.call(self, "does-not-exist", superGet);
    expect(res instanceof Response).toBe(true);
    expect(res.status).toBe(404);
  });
});

describe("makeByIdReadGate — open-within-org mode (Memory's model)", () => {
  const store = new Map<string, any>([
    ["mem-own-private", { id: "mem-own-private", agentId: "agent-1", visibility: "private" }],
    ["mem-other-shared", { id: "mem-other-shared", agentId: "agent-2", visibility: "shared" }],
    ["mem-other-private", { id: "mem-other-private", agentId: "agent-2", visibility: "private" }],
  ]);
  const superGet = async (t: any) => store.get(typeof t === "string" ? t : t?.id) ?? null;
  const self = { getContext: () => ({ request: agentCtx("agent-1") }), search: mock(() => null) };

  it("own record, any visibility (including private) → returned", async () => {
    const gate = makeByIdReadGate(makeReadScope("open-within-org"));
    const res: any = await gate.call(self, "mem-own-private", superGet);
    expect(res.id).toBe("mem-own-private");
  });

  it("another agent's non-private record → returned (org-open)", async () => {
    const gate = makeByIdReadGate(makeReadScope("open-within-org"));
    const res: any = await gate.call(self, "mem-other-shared", superGet);
    expect(res.id).toBe("mem-other-shared");
  });

  it("another agent's PRIVATE record → 404", async () => {
    const gate = makeByIdReadGate(makeReadScope("open-within-org"));
    const res: any = await gate.call(self, "mem-other-private", superGet);
    expect(res instanceof Response).toBe(true);
    expect(res.status).toBe(404);
  });
});

// ─── resolveAuthGate ────────────────────────────────────────────────────────

describe("resolveAuthGate — the three-way dispatch shared by get()/search()/delete()", () => {
  it("anonymous → denied, with the caller-supplied response", async () => {
    const deny = FORBIDDEN("custom denial");
    const outcome = await resolveAuthGate({ request: anonCtx() }, deny);
    expect(outcome.kind).toBe("denied");
    if (outcome.kind === "denied") expect(outcome.response).toBe(deny);
  });

  it("internal call (no context) → unfiltered", async () => {
    const outcome = await resolveAuthGate(undefined, UNAUTH());
    expect(outcome.kind).toBe("unfiltered");
  });

  it("admin agent → unfiltered", async () => {
    const outcome = await resolveAuthGate({ request: agentCtx("agent-admin", true) }, UNAUTH());
    expect(outcome.kind).toBe("unfiltered");
  });

  it("non-admin agent → scoped, carrying the resolved agentId", async () => {
    const outcome = await resolveAuthGate({ request: agentCtx("agent-1") }, UNAUTH());
    expect(outcome.kind).toBe("scoped");
    if (outcome.kind === "scoped") expect(outcome.agentId).toBe("agent-1");
  });
});

// ─── (c) stampAttribution — every idiom, named to match the source tables ──

describe("stampAttribution('validate-truthy') — Memory.post/put, Soul.post/put idiom", () => {
  it("non-admin + field PRESENT and mismatched → denied, field untouched", () => {
    const content: any = { agentId: "victim" };
    const result = stampAttribution({ kind: "agent", agentId: "attacker", isAdmin: false }, content, "agentId", "validate-truthy", "nope");
    expect(result.denied).toBeDefined();
    expect(result.denied!.status).toBe(403);
    expect(content.agentId).toBe("victim"); // never stamped even on rejection
  });

  it("non-admin + field ABSENT → passes through untouched, no stamp, no rejection", () => {
    const content: any = {};
    const result = stampAttribution({ kind: "agent", agentId: "agent-1", isAdmin: false }, content, "agentId", "validate-truthy", "nope");
    expect(result.denied).toBeUndefined();
    expect(content.agentId).toBeUndefined();
  });

  it("non-admin + field present and MATCHING → passes through, unchanged", () => {
    const content: any = { agentId: "agent-1" };
    const result = stampAttribution({ kind: "agent", agentId: "agent-1", isAdmin: false }, content, "agentId", "validate-truthy", "nope");
    expect(result.denied).toBeUndefined();
    expect(content.agentId).toBe("agent-1");
  });

  it("admin → always passthrough, no default-if-absent", () => {
    const content: any = {};
    stampAttribution({ kind: "agent", agentId: "admin-1", isAdmin: true }, content, "agentId", "validate-truthy", "nope");
    expect(content.agentId).toBeUndefined();
  });

  it("internal → always passthrough", () => {
    const content: any = { agentId: "whatever" };
    const result = stampAttribution({ kind: "internal" }, content, "agentId", "validate-truthy", "nope");
    expect(result.denied).toBeUndefined();
    expect(content.agentId).toBe("whatever");
  });
});

describe("stampAttribution('validate-strict') — WorkspaceState.put/OrgEvent.put idiom", () => {
  it("non-admin + field ABSENT → DENIED (no truthy guard, unlike validate-truthy)", () => {
    const content: any = {};
    const result = stampAttribution({ kind: "agent", agentId: "agent-1", isAdmin: false }, content, "agentId", "validate-strict", "nope");
    expect(result.denied).toBeDefined();
    expect(result.denied!.status).toBe(403);
  });

  it("non-admin + field mismatched → denied", () => {
    const content: any = { agentId: "victim" };
    const result = stampAttribution({ kind: "agent", agentId: "attacker", isAdmin: false }, content, "agentId", "validate-strict", "nope");
    expect(result.denied).toBeDefined();
  });

  it("non-admin + field matching → passes, never stamps (already correct)", () => {
    const content: any = { agentId: "agent-1" };
    const result = stampAttribution({ kind: "agent", agentId: "agent-1", isAdmin: false }, content, "agentId", "validate-strict", "nope");
    expect(result.denied).toBeUndefined();
    expect(content.agentId).toBe("agent-1");
  });

  it("admin → always passthrough, field may stay absent", () => {
    const content: any = {};
    const result = stampAttribution({ kind: "agent", agentId: "admin-1", isAdmin: true }, content, "agentId", "validate-strict", "nope");
    expect(result.denied).toBeUndefined();
    expect(content.agentId).toBeUndefined();
  });
});

describe("stampAttribution('stamp-default') — WorkspaceState.post/OrgEvent.post idiom", () => {
  it("non-admin → unconditional overwrite, NEVER rejects (no rejection branch at all)", () => {
    const content: any = { agentId: "claimed-victim" };
    const result = stampAttribution({ kind: "agent", agentId: "agent-1", isAdmin: false }, content, "agentId", "stamp-default", "unreachable");
    expect(result.denied).toBeUndefined();
    expect(content.agentId).toBe("agent-1"); // silently overwritten, no 403
  });

  it("non-admin + field absent → stamped", () => {
    const content: any = {};
    stampAttribution({ kind: "agent", agentId: "agent-1", isAdmin: false }, content, "agentId", "stamp-default", "unreachable");
    expect(content.agentId).toBe("agent-1");
  });

  it("admin + field absent → default-if-absent (||=)", () => {
    const content: any = {};
    stampAttribution({ kind: "agent", agentId: "admin-1", isAdmin: true }, content, "agentId", "stamp-default", "unreachable");
    expect(content.agentId).toBe("admin-1");
  });

  it("admin + field present → admin-supplied value passes through, NOT overwritten", () => {
    const content: any = { agentId: "on-behalf-of" };
    stampAttribution({ kind: "agent", agentId: "admin-1", isAdmin: true }, content, "agentId", "stamp-default", "unreachable");
    expect(content.agentId).toBe("on-behalf-of");
  });

  it("internal → passthrough, untouched", () => {
    const content: any = { agentId: "whatever" };
    stampAttribution({ kind: "internal" }, content, "agentId", "stamp-default", "unreachable");
    expect(content.agentId).toBe("whatever");
  });
});

describe("stampAttribution('stamp-strict') — Relationship.put idiom (K&S refinement)", () => {
  it("non-admin + field PRESENT and mismatched → denied, never stamps", () => {
    const content: any = { agentId: "victim" };
    const result = stampAttribution({ kind: "agent", agentId: "attacker", isAdmin: false }, content, "agentId", "stamp-strict", "nope");
    expect(result.denied).toBeDefined();
    expect(content.agentId).toBe("victim");
  });

  it("non-admin + field absent → stamped (no rejection — absence isn't a mismatch)", () => {
    const content: any = {};
    const result = stampAttribution({ kind: "agent", agentId: "agent-1", isAdmin: false }, content, "agentId", "stamp-strict", "nope");
    expect(result.denied).toBeUndefined();
    expect(content.agentId).toBe("agent-1");
  });

  it("non-admin + field ALREADY matching → still unconditionally re-stamped (clearer signal than silent no-op)", () => {
    const content: any = { agentId: "agent-1" };
    stampAttribution({ kind: "agent", agentId: "agent-1", isAdmin: false }, content, "agentId", "stamp-strict", "nope");
    expect(content.agentId).toBe("agent-1");
  });

  it("admin → passthrough, NO default-if-absent (unlike stamp-default)", () => {
    const content: any = {};
    stampAttribution({ kind: "agent", agentId: "admin-1", isAdmin: true }, content, "agentId", "stamp-strict", "nope");
    expect(content.agentId).toBeUndefined();
  });

  it("internal → passthrough", () => {
    const content: any = { agentId: "whatever" };
    stampAttribution({ kind: "internal" }, content, "agentId", "stamp-strict", "nope");
    expect(content.agentId).toBe("whatever");
  });
});

describe("stampAttribution — field parameterization (authorId, not just agentId)", () => {
  it("works identically against a different ownerField name (OrgEvent's authorId)", () => {
    const content: any = { authorId: "victim" };
    const result = stampAttribution({ kind: "agent", agentId: "attacker", isAdmin: false }, content, "authorId", "validate-strict", "authorId mismatch");
    expect(result.denied).toBeDefined();
    expect(content.agentId).toBeUndefined(); // only authorId touched
  });
});
