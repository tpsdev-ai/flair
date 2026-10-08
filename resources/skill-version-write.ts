/** Skill writes share the ["flair-instruction-version", "skill"] lock. */
import { databases } from "harper";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { recordVersion, readHead, skillRefReadable, SKILL_SUBJECT_TYPE, type RecordVersionOutcome } from "./instruction-version-record.js";
import { SKILL_TAG, enforceSkillDurability, skillEmbedText } from "./skill-write.js";
import { stripUndeclaredMemoryAttributes } from "./memory-declared-attributes.js";
import { skillWriteSource } from "./skill-write-policy.js";
import type { AgentAuthVerdict } from "./agent-auth.js";
import { FORBIDDEN } from "./record-type-kit.js";
import { PRIVATE_VISIBILITY, SHARED_VISIBILITY } from "./memory-visibility.js";
import { maybeThrowSkillWriteFault } from "./skill-write-fault.js";
import { supersedesTargetUnreadable } from "./memory-id-guard.js";

/** Durability-keyed default visibility (mirrors Memory's write default). */
function defaultVisibilityForDurability(durability: unknown): "private" | "shared" {
  return durability === "permanent" || durability === "persistent" ? "shared" : "private";
}

/**
 * The effective visibility stamped on a skill version row (flair#2139 S2
 * decision 3): the row's writable visibility, else the durability-keyed default.
 * Never absent: a legacy row missing visibility is normalized at capture time
 * rather than left to read as public.
 */
export function skillVersionVisibility(row: any): string {
  const v = row?.visibility;
  if (v === PRIVATE_VISIBILITY || v === SHARED_VISIBILITY) return v;
  return defaultVisibilityForDurability(row?.durability);
}

export async function closedSkillPayloadReadable(
  row: Record<string, any> | null | undefined,
  readerId: string,
  read: { headOf?: (subjectId: string) => Promise<Record<string, any> | null>; memoryGet?: (id: string) => Promise<any> } = {},
): Promise<boolean> {
  if (!row || typeof row !== "object" || !rowIsSkill(row)) return true;
  if (isOpenLiveRow(row)) return true;
  if (!skillRefReadable({ agentId: row.agentId, visibility: row.visibility }, readerId)) return false;
  const subjectId = typeof row.skillSubjectId === "string" && row.skillSubjectId.length > 0
    ? row.skillSubjectId
    : String(row.id);
  const headOf = read.headOf ?? ((sid: string) => readHead(SKILL_SUBJECT_TYPE, sid));
  let versionHead: Record<string, any> | null;
  try {
    versionHead = await headOf(subjectId);
  } catch {
    return false;
  }
  if (!versionHead || versionHead.subjectType !== SKILL_SUBJECT_TYPE || versionHead.subjectId !== subjectId) return false;
  if (!skillRefReadable(versionHead, versionHead.agentId)) return false;
  if (versionHead.kind === "delete") {
    return versionHead.memoryId === null && skillRefReadable(versionHead, readerId);
  }
  if (versionHead.kind !== "create" && versionHead.kind !== "update") return false;
  if (typeof versionHead.memoryId !== "string" || versionHead.memoryId.length === 0) return false;
  const memoryGet = read.memoryGet ?? ((id: string) => (databases as any).flair?.Memory?.get(id));
  let live: any;
  try {
    live = await memoryGet(versionHead.memoryId);
  } catch {
    return false;
  }
  if (!live || live.id !== versionHead.memoryId || live.skillSubjectId !== subjectId) return false;
  if (live.agentId !== versionHead.agentId || !rowIsSkill(live) || live.archived === true) return false;
  for (const end of [live.validTo, live.expiresAt]) {
    if (end == null) continue;
    if (typeof end !== "string" || !(Date.parse(end) > Date.now())) return false;
  }
  return skillRefReadable({ agentId: live.agentId, visibility: live.visibility }, readerId);
}

/**
 * Build the successor Memory row for a superseded skill. It carries the
 * predecessor's fields (a partial body merges over them), a fresh physical id,
 * the carried `skillSubjectId`, `supersedes`, a fresh incarnation token, and no
 * closed-row markers. Declared attributes only.
 */
export function buildSkillSuccessorRow(args: {
  base: any;
  predecessorRow: Record<string, any> | null;
  successorId: string;
  subjectId: string;
  supersedes: string | null;
  now: string;
}): Record<string, any> {
  const { base, predecessorRow, successorId, subjectId, supersedes, now } = args;
  const row: Record<string, any> = predecessorRow ? { ...predecessorRow, ...base } : { ...base };
  row.id = successorId;
  row.skillSubjectId = subjectId;
  if (supersedes) row.supersedes = supersedes;
  else delete row.supersedes;
  row.updatedAt = now;
  row.archived = false;
  delete row.validTo;
  delete row.archivedAt;
  delete row.archivedBy;
  if (!predecessorRow) row.createdAt = typeof base.createdAt === "string" ? base.createdAt : now;
  row.instanceToken = randomUUID();
  enforceSkillDurability(row);
  stripUndeclaredMemoryAttributes(row);
  return row;
}

function okResponse(): Response {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function isOpenLiveRow(row: Record<string, any> | null | undefined): boolean {
  if (!row || typeof row !== "object") return false;
  if (row.archived === true) return false;
  if (row.expiresAt != null && (typeof row.expiresAt !== "string" || !(Date.parse(row.expiresAt) > Date.now()))) return false;
  if (typeof row.validTo === "string" && row.validTo.length > 0) return false;
  return true;
}

/** Is this row a skill-tagged Memory row? */
export function rowIsSkill(row: Record<string, any> | null | undefined): boolean {
  return !!row && Array.isArray(row.tags) && row.tags.includes(SKILL_TAG);
}

export function skillPayloadUnchanged(base: Record<string, any>, head: Record<string, any>): boolean {
  const bookkeeping = new Set([
    "embedding", "embeddingModel", "contentHash", "updatedAt", "instanceToken",
    "provenance", "skillSubjectId", "_safetyFlags", "_skillScan",
    "retrievalCount", "lastRetrieved",
  ]);
  return Object.entries(base).every(([key, value]) =>
    bookkeeping.has(key) || isDeepStrictEqual(value, head[key]));
}

export function skillWriteConflict(error: string): Response {
  return Response.json({ error }, { status: 409 });
}

export async function prepareSkillBody(content: any, stored: Record<string, any> | null) {
  let predecessor: any = null;
  if (typeof content.supersedes === "string" && content.supersedes.length > 0) {
    // flair#2307: a failed read of the `supersedes` target refuses the write
    // with a named error; it is never read as "no predecessor".
    try {
      predecessor = await (databases as any).flair.Memory.get(content.supersedes);
    } catch (err) {
      return supersedesTargetUnreadable(err);
    }
  }
  if (!rowIsSkill(content) && !rowIsSkill(stored) && !rowIsSkill(predecessor)) {
    return { content, predecessor };
  }
  if (content.supersedes && content.supersedes === content.id) return skillWriteConflict("skill_self_supersede");
  if (content.supersedes && !predecessor && content.supersedes !== stored?.supersedes) {
    return skillWriteConflict("skill_predecessor_missing");
  }
  if (content.tags !== undefined && (!Array.isArray(content.tags) || !content.tags.includes(SKILL_TAG))) {
    return Response.json({ error: "skill_lineage_tag_removed" }, { status: 400 });
  }
  if ((content.archived != null && content.archived !== false) || (content.validTo != null && content.validTo !== "")) {
    return Response.json({ error: "skill_state_requires_delete" }, { status: 400 });
  }
  const effective = { ...(stored ?? predecessor ?? {}), ...content };
  effective.tags = content.tags ?? (rowIsSkill(stored) ? stored!.tags : predecessor?.tags);
  if (content.embedding === undefined && skillEmbedText(effective) !== skillEmbedText(stored ?? predecessor ?? {})) {
    effective.embedding = null;
    effective.embeddingModel = null;
  }
  if (content.id === undefined) delete effective.id;
  return { content: effective, predecessor };
}

/** Select exactly one open row; ambiguity refuses. */
export async function resolveSkillHead(
  subjectId: string | null,
  addressedId: string | null,
  shared: any,
): Promise<Record<string, any> | null> {
  const table = (databases as any).flair?.Memory;
  if (!table || typeof table.search !== "function") throw new Error("flair: the Memory table is unavailable");
  const live = new Map<string, Record<string, any>>();
  if (subjectId) {
    for await (const row of table.search({
      conditions: [{ attribute: "skillSubjectId", comparator: "equals", value: subjectId }],
    }, shared)) {
      if (isOpenLiveRow(row)) live.set(String(row.id), row);
    }
  }
  if (addressedId) {
    const row = await table.get(addressedId, shared);
    if (isOpenLiveRow(row) && (!row.skillSubjectId || row.skillSubjectId === subjectId)) live.set(String(row.id), row);
  }
  if (live.size > 1) throw new Error("skill_head_ambiguous");
  return live.values().next().value ?? null;
}

export async function authorizeSkillOwners(ctx: any, auth: AgentAuthVerdict, rows: any[], shared: any): Promise<Response | null> {
  for (const row of rows.filter(Boolean)) {
    if (typeof row.agentId !== "string" || !row.agentId.trim()) return FORBIDDEN("skill_owner_missing");
    if (skillWriteSource(ctx, auth) !== "agent" || auth.kind !== "agent" || row.agentId === auth.agentId) continue;
    let granted = false;
    for await (const grant of (databases as any).flair.MemoryGrant.search({ conditions: [
      { attribute: "granteeId", comparator: "equals", value: auth.agentId },
      { attribute: "ownerId", comparator: "equals", value: row.agentId },
    ] }, shared)) {
      if (grant.scope === "write") granted = true;
    }
    if (!granted) return FORBIDDEN("forbidden: cannot write a skill owned by another agent without a write grant");
  }
  return null;
}

export async function validateSkillSnapshots(stored: any, predecessor: any, targetId: string | null, shared: any): Promise<Response | null> {
  for (const [id, expected] of [[targetId, stored], [predecessor?.id, predecessor]]) {
    if (!id) continue;
    const current = await (databases as any).flair.Memory.get(id, shared);
    if (!isDeepStrictEqual(current ?? null, expected ?? null)) return skillWriteConflict("skill_target_changed");
  }
  return null;
}

/** The successor plan for a create/update. */
export interface SkillSuccessorPlan {
  kind: "create" | "update";
  /** The resolved live predecessor row being superseded (null on a first create). */
  predecessor: Record<string, any> | null;
  successor: Record<string, any>;
  /** The patch that closes the predecessor (e.g. `validTo`). */
  closePatch: Record<string, unknown>;
  /** The value bytes the version hashes (the skill's content). */
  value: string | null;
  /** The effective visibility stamped on the version row. */
  visibility: string | null;
}

/** The plan for a logical delete. */
export interface SkillDeletePlan {
  kind: "delete";
  predecessor: Record<string, any>;
  closePatch: Record<string, unknown>;
  value: null;
  visibility: string | null;
}

export type SkillWritePlan = SkillSuccessorPlan | SkillDeletePlan;

export interface SkillWriteHooks {
  /** Create the successor row through the shared transaction; returns its id. */
  createSuccessor?: (successor: Record<string, any>, shared: any) => Promise<string>;
  /** Close the predecessor (or, for a delete, the head) through the shared transaction. */
  closePredecessor?: (predecessor: Record<string, any>, patch: Record<string, unknown>, shared: any) => Promise<void>;
  /** Pointer writes through the shared transaction; a Response denies and aborts. */
  pointer?: (shared: any) => Promise<Response | null>;
}

/**
 * The default Memory-table hooks: the successor is upserted and the predecessor
 * is read-modify-written (full-record PUT, its stored fields preserved), both
 * through the shared transaction so the helper's rollback covers them.
 */
export const defaultSkillHooks: SkillWriteHooks = {
  createSuccessor: async (successor, shared) => {
    await (databases as any).flair.Memory.put(successor, shared);
    return String(successor.id);
  },
  closePredecessor: async (predecessor, patch, shared) => {
    const closed = { ...predecessor, ...patch };
    await (databases as any).flair.Memory.put(closed, shared);
  },
};

export interface RunSkillVersionWriteArgs {
  ctx: any;
  /** The stable logical subject id. */
  subjectId: string;
  /** The subject owner's agent id (the skill's `agentId`). */
  agentId: string;
  /** The addressable version id the caller compared against; null => unguarded. */
  expectedVersion?: string | null;
  /**
   * Build the write plan from the live head resolved under the lock. Returning
   * a Response refuses the write (and rolls back: nothing is written).
   */
  plan: (head: Record<string, any> | null, shared: any) => SkillWritePlan | Response | null | Promise<SkillWritePlan | Response | null>;
  /** Resolve the live head under the lock. */
  head: (shared: any) => Promise<Record<string, any> | null>;
  hooks: SkillWriteHooks;
}

/**
 * Run one skill version write atomically. The append helper owns the lock, the
 * transaction and the version row; this function performs the Memory-side
 * successor/close/pointer writes inside that same transaction.
 */
export async function runSkillVersionWrite(args: RunSkillVersionWriteArgs): Promise<RecordVersionOutcome> {
  // A raw table `create` inside the write (the InstructionVersion append, or
  // the successor upsert) can set Harper's `createdResource` flag on the
  // request context, which would surface as HTTP 201. The path a skill write
  // replaces returned 200, so restore the flag's prior value on the way out.
  const restoreCreated = captureCreatedFlag(args.ctx);
  try {
    return await runSkillVersionWriteInner(args);
  } finally {
    restoreCreated();
  }
}

/** Capture the `createdResource` flag on a context and its request, and return a
 *  restore callback that puts them back exactly as they were. */
export function captureCreatedFlag(ctx: any): () => void {
  const targets = [ctx, ctx?.request].filter((t): t is Record<string, any> => !!t && typeof t === "object");
  const before = targets.map((t) => [t, Object.prototype.hasOwnProperty.call(t, "createdResource"), t.createdResource] as const);
  return () => {
    for (const [t, had, value] of before) {
      if (had) (t as Record<string, any>).createdResource = value;
      else delete (t as Record<string, any>).createdResource;
    }
  };
}

async function runSkillVersionWriteInner(args: RunSkillVersionWriteArgs): Promise<RecordVersionOutcome> {
  let plan: SkillWritePlan | null = null;
  let owner = "";
  return recordVersion(
    args.ctx,
    {
      subjectType: "skill",
      prepare: async (shared: any) => {
        const head = await args.head(shared);
        const built = await args.plan(head, shared);
        if (built === null) return null;
        if (built instanceof Response) return built;
        plan = built;
        const target = built.kind === "delete" ? built.predecessor : built.successor;
        owner = String(target.agentId);
        return {
          subjectType: "skill" as const,
          subjectId: args.subjectId,
          agentId: String(target.agentId),
          key: null,
          kind: built.kind,
          rowId: String(target.id),
          value: built.kind === "delete" ? null : built.value,
          memoryId: built.kind === "delete" ? null : String(built.successor.id),
          visibility: built.visibility,
          expectedVersion: args.expectedVersion ?? null,
        };
      },
    },
    async (shared: any) => {
      if (plan === null) return okResponse();
      const writePlan = plan!;
      if (writePlan.kind === "delete") {
        maybeThrowSkillWriteFault("close", owner);
        await args.hooks.closePredecessor!(writePlan.predecessor, writePlan.closePatch, shared);
      } else {
        maybeThrowSkillWriteFault("successor", owner);
        await args.hooks.createSuccessor!(writePlan.successor, shared);
        if (writePlan.predecessor) {
          maybeThrowSkillWriteFault("close", owner);
          await args.hooks.closePredecessor!(writePlan.predecessor, writePlan.closePatch, shared);
        }
      }
      maybeThrowSkillWriteFault("pointer", owner);
      const pointerDenial = await args.hooks.pointer?.(shared);
      if (pointerDenial) return pointerDenial;
      return okResponse();
    },
  );
}
