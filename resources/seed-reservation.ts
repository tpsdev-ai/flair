/**
 * seed-reservation.ts — the `using-flair` seed's fixed ids are written only with
 * operator authority (flair#2141 S2).
 *
 * `flair init` seeds one skill row at a FIXED Memory id and one org assignment
 * at a FIXED OrgSkillAssignment id that points at it. Bootstrap lists the
 * assignment for every agent principal, so the row behind that id must be the
 * operator's. The rule:
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
 * Where it applies: each Memory write path that can take a caller-chosen id
 * runs this decision before it writes — Memory post/put/patch/delete, the
 * supersede target, and FeedMemories — and the federation merge skips a
 * reserved id (`seed_id_not_federated`). Server bookkeeping that writes one
 * server-chosen field onto a row (usageCount, lastReflected, the embedding
 * backfill) never writes content, tags, owner or visibility, and is left open.
 * test/unit/seed-id-writer-coverage.test.ts classifies every raw Memory write
 * site, so a new path is a reviewed change.
 */
import { resolveAgentAuth, type AgentAuthVerdict } from "./agent-auth.js";
import { FORBIDDEN, UNAUTH } from "./record-type-kit.js";
import { soulWriteSource } from "./soul-write-policy.js";
import { SEED_SKILL_ROW_ID } from "./seed-ids.js";

export { SEED_SKILL_ROW_ID };

/** Table → the ids on it that only the operator may write. */
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
    `seed_id_reserved: ${table} ${JSON.stringify(String(reserved))} is written only by the operator ` +
      "(an authenticated Basic administrator)",
  );
}

/** `reservedSeedWriteDenial`, resolving the auth verdict only when an id is reserved. */
export async function refuseReservedSeedWrite(table: string, ids: unknown[], context: unknown): Promise<Response | null> {
  if (!ids.some((id) => isReservedSeedId(table, id))) return null;
  return reservedSeedWriteDenial(table, ids, context, await resolveAgentAuth(context));
}
