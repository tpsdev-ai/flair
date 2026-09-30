/**
 * usage-recording.test.ts — resources/usage-recording.ts's batch helpers and
 * ledger read rule: recordCitations() (flair#744 slice A: citation-on-write;
 * flair#775 slice 1: read-scope gate), recordUsageBatch() (POST /RecordUsage's
 * batch under the caller's read scope) and isLedgerRowVisible() /
 * readableLedgerRows() (the MemoryUsage read rule).
 *
 * Pure unit coverage via the `recordFn`/`fetchFn`/`scopeFn` injection seams —
 * no Harper. `recordUsageContribution()` itself (the real ledger-write core)
 * has end-to-end coverage via test/integration/record-usage-e2e.test.ts (real
 * Harper) and its read-scope gate is pinned against a table double in
 * test/unit-isolated/usage-contribution-read-scope.test.ts; this file covers
 * the batch-orchestration contracts in isolation: auth gating, validation,
 * dedup+cap, the read-scope gate (scope-denied ids dropped on the SAME branch
 * as nonexistent ids, scope resolved once per batch, fail-closed on
 * scope-resolution failure), the predicate handed to the ledger core, per-id
 * failure isolation, that the agentId credited is always the resolved auth
 * context's — never anything derived from the ids/args (flair#744 slice A
 * invariant 4) — and which ledger rows a reader is shown.
 *
 * The scope-gate tests deliberately use the REAL default `scopeFn`
 * (resolveReadScope — pure, no DB access) against fetch doubles, so they
 * exercise the actual open-within-org predicate (own records any visibility;
 * others' records only when non-private) rather than a stubbed rule.
 */
import { mock, describe, it, expect } from "bun:test";
import type { AgentAuthVerdict } from "../../resources/agent-auth.ts";

// resources/usage-recording.ts imports `databases` from harper,
// whose module chain throws when loaded outside a Harper runtime (the same
// gotcha test/unit/resolve-agent-auth.test.ts documents for agent-auth.ts).
// Mock it — every test below drives recordCitations() exclusively through
// the injected `recordFn` seam, so this stub is never actually touched; it
// exists purely so importing the module under test doesn't throw.
mock.module("harper", () => ({
  server: { http: () => {}, getUser: async () => null },
  databases: { flair: { Memory: { get: async () => null }, MemoryUsage: { get: async () => null, put: async () => {} } } },
  Resource: class {},
}));

const { recordCitations, recordUsageBatch, isLedgerRowVisible, readableLedgerRows, MAX_USAGE_IDS_PER_CALL } = await import("../../resources/usage-recording.ts");

const CITER_ID = "agt_citer";
const AGENT: AgentAuthVerdict = { kind: "agent", agentId: CITER_ID, isAdmin: false };
const NOW = "2026-07-21T00:00:00.000Z";

interface Call {
  agentId: string;
  memoryId: string;
  attribution: string | undefined;
  now: string;
}

/** A recorder double that records every call it receives — never throws. */
function trackingRecorder(): {
  fn: (ctx: any, agentId: string, memoryId: string, attribution: string | undefined, now: string) => Promise<void>;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fn = async (_ctx: any, agentId: string, memoryId: string, attribution: string | undefined, now: string) => {
    calls.push({ agentId, memoryId, attribution, now });
  };
  return { fn, calls };
}

// ── fetchFn doubles (flair#775 read-scope gate seam) ─────────────────────────
// recordCitations now fetches each cited id's record and checks it against
// the writer's read scope before crediting. Tests that only exercise the
// batch-orchestration contract (dedup/cap/isolation/provenance) inject
// `fetchOrgOpen` — every id resolves to another agent's non-private record,
// i.e. in-scope under the real resolveReadScope, which is what the pre-#775
// behavior implicitly assumed. The scope-gate tests below inject targeted
// doubles instead.

/** Every cited id resolves to an org-open (non-private) record owned by a
 *  DIFFERENT agent — in the citer's read scope. */
const fetchOrgOpen = async (_ctx: any, memoryId: string) => ({ id: memoryId, agentId: "agt_someone_else", visibility: "shared" });

describe("recordCitations — non-agent auth is a silent no-op", () => {
  // AgentAuthVerdict's non-"agent" kinds are "internal" (trusted in-process
  // call, no per-agent identity) and "anonymous" (HTTP request, no verified
  // agent) — same "requires a verified agent identity" rule RecordUsage.post()
  // applies. Neither has an agentId to credit a contribution TO.
  it("kind: internal ⇒ recorder never called", async () => {
    const { fn, calls } = trackingRecorder();
    await recordCitations({}, { kind: "internal" }, ["m1", "m2"], NOW, fn);
    expect(calls).toEqual([]);
  });

  it("kind: anonymous ⇒ recorder never called", async () => {
    const { fn, calls } = trackingRecorder();
    await recordCitations({}, { kind: "anonymous" }, ["m1", "m2"], NOW, fn);
    expect(calls).toEqual([]);
  });
});

describe("recordCitations — usedMemoryIds validation (advisory field, no-op never throws)", () => {
  it("empty array ⇒ recorder never called", async () => {
    const { fn, calls } = trackingRecorder();
    await recordCitations({}, AGENT, [], NOW, fn);
    expect(calls).toEqual([]);
  });

  it("missing (undefined) ⇒ recorder never called", async () => {
    const { fn, calls } = trackingRecorder();
    await recordCitations({}, AGENT, undefined, NOW, fn);
    expect(calls).toEqual([]);
  });

  it("non-array ⇒ recorder never called", async () => {
    const { fn, calls } = trackingRecorder();
    await recordCitations({}, AGENT, "m1" as any, NOW, fn);
    expect(calls).toEqual([]);
  });

  it("array containing an empty-string entry ⇒ the whole call is a no-op", async () => {
    const { fn, calls } = trackingRecorder();
    await recordCitations({}, AGENT, ["m1", "", "m2"], NOW, fn);
    expect(calls).toEqual([]);
  });

  it("array containing a non-string entry ⇒ the whole call is a no-op", async () => {
    const { fn, calls } = trackingRecorder();
    await recordCitations({}, AGENT, ["m1", 42 as any], NOW, fn);
    expect(calls).toEqual([]);
  });
});

describe("recordCitations — dedup + cap", () => {
  it("duplicate ids are deduped within the call — each unique id credited once", async () => {
    const { fn, calls } = trackingRecorder();
    await recordCitations({}, AGENT, ["m1", "m2", "m1", "m2", "m1"], NOW, fn, fetchOrgOpen);
    expect(calls.length).toBe(2);
    expect(new Set(calls.map((c: Call) => c.memoryId))).toEqual(new Set(["m1", "m2"]));
  });

  it("more than MAX_USAGE_IDS_PER_CALL unique ids ⇒ recorder called exactly the cap — sliced, not rejected", async () => {
    const ids = Array.from({ length: MAX_USAGE_IDS_PER_CALL + 15 }, (_, i) => `m${i}`);
    const { fn, calls } = trackingRecorder();
    await recordCitations({}, AGENT, ids, NOW, fn, fetchOrgOpen);
    expect(calls.length).toBe(MAX_USAGE_IDS_PER_CALL);
  });
});

describe("recordCitations — per-id failure isolation (post-commit safety)", () => {
  it("a recorder that throws on one id still attempts every OTHER id, and recordCitations itself never throws", async () => {
    const seen: string[] = [];
    const throwingFn = async (_ctx: any, _agentId: string, memoryId: string) => {
      seen.push(memoryId);
      if (memoryId === "bad") throw new Error("simulated ledger failure");
    };
    await expect(recordCitations({}, AGENT, ["m1", "bad", "m2"], NOW, throwingFn as any, fetchOrgOpen)).resolves.toBeUndefined();
    expect(seen).toEqual(["m1", "bad", "m2"]);
  });

  it("every id throwing still resolves cleanly (no unhandled rejection)", async () => {
    const alwaysThrows = async () => {
      throw new Error("simulated ledger failure");
    };
    await expect(recordCitations({}, AGENT, ["m1", "m2", "m3"], NOW, alwaysThrows as any, fetchOrgOpen)).resolves.toBeUndefined();
  });

  it("a fetch that throws on one id drops ONLY that id — the rest of the batch is still fetched and credited", async () => {
    const { fn, calls } = trackingRecorder();
    const throwingFetch = async (_ctx: any, memoryId: string) => {
      if (memoryId === "bad") throw new Error("simulated fetch failure");
      return { id: memoryId, agentId: "agt_someone_else", visibility: "shared" };
    };
    await expect(recordCitations({}, AGENT, ["m1", "bad", "m2"], NOW, fn, throwingFetch)).resolves.toBeUndefined();
    expect(calls.map((c: Call) => c.memoryId)).toEqual(["m1", "m2"]);
  });
});

describe("recordCitations — agentId/attribution provenance (invariant 4: from auth context only)", () => {
  it("agentId credited to every recorded id is auth.agentId, never derived from the cited ids or any other input", async () => {
    const { fn, calls } = trackingRecorder();
    const auth: AgentAuthVerdict = { kind: "agent", agentId: "agt_the_real_citer", isAdmin: false };
    await recordCitations({}, auth, ["some-other-agent-mem-1", "some-other-agent-mem-2"], NOW, fn, fetchOrgOpen);
    expect(calls.length).toBe(2);
    expect(calls.every((c: Call) => c.agentId === "agt_the_real_citer")).toBe(true);
  });

  it("attribution passed to the recorder is always undefined for citation-on-write (Slice A)", async () => {
    const { fn, calls } = trackingRecorder();
    await recordCitations({}, AGENT, ["m1"], NOW, fn, fetchOrgOpen);
    expect(calls[0].attribution).toBeUndefined();
  });

  it("`now` is threaded through to the recorder unchanged", async () => {
    const { fn, calls } = trackingRecorder();
    await recordCitations({}, AGENT, ["m1"], NOW, fn, fetchOrgOpen);
    expect(calls[0].now).toBe(NOW);
  });
});

describe("recordCitations — read-scope gate (flair#775 slice 1)", () => {
  // These use the REAL default scopeFn (resolveReadScope — pure, no DB) so
  // the actual open-within-org predicate is exercised: the writer's own
  // records are in scope at any visibility; another agent's record is in
  // scope iff it is not private (a missing visibility field reads as
  // non-private — the migration-equivalence invariant).

  it("another agent's PRIVATE record is silently dropped — recorder never called", async () => {
    const { fn, calls } = trackingRecorder();
    const fetchOtherPrivate = async (_ctx: any, memoryId: string) => ({ id: memoryId, agentId: "agt_owner", visibility: "private" });
    await recordCitations({}, AGENT, ["m-private"], NOW, fn, fetchOtherPrivate);
    expect(calls).toEqual([]);
  });

  it("another agent's non-private record is credited", async () => {
    const { fn, calls } = trackingRecorder();
    await recordCitations({}, AGENT, ["m-shared"], NOW, fn, fetchOrgOpen);
    expect(calls.map((c: Call) => c.memoryId)).toEqual(["m-shared"]);
  });

  it("the writer's OWN private record is credited — own records are always in scope", async () => {
    const { fn, calls } = trackingRecorder();
    const fetchOwnPrivate = async (_ctx: any, memoryId: string) => ({ id: memoryId, agentId: CITER_ID, visibility: "private" });
    await recordCitations({}, AGENT, ["m-own-private"], NOW, fn, fetchOwnPrivate);
    expect(calls.map((c: Call) => c.memoryId)).toEqual(["m-own-private"]);
  });

  it("another agent's record with NO visibility field reads as org-open (migration invariant) — credited", async () => {
    const { fn, calls } = trackingRecorder();
    const fetchLegacy = async (_ctx: any, memoryId: string) => ({ id: memoryId, agentId: "agt_owner" });
    await recordCitations({}, AGENT, ["m-legacy"], NOW, fn, fetchLegacy);
    expect(calls.map((c: Call) => c.memoryId)).toEqual(["m-legacy"]);
  });

  it("mixed batch credits ONLY the in-scope ids; out-of-scope and not-found drop on the same silent path", async () => {
    const { fn, calls } = trackingRecorder();
    const fetchMixed = async (_ctx: any, memoryId: string) => {
      switch (memoryId) {
        case "own-private":
          return { id: memoryId, agentId: CITER_ID, visibility: "private" };
        case "other-private":
          return { id: memoryId, agentId: "agt_owner", visibility: "private" };
        case "other-shared":
          return { id: memoryId, agentId: "agt_owner", visibility: "shared" };
        case "missing":
          return null;
        default:
          throw new Error(`unexpected id ${memoryId}`);
      }
    };
    await expect(
      recordCitations({}, AGENT, ["own-private", "other-private", "other-shared", "missing"], NOW, fn, fetchMixed),
    ).resolves.toBeUndefined();
    expect(calls.map((c: Call) => c.memoryId)).toEqual(["own-private", "other-shared"]);
  });

  it("not-found and out-of-scope are indistinguishable at this layer — both end as recorder-never-called, clean resolve", async () => {
    const runs: Call[][] = [];
    for (const fetch of [
      async () => null, // nonexistent
      async (_ctx: any, memoryId: string) => ({ id: memoryId, agentId: "agt_owner", visibility: "private" }), // out of scope
    ]) {
      const { fn, calls } = trackingRecorder();
      await expect(recordCitations({}, AGENT, ["m1"], NOW, fn, fetch as any)).resolves.toBeUndefined();
      runs.push(calls);
    }
    expect(runs[0]).toEqual(runs[1]); // both empty — identical observable outcome
  });

  it("the writer's read scope is resolved exactly ONCE per batch, for auth.agentId", async () => {
    const { fn, calls } = trackingRecorder();
    const scopeCalls: string[] = [];
    const countingScope = async (agentId: string) => {
      scopeCalls.push(agentId);
      return { allowedOwners: [agentId], condition: {}, isAllowed: () => true };
    };
    await recordCitations({}, AGENT, ["m1", "m2", "m3", "m4", "m5"], NOW, fn, fetchOrgOpen, countingScope as any);
    expect(scopeCalls).toEqual(["agt_citer"]);
    expect(calls.length).toBe(5);
  });

  it("scope-resolution failure drops the WHOLE batch (fail closed) — no credit, no throw", async () => {
    const { fn, calls } = trackingRecorder();
    const failingScope = async () => {
      throw new Error("simulated scope-resolution failure");
    };
    await expect(recordCitations({}, AGENT, ["m1", "m2"], NOW, fn, fetchOrgOpen, failingScope as any)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });
});

// ─── POST /RecordUsage's batch: the caller's read scope ─────────────────────

interface ScopedCall extends Call {
  allowed: { ownPrivate: boolean; otherShared: boolean; otherPrivate: boolean; missing: boolean };
}

/** A recorder double that also evaluates the read-scope predicate it was handed
 *  against the four record shapes that matter, so a test can assert WHICH rule
 *  reached the ledger core — not just that one did. */
function scopeProbingRecorder(): {
  fn: (ctx: any, agentId: string, memoryId: string, attribution: string | undefined, now: string, canRead: any) => Promise<void>;
  calls: ScopedCall[];
} {
  const calls: ScopedCall[] = [];
  const fn = async (_ctx: any, agentId: string, memoryId: string, attribution: string | undefined, now: string, canRead: any) => {
    calls.push({
      agentId,
      memoryId,
      attribution,
      now,
      allowed: {
        ownPrivate: canRead({ agentId, visibility: "private" }),
        otherShared: canRead({ agentId: "agt_owner", visibility: "shared" }),
        otherPrivate: canRead({ agentId: "agt_owner", visibility: "private" }),
        missing: canRead(null),
      },
    });
  };
  return { fn, calls };
}

describe("recordUsageBatch — credits under the caller's read scope", () => {
  it("hands every contribution the caller's own read-scope predicate (own any visibility, others' non-private, never a missing row)", async () => {
    const { fn, calls } = scopeProbingRecorder();
    await recordUsageBatch({}, "agt_reporter", ["m1", "m2"], "grounded", NOW, fn);
    expect(calls.map((c) => c.memoryId)).toEqual(["m1", "m2"]);
    for (const c of calls) {
      expect(c.agentId).toBe("agt_reporter");
      expect(c.attribution).toBe("grounded");
      expect(c.now).toBe(NOW);
      expect(c.allowed).toEqual({ ownPrivate: true, otherShared: true, otherPrivate: false, missing: false });
    }
  });

  it("resolves the scope exactly once per batch, for the caller", async () => {
    const { fn, calls } = trackingRecorder();
    const scopeCalls: string[] = [];
    const countingScope = async (agentId: string) => {
      scopeCalls.push(agentId);
      return { allowedOwners: [agentId], condition: {}, isAllowed: () => true };
    };
    await recordUsageBatch({}, "agt_reporter", ["m1", "m2", "m3"], undefined, NOW, fn, countingScope as any);
    expect(scopeCalls).toEqual(["agt_reporter"]);
    expect(calls.length).toBe(3);
  });

  it("a failed scope lookup records nothing — no contribution is attempted, and it resolves cleanly", async () => {
    const { fn, calls } = trackingRecorder();
    const failingScope = async () => {
      throw new Error("simulated scope-resolution failure");
    };
    await expect(recordUsageBatch({}, "agt_reporter", ["m1", "m2"], undefined, NOW, fn, failingScope as any)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("one contribution throwing still attempts every other id, and the batch never throws", async () => {
    const seen: string[] = [];
    const throwingFn = async (_ctx: any, _agentId: string, memoryId: string) => {
      seen.push(memoryId);
      if (memoryId === "bad") throw new Error("simulated ledger failure");
    };
    await expect(recordUsageBatch({}, "agt_reporter", ["m1", "bad", "m2"], undefined, NOW, throwingFn as any)).resolves.toBeUndefined();
    expect(seen).toEqual(["m1", "bad", "m2"]);
  });
});

describe("recordCitations — the ledger core receives the writer's read-scope predicate", () => {
  it("each credited id is handed the writer's own isAllowed", async () => {
    const { fn, calls } = scopeProbingRecorder();
    await recordCitations({}, AGENT, ["m1"], NOW, fn, fetchOrgOpen);
    expect(calls.length).toBe(1);
    expect(calls[0].agentId).toBe(CITER_ID);
    expect(calls[0].allowed).toEqual({ ownPrivate: true, otherShared: true, otherPrivate: false, missing: false });
  });
});

// ─── Non-admin MemoryUsage reads: a row is shown only about a readable memory

const READER = "agt_reader";
const ledgerRow = (memoryId: string | undefined) => ({ id: `${READER}:${memoryId}`, agentId: READER, memoryId });
const memoryFixtures: Record<string, { id: string; agentId: string; visibility?: string }> = {
  "own-private": { id: "own-private", agentId: READER, visibility: "private" },
  "other-shared": { id: "other-shared", agentId: "agt_owner", visibility: "shared" },
  "other-legacy": { id: "other-legacy", agentId: "agt_owner" },
  "other-private": { id: "other-private", agentId: "agt_owner", visibility: "private" },
};
const fetchFixture = async (_ctx: any, memoryId: string) => {
  if (memoryId === "fetch-throws") throw new Error("simulated Memory read failure");
  return memoryFixtures[memoryId] ?? null;
};

describe("isLedgerRowVisible — the by-id ledger read rule", () => {
  it("shows a row about the reader's own memory (any visibility) and about another agent's non-private memory", async () => {
    for (const id of ["own-private", "other-shared", "other-legacy"]) {
      expect(await isLedgerRowVisible({}, READER, ledgerRow(id), undefined, fetchFixture), id).toBe(true);
    }
  });

  it("hides a row about another agent's private memory — the same answer as a row about a missing memory", async () => {
    expect(await isLedgerRowVisible({}, READER, ledgerRow("other-private"), undefined, fetchFixture)).toBe(false);
    expect(await isLedgerRowVisible({}, READER, ledgerRow("missing"), undefined, fetchFixture)).toBe(false);
  });

  it("a failed Memory read, a row without a memoryId, and a failed scope lookup all hide the row", async () => {
    expect(await isLedgerRowVisible({}, READER, ledgerRow("fetch-throws"), undefined, fetchFixture)).toBe(false);
    expect(await isLedgerRowVisible({}, READER, ledgerRow(undefined), undefined, fetchFixture)).toBe(false);
    const failingScope = async () => {
      throw new Error("simulated scope-resolution failure");
    };
    expect(await isLedgerRowVisible({}, READER, ledgerRow("own-private"), failingScope as any, fetchFixture)).toBe(false);
  });
});

describe("readableLedgerRows — the collection ledger read rule", () => {
  async function collect(it: AsyncIterable<any>): Promise<string[]> {
    const out: string[] = [];
    for await (const r of it) out.push(r.memoryId);
    return out;
  }

  it("yields only rows about readable memories, in source order", async () => {
    const rows = ["other-private", "own-private", "missing", "other-shared", "fetch-throws", "other-legacy"].map(ledgerRow);
    expect(await collect(readableLedgerRows({}, READER, rows, undefined, fetchFixture))).toEqual([
      "own-private",
      "other-shared",
      "other-legacy",
    ]);
  });

  it("accepts an async source (Harper's search result shape)", async () => {
    async function* source() {
      yield ledgerRow("other-private");
      yield ledgerRow("own-private");
    }
    expect(await collect(readableLedgerRows({}, READER, source(), undefined, fetchFixture))).toEqual(["own-private"]);
  });

  it("a failed scope lookup yields nothing", async () => {
    const failingScope = async () => {
      throw new Error("simulated scope-resolution failure");
    };
    const rows = ["own-private", "other-shared"].map(ledgerRow);
    expect(await collect(readableLedgerRows({}, READER, rows, failingScope as any, fetchFixture))).toEqual([]);
  });
});
