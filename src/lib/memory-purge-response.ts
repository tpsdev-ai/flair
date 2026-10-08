/**
 * The ids a POST /MemoryPurge response lists as removed. Throws when the
 * response is not `{ removed, removedIds }` with `removed` equal to the list's
 * length, or when the list leaves out a requested id.
 */
export function confirmedPurgeIds(response: unknown, requested: readonly string[]): string[] {
  const body = response as { removed?: unknown; removedIds?: unknown } | null | undefined;
  const removedIds = body?.removedIds;
  if (
    !Array.isArray(removedIds) ||
    !removedIds.every((id) => typeof id === "string") ||
    body?.removed !== removedIds.length
  ) {
    throw new Error(
      `POST /MemoryPurge returned a response that does not list the removed rows: ${String(JSON.stringify(response)).slice(0, 200)}`,
    );
  }
  const removed = new Set<string>(removedIds);
  const unconfirmed = requested.filter((id) => !removed.has(id));
  if (unconfirmed.length > 0) {
    throw new Error(
      `POST /MemoryPurge did not list ${unconfirmed.length} requested row(s) as removed: ${unconfirmed.slice(0, 5).join(", ")}`,
    );
  }
  return removedIds;
}
