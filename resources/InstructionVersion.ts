/**
 * InstructionVersion.ts — the read-only REST resource for instruction-version
 * history (flair#2139 slice 1). See resources/instruction-version-record.ts for
 * the append helper and the frozen shape (schemas/memory.graphql).
 *
 * Writes: every mutation verb — post, put, patch and delete — returns 403 for
 * EVERY principal, including the super_user operator, and the inherited
 * Table allow* hooks (allowCreate/allowUpdate/allowDelete) are overridden to
 * reject before any verb runs. The only application writer is the in-process
 * `recordVersion` helper. The Harper operations API (raw upsert/delete under
 * admin auth) is an explicit deferred exception: it is not audited by this
 * table (docs/api-reference.md).
 *
 * Reads: explicit Soul and skill branches plus default denial. `allowRead`
 * admits any verified agent (Soul's rule — anonymous denied). A `soul` row is
 * returned to any verified agent. A `skill` row is authorized per flair#2139 S2
 * decision 3: the reader must hold Memory read permission against BOTH the
 * requested version's stored owner/visibility AND the subject's current
 * authority (the head's live Memory row, or the head tombstone after a logical
 * delete); admin/internal keep Memory's
 * unfiltered exception. Any other subject type is denied on both the by-id and
 * the collection read.
 *
 * Soul REST writes do not expose the helper's expected-head guard.
 */
import { databases } from "harper";
import { resolveAgentAuth } from "./agent-auth.js";
import { makeAuthGate, makeScopedSearch, NOT_FOUND, UNAUTH } from "./record-type-kit.js";
import { SKILL_SUBJECT_TYPE, readHead, skillRefReadable, subjectTypeReadable } from "./instruction-version-record.js";

const MUTATION_DENIED = (): Response =>
  new Response(
    JSON.stringify({
      error: "instruction_version_immutable",
      message: "InstructionVersion is append-only within the application; REST writes are refused",
    }),
    { status: 403, headers: { "Content-Type": "application/json" } },
  );

// See makeAuthGate's doc (record-type-kit.ts): must be a genuine prototype
// method, never a class-field assignment — Harper's relationship-traversal
// RBAC path reads allowRead off the prototype.
const readGate = makeAuthGate();

/**
 * flair#2139 S2 decision 3 — skill-read authority.
 *
 * A skill version is readable only when the reader holds Memory read permission
 * against BOTH the requested version's stored owner/visibility and the subject's
 * CURRENT authority, which is the head's live Memory row (or, after a logical
 * delete, the head tombstone's last owner/visibility). It is the more
 * restrictive of write-time and current: tightening a skill to private revokes
 * its earlier versions, and loosening it never widens a version that was private
 * when written. Ordinary readers require matching subjects, a live skill Memory
 * row owned by the head's owner, and explicit private/shared authority references.
 * Delete heads require a null memoryId. Admin/internal keep unfiltered reads.
 */
async function skillVersionReadable(row: Record<string, any>, auth: any): Promise<boolean> {
  if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) return true;
  const reader = auth.agentId;
  if (typeof row.subjectId !== "string" || row.subjectId.length === 0) return false;
  if (!skillRefReadable({ agentId: row.agentId, visibility: row.visibility }, reader)) return false;
  let head: Record<string, any> | null;
  try {
    head = await readHead(SKILL_SUBJECT_TYPE, row.subjectId);
  } catch {
    return false;
  }
  if (!head || head.subjectType !== SKILL_SUBJECT_TYPE || head.subjectId !== row.subjectId) return false;
  if (!skillRefReadable({ agentId: head.agentId, visibility: head.visibility }, head.agentId)) return false;
  if (head.kind === "delete") {
    return head.memoryId === null && skillRefReadable(head, reader);
  }
  if (head.kind !== "create" && head.kind !== "update") return false;
  if (typeof head.memoryId !== "string" || head.memoryId.length === 0) return false;
  let memory: any;
  try {
    memory = await (databases as any).flair?.Memory?.get(head.memoryId);
  } catch {
    return false;
  }
  if (!memory || memory.id !== head.memoryId || memory.skillSubjectId !== row.subjectId) return false;
  if (memory.agentId !== head.agentId || memory.archived === true) return false;
  if (!Array.isArray(memory.tags) || !memory.tags.includes("skill")) return false;
  for (const end of [memory.validTo, memory.expiresAt]) {
    if (end == null) continue;
    if (typeof end !== "string" || !(Date.parse(end) > Date.now())) return false;
  }
  return skillRefReadable({ agentId: memory.agentId, visibility: memory.visibility }, reader);
}

/** The per-row read decision: Soul under its verified-agent rule, skill under
 *  decision 3, every other (or unknown) subject type denied. */
async function rowReadable(row: Record<string, any> | null | undefined, auth: any): Promise<boolean> {
  if (!row || typeof row !== "object") return false;
  if (subjectTypeReadable(row.subjectType)) return true;
  if (row.subjectType === SKILL_SUBJECT_TYPE) return skillVersionReadable(row, auth);
  return false;
}

/**
 * The portion of the read scope Harper can evaluate in the scan: a row of either
 * readable subject type (Soul, or a skill reference). Pushed as the OUTERMOST
 * `and` condition, so an unknown subject type is never returned and a
 * caller-supplied `operator: "or"` cannot widen past it. A skill reference's own
 * rule depends on its subject's head and Memory row — not a condition on this
 * table — so it stays the per-row decision below.
 */
const readableSubjectScope = async (): Promise<{ condition: any; isAllowed: (row: any) => boolean }> => ({
  condition: {
    operator: "or",
    conditions: [
      { attribute: "subjectType", comparator: "equals", value: "soul" },
      { attribute: "subjectType", comparator: "equals", value: SKILL_SUBJECT_TYPE },
    ],
  },
  isAllowed: () => true,
});
const scopedSearch = makeScopedSearch(readableSubjectScope as any);

/**
 * Strip the caller's page and projection from the query handed to the scoped
 * scan. Harper applies `limit`/`offset` to the rows it scans — before the
 * per-row decision, so a page would count unreadable rows — and applies
 * `select`/`property` to those rows, which hides the fields the decision reads.
 * `limit`/`offset` are reapplied over the readable stream in search(); the
 * selection is not reapplied, so a collection read returns the readable rows
 * themselves. Not a selection parser: it removes only `select`, `property`,
 * `limit` and `offset`.
 */
function withoutPagingOrSelection(query: any): any {
  if (!query || typeof query !== "object") return query;
  if (
    (query as any).select === undefined &&
    (query as any).property === undefined &&
    (query as any).limit === undefined &&
    (query as any).offset === undefined
  ) {
    return query;
  }
  const copy: any = Array.isArray(query) ? query.slice() : { ...query };
  delete copy.select;
  delete copy.property;
  delete copy.limit;
  delete copy.offset;
  return copy;
}

function pagingOf(query: any): { limit: number | undefined; offset: number | undefined } {
  if (!query || typeof query !== "object") return { limit: undefined, offset: undefined };
  const rawLimit = (query as any).limit;
  const rawOffset = (query as any).offset;
  return {
    limit: rawLimit == null ? undefined : Number(rawLimit),
    offset: rawOffset == null ? undefined : Number(rawOffset),
  };
}

export class InstructionVersion extends (databases as any).flair.InstructionVersion {
  allowRead() { return readGate.call(this); }
  allowCreate() { return false; }
  allowUpdate() { return false; }
  allowDelete() { return false; }

  async post() { return MUTATION_DENIED(); }
  async put() { return MUTATION_DENIED(); }
  async patch() { return MUTATION_DENIED(); }
  async delete() { return MUTATION_DENIED(); }

  async get(target?: any) {
    if (!target || (typeof target === "object" && target.isCollection)) return this.search(target);
    const auth = await resolveAgentAuth((this as any).getContext?.());
    if (auth.kind === "anonymous") return NOT_FOUND();
    // The decision reads the STORED row's subject type and reference fields, so it
    // runs on the unprojected row: a `select`/`property` read loads the full row
    // by id first, then lets Harper project the authorized row.
    const shaped =
      typeof target === "object" && target !== null && (target.select != null || target.property != null);
    const targetId = typeof target === "string" ? target : (target as any)?.id;
    const row = await super.get(shaped && targetId != null ? { id: targetId } : target);
    if (!row || row instanceof Response) return NOT_FOUND();
    if (!(await rowReadable(row as any, auth))) return NOT_FOUND();
    return shaped ? super.get(target) : row;
  }

  async search(query?: any) {
    const auth = await resolveAgentAuth((this as any).getContext?.());
    if (auth.kind === "anonymous") return UNAUTH();
    // The read scope applies before anything else: the readable subject types are
    // pushed into the scan as the outermost AND condition, the caller's page and
    // selection are stripped, and every surviving row is checked by rowReadable.
    // The caller's offset/limit are then applied over the readable rows, so
    // nothing unreadable is returned or counted.
    const { limit, offset } = pagingOf(query);
    const readerId = auth.kind === "agent" ? auth.agentId : "";
    const source = scopedSearch(readerId, withoutPagingOrSelection(query), (q: any) => super.search(q));
    return (async function* authorizedRows(): AsyncGenerator<any> {
      let skipped = 0;
      let yielded = 0;
      for await (const row of await (source as any)) {
        if (!(await rowReadable(row, auth))) continue;
        if (offset != null && skipped < offset) {
          skipped += 1;
          continue;
        }
        if (limit != null && yielded >= limit) return;
        yielded += 1;
        yield row;
      }
    })();
  }
}
