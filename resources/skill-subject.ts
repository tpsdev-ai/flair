/**
 * skill-subject.ts — the STABLE logical subject id of a skill lineage
 * (flair#2139 S2). Pure: no Harper imports, so it is unit-testable and callable
 * from every skill writer.
 *
 * Memory.skillSubjectId survives supersession and in-place writes.
 *
 * Derivation, in the one order the spec pins:
 *   1. An EXPLICIT successor (`supersedes` set) inherits its predecessor's
 *      established subject, or — on first enrollment — adopts the predecessor's
 *      physical ID.
 *   2. Otherwise the row's own stored `skillSubjectId` (carry-over) is used.
 *   3. Otherwise first enrollment of an existing skill row uses that row's
 *      physical ID.
 *   4. Otherwise a brand-new skill derives it from its FIRST physical Memory ID
 *      (the new row's own id).
 *
 * It is NEVER derived from a name, a content hash, client metadata, or a
 * successor's fresh id when an established subject exists. A client- or
 * body-supplied `skillSubjectId` is never read (see
 * memory-declared-attributes.ts's SERVER_STAMPED_MEMORY_FIELDS, which strips it
 * from every write body).
 */

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export interface SkillSubjectInput {
  /** The fresh physical Memory id being written (for a create) or created. */
  newPhysicalId: string;
  /** The stored row the caller addressed, when one exists. */
  storedHead?: { id?: unknown; skillSubjectId?: unknown } | null;
  /** The explicit `supersedes` predecessor row, when the caller named one. */
  predecessor?: { id?: unknown; skillSubjectId?: unknown } | null;
}

/**
 * The stable logical subject id for a skill write. Deterministic and total: as
 * long as `newPhysicalId` is non-empty it returns a non-empty id.
 */
export function deriveSkillSubjectId(input: SkillSubjectInput): string {
  const { newPhysicalId, storedHead, predecessor } = input;
  const predecessorSubject = nonEmptyString(predecessor?.skillSubjectId);
  if (predecessorSubject) return predecessorSubject;
  const predecessorId = nonEmptyString(predecessor?.id);
  if (predecessorId) return predecessorId;
  const carried = nonEmptyString(storedHead?.skillSubjectId);
  if (carried) return carried;
  const storedId = nonEmptyString(storedHead?.id);
  if (storedId) return storedId;
  return newPhysicalId;
}

/** The subject id to stamp on a successor: the predecessor's established
 *  subject, else the predecessor's id, else its own (a fresh standalone row). */
export function carrySkillSubjectId(
  predecessor: { id?: unknown; skillSubjectId?: unknown } | null | undefined,
  fallbackId: string,
): string {
  return nonEmptyString(predecessor?.skillSubjectId)
    ?? nonEmptyString(predecessor?.id)
    ?? fallbackId;
}
