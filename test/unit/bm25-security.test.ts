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
// scope: (agentId == me OR visibility == office) AND archived != true.
function conditionsForAgent(me: string, extra: Condition[] = []): Condition[] {
  return [
    {
      operator: "or",
      conditions: [
        { attribute: "agentId", comparator: "equals", value: me },
        { attribute: "visibility", comparator: "equals", value: "office" },
      ],
    },
    { attribute: "archived", comparator: "not_equal", value: true },
    ...extra,
  ];
}

describe("conditions-filter-before-fusion (cross-agent leak gate)", () => {
  const me = "flint";
  const conditions = conditionsForAgent(me);

  test("a BM25 candidate belonging to ANOTHER agent is excluded BEFORE fusion", () => {
    const mine = { id: "m1", agentId: "flint", content: "Harper getUser phantom user", visibility: "private" };
    const theirs = { id: "t1", agentId: "anvil", content: "Harper getUser phantom user", visibility: "private" };

    expect(isAllowedBm25Candidate(mine, conditions)).toBe(true);
    // The leak case: identical content owned by anvil — MUST be excluded so its
    // term-frequency never enters the BM25 index / union / fusion.
    expect(isAllowedBm25Candidate(theirs, conditions)).toBe(false);
  });

  test("simulated full pre-fusion filter: only the caller's docs survive", () => {
    const corpus = [
      { id: "m1", agentId: "flint", content: "secret flint plan alpha", visibility: "private" },
      { id: "m2", agentId: "flint", content: "flint roadmap beta", visibility: "private" },
      { id: "t1", agentId: "anvil", content: "secret anvil plan alpha", visibility: "private" },
      { id: "t2", agentId: "kern", content: "kern review notes", visibility: "private" },
      { id: "o1", agentId: "anvil", content: "shared office doc", visibility: "office" }, // office-visible → allowed
    ];
    const allowed = corpus.filter(r => isAllowedBm25Candidate(r, conditions));
    const allowedIds = allowed.map(r => r.id).sort();
    // flint's own (m1, m2) + the office-visible doc (o1). NEVER anvil/kern private.
    expect(allowedIds).toEqual(["m1", "m2", "o1"]);
    // Explicitly assert no other-agent PRIVATE doc leaked into the candidate set.
    expect(allowed.some(r => r.id === "t1")).toBe(false);
    expect(allowed.some(r => r.id === "t2")).toBe(false);
  });

  test("office-visible memories from other agents ARE allowed (matches HNSW scope)", () => {
    const officeDoc = { id: "o1", agentId: "anvil", content: "office wide note", visibility: "office" };
    expect(isAllowedBm25Candidate(officeDoc, conditions)).toBe(true);
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

  test("multi-agent scope (grants): each granted owner + office, never ungranted", () => {
    // searchAgentIds = {flint, anvil} (anvil granted flint a search scope).
    const grantConditions: Condition[] = [
      {
        operator: "or",
        conditions: [
          { attribute: "agentId", comparator: "equals", value: "flint" },
          { attribute: "agentId", comparator: "equals", value: "anvil" },
          { attribute: "visibility", comparator: "equals", value: "office" },
        ],
      },
      { attribute: "archived", comparator: "not_equal", value: true },
    ];
    const flintDoc = { id: "f", agentId: "flint", visibility: "private" };
    const anvilGranted = { id: "g", agentId: "anvil", visibility: "private" };
    const kernUngranted = { id: "k", agentId: "kern", visibility: "private" };
    expect(isAllowedBm25Candidate(flintDoc, grantConditions)).toBe(true);
    expect(isAllowedBm25Candidate(anvilGranted, grantConditions)).toBe(true);
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
