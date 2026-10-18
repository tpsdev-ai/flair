import { WriteJournal, currentWriteJournal } from "./write-journal.js";
import { withKeyLock } from "./key-lock.js";
import { normalizeEmptyEmbedding } from "./memory-embedding-value.js";
/** Skill writes share the ["flair-instruction-version", "skill"] lock. */
import { databases } from "harper";
import { storageResult } from "./memory-write-response.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { recordVersion, readHead, readVersionRecord, readVersionRecordAfter, skillRefReadable, SKILL_SUBJECT_TYPE, type RecordVersionOutcome } from "./instruction-version-record.js";
import { SKILL_TAG, enforceSkillDurability, skillEmbedText, skillMetadataHasDuplicateKey } from "./skill-write.js";
import { stripUndeclaredMemoryAttributes } from "./memory-declared-attributes.js";
import { skillWriteSource } from "./skill-write-policy.js";
import type { AgentAuthVerdict } from "./agent-auth.js";
import { keepsSuppliedVector } from "./memory-supplied-vector.js";
import { FORBIDDEN } from "./record-type-kit.js";
import { PRIVATE_VISIBILITY, SHARED_VISIBILITY } from "./memory-visibility.js";
import { maybeThrowSkillWriteFault } from "./skill-write-fault.js";
import { supersedesTargetUnreadable } from "./memory-id-guard.js";
import { grantedCloseRevokedRefusal, sameStoredRow, storedRowChangedRefusal, writeGrantHeld } from "./write-back.js";
import { isJoinableTransaction, withOwnedTransaction } from "./request-transaction.js";
import { txnPausePoint } from "./txn-pause-point.js";
import { committedVisibilityDiffers, grantedSuccessorVisibilityDenial, predecessorVisibilityChangedRefusal } from "./grant-visibility.js";
import { isOpenLiveRow } from "../src/lib/open-live-row.js";

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
 * Build the successor Memory row for a superseded skill. Retains declared and explicitly allowed fields.
 */
export function buildSkillSuccessorRow(args: {
  auth: AgentAuthVerdict;
  base: any;
  predecessorRow: Record<string, any> | null;
  successorId: string;
  subjectId: string;
  supersedes: string | null;
  now: string;
}): Record<string, any> {
  const { auth, base, predecessorRow, successorId, subjectId, supersedes, now } = args;
  const row: Record<string, any> = predecessorRow ? { ...predecessorRow, ...base } : { ...base };
  if (!keepsSuppliedVector(auth)) {
    for (const field of ["embedding", "embeddingModel"]) {
      if (!Object.prototype.hasOwnProperty.call(base, field)) delete row[field];
    }
  }
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

export async function prepareSkillBody(content: any, stored: Record<string, any> | null, auth: AgentAuthVerdict) {
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
  // Non-admin writes keep a carried vector's stored stamp. Administrator and
  // trusted in-process writes may replace it and may supply their own vector.
  if (!keepsSuppliedVector(auth) && content.embedding === undefined && sourceHasVector && textUnchanged) {
    if (source.embeddingModel === undefined) delete effective.embeddingModel;
    else effective.embeddingModel = source.embeddingModel;
  }
  effective.embeddedContentHash = sourceHasVector && content.embedding === undefined && textUnchanged
    ? (source.embeddedContentHash ?? null)
    : null;
  if (content.id === undefined) delete effective.id;
  return { content: effective, predecessor };
}

/** Return the sole live head, or null if none; refuse ambiguity. */
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
  /** Re-check the caller's authority over the current committed predecessor
   *  before a close that did not land is re-applied from a fresh read. */
  authorizeClose?: (row: Record<string, any>, shared: any) => Promise<Response | null>;
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
  /** Join the caller's open transaction. A plan that supersedes a predecessor
   *  is first built there without staging a write, then planned again and
   *  committed in a transaction this write owns (flair#2645). */
  joinCallerTransaction?: boolean;
  /** The stable logical subject id. */
  subjectId: string;
  /** The subject owner's agent id (the skill's `agentId`). */
  agentId: string;
  /** The addressable version id the caller compared against; null => unguarded. */
  expectedVersion?: string | null;
  /**
   * Build the write plan from the live head resolved under the lock. Returning
   * a Response refuses the write (and rolls back: nothing is written).
   * `attempt.joined` is true when this attempt plans in the caller's transaction.
   */
  plan: (head: Record<string, any> | null, shared: any, attempt: { joined: boolean }) => SkillWritePlan | Response | null | Promise<SkillWritePlan | Response | null>;
  /** Resolve the live head under the lock. */
  head: (shared: any) => Promise<Record<string, any> | null>;
  hooks: SkillWriteHooks;
}

/**
 * flair#2511: run once a close's write is staged — a supersede's predecessor
 * close or a delete's head close. A grant-authorized cross-agent close stands on
 * the grant read at authorization time; re-read it on committed state HERE,
 * after the close is staged, through the shared write-back helper the non-skill
 * close uses (Memory.ts closeSupersededRecord, flair#2333 H10).
 *
 * For a grant-authorized supersede, `successor` is the planned successor row.
 * Before the grant re-check, the predecessor's COMMITTED row (an empty-context
 * read, as for the grant) must read with the successor's visibility: a write
 * grant does not include changing a record's visibility (grant-visibility.ts).
 * A mismatch returns the named 409 predecessor_visibility_changed.
 * As with the grant, a change committed
 * after this re-read and before the transaction commits is not seen by it.
 */
export async function afterCloseStaged(
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

/** Attempts at re-applying a skill update's close whose committed write did not land (flair#2645). */
const SKILL_UPDATE_CLOSE_ATTEMPTS = 3;

/** The named 500 when the skill update cannot be confirmed. */
function skillUpdateUnconfirmedFailure(): Response {
  return Response.json({
    error: "skill_update_unconfirmed",
    message: "the skill update could not be confirmed",
  }, { status: 500 });
}

/** The named 409 for an update whose close still is not visible after the bounded re-applies. */
function skillUpdateNotClosedRefusal(attempts: number): Response {
  return Response.json({
    error: "skill_update_not_closed",
    message: `the skill version close was not applied after ${attempts} attempts; not updated`,
  }, { status: 409 });
}

/** The named 409 when neither a sole live successor nor ordered supersession is confirmed. */
function skillUpdateNotConfirmedRefusal(): Response {
  return Response.json({
    error: "skill_update_not_confirmed",
    message: "the committed store confirms neither this update's successor as the only live head nor its closure with this request's version record present, the record with the next sequence number linked to it by hash, and that later version's row naming the successor as superseded",
  }, { status: 409 });
}

/** The named 500 when compensation cannot be confirmed. */
function skillUpdateCompensationFailure(message: string): Response {
  return Response.json({ error: "skill_update_compensation_failed", message }, { status: 500 });
}

async function compensateUnlandedSkillUpdate(args: {
  ctx: any;
  journal: WriteJournal;
}): Promise<Response | null> {
  args.journal.compensationAttempted = true;
  try {
    const table = (databases as any).flair?.InstructionVersion;
    const result = await withKeyLock(table?.primaryStore, ["flair-instruction-version", "skill"], async () => {
      const appended = [...args.journal.entries].reverse().find((entry) => entry.after?.subjectType === "skill");
      if (appended) {
        const head = await readHead(SKILL_SUBJECT_TYPE, appended.after.subjectId, {});
        if (head && String(head.id) !== String(appended.after.id)) return false;
      }
      return args.journal.undo(args.ctx, withOwnedTransaction);
    }, 200, 10);
    if (result.kind === "done" && result.value) return null;
  } catch (err) {
    console.error("skill-version-write: update undo could not be confirmed", err);
  }
  return skillUpdateCompensationFailure("the undo of a close that did not land could not be confirmed" +
    (args.journal.pointerChanged ? "; a different host-pointer row was left in place" : ""));
}

/**
 * flair#2645 — confirm a closed successor only when this request's update
 * record is present, the record with the next sequence number links to it by
 * hash, and that later version's row names this successor as superseded.
 */
async function confirmSupersededInOrder(args: {
  subjectId: string;
  successor: Record<string, any>;
  appendedVersionId: string | null;
  memory: SkillCloseTable;
}): Promise<Response | null> {
  if (!args.appendedVersionId) return skillUpdateNotConfirmedRefusal();
  let appended: Record<string, any> | null;
  let following: Record<string, any> | null;
  try {
    appended = await readVersionRecord(SKILL_SUBJECT_TYPE, args.subjectId, args.appendedVersionId, {});
    following = appended
      ? await readVersionRecordAfter(SKILL_SUBJECT_TYPE, args.subjectId, appended.version, {})
      : null;
  } catch {
    return skillUpdateUnconfirmedFailure();
  }
  if (!appended || appended.kind !== "update" || String(appended.memoryId) !== String(args.successor.id)) {
    return skillUpdateNotConfirmedRefusal();
  }
  if (!following || following.kind !== "update") return skillUpdateNotConfirmedRefusal();
  if (following.previousVersionHash !== appended.recordHash) return skillUpdateNotConfirmedRefusal();
  const followingId = typeof following.memoryId === "string" ? following.memoryId : null;
  if (!followingId) return skillUpdateNotConfirmedRefusal();
  let followingRow: Record<string, any> | null;
  try {
    followingRow = await args.memory.get(followingId, {});
  } catch {
    return skillUpdateUnconfirmedFailure();
  }
  if (!followingRow || String(followingRow.supersedes ?? "") !== String(args.successor.id)) {
    return skillUpdateNotConfirmedRefusal();
  }
  return null;
}

/** The table surface a confirmed skill close reads and re-applies through. */
export interface SkillCloseTable {
  get(id: string, ctx?: any): Promise<any>;
  put(row: any, ctx?: any): Promise<any>;
  search?(query: any, ctx?: any): AsyncIterable<any>;
}

export interface ConfirmSkillCloseArgs {
  ctx: any;
  table: SkillCloseTable;
  /** The row as read and planned in the write's transaction. */
  expected: Record<string, any>;
  /** The fields the close stamps on the row it re-reads. */
  closePatch: Record<string, unknown>;
  /** Re-check the caller's authority on the current committed row. */
  authorize: (row: Record<string, any>, shared: any) => Promise<Response | null>;
  afterStaged?: (row: Record<string, any>, attempt: number) => Promise<Response | null>;
  /** Check the committed effect beyond the close (a sole live successor or ordered supersession of a closed successor). */
  confirmEffect?: () => Promise<Response | null>;
  missing?: () => Response;
  /** The named refusal when the close never lands. */
  refusal: () => Response;
  /** The named 500 when the close cannot be confirmed. */
  unconfirmed: () => Response;
  /** Attempts at re-applying the close. Default 3. */
  attempts?: number;
}

/**
 * flair#2645 — confirm a skill close in a fresh committed read, then answer
 * success only when the committed store shows it. Harper can resolve the
 * close's commit while skipping the queued full put (it loses to a newer write
 * of the same row) and still commit the request's other writes. A close that
 * did not land is re-applied from a fresh read, re-checking the row's identity
 * and the caller's authority. Exhausted retries run compensation before the
 * named refusal; unconfirmed compensation returns a named 500.
 * Returns null only when the close and any caller-supplied effect are confirmed.
 */
export async function confirmSkillClose(args: ConfirmSkillCloseArgs): Promise<Response | null> {
  const journal = currentWriteJournal() ?? new WriteJournal();
  return journal.run(async () => {
    const result = await confirmSkillCloseInner(args, journal);
    if (result && !journal.compensationAttempted && journal.entries.some((entry) => entry.applied)) {
      return (await compensateUnlandedSkillUpdate({ ctx: args.ctx, journal })) ?? result;
    }
    return result;
  });
}

async function confirmSkillCloseInner(args: ConfirmSkillCloseArgs, journal: WriteJournal): Promise<Response | null> {
  const { ctx, table, expected, closePatch, authorize, afterStaged, confirmEffect, refusal, unconfirmed } = args;
  const compensate = () => compensateUnlandedSkillUpdate({ ctx, journal });
  const attempts = args.attempts ?? SKILL_UPDATE_CLOSE_ATTEMPTS;
  const id = String(expected.id);
  for (let attempt = 1; ; attempt++) {
    let committed: any;
    try {
      committed = await table.get(id, {});
    } catch {
      return unconfirmed();
    }
    if (!committed) {
      const denied = args.missing?.() ?? storedRowChangedRefusal("Memory");
      return (await compensate()) ?? denied;
    }
    if (!sameStoredRow(committed, expected)) {
      // Replaced between the reads: not the row the caller meant.
      return (await compensate()) ?? storedRowChangedRefusal("Memory");
    }
    if (typeof committed.validTo === "string" && committed.validTo.length > 0) {
      const denied = confirmEffect ? await confirmEffect() : null;
      return denied ? (await compensate()) ?? denied : null;
    }
    if (attempt > attempts) break;
    let applied: "staged" | Response;
    try {
      applied = await withOwnedTransaction(ctx, async (c) => {
        const stored = await table.get(id, c);
        if (!stored) return "staged";
        if (!sameStoredRow(stored, expected)) return storedRowChangedRefusal("Memory");
        const denied = await authorize(stored, c);
        if (denied) return denied;
        const closed = { ...stored, ...closePatch };
        normalizeEmptyEmbedding(closed);
        const result = storageResult(await table.put(closed, c));
        if (result instanceof Response) throw result;
        const revoked = await afterStaged?.(stored, attempt);
        if (revoked) throw revoked;
        return "staged";
      });
    } catch (err) {
      if (err instanceof Response) applied = err;
      else return unconfirmed();
    }
    if (applied instanceof Response) return (await compensate()) ?? applied;
  }
  return (await compensate()) ?? refusal();
}

/**
 * flair#2645 — confirm the predecessor close and either this request's
 * successor as the subject's only live head or its ordered supersession while closed.
 */
async function confirmSkillUpdate(args: {
  ctx: any;
  subjectId: string;
  predecessor: Record<string, any>;
  closePatch: Record<string, unknown>;
  successor: Record<string, any>;
  grantedClose: GrantedClose | null;
  authorize: (row: Record<string, any>, shared: any) => Promise<Response | null>;
  /** The version record this request appended (null when it wrote no version). */
  appendedVersionId: string | null;
}): Promise<Response | null> {
  const { ctx, subjectId, predecessor, closePatch, successor, grantedClose, authorize } = args;
  const table = (databases as any).flair?.Memory;
  if (!table || typeof table.get !== "function" || typeof table.put !== "function") {
    return skillUpdateUnconfirmedFailure();
  }
  const confirmsSingleHead = async (): Promise<Response | null> => {
    let successorCommitted: any;
    try {
      successorCommitted = await table.get(String(successor.id), {});
    } catch {
      return skillUpdateUnconfirmedFailure();
    }
    if (!successorCommitted || !sameStoredRow(successorCommitted, successor)) {
      return skillUpdateNotConfirmedRefusal();
    }
    if (!isOpenLiveRow(successorCommitted)) {
      if (typeof successorCommitted.validTo !== "string" || successorCommitted.validTo.length === 0) {
        return skillUpdateNotConfirmedRefusal();
      }
      // The successor is closed; confirm the ordered supersession.
      return confirmSupersededInOrder({
        subjectId,
        successor,
        appendedVersionId: args.appendedVersionId,
        memory: table,
      });
    }
    if (typeof table.search !== "function") return skillUpdateUnconfirmedFailure();
    const live: string[] = [];
    try {
      for await (const row of table.search({ conditions: [
        { attribute: "skillSubjectId", comparator: "equals", value: subjectId },
      ] }, {})) {
        if (isOpenLiveRow(row)) live.push(String(row.id));
      }
    } catch {
      return skillUpdateUnconfirmedFailure();
    }
    return live.length === 1 && live[0] === String(successor.id) ? null : skillUpdateNotConfirmedRefusal();
  };
  return confirmSkillClose({
    ctx,
    table,
    expected: predecessor,
    closePatch,
    authorize,
    afterStaged: async (_row, attempt) => {
      const pause = attempt === 1 ? txnPausePoint("skill-update-retry-first")
        : attempt === 2 ? txnPausePoint("skill-update-retry-second")
          : txnPausePoint("skill-update-retry-third");
      if (pause) await pause;
      return afterCloseStaged(grantedClose, { predecessorId: String(predecessor.id), successor });
    },
    confirmEffect: confirmsSingleHead,
    missing: () => storedRowChangedRefusal("Memory"),
    refusal: () => skillUpdateNotClosedRefusal(SKILL_UPDATE_CLOSE_ATTEMPTS),
    unconfirmed: skillUpdateUnconfirmedFailure,
  });
}

/**
 * Run one skill version write atomically. The append helper owns the lock, the
 * version row; this function performs the Memory-side
 * successor/close/pointer writes inside that same transaction.
 */
export async function runSkillVersionWrite(args: RunSkillVersionWriteArgs): Promise<RecordVersionOutcome> {
  // A raw table `create` inside the write (the InstructionVersion append, or
  // the successor upsert) can set Harper's `createdResource` flag on the
  // request context, which would surface as HTTP 201. The path a skill write
  // replaces returned 200, so restore the flag's prior value on the way out.
  const restoreCreated = captureCreatedFlag(args.ctx);
  try {
    const journal = new WriteJournal();
    return await journal.run(async () => {
      const result = await runSkillVersionWriteInner(args);
      if (!result.ok && !journal.compensationAttempted && journal.entries.some((entry) => entry.applied)) {
        const failure = await compensateUnlandedSkillUpdate({ ctx: args.ctx, journal });
        if (failure) return { ok: false, response: failure };
      }
      return result;
    });
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

/** A plan whose success {@link confirmSkillUpdate} checks after the commit. */
function supersedesPredecessor(plan: SkillWritePlan): plan is SkillSuccessorPlan & { kind: "update"; predecessor: Record<string, any> } {
  return plan.kind === "update" && !!plan.predecessor;
}

/** A joined attempt's signal that its plan needs a commit this write owns. */
const OWNED_COMMIT_REQUIRED = Symbol("skill-version-write.owned-commit-required");

async function runSkillVersionWriteInner(args: RunSkillVersionWriteArgs): Promise<RecordVersionOutcome> {
  const joined = args.joinCallerTransaction === true && isJoinableTransaction(args.ctx);
  const first = await runSkillVersionAttempt(args, joined);
  if (first !== OWNED_COMMIT_REQUIRED) return first;
  // flair#2645: the update is confirmed against the committed store after its
  // commit, which a joined write leaves to the caller. The joined attempt
  // stopped before staging a write; plan again from a fresh head, owned.
  const owned = await runSkillVersionAttempt(args, false);
  if (owned === OWNED_COMMIT_REQUIRED) throw new Error("skill-version-write: an owned attempt cannot require an owned commit");
  return owned;
}

async function runSkillVersionAttempt(args: RunSkillVersionWriteArgs, joined: boolean): Promise<RecordVersionOutcome | typeof OWNED_COMMIT_REQUIRED> {
  let plan: SkillWritePlan | null = null;
  let owner = "";
  let ownedCommitRequired = false;
  const outcome = await recordVersion(
    args.ctx,
    {
      subjectType: "skill",
      prepare: async (shared: any) => {
        const head = await args.head(shared);
        const built = await args.plan(head, shared, { joined });
        if (built === null) return null;
        if (built instanceof Response) return built;
        if (joined && supersedesPredecessor(built)) {
          ownedCommitRequired = true;
          return skillUpdateUnconfirmedFailure();
        }
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
    joined,
  );
  if (ownedCommitRequired) return OWNED_COMMIT_REQUIRED;
  if (!outcome.ok || plan === null) return outcome;
  const writePlan = plan as SkillWritePlan;
  if (!supersedesPredecessor(writePlan)) return outcome;
  // Test-only: inert unless armed. Pauses between the committed write and the
  // confirmation read, so a later update of the same subject can complete.
  const confirmPause = txnPausePoint("skill-update-confirm");
  if (confirmPause) await confirmPause;
  const authorize = args.hooks.authorizeClose ?? (async () => skillUpdateUnconfirmedFailure());
  // flair#2645: the owned transaction has committed, but its success is not
  // proof that the queued close was applied. Confirm against the committed
  // store before answering success.
  const confirmation = await confirmSkillUpdate({
    ctx: args.ctx,
    subjectId: args.subjectId,
    predecessor: writePlan.predecessor,
    closePatch: writePlan.closePatch,
    successor: writePlan.successor,
    grantedClose: writePlan.grantedClose,
    authorize,
    appendedVersionId: outcome.version || null,
  });
  if (confirmation) return { ok: false, response: confirmation };
  return outcome;
}
