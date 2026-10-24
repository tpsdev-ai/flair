/**
 * embedding-stamp.ts — the first registered migration (per the spec):
 * re-embeds every Memory row whose `embeddingModel` doesn't match
 * `getModelId()`. riskClass 'derived-only' — embeddings are recomputable
 * from `content` (SOURCE_FIELDS), never the only copy of anything
 * (invariant I), so this is the cheapest posture: metadata-only snapshot,
 * no content-hash gate (row-count + stamp convergence only).
 *
 * THE GATE (`EMBEDDING_PREFIXES_ENABLED` in resources/embeddings-provider.ts)
 * is now ON (flair#504, flipped and re-baselined through the ratchet gate),
 * so `getModelId()` returns `<base>+searchprefix` — every row written before
 * this flip was stamped with the bare base id, so it now reads as stale and
 * gets picked up by this migration on the next boot that reaches it. This is
 * this migration's first real payload: before the flip, `getModelId()`
 * returned the bare base id unconditionally, so this migration — live and
 * always-registered from the day it shipped — had nothing to detect. That
 * was intentional groundwork, not dead code: proving the detect/re-embed
 * mechanism end-to-end (this file, `test/integration/
 * migrations-embedding-stamp-e2e.test.ts`) before it ever had real work to
 * do was the point.
 *
 * flair#1073: that self-heal sat idle for days on a Fabric instance. The
 * runner is boot-keyed; a first detect() against a not-yet-visible corpus
 * (or a version-keyed short-circuit after a no-op complete) marked this
 * migration done while 554 pre-flip rows stayed stale. `alwaysDetect`
 * plus delayed follow-up cycles close that; /HealthDetail names this
 * migration when the corpus is still split. run() has no batch cap — the
 * runner loops until processed=0 — and a re-run is idempotent.
 *
 * Reuses Memory's OWN regen branch — never duplicates embedding logic —
 * via a genuine `PATCH /Memory/:id` HTTP request (admin-authenticated
 * loopback), not an in-process call on `databases.flair.Memory` directly.
 * The one exception is a row whose id ends in `.content`, which that request
 * cannot address (see regenContentSuffixRow below).
 *
 * The request is the re-embed PATCH (flair#2296): body
 * `{"embedding": null, "embeddingModel": null}`. Memory.patch() embeds the row
 * the PATCH handler reads and writes `embedding`, `embeddingModel`, `updatedAt`
 * and `embeddedContentHash` (and `instanceToken` on a legacy row that has none).
 * Edits committed after this migration's read and before the PATCH handler's
 * stored-row read are kept (flair#2275); the handler reads, embeds and commits
 * under the id's per-id write lock (flair#2478, below). A text change by a
 * writer outside that lock is detected only up to and including the request's
 * final post-commit read-back: seen at an attempt's fresh read it is
 * re-embedded; seen at the confirmation or a read-back, the attempt retries
 * within its bound or the request refuses, as Memory.patch documents. A
 * lock-bypassing write committed after that final read-back is not detected by
 * this request.
 *
 * THIS IS LOAD-BEARING, confirmed empirically while building
 * test/integration/migrations-embedding-stamp-e2e.test.ts against real
 * Harper: `databases.flair.Memory` (the property Harper exposes to OTHER
 * modules, imported the same way resources/health.ts / MemoryReindex.ts /
 * etc. already do for READS) resolves to the RAW underlying table, not the
 * resources/Memory.ts SUBCLASS that carries the actual regen/dedup/auth
 * logic — that subclass is only reachable via Harper's own REST dispatch
 * for a genuine `/Memory` request. Calling `.put()` on the raw reference
 * writes the record fine (confirmed: fields land exactly as passed) but
 * silently skips every override in resources/Memory.ts, INCLUDING the
 * re-embed branch this migration exists to trigger. Reads
 * (`.search()`/`.get()`, used below for detect/countPending/candidate-selection)
 * are unaffected by this — only the re-embed request needs the real dispatch,
 * hence the loopback HTTP call for exactly that one step.
 *
 * Query correctness (also verified against real Harper): Harper's
 * `not_equal` comparator only matches rows where the attribute holds an
 * EXPLICIT value (including explicit `null`) — a row where the attribute
 * was NEVER SET AT ALL (`getIndexedValues()` returns `undefined` for a
 * truly-absent property, never indexed regardless of `indexNulls`) is
 * invisible to ANY condition-based query, not just `not_equal`. A re-embed
 * request that fails (engine not yet warmed up, transient failure, admin
 * credential unavailable this cycle) is retried on a later cycle while the row
 * still matches the pending condition.
 * The pending condition is an OR of `not_equal <current>` (catches a
 * stale non-null model string) and `equals null` (catches an explicit-null
 * state). A row whose `embeddingModel` was NEVER
 * touched by anything (truly absent from its very first write — only
 * possible if the embeddings engine was down for that entire write) is a
 * known, narrow gap this bounded query cannot see;
 * resources/migration-boot.ts mitigates the common case by waiting for the
 * embeddings engine to settle before running migrations at all.
 *
 * flair#807 — completion-gate false-negative on 0.10-era / cross-version
 * stores, root-caused against the installed `harper@5.1.22`
 * source (node_modules/harper/resources/search.ts): for an
 * INDEXED attribute (`embeddingModel` IS `@indexed` — schemas/memory.graphql),
 * a non-negated `not_equal`/`ne` leaf condition takes `searchByIndex`'s
 * `index && !skipIndex` branch, which reconstructs a SYNTHETIC partial record
 * from the SECONDARY INDEX KEY alone (`recordMatcher = { [attribute_name]:
 * key }`, resources/search.ts ~L418) and filters against THAT — never reading
 * the live record. On a store whose rows were written under flair 0.10.0 /
 * Harper 5.0.x and later rewritten via `PUT /Memory` (crossing a Harper
 * 5.0.21→5.1.22 boot), the secondary index for `embeddingModel` can lag the
 * live, on-disk value — the filter then evaluates a STALE key that never
 * equals `getCurrentModelId()`, matching every row regardless of its true
 * (already-current) stamp.
 *
 * The fix: use `comparator: "not_equals"` (the `not_` PREFIX form, distinct
 * from the legacy `not_equal`/`ne` ALIAS — see search.ts's
 * `resolveComparator`/`NEGATABLE_BASE_COMPARATORS`) for the not-current leg.
 * `prepareConditions` resolves this to `{comparator: "equals", negated:
 * true}`, which flips `searchByIndex`'s `skipIndex` flag
 * (`searchCondition.negated && index && !isPrimaryKey`) — this is Harper's
 * OWN documented mechanism for "bypass the secondary index, iterate the
 * primary store directly" (see that file's comment: "we need to consider
 * records whose attribute value is missing from the index... so we bypass
 * the secondary index"). That path reads the LIVE record unconditionally,
 * immune to any index/record divergence regardless of cause (this migration,
 * a future one, or a Harper-internal index-rebuild timing issue). Strictly
 * MORE reliable than the index-assisted path in every case — a genuinely
 * stale row still matches (full scan over live values), so this changes
 * nothing about the "3/3 success" happy path, only closes the false-positive
 * gap on migrated stores. The `equals: null` leg is unaffected (not a
 * negated comparator — no analogous bypass exists or is needed; its
 * behavior was already verified against real Harper per the doc above).
 *
 * NO `recheckPending()` (the runner's flair#807 completion-gate safety net,
 * resources/migrations/runner.ts) since flair#2465. `countPending()` now scans
 * every row's live value instead of querying an index, so there is no index
 * artifact for that net to excuse. A recheck that re-derived its candidates
 * from the `staleCondition()` query could also sample rows other than the ones
 * the scan counted (a row pending only on its stored hash is invisible to that
 * query) and pass the gate with that row still pending.
 *
 * ROOT-CAUSE GUARD — recall graph correctness (recall-hnsw-graph-heal).
 * This migration RE-EMBEDS rows in BULK via `PATCH /Memory/:id` — it replaces
 * the stored vector of many rows in place. Historically, an OLDER (pre-fix)
 * Harper's INCREMENTAL HNSW update left stale/asymmetric reverse edges under
 * exactly this kind of bulk re-embed (order-dependent), which collapsed prod
 * recall (p@3 0.25) in July. That engine bug is FIXED in the Harper this ships
 * against (5.1.22): its index() reconstructs the prior vector from the stored
 * node and carries the node's real connections into the reverse-edge cleanup
 * the old build skipped, so a bulk re-embed no longer corrupts the graph.
 * DEFENSE-IN-DEPTH RULE (a prudent, version-independent default — not a
 * workaround for a live bug): pair any BULK re-embed with a structural graph
 * REBUILD trigger rather than relying on incremental HNSW updates to converge
 * — it keeps recall correct regardless of engine version, closes the rare
 * decode-failure edge case, and heals a graph already corrupted on disk by an
 * older engine. Do NOT reach for resources/MemoryReindex.ts's `_reindex` for
 * graph correctness (it re-PUTs the same vector through the incremental path
 * and rebuilds nothing). The lever flair uses is a structural schema-descriptor
 * change: the `@indexed(type:"HNSW", M:16)` bump in schemas/memory.graphql
 * ships alongside this migration precisely so a graph corrupted under an older
 * engine is rebuilt on the upgrade boot (observed/ledgered by
 * resources/migrations/graph-heal.ts). Before enabling any FUTURE bulk
 * re-embed, ship a structural reindex trigger with it.
 *
 * flair#2465 part 2 — the stored text hash. A re-embed can still store the
 * vector for the text it read when a text edit commits after that read and
 * before the commit (Harper has no compare-and-set; the field-only write and the
 * committed-row confirm are checked again by the post-commit verification, which
 * retries from a fresh read). To catch the rows an earlier edit leaves behind,
 * the server stores a newly computed
 * `embeddedContentHash` (resources/memory-embed-hash.ts) when it computes a
 * vector on a guarded path for a row with a non-empty owner, and this migration
 * re-queues a row whose stored hash differs from the expected hash of its
 * current embedding text. No query can compute that expected hash (a condition
 * compares a stored value to a constant), so finding a mismatch takes a LIVE
 * SCAN: `detect` runs the `staleCondition()` query first and scans only when
 * the query finds nothing; `countPending` and `run` scan the whole table
 * directly, applying `rowEmbeddingCurrent` per row. A row with no stored hash
 * (e.g. written before this change, created with a vector accepted from the
 * caller, or with an empty owner) bypasses only the hash comparison: it is
 * current when its model is current-space. A rule that queued every missing hash
 * would queue every legacy row at upgrade, and could leave pending a row that
 * cannot get a hash (one with an empty owner); a missing hash skips the
 * comparison instead.
 *
 * flair#2478 slice 3 — the per-id Memory write lock. Both write paths write
 * under the id's lock shared with the owner verbs (resources/memory-write-lock.ts).
 * The HTTP delegation's `PATCH /Memory/:id` takes it in Memory.patch (phase
 * `patch-reembed`) with the owner budget; a refusal (`503 memory_busy`,
 * `write_outcome_unknown`, `memory_provider_timeout`) is logged and leaves the
 * row uncounted; the next scan decides whether it is still stale (an owner write
 * can make it current meanwhile). Under the lock that PATCH re-reads the
 * committed row and embeds its stored text, so an owner edit committed after
 * this migration's read is the row it re-embeds; it writes only the embedding
 * fields (and gives a legacy row with no `instanceToken` one) and commits before
 * the lock is released. The `.content`-suffix fallback computes its vector
 * first, then takes the id's lock (phase `embedding-stamp-content-suffix`) with
 * one non-waiting acquisition per attempt; a retry acquires it again. On a
 * held id, an id with an unresolved write outcome, or a store with no lock,
 * that attempt writes nothing and is logged, and the row is left uncounted;
 * the next scan decides whether it is still stale. After an earlier attempt
 * for the same row committed unconfirmed, that line says the outcome is
 * unknown, and the unconfirmed outcome is logged as well. Under the lock it re-reads the committed row, writes only when
 * that row is the one it embedded, and commits and verifies the committed row
 * before the release. A row changed at that in-lock read, or a change visible
 * at the confirmation (which aborts the transaction), writes nothing and leaves
 * the row uncounted. A readable read-back mismatch retries with a fresh read, a
 * vector computed before the lock and a new acquisition, at most
 * CONTENT_SUFFIX_REGEN_ATTEMPTS (3) attempts; an unreadable read-back, or the
 * attempts exhausted, is logged as unconfirmed and leaves the row uncounted
 * for the next scan. A retry after an unconfirmed attempt compares the row's
 * stored vector with the vector that attempt staged (within a relative
 * tolerance that accepts a float32 copy of an in-range component; a non-finite
 * component never matches), not the stored text hash (null for a row with an
 * empty owner): a match beside a changed text is not treated as current, so the
 * retry re-embeds the current text. A row whose stamp is not current or whose
 * stored hash does not match its text is re-embedded whatever vector it holds; the
 * staged-vector comparison only decides, on a retry, whether a row that
 * otherwise counts as current (a null hash passes for any text) is re-embedded.
 */
import { databases } from "harper";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { confirmCommittedRow, verifyCommittedFields, type CommittedWriteVerdict } from "../write-back.js";
import { withMemoryWriteLockOnce, type MemoryLockOutcome } from "../memory-write-lock.js";
import { getEmbedding, getModelId } from "../embeddings-provider.js";
import { withOwnedTransaction } from "../request-transaction.js";
import { txnPausePoint } from "../txn-pause-point.js";
import { harperPortValue } from "../../src/lib/harper-port-value.js";
import { DEFAULT_HTTP_PORT } from "../a2a-url.js";
import { currentSpaceRawForms, isCurrentSpaceStamp } from "../embedding-space-guard.js";
import type { Migration, RunBatchResult } from "./types.js";
import { EMBEDDING_STAMP_ID } from "./stamp-outstanding.js";
import { endsWithContentSelectorSuffix } from "../../src/lib/memory-id-policy.js";
import { skillEmbedText } from "../skill-write.js";
import { embeddedHashMatches, embeddedTextHash, holdsOwnStaleVector, type StagedVector } from "../memory-embed-hash.js";

export { EMBEDDING_STAMP_ID };

export interface MemoryTableLike {
  search(query: unknown): AsyncIterable<Record<string, unknown>>;
  /** `context` carries the owned transaction of the content-suffix fallback below, or an
   *  empty context for its re-read of the committed row. */
  get(id: string, context?: unknown): Promise<Record<string, unknown> | null>;
  /** The raw table write handle, used only for the content-suffix fallback below: an
   *  incremental update of the embedding fields (flair#2465), never a full-row put. */
  update(id: string, row: Record<string, unknown>, context?: unknown): Promise<unknown>;
}

function defaultMemoryTable(): MemoryTableLike {
  return (databases as unknown as { flair: { Memory: MemoryTableLike } }).flair.Memory;
}

const REGEN_HTTP_TIMEOUT_MS = 20_000; // a real embedding compute can be slow on constrained hardware
/** Attempt bound for a `.content`-suffix re-embed. */
const CONTENT_SUFFIX_REGEN_ATTEMPTS = 3;

/** Test-only: record each run's result when fault injection is armed. */
function noteTestMigrationRun(result: RunBatchResult): void {
  if (process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION !== "1") return;
  const dir = process.env.FLAIR_TEST_PAUSE_DIR;
  if (!dir) return;
  try {
    appendFileSync(join(dir, "embedding-stamp-runs.jsonl"), `${JSON.stringify(result)}\n`);
  } catch {
    // Append errors are ignored.
  }
}

/** Same admin-password resolution as resources/auth-middleware.ts's getAdminPass(). */
function resolveAdminAuthHeader(): string | null {
  const pass = process.env.HDB_ADMIN_PASSWORD ?? process.env.FLAIR_ADMIN_PASSWORD;
  if (!pass) return null;
  return "Basic " + Buffer.from(`admin:${pass}`).toString("base64");
}

/**
 * Base URL for the loopback self-call that regenerates an embedding.
 *
 * ALWAYS loopback. This is the destination of a credentialed self-call —
 * `regenViaHttpPatch` sends `Authorization: Basic` carrying the admin password to
 * it — so it must never leave the box. `FLAIR_PUBLIC_URL` names a remote /
 * reverse-proxied origin and is deliberately ignored here, matching
 * `a2a-url.localBaseUrl` ("never the public/proxy URL"): two self-call
 * resolvers, both pinned to loopback. The public-facing resolvers (e.g.
 * oauth-discovery, AdminInstance, XAA; also a2a-url.resolvePublicBaseUrl and
 * the MCP issuer resolvers) honour `FLAIR_PUBLIC_URL` precisely because their
 * output is meant to be reachable off-box; this one's output is not. That list
 * is illustrative, not exhaustive — the deciding question is whether the URL
 * leaves the box, not a roster of call sites.
 *
 * Pinned by the "loopback self-call target" suite in
 * test/unit/host-qualified-port-consumers.test.ts, which asserts this returns
 * loopback even when `FLAIR_PUBLIC_URL` is set (and not merely that it parses).
 *
 * `HTTP_PORT` is parsed through `harperPortValue` so a host-qualified value
 * (`127.0.0.1:19926`) yields a valid URL rather than a doubled host. Absent
 * (or out-of-range) falls back to `DEFAULT_HTTP_PORT` (19926) — NOT the legacy
 * early-install 9926 this used to reach for. 9926 is Harper's OWN default bind,
 * which is what the one boot shape that reaches this fallback actually uses: a
 * bare `harper run .` that flair did not spawn. On a pre-March data dir that
 * 9926 coincidentally matched the real bind; post-March 19926 does. Both are
 * guesses — `HTTP_PORT` is the only channel carrying the truth.
 */
export function resolveSelfBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `http://127.0.0.1:${harperPortValue(env.HTTP_PORT) ?? DEFAULT_HTTP_PORT}`;
}

/**
 * Triggers Memory.patch()'s re-embed branch via a genuine loopback HTTP
 * PATCH — the ONLY reliable way to reach resources/Memory.ts's subclass logic
 * (see module doc). The body names only the two embedding fields, never the
 * row this migration read. Returns true iff the request succeeded (2xx);
 * NEVER throws — on false the row is re-checked on the next batch or cycle.
 */
async function regenViaHttpPatch(
  id: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const authHeader = resolveAdminAuthHeader();
  if (!authHeader) return false; // no admin credential available this cycle — retried next boot
  try {
    const res = await fetchImpl(`${resolveSelfBaseUrl()}/Memory/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({ embedding: null, embeddingModel: null }),
      signal: AbortSignal.timeout(REGEN_HTTP_TIMEOUT_MS),
    });
    if (res.status === 503) await logRegenRefusal(id, res);
    return res.ok;
  } catch {
    return false;
  }
}

/** A 503 from the re-embed request (flair#2478). `memory_busy` (the id stayed
 *  held through the request's wait budget) and `memory_provider_timeout` (the
 *  locked-provider bound) mean the request wrote nothing: a provider timeout
 *  after an earlier attempt of the same request committed unconfirmed answers
 *  `write_outcome_unknown` instead. `write_outcome_unknown` means the id has an
 *  unresolved write, which can be this request's own re-embed (a committed row
 *  it could not read back, or one whose read-back did not show the write, or a
 *  step after a commit that failed before any read-back), so that write may have
 *  committed. The
 *  row is uncounted; the next scan decides whether it is still stale. Logs the
 *  refusal's code. */
async function logRegenRefusal(id: string, res: Response): Promise<void> {
  let code = "unnamed";
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === "string") code = body.error;
  } catch {
    // An unreadable refusal body is logged as unnamed.
  }
  console.warn("[embedding-stamp] %s: the re-embed request was refused 503 %s; the row is uncounted and the next scan decides whether it is still stale", id, code);
}

/** A vector this migration may stamp as current: a non-empty array of finite numbers. */
function isUsableEmbedding(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((n) => typeof n === "number" && Number.isFinite(n));
}

/**
 * Is this row's stored embedding current? Current means BOTH its
 * `embeddingModel` is a current-space stamp for `currentModelId` AND either it
 * stores no `embeddedContentHash` or the stored hash equals the expected hash of
 * the row's current embedding text (`memory-embed-hash.ts`). No query can
 * compute that expected hash, so a caller that needs to find a hash mismatch
 * must scan (see each method below).
 */
function rowEmbeddingCurrent(row: Record<string, unknown>, currentModelId: string): boolean {
  return isCurrentSpaceStamp(row.embeddingModel as string | null | undefined, currentModelId) &&
    embeddedHashMatches(row);
}

/** The seams the content-suffix fallback reaches; injectable for unit tests. */
export interface ContentSuffixRegenDeps {
  embed: (text: string) => Promise<unknown>;
  inTransaction: <T>(fn: (txn: unknown) => Promise<T>) => Promise<T>;
  /** The store whose per-id lock the fallback writes under: `Memory.primaryStore`
   *  (flair#2478). With a store that has no lock nothing is written (never
   *  unserialized) and the row is uncounted. */
  lockStore?: () => unknown;
}

/** The Memory table's primary store, whose per-id lock the owner verbs take. */
function defaultMemoryLockStore(): unknown {
  return (defaultMemoryTable() as unknown as { primaryStore?: unknown }).primaryStore;
}

const defaultContentSuffixRegenDeps: ContentSuffixRegenDeps = {
  embed: (text) => getEmbedding(text, "document"),
  inTransaction: (fn) => withOwnedTransaction(undefined, fn),
  lockStore: defaultMemoryLockStore,
};

/** One `.content`-suffix re-embed attempt: nothing written (`skipped`); not
 *  attempted because the id's lock answered other than a completed callback
 *  (`lock`); or written, committed and verified under the lock (`verified`). */
type ContentSuffixAttempt =
  | { kind: "skipped" }
  | { kind: "lock"; outcome: Exclude<MemoryLockOutcome<unknown>["kind"], "done"> }
  | { kind: "verified"; verdict: CommittedWriteVerdict; staged: StagedVector };

/**
 * Re-embed a legacy row whose id ends in the `.content` property suffix. The
 * loopback `PATCH /Memory/:id` the regen path uses cannot address such an id
 * (Harper's REST by-id path reads the suffix as a selector, and the write path
 * refuses the id), so this computes the embedding itself and writes through the
 * raw table handle.
 *
 * The text embedded is the one Memory's own write paths embed for the row
 * (`skillEmbedText`: a skill row's `trigger` when present, else `content`); a
 * row with no such text is not embedded.
 *
 * The vector is computed BEFORE the id's per-id write lock is taken
 * (flair#2478): no provider call runs while the id is locked. Each call of this
 * function is one attempt and tries the lock once, without waiting (the
 * caller's retry calls it again); a held id, an unresolved-outcome marker or a store with no lock answers
 * `lock` and writes nothing. Holding it, the attempt re-reads the committed row:
 * a row that is not the one the vector was computed for (gone, or any field
 * changed) is `skipped` and nothing is written; a later scan decides whether
 * it is still stale, and if so computes again.
 *
 * Writes a usable vector in an owned transaction. It STAGES an incremental
 * `update` of only `embedding`, `embeddingModel`, `updatedAt` and
 * `embeddedContentHash` — the field-only write Memory's own re-embed branch
 * uses (flair#2465), never a full-row put — and the write touches no other field
 * of the committed row. (Memory's re-embed branch also gives a legacy row with
 * no `instanceToken` one, flair#2478; this fallback writes no token.)
 * Then it CONFIRMS the committed row (an explicit fresh context) is still the
 * row this transaction read and embedded; a row gone or distinguishably changed
 * at confirmation aborts the owned transaction (`skipped`, nothing written).
 *
 * The post-commit read detects surviving differences in compared fields,
 * identity or embedding text. The confirmation compares the WHOLE committed row
 * with the row read (the supersede-close pattern), which is stronger than the
 * identity list alone: a content-only change to a row that lacks a stored
 * incarnation token (a legacy row may lack one) still fails it. The vector is computed for text unchanged through confirmation.
 *
 * After the commit, still holding the lock, it re-reads the committed row in a
 * fresh context (flair#2656) and returns the verdict: `shown` only when the row
 * still has this attempt's identity, the staged fields, and the text the vector
 * was computed for. The lock is released after that read. A row this attempt
 * did not confirm is uncounted; the next batch or scan decides whether it is
 * still stale.
 */
async function regenContentSuffixRow(
  table: MemoryTableLike,
  id: string,
  existing: Record<string, unknown>,
  current: string,
  deps: ContentSuffixRegenDeps,
): Promise<ContentSuffixAttempt> {
  try {
    const text = skillEmbedText(existing);
    if (typeof text !== "string" || text.length === 0) return { kind: "skipped" };
    const embedding = await deps.embed(text);
    if (!isUsableEmbedding(embedding)) return { kind: "skipped" };
    // Test-only: inert unless the fault-injection env opt-in is set and armed.
    // The vector is computed and the id's lock is not yet taken.
    const before = txnPausePoint("embedding-stamp-content-suffix-pre");
    if (before) await before;
    const locked = await withMemoryWriteLockOnce((deps.lockStore ?? defaultMemoryLockStore)(), [id], async (): Promise<ContentSuffixAttempt> => {
      const staged = await stageContentSuffixUpdate(table, id, existing, current, embedding, text, deps);
      if (!staged) return { kind: "skipped" };
      // Test-only: inert unless the fault-injection env opt-in is set and armed.
      // After this attempt's transaction commits and before its committed-row
      // read-back; the lock is held.
      const verifyPause = txnPausePoint("embedding-stamp-content-suffix-verify");
      if (verifyPause) await verifyPause;
      // The staged vector counts only when the committed row still carries the
      // exact text the vector was computed for.
      const verdict = await verifyCommittedFields(
        table, id, staged.identity, staged.fields,
        (committed) => skillEmbedText(committed) === staged.text,
      );
      // Test-only: the attempt has committed and read its row back; the lock is
      // still held.
      const committedPause = txnPausePoint("embedding-stamp-content-suffix-committed");
      if (committedPause) await committedPause;
      return { kind: "verified", verdict, staged: { embedding, text: staged.text } };
    }, { phase: "embedding-stamp-content-suffix" });
    if (locked.kind !== "done") return { kind: "lock", outcome: locked.kind };
    return locked.value;
  } catch {
    // Includes CommittedRowChanged: the transaction was aborted, nothing written.
    return { kind: "skipped" };
  }
}

/** The fallback's owned transaction, run while the caller holds the id's lock:
 *  the re-read, the staged update, the committed-row confirmation and the commit.
 *  Returns the staged row and fields, or false when the re-read row is not the
 *  row the vector was computed for. A failed confirmation throws (the
 *  transaction aborts). */
async function stageContentSuffixUpdate(
  table: MemoryTableLike,
  id: string,
  existing: Record<string, unknown>,
  current: string,
  embedding: number[],
  text: string,
  deps: ContentSuffixRegenDeps,
): Promise<{ identity: Record<string, unknown>; fields: Record<string, unknown>; text: string } | false> {
  return deps.inTransaction(async (txn) => {
    const fresh = await table.get(id, txn);
    if (!fresh || !isDeepStrictEqual(fresh, existing)) return false;
    // flair#2465: an incremental update of ONLY the embedding fields, not a
    // full-row put. A full-row put carries this transaction's re-read row and
    // can revert a field an owner edit committed meanwhile; this write touches
    // only embedding/embeddingModel/updatedAt and the embedded-text hash.
    const update = { embedding, embeddingModel: current, updatedAt: new Date().toISOString(), embeddedContentHash: embeddedTextHash(existing) ?? null };
    await table.update(id, update, txn);
    // Test-only: inert unless the fault-injection env opt-in is set and armed.
    // After the write is STAGED and before the transaction commits.
    const pause = txnPausePoint("embedding-stamp-content-suffix");
    if (pause) await pause;
    // Stage first, then confirm the COMMITTED row is still the row this
    // transaction read and embedded; gone or distinguishably changed at
    // confirmation aborts (the staged write is discarded). Post-commit
    // verification retries surviving differences in compared fields, identity
    // or embedding text from a fresh read.
    await confirmCommittedRow(table, id, (committed) => isDeepStrictEqual(committed, fresh));
    // Test-only: inert unless the fault-injection env opt-in is set and armed.
    // Holds the regen after its final pre-commit confirmation and before its
    // owned transaction commits (flair#2656).
    const commitPause = txnPausePoint("embedding-stamp-content-suffix-commit");
    if (commitPause) await commitPause;
    return { identity: fresh, fields: update, text };
  });
}

/**
 * `getTable`/`getCurrentModelId`/`regen` are injectable so unit tests can
 * exercise this migration's full detect/countPending/run logic against an
 * in-memory fake table and a fake regen function (no real Harper, no real
 * HTTP needed) — matching the mocking technique used throughout
 * test/unit/*.ts (e.g. test/unit/instance-identity.test.ts). The real
 * loopback-HTTP regen path is exercised for real in
 * test/integration/migrations-embedding-stamp-e2e.test.ts.
 */
export function createEmbeddingStampMigration(
  getTable: () => MemoryTableLike = defaultMemoryTable,
  getCurrentModelId: () => string = getModelId,
  regen: (id: string, existing: Record<string, unknown>) => Promise<boolean> = (id) =>
    regenViaHttpPatch(id, fetch),
  contentSuffixRegen: ContentSuffixRegenDeps = defaultContentSuffixRegenDeps,
): Migration {
  function staleCondition() {
    // OR-combined: `not_equals <current>` catches a stale non-null model
    // string; `equals null` catches an explicit-null state (see the
    // module doc above — Harper's index never sees a TRULY ABSENT
    // property, only an explicit null).
    //
    // "not_equals" (NOT the legacy "not_equal" alias — see the flair#807
    // addendum in the module doc) is load-bearing: it's the `not_` PREFIX
    // form Harper's query engine resolves to a `negated: true` leaf, which
    // bypasses the (on some stores, stale/desynced) secondary index and
    // reads the live record directly. Reverting this to "not_equal" would
    // reopen #807 on any store where the embeddingModel index lags the
    // on-disk value.
    // embedding-space-guard slice 1: getModelId() now stamps the
    // ENGINE-QUALIFIED id (`gguf:<base>[+searchprefix]`). Today's corpus is
    // stamped with the BARE name, which denotes the SAME space — so a row is
    // current-space iff its stamp is EITHER the qualified id OR its bare
    // equivalent. `currentSpaceRawForms()` returns both; stale = matches
    // NEITHER (an AND of `not_equals`), so a legacy bare row is NOT re-embedded
    // (which would loop forever — Memory.put re-stamps it qualified, still
    // "!= bare" under a single-value check). Each leg stays the `not_equals`
    // PREFIX form (flair#807: resolves to a negated-equals leaf that bypasses a
    // possibly-stale secondary index and reads the live record).
    const forms = currentSpaceRawForms(getCurrentModelId());
    const notCurrentSpace = forms.length === 1
      ? { attribute: "embeddingModel", comparator: "not_equals", value: forms[0] }
      : {
          operator: "and",
          conditions: forms.map((f) => ({ attribute: "embeddingModel", comparator: "not_equals", value: f })),
        };
    return [
      {
        operator: "or",
        conditions: [
          notCurrentSpace,
          { attribute: "embeddingModel", comparator: "equals", value: null },
        ],
      },
    ];
  }

  return {
    id: EMBEDDING_STAMP_ID,
    riskClass: "derived-only",
    affectsTables: ["Memory"],
    // flair#1073: pending work is "does any row's stamp differ from
    // getModelId()", not "did this version already record success." A
    // Fabric boot that detect()'d empty (tables ready, corpus not yet
    // visible) or a no-op complete at the searchprefix-flip version wrote
    // success and then skipped every later boot at that version — 554
    // pre-flip rows sat stale for days. alwaysDetect keeps the cheap
    // limit=1 corpus read on every cycle so a false complete cannot hide
    // remaining work. run() is idempotent; a re-run over already-current
    // rows is a no-op.
    alwaysDetect: true,

    async detect(): Promise<boolean> {
      const table = getTable();
      // The query leg first: a row whose stamp is not current-space (cheap,
      // index- or live-read backed — see staleCondition()).
      for await (const _row of table.search({ conditions: staleCondition(), limit: 1 })) {
        return true;
      }
      // The mismatch leg: a row whose stamp IS current-space but whose stored
      // hash differs from the expected hash of its current text. No query can
      // compute that expected hash, so this is a live scan; it exits at the
      // first mismatch.
      const current = getCurrentModelId();
      for await (const row of table.search({})) {
        if (!rowEmbeddingCurrent(row as Record<string, unknown>, current)) return true;
      }
      return false;
    },

    async countPending(): Promise<number> {
      const table = getTable();
      const current = getCurrentModelId();
      let n = 0;
      for await (const row of table.search({})) {
        if (!rowEmbeddingCurrent(row as Record<string, unknown>, current)) n++;
      }
      return n;
    },

    async run(batchSize: number): Promise<RunBatchResult> {
      const table = getTable();
      const current = getCurrentModelId();

      const candidates: Record<string, unknown>[] = [];
      for await (const row of table.search({})) {
        if (!rowEmbeddingCurrent(row as Record<string, unknown>, current)) candidates.push(row);
        if (candidates.length >= batchSize) break;
      }

      const touchedIds: string[] = [];
      for (const row of candidates) {
        const id = String((row as { id?: unknown }).id ?? "");
        if (!id) continue;
        const existing = await table.get(id);
        if (!existing) continue; // deleted since the search above — nothing to fix
        if (rowEmbeddingCurrent(existing, current)) {
          // Current now although the scan above selected it: another writer's
          // change between the scan and this read. This run has not attempted
          // the row, so it is not this migration's work and stays uncounted
          // (flair#2840).
          continue;
        }

        let ok: boolean;
        if (endsWithContentSelectorSuffix(id)) {
          // flair#2656: the commit is not proof the update landed. A newer write
          // committing after the confirm read can make the commit resolve while
          // discarding this update. Re-read from committed state within this
          // bound; count the row touched only when the committed row shows the
          // staged fields and the text the vector was computed for.
          ok = false;
          let unconfirmed = false;
          // The vector and text of this row's last unconfirmed attempt.
          let ownUnconfirmed: StagedVector | undefined;
          // One guard over the whole retry loop (flair#2478): when the loop ends
          // without a verified attempt after an attempt whose committed write is
          // unconfirmed, by a break, a refusal or a thrown error, the unconfirmed
          // outcome is logged exactly once. A later verified attempt sets `ok`,
          // and nothing is logged. An error the loop itself throws (a retry's
          // fresh read of the row) propagates to the runner after the line is
          // logged; an error inside an attempt is caught by regenContentSuffixRow
          // and ends the loop as a skipped attempt.
          try {
            for (let attempt = 1; attempt <= CONTENT_SUFFIX_REGEN_ATTEMPTS; attempt++) {
              const rowNow = attempt === 1 ? existing : await table.get(id);
              if (!rowNow) break;
              // A row another writer already made current is not this migration's
              // write. Leave it uncounted; a later scan decides whether anything
              // still needs re-embedding. A row whose stored vector matches the
              // vector this loop's last unconfirmed attempt staged (within a
              // relative tolerance, holdsOwnStaleVector) while its text changed is
              // not current, whatever its stored hash says: a row with an empty
              // owner stores a null hash, which passes the hash comparison for any
              // text (flair#2478). Who stored a matching vector is not known.
              if (attempt > 1 && rowEmbeddingCurrent(rowNow as Record<string, unknown>, current) &&
                  !holdsOwnStaleVector(rowNow as Record<string, unknown>, ownUnconfirmed)) {
                // flair#2840: a current row counts as done only when this loop's
                // own attempt on the row was unconfirmed and the row now holds
                // the text that attempt embedded. The attempt outcome comes from
                // the loop's own state, not from the row's value; a row another
                // writer made current stays uncounted, as on main.
                if (unconfirmed && ownUnconfirmed !== undefined && skillEmbedText(rowNow) === ownUnconfirmed.text) ok = true;
                break;
              }
              const attemptResult = await regenContentSuffixRow(table, id, rowNow as Record<string, unknown>, current, contentSuffixRegen);
              if (attemptResult.kind === "lock") {
                // This attempt wrote nothing. After an earlier unconfirmed attempt
                // of this loop the row may hold that attempt's write, so the line
                // says the outcome is unknown (the unconfirmed line below follows).
                console.warn("[embedding-stamp] %s: the per-id write lock answered %s; %s; the row is uncounted and the next scan decides whether it is still stale", id, attemptResult.outcome, unconfirmed
                  ? "this attempt wrote nothing, but an earlier attempt's write was not confirmed, so the outcome is unknown"
                  : "nothing was written");
                break;
              }
              if (attemptResult.kind === "skipped") break;
              // Safe to retry from a fresh read: the same text yields the same
              // vector and hash, and a retry restages `updatedAt`. A readable
              // post-commit mismatch retries from a fresh read (and a new vector,
              // computed before the lock) within CONTENT_SUFFIX_REGEN_ATTEMPTS; an
              // unreadable verification stops without a retry.
              if (attemptResult.verdict === "shown") {
                ok = true;
                break;
              }
              unconfirmed = true;
              ownUnconfirmed = attemptResult.staged;
              if (attemptResult.verdict === "unreadable") break;
            }
          } finally {
            if (!ok && unconfirmed) {
              console.warn("[embedding-stamp] %s: the content-suffix re-embed did not confirm its committed row; outcome: unconfirmed, the row is uncounted and a later scan decides pending state", id);
            }
          }
        } else {
          // Test-only: inert unless the fault-injection env opt-in is set and armed.
          const pause = txnPausePoint("embedding-stamp-regen-pre");
          if (pause) await pause;
          ok = await regen(id, existing);
        }
        if (ok) touchedIds.push(id);
        // A false result does not add the row to touchedIds. It does not prove
        // nothing was written (a loopback PATCH can commit before its response
        // fails); the next live scan decides, retrying the row only if it is
        // still pending. Only the `.content`-suffix path's aborted local
        // transaction is known to write nothing.
      }

      noteTestMigrationRun({ processed: touchedIds.length, touchedIds });
      return { processed: touchedIds.length, touchedIds };
    },
  };
}
