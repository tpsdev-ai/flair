// Test-only, single-worker instrumentation; start/stop bracket real HTTP queries.
import { Resource, databases } from "harper";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Bm25Index } from "./bm25-index.js";
import { bm25IndexStatus, markBm25IndexStale } from "./bm25-index-service.js";
import { liveHitTracker } from "./hit-tracking.js";
let active;
const TRACKED = 5;
async function trackedLedger() {
  const trackedCounts = [];
  let counterTotal = 0;
  for (let i = 0; i < TRACKED; i++) {
    const id = `metadata-${String(i).padStart(4, "0")}`;
    const stat = await databases.flair.MemoryHitStat.get(id).catch(() => null);
    const row = await databases.flair.Memory.get(id);
    const count = stat?.retrievalCount ?? row?.retrievalCount ?? 0;
    trackedCounts.push(count);
    counterTotal += count;
  }
  return { trackedCounts, counterTotal };
}
export class Bm25MetadataProbe extends Resource {
  allowCreate() { return true; }
  async post({ action = "status", legacy = false, reason = "test rebuild" }) {
    if (action === "start") {
      if (active) throw new Error("probe already active");
      const table = databases.flair.Memory;
      const stats = databases.flair.MemoryHitStat;
      const originalPut = table.put;
      const originalStatPut = stats.put;
      const originalUpsert = Bm25Index.prototype.upsert;
      const originalRemove = Bm25Index.prototype.remove;
      const metrics = {
        writes: 0, successfulPuts: 0, failedPuts: 0, updates: 0, replacements: 0, updateMs: 0,
        hitStatWrites: 0, hitStatSuccessfulPuts: 0, hitStatFailedPuts: 0,
      };
      const delay = monitorEventLoopDelay({ resolution: 1 });
      table.put = async function (...args) {
        metrics.writes++;
        try { const result = await originalPut.apply(this, args); metrics.successfulPuts++; return result; }
        catch (error) { metrics.failedPuts++; throw error; }
      };
      stats.put = async function (...args) {
        metrics.hitStatWrites++;
        try { const result = await originalStatPut.apply(this, args); metrics.hitStatSuccessfulPuts++; return result; }
        catch (error) { metrics.hitStatFailedPuts++; throw error; }
      };
      Bm25Index.prototype.remove = function (id) {
        if (this.has(id)) metrics.replacements++;
        return originalRemove.call(this, id);
      };
      Bm25Index.prototype.upsert = function (record) {
        metrics.updates++;
        const start = performance.now();
        // Force the former tombstone+re-tokenize path as the positive control.
        if (legacy) this.remove(record.id);
        originalUpsert.call(this, record);
        metrics.updateMs += performance.now() - start;
      };
      delay.enable();
      active = { metrics, delay, restore() {
        delay.disable();
        table.put = originalPut;
        stats.put = originalStatPut;
        Bm25Index.prototype.upsert = originalUpsert;
        Bm25Index.prototype.remove = originalRemove;
      } };
    }
    if (action === "idle") await liveHitTracker().whenIdle();
    if (action === "rebuild") markBm25IndexStale(reason);
    let tableSize;
    if (action === "tableCount") {
      tableSize = 0;
      for await (const _ of databases.flair.Memory.search({ select: ["id"] })) tableSize++;
    }
    const ledger = await trackedLedger();
    const result = { ...active?.metrics, ...ledger, ...(tableSize != null ? { tableSize } : {}),
      eventLoopP99Ms: active ? active.delay.percentile(99) / 1e6 : null,
      index: bm25IndexStatus() };
    if (action === "stop" && active) { active.restore(); active = null; }
    return result;
  }
}
