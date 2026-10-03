import { describe, expect, test } from "bun:test";
import {
  EXPIRED_BY_AGENT_NAMED_MAX,
  summarizeExpiredByAgent,
  expiredByAgentWarningLines,
  type NightlyDriverFacts,
} from "../../src/lib/expired-by-agent.ts";

const driverFor = (agent: string): NightlyDriverFacts => ({ installed: true, agent, agentKnown: true });

describe("summarizeExpiredByAgent (flair#2231)", () => {
  test("names agents by count, most first, and marks the agent named by the installed scheduler", () => {
    const b = summarizeExpiredByAgent([["bob", 2], ["alice", 3]], driverFor("alice"));
    expect(b.agentCount).toBe(2);
    expect(b.total).toBe(5);
    expect(b.remainderCount).toBe(0);
    expect(b.agents).toEqual([
      { agentId: "alice", count: 3, nightlyDriverInstalled: true },
      { agentId: "bob", count: 2, nightlyDriverInstalled: false },
    ]);
  });

  test("no driver installed flags every named agent", () => {
    const b = summarizeExpiredByAgent([["a", 1], ["b", 1]], { installed: false, agent: null, agentKnown: false });
    expect(b.agents.every((a) => a.nightlyDriverInstalled === false)).toBe(true);
  });

  test("installed but unreadable agent is UNKNOWN, not 'no driver'", () => {
    const b = summarizeExpiredByAgent([["a", 1]], { installed: true, agent: null, agentKnown: false });
    expect(b.agents[0].nightlyDriverInstalled).toBeNull();
    expect(expiredByAgentWarningLines(b)).toContain("nightly driver state unknown");
  });

  test("a failed probe is UNKNOWN, not 'no driver'", () => {
    const b = summarizeExpiredByAgent([["a", 1]], { installed: null, agent: null, agentKnown: false });
    expect(b.agents[0].nightlyDriverInstalled).toBeNull();
  });

  test("bounded: names at most the cap and counts the remainder", () => {
    const counts = Array.from({ length: 9 }, (_, i) => [`agent-${i}`, 10 - i] as const);
    const b = summarizeExpiredByAgent(counts, driverFor("agent-0"));
    expect(b.agents).toHaveLength(EXPIRED_BY_AGENT_NAMED_MAX);
    expect(b.agentCount).toBe(9);
    expect(b.agents.map((a) => a.agentId)).toEqual(["agent-0", "agent-1", "agent-2", "agent-3", "agent-4"]);
    expect(b.remainderCount).toBe(5 + 4 + 3 + 2);
    const text = expiredByAgentWarningLines(b);
    expect(text).toContain("and 4 more agent(s) (14 expired rows)");
    expect(text).not.toContain("agent-8");
  });

  test("deterministic tie-break by agent id", () => {
    const b = summarizeExpiredByAgent([["zeta", 2], ["alpha", 2]], driverFor("alpha"));
    expect(b.agents.map((a) => a.agentId)).toEqual(["alpha", "zeta"]);
  });

  test("rows without an owner are named, not dropped", () => {
    const b = summarizeExpiredByAgent([["", 4]], driverFor("alice"));
    expect(b.agents[0].agentId).toBe("");
    expect(expiredByAgentWarningLines(b)).toContain("(no agent id): 4");
  });

  test("zero expired rows yields an empty, harmless breakdown", () => {
    const b = summarizeExpiredByAgent([], driverFor("alice"));
    expect(b.agents).toEqual([]);
    expect(b.total).toBe(0);
    expect(expiredByAgentWarningLines(b)).toBe("");
  });

  test("warning text groups by agent", () => {
    const b = summarizeExpiredByAgent([["alice", 3], ["bob", 2]], driverFor("alice"));
    const text = expiredByAgentWarningLines(b);
    expect(text).toContain("grouped by agent:");
    expect(text).toContain("alice: 3 — installed nightly scheduler names this agent");
    expect(text).toContain("bob: 2 — NO matching installed nightly scheduler");
  });
});
