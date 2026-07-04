import { describe, test, expect } from "bun:test";
// ─── SECURITY: conditions-filter-before-fusion (Sherlock's gate) ────────────
// FLAIR-BM25-HYBRID §26/§45-46, ops-i39b. The HARD trust boundary: a BM25
// candidate belonging to another agent MUST be excluded BEFORE the union/fusion,
// so no cross-agent term-frequency / content metadata leaks. These tests
// exercise the SHIPPED predicate (resources/bm25-filter.ts) that the
// SemanticSearch hybrid path applies to the BM25 corpus before scoring.
import {
  isAllowedBm25Candidate,
  matchesConditions,
  passesRecordFilters,
  type Condition,
} from "../../resources/bm25-filter.ts";

// Reconstruct the EXACT conditions[] SemanticSearch.ts builds for a single-agent
// scope (ops-2dm3 Layer 1, resources/memory-read-scope.ts resolveReadScope()):
//   (agentId == me) AND archived != true
// (no grants held → the condition is just the plain self leaf — see the
// multi-agent-scope test below for the granted-owner + private-exclusion shape).
function conditionsForAgent(me: string, extra: Condition[] = []): Condition[] {
  return [
    { attribute: "agentId", comparator: "equals", value: me },
    { attribute: "archived", comparator: "not_equal", value: true },
    ...extra,
  ];
}

// The granted-owner shape: (agentId == me) OR (agentId IN grantedOwners AND
// visibility != 'private'). This is resolveReadScope()'s `condition` when the
// reader holds at least one grant — reconstructed here rather than imported so
// this file stays a pure Harper-free predicate test (matches the existing
// pattern: bm25-filter.ts's shipped predicate is Harper-free and exercised
// directly, with the condition SHAPE hand-built to mirror the real caller).
function conditionsForAgentWithGrants(me: string, grantedOwners: string[]): Condition[] {
  const grantedOwnerCondition: Condition = grantedOwners.length === 1
    ? { attribute: "agentId", comparator: "equals", value: grantedOwners[0] }
    : { operator: "or", conditions: grantedOwners.map((id) => ({ attribute: "agentId", comparator: "equals", value: id })) };
  return [
    {
      operator: "or",
      conditions: [
        { attribute: "agentId", comparator: "equals", value: me },
        {
          operator: "and",
          conditions: [
            grantedOwnerCondition,
            { attribute: "visibility", comparator: "not_equal", value: "private" },
          ],
        },
      ],
    },
    { attribute: "archived", comparator: "not_equal", value: true },
  ];
}

describe("conditions-filter-before-fusion (cross-agent leak gate)", () => {
  const me = "flint";
  const conditions = conditionsForAgent(me);

  test("a BM25 candidate belonging to ANOTHER agent (no grant) is excluded BEFORE fusion", () => {
    const mine = { id: "m1", agentId: "flint", content: "Harper getUser phantom user", visibility: "private" };
    const theirs = { id: "t1", agentId: "anvil", content: "Harper getUser phantom user", visibility: "shared" };

    expect(isAllowedBm25Candidate(mine, conditions)).toBe(true);
    // The leak case: identical content owned by anvil — MUST be excluded (no
    // grant held for anvil at all, regardless of anvil's own visibility
    // choice) so its term-frequency never enters the BM25 index/union/fusion.
    expect(isAllowedBm25Candidate(theirs, conditions)).toBe(false);
  });

  test("simulated full pre-fusion filter: only the caller's docs survive (no grants held)", () => {
    const corpus = [
      { id: "m1", agentId: "flint", content: "secret flint plan alpha", visibility: "private" },
      { id: "m2", agentId: "flint", content: "flint roadmap beta", visibility: "private" },
      { id: "t1", agentId: "anvil", content: "secret anvil plan alpha", visibility: "private" },
      { id: "t2", agentId: "kern", content: "kern review notes", visibility: "private" },
      // ops-nzxa regression: this used to be `visibility: "office"`, which the
      // OLD global OR-clause exposed to ANY authenticated agent with no grant
      // at all. That clause is gone — a `shared` memory from an UNGRANTED
      // owner must be excluded exactly like a private one.
      { id: "o1", agentId: "anvil", content: "shared doc, no grant held for anvil", visibility: "shared" },
    ];
    const allowed = corpus.filter(r => isAllowedBm25Candidate(r, conditions));
    const allowedIds = allowed.map(r => r.id).sort();
    // ONLY flint's own (m1, m2) — nothing from anvil or kern, grant or not.
    expect(allowedIds).toEqual(["m1", "m2"]);
    expect(allowed.some(r => r.id === "t1")).toBe(false);
    expect(allowed.some(r => r.id === "t2")).toBe(false);
    expect(allowed.some(r => r.id === "o1")).toBe(false);
  });

  test("office-OR leak closed: an ungranted owner's SHARED memory is never allowed (ops-nzxa)", () => {
    const sharedNoGrant = { id: "o1", agentId: "anvil", content: "office wide note", visibility: "shared" };
    expect(isAllowedBm25Candidate(sharedNoGrant, conditions)).toBe(false);
  });

  test("private-exclusion: a GRANTED owner's private memory is excluded, shared/no-field is allowed", () => {
    const grantConditions = conditionsForAgentWithGrants("flint", ["anvil"]);
    const anvilPrivate = { id: "p1", agentId: "anvil", content: "anvil's private note", visibility: "private" };
    const anvilShared = { id: "s1", agentId: "anvil", content: "anvil's shared note", visibility: "shared" };
    const anvilNoField = { id: "n1", agentId: "anvil", content: "anvil's pre-migration note" }; // no visibility field
    expect(isAllowedBm25Candidate(anvilPrivate, grantConditions)).toBe(false);
    expect(isAllowedBm25Candidate(anvilShared, grantConditions)).toBe(true);
    // Migration invariant: absent visibility reads as shared, not private.
    expect(isAllowedBm25Candidate(anvilNoField, grantConditions)).toBe(true);
  });

  test("own records are NEVER private-excluded, regardless of visibility", () => {
    const myPrivate = { id: "mp1", agentId: "flint", content: "my private note", visibility: "private" };
    expect(isAllowedBm25Candidate(myPrivate, conditions)).toBe(true);
  });

  test("archived records are excluded (archived == true fails not_equal)", () => {
    const archived = { id: "a1", agentId: "flint", content: "old", visibility: "private", archived: true };
    const live = { id: "a2", agentId: "flint", content: "new", visibility: "private", archived: false };
    const noField = { id: "a3", agentId: "flint", content: "legacy", visibility: "private" }; // no archived field
    expect(isAllowedBm25Candidate(archived, conditions)).toBe(false);
    expect(isAllowedBm25Candidate(live, conditions)).toBe(true);
    // not_equal must INCLUDE records without the field (Harper semantics).
    expect(isAllowedBm25Candidate(noField, conditions)).toBe(true);
  });

  test("multi-agent scope (grants): each granted owner's SHARED docs, never ungranted, never a granted owner's private", () => {
    // flint holds a grant on anvil (but not kern).
    const grantConditions = conditionsForAgentWithGrants("flint", ["anvil"]);
    const flintDoc = { id: "f", agentId: "flint", visibility: "private" }; // own — unrestricted
    const anvilSharedGranted = { id: "g", agentId: "anvil", visibility: "shared" }; // granted + shared — allowed
    const anvilPrivateGranted = { id: "gp", agentId: "anvil", visibility: "private" }; // granted but PRIVATE — excluded
    const kernUngranted = { id: "k", agentId: "kern", visibility: "shared" }; // no grant at all — excluded regardless of visibility
    expect(isAllowedBm25Candidate(flintDoc, grantConditions)).toBe(true);
    expect(isAllowedBm25Candidate(anvilSharedGranted, grantConditions)).toBe(true);
    expect(isAllowedBm25Candidate(anvilPrivateGranted, grantConditions)).toBe(false);
    expect(isAllowedBm25Candidate(kernUngranted, grantConditions)).toBe(false);
  });

  test("tag/subject conditions are applied to the BM25 set too", () => {
    const withTagSubject = conditionsForAgent(me, [
      { attribute: "tags", comparator: "equals", value: "security" },
      { attribute: "subject", comparator: "equals", value: "flair" },
    ]);
    const match = { id: "x", agentId: "flint", visibility: "private", tags: ["security", "ops"], subject: "flair" };
    const wrongSubject = { id: "y", agentId: "flint", visibility: "private", tags: ["security"], subject: "tps" };
    const wrongTag = { id: "z", agentId: "flint", visibility: "private", tags: ["ops"], subject: "flair" };
    expect(isAllowedBm25Candidate(match, withTagSubject)).toBe(true);
    expect(isAllowedBm25Candidate(wrongSubject, withTagSubject)).toBe(false);
    expect(isAllowedBm25Candidate(wrongTag, withTagSubject)).toBe(false);
  });

  test("fail-closed: an unknown comparator excludes the record (never leaks)", () => {
    const bad: Condition[] = [{ attribute: "agentId", comparator: "regex_pwn", value: ".*" }];
    const anyDoc = { id: "x", agentId: "flint" };
    expect(matchesConditions(bad, anyDoc)).toBe(false);
  });
});

describe("per-record temporal filters mirror the HNSW loop", () => {
  const fixedNow = Date.parse("2026-06-24T00:00:00Z");

  test("expired records are excluded", () => {
    const expired = { id: "e", expiresAt: "2020-01-01T00:00:00Z" };
    const live = { id: "l", expiresAt: "2099-01-01T00:00:00Z" };
    expect(passesRecordFilters(expired, { now: fixedNow })).toBe(false);
    expect(passesRecordFilters(live, { now: fixedNow })).toBe(true);
  });

  test("sinceDate excludes older createdAt", () => {
    const since = new Date("2026-06-20T00:00:00Z");
    const older = { id: "o", createdAt: "2026-06-01T00:00:00Z" };
    const newer = { id: "n", createdAt: "2026-06-23T00:00:00Z" };
    expect(passesRecordFilters(older, { now: fixedNow, sinceDate: since })).toBe(false);
    expect(passesRecordFilters(newer, { now: fixedNow, sinceDate: since })).toBe(true);
  });

  test("asOf bitemporal window (validFrom/validTo) is enforced", () => {
    const asOf = "2026-06-15T00:00:00Z";
    const notYetValid = { id: "f", validFrom: "2026-06-20T00:00:00Z" };
    const expiredValidity = { id: "g", validTo: "2026-06-10T00:00:00Z" };
    const inWindow = { id: "h", validFrom: "2026-06-01T00:00:00Z", validTo: "2026-06-30T00:00:00Z" };
    expect(passesRecordFilters(notYetValid, { now: fixedNow, asOf })).toBe(false);
    expect(passesRecordFilters(expiredValidity, { now: fixedNow, asOf })).toBe(false);
    expect(passesRecordFilters(inWindow, { now: fixedNow, asOf })).toBe(true);
  });
});
