/**
 * skill-version-write.ts — the transactional skill version writer (flair#2139
 * S2). A skill is a Memory tagged "skill"; an update SUPERSEDES (a fresh
 * physical row) instead of overwriting in place, and every change appends an
 * InstructionVersion row.
 *
 * Atomicity is mandatory (spec): inside the append helper's per-subject lock and
 * its ONE owned transaction, this module re-reads the subject's current live
 * Memory head, builds the successor, closes the predecessor, performs pointer
 * writes, and appends the version. Every table operation is given the SAME
 * transaction context, so any failure aborts everything. The helper (not this
 * module) owns the lock/transaction/append; `mutateRow` here only performs the
 * Memory writes that ride along.
 *
 * Main's detached close + catch-and-log path (closeSupersededIfNeeded) is never
 * used for skills: the predecessor close is part of the same transaction as the
 * successor write, so a failure rolls both back rather than leaving two active
 * rows or a swallowed error.
 */
import { databases } from "harper";
import { randomUUID } from "node:crypto";
import { recordVersion, readHead, skillRefReadable, SKILL_SUBJECT_TYPE, type RecordVersionOutcome } from "./instruction-version-record.js";
import { SKILL_TAG, enforceSkillDurability } from "./skill-write.js";
import { stripUndeclaredMemoryAttributes } from "./memory-declared-attributes.js";
import { PRIVATE_VISIBILITY, SHARED_VISIBILITY } from "./memory-visibility.js";
import { maybeThrowSkillWriteFault } from "./skill-write-fault.js";

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
  if (typeof row.validTo === "string" && row.validTo.length > 0) return false;
  return true;
}

/** Is this row a skill-tagged Memory row? */
export function rowIsSkill(row: Record<string, any> | null | undefined): boolean {
  return !!row && Array.isArray(row.tags) && row.tags.includes(SKILL_TAG);
}

/**
 * flair#2139 S2 — the close-payload bypass predicate. A reader who may not read
 * a skill VERSION must not be able to read a retained (CLOSED) payload of that
 * same skill through Memory's GET/search or the Feed replay. A CURRENT (open)
 * skill row keeps its ordinary live read semantics (this returns true). A closed
 * skill row is re-checked under decision 3: the reader must hold Memory read
 * permission against BOTH the retained row's own owner/visibility AND the
 * subject's CURRENT authority — the live head, or the head tombstone after a
 * logical delete. A missing or inconsistent authority state denies.
 */
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
  let head: Record<string, any> | null;
  try {
    head = await resolveSkillHead(subjectId, String(row.id), undefined);
  } catch {
    return false;
  }
  if (head && String(head.id) !== String(row.id)) {
    return skillRefReadable({ agentId: head.agentId, visibility: head.visibility }, readerId);
  }
  // No live head: the subject's current authority is its head tombstone.
  const headOf = read.headOf ?? ((sid: string) => readHead(SKILL_SUBJECT_TYPE, sid));
  let versionHead: Record<string, any> | null;
  try {
    versionHead = await headOf(subjectId);
  } catch {
    return false;
  }
  if (!versionHead) return false;
  if (versionHead.kind === "delete") {
    return skillRefReadable({ agentId: versionHead.agentId, visibility: versionHead.visibility }, readerId);
  }
  if (typeof versionHead.memoryId !== "string" || versionHead.memoryId.length === 0) return false;
  const memoryGet = read.memoryGet ?? ((id: string) => (databases as any).flair?.Memory?.get(id));
  let live: any;
  try {
    live = await memoryGet(versionHead.memoryId);
  } catch {
    return false;
  }
  if (!live) return false;
  return skillRefReadable({ agentId: live.agentId, visibility: live.visibility }, readerId);
}

/**
 * Resolve the current live head of a skill subject under the caller's lock.
 * `subjectId` is the stable `skillSubjectId`; `addressedId` is the physical row
 * the caller named (used to find the lineage for a legacy row that has no
 * `skillSubjectId` yet). Returns the live row, or the addressed row when it is
 * not yet enrolled, or null when neither exists.
 */
export async function resolveSkillHead(
  subjectId: string | null,
  addressedId: string | null,
  shared: any,
): Promise<Record<string, any> | null> {
  const table = (databases as any).flair?.Memory;
  if (!table || typeof table.search !== "function") throw new Error("flair: the Memory table is unavailable");
  if (subjectId) {
    let best: Record<string, any> | null = null;
    for await (const row of table.search({
      conditions: [{ attribute: "skillSubjectId", comparator: "equals", value: subjectId }],
      limit: 200,
    }, shared)) {
      if (!isOpenLiveRow(row)) continue;
      // A subject should have exactly one live head; if several match, take the
      // one with no successor-of-it still open — deterministically the latest
      // by createdAt, then id, so the resolution is stable.
      if (!best || String(row.createdAt ?? "") > String(best.createdAt ?? "") ||
          (String(row.createdAt ?? "") === String(best.createdAt ?? "") && String(row.id) > String(best.id))) {
        best = row;
      }
    }
    if (best) return best;
  }
  if (addressedId) {
    const row = await table.get(addressedId, shared);
    if (row && typeof row === "object" && isOpenLiveRow(row)) return row;
  }
  return null;
}

/** The successor plan for a create/update. */
export interface SkillSuccessorPlan {
  kind: "create" | "update";
  /** The resolved live predecessor row being superseded (null on a first create). */
  predecessor: Record<string, any> | null;
  /** The full successor row, with a fresh physical id and `supersedes` set. */
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
  plan: (head: Record<string, any> | null) => SkillWritePlan | Response;
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
  return recordVersion(
    args.ctx,
    {
      subjectType: "skill",
      prepare: async (shared: any) => {
        const head = await args.head(shared);
        const built = args.plan(head);
        if (built instanceof Response) return built;
        plan = built;
        const target = built.kind === "delete" ? built.predecessor : built.successor;
        return {
          subjectType: "skill" as const,
          subjectId: args.subjectId,
          agentId: args.agentId,
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
      const writePlan = plan!;
      if (writePlan.kind === "delete") {
        maybeThrowSkillWriteFault("close", args.agentId);
        await args.hooks.closePredecessor!(writePlan.predecessor, writePlan.closePatch, shared);
      } else {
        maybeThrowSkillWriteFault("successor", args.agentId);
        await args.hooks.createSuccessor!(writePlan.successor, shared);
        if (writePlan.predecessor) {
          maybeThrowSkillWriteFault("close", args.agentId);
          await args.hooks.closePredecessor!(writePlan.predecessor, writePlan.closePatch, shared);
        }
      }
      maybeThrowSkillWriteFault("pointer", args.agentId);
      const pointerDenial = await args.hooks.pointer?.(shared);
      if (pointerDenial) return pointerDenial;
      return okResponse();
    },
  );
}
