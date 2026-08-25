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
 * MERGE vs native /mcp PREFER (deliberate, named — Sherlock #1404):
 * native `recordUsage` in resources/mcp-tools.ts prefers `memoryIds` and
 * drops `memoryId` when both are supplied (`Array.isArray(args?.memoryIds)
 * ? args.memoryIds : [args.memoryId]`). This stdio helper MERGES them, then
 * dedupes. A client that fills both fields (common when an agent echoes
 * the singular convenience into a list) would silently lose the singular
 * id on the native path; dropping a citation here would reopen the
 * usageCount hole this issue exists to close. Server-side
 * `RecordUsage.post()` already unions `memoryIds` / `memoryId` the same
 * way (`data?.memoryIds ?? [data?.memoryId]` is prefer, but once we send
 * a merged `memoryIds` array the endpoint sees one list). Do not "align"
 * this helper to the native prefer — the merge is the intended stdio
 * behavior; native prefer is pre-existing and out of this issue's scope.
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
