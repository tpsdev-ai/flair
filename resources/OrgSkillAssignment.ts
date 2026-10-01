import { createHash, randomUUID } from "node:crypto";
import { databases } from "harper";
import { resolveAgentAuth } from "./agent-auth.js";
import { resolveStoredRow } from "./originator-instance.js";
import { FORBIDDEN, NOT_FOUND, UNAUTH, makeAuthGate } from "./record-type-kit.js";
import { withSharedWriteTransaction } from "./request-transaction.js";
import { PRIORITY_RANK } from "./skill-provenance.js";
import { soulWriteSource, type SoulWriteSource } from "./soul-write-policy.js";

/**
 * OrgSkillAssignment — org-scope skill assignments (flair#2141 S1).
 *
 * A row assigns the skill row `skillRef` under `skillName` and `priority`;
 * bootstrap's skills manifest resolves it for an agent that receives org
 * skills (resources/skill-manifest.ts).
 *
 * Writes: post, put, patch and delete each require the operator source
 * (`soulWriteSource`: verified Basic admin auth, or the deliberate internal
 * marker). Agent keys, admin agent keys included, are refused. `writer`,
 * `sourceClass`, `createdAt` and `updatedAt` are server-stamped; other body
 * fields are not stored. Reads: any verified agent.
 *
 * History: each accepted write appends an OrgSkillAssignmentHistory row
 * (actor, source class, a hash of the stored row before the write) in the
 * write's transaction.
 */

const TABLE = "OrgSkillAssignment";

type Operator = { writer: string | null; sourceClass: SoulWriteSource };
type Fields = { skillName: string; skillRef: string; priority: string };

/** The stored fields, in the order `previousHash` covers them. */
const HASHED_FIELDS = ["id", "skillName", "skillRef", "priority", "createdAt", "updatedAt", "writer", "sourceClass"] as const;

/** sha256 over a stored row's fields (HASHED_FIELDS), for `previousHash`. */
export function assignmentHash(row: Record<string, unknown>): string {
  const canonical = JSON.stringify(HASHED_FIELDS.map((field) => [field, row[field] ?? null]));
  return createHash("sha256").update(canonical).digest("hex");
}

function badRequest(error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status: 400, headers: { "Content-Type": "application/json" },
  });
}

async function authorizeOperator(self: any): Promise<Operator | Response> {
  const context = self.getContext?.();
  const auth = await resolveAgentAuth(context);
  if (auth.kind === "anonymous") return UNAUTH();
  const sourceClass = soulWriteSource(context, auth);
  if (!sourceClass) return FORBIDDEN("org_skill_assignment_requires_operator: use operator credentials");
  return { writer: auth.kind === "agent" ? auth.agentId : null, sourceClass };
}

/** The URL-bound row id, or null on a collection address. */
function boundId(self: any): string | null {
  try {
    const id = self.getId?.();
    if (typeof id === "string" && id.length > 0) return id;
    if (typeof id === "number") return String(id);
  } catch {
    /* no bound id */
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validFields(body: Record<string, unknown>): Fields | Response {
  const { skillName, skillRef, priority = "standard" } = body;
  if (typeof skillName !== "string" || skillName.trim() === "") {
    return badRequest("skill_name_required", "skillName must be a non-empty string");
  }
  if (typeof skillRef !== "string" || skillRef.trim() === "") {
    return badRequest("skill_ref_required", "skillRef must be the id of a skill-tagged Memory row");
  }
  if (typeof priority !== "string" || !Object.hasOwn(PRIORITY_RANK, priority)) {
    return badRequest("invalid_priority", `priority must be one of ${Object.keys(PRIORITY_RANK).join(", ")}`);
  }
  return { skillName, skillRef, priority };
}

async function appendHistory(
  context: any,
  assignmentId: string,
  op: "create" | "update" | "delete",
  previous: Record<string, unknown> | null,
  who: Operator,
  at: string,
): Promise<void> {
  await (databases as any).flair.OrgSkillAssignmentHistory.put({
    id: randomUUID(),
    assignmentId,
    op,
    actor: who.writer,
    sourceClass: who.sourceClass,
    previousHash: previous ? assignmentHash(previous) : null,
    at,
  }, context);
}

const authGate = makeAuthGate();

export class OrgSkillAssignment extends (databases as any).flair.OrgSkillAssignment {
  allowRead() { return authGate.call(this); }

  async post(content: any, context?: any) {
    const who = await authorizeOperator(this);
    if (who instanceof Response) return who;
    if (boundId(this)) return badRequest("org_skill_assignment_post_to_collection", "create an assignment with POST /OrgSkillAssignment/");
    if (!isRecord(content)) return badRequest("org_skill_assignment_requires_one_record", "send one assignment object");
    const fields = validFields(content);
    if (fields instanceof Response) return fields;
    const at = new Date().toISOString();
    const record = { id: randomUUID(), ...fields, createdAt: at, updatedAt: at, writer: who.writer, sourceClass: who.sourceClass };
    return withSharedWriteTransaction((this as any).getContext?.(), async (shared) => {
      await appendHistory(shared, record.id, "create", null, who, at);
      return super.post(record, context);
    });
  }

  async put(content: any, context?: any) {
    const who = await authorizeOperator(this);
    if (who instanceof Response) return who;
    const id = boundId(this);
    if (!id) return badRequest("org_skill_assignment_id_required", "address one assignment: PUT /OrgSkillAssignment/<id>");
    if (!isRecord(content)) return badRequest("org_skill_assignment_requires_one_record", "send one assignment object");
    const fields = validFields(content);
    if (fields instanceof Response) return fields;
    const stored = await resolveStoredRow(this, TABLE, content, () => super.get());
    if (stored.denial) return stored.denial;
    const at = new Date().toISOString();
    const createdAt = typeof stored.row?.createdAt === "string" ? stored.row.createdAt : at;
    const record = { id, ...fields, createdAt, updatedAt: at, writer: who.writer, sourceClass: who.sourceClass };
    return withSharedWriteTransaction((this as any).getContext?.(), async (shared) => {
      await appendHistory(shared, id, stored.row ? "update" : "create", stored.row, who, at);
      return super.put(record, context);
    });
  }

  async patch(content: any, query?: any) {
    const who = await authorizeOperator(this);
    if (who instanceof Response) return who;
    const id = boundId(this);
    if (!id) return badRequest("org_skill_assignment_id_required", "address one assignment: PATCH /OrgSkillAssignment/<id>");
    if (!isRecord(content)) return badRequest("org_skill_assignment_requires_one_record", "send one assignment object");
    const stored = await resolveStoredRow(this, TABLE, content, () => super.get());
    if (stored.denial) return stored.denial;
    if (!stored.row) return NOT_FOUND();
    const merged: Record<string, unknown> = {};
    for (const field of ["skillName", "skillRef", "priority"] as const) {
      merged[field] = Object.hasOwn(content, field) ? content[field] : stored.row[field];
    }
    const fields = validFields(merged);
    if (fields instanceof Response) return fields;
    const at = new Date().toISOString();
    const changes = { ...fields, updatedAt: at, writer: who.writer, sourceClass: who.sourceClass };
    return withSharedWriteTransaction((this as any).getContext?.(), async (shared) => {
      await appendHistory(shared, id, "update", stored.row, who, at);
      return super.patch(changes, query);
    });
  }

  async delete(target?: any) {
    const who = await authorizeOperator(this);
    if (who instanceof Response) return who;
    const id = boundId(this);
    if (!id) return badRequest("org_skill_assignment_id_required", "address one assignment: DELETE /OrgSkillAssignment/<id>");
    const stored = await resolveStoredRow(this, TABLE, undefined, () => super.get());
    if (stored.denial) return stored.denial;
    if (!stored.row) return NOT_FOUND();
    const at = new Date().toISOString();
    return withSharedWriteTransaction((this as any).getContext?.(), async (shared) => {
      await appendHistory(shared, id, "delete", stored.row, who, at);
      return super.delete(target);
    });
  }
}
