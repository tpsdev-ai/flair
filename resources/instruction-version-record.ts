/**
 * Transaction helper for single-row Soul resource history (flair#2139 slice 1).
 */
import { createHash } from "node:crypto";
import { databases } from "harper";
import { authorizeSoulWrite } from "./soul-write-policy.js";
import { authorizeSkillVersionWrite } from "./skill-write-policy.js";
import { withKeyLock } from "./key-lock.js";
import { withOwnedTransaction } from "./request-transaction.js";
import { maybeThrowSkillWriteFault } from "./skill-write-fault.js";
import { PRIVATE_VISIBILITY, SHARED_VISIBILITY } from "./memory-visibility.js";

export const INSTRUCTION_VERSION_TABLE = "InstructionVersion";

export type VersionKind = "create" | "update" | "delete";
export type InstructionSubjectType = "soul" | "skill";
export type ActorKind = "operator" | "agent" | "internal" | "instance";
export type SourceClass = "operator" | "internal" | "agent" | "federation" | "seed";

/** Server-derived attribution for one version row; never read from a request body. */
export interface VersionAttribution {
  actorKind: ActorKind;
  actorId: string | null;
  sourceClass: SourceClass;
}

export interface RecordVersionInput {
  subjectType: InstructionSubjectType;
  /** Canonical subject: `agentId:key` for soul; a stable logical skill id for skill. */
  subjectId: string;
  agentId: string;
  key?: string | null;
  kind: VersionKind;
  /** The physical row this version describes. */
  rowId: string;
  /** Value bytes for the digest; soulSnapshot also contains the value. */
  value?: string | null;
  soulSnapshot?: string | null;
  memoryId?: string | null;
  visibility?: string | null;
  snapshot?: () => Record<string, any>;
  /** The addressable version id the caller compared against; null ⇒ unguarded. */
  expectedVersion?: string | null;
  /**
   * A subject-identity change: when set, the write first appends a delete
   * tombstone to this closed subject, in the same transaction, before the
   * subject's own record. The old subject's chain is closed, never silently
   * moved.
   */
  previousSubjectId?: string | null;
  previousKey?: string | null;
  /** The closed subject's own agentId; the tombstone is about the OLD subject. */
  previousAgentId?: string | null;
  previousRowId?: string | null;
}

export interface RecordVersionSuccess { ok: true; result: any; version: string }
export interface RecordVersionFailure { ok: false; response: Response }
export type RecordVersionOutcome = RecordVersionSuccess | RecordVersionFailure;

/**
 * The fields the record digest covers, in this exact order. `recordHash` is
 * excluded (it is the digest), and every other field is included, including
 * the preceding record digest (`previousVersionHash`), so removing a field or
 * reordering the list breaks every chain.
 */
export const RECORD_HASH_FIELDS = [
  "id",
  "subjectType",
  "subjectId",
  "agentId",
  "key",
  "version",
  "kind",
  "rowId",
  "valueHash",
  "previousVersionHash",
  "soulSnapshot",
  "memoryId",
  "visibility",
  "actorKind",
  "actorId",
  "sourceClass",
  "createdAt",
  "guarded",
  "expectedVersion",
] as const;

/** A field as it enters the canonical serialization: bigint → decimal string, undefined → null. */
function normalizeField(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return value === undefined ? null : value;
}

/** sha256 of the deterministic canonical serialization of a version record, excluding recordHash. */
export function recordDigest(record: Record<string, unknown>): string {
  const canonical = JSON.stringify(RECORD_HASH_FIELDS.map((field) => [field, normalizeField(record[field])]));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** sha256 of the exact UTF-8 value bytes; null when there is no value (a tombstone). */
export function valueDigest(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The addressable version id: subjectType + subjectId + sequence. Never a content hash. */
export function versionId(
  subjectType: InstructionSubjectType,
  subjectId: string,
  sequence: bigint,
): string {
  return `${subjectType}:${subjectId}:${sequence.toString()}`;
}

/**
 * Read authority by subject type, default-deny: slice 1 authorizes `soul` only
 * (under Soul's verified-agent rule). A later skill slice adds `skill` here and
 * resolves it from Memory's owner/non-private rule, never from Soul's.
 */
export const AUTHORIZED_SUBJECT_TYPES: ReadonlySet<string> = new Set(["soul"]);

/** Whether a version row's subjectType may be read. An unrecognized type is denied. */
export function subjectTypeReadable(subjectType: unknown): boolean {
  return typeof subjectType === "string" && AUTHORIZED_SUBJECT_TYPES.has(subjectType);
}

/** Canonical subject for a Soul row. */
export function soulSubjectId(agentId: string, key: string): string {
  return `${agentId}:${key}`;
}

/** The subject type of a skill-tagged Memory row's version chain (flair#2139 S2). */
export const SKILL_SUBJECT_TYPE = "skill";

/** A retained skill read-scope reference: the owner and the effective visibility. */
export interface InstructionReadRef {
  agentId?: unknown;
  visibility?: unknown;
}

/**
 * Skill references require a nonempty owner and explicit private/shared visibility.
 */
export function skillRefReadable(ref: InstructionReadRef | null | undefined, readerId: string): boolean {
  if (!ref || typeof ref !== "object") return false;
  if (typeof ref.agentId !== "string" || ref.agentId.length === 0) return false;
  if (ref.visibility !== PRIVATE_VISIBILITY && ref.visibility !== SHARED_VISIBILITY) return false;
  return ref.agentId === readerId || ref.visibility === SHARED_VISIBILITY;
}

/** A version row carries the expectedVersion it compared iff it is guarded; otherwise null. */
export function expectedVersionOf(input: RecordVersionInput): string | null {
  return input.expectedVersion ?? null;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function staleHeadResponse(expected: string, head: Record<string, any> | null): Response {
  return jsonResponse(409, {
    error: "instruction_version_head_mismatch",
    message: "the subject's head has changed since the version you compared; re-read and retry",
    expectedVersion: expected,
    currentVersion: head ? head.id : null,
  });
}

/** Thrown when the caller's row mutation returns a non-success Response, so the append aborts. */
class RowMutationDenied extends Error {
  constructor(readonly response: Response) {
    super("instruction version: the row mutation failed, so the append was rolled back");
  }
}

function isTableLike(table: unknown): boolean {
  return !!table && typeof (table as any).search === "function" && typeof (table as any).create === "function";
}

/**
 * The subject's current head, or null when it has no history yet.
 * The append caller reads under its subject lock and transaction after resetting
 * the cached read snapshot; the read resource uses the same raw handle without a lock.
 */
export async function readHead(subjectType: string, subjectId: string, shared?: any): Promise<Record<string, any> | null> {
  const table = (databases as any).flair?.InstructionVersion;
  if (!isTableLike(table)) throw new Error("flair: the InstructionVersion table is unavailable");
  for await (const row of table.search({
    conditions: [
      { attribute: "subjectType", comparator: "equals", value: subjectType },
      { attribute: "subjectId", comparator: "equals", value: subjectId },
    ],
    sort: { attribute: "version", descending: true },
    limit: 1,
  }, shared)) {
    return row as Record<string, any>;
  }
  return null;
}

/** Server-derived attribution for an authorization outcome; never from a body. */
const UNATTRIBUTED: VersionAttribution = { actorKind: "internal", actorId: null, sourceClass: "internal" };

/**
 * Dispatch authorization and attribution by subject type (flair#2139 S2). Soul
 * uses Soul's operator/internal rule; skill uses the shared skill-write
 * credential class (operator / agent / internal). An unrecognized subject type
 * is refused, not silently attributed.
 */
export async function resolveVersionAuthorization(
  subjectType: InstructionSubjectType,
  context: any,
): Promise<{ attribution: VersionAttribution; denied: Response | null }> {
  if (subjectType === "soul") {
    const { auth, source, denied } = await authorizeSoulWrite(context);
    if (denied) return { attribution: UNATTRIBUTED, denied };
    return {
      attribution: {
        actorKind: source === "operator" ? "operator" : "internal",
        actorId: auth.kind === "agent" ? auth.agentId : null,
        sourceClass: source!,
      },
      denied: null,
    };
  }
  if (subjectType === "skill") {
    const { auth, source, denied } = await authorizeSkillVersionWrite(context);
    if (denied) return { attribution: UNATTRIBUTED, denied };
    return {
      attribution: {
        actorKind: source!,
        actorId: auth.kind === "agent" ? auth.agentId : null,
        sourceClass: source!,
      },
      denied: null,
    };
  }
  throw new Error(`instruction version: unknown subject type: ${String(subjectType)}`);
}

const LOCK_NAMESPACE = "flair-instruction-version";
/** Bounded lock wait. */
const LOCK_ATTEMPTS = 200;
const LOCK_WAIT_MS = 10;

export interface PreparedVersionInput {
  subjectType: InstructionSubjectType;
  prepare: (shared: any) => Promise<RecordVersionInput | Response | null>;
}

export async function recordVersion(
  ctx: any,
  request: RecordVersionInput | PreparedVersionInput,
  mutateRow: (shared: any) => Promise<any>,
): Promise<RecordVersionOutcome> {
  const store = (databases as any).flair?.InstructionVersion?.primaryStore;
  let outcome;
  try {
    outcome = await withKeyLock(store, [LOCK_NAMESPACE, request.subjectType], () =>
      withOwnedTransaction(ctx, async (shared) => {
        const authorization = await resolveVersionAuthorization(request.subjectType, shared);
        if (authorization.denied) return { ok: false, response: authorization.denied } as RecordVersionOutcome;
        const attribution = authorization.attribution;
        const input = "prepare" in request ? await request.prepare(shared) : request;
        if (input === null) {
          const result = await mutateRow(shared);
          if (result instanceof Response && result.status >= 300) throw new RowMutationDenied(result);
          return { ok: true, result, version: "" } as RecordVersionOutcome;
        }
        if (input instanceof Response) return { ok: false, response: input } as RecordVersionOutcome;
        if (input.subjectType !== request.subjectType) throw new Error("instruction version: subject type changed during preparation");
        const expected = expectedVersionOf(input);
        const table = (databases as any).flair?.InstructionVersion;
        if (!isTableLike(table)) throw new Error("flair: the InstructionVersion table is unavailable");
        const head = await readHead(input.subjectType, input.subjectId, shared);
        if (expected != null && (!head || head.id !== expected)) {
          return { ok: false, response: staleHeadResponse(expected, head) } as RecordVersionOutcome;
        }
        const result = await mutateRow(shared);
        if (result instanceof Response && result.status >= 300) throw new RowMutationDenied(result);
        // Only a Soul record carries a full stored snapshot; a skill record
        // holds hashes and physical references, never a second content copy.
        if (input.subjectType === "soul" && input.kind !== "delete" && input.snapshot) {
          const row = input.snapshot();
          if (!row) throw new Error("instruction version: stored snapshot unavailable");
          input.soulSnapshot = JSON.stringify(row);
          input.value = typeof row.value === "string" ? row.value : null;
        }
        // A logical-key change closes the old subject first, in this transaction.
        if (input.previousSubjectId && input.previousSubjectId !== input.subjectId) {
          const oldHead = await readHead(input.subjectType, input.previousSubjectId, shared);
          const oldSequence = oldHead ? BigInt(oldHead.version as any) + 1n : 1n;
          const oldRecord: Record<string, unknown> = {
            id: versionId(input.subjectType, input.previousSubjectId, oldSequence),
            subjectType: input.subjectType,
            subjectId: input.previousSubjectId,
            agentId: input.previousAgentId ?? input.agentId,
            key: input.previousKey ?? null,
            version: oldSequence,
            kind: "delete",
            rowId: input.previousRowId ?? input.rowId,
            valueHash: null,
            previousVersionHash: oldHead ? (oldHead.recordHash ?? null) : null,
            soulSnapshot: null,
            memoryId: null,
            visibility: null,
            actorKind: attribution.actorKind,
            actorId: attribution.actorId,
            sourceClass: attribution.sourceClass,
            createdAt: new Date().toISOString(),
            guarded: false,
            expectedVersion: null,
          };
          oldRecord.recordHash = recordDigest(oldRecord);
          await table.create(oldRecord, shared);
        }
        const sequence = head ? BigInt(head.version as any) + 1n : 1n;
        const id = versionId(input.subjectType, input.subjectId, sequence);
        const record: Record<string, unknown> = {
          id,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          agentId: input.agentId,
          key: input.key ?? null,
          version: sequence,
          kind: input.kind,
          rowId: input.rowId,
          valueHash: input.kind === "delete" ? null : valueDigest(input.value ?? ""),
          previousVersionHash: head ? (head.recordHash ?? null) : null,
          soulSnapshot: input.kind === "delete" ? null : (input.soulSnapshot ?? null),
          memoryId: input.memoryId ?? null,
          visibility: input.visibility ?? null,
          actorKind: attribution.actorKind,
          actorId: attribution.actorId,
          sourceClass: attribution.sourceClass,
          createdAt: new Date().toISOString(),
          guarded: expected != null,
          expectedVersion: expected,
        };
        record.recordHash = recordDigest(record);
        // flair#2139 S2 — test-only per-step fault injection (see
        // skill-write-fault.ts). Fires after the Memory-side successor/close
        // writes rode this same transaction, so the append failure aborts them
        // too: no successor, no close, no version.
        if (input.subjectType === "skill") maybeThrowSkillWriteFault("append", input.agentId);
        await table.create(record, shared);
        return { ok: true, result, version: id } as RecordVersionOutcome;
      }),
    LOCK_ATTEMPTS,
    LOCK_WAIT_MS);
  } catch (err) {
    if (err instanceof RowMutationDenied) return { ok: false, response: err.response };
    // A head-read, append or commit failure aborts the whole transaction; report
    // unavailable rather than a success, so no caller reads a missing version as
    // "nothing happened" (fail-closed).
    console.error("instruction-version-record: the append transaction failed and was rolled back", { err });
    return {
      ok: false,
      response: jsonResponse(500, {
        error: "instruction_version_append_failed",
        message: "the version history append failed and the write was rolled back",
      }),
    };
  }
  if (outcome.kind === "busy") {
    return {
      ok: false,
      response: jsonResponse(409, {
        error: "instruction_version_busy",
        message: "another instruction write is still in progress; retry",
      }),
    };
  }
  if (outcome.kind === "unavailable") {
    return {
      ok: false,
      response: jsonResponse(503, {
        error: "instruction_version_lock_unavailable",
        message: "the InstructionVersion store has no per-key lock, so the write was refused",
      }),
    };
  }
  return outcome.value;
}
