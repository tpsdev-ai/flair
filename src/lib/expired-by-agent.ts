/** Named agents in the warning before the remainder is folded into a count. */
export const EXPIRED_BY_AGENT_NAMED_MAX = 5;

/** Facts about the local REM nightly driver, from the scheduler file paths status/doctor check. */
export interface NightlyDriverFacts {
  /** Plist present, or both Linux timer and service present; null = unknown. */
  installed: boolean | null;
  /** The agent named by the scheduler file. */
  agent: string | null;
  /** Whether `agent` is known: a present but unreadable unit is UNKNOWN, not "no driver". */
  agentKnown: boolean;
}

export interface ExpiredAgentEntry {
  agentId: string;
  count: number;
  /** Installed nightly scheduler whose plist or service names this agent; null = unknown. */
  nightlyDriverInstalled: boolean | null;
}

export interface ExpiredByAgent {
  /** Named agents, most expired rows first. Default limit: EXPIRED_BY_AGENT_NAMED_MAX. */
  agents: ExpiredAgentEntry[];
  /** Named agents with at least one expired row. */
  agentCount: number;
  /** All expired rows, including rows with no agent id. */
  total: number;
  /** Expired rows owned by agents the named list does not include. */
  remainderCount: number;
  /** Expired rows with no agent id. */
  unownedCount: number;
}

export function summarizeExpiredByAgent(
  counts: Iterable<readonly [string, number]>,
  driver: NightlyDriverFacts,
  max: number = EXPIRED_BY_AGENT_NAMED_MAX,
): ExpiredByAgent {
  const positive = [...counts].filter(([, n]) => n > 0);
  const entries = positive.filter(([id]) => id !== "");
  entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const keep = Math.max(0, max);
  const named = entries.slice(0, keep);
  const rest = entries.slice(keep);
  const installedFor = (agentId: string): boolean | null =>
    driver.installed !== true ? driver.installed : driver.agentKnown ? agentId === driver.agent : null;
  return {
    agents: named.map(([agentId, count]) => ({ agentId, count, nightlyDriverInstalled: installedFor(agentId) })),
    agentCount: entries.length,
    total: positive.reduce((sum, [, n]) => sum + n, 0),
    remainderCount: rest.reduce((sum, [, n]) => sum + n, 0),
    unownedCount: positive.filter(([id]) => id === "").reduce((sum, [, n]) => sum + n, 0),
  };
}

export function expiredByAgentWarningLines(b: ExpiredByAgent): string {
  if (b.total === 0) return "";
  const lines: string[] = ["    grouped by agent:\n"];
  for (const a of b.agents) {
    const state = a.nightlyDriverInstalled === true
      ? "installed nightly scheduler names this agent"
      : a.nightlyDriverInstalled === false
        ? "NO matching installed nightly scheduler"
        : "nightly driver state unknown";
    lines.push(`      ${a.agentId}: ${a.count} — ${state}\n`);
  }
  const remaining = b.agentCount - b.agents.length;
  if (remaining > 0) lines.push(`      and ${remaining} more agent(s) (${b.remainderCount} expired rows)\n`);
  if (b.unownedCount > 0) lines.push(`      ${b.unownedCount} expired row(s) with no agent id\n`);
  return lines.join("");
}
