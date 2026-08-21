/**
 * continuity-rem-slice3.test.ts — unit coverage for the flair#1257 slice-3
 * pure logic (REM promotion wiring for continuity journals), across its three
 * packaging-boundary homes:
 *
 *   resources/memory-reflect-lib.ts — the stale-intent post-filter (the
 *     TESTABLE layer of Kern's two-layer guard), the visibility-ruling
 *     resolution (Sherlock's default-private-unless), the continuity prompt
 *     addendum, the journal-row scope containment, and the staged-candidate
 *     visibility stamp.
 *   resources/auto-promote-lib.ts — decidePromotedVisibility (the unattended
 *     promotion path's visibility decision).
 *   src/cli.ts — derivePromotedVisibility (the HUMAN `rem promote` path's
 *     mirror of the same decision).
 *
 * The load-bearing mutations (each verified red during development, per the
 * slice-3 spec):
 *   - default-to-shared flip in decidePromotedVisibility → the
 *     "default is private" tests go red (both promotion paths).
 *   - disable the stale-intent filter (always return kept=all) → the
 *     "stale in-flight intent dropped" tests go red.
 *   - drop the journal-containment branch in memoryMatchesReflectScope →
 *     the "journal rows refused outside their own tagged run" tests go red.
 */

import { describe, test, expect } from "bun:test";
import {
  CONTINUITY_SCOPE_TAG_PREFIX,
  isContinuityScopeTag,
  isInFlightIntentShaped,
  filterStaleSessionIntentCandidates,
  resolveCandidateVisibilityRuling,
  buildContinuityExecuteAddendum,
  buildExecutePrompt,
  buildStagedCandidateRow,
  parseAndValidateCandidates,
  memoryMatchesReflectScope,
  DEFAULT_STALE_INTENT_HORIZON_MS,
  type RawCandidate,
} from "../../resources/memory-reflect-lib.ts";
import {
  decidePromotedVisibility,
  isContinuityScopeTag as autoPromoteIsContinuityScopeTag,
  CONTINUITY_SCOPE_TAG_PREFIX as AUTO_PROMOTE_CONTINUITY_PREFIX,
  decideAutoPromote,
} from "../../resources/auto-promote-lib.ts";
import {
  derivePromotedVisibility,
  CONTINUITY_SCOPE_TAG_PREFIX as CLI_CONTINUITY_PREFIX,
} from "../../src/cli.ts";
import { CONTINUITY_TAG_PREFIX as RUNNER_CONTINUITY_PREFIX } from "../../src/rem/runner.ts";
import { CONTINUITY_TAG_PREFIX as MCP_CONTINUITY_PREFIX } from "../../packages/flair-mcp/src/continuity.ts";

const TAG = "adk:continuity:sess-abc123";
const NOW = new Date("2026-08-20T12:00:00.000Z");
const FRESH = "2026-08-20T10:00:00.000Z"; // 2h old — inside the 72h horizon
const STALE = "2026-08-16T10:00:00.000Z"; // 4d old — beyond the 72h horizon

function cand(claim: string, extra: Partial<RawCandidate> = {}): RawCandidate {
  return { claim, sourceMemoryIds: ["m1"], ...extra };
}

describe("canonical continuity prefix stays in sync across packaging boundaries", () => {
  test("all four duplicated constants are the same string", () => {
    expect(CONTINUITY_SCOPE_TAG_PREFIX).toBe("adk:continuity:");
    expect(AUTO_PROMOTE_CONTINUITY_PREFIX).toBe(CONTINUITY_SCOPE_TAG_PREFIX);
    expect(CLI_CONTINUITY_PREFIX).toBe(CONTINUITY_SCOPE_TAG_PREFIX);
    expect(RUNNER_CONTINUITY_PREFIX).toBe(CONTINUITY_SCOPE_TAG_PREFIX);
    expect(MCP_CONTINUITY_PREFIX).toBe(CONTINUITY_SCOPE_TAG_PREFIX);
  });

  test("isContinuityScopeTag: session tags yes; bare prefix, adk user tags, null no (both copies agree)", () => {
    for (const fn of [isContinuityScopeTag, autoPromoteIsContinuityScopeTag]) {
      expect(fn(TAG)).toBe(true);
      expect(fn("adk:continuity:")).toBe(false); // bare prefix is not a session
      expect(fn("adk:app:alice")).toBe(false);
      expect(fn(undefined)).toBe(false);
      expect(fn(null)).toBe(false);
      expect(fn("")).toBe(false);
    }
  });
});

describe("isInFlightIntentShaped (the ruled shapes, non-exhaustive by design)", () => {
  test("matches the four ruled in-flight families, case-insensitive", () => {
    expect(isInFlightIntentShaped("About to merge PR #42")).toBe(true);
    expect(isInFlightIntentShaped("waiting on Kern's review")).toBe(true);
    expect(isInFlightIntentShaped("Waiting for CI")).toBe(true);
    expect(isInFlightIntentShaped("going to redeploy after lunch")).toBe(true);
    expect(isInFlightIntentShaped("Planning to split the spec")).toBe(true);
  });

  test("decision-class content does not match", () => {
    expect(isInFlightIntentShaped("Decided to use scope:tagged for continuity distills because it reuses #1205")).toBe(false);
    expect(isInFlightIntentShaped("Root cause: the settle window was measured on the oldest entry")).toBe(false);
  });

  test("word-bounded: 'roundabout to' is not 'about to'", () => {
    expect(isInFlightIntentShaped("took the roundabout tour of the codebase")).toBe(false);
  });
});

describe("filterStaleSessionIntentCandidates (the testable guard layer)", () => {
  const inFlight = cand("was about to merge flair#1290, waiting on CI");
  const decision = cand("Decided: continuity distills ride scope:tagged; reuses the #1205 engine");

  test("FRESH session: everything passes, nothing dropped (in-flight intent is promote-eligible)", () => {
    const r = filterStaleSessionIntentCandidates([inFlight, decision], {
      sessionNewestCreatedAt: FRESH,
      now: NOW,
    });
    expect(r.kept).toEqual([inFlight, decision]);
    expect(r.droppedStaleIntent).toEqual([]);
  });

  test("STALE session: in-flight intent dropped; DECISION-class still promotes (the positive control)", () => {
    const r = filterStaleSessionIntentCandidates([inFlight, decision], {
      sessionNewestCreatedAt: STALE,
      now: NOW,
    });
    expect(r.kept).toEqual([decision]); // positive control: the filter is selective, not a blanket drop
    expect(r.droppedStaleIntent).toEqual([inFlight]);
  });

  test("UNDATEABLE session is treated as stale (fail-closed)", () => {
    for (const sessionNewestCreatedAt of [undefined, "not-a-date"]) {
      const r = filterStaleSessionIntentCandidates([inFlight, decision], {
        sessionNewestCreatedAt: sessionNewestCreatedAt as string | undefined,
        now: NOW,
      });
      expect(r.kept).toEqual([decision]);
      expect(r.droppedStaleIntent).toEqual([inFlight]);
    }
  });

  test("horizon boundary: default is 72h; a session exactly at the horizon is not yet stale", () => {
    expect(DEFAULT_STALE_INTENT_HORIZON_MS).toBe(72 * 3600_000);
    const exactly72h = new Date(NOW.getTime() - DEFAULT_STALE_INTENT_HORIZON_MS).toISOString();
    const r = filterStaleSessionIntentCandidates([inFlight], { sessionNewestCreatedAt: exactly72h, now: NOW });
    expect(r.kept).toEqual([inFlight]);
    const past72h = new Date(NOW.getTime() - DEFAULT_STALE_INTENT_HORIZON_MS - 1000).toISOString();
    const r2 = filterStaleSessionIntentCandidates([inFlight], { sessionNewestCreatedAt: past72h, now: NOW });
    expect(r2.droppedStaleIntent).toEqual([inFlight]);
  });

  test("custom horizon is honored", () => {
    const r = filterStaleSessionIntentCandidates([inFlight], {
      sessionNewestCreatedAt: FRESH, // 2h old
      now: NOW,
      horizonMs: 3600_000, // 1h horizon → session is stale
    });
    expect(r.droppedStaleIntent).toEqual([inFlight]);
  });
});

describe("resolveCandidateVisibilityRuling (affirmative-only, Sherlock)", () => {
  test("absent visibility → null (private default)", () => {
    expect(resolveCandidateVisibilityRuling({})).toBeNull();
  });
  test("explicit private → null (no ruling to record)", () => {
    expect(resolveCandidateVisibilityRuling({ visibility: "private", teamRelevance: "irrelevant" })).toBeNull();
  });
  test("shared WITHOUT justification → null (not affirmative, fail-closed)", () => {
    expect(resolveCandidateVisibilityRuling({ visibility: "shared" })).toBeNull();
    expect(resolveCandidateVisibilityRuling({ visibility: "shared", teamRelevance: "   " })).toBeNull();
  });
  test("shared WITH justification → recorded ruling with the trimmed rationale", () => {
    const r = resolveCandidateVisibilityRuling({ visibility: "shared", teamRelevance: " the team gates merges on this decision " });
    expect(r).toEqual({ ruling: "shared", rationale: "the team gates merges on this decision" });
  });
});

describe("parseAndValidateCandidates — visibility/teamRelevance validation", () => {
  const ids = new Set(["m1"]);
  test("valid shared ruling passes through to the RawCandidate", () => {
    const raw = JSON.stringify({ candidates: [{ claim: "c", sourceMemoryIds: ["m1"], visibility: "shared", teamRelevance: "team needs it" }] });
    const r = parseAndValidateCandidates(raw, ids);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.candidates[0].visibility).toBe("shared");
      expect(r.candidates[0].teamRelevance).toBe("team needs it");
    }
  });
  test("an unknown visibility value fails the batch closed (never a third readable state)", () => {
    const raw = JSON.stringify({ candidates: [{ claim: "c", sourceMemoryIds: ["m1"], visibility: "org" }] });
    expect(parseAndValidateCandidates(raw, ids)).toEqual({ ok: false, reason: "shape_mismatch" });
  });
  test("a non-string teamRelevance fails the batch closed", () => {
    const raw = JSON.stringify({ candidates: [{ claim: "c", sourceMemoryIds: ["m1"], teamRelevance: 42 }] });
    expect(parseAndValidateCandidates(raw, ids)).toEqual({ ok: false, reason: "shape_mismatch" });
  });
  test("candidates without the optional fields still pass (pre-slice-3 shape unchanged)", () => {
    const raw = JSON.stringify({ candidates: [{ claim: "c", sourceMemoryIds: ["m1"] }] });
    expect(parseAndValidateCandidates(raw, ids).ok).toBe(true);
  });
});

describe("buildContinuityExecuteAddendum / buildExecutePrompt continuity wiring", () => {
  test("addendum always carries the default-private + affirmative-shared contract", () => {
    const text = buildContinuityExecuteAddendum({ sessionStale: false });
    expect(text).toContain('defaults to "private"');
    expect(text).toContain("teamRelevance");
    expect(text).toContain("If uncertain, stay private");
    expect(text).not.toContain("STALE");
  });
  test("stale sessions add the prompt-layer stale-intent rule (Kern's primary layer)", () => {
    const text = buildContinuityExecuteAddendum({ sessionStale: true });
    expect(text).toContain("STALE");
    expect(text).toContain("about to");
    expect(text).toContain("waiting on");
  });
  test("buildExecutePrompt embeds the addendum and the widened output shape ONLY for continuity runs", () => {
    const base = { agentId: "a", focus: "continuity", scope: "tagged", sinceISO: NOW.toISOString(), memories: [{ id: "m1", content: "x" }] };
    const withContinuity = buildExecutePrompt({ ...base, continuity: { sessionStale: true } });
    expect(withContinuity).toContain("Continuity visibility rules:");
    expect(withContinuity).toContain('"teamRelevance"?: string');
    const without = buildExecutePrompt(base);
    expect(without).not.toContain("Continuity visibility rules:");
    expect(without).not.toContain("teamRelevance");
  });
});

describe("buildStagedCandidateRow — the visibility stamp", () => {
  const base = {
    id: "cand_1",
    agentId: "a",
    claim: "c",
    sourceMemoryIds: ["m1"],
    rationalePrompt: "p",
    generatedBy: "default",
    generatedAt: NOW.toISOString(),
    scope: "tagged",
    tag: TAG,
  };
  test("an affirmative ruling stamps visibilityRuling + visibilityRationale on the row", () => {
    const row = buildStagedCandidateRow({ ...base, visibilityRuling: { ruling: "shared", rationale: "team gates on it" } });
    expect(row.visibilityRuling).toBe("shared");
    expect(row.visibilityRationale).toBe("team gates on it");
    expect(row.scopeTag).toBe(TAG);
  });
  test("null/absent ruling stamps NOTHING (absent = private default, never an explicit value)", () => {
    for (const row of [buildStagedCandidateRow({ ...base, visibilityRuling: null }), buildStagedCandidateRow(base)]) {
      expect("visibilityRuling" in row).toBe(false);
      expect("visibilityRationale" in row).toBe(false);
    }
  });
});

describe("memoryMatchesReflectScope — journal containment, both directions", () => {
  const journalRow = { tags: [TAG], createdAt: FRESH, durability: "ephemeral" };
  // A promoted row PRESERVES the session scopeTag but is persistent.
  const promotedRow = { tags: [TAG, "nightly-rem-promoted", "auto-promoted"], createdAt: FRESH, durability: "persistent" };
  const sinceDate = new Date("2026-08-19T12:00:00.000Z");

  test("a journal row is admitted ONLY by its own session's tagged run", () => {
    expect(memoryMatchesReflectScope(journalRow, { scope: "tagged", tag: TAG, sinceDate })).toBe(true);
  });
  test("scope:'recent' and scope:'all' refuse journal rows (a live session must not ride the generic distill)", () => {
    // Mutation check (run red during development): drop the containment
    // branch → these go red.
    expect(memoryMatchesReflectScope(journalRow, { scope: "recent", sinceDate })).toBe(false);
    expect(memoryMatchesReflectScope(journalRow, { scope: "all", sinceDate })).toBe(false);
  });
  test("a tagged run for a DIFFERENT tag refuses a journal row even when the row carries that other tag too", () => {
    const dualTagged = { tags: ["adk:app:alice", TAG], createdAt: FRESH, durability: "ephemeral" };
    expect(memoryMatchesReflectScope(dualTagged, { scope: "tagged", tag: "adk:app:alice", sinceDate })).toBe(false);
    expect(memoryMatchesReflectScope(dualTagged, { scope: "tagged", tag: TAG, sinceDate })).toBe(true);
  });
  test("NO FEEDBACK LOOP: a continuity tagged run refuses the PROMOTED row carrying the preserved scopeTag", () => {
    // Without the ephemeral bound, a re-distill of the same session would
    // gather its own previous distillation outputs as input.
    expect(memoryMatchesReflectScope(promotedRow, { scope: "tagged", tag: TAG, sinceDate })).toBe(false);
  });
  test("promoted rows stay re-reflectable under the NORMAL scopes (they are ordinary durable memories)", () => {
    expect(memoryMatchesReflectScope(promotedRow, { scope: "recent", sinceDate })).toBe(true);
    expect(memoryMatchesReflectScope(promotedRow, { scope: "all", sinceDate })).toBe(true);
  });
  test("non-journal rows keep the pre-slice-3 behavior byte-for-byte", () => {
    const plain = { tags: ["adk:app:alice"], createdAt: FRESH };
    expect(memoryMatchesReflectScope(plain, { scope: "tagged", tag: "adk:app:alice", sinceDate })).toBe(true);
    expect(memoryMatchesReflectScope(plain, { scope: "recent", sinceDate })).toBe(true);
    expect(memoryMatchesReflectScope(plain, { scope: "all", sinceDate })).toBe(true);
  });
});

describe("decidePromotedVisibility (auto-promote path) — default-private-unless", () => {
  test("THE DEFAULT IS PRIVATE: empty candidate, no ruling, no rationale", () => {
    // Mutation check (run red during development): flip the function's
    // fallback returns to "shared" → this test fails.
    expect(decidePromotedVisibility({})).toBe("private");
    expect(decidePromotedVisibility({ scopeTag: TAG })).toBe("private");
  });
  test("continuity + affirmative ruling + recorded rationale → shared (the ONLY widening path)", () => {
    expect(
      decidePromotedVisibility({ scopeTag: TAG, visibilityRuling: "shared", visibilityRationale: "the team gates merges on this decision" }),
    ).toBe("shared");
  });
  test("continuity + shared ruling WITHOUT rationale → private (not affirmative)", () => {
    expect(decidePromotedVisibility({ scopeTag: TAG, visibilityRuling: "shared" })).toBe("private");
    expect(decidePromotedVisibility({ scopeTag: TAG, visibilityRuling: "shared", visibilityRationale: "  " })).toBe("private");
  });
  test("an ADK per-user candidate NEVER widens, even with a full ruling (the #1205b-2 invariant)", () => {
    expect(
      decidePromotedVisibility({ scopeTag: "adk:app:alice", visibilityRuling: "shared", visibilityRationale: "irrelevant" }),
    ).toBe("private");
  });
  test("an unknown ruling value never widens (unknown must mean safe)", () => {
    expect(decidePromotedVisibility({ scopeTag: TAG, visibilityRuling: "Shared", visibilityRationale: "x" })).toBe("private");
    expect(decidePromotedVisibility({ scopeTag: TAG, visibilityRuling: "org", visibilityRationale: "x" })).toBe("private");
  });
  test("continuity candidates remain ELIGIBLE for the unattended sweep (decideAutoPromote admits the scopeTag)", () => {
    const d = decideAutoPromote({ status: "pending", claim: "Decided X because Y", scopeTag: TAG });
    expect(d.promote).toBe(true);
    if (d.promote) expect(d.scopeTag).toBe(TAG);
  });
});

describe("derivePromotedVisibility (human `rem promote` path) — the same posture", () => {
  test("continuity candidate with no ruling → explicit private (never the durability default)", () => {
    // Mutation check (run red during development): return undefined (or
    // "shared") for the continuity-no-ruling case → this test fails. An
    // undefined here would let Memory's persistent→shared durability default
    // widen the row silently.
    expect(derivePromotedVisibility({ scopeTag: TAG })).toBe("private");
    expect(derivePromotedVisibility({ scopeTag: TAG, visibilityRuling: "shared" })).toBe("private");
  });
  test("continuity + affirmative ruling + rationale → shared", () => {
    expect(derivePromotedVisibility({ scopeTag: TAG, visibilityRuling: "shared", visibilityRationale: "team-blocking decision" })).toBe("shared");
  });
  test("NON-continuity candidates return undefined — pre-slice-3 behavior deliberately untouched", () => {
    expect(derivePromotedVisibility({ scopeTag: "adk:app:alice" })).toBeUndefined();
    expect(derivePromotedVisibility({})).toBeUndefined();
    expect(derivePromotedVisibility({ scopeTag: null })).toBeUndefined();
  });
});
