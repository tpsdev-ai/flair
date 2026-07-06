import { describe, test, expect } from "bun:test";
// ─── SECURITY: conditions-filter-before-fusion (Sherlock's gate) ────────────
// FLAIR-BM25-HYBRID §26/§45-46. The HARD trust boundary: a BM25
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

// Reconstruct the EXACT conditions[] SemanticSearch.ts builds for the read
// scope (resources/memory-read-scope.ts resolveReadScope(), within-org-read-
// open — see that module's doc): resolveReadScope() ALWAYS emits this SAME
// compound shape now — there is no separate "no grants held" plain-leaf
// variant anymore, because MemoryGrant is no longer consulted at all:
//   (agentId == me) OR (visibility != 'private')
// AND archived != true. Reconstructed here rather than imported so this file
// stays a pure Harper-free predicate test (matches the existing pattern:
// bm25-filter.ts's shipped predicate is Harper-free and exercised directly,
// with the condition SHAPE hand-built to mirror the real caller).
function conditionsForAgent(me: string, extra: Condition[] = []): Condition[] {
  return [
    {
      operator: "or",
      conditions: [
        { attribute: "agentId", comparator: "equals", value: me },
        { attribute: "visibility", comparator: "not_equal", value: "private" },
      ],
    },
    { attribute: "archived", comparator: "not_equal", value: true },
    ...extra,
  ];
}

describe("conditions-filter-before-fusion (cross-agent leak gate — now within-org-read-open)", () => {
  const me = "flint";
  const conditions = conditionsForAgent(me);

  test("a BM25 candidate belonging to ANOTHER agent, non-private → allowed (within-org-read-open, no grant needed); a PRIVATE one is still excluded", () => {
    const mine = { id: "m1", agentId: "flint", content: "Harper getUser phantom user", visibility: "private" };
    const theirsShared = { id: "t1", agentId: "anvil", content: "Harper getUser phantom user", visibility: "shared" };
    const theirsPrivate = { id: "t2", agentId: "anvil", content: "Harper getUser phantom user", visibility: "private" };

    expect(isAllowedBm25Candidate(mine, conditions)).toBe(true);
    // Within-org-read-open: anvil's SHARED doc is now allowed into the BM25
    // corpus — this is the intended, documented broadening (Kern-approved),
    // not a leak. Only anvil's PRIVATE doc stays excluded.
    expect(isAllowedBm25Candidate(theirsShared, conditions)).toBe(true);
    expect(isAllowedBm25Candidate(theirsPrivate, conditions)).toBe(false);
  });

  test("simulated full pre-fusion filter: every non-private doc survives, regardless of owner — only PRIVATE docs (others' or, if not self, one's own) are excluded", () => {
    const corpus = [
      { id: "m1", agentId: "flint", content: "secret flint plan alpha", visibility: "private" }, // own — always allowed
      { id: "m2", agentId: "flint", content: "flint roadmap beta", visibility: "private" }, // own — always allowed
      { id: "t1", agentId: "anvil", content: "secret anvil plan alpha", visibility: "private" }, // other + PRIVATE — excluded
      { id: "t2", agentId: "kern", content: "kern review notes", visibility: "private" }, // other + PRIVATE — excluded
      // within-org-read-open: a `shared` memory from ANY other agent is now
      // allowed, no grant required — the intended broadening this module's
      // doc describes (formerly excluded pre-open-read; the office-visibility
      // read leak was a DIFFERENT bug — an accidental `visibility:"office"`
      // bypass BEFORE any grant-gating existed at all — not this deliberate
      // design decision).
      { id: "o1", agentId: "anvil", content: "shared doc, no grant needed", visibility: "shared" },
    ];
    const allowed = corpus.filter(r => isAllowedBm25Candidate(r, conditions));
    const allowedIds = allowed.map(r => r.id).sort();
    expect(allowedIds).toEqual(["m1", "m2", "o1"]);
    expect(allowed.some(r => r.id === "t1")).toBe(false);
    expect(allowed.some(r => r.id === "t2")).toBe(false);
  });

  test("within-org-read-open (was: office-OR leak closed): an owner's SHARED memory IS allowed for any other agent — no grant needed, this is intentional", () => {
    const shared = { id: "o1", agentId: "anvil", content: "org-wide note", visibility: "shared" };
    expect(isAllowedBm25Candidate(shared, conditions)).toBe(true);
  });

  test("private-exclusion: another agent's private memory is excluded, shared/no-field is allowed — a grant is never consulted", () => {
    const anvilPrivate = { id: "p1", agentId: "anvil", content: "anvil's private note", visibility: "private" };
    const anvilShared = { id: "s1", agentId: "anvil", content: "anvil's shared note", visibility: "shared" };
    const anvilNoField = { id: "n1", agentId: "anvil", content: "anvil's pre-migration note" }; // no visibility field
    expect(isAllowedBm25Candidate(anvilPrivate, conditions)).toBe(false);
    expect(isAllowedBm25Candidate(anvilShared, conditions)).toBe(true);
    // Migration invariant: absent visibility reads as non-private (org-open).
    expect(isAllowedBm25Candidate(anvilNoField, conditions)).toBe(true);
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

  test("multi-agent scope: EVERY other agent's non-private docs are allowed (no grant relationship needed at all), own docs unrestricted, only PRIVATE is excluded", () => {
    // No grants exist anywhere in this test — the point is that none are needed.
    const flintDoc = { id: "f", agentId: "flint", visibility: "private" }; // own — unrestricted
    const anvilShared = { id: "g", agentId: "anvil", visibility: "shared" }; // no relationship to flint — still allowed
    const anvilPrivate = { id: "gp", agentId: "anvil", visibility: "private" }; // PRIVATE — excluded regardless of anything
    const kernShared = { id: "k", agentId: "kern", visibility: "shared" }; // a totally different, unrelated agent — still allowed
    expect(isAllowedBm25Candidate(flintDoc, conditions)).toBe(true);
    expect(isAllowedBm25Candidate(anvilShared, conditions)).toBe(true);
    expect(isAllowedBm25Candidate(anvilPrivate, conditions)).toBe(false);
    expect(isAllowedBm25Candidate(kernShared, conditions)).toBe(true);
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
