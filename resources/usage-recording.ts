/**
 * usage-recording.ts — shared usage-ledger recording core (flair#744 slice A,
 * "citation-on-write"; extracted from RecordUsage.ts's flair#683 signal so
 * there is exactly ONE implementation of the ledger logic, not two that can
 * drift).
 *
 * Two callers share this core, both crediting the SAME deduped,
 * principal-bound `MemoryUsage` ledger + the targeted `Memory.usageCount`
 * bump:
 *   - `POST /RecordUsage` (resources/RecordUsage.ts) — an agent explicitly
 *     reports "I used this memory" as a standalone call.
 *   - Citation-on-write (resources/Memory.ts's post()/put(), via
 *     `recordCitations()` below) — an agent cites `usedMemoryIds` inline on a
 *     memory WRITE; each cited id is credited the same way, post-commit and
 *     failure-isolated from the write itself.
 *
 * `recordUsageContribution()` is the one (agentId, memoryId) ledger write —
 * see its doc below for the read-scope gate it applies, the ledger-then-count
 * ordering, and the owned read-modify-write that confirms the stored row before
 * the count bump.
 *
 * `recordCitations()` is the NEW batch helper citation-on-write uses: the
 * same agent-required / cap / dedup / per-id failure-isolation shape as
 * RecordUsage.post()'s loop, parameterized so Memory.ts can drive it from a
 * write body instead of a dedicated POST body. It NEVER reads the ledger for
 * authority — it only writes contributions; `usedMemoryIds` must never enter
 * an access/scope/attribution/dedup decision (flair#744 slice A invariant 3;
 * the flair#775 read-scope gate below is the REVERSE direction — the writer's
 * scope vets the cited ids, the cited ids never widen anything).
 *
 * READ SCOPE, ON BOTH SURFACES. A contribution is recorded only for a memory
 * in the contributing agent's read scope: `resolveReadScope(agentId).isAllowed(record)`
 * — the scope Memory.get() applies to a NON-ADMIN by-id read. It applies to
 * admin agents here too, although an admin's Memory reads are unfiltered. A
 * memory outside that scope takes the SAME branch as an id that does not
 * exist: the caller gets the same response and the memory's counters do not
 * change. Any difference between the two (an error, a response or shape
 * difference, a ledger row the caller can read back) would tell the caller
 * "that id exists but you can't see it".
 *   - recordUsageContribution() REQUIRES the predicate (`canRead`). It applies
 *     it to its first read of the memory, before the ledger row is written
 *     (out of scope there: no row), and again to the re-read before the count
 *     bump (out of scope there: the row already written stays, and the count
 *     is not bumped). No caller of the ledger core can credit a memory without
 *     a read-scope decision.
 *   - recordUsageBatch() (POST /RecordUsage) and recordCitations()
 *     (citation-on-write) each resolve the caller's scope ONCE per batch and
 *     fail CLOSED: if the scope cannot be resolved, nothing in the batch is
 *     credited. recordCitations() also pre-checks each cited id (flair#775).
 *   - The ledger's own read path (resources/MemoryUsage.ts) applies the same
 *     rule to NON-ADMIN reads through isLedgerRowVisible()/readableLedgerRows():
 *     a non-admin reader sees its own row only while the memory it names
 *     exists and is readable. Admin and trusted internal ledger reads are
 *     unfiltered.
 */
import { databases } from "harper";
import { stripUndeclaredMemoryAttributes } from "./memory-declared-attributes.js";
import { withDetachedTxn } from "./table-helpers.js";
import { WriteBackConflictError, writeBackCommittedRow } from "./write-back.js";
import { txnPausePoint } from "./txn-pause-point.js";
import { resolveReadScope } from "./memory-read-scope.js";
import type { ReadScope, ScopableRecord } from "./memory-read-scope.js";
import type { AgentAuthVerdict } from "./agent-auth.js";

/**
 * Per-call cap on ids credited in one batch — shared by RecordUsage.post()'s
 * validated `memoryIds` body (rejects a batch over the cap with a 400) and
 * recordCitations()'s advisory `usedMemoryIds` (silently slices instead —
 * see that function's doc for why the two differ here).
 */
export const MAX_USAGE_IDS_PER_CALL = 20;

/** The read-scope predicate the ledger core applies — `ReadScope.isAllowed`. */
export type CanReadMemory = (record: ScopableRecord | null | undefined) => boolean;

/**
 * One (agentId, memoryId) contribution — the shared ledger-write core.
 *
 * READ-SCOPE GATE: `canRead` is the contributing agent's read-scope predicate
 * (`resolveReadScope(agentId).isAllowed`, resolved once per batch by the
 * caller). The memory row is checked against it before the ledger row is
 * written, and the re-fetched row is checked again before the count is
 * bumped. At the first read, a memory that does not exist and a memory the
 * agent cannot read end on the same silent no-op: no ledger row, no count
 * change. At the re-read the ledger row is already written; a rejection there
 * leaves the row in place and skips the count bump.
 *
 * Ledger-row-create FIRST, THEN the Memory.usageCount bump — so a crash
 * between the two leaves the SAFE failure state (ledger row exists, count
 * not yet bumped: a later retry just re-checks and no-ops) rather than the
 * reverse (count bumped, no ledger row → a retry would double-count).
 *
 * The MemoryUsage ledger reads and its row create keep the withDetachedTxn
 * discipline — one wrap per discrete Harper call (table-helpers.ts's
 * withDetachedTxn doc): a request that reads/writes MULTIPLE tables in
 * sequence can otherwise inherit a closed transaction from a prior call's
 * drained chain. The count bump does not wrap its own calls: it runs through
 * the shared write-back helper (writeBackCommittedRow, below), which opens a
 * transaction this call OWNS and reads, builds and writes the row inside it.
 *
 * The count bump is the shared write-back helper (write-back.ts): the row is
 * read inside a transaction this call OWNS, the bump is built from THAT read,
 * and the committed row is re-read before commit. A row deleted or purged
 * between the read and the write is not bumped and NOT re-created (the plan
 * skips an absent row). A same-id replace is refused, never overwritten: an
 * identity change the in-transaction read already sees throws
 * WriteBackConflictError at once (no retry). Only a change to the committed
 * row found by the re-read after the bump is staged retries, from a fresh
 * read, at most WRITE_BACK_ATTEMPTS attempts in all (then
 * WriteBackConflictError). recordUsageBatch / recordCitations log either
 * refusal with the reason `stored_row_changed`. The earlier read only decides
 * the read-scope gate above; it never authorizes the count write on its own.
 *
 * Called by recordUsageBatch() (POST /RecordUsage, explicit usage feedback)
 * and by recordCitations() below (citation-on-write) — identical ledger
 * semantics regardless of which surface triggered the contribution.
 */
export async function recordUsageContribution(
  ctx: any,
  agentId: string,
  memoryId: string,
  attribution: string | undefined,
  now: string,
  canRead: CanReadMemory,
): Promise<void> {
  const ledgerId = `${agentId}:${memoryId}`;

  // Bypasses resources/MemoryUsage.ts's own auth wrapper by design — this
  // IS the trusted internal caller that resource's module doc describes
  // (same "raw table object" pattern resources/Memory.ts uses for
  // MemoryGrant).
  const existingContribution = await withDetachedTxn(ctx, () =>
    (databases as any).flair.MemoryUsage.get(ledgerId),
  ).catch(() => null);
  if (existingContribution) return; // already counted by this agent — silent no-op

  // Absent, unreadable, or a failed read: ONE silent no-op branch (no
  // enumeration). A read failure is never evidence the memory is readable.
  const memory = await withDetachedTxn(ctx, () => (databases as any).flair.Memory.get(memoryId)).catch(() => null);
  if (!memory || !canRead(memory)) return;

  const ledgerRecord: Record<string, unknown> = { id: ledgerId, agentId, memoryId, createdAt: now };
  if (attribution) ledgerRecord.attribution = attribution;
  // .put(), not .post(): Harper's raw TableResource has no default post()
  // implementation for a static-style (non-`isCollection`-instantiated)
  // call — confirmed live ("The MemoryUsage does not have a post method
  // implemented", statusCode 405) — the SAME class of gotcha
  // resources/Memory.ts documents for HTTP POST, but here it bites even
  // this in-process call. Irrelevant anyway: ledgerId is already a
  // deterministic composite key, so this is a create-with-explicit-id —
  // exactly what PUT (upsert) is for, not an auto-generated-id insert.
  await withDetachedTxn(ctx, () => (databases as any).flair.MemoryUsage.put(ledgerRecord));

  // Targeted usageCount-ONLY bump: read-full-record, merge just this one
  // field, write — against the RAW Memory table, NEVER Memory.put() (the
  // resource class): that would 403 this cross-agent write via its
  // ownership check, and bypassing that check directly would risk letting
  // this write path smuggle OTHER field changes through instead of just the
  // count (RecordUsage.ts module doc's "WHY THIS IS ITS OWN ENDPOINT").
  // Targeted usageCount-ONLY bump: a full-row read-modify-write through the
  // shared helper, against the RAW Memory table, NEVER Memory.put() (the
  // resource class): that would 403 this cross-agent write via its ownership
  // check, and bypassing that check directly would risk letting this write
  // path smuggle OTHER field changes through instead of just the count
  // (RecordUsage.ts module doc's "WHY THIS IS ITS OWN ENDPOINT"). The helper
  // confirms, inside its own transaction, that the stored row is still the one
  // this contribution was checked against (flair#2441): a row deleted or purged
  // after the read is not re-created (the plan skips an absent row), a same-id
  // replace is refused, and a row in a scope that no longer reads is skipped.
  await writeBackCommittedRow(
    (databases as any).flair.Memory,
    memoryId,
    (row: any) => {
      // Deleted, or moved out of the agent's read scope, between the check
      // above and this read — the count is not bumped (the ledger row written
      // above stays). The count is only ever bumped on a row in the agent's
      // read scope.
      if (!row || !canRead(row)) return { skip: true };
      const usageRow = { ...row, usageCount: (row.usageCount ?? 0) + 1 };
      stripUndeclaredMemoryAttributes(usageRow);
      return { write: usageRow };
    },
    {
      ctx,
      label: "usage-recording",
      // The row the contribution was checked against is the basis: the helper
      // refuses when the stored row is no longer it (a delete, a purge, or a
      // same-id replace with a new token).
      expectedRow: memory,
      pausePre: () => txnPausePoint("usage-count-pre"),
      pausePoint: () => txnPausePoint("usage-count"),
    },
  );
}

/**
 * Default record fetch for the read-scope gates in this module
 * (recordCitations() and the ledger read helpers below) — the RAW Memory
 * table (bypassing the Memory RESOURCE class's own read wrapper; the same
 * trusted-internal-caller pattern recordUsageContribution() uses) so
 * `scope.isAllowed` runs against the raw stored record. Never throws: a
 * fetch failure reads as "not found", which every gate treats as not
 * readable — identical to a nonexistent id.
 */
async function fetchMemoryForScopeCheck(ctx: any, memoryId: string): Promise<ScopableRecord | null> {
  return withDetachedTxn(ctx, () => (databases as any).flair.Memory.get(memoryId)).catch(() => null) as Promise<ScopableRecord | null>;
}

/**
 * Batch citation helper — credits every id in `usedMemoryIds` through
 * `recordFn` (the real `recordUsageContribution` by default), one contribution
 * per unique id, capped at `MAX_USAGE_IDS_PER_CALL`.
 *
 * Called by Memory.ts's post()/put() POST-COMMIT, wrapped in its own
 * try/catch at the call site — this function itself never throws (every
 * per-id failure is caught and logged below), but callers still isolate the
 * call as a second line of defense so a write can never be affected by
 * citation recording (flair#744 slice A invariant 1).
 *
 *   - `auth.kind !== "agent"` ⇒ return immediately, no-op. Internal/admin/
 *     anonymous writes have no agent identity to attribute a contribution
 *     TO — same rule RecordUsage.post() applies ("usage feedback requires a
 *     verified agent identity").
 *   - `usedMemoryIds` not a non-empty array of non-empty strings ⇒ no-op
 *     (advisory field, never a validated request body — a malformed value
 *     is silently ignored, never a 400).
 *   - Deduped within the call (`[...new Set(...)]`), THEN capped at
 *     MAX_USAGE_IDS_PER_CALL by slicing — a citation list is advisory, not a
 *     validated request body, so an oversized list is trimmed rather than
 *     rejected (unlike RecordUsage.post()'s validated `memoryIds`, which
 *     400s over the same cap).
 *   - Each cited id is validated against the WRITER's read scope before it
 *     is credited (flair#775 slice 1, K&S binding condition — see the module
 *     doc above): the scope is resolved ONCE per batch via resolveReadScope
 *     (the same single source every cross-agent Memory read path uses), then
 *     each id gets one raw fetch + one in-process `scope.isAllowed` check.
 *     Not-found and out-of-scope take the SAME silent-drop branch — there is
 *     no structurally distinguishable code path, error, or response
 *     difference between them that a caller could use to probe whether
 *     another agent's private id exists.
 *   - Each id is credited independently: one id throwing never stops the
 *     rest, and the failure is logged server-side, never surfaced to the
 *     caller (the write already committed by the time this runs).
 *
 * `agentId` passed to `recordFn` (and to the scope resolution) is ALWAYS
 * `auth.agentId` — the resolved auth context, never anything derived from
 * `usedMemoryIds` or any other caller-supplied input (flair#744 slice A
 * invariant 4: no forging on behalf of another identity).
 *
 * `recordFn` / `fetchFn` / `scopeFn` are unit-test injection seams
 * (test/unit/usage-recording.test.ts) — production callers pass none of
 * them and always get the real recordUsageContribution / raw-table fetch /
 * resolveReadScope.
 */
export async function recordCitations(
  ctx: any,
  auth: AgentAuthVerdict,
  usedMemoryIds: unknown,
  now: string,
  recordFn: typeof recordUsageContribution = recordUsageContribution,
  fetchFn: (ctx: any, memoryId: string) => Promise<ScopableRecord | null> = fetchMemoryForScopeCheck,
  scopeFn: typeof resolveReadScope = resolveReadScope,
): Promise<void> {
  if (auth.kind !== "agent") return;

  if (
    !Array.isArray(usedMemoryIds) ||
    usedMemoryIds.length === 0 ||
    !usedMemoryIds.every((id) => typeof id === "string" && id.length > 0)
  ) {
    return;
  }

  const ids = [...new Set(usedMemoryIds as string[])].slice(0, MAX_USAGE_IDS_PER_CALL);

  // Resolve the WRITER's read scope ONCE per batch. Fail CLOSED: if scope
  // resolution itself fails, drop the whole batch rather than credit
  // unvetted ids — citations are advisory signal, so losing a batch is
  // strictly safer than crediting an id the writer may not be able to read.
  let scope: ReadScope;
  try {
    scope = await scopeFn(auth.agentId);
  } catch (err) {
    console.error("recordCitations: read-scope resolution failed — batch dropped (no-op)", { err });
    return;
  }

  for (const id of ids) {
    try {
      // flair#775 slice 1 read-scope gate. The raw fetch + in-process
      // predicate is deliberately ONE branch for both "doesn't exist" and
      // "exists but out of the writer's read scope" — uniform silent drop
      // (see the module doc). recordUsageContribution applies the same
      // predicate again to the rows it reads itself (it is passed
      // `scope.isAllowed`), so this pre-check is a second point-lookup of
      // the same record — accepted on a ≤20-id advisory batch.
      const record = await fetchFn(ctx, id);
      if (!record || !scope.isAllowed(record)) continue;
      await recordFn(ctx, auth.agentId, id, undefined, now, scope.isAllowed);
    } catch (err) {
      // Never let one bad id stop the batch — same no-op-on-error discipline
      // as RecordUsage.post()'s loop, log server-side only.
      if (err instanceof WriteBackConflictError) {
        // flair#2441: the stored row is no longer the one read (a same-id
        // replace, or a change found on every attempt); the count bump was
        // refused and nothing was written.
        console.error("recordCitations: not credited, stored_row_changed (no-op)", { memoryId: id, reason: "stored_row_changed", err });
      } else {
        console.error("recordCitations: failed to credit (no-op)", { memoryId: id, err });
      }
    }
  }
}

/**
 * POST /RecordUsage's batch (resources/RecordUsage.ts) — credits each id in
 * `memoryIds` through `recordFn` (the real `recordUsageContribution` by
 * default) under the CALLER's read scope.
 *
 *   - The caller's scope is resolved ONCE per batch via resolveReadScope — the
 *     scope Memory.get() applies to non-admin readers, applied here to admin
 *     callers too — and its `isAllowed` predicate is handed to every
 *     contribution, which applies it to each Memory row it reads.
 *   - Fail CLOSED: if the scope cannot be resolved, nothing in the batch is
 *     credited. The endpoint's response does not change (RecordUsage.ts's
 *     "NO ID ENUMERATION"), so a failure is visible only in the server log.
 *   - Each id is credited independently: one id throwing never stops the
 *     rest, and the failure is logged server-side, never surfaced to the
 *     caller.
 *
 * Input validation, the per-call cap and the attribution sanitizer stay in
 * RecordUsage.post(); `memoryIds` arrives here already validated and deduped.
 * `recordFn` / `scopeFn` are unit-test injection seams
 * (test/unit/usage-recording.test.ts) — the production caller passes neither.
 */
export async function recordUsageBatch(
  ctx: any,
  agentId: string,
  memoryIds: readonly string[],
  attribution: string | undefined,
  now: string,
  recordFn: typeof recordUsageContribution = recordUsageContribution,
  scopeFn: typeof resolveReadScope = resolveReadScope,
): Promise<void> {
  let scope: ReadScope;
  try {
    scope = await scopeFn(agentId);
  } catch (err) {
    console.error("RecordUsage.post: read-scope resolution failed — batch not recorded (no-op)", { err });
    return;
  }

  for (const memoryId of memoryIds) {
    try {
      await recordFn(ctx, agentId, memoryId, attribution, now, scope.isAllowed);
    } catch (err) {
      // Never let one bad id fail the whole batch, and never let an internal
      // error leak existence information either — log server-side, collapse
      // to the same no-op the response already returns for every other
      // outcome.
      if (err instanceof WriteBackConflictError) {
        // flair#2441: the stored row is no longer the one read (a same-id
        // replace, or a change found on every attempt); the count bump was
        // refused and nothing was written.
        console.error("RecordUsage.post: not recorded, stored_row_changed (treated as no-op)", { memoryId, reason: "stored_row_changed", err });
      } else {
        console.error("RecordUsage.post: failed to record usage (treated as no-op)", { memoryId, err });
      }
    }
  }
}

// ─── The ledger's read rule (resources/MemoryUsage.ts) ──────────────────────
//
// A non-admin reader sees its own MemoryUsage row only while the memory the row
// names exists and is in the reader's read scope. A row about a memory the
// reader cannot read reads exactly like a row that does not exist. A failed
// scope resolution or a failed Memory read hides the row: unknown evidence is
// never treated as readable. Admin and trusted internal ledger reads do not go
// through these helpers (resources/MemoryUsage.ts leaves them unfiltered).

/**
 * Is this one ledger row about a memory `scope` can read? A row with no
 * `memoryId`, a memory that does not exist, and a failed read are all `false`.
 */
async function isLedgerRowAboutReadableMemory(
  ctx: any,
  row: any,
  scope: Pick<ReadScope, "isAllowed">,
  fetchFn: (ctx: any, memoryId: string) => Promise<ScopableRecord | null>,
): Promise<boolean> {
  const memoryId = row?.memoryId;
  if (typeof memoryId !== "string" || memoryId.length === 0) return false;
  try {
    const memory = await fetchFn(ctx, memoryId);
    return !!memory && scope.isAllowed(memory) === true;
  } catch {
    return false;
  }
}

/**
 * By-id form of the ledger read rule, for MemoryUsage.get(): resolves the
 * reader's scope and checks the one row. `false` on any failure.
 * `scopeFn` / `fetchFn` are unit-test injection seams.
 */
export async function isLedgerRowVisible(
  ctx: any,
  readerId: string,
  row: any,
  scopeFn: typeof resolveReadScope = resolveReadScope,
  fetchFn: (ctx: any, memoryId: string) => Promise<ScopableRecord | null> = fetchMemoryForScopeCheck,
): Promise<boolean> {
  let scope: ReadScope;
  try {
    scope = await scopeFn(readerId);
  } catch (err) {
    console.error("MemoryUsage.get: read-scope resolution failed — row hidden", { err });
    return false;
  }
  return isLedgerRowAboutReadableMemory(ctx, row, scope, fetchFn);
}

/**
 * Collection form of the ledger read rule, for MemoryUsage.search(): yields
 * only the rows of `rows` about memories the reader can read, in source
 * order. The scope is resolved once; if that fails, nothing is yielded.
 * `scopeFn` / `fetchFn` are unit-test injection seams.
 */
export async function* readableLedgerRows(
  ctx: any,
  readerId: string,
  rows: AsyncIterable<any> | Iterable<any>,
  scopeFn: typeof resolveReadScope = resolveReadScope,
  fetchFn: (ctx: any, memoryId: string) => Promise<ScopableRecord | null> = fetchMemoryForScopeCheck,
): AsyncGenerator<any> {
  let scope: ReadScope;
  try {
    scope = await scopeFn(readerId);
  } catch (err) {
    console.error("MemoryUsage.search: read-scope resolution failed — no rows returned", { err });
    return;
  }
  for await (const row of rows) {
    if (await isLedgerRowAboutReadableMemory(ctx, row, scope, fetchFn)) yield row;
  }
}
