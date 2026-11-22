/**
 * instruction-event-contract.ts — the shared reserved-event predicate
 * (flair#2139 slice 3a). Kept in `src/lib` so both the OrgEvent resource and
 * the `flair doctor` check import one definition without crossing the CLI
 * build's rootDir.
 */

export const RESERVED_EVENT_KINDS: readonly string[] = Object.freeze(["soul.changed", "skill.changed"]);
export const RESERVED_EVENT_ID_PREFIX = "instruction-change:";

/** Whether a record carries a reserved kind or id prefix. Non-records are not reserved. */
export function isReservedEventRecord(record: unknown): boolean {
  if (record == null || typeof record !== "object" || Array.isArray(record)) return false;
  const { kind, id } = record as { kind?: unknown; id?: unknown };
  if (typeof kind === "string" && RESERVED_EVENT_KINDS.includes(kind)) return true;
  return typeof id === "string" && id.startsWith(RESERVED_EVENT_ID_PREFIX);
}
