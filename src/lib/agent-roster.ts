/**
 * agent-roster.ts — the complete Agent roster read `flair doctor` uses for its
 * agent-ID check (flair#2359).
 *
 * SQL is the ops-API operation that reads the whole table: `search_by_conditions`
 * needs at least one condition, and any condition can hide a row.
 */

/** The ops-API `sql` read of every Agent row's id. */
export const AGENT_ROSTER_SQL = "SELECT id FROM flair.Agent";

/**
 * Read every Agent row's id through the operations API. Returns the row list on
 * a successful read, or null when the call failed or its body was not a row
 * list — a failed read is never "no rows". The caller validates each id.
 */
export async function readAgentRoster(args: {
  opsUrl: string;
  authHeader: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<Array<{ id?: unknown }> | null> {
  const fetchImpl = args.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(args.opsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: args.authHeader },
      body: JSON.stringify({ operation: "sql", sql: AGENT_ROSTER_SQL }),
      signal: AbortSignal.timeout(args.timeoutMs ?? 5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const rows = Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : null;
    return rows as Array<{ id?: unknown }> | null;
  } catch {
    return null;
  }
}
