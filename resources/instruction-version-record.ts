/**
 * instruction-version-record.ts — the frozen InstructionVersion shape and the
 * one shared transactional append helper for instruction-version history
 * (flair#2139 slice 1).
 *
 * ─── What this is ────────────────────────────────────────────────────────────
 * `recordVersion` is the only application writer of InstructionVersion. It resolves the
 * subject's head, allocates the next per-subject sequence, verifies the
 * caller's attribution, optionally compares an expected head, appends the
 * version row, and runs the caller's row mutation — all in ONE serialized,
 * owned transaction. Any failure aborts the transaction, so neither the append
 * nor the row mutation survives (fail-closed: no unaudited mutation, no phantom
 * version).
 *
 * ─── Serialization, and what it is NOT ───────────────────────────────────────
 * Writes to one subject are serialized by this process's per-key lock on the
 * InstructionVersion primary store (resources/key-lock.ts) plus an owned
 * transaction. That lock is per key, shared by the threads of ONE Harper
 * process (key-lock.ts) — it is NOT cross-instance compare-and-swap. Two
 * processes writing the same subject at once can allocate the same sequence;
 * the second append then hits the version primary key and the whole
 * transaction rolls back. That fail-closed collision is the correct direction
 * for an append-only audit table, and it is why version ids never encode a
 * content hash.
 */
import { createHash } from "node:crypto";
import { databases } from "harper";
import type { AgentAuthVerdict } from "./agent-auth.js";
import { withKeyLock } from "./key-lock.js";
import { withOwnedTransaction } from "./request-transaction.js";

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
  /** The value the row carries; hashed, never stored here. Null on delete. */
  value?: string | null;
  soulSnapshot?: string | null;
  memoryId?: string | null;
  visibility?: string | null;
  attribution: VersionAttribution;
  /** The addressable version id the caller compared against; null ⇒ unguarded. */
  expectedVersion?: string | null;
  /** Server clock, ISO. */
  createdAt: string;
  /**
   * A logical-key change: when set, the write first appends a delete tombstone
   * to this closed subject, in the same transaction, before the subject's own
   * record. The old subject's chain is closed, never silently moved.
   */
  previousSubjectId?: string | null;
  previousKey?: string | null;
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

/** Server-derived attribution for a Soul write (operator Basic or deliberate internal). */
export function soulAttribution(auth: AgentAuthVerdict, source: "operator" | "internal"): VersionAttribution {
  return {
    actorKind: source === "operator" ? "operator" : "internal",
    actorId: auth.kind === "agent" ? auth.agentId : null,
    sourceClass: source,
  };
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
  return !!table && typeof (table as any).search === "function" && typeof (table as any).put === "function";
}

/**
 * The subject's current head, or null when it has no history yet. Read through
 * the raw table handle: this runs inside the caller's append transaction and
 * has already dropped the thread's cached read snapshot (withKeyLock), so it
 * sees the last committed head under the subject lock.
 */
async function readHead(subjectType: string, subjectId: string): Promise<Record<string, any> | null> {
  const table = (databases as any).flair?.InstructionVersion;
  if (!isTableLike(table)) throw new Error("flair: the InstructionVersion table is unavailable");
  for await (const row of table.search({
    conditions: [
      { attribute: "subjectType", comparator: "equals", value: subjectType },
      { attribute: "subjectId", comparator: "equals", value: subjectId },
    ],
    sort: { attribute: "version", descending: true },
    limit: 1,
  })) {
    return row as Record<string, any>;
  }
  return null;
}

const LOCK_NAMESPACE = "flair-instruction-version";
/** The wait for another write to the same subject: at most LOCK_ATTEMPTS × LOCK_WAIT_MS. */
const LOCK_ATTEMPTS = 200;
const LOCK_WAIT_MS = 10;

/**
 * Append one version row for `input.subject` and run `mutateRow` in the same
 * owned transaction. `mutateRow` receives the shared context the row write must
 * be given; it returns the resource's Response (a non-success status aborts the
 * append) or any value.
 */
export async function recordVersion(
  ctx: any,
  input: RecordVersionInput,
  mutateRow: (shared: any) => Promise<any>,
): Promise<RecordVersionOutcome> {
  const expected = expectedVersionOf(input);
  const store = (databases as any).flair?.InstructionVersion?.primaryStore;
  let outcome;
  try {
    outcome = await withKeyLock(store, [LOCK_NAMESPACE, input.subjectType, input.subjectId], () =>
      withOwnedTransaction(ctx, async (shared) => {
        const table = (databases as any).flair?.InstructionVersion;
        if (!isTableLike(table)) throw new Error("flair: the InstructionVersion table is unavailable");
        const head = await readHead(input.subjectType, input.subjectId);
        if (expected != null && (!head || head.id !== expected)) {
          return { ok: false, response: staleHeadResponse(expected, head) } as RecordVersionOutcome;
        }
        // A logical-key change closes the old subject first, in this transaction.
        if (input.previousSubjectId && input.previousSubjectId !== input.subjectId) {
          const oldHead = await readHead(input.subjectType, input.previousSubjectId);
          const oldSequence = oldHead ? BigInt(oldHead.version as any) + 1n : 1n;
          const oldRecord: Record<string, unknown> = {
            id: versionId(input.subjectType, input.previousSubjectId, oldSequence),
            subjectType: input.subjectType,
            subjectId: input.previousSubjectId,
            agentId: input.agentId,
            key: input.previousKey ?? null,
            version: oldSequence,
            kind: "delete",
            rowId: input.previousRowId ?? input.rowId,
            valueHash: null,
            previousVersionHash: oldHead ? (oldHead.recordHash ?? null) : null,
            soulSnapshot: null,
            memoryId: null,
            visibility: null,
            actorKind: input.attribution.actorKind,
            actorId: input.attribution.actorId,
            sourceClass: input.attribution.sourceClass,
            createdAt: input.createdAt,
            guarded: false,
            expectedVersion: null,
          };
          oldRecord.recordHash = recordDigest(oldRecord);
          await table.put(oldRecord, shared);
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
          actorKind: input.attribution.actorKind,
          actorId: input.attribution.actorId,
          sourceClass: input.attribution.sourceClass,
          createdAt: input.createdAt,
          guarded: expected != null,
          expectedVersion: expected,
        };
        record.recordHash = recordDigest(record);
        await table.put(record, shared);
        const result = await mutateRow(shared);
        if (result instanceof Response && result.status >= 300) throw new RowMutationDenied(result);
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
        message: "another write to this subject is still in progress; retry",
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
