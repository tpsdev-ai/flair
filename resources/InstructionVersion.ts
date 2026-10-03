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
 * delete), fail-closed on missing metadata; admin/internal keep Memory's
 * unfiltered exception. Any other subject type is denied on both the by-id and
 * the collection read.
 *
 * Soul REST writes do not expose the helper's expected-head guard.
 */
import { databases } from "harper";
import { resolveAgentAuth } from "./agent-auth.js";
import { makeAuthGate, NOT_FOUND, UNAUTH } from "./record-type-kit.js";
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
 * when written. A missing or inconsistent authority state denies. Admin agents
 * and trusted internal calls keep Memory's unfiltered read exception.
 */
async function skillVersionReadable(row: Record<string, any>, auth: any): Promise<boolean> {
  if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) return true;
  const reader = auth.agentId;
  if (!skillRefReadable({ agentId: row.agentId, visibility: row.visibility }, reader)) return false;
  let head: Record<string, any> | null;
  try {
    head = await readHead(SKILL_SUBJECT_TYPE, String(row.subjectId));
  } catch {
    return false;
  }
  if (!head) return false;
  if (head.kind === "delete") {
    return skillRefReadable({ agentId: head.agentId, visibility: head.visibility }, reader);
  }
  if (typeof head.memoryId !== "string" || head.memoryId.length === 0) return false;
  let memory: any;
  try {
    memory = await (databases as any).flair?.Memory?.get(head.memoryId);
  } catch {
    return false;
  }
  if (!memory) return false;
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
    const row = await super.get(target);
    if (!row || row instanceof Response) return NOT_FOUND();
    return (await rowReadable(row as any, auth)) ? row : NOT_FOUND();
  }

  async search(query?: any) {
    const auth = await resolveAgentAuth((this as any).getContext?.());
    if (auth.kind === "anonymous") return UNAUTH();
    // The caller's query narrows which rows are considered; it never widens what
    // is authorized. Every returned row is re-checked per subject type, so a
    // caller-supplied filter or projection cannot surface an unauthorized row.
    const results = await super.search(query);
    return (async function* authorizedRows(): AsyncGenerator<any> {
      for await (const row of results) {
        if (await rowReadable(row, auth)) yield row;
      }
    })();
  }
}
