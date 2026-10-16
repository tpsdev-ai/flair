import { normalizeEmptyEmbedding } from "./memory-embedding-value.js";
/** Skill writes share the ["flair-instruction-version", "skill"] lock. */
import { databases } from "harper";
import { storageResult } from "./memory-write-response.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { recordVersion, readHead, skillRefReadable, SKILL_SUBJECT_TYPE, type RecordVersionOutcome } from "./instruction-version-record.js";
import { SKILL_TAG, enforceSkillDurability, skillEmbedText, skillMetadataHasDuplicateKey } from "./skill-write.js";
import { stripUndeclaredMemoryAttributes } from "./memory-declared-attributes.js";
import { skillWriteSource } from "./skill-write-policy.js";
import type { AgentAuthVerdict } from "./agent-auth.js";
import { FORBIDDEN } from "./record-type-kit.js";
import { PRIVATE_VISIBILITY, SHARED_VISIBILITY } from "./memory-visibility.js";
import { maybeThrowSkillWriteFault } from "./skill-write-fault.js";
import { supersedesTargetUnreadable } from "./memory-id-guard.js";
import { grantedCloseRevokedRefusal, writeGrantHeld } from "./write-back.js";
import { txnPausePoint } from "./txn-pause-point.js";
import { committedVisibilityDiffers, grantedSuccessorVisibilityDenial, predecessorVisibilityChangedRefusal } from "./grant-visibility.js";

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
    "embedding", "embeddingModel", "embeddedContentHash", "contentHash", "updatedAt", "instanceToken",
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
  const source = stored ?? predecessor ?? {};
  const effective = { ...source, ...content };
  effective.tags = content.tags ?? (rowIsSkill(stored) ? stored!.tags : predecessor?.tags);
  if (skillMetadataHasDuplicateKey(effective.metadata)) {
    return Response.json({ error: "skill_metadata_duplicate_key" }, { status: 400 });
  }
  const textUnchanged = skillEmbedText(effective) === skillEmbedText(source);
  if (content.embedding === undefined && !textUnchanged) {
    effective.embedding = null;
    effective.embeddingModel = null;
  }
  // flair#2465: the successor keeps the stored `embeddedContentHash` only when
  // the stored row has a vector, the body omits `embedding` (so that vector is
  // carried), and the embedding text is unchanged; otherwise null. A body value
  // is never kept. A Feed successor stores this value; Memory.post()/put() keep
  // it when they store the carried vector, and otherwise set their own.
  const sourceHasVector = Array.isArray(source.embedding) && source.embedding.length > 0;
  effective.embeddedContentHash = sourceHasVector && content.embedding === undefined && textUnchanged
    ? (source.embeddedContentHash ?? null)
    : null;
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

/** flair#2511: the "write" grant a cross-agent close stands on. */
export interface GrantedClose {
  granteeId: string;
  ownerId: string;
}

/**
 * flair#2511: the "write" grant a cross-agent close of `closed` stands on, or
 * null when the close is not a grant-authorized cross-agent one — an operator,
 * internal or same-agent caller. The same predicate {@link authorizeSkillOwners}
 * uses to demand the grant; the shared writer re-checks it on committed state
 * after the close is staged. Every plan that closes a row passes this for the
 * row it closes.
 */
export function grantedSkillClose(closed: Record<string, any> | null | undefined, ctx: any, auth: AgentAuthVerdict): GrantedClose | null {
  if (!closed || typeof closed.agentId !== "string" || !closed.agentId.trim()) return null;
  if (skillWriteSource(ctx, auth) !== "agent" || auth.kind !== "agent") return null;
  if (closed.agentId === auth.agentId) return null;
  return { granteeId: auth.agentId, ownerId: closed.agentId };
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
  /**
   * flair#2511: {@link grantedSkillClose} of `predecessor` — the grant a CROSS-agent
   * close of it stands on (an agent caller, not the operator's Basic admin or an
   * internal call, closing another agent's row), else null (no predecessor, or a
   * same-agent, operator or internal close).
   * Required, so every plan states it. When set, the shared writer re-checks the
   * grant on committed state after it stages the close and refuses the whole
   * write — no close, no successor, no version — when the grant is gone.
   * When set, this grant-authorized write must also carry a successor that
   * reads with the predecessor's visibility, both as planned and on committed
   * state after the close is staged: a write grant does not include changing a
   * record's visibility (grant-visibility.ts).
   */
  grantedClose: GrantedClose | null;
}

/** The plan for a logical delete. */
export interface SkillDeletePlan {
  kind: "delete";
  predecessor: Record<string, any>;
  closePatch: Record<string, unknown>;
  value: null;
  visibility: string | null;
  /**
   * flair#2511: {@link grantedSkillClose} of the head this delete closes — set
   * when that head is another agent's row a "write" grant authorizes the caller
   * to close. The shared writer re-checks it after staging the close, as for a
   * supersede.
   */
  grantedClose: GrantedClose | null;
}

export type SkillWritePlan = SkillSuccessorPlan | SkillDeletePlan;

export interface SkillWriteHooks {
  /** Create the successor row through the shared transaction. */
  createSuccessor?: (successor: Record<string, any>, shared: any) => Promise<string | Response>;
  /** Close the predecessor (or, for a delete, the head) through the shared transaction. */
  closePredecessor?: (predecessor: Record<string, any>, patch: Record<string, unknown>, shared: any) => Promise<void | Response>;
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
    normalizeEmptyEmbedding(successor);
    const result = storageResult(await (databases as any).flair.Memory.put(successor, shared));
    if (result instanceof Response) return result;
    return String(successor.id);
  },
  closePredecessor: async (predecessor, patch, shared) => {
    const closed = { ...predecessor, ...patch };
    normalizeEmptyEmbedding(closed);
    const result = storageResult(await (databases as any).flair.Memory.put(closed, shared));
    if (result instanceof Response) return result;
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
 * flair#2511: run once a close's write is staged — a supersede's predecessor
 * close or a delete's head close. A grant-authorized cross-agent close stands on
 * the grant read at authorization time; re-read it on committed state HERE,
 * after the close is staged, through the shared write-back helper the non-skill
 * close uses (Memory.ts closeSupersededRecord, flair#2333 H10). Returns the named
 * 409 when the grant is gone — the caller returns it, so the whole transaction
 * rolls back: no close, no successor, no version — else null. A plan with no
 * grant (same-agent, operator, internal) reads nothing.
 *
 * For a grant-authorized supersede, `successor` is the planned successor row.
 * Before the grant re-check, the predecessor's COMMITTED row (an empty-context
 * read, as for the grant) must read with the successor's visibility: a write
 * grant does not include changing a record's visibility (grant-visibility.ts).
 * A mismatch returns the named 409 predecessor_visibility_changed, and the
 * whole write rolls back the same way. As with the grant, a change committed
 * after this re-read and before the transaction commits is not seen by it.
 */
async function afterCloseStaged(
  granted: GrantedClose | null | undefined,
  supersede?: { predecessorId: string; successor: Record<string, any> },
): Promise<Response | null> {
  // Test-only: inert unless armed — here the close write is staged, so a
  // competing grant revocation or row change and the committed-state re-checks
  // below can be exercised in either order (the skill-path counterpart of Memory's "granted-close-staged").
  const stagedPause = txnPausePoint("skill-close-staged");
  if (stagedPause) await stagedPause;
  if (!granted) return null;
  if (supersede) {
    const committed = await (databases as any).flair.Memory.get(supersede.predecessorId, {});
    if (committedVisibilityDiffers(committed, supersede.successor.visibility)) return predecessorVisibilityChangedRefusal();
  }
  const held = await writeGrantHeld((databases as any).flair.MemoryGrant, granted.granteeId, granted.ownerId, {});
  return held ? null : grantedCloseRevokedRefusal();
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
        // A write grant does not include changing a record's visibility;
        // visibility is set by the owner or an admin (grant-visibility.ts). The
        // plan is checked here and again on committed state once the close is
        // staged (afterCloseStaged).
        const visibilityDenial = grantedSuccessorVisibilityDenial(built);
        if (visibilityDenial) return visibilityDenial;
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
        const closed = await args.hooks.closePredecessor!(writePlan.predecessor, writePlan.closePatch, shared);
        if (closed instanceof Response) return storageResult(closed);
        // flair#2511: the grant re-check, after the close is staged.
        const revoked = await afterCloseStaged(writePlan.grantedClose);
        if (revoked) return revoked;
      } else {
        maybeThrowSkillWriteFault("successor", owner);
        const created = await args.hooks.createSuccessor!(writePlan.successor, shared);
        if (created instanceof Response) return storageResult(created);
        if (writePlan.predecessor) {
          maybeThrowSkillWriteFault("close", owner);
          const closed = await args.hooks.closePredecessor!(writePlan.predecessor, writePlan.closePatch, shared);
          if (closed instanceof Response) return storageResult(closed);
          // flair#2511: the grant re-check, after the close is staged, with the
          // committed-visibility check for a grant-authorized successor.
          const revoked = await afterCloseStaged(writePlan.grantedClose, {
            predecessorId: String(writePlan.predecessor.id), successor: writePlan.successor,
          });
          if (revoked) return revoked;
        }
      }
      maybeThrowSkillWriteFault("pointer", owner);
      const pointerDenial = await args.hooks.pointer?.(shared);
      if (pointerDenial) return pointerDenial;
      return okResponse();
    },
  );
}
