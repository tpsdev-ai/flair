/**
 * usage-ids.ts — which memory ids a usage-feedback call credits (flair#1410).
 *
 * `record_usage` / `POST /RecordUsage` accept both singular `memoryId` and
 * plural `memoryIds`. MERGE, not prefer: a caller who supplies both means
 * both. Preferring `memoryIds` (`data?.memoryIds ?? [data?.memoryId]`)
 * silently dropped the singular id — quiet data loss, same class as
 * #1206 / #1371.
 *
 * Pure: no Harper. Native `/mcp` (`resources/mcp-tools.ts`) and the HTTP
 * endpoint (`resources/RecordUsage.ts`) both call this so the credited set
 * does not depend on every client flattening first. Stdio `flair-mcp`
 * merges independently in `buildRecordUsageBody`; the conformance test
 * pins the two surfaces to the same set.
 */

/** Stated on both MCP tool schemas so a caller can predict the merge without reading source. */
export const RECORD_USAGE_ID_MERGE_CONTRACT =
  "When both memoryId and memoryIds are supplied they are merged (union, then deduped) — a caller who passes both means both.";

/**
 * Union `memoryId` + `memoryIds`, then dedupe. Empty / non-string entries
 * in the plural list are skipped (same filter as stdio `buildRecordUsageBody`).
 * Used by native `/mcp` to flatten the tool args before `RecordUsage.post`.
 */
export function unionUsageMemoryIds(memoryId?: unknown, memoryIds?: unknown): string[] {
  const ids: string[] = [];
  if (Array.isArray(memoryIds)) {
    for (const id of memoryIds) {
      if (typeof id === "string" && id.length > 0) ids.push(id);
    }
  }
  if (typeof memoryId === "string" && memoryId.length > 0) {
    ids.push(memoryId);
  }
  return [...new Set(ids)];
}

export type ResolveUsageIdsError = "invalid" | "empty" | "cap";

export type ResolveUsageIdsResult =
  | { ok: true; ids: string[] }
  | { ok: false; error: ResolveUsageIdsError };

/**
 * HTTP-endpoint resolver: union both fields, then apply RecordUsage.post()'s
 * existing validation (non-empty strings, per-call cap on the unique credited
 * set). Cap after dedupe so an overlapping `memoryId` does not 400 a legal
 * unique set that native `/mcp` and stdio already accept. A present-but-invalid
 * `memoryIds` still 400s. The max-20 anti-gaming bound is unchanged — it
 * limits unique ids credited, not raw concatenation length.
 */
export function resolveRecordUsageIds(
  data: { memoryId?: unknown; memoryIds?: unknown } | null | undefined,
  maxIds: number,
): ResolveUsageIdsResult {
  const memoryIds = data?.memoryIds;
  const memoryId = data?.memoryId;

  if (memoryIds != null) {
    if (!Array.isArray(memoryIds) || !memoryIds.every((id) => typeof id === "string" && id.length > 0)) {
      return { ok: false, error: "invalid" };
    }
  }

  const raw: string[] = [];
  if (Array.isArray(memoryIds)) raw.push(...memoryIds);
  if (typeof memoryId === "string" && memoryId.length > 0) raw.push(memoryId);

  if (raw.length === 0) return { ok: false, error: "empty" };
  const ids = [...new Set(raw)];
  if (ids.length > maxIds) return { ok: false, error: "cap" };
  return { ok: true, ids };
}
