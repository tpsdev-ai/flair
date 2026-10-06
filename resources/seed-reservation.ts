/**
 * seed-reservation.ts — reserve the `using-flair` seed's fixed ids for the
 * operator source (flair#2141 S2).
 *
 * Normal `flair init` seeds one skill row at a FIXED Memory id and one org
 * assignment at a FIXED OrgSkillAssignment id that points at it. Re-initializing
 * an already-installed default local instance with `flair init --skip-start`
 * defers the seed until a later `flair start` that has the admin credential.
 * Bootstrap may list the
 * assignment for an active agent when it wins same-name conflict resolution,
 * the agent has not opted out, and the entry fits its budget. The row behind
 * that id must be the operator's. The rule:
 *
 *   A create, PUT, PATCH or DELETE of the reserved Memory id needs the operator
 *   source: an authenticated Basic administrator, or a deliberate internal call
 *   (`soulWriteSource`, the same predicate that gates every OrgSkillAssignment
 *   write). Every other caller is refused, an agent key whose id equals the
 *   administrator's username and an admin agent key included.
 *
 * The decision reads the auth verdict and the request's credential class. It
 * never compares the stored owner with the caller's id: an agent can hold the
 * id the operator's rows are attributed to.
 *
 * The assignment id needs no entry here: every OrgSkillAssignment write
 * already requires the operator source (resources/OrgSkillAssignment.ts), and
 * test/unit/org-skill-assignment-writer-coverage.test.ts pins its writers.
 *
 * Where it applies: Memory post/put/patch/delete, the supersede target, and
 * FeedMemories check caller-chosen ids before writing; federation skips a
 * reserved id (`seed_id_not_federated`). Server bookkeeping is also allowed:
 * lastReflected and embedding backfill update their selected fields. Usage
 * recording intends to change only usageCount, but re-PUTs the stored row and
 * can receive an agent-supplied id. The coverage test classifies raw Memory
 * write sites detected by its supported source patterns; it does not prove
 * that every possible write path is classified.
 */
import { resolveAgentAuth, type AgentAuthVerdict } from "./agent-auth.js";
import { FORBIDDEN, UNAUTH } from "./record-type-kit.js";
import { soulWriteSource } from "./soul-write-policy.js";
import { SEED_SKILL_ROW_ID } from "./seed-ids.js";

export { SEED_SKILL_ROW_ID };

/** Table → ids reserved for the operator source, subject to documented bookkeeping writes. */
export const RESERVED_SEED_IDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Memory: Object.freeze([SEED_SKILL_ROW_ID]),
});

/** Whether `id` is a reserved seed id on `table`. */
export function isReservedSeedId(table: string, id: unknown): boolean {
  if (typeof id !== "string" && typeof id !== "number") return false;
  return (RESERVED_SEED_IDS[table] ?? []).includes(String(id));
}

/** The ids a resource write names: the URL-bound id and any body id (one record or an array). */
export function writeTargetIds(resource: unknown, content?: unknown): unknown[] {
  const ids: unknown[] = [];
  try {
    const getId = (resource as { getId?: () => unknown } | null | undefined)?.getId;
    if (typeof getId === "function") ids.push(getId.call(resource));
  } catch {
    /* no bound id */
  }
  const records = Array.isArray(content) ? content : [content];
  for (const record of records) {
    if (record && typeof record === "object" && "id" in record) ids.push((record as { id?: unknown }).id);
  }
  return ids;
}

/**
 * The decision: null when no id is reserved or the caller has operator
 * authority; otherwise 401 (anonymous) or 403.
 */
export function reservedSeedWriteDenial(
  table: string,
  ids: unknown[],
  context: unknown,
  auth: AgentAuthVerdict,
): Response | null {
  const reserved = ids.find((id) => isReservedSeedId(table, id));
  if (reserved === undefined) return null;
  if (auth.kind === "anonymous") return UNAUTH();
  if (soulWriteSource(context, auth)) return null;
  return FORBIDDEN(
    `seed_id_reserved: ${table} ${JSON.stringify(String(reserved))} requires the operator source ` +
      "(an authenticated Basic administrator or deliberate internal call)",
  );
}

/** `reservedSeedWriteDenial`, resolving the auth verdict only when an id is reserved. */
export async function refuseReservedSeedWrite(table: string, ids: unknown[], context: unknown): Promise<Response | null> {
  if (!ids.some((id) => isReservedSeedId(table, id))) return null;
  return reservedSeedWriteDenial(table, ids, context, await resolveAgentAuth(context));
}

/**
 * The LINEAGE form of the reservation (flair#2139 S2). A skill update SUPERSEDES
 * into a fresh physical Memory row that carries the stable logical
 * `skillSubjectId` forward, so reserving the seed's physical id alone would let
 * another caller enter the seed's lineage through a successor row whose own id
 * is not the reserved one. This denies a write whose skill SUBJECT is reserved
 * unless the caller has the operator source, exactly as the physical-id check
 * does. `subjectIds` are the resolved logical subject ids the write targets.
 */
export function reservedSeedSubjectDenial(
  table: string,
  subjectIds: unknown[],
  context: unknown,
  auth: AgentAuthVerdict,
): Response | null {
  const reserved = subjectIds.find((id) => isReservedSeedId(table, id));
  if (reserved === undefined) return null;
  if (auth.kind === "anonymous") return UNAUTH();
  if (soulWriteSource(context, auth)) return null;
  return FORBIDDEN(
    `seed_subject_reserved: the ${table} ${JSON.stringify(String(reserved))} lineage requires the operator source ` +
      "(an authenticated Basic administrator or deliberate internal call)",
  );
}

export function reservedSeedFeedWriteDenial(table: string, ids: unknown[]): Response | null {
  const reserved = ids.find((id) => id != null && isReservedSeedId(table, String(id)));
  if (reserved === undefined) return null;
  return FORBIDDEN(
    `seed_id_reserved: ${table} ${JSON.stringify(String(reserved))} is written by the flair init seed; ` +
      "the feed ingest does not write it",
  );
}
