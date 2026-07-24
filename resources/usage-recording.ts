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
 * `recordUsageContribution()` is an EXACT extraction of what was
 * RecordUsage.ts's private `_recordOne()` — see its doc below for the
 * ledger-then-count ordering, the individually-wrapped `withDetachedTxn`
 * discipline, and the accepted best-effort race on the final
 * read-modify-write. This move changes WHERE the logic lives, not what it
 * does — behavior is byte-identical for RecordUsage.ts's existing callers.
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
 * recordCitations() additionally validates each cited id against the
 * WRITER's own read-scope before crediting (flair#775, a Kern+Sherlock
 * binding condition on the locked design): citing a memory the writer cannot
 * read is silently dropped, uniformly with a nonexistent id — never an
 * error, never a distinguishable code path (an error, or any response/shape
 * difference, would leak "that id exists but you can't see it").
 * POST /RecordUsage is DELIBERATELY not scope-gated — its module doc
 * establishes usage feedback as a cross-agent contract (agent B reports
 * using agent A's memory regardless of A's visibility setting);
 * citation-on-write is a separate write surface with a narrower threat
 * model (the ids ride along on the WRITER's own memory-creation call, so
 * crediting an unreadable id would let a writer both probe for and boost
 * memories it cannot see). So the scope gate lives HERE, not retrofitted
 * onto recordUsageContribution() — do not "unify" the two surfaces.
 */
import { databases } from "@harperfast/harper";
import { withDetachedTxn } from "./table-helpers.js";
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

/**
 * One (agentId, memoryId) contribution — the shared ledger-write core.
 *
 * Ledger-row-create FIRST, THEN the Memory.usageCount bump — so a crash
 * between the two leaves the SAFE failure state (ledger row exists, count
 * not yet bumped: a later retry just re-checks and no-ops) rather than the
 * reverse (count bumped, no ledger row → a retry would double-count).
 *
 * Every discrete Harper call is wrapped INDIVIDUALLY in its own
 * withDetachedTxn — never one wrap around a multi-step helper. A request
 * that reads/writes MULTIPLE tables (or the same table twice) in sequence
 * can otherwise inherit a closed transaction from a prior call's drained
 * chain (table-helpers.ts's withDetachedTxn doc); resources/Memory.ts's
 * closeSupersededRecord documents exactly why a single wrap around a
 * multi-await async function does NOT protect a later call inside it —
 * this mirrors that function's literal shape (get wrapped, then a
 * SEPARATE put wrapped) rather than delegating to the generic
 * patchRecord() helper, which would combine both into one un-safe wrap.
 *
 * The final get-then-put for the increment is a best-effort (non-atomic)
 * read-modify-write, same class of race already accepted elsewhere in
 * this codebase for count fields (e.g. retrievalCount's bump in
 * SemanticSearch.ts) — a concurrent contribution from a DIFFERENT agent
 * landing between this call's read and write could lose one increment.
 * Re-fetching immediately before the write (rather than reusing the
 * earlier existence-check read) narrows, without eliminating, that
 * window. Not solved here: bounded, low-severity (an undercount, never an
 * inflation), and orthogonal to the anti-gaming properties the cap/floor
 * and dedup ledger actually defend.
 *
 * Called by RecordUsage.post() (explicit usage feedback) and by
 * recordCitations() below (citation-on-write) — identical ledger semantics
 * regardless of which surface triggered the contribution.
 */
export async function recordUsageContribution(
  ctx: any,
  agentId: string,
  memoryId: string,
  attribution: string | undefined,
  now: string,
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

  const memoryExists = await withDetachedTxn(ctx, () => (databases as any).flair.Memory.get(memoryId)).catch(() => null);
  if (!memoryExists) return; // no such memory — silent no-op (no enumeration)

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
  const fresh = await withDetachedTxn(ctx, () => (databases as any).flair.Memory.get(memoryId)).catch(() => null);
  if (!fresh) return; // deleted between the checks above and now — no-op
  await withDetachedTxn(ctx, () =>
    (databases as any).flair.Memory.put({ ...fresh, usageCount: (fresh.usageCount ?? 0) + 1 }),
  );
}

/**
 * Default record fetch for recordCitations()'s read-scope gate — the RAW
 * Memory table (bypassing the Memory RESOURCE class's own read wrapper; the
 * same trusted-internal-caller pattern recordUsageContribution() uses) so
 * `scope.isAllowed` runs against the raw stored record. Never throws: a
 * fetch failure reads as "not found", which the gate silently drops —
 * identical to a nonexistent id.
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
      // (see the module doc). recordUsageContribution's own existence
      // re-check makes this a second point-lookup of the same record;
      // accepted — keeping the shared ledger core byte-identical for
      // RecordUsage.post() is worth two point-lookups on a ≤20-id advisory
      // batch.
      const record = await fetchFn(ctx, id);
      if (!record || !scope.isAllowed(record)) continue;
      await recordFn(ctx, auth.agentId, id, undefined, now);
    } catch (err) {
      // Never let one bad id stop the batch — same no-op-on-error discipline
      // as RecordUsage.post()'s loop, log server-side only.
      console.error("recordCitations: failed to credit (no-op)", { memoryId: id, err });
    }
  }
}
