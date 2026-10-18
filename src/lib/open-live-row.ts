/**
 * open-live-row.ts — the skill writer's "open live" Memory-row predicate
 * (flair#2662), shared so `flair doctor` asks the same question the writer
 * answers. PURE: field checks only. Deliberately imports nothing (resources
 * importing this compiled helper require it to be load-free).
 *
 * A row is open-live when it is not archived, is not expired (`expiresAt`
 * absent, or a string later than now), and carries no `validTo`.
 */
export function isOpenLiveRow(row: Record<string, any> | null | undefined): boolean {
  if (!row || typeof row !== "object") return false;
  if (row.archived === true) return false;
  if (row.expiresAt != null && (typeof row.expiresAt !== "string" || !(Date.parse(row.expiresAt) > Date.now()))) return false;
  if (typeof row.validTo === "string" && row.validTo.length > 0) return false;
  return true;
}
