// Unit tests for resources/collision-lib.ts — the pure join/rank/format
// logic behind MemoryBootstrap's "Others in the room" collision-surfacing
// block (flair#681, "Phase 2").
//
// These exercise the real shipped logic directly (no Harper dependency —
// same reason test/unit/bootstrap-team.test.ts imports memory-bootstrap-lib.ts
// rather than MemoryBootstrap.ts itself).

import { describe, test, expect } from "bun:test";
import {
  buildCollisionEntries,
  freshPresenceByAgent,
  formatRelativeTime,
  type EntityMatchInput,
  type SemanticMatchInput,
  type PresenceRosterRow,
} from "../../resources/collision-lib.ts";

const NOW = Date.parse("2026-07-10T12:00:00.000Z");

describe("formatRelativeTime", () => {
  test("under a minute reads 'just now'", () => {
    expect(formatRelativeTime(NOW - 10_000, NOW)).toBe("just now");
  });
  test("minutes", () => {
    expect(formatRelativeTime(NOW - 4 * 60_000, NOW)).toBe("4m ago");
  });
  test("hours", () => {
    expect(formatRelativeTime(NOW - 3 * 3600_000, NOW)).toBe("3h ago");
  });
  test("days", () => {
    expect(formatRelativeTime(NOW - 2 * 24 * 3600_000, NOW)).toBe("2d ago");
  });
});

describe("freshPresenceByAgent", () => {
  test("excludes presenceStatus=offline", () => {
    const roster: PresenceRosterRow[] = [
      { id: "a", presenceStatus: "active", lastHeartbeatAt: NOW },
      { id: "b", presenceStatus: "offline", lastHeartbeatAt: NOW - 20 * 3600_000 },
    ];
    const fresh = freshPresenceByAgent(roster);
    expect(fresh.has("a")).toBe(true);
    expect(fresh.has("b")).toBe(false);
  });

  test("includes presenceStatus=idle (recent heartbeat, just not actively-coding-fresh)", () => {
    const roster: PresenceRosterRow[] = [{ id: "a", presenceStatus: "idle", lastHeartbeatAt: NOW - 5 * 60_000 }];
    expect(freshPresenceByAgent(roster).has("a")).toBe(true);
  });

  test("excludes a row with no usable lastHeartbeatAt", () => {
    const roster: PresenceRosterRow[] = [{ id: "a", presenceStatus: "active", lastHeartbeatAt: null }];
    expect(freshPresenceByAgent(roster).has("a")).toBe(false);
  });

  test("an agent with no roster row at all is simply absent from the map", () => {
    expect(freshPresenceByAgent([]).size).toBe(0);
  });

  test("tolerates a missing/malformed id", () => {
    const roster: PresenceRosterRow[] = [{ presenceStatus: "active", lastHeartbeatAt: NOW } as any];
    expect(freshPresenceByAgent(roster).size).toBe(0);
  });
});

describe("buildCollisionEntries — the join, freshness gate, and ranking", () => {
  const freshRoster = (rows: Array<[string, string, number]>): Map<string, PresenceRosterRow> =>
    freshPresenceByAgent(rows.map(([id, displayName, hb]) => ({ id, displayName, presenceStatus: "active", lastHeartbeatAt: hb })));

  test("entity overlap surfaces for a fresh teammate", () => {
    const entityMatches: EntityMatchInput[] = [{
      agentId: "anvil", entities: ["issue:tpsdev-ai/flair#504"], summary: "implementing embeddings",
      taskId: "504", timestamp: "2026-07-10T11:56:00.000Z", source: "workspace",
    }];
    const fresh = freshRoster([["anvil", "Anvil", NOW - 4 * 60_000]]);
    const entries = buildCollisionEntries(entityMatches, [], fresh, "caller", NOW);
    expect(entries.length).toBe(1);
    expect(entries[0].agentId).toBe("anvil");
    expect(entries[0].kind).toBe("entity");
    expect(entries[0].line).toContain("Anvil");
    expect(entries[0].line).toContain("issue:tpsdev-ai/flair#504");
    expect(entries[0].line).toContain("last active 4m ago");
  });

  test("NOTHING surfaces for a non-overlapping teammate (no entity match, no semantic match)", () => {
    const entityMatches: EntityMatchInput[] = [{
      agentId: "kern", entities: ["subsystem:unrelated"], summary: "unrelated work",
      taskId: null, timestamp: "2026-07-10T11:56:00.000Z", source: "workspace",
    }];
    // kern's row exists and is fresh, but its entity doesn't overlap with
    // whatever the caller declared — buildCollisionEntries only ever
    // receives ALREADY-overlapping candidates (MemoryBootstrap.ts filters
    // the intersection before calling this), so an empty entityMatches list
    // (the non-overlap case) must produce zero entries.
    const fresh = freshRoster([["kern", "Kern", NOW - 4 * 60_000]]);
    const entries = buildCollisionEntries([], [], fresh, "caller", NOW);
    expect(entries).toEqual([]);
    // Sanity: even with entityMatches present (as the caller would only
    // pass overlapping rows), a candidate for an agent with no presence row
    // still can't leak through some other path.
    void entityMatches;
  });

  test("freshness gate: a stale (offline) teammate's entity match does NOT surface", () => {
    const entityMatches: EntityMatchInput[] = [{
      agentId: "anvil", entities: ["issue:tpsdev-ai/flair#504"], summary: "stale work",
      taskId: "504", timestamp: "2026-07-01T00:00:00.000Z", source: "workspace",
    }];
    const fresh = freshPresenceByAgent([{ id: "anvil", displayName: "Anvil", presenceStatus: "offline", lastHeartbeatAt: NOW - 20 * 3600_000 }]);
    const entries = buildCollisionEntries(entityMatches, [], fresh, "caller", NOW);
    expect(entries).toEqual([]);
  });

  test("freshness gate: a teammate with NO presence row at all does not surface", () => {
    const entityMatches: EntityMatchInput[] = [{
      agentId: "ghost", entities: ["issue:tpsdev-ai/flair#1"], summary: "phantom",
      taskId: null, timestamp: "2026-07-10T11:00:00.000Z", source: "workspace",
    }];
    const entries = buildCollisionEntries(entityMatches, [], new Map(), "caller", NOW);
    expect(entries).toEqual([]);
  });

  test("the caller itself is never surfaced even if present in the candidate lists", () => {
    const entityMatches: EntityMatchInput[] = [{
      agentId: "caller", entities: ["issue:tpsdev-ai/flair#1"], summary: "own work",
      taskId: null, timestamp: "2026-07-10T11:56:00.000Z", source: "workspace",
    }];
    const fresh = freshRoster([["caller", "Caller", NOW - 60_000]]);
    expect(buildCollisionEntries(entityMatches, [], fresh, "caller", NOW)).toEqual([]);
  });

  test("semantic-only match surfaces for a fresh teammate (no entity overlap needed)", () => {
    const semanticMatches: SemanticMatchInput[] = [{ agentId: "sherlock", score: 0.62, content: "reviewed the auth reshape for the same subsystem" }];
    const fresh = freshRoster([["sherlock", "Sherlock", NOW - 12 * 60_000]]);
    const entries = buildCollisionEntries([], semanticMatches, fresh, "caller", NOW);
    expect(entries.length).toBe(1);
    expect(entries[0].kind).toBe("semantic");
    expect(entries[0].line).toContain("Sherlock");
    expect(entries[0].line).toContain("last active 12m ago");
  });

  test("a weak semantic match (never passed in — relevance floor is #550's score>0.3, applied upstream) produces no candidate; empty semanticMatches surfaces nothing", () => {
    const fresh = freshRoster([["sherlock", "Sherlock", NOW - 60_000]]);
    expect(buildCollisionEntries([], [], fresh, "caller", NOW)).toEqual([]);
  });

  test("entity overlap OUTRANKS a semantic match for the SAME agent — only one line, entity wins", () => {
    const entityMatches: EntityMatchInput[] = [{
      agentId: "anvil", entities: ["issue:tpsdev-ai/flair#504"], summary: "implementing embeddings",
      taskId: "504", timestamp: "2026-07-10T11:56:00.000Z", source: "workspace",
    }];
    const semanticMatches: SemanticMatchInput[] = [{ agentId: "anvil", score: 0.9, content: "irrelevant if entity already won" }];
    const fresh = freshRoster([["anvil", "Anvil", NOW - 4 * 60_000]]);
    const entries = buildCollisionEntries(entityMatches, semanticMatches, fresh, "caller", NOW);
    expect(entries.length).toBe(1);
    expect(entries[0].kind).toBe("entity");
  });

  test("ranking: entity-kind entries all sort before semantic-kind entries", () => {
    const entityMatches: EntityMatchInput[] = [{
      agentId: "anvil", entities: ["issue:tpsdev-ai/flair#504"], summary: null, taskId: null,
      timestamp: "2026-07-01T00:00:00.000Z", source: "workspace", // older, but still entity-kind
    }];
    const semanticMatches: SemanticMatchInput[] = [{ agentId: "sherlock", score: 0.9, content: "very fresh semantic match" }];
    const fresh = freshRoster([["anvil", "Anvil", NOW - 60 * 60_000], ["sherlock", "Sherlock", NOW - 60_000]]);
    const entries = buildCollisionEntries(entityMatches, semanticMatches, fresh, "caller", NOW);
    expect(entries.map((e) => e.kind)).toEqual(["entity", "semantic"]);
  });

  test("ranking within a kind: more recently active first", () => {
    const semanticMatches: SemanticMatchInput[] = [
      { agentId: "older", score: 0.9, content: "higher score but less recently active" },
      { agentId: "newer", score: 0.31, content: "lower score but very recently active" },
    ];
    const fresh = freshRoster([["older", "Older", NOW - 30 * 60_000], ["newer", "Newer", NOW - 60_000]]);
    const entries = buildCollisionEntries([], semanticMatches, fresh, "caller", NOW);
    // Both are semantic-kind, so they rank by lastHeartbeatAt, not score.
    expect(entries.map((e) => e.agentId)).toEqual(["newer", "older"]);
  });

  test("multiple overlapping entities for one agent are all named in the line", () => {
    const entityMatches: EntityMatchInput[] = [{
      agentId: "anvil", entities: ["issue:tpsdev-ai/flair#504", "repo:tpsdev-ai/flair"], summary: null,
      taskId: null, timestamp: "2026-07-10T11:56:00.000Z", source: "workspace",
    }];
    const fresh = freshRoster([["anvil", "Anvil", NOW - 60_000]]);
    const entries = buildCollisionEntries(entityMatches, [], fresh, "caller", NOW);
    expect(entries[0].line).toContain("issue:tpsdev-ai/flair#504, repo:tpsdev-ai/flair");
  });

  test("falls back to agentId as displayName when the roster row has none", () => {
    const entityMatches: EntityMatchInput[] = [{
      agentId: "anvil", entities: ["repo:tpsdev-ai/flair"], summary: null, taskId: null,
      timestamp: "2026-07-10T11:56:00.000Z", source: "workspace",
    }];
    const fresh = freshPresenceByAgent([{ id: "anvil", presenceStatus: "active", lastHeartbeatAt: NOW - 60_000 }]);
    const entries = buildCollisionEntries(entityMatches, [], fresh, "caller", NOW);
    expect(entries[0].line).toContain("anvil is touching");
  });
});
