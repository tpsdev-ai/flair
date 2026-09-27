/**
 * host-pointer/registry.ts — the host-pointer write adapter (flair#1940 slice 1).
 * The build check recursively scans JavaScript (`.js`) files under `dist`, excluding
 * `node_modules`, for the former seam symbol and failure switch. This module is NOT under `dist/resources/*.js` (the
 * jsResource glob loads only top-level files there), so it is not a resource
 * surface. It exports NO failure switch and NO test seam: the production
 * adapter is the real MemoryHostSource table, and tests that need a failing
 * pointer write drive the failure from TEST code (the shared Harper mock's
 * next-write failure flag in test/helpers/memory-search-harness.ts).
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

/** The adapter the write path uses. The production one, always. */
export function currentHostPointerAdapter(): HostPointerAdapter {
  return productionHostPointerAdapter;
}
