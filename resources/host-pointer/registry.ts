/**
 * host-pointer/registry.ts — the host-pointer write adapter (flair#1940 slice 1,
 * A1-iv item 5/6). This module is NOT under `dist/resources/*.js` (the
 * jsResource glob loads only top-level files there), so it is not a resource
 * surface: the TEST-ONLY `setHostPointerAdapterForTests` symbol never appears in
 * the loaded resource surface, and only tests import it. Production gets the
 * real MemoryHostSource table.
 */
import { databases } from "harper";
import { MEMORY_HOST_SOURCE_TABLE } from "../memory-host-source.js";

export interface HostPointerAdapter {
  putPointerRow(row: any, ctx: any): Promise<void>;
  deletePointerRow(memoryId: string, ctx: any): Promise<void>;
}

function pointerTable(): any {
  return (databases as any).flair?.[MEMORY_HOST_SOURCE_TABLE];
}

/** The production adapter: the real MemoryHostSource table. Throws when the
 *  table is unavailable — fail closed, never a silent skip (A1-iv item 4). */
export const productionHostPointerAdapter: HostPointerAdapter = {
  async putPointerRow(row: any, ctx: any): Promise<void> {
    const table = pointerTable();
    if (!table?.put) throw new Error("MemoryHostSource table unavailable");
    await table.put(row, ctx);
  },
  async deletePointerRow(memoryId: string, ctx: any): Promise<void> {
    const table = pointerTable();
    if (!table?.delete) throw new Error("MemoryHostSource table unavailable");
    await table.delete(memoryId, ctx);
  },
};

let override: HostPointerAdapter | null = null;

/** The adapter the write path uses (the production one unless a test replaced it). */
export function currentHostPointerAdapter(): HostPointerAdapter {
  return override ?? productionHostPointerAdapter;
}

/** TEST-ONLY seam. Imported only by tests; absent from the resource surface. */
export function setHostPointerAdapterForTests(adapter: HostPointerAdapter | null): void {
  override = adapter;
}
