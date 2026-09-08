/**
 * hit-tracking.ts — search-hit counters without rewriting Memory (flair#1528).
 *
 * SemanticSearch used to `patchRecord` every returned hit:
 *   retrievalCount: (row.retrievalCount || 0) + 1
 * that is a full-row Harper put (embeddings included). Concurrent searches
 * of the same hits lost increments (read-modify-write on the retrieved
 * snapshot) and still wrote storage on a read path.
 *
 * This module is the remaining #1528 slice (BM25 metadata-skip already
 * landed in #1545 and is not revisited here):
 *   - increments go to MemoryHitStat, a small per-id row, never Memory
 *   - per-id promise tails serialize flushes and coalesce pending deltas
 *     so overlapping hits add instead of racing
 *   - GET /Memory/{id}, Memory.search, AdminMemory detail, and consolidate
 *     overlay the stat row so retrievalCount / lastRetrieved stay the
 *     observable Memory fields they have always been
 *
 * Fire-and-forget from SemanticSearch: a failed flush is swallowed, same
 * best-effort class as the previous `.catch(() => {})` patch. Bootstrap
 * still does not call this module.
 *
 * Every Harper call is wrapped individually in withDetachedTxn — never one
 * wrap around a multi-await helper. Search already read Memory on the
 * request context; a later HitStat get/put on that closed chain would
 * inherit the closed transaction (table-helpers.ts / usage-recording.ts).
 */
import { databases } from "harper";
import { withDetachedTxn } from "./table-helpers.js";

export interface HitStatRow {
  id: string;
  retrievalCount: number;
  lastRetrieved?: string;
}

export interface HitStatTables {
  stats: {
    get: (id: string) => Promise<HitStatRow | null | undefined>;
    put: (row: HitStatRow) => Promise<unknown>;
    delete?: (id: string) => Promise<unknown>;
  };
  memory: {
    get: (id: string) => Promise<{ retrievalCount?: number; lastRetrieved?: string } | null | undefined>;
  };
}

interface Pending {
  delta: number;
  lastRetrieved: string;
}

export interface HitTrackerMetrics {
  writes: number;
  successfulPuts: number;
  failedPuts: number;
}

function asRow(value: HitStatRow | null | undefined, id: string): HitStatRow | null {
  if (!value) return null;
  return {
    id,
    retrievalCount: Number(value.retrievalCount) || 0,
    lastRetrieved: value.lastRetrieved,
  };
}

export class HitTracker {
  private readonly pending = new Map<string, Pending>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly cache = new Map<string, HitStatRow>();
  private readonly metricsState: HitTrackerMetrics = { writes: 0, successfulPuts: 0, failedPuts: 0 };

  constructor(private readonly tables: HitStatTables) {}

  get metrics(): HitTrackerMetrics {
    return { ...this.metricsState };
  }

  noteHits(ids: Iterable<string>, now: string, ctx?: unknown): void {
    for (const id of ids) {
      if (typeof id !== "string" || id.length === 0) continue;
      const prev = this.pending.get(id);
      if (prev) {
        prev.delta += 1;
        prev.lastRetrieved = now;
      } else {
        this.pending.set(id, { delta: 1, lastRetrieved: now });
      }
      this.enqueueFlush(id, ctx);
    }
  }

  async apply<T>(record: T, ctx?: unknown): Promise<T> {
    if (!record || typeof record !== "object") return record;
    const id = (record as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) return record;
    const stat = await this.statFor(id, ctx);
    if (!stat) return record;
    const current = record as { retrievalCount?: number; lastRetrieved?: string };
    if (current.retrievalCount === stat.retrievalCount && current.lastRetrieved === stat.lastRetrieved) {
      return record;
    }
    return { ...record, retrievalCount: stat.retrievalCount, lastRetrieved: stat.lastRetrieved };
  }

  async statFor(id: string, ctx?: unknown): Promise<HitStatRow | null> {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const row = asRow(await this.readStat(id, ctx), id);
    if (row) this.cache.set(id, row);
    return row;
  }

  async whenIdle(): Promise<void> {
    for (let spins = 0; spins < 32; spins++) {
      for (const id of this.pending.keys()) this.enqueueFlush(id);
      if (this.tails.size === 0 && ![...this.pending.values()].some((p) => p.delta > 0)) return;
      await Promise.all([...this.tails.values()]);
    }
  }

  async clear(id: string, ctx?: unknown): Promise<void> {
    this.pending.delete(id);
    this.cache.delete(id);
    if (!this.tables.stats.delete) return;
    await withDetachedTxn(ctx, () => this.tables.stats.delete!(id));
  }

  private enqueueFlush(id: string, ctx?: unknown): void {
    const prev = this.tails.get(id) ?? Promise.resolve();
    const next = prev
      .then(() => this.runFlush(id, ctx))
      .catch(() => {})
      .finally(() => {
        if (this.tails.get(id) === next) this.tails.delete(id);
      });
    this.tails.set(id, next);
  }

  private async runFlush(id: string, ctx?: unknown): Promise<void> {
    const taken = this.pending.get(id);
    if (!taken || taken.delta <= 0) return;
    this.pending.delete(id);

    const existing = asRow(await this.readStat(id, ctx), id);
    let base = existing?.retrievalCount;
    if (base == null) {
      const memory = await withDetachedTxn(ctx, () => this.tables.memory.get(id)).catch(() => null);
      base = memory?.retrievalCount ?? 0;
    }
    const row: HitStatRow = {
      id,
      retrievalCount: base + taken.delta,
      lastRetrieved: taken.lastRetrieved,
    };
    this.metricsState.writes += 1;
    try {
      await withDetachedTxn(ctx, () => this.tables.stats.put(row));
      this.metricsState.successfulPuts += 1;
      this.cache.set(id, row);
    } catch {
      this.metricsState.failedPuts += 1;
      const again = this.pending.get(id);
      if (again) {
        again.delta += taken.delta;
        if (taken.lastRetrieved > (again.lastRetrieved ?? "")) again.lastRetrieved = taken.lastRetrieved;
      } else {
        this.pending.set(id, taken);
      }
    }
  }

  private readStat(id: string, ctx?: unknown): Promise<HitStatRow | null | undefined> {
    return withDetachedTxn(ctx, () => this.tables.stats.get(id)).catch(() => null);
  }
}

function liveTables(): HitStatTables {
  return {
    stats: {
      get: (id) => (databases as any).flair.MemoryHitStat.get(id),
      put: (row) => (databases as any).flair.MemoryHitStat.put(row),
      delete: (id) => (databases as any).flair.MemoryHitStat.delete(id),
    },
    memory: {
      get: (id) => (databases as any).flair.Memory.get(id),
    },
  };
}

let live: HitTracker | undefined;

export function liveHitTracker(): HitTracker {
  live ??= new HitTracker(liveTables());
  return live;
}

/** Fire-and-forget increment for SemanticSearch's returned hit ids. */
export function noteSearchHits(ids: Iterable<string>, now: string, ctx?: unknown): void {
  liveHitTracker().noteHits(ids, now, ctx);
}

/** Overlay MemoryHitStat onto a Memory-shaped record. */
export function applyHitStats<T>(record: T, ctx?: unknown): Promise<T> {
  return liveHitTracker().apply(record, ctx);
}

/** Overlay an async-iterable / thenable Memory search result. */
export function overlayHitStatsResult(result: any, ctx?: unknown): any {
  if (result && typeof result.then === "function") {
    return result.then((value: any) => overlayHitStatsResult(value, ctx));
  }
  if (!result || result instanceof Response) return result;
  if (typeof result[Symbol.asyncIterator] === "function") {
    const tracker = liveHitTracker();
    return (async function* overlayHits() {
      for await (const row of result) {
        yield await tracker.apply(row, ctx);
      }
    })();
  }
  return liveHitTracker().apply(result, ctx);
}

export function clearHitStats(id: string, ctx?: unknown): Promise<void> {
  return liveHitTracker().clear(id, ctx);
}

/** Test-only: drop the process singleton so the next call rebuilds it. */
export function resetLiveHitTracker(): void {
  live = undefined;
}
