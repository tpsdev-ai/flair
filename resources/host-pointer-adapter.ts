/**
 * host-pointer-adapter.ts — the resource-surface shim the Memory write path
 * calls to write/delete a MemoryHostSource row (flair#1940 slice 1). The
 * failure-injection seam exists only in test code; a build check scans every
 * file under dist/ for it. This shim holds NO failure switch: the adapter it
 * delegates to lives in ./host-pointer/registry.js, which has no test seam.
 * Production behaviour is the real table.
 */
import { currentHostPointerAdapter } from "./host-pointer/registry.js";

export function putPointerRow(row: any, ctx: any): Promise<void> {
  return currentHostPointerAdapter().putPointerRow(row, ctx);
}

export function deletePointerRowViaTable(memoryId: string, ctx: any): Promise<void> {
  return currentHostPointerAdapter().deletePointerRow(memoryId, ctx);
}
