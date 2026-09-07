// Test-only, single-worker instrumentation; start/stop bracket real HTTP queries.
import { Resource, databases } from "harper";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Bm25Index } from "./bm25-index.js";
import { bm25IndexStatus } from "./bm25-index-service.js";
let active;
export class Bm25MetadataProbe extends Resource {
  allowCreate() { return true; }
  async post({ action = "status", legacy = false }) {
    if (action === "start") {
      if (active) throw new Error("probe already active");
      const table = databases.flair.Memory;
      const originalPut = table.put;
      const originalUpsert = Bm25Index.prototype.upsert;
      const originalRemove = Bm25Index.prototype.remove;
      const metrics = { writes: 0, successfulPuts: 0, failedPuts: 0, updates: 0, replacements: 0, updateMs: 0 };
      const delay = monitorEventLoopDelay({ resolution: 1 });
      table.put = async function (...args) {
        metrics.writes++;
        try { const result = await originalPut.apply(this, args); metrics.successfulPuts++; return result; }
        catch (error) { metrics.failedPuts++; throw error; }
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
        Bm25Index.prototype.upsert = originalUpsert;
        Bm25Index.prototype.remove = originalRemove;
      } };
    }
    let counterTotal = 0;
    for (let i = 0; i < 5; i++) {
      const row = await databases.flair.Memory.get(`metadata-${String(i).padStart(4, "0")}`);
      counterTotal += row?.retrievalCount ?? 0;
    }
    const result = { ...active?.metrics, counterTotal, eventLoopP99Ms: active ? active.delay.percentile(99) / 1e6 : null,
      index: bm25IndexStatus() };
    if (action === "stop" && active) { active.restore(); active = null; }
    return result;
  }
}
