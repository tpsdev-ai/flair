/**
 * flair#1147 — the usage-feedback loop on the stdio MCP surface.
 *
 * Native `/mcp` already exposes `record_usage` and `memory_store.usedMemoryIds`.
 * The stdio package (`@tpsdev-ai/flair-mcp`) did not, so a Claude Code / Cursor
 * client had no way to reach POST /RecordUsage. These helpers are the thin
 * client-side half: body construction for that endpoint, citation passthrough
 * on write, and the one-line "cite what you use" nudge on recalled ids.
 *
 * Identity is NEVER in the body — RecordUsage attributes from the signed
 * request, same no-forge contract as flair_workspace_set / flair_orgevent.
 */

/** One-line instruction on recalled ids (issue ask #3). Search/bootstrap hits are not usage. */
export const CITE_USAGE_NUDGE =
  "Cite memories you actually use via record_usage (or memory_store.usedMemoryIds). A search or bootstrap hit is not usage.";

export function withCiteNudge(text: string): string {
  if (!text) return text;
  return `${text}\n\n${CITE_USAGE_NUDGE}`;
}

/**
 * Build the POST /RecordUsage body from the MCP tool args.
 * Accepts singular `memoryId` and/or `memoryIds`. Returns null when there is
 * nothing to send (the tool should fail locally rather than POST an empty list).
 * Never includes agentId — the server attributes from the signature.
 *
 * MERGE vs PREFER (deliberate, named — Sherlock/Kern #1404):
 * This helper MERGES `memoryId` + `memoryIds`, then dedupes. Native `/mcp`
 * `recordUsage` (resources/mcp-tools.ts) PREFERS `memoryIds` and drops
 * `memoryId` when both are supplied. The HTTP endpoint does the same:
 * `RecordUsage.post()` is `data?.memoryIds ?? [data?.memoryId]` — PREFER,
 * not union. If `memoryIds` is present (even `[]`, which is truthy),
 * `memoryId` is never read.
 *
 * The stdio merge is load-bearing because it flattens first: we send only
 * a single `memoryIds` array, so the server's prefer is never exercised
 * on two fields. A future path that POSTs both fields through to
 * `/RecordUsage` without flattening would silently drop `memoryId`
 * (delivered-but-uncounted; empty `memoryIds: []` alongside a real
 * `memoryId` would 400 rather than fall through).
 *
 * Native prefer is a pre-existing delivered-but-uncounted bug on a
 * different surface, tracked in flair#1410 — not a regression from this
 * PR, and not a blocker for #1147. Do not "align" this helper to prefer.
 */
export function buildRecordUsageBody(args: {
  memoryId?: string;
  memoryIds?: string[];
  attribution?: string;
}): { memoryIds: string[]; attribution?: string } | null {
  const ids: string[] = [];
  if (Array.isArray(args.memoryIds)) {
    for (const id of args.memoryIds) {
      if (typeof id === "string" && id.length > 0) ids.push(id);
    }
  }
  if (typeof args.memoryId === "string" && args.memoryId.length > 0) {
    ids.push(args.memoryId);
  }
  const memoryIds = [...new Set(ids)];
  if (memoryIds.length === 0) return null;
  const body: { memoryIds: string[]; attribution?: string } = { memoryIds };
  if (typeof args.attribution === "string" && args.attribution.length > 0) {
    body.attribution = args.attribution;
  }
  return body;
}

/**
 * Citation-on-write passthrough. Only returns a list when the caller actually
 * supplied a non-empty array of non-empty strings — omitted/empty is undefined
 * so the write body stays byte-identical to a pre-#1147 write.
 */
export function citationIds(usedMemoryIds?: string[]): string[] | undefined {
  if (!Array.isArray(usedMemoryIds) || usedMemoryIds.length === 0) return undefined;
  if (!usedMemoryIds.every((id) => typeof id === "string" && id.length > 0)) return undefined;
  return usedMemoryIds;
}
