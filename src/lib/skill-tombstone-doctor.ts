/**
 * skill-tombstone-doctor.ts — the `flair doctor` check for skill subjects whose
 * newest InstructionVersion is a `delete` tombstone while the skill's Memory
 * row is still open-live (flair#2662).
 *
 * A skill DELETE appends a tombstone and closes the live Memory row. When the
 * post-commit confirmation cannot read the close, the tombstone can commit
 * while the row stays open-live. This check reports that inconsistency; it
 * never repairs it.
 *
 * "Open-live" is the skill writer's own predicate (isOpenLiveRow): not
 * archived, not expired, and no `validTo`. An archived or expired row under a
 * tombstone is not reported.
 *
 * The decision reads only the row fields and the current time. The reads use the operations API and return null on a
 * failed read (never an empty list), so a doctor that cannot read the tables
 * reports the check as unrun rather than passed when this section runs. When
 * Harper is not responding, the enclosing gate skips the section and doctor
 * reports the server problem elsewhere.
 */

import { isOpenLiveRow } from "./open-live-row.js";

export const SKILL_TOMBSTONE_VERSION_ROWS_SQL =
  "SELECT id, subjectType, subjectId, version, kind, rowId FROM flair.InstructionVersion WHERE subjectType = 'skill'";
export const SKILL_TOMBSTONE_MEMORY_ROWS_SQL =
  "SELECT id, skillSubjectId, validTo, archived, expiresAt FROM flair.Memory";

export interface SkillVersionRow {
  id?: unknown;
  subjectType?: unknown;
  subjectId?: unknown;
  version?: unknown;
  kind?: unknown;
  rowId?: unknown;
}

export interface SkillMemoryRow {
  id?: unknown;
  skillSubjectId?: unknown;
  validTo?: unknown;
  archived?: unknown;
  expiresAt?: unknown;
}

export interface LiveSkillTombstone {
  subjectId: string;
  tombstoneId: string;
  liveRowId: string;
}

function versionSequence(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isInteger(value) ? BigInt(value) : null;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

/** The skill writer's open-live predicate, applied to a row read from Memory. */
function memoryRowIsOpenLive(row: SkillMemoryRow): boolean {
  return isOpenLiveRow(row as Record<string, any>);
}

function rowIdOf(row: { id?: unknown }): string | null {
  return typeof row.id === "string" && row.id.length > 0 ? row.id : null;
}

/**
 * Every skill subject whose newest InstructionVersion is a `delete` tombstone
 * and whose Memory row is still open-live, sorted by subject id. A closed,
 * archived, expired or absent Memory row passes.
 */
export function findLiveSkillTombstones(
  versions: readonly SkillVersionRow[],
  memories: readonly SkillMemoryRow[],
): LiveSkillTombstone[] {
  const heads = new Map<string, { version: bigint; row: SkillVersionRow }>();
  for (const row of versions) {
    if (!row || typeof row !== "object" || row.subjectType !== "skill") continue;
    if (typeof row.subjectId !== "string" || row.subjectId.length === 0) continue;
    const version = versionSequence(row.version);
    if (version === null) continue;
    const current = heads.get(row.subjectId);
    if (!current || version > current.version) heads.set(row.subjectId, { version, row });
  }

  const liveRowIdBySubject = new Map<string, string>();
  const liveRowsById = new Map<string, SkillMemoryRow>();
  for (const memory of memories) {
    if (!memory || typeof memory !== "object" || !memoryRowIsOpenLive(memory)) continue;
    const id = rowIdOf(memory);
    if (id === null) continue;
    liveRowsById.set(id, memory);
    if (typeof memory.skillSubjectId !== "string") continue;
    const current = liveRowIdBySubject.get(memory.skillSubjectId);
    if (current === undefined || id < current) liveRowIdBySubject.set(memory.skillSubjectId, id);
  }

  const findings: LiveSkillTombstone[] = [];
  for (const [subjectId, { row }] of heads) {
    if (row.kind !== "delete") continue;
    const tombstoneRowId = typeof row.rowId === "string" && row.rowId.length > 0 ? row.rowId : null;
    let liveRowId = liveRowIdBySubject.get(subjectId);
    if (tombstoneRowId !== null && liveRowsById.has(tombstoneRowId) &&
        (liveRowId === undefined || tombstoneRowId < liveRowId)) liveRowId = tombstoneRowId;
    if (liveRowId === undefined) continue;
    findings.push({
      subjectId,
      tombstoneId: rowIdOf(row) ?? "(no id)",
      liveRowId,
    });
  }
  return findings.sort((a, b) => (a.subjectId < b.subjectId ? -1 : a.subjectId > b.subjectId ? 1 : 0));
}

/** The doctor line for a live-tombstone set: null when the store is clean. */
export function describeLiveSkillTombstones(
  versions: readonly SkillVersionRow[],
  memories: readonly SkillMemoryRow[],
): string | null {
  const findings = findLiveSkillTombstones(versions, memories);
  if (findings.length === 0) return null;
  const rows = findings
    .map(({ subjectId, tombstoneId, liveRowId }) => `${subjectId} (tombstone ${tombstoneId}, live row ${liveRowId})`)
    .join(", ");
  const noun = findings.length === 1 ? "subject" : "subjects";
  const verb = findings.length === 1 ? "has" : "have";
  return `${findings.length} skill ${noun} whose newest InstructionVersion is a delete tombstone still ${verb} an open-live Memory row: ${rows}`;
}

interface Tables {
  versions: SkillVersionRow[];
  memories: SkillMemoryRow[];
}

/** Read both tables through the ops API; null when either read fails. */
export async function readSkillTombstoneTables(args: {
  opsUrl: string;
  authHeader: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<Tables | null> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const read = async (sql: string): Promise<unknown[] | null> => {
    try {
      const res = await fetchImpl(args.opsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: args.authHeader },
        body: JSON.stringify({ operation: "sql", sql }),
        signal: AbortSignal.timeout(args.timeoutMs ?? 5000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data) ? data : Array.isArray((data as any)?.results) ? (data as any).results : null;
    } catch {
      return null;
    }
  };
  const versions = await read(SKILL_TOMBSTONE_VERSION_ROWS_SQL);
  const memories = await read(SKILL_TOMBSTONE_MEMORY_ROWS_SQL);
  if (versions === null || memories === null) return null;
  return {
    versions: versions as SkillVersionRow[],
    memories: memories as SkillMemoryRow[],
  };
}
