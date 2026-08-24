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
// ── COLD BOOT: LAZY ─────────────────────────────────────────────────────────
// Built on the first hybrid query that carries query text, not at component
// start. Eager building would add a full corpus scan to every boot including
// the many processes that never search (CLI verbs, migration boots, health
// checks), and it would race the embedding engine's own model load. The first
// query after boot pays what every query used to pay; every one after it pays
// nothing. Concurrent first queries share a single build promise.
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
// process". Cross-worker write visibility rides on mechanism (1): the feed is
// audit-log-backed and the audit store is shared, so a write committed by
// another worker still arrives. Mechanism (2) is local to the writing worker,
// which is why it is an immediacy optimisation and never the correctness
// argument.
import { databases } from "harper";
import { withDetachedTxn } from "./table-helpers.js";
import { Bm25Index, INDEX_SELECT, type IndexRecord, type RankParams } from "./bm25-index.js";

/** Kill switch. Default ON; set FLAIR_BM25_INDEX=false/0/off to force every
 *  query back onto the legacy per-query corpus scan + buildBM25(). Read
 *  per-call so it can be flipped without a rebuild and set per-case in tests. */
export function bm25IndexEnabled(): boolean {
  const v = (process.env.FLAIR_BM25_INDEX ?? "true").toLowerCase();
  return v === "true" || v === "1" || v === "on";
}

type PendingEvent = { kind: "upsert"; record: IndexRecord } | { kind: "delete"; id: string };

const index = new Bm25Index();
let state: "empty" | "building" | "ready" | "disabled" = "empty";
let buildPromise: Promise<boolean> | null = null;
let pending: PendingEvent[] | null = null;
let feedStarted = false;
let disabledReason = "";

/** Test seam — resets everything this module owns. */
export function __resetBm25IndexForTests(): void {
  index.clear();
  state = "empty";
  buildPromise = null;
  pending = null;
  feedStarted = false;
  disabledReason = "";
}

/** Diagnostics, for tests and `flair doctor`-shaped callers. */
export function bm25IndexStatus(): { state: string; size: number; postings: number; terms: number; reason: string } {
  return { state, size: index.size, postings: index.postingCount, terms: index.termCount, reason: disabledReason };
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
  if (state === "building") { pending!.push(ev); return; }
  apply(ev);
}

/** Read-your-write hook: call immediately after a committed Memory write that
 *  changed content or any scope/temporal attribute. Safe to call for writes
 *  that changed neither (it is an idempotent re-index of one row). */
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
  disabledReason = reason;
  state = "empty";
  buildPromise = null;
}

function disable(reason: string): void {
  state = "disabled";
  disabledReason = reason;
  buildPromise = null;
  pending = null;
  index.clear();
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
 * Build (or rebuild) the index from one full corpus scan.
 *
 * ORDER IS LOAD-BEARING: the change feed is started BEFORE the scan, and the
 * events it delivers during the scan are buffered and replayed AFTER it. A
 * delete that lands mid-scan for a row the cursor has not reached yet would
 * otherwise be applied first and then undone by the cursor re-adding the row.
 * Replaying after the scan lets the newer event win, whichever order they
 * physically occurred in.
 */
async function build(ctx: any): Promise<boolean> {
  state = "building";
  pending = [];
  index.clear();
  try {
    await startFeed(ctx);
    const results = withDetachedTxn(ctx, () =>
      (databases as any).flair.Memory.search({ select: INDEX_SELECT }),
    );
    for await (const row of results as any) {
      const r = project(row);
      if (r) index.upsert(r);
    }
  } catch (err: any) {
    disable("build failed: " + String(err?.message ?? err));
    return false;
  }
  const buffered = pending ?? [];
  pending = null;
  // `state` may have been knocked back to "empty" by a stale marker that
  // arrived during the scan; in that case do not claim readiness.
  if (state !== "building") return false;
  state = "ready";
  for (const ev of buffered) apply(ev);
  return true;
}

async function ensureReady(ctx: any): Promise<boolean> {
  if (!bm25IndexEnabled()) return false;
  if (state === "disabled") return false;
  if (state === "ready") return true;
  if (!buildPromise) buildPromise = build(ctx).finally(() => { buildPromise = null; });
  return buildPromise;
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
