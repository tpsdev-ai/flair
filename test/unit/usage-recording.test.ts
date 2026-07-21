/**
 * usage-recording.test.ts — resources/usage-recording.ts's recordCitations()
 * (flair#744 slice A: citation-on-write).
 *
 * Pure unit coverage via the `recordFn` injection seam — no Harper.
 * `recordUsageContribution()` itself (the real ledger-write core, moved
 * unchanged from RecordUsage.ts's former private `_recordOne()`) already has
 * end-to-end coverage via test/integration/record-usage-e2e.test.ts (real
 * Harper); this file covers ONLY recordCitations()'s batch-orchestration
 * contract in isolation: auth gating, validation, dedup+cap, per-id failure
 * isolation, and that the agentId credited is always the resolved auth
 * context's — never anything derived from the ids/args (flair#744 slice A
 * invariant 4).
 */
import { mock, describe, it, expect } from "bun:test";
import type { AgentAuthVerdict } from "../../resources/agent-auth.ts";

// resources/usage-recording.ts imports `databases` from @harperfast/harper,
// whose module chain throws when loaded outside a Harper runtime (the same
// gotcha test/unit/resolve-agent-auth.test.ts documents for agent-auth.ts).
// Mock it — every test below drives recordCitations() exclusively through
// the injected `recordFn` seam, so this stub is never actually touched; it
// exists purely so importing the module under test doesn't throw.
mock.module("@harperfast/harper", () => ({
  databases: { flair: { Memory: { get: async () => null }, MemoryUsage: { get: async () => null, put: async () => {} } } },
  Resource: class {},
}));

const { recordCitations, MAX_USAGE_IDS_PER_CALL } = await import("../../resources/usage-recording.ts");

const AGENT: AgentAuthVerdict = { kind: "agent", agentId: "agt_citer", isAdmin: false };
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
    await recordCitations({}, AGENT, ["m1", "m2", "m1", "m2", "m1"], NOW, fn);
    expect(calls.length).toBe(2);
    expect(new Set(calls.map((c: Call) => c.memoryId))).toEqual(new Set(["m1", "m2"]));
  });

  it("more than MAX_USAGE_IDS_PER_CALL unique ids ⇒ recorder called exactly the cap — sliced, not rejected", async () => {
    const ids = Array.from({ length: MAX_USAGE_IDS_PER_CALL + 15 }, (_, i) => `m${i}`);
    const { fn, calls } = trackingRecorder();
    await recordCitations({}, AGENT, ids, NOW, fn);
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
    await expect(recordCitations({}, AGENT, ["m1", "bad", "m2"], NOW, throwingFn as any)).resolves.toBeUndefined();
    expect(seen).toEqual(["m1", "bad", "m2"]);
  });

  it("every id throwing still resolves cleanly (no unhandled rejection)", async () => {
    const alwaysThrows = async () => {
      throw new Error("simulated ledger failure");
    };
    await expect(recordCitations({}, AGENT, ["m1", "m2", "m3"], NOW, alwaysThrows as any)).resolves.toBeUndefined();
  });
});

describe("recordCitations — agentId/attribution provenance (invariant 4: from auth context only)", () => {
  it("agentId credited to every recorded id is auth.agentId, never derived from the cited ids or any other input", async () => {
    const { fn, calls } = trackingRecorder();
    const auth: AgentAuthVerdict = { kind: "agent", agentId: "agt_the_real_citer", isAdmin: false };
    await recordCitations({}, auth, ["some-other-agent-mem-1", "some-other-agent-mem-2"], NOW, fn);
    expect(calls.length).toBe(2);
    expect(calls.every((c: Call) => c.agentId === "agt_the_real_citer")).toBe(true);
  });

  it("attribution passed to the recorder is always undefined for citation-on-write (Slice A)", async () => {
    const { fn, calls } = trackingRecorder();
    await recordCitations({}, AGENT, ["m1"], NOW, fn);
    expect(calls[0].attribution).toBeUndefined();
  });

  it("`now` is threaded through to the recorder unchanged", async () => {
    const { fn, calls } = trackingRecorder();
    await recordCitations({}, AGENT, ["m1"], NOW, fn);
    expect(calls[0].now).toBe(NOW);
  });
});
