// ─── Harper wiring for the persistent BM25 index (flair#1357) ───────────────
//
// ./bm25-index.ts is the Harper-free data structure. This module owns the one
// process-wide instance of it and answers the only two questions the retrieval
// core asks: "can you serve this lexical leg?" and "here is a write you should
// know about".
//
// ── WHERE THE INDEX STATE LIVES, AND WHY ────────────────────────────────────
// In process memory, per Harper worker, NOT in a Harper table.
//
// A Harper-table posting list was considered and rejected on WRITE cost: a
// memory averages ~26 tokens (the measured live corpus,
// test/bench/corpus-profiler/profiles), so persisting postings would turn one
// `Memory.put()` into ~25 additional indexed row writes inside the same
// transaction — write amplification on the ingestion path in order to speed up
// the read path. It would also put a Harper round-trip per query TERM back
// into recall. The in-process structure costs one full corpus scan per worker
// lifetime, which is exactly ONE instance of what the defect used to charge on
// EVERY query.
//
// Footprint at 250k documents: ~6.5M postings held as paired Int32Arrays
// (~52MB), the term dictionary (~20MB), and per-document scope metadata with
// NO content and NO embedding (~50MB) — order 120MB steady state. For scale:
// the code this replaces allocated a 250k-entry array of per-document term
// Maps plus the whole projected corpus INCLUDING content, transiently, on
// every single query.
//
// ── BOOT WARM ───────────────────────────────────────────────────────────────
// After the embeddings backend registration settles, embeddings-boot.ts calls
// scheduleBm25BootWarm(). That schedules ensureReady on a later turn, at low
// priority (setImmediate, then a yield every few dozen documents). Module
// load, boot, and the first non-search request do not wait on the scan.
// A text query that arrives while the build is in flight awaits the SAME
// buildPromise — it does not fall back to the per-query corpus scan.
//
// The warm is not started from this module's top level. Importing the service
// (unit tests, CLI helpers) must not scan. Processes that never load
// embeddings-boot still build on the first text search, which is what the
// `empty` status line says.
//
// ── STAYING CURRENT ─────────────────────────────────────────────────────────
// Two mechanisms, deliberately overlapping:
//
//   1. THE TABLE'S OWN CHANGE FEED (`Memory.subscribe`) is the authority. It
//      is the same audit-log-backed primitive `FeedMemories.connect()` already
//      uses, and it observes the TABLE — so it sees writes that never touch a
//      flair resource at all: operations-API writes, `flair` CLI direct
//      writes, and Harper replication applying federated rows. A scheme built
//      only from hooks in flair's own write paths CANNOT see those, which is
//      why the feed — not the hook list — is the correctness argument.
//      Verified against a stock instance: an operations-API insert and an
//      operations-API delete both arrive (put/delete with the full row).
//
//   2. SYNCHRONOUS HOOKS at flair's own write surface (`noteMemoryUpsert` /
//      `noteMemoryDelete`) give READ-YOUR-WRITE. The feed is asynchronous, so
//      without the hooks a store immediately followed by a search would be a
//      race — and the path being replaced had no such race, because it refetched
//      the corpus every query. Both mechanisms are idempotent upserts keyed by
//      id, so seeing a write twice is a no-op.
//
// If the feed cannot be established, or delivers an event shape we do not
// understand (Harper emits a bare `reload` marker when a base copy / resync is
// applied — precisely when the index CANNOT be patched incrementally), the
// index marks itself stale and the next query rebuilds it. If subscription
// fails outright, the index DISABLES itself and every query falls back to the
// legacy per-query corpus scan. A slow-but-correct recall is acceptable; a
// silently stale one is not — recall is the product floor.
//
// ── MULTI-WORKER ────────────────────────────────────────────────────────────
// The instance is per worker thread, so in a multi-worker configuration each
// worker pays its own first-query build and holds its own copy of the index.
// Both of flair's shipped launch paths pin `THREADS_COUNT=1` (src/cli.ts's
// launchd plist and its direct-spawn env), as does the integration harness, so
// the shipped configuration has exactly one worker and "per worker" is "per
// process". Status is still per worker: bm25IndexStatus() names the worker
// thread when THREADS_COUNT is greater than 1, and never claims to aggregate
// the other workers' indexes. Cross-worker write visibility rides on
// mechanism (1): the feed is audit-log-backed and the audit store is shared,
// so a write committed by
// another worker still arrives. Mechanism (2) is local to the writing worker,
// which is why it is an immediacy optimisation and never the correctness
// argument.
import { threadId } from "node:worker_threads";
import { databases } from "harper";
import { withDetachedTxn } from "./table-helpers.js";
import { Bm25Index, INDEX_SELECT, type IndexRecord, type RankParams } from "./bm25-index.js";
import { BM25_BOOT_WARM_SKIPPED_PREFIX, formatBm25IndexSummary, readThreadsCount, type Bm25IndexState } from "./bm25-status.js";
import { retrievalMode } from "./bm25.js";

/** Kill switch. Default ON; set FLAIR_BM25_INDEX=false/0/off to force every
 *  query back onto the legacy per-query corpus scan + buildBM25(). Read
 *  per-call so it can be flipped without a rebuild and set per-case in tests. */
export function bm25IndexEnabled(): boolean {
  const v = (process.env.FLAIR_BM25_INDEX ?? "true").toLowerCase();
  return v === "true" || v === "1" || v === "on";
}

/**
 * The index is read only by the "hybrid" and "bm25-only" retrieval modes
 * (semantic-retrieval-core.ts). A "vector-only" process has no lexical leg,
 * so the boot warm does not build an index nothing reads, and status says
 * so instead of claiming a text search will build it. An unrecognized
 * FLAIR_RETRIEVAL_MODE throws on every query anyway; treat it as in the
 * path so this check never hides that error.
 */
export function bm25IndexInRetrievalPath(): boolean {
  try {
    return retrievalMode() !== "vector-only";
  } catch {
    return true;
  }
}

type PendingEvent = { kind: "upsert"; record: IndexRecord } | { kind: "delete"; id: string };

const index = new Bm25Index();
let state: "empty" | "building" | "ready" | "disabled" = "empty";
let buildPromise: Promise<boolean> | null = null;
let pending: PendingEvent[] | null = null;
let feedStarted = false;
let disabledReason = "";
let builtCount = 0;
let totalCount = 0;
let startedAt: number | null = null;
let finishedAt: number | null = null;
let buildDurationMs: number | null = null;
/** Invalidates an in-flight build when a stale marker or a test reset lands. */
let buildSerial = 0;
/** Test seam: awaited once the first document of a multi-doc build is in. */
let buildPause: (() => Promise<void>) | null = null;
let warmScheduled = false;
let warmSerial = 0;

const YIELD_EVERY = 32;

export type Bm25IndexStatus = {
  state: Bm25IndexState;
  size: number;
  postings: number;
  terms: number;
  reason: string;
  built: number;
  total: number;
  startedAt: number | null;
  finishedAt: number | null;
  buildDurationMs: number | null;
  /** `node:worker_threads` id of the worker answering this call. */
  workerThreadId: number;
  /** THREADS_COUNT as seen by this process, or null when it is not a count. */
  threadsCount: number | null;
  /** This object describes one worker's index. It is not a cluster aggregate. */
  scope: "this-worker";
  summary: string;
};

/** Test seam — resets everything this module owns. */
export function __resetBm25IndexForTests(): void {
  buildSerial++;
  warmSerial++;
  warmScheduled = false;
  buildPause = null;
  index.clear();
  state = "empty";
  buildPromise = null;
  pending = null;
  feedStarted = false;
  disabledReason = "";
  builtCount = 0;
  totalCount = 0;
  startedAt = null;
  finishedAt = null;
  buildDurationMs = null;
}

/** Test seam — hold the build after the first admitted document. */
export function __setBm25BuildPauseForTests(fn: (() => Promise<void>) | null): void {
  buildPause = fn;
}

/** Diagnostics, for tests, /HealthDetail, and `flair status`. */
export function bm25IndexStatus(): Bm25IndexStatus {
  const threadsCount = readThreadsCount();
  const enabled = bm25IndexEnabled();
  const inPath = bm25IndexInRetrievalPath();
  const viewState: Bm25IndexState = enabled && inPath ? state : "disabled";
  const reason = !enabled
    ? "FLAIR_BM25_INDEX is off"
    : !inPath
      ? "retrieval mode is vector-only; the index is not used"
      : disabledReason;
  const view = {
    state: viewState,
    size: index.size,
    postings: index.postingCount,
    terms: index.termCount,
    reason,
    built: builtCount,
    total: totalCount,
    startedAt,
    finishedAt,
    buildDurationMs,
    workerThreadId: threadId,
    threadsCount,
    scope: "this-worker" as const,
  };
  return { ...view, summary: formatBm25IndexSummary(view) };
}

function project(record: any): IndexRecord | null {
  if (!record || typeof record.id !== "string") return null;
  const out: IndexRecord = { id: record.id };
  for (const k of INDEX_SELECT) if (k !== "id" && k in record) out[k] = record[k];
  return out;
}

function apply(ev: PendingEvent): void {
  if (ev.kind === "delete") index.remove(ev.id);
  else index.upsert(ev.record);
}

function record(ev: PendingEvent): void {
  if (state === "disabled" || state === "empty") return; // a later build will scan it
  if (state === "building") {
    // A throw here is caught by the feed consumer, which disables the index
    // for this worker's lifetime. A missing buffer means this build no longer
    // owns the events; mark stale so the next query rebuilds instead.
    if (pending == null) {
      markBm25IndexStale("in-flight build lost its event buffer");
      return;
    }
    pending.push(ev);
    return;
  }
  apply(ev);
}

/** Read-your-write hook: call immediately after a committed Memory write that
 *  changed content or any scope/temporal attribute. Safe to call for writes
 *  that changed neither (an unchanged indexed projection is ignored). */
export function noteMemoryUpsert(row: any): void {
  const r = project(row);
  if (r) record({ kind: "upsert", record: r });
}

/** Read-your-write hook: call immediately after a committed Memory delete. */
export function noteMemoryDelete(id: string): void {
  if (typeof id === "string" && id.length > 0) record({ kind: "delete", id });
}

/** Force the next query to rebuild — used when the feed reports a change we
 *  cannot express incrementally (a resync/base-copy `reload` marker). */
export function markBm25IndexStale(reason: string): void {
  if (state === "disabled") return;
  buildSerial++;
  disabledReason = reason;
  state = "empty";
  buildPromise = null;
  builtCount = 0;
  totalCount = 0;
  startedAt = null;
  finishedAt = null;
  buildDurationMs = null;
}

function stampFinished(): void {
  if (finishedAt != null) return;
  finishedAt = Date.now();
  buildDurationMs = startedAt == null ? null : finishedAt - startedAt;
}

function disable(reason: string): void {
  state = "disabled";
  disabledReason = reason;
  buildPromise = null;
  pending = null;
  index.clear();
  builtCount = 0;
  stampFinished();
}

function yieldBackground(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

async function startFeed(ctx: any): Promise<void> {
  if (feedStarted) return;
  feedStarted = true;
  const subscription = await withDetachedTxn(ctx, () =>
    (databases as any).flair.Memory.subscribe({ omitCurrent: true }),
  );
  // Deliberately not awaited: the consumer runs for the life of the process.
  (async () => {
    try {
      for await (const ev of subscription as any) {
        const type = ev?.type;
        if (type === "delete") {
          record({ kind: "delete", id: String(ev.id) });
        } else if (type === "put" || type === "insert" || type === "update" || type === "upsert") {
          const r = project(ev?.value);
          if (r) record({ kind: "upsert", record: r });
          else markBm25IndexStale(`feed ${type} event carried no usable record`);
        } else if (type !== undefined) {
          // Includes Harper's `reload` base-copy/resync marker: the table's
          // contents may have been replaced wholesale with no per-row events.
          markBm25IndexStale(`unhandled feed event type ${String(type)}`);
        }
      }
      disable("change feed ended");
    } catch (err: any) {
      disable("change feed error: " + String(err?.message ?? err));
    }
  })();
}

/**
 * Build (or rebuild) the index from the corpus.
 *
 * ORDER IS LOAD-BEARING: the change feed is started BEFORE either pass, and
 * the events it delivers during the passes are buffered and replayed AFTER
 * the admitting pass. A delete that lands mid-scan for a row the cursor has
 * not reached yet would otherwise be applied first and then undone by the
 * cursor re-adding the row. Replaying after the admitting pass lets the
 * newer event win, whichever order they physically occurred in.
 *
 * Pass 1 counts ids so status can report built/total. Pass 2 admits the
 * projected rows and yields every few dozen documents so a request already
 * on the event loop is not stuck behind the tokenize.
 */
async function build(ctx: any): Promise<boolean> {
  const serial = ++buildSerial;
  const live = () => state === "building" && serial === buildSerial;
  state = "building";
  pending = [];
  index.clear();
  builtCount = 0;
  totalCount = 0;
  startedAt = Date.now();
  finishedAt = null;
  buildDurationMs = null;
  try {
    await startFeed(ctx);
    if (!live()) return false;
    // Count first so status can report built/total while the bodies are
    // admitted. Buffering every projected row would hold the corpus in JS
    // for the length of the tokenize; a second id-only pass does not.
    const idScan = withDetachedTxn(ctx, () =>
      (databases as any).flair.Memory.search({ select: ["id"] }),
    );
    let total = 0;
    for await (const row of idScan as any) {
      if (!live()) return false;
      if (row && typeof row.id === "string") total++;
    }
    if (!live()) return false;
    totalCount = total;
    // Let a status read observe 0/total before tokenize starts, and let
    // already-queued requests run before this worker spends the scan.
    await yieldBackground();
    if (!live()) return false;

    const results = withDetachedTxn(ctx, () =>
      (databases as any).flair.Memory.search({ select: INDEX_SELECT }),
    );
    let admitted = 0;
    for await (const row of results as any) {
      if (!live()) return false;
      const r = project(row);
      if (!r) continue;
      index.upsert(r);
      admitted++;
      builtCount = admitted;
      if (buildPause && admitted === 1 && total > 1) await buildPause();
      if (!live()) return false;
      if (admitted % YIELD_EVERY === 0) await yieldBackground();
    }
  } catch (err: any) {
    if (serial === buildSerial) disable("build failed: " + String(err?.message ?? err));
    return false;
  }
  // Ownership is checked before the buffer is taken. An aborted build
  // resumes after its last for-await yield; by then a stale marker may have
  // started a replacement whose `pending` is a new array. Clearing it here
  // makes the next feed event throw and disables the index for this worker.
  // Nothing awaits between this check and the clear, so the take is atomic
  // on the single thread.
  if (!live()) return false;
  const buffered = pending ?? [];
  pending = null;
  const finished = Date.now();
  state = "ready";
  finishedAt = finished;
  buildDurationMs = finished - (startedAt ?? finished);
  for (const ev of buffered) apply(ev);
  return true;
}

async function ensureReady(ctx: any): Promise<boolean> {
  if (!bm25IndexEnabled()) return false;
  if (state === "disabled") return false;
  if (state === "ready") return true;
  if (!buildPromise) {
    const run = build(ctx).finally(() => {
      if (buildPromise === run) buildPromise = null;
    });
    buildPromise = run;
  }
  return buildPromise;
}

async function waitForMemorySearch(maxWaitMs = 30_000, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try {
      const mem = (databases as any).flair?.Memory;
      if (mem && typeof mem.search === "function") return true;
    } catch { /* tables are not bound yet */ }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function warmWhenReady(serial: number): Promise<void> {
  if (serial !== warmSerial) return;
  if (!bm25IndexEnabled() || !bm25IndexInRetrievalPath()) return;
  let ready = false;
  try {
    ready = await waitForMemorySearch();
  } catch (err: any) {
    if (serial !== warmSerial || state !== "empty") return;
    disabledReason = `${BM25_BOOT_WARM_SKIPPED_PREFIX} ${String(err?.message ?? err)}`;
    return;
  }
  if (serial !== warmSerial) return;
  if (!bm25IndexEnabled() || !bm25IndexInRetrievalPath()) return;
  if (!ready) {
    if (state === "empty") {
      disabledReason = `${BM25_BOOT_WARM_SKIPPED_PREFIX} Memory table was not ready within 30s`;
    }
    return;
  }
  if (state !== "empty") return;
  await ensureReady(undefined);
}

/**
 * Start the index build on a later turn. Boot and the caller do not wait.
 * A text query that arrives mid-build shares `buildPromise`.
 * Idempotent per process until a test reset.
 */
export function scheduleBm25BootWarm(): void {
  if (warmScheduled) return;
  warmScheduled = true;
  const serial = warmSerial;
  setImmediate(() => {
    void warmWhenReady(serial);
  });
}

/**
 * The lexical leg, served from the index. Returns the BM25 candidate ids
 * (score>0, best-first, sliced to `limit`) — or NULL when the index declines,
 * in which case the caller MUST run the legacy corpus scan + buildBM25(). Null
 * is returned for: the kill switch, a failed/disabled index, and any query
 * whose conditions the index cannot reproduce exactly (see
 * ./bm25-index.ts's `planQuery`).
 */
export async function indexedBm25Ids(params: RankParams & { ctx?: any }): Promise<string[] | null> {
  if (!(await ensureReady(params.ctx))) return null;
  try {
    return index.rank(params);
  } catch (err: any) {
    disable("rank failed: " + String(err?.message ?? err));
    return null;
  }
}
