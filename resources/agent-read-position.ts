/**
 * agent-read-position.ts — durable per-agent read-position (watermark) store.
 *
 * Storage + monotonic advance for resources/agent-read-position-lib.ts.
 * Owner-scoping lives in the HTTP resource / catch-up handler; this module
 * is the internal contract for raw table access (Harper table I/O bypasses
 * Resource rules).
 *
 * Advance is at-least-once (advance-on-ack): only move forward, never back.
 * Same-process concurrent advances serialize on a per-id promise tail so two
 * acks cannot clobber a higher watermark with a lower one.
 */

import { databases } from "harper";
import { withDetachedTxn } from "./table-helpers.js";
import { comparePosition, readPositionId } from "./agent-read-position-lib.js";

export interface AgentReadPositionRow {
  id: string;
  agentId: string;
  stream: string;
  position: string;
  updatedAt: string;
}

export interface ReadPositionTable {
  get: (id: string) => Promise<AgentReadPositionRow | null | undefined>;
  put: (row: AgentReadPositionRow) => Promise<unknown>;
}

export function defaultReadPositionTable(): ReadPositionTable | null {
  try {
    const table = (databases as any).flair?.AgentReadPosition;
    if (!table || typeof table.get !== "function" || typeof table.put !== "function") return null;
    return table as ReadPositionTable;
  } catch {
    return null;
  }
}

const tails = new Map<string, Promise<unknown>>();

function enqueue<T>(id: string, work: () => Promise<T>): Promise<T> {
  const prev = tails.get(id) ?? Promise.resolve();
  const next = prev.then(work, work);
  tails.set(id, next);
  return next.finally(() => {
    if (tails.get(id) === next) tails.delete(id);
  }) as Promise<T>;
}

async function readRow(
  table: ReadPositionTable,
  id: string,
  ctx?: unknown,
): Promise<AgentReadPositionRow | null> {
  try {
    const row = await withDetachedTxn(ctx, () => table.get(id));
    return row && typeof row.position === "string" ? row : null;
  } catch {
    return null;
  }
}

export async function getReadPosition(
  table: ReadPositionTable | null,
  agentId: string,
  stream: string,
  ctx?: unknown,
): Promise<string | null> {
  if (!table) return null;
  const row = await readRow(table, readPositionId(agentId, stream), ctx);
  return row?.position ?? null;
}

/**
 * Return the stored watermark, creating it at `initial` when absent.
 * Concurrent first-writers serialize; the stored row wins if one appears.
 */
export async function ensureReadPosition(
  table: ReadPositionTable | null,
  agentId: string,
  stream: string,
  initial: string,
  ctx?: unknown,
  now: () => string = () => new Date().toISOString(),
): Promise<string> {
  if (!table) return initial;
  const id = readPositionId(agentId, stream);
  return enqueue(id, async () => {
    const existing = await readRow(table, id, ctx);
    if (existing) return existing.position;
    const row: AgentReadPositionRow = {
      id,
      agentId,
      stream,
      position: initial,
      updatedAt: now(),
    };
    try {
      await withDetachedTxn(ctx, () => table.put(row));
    } catch {
      const raced = await readRow(table, id, ctx);
      if (raced) return raced.position;
      return initial;
    }
    return initial;
  });
}

export interface AdvanceResult {
  position: string;
  advanced: boolean;
}

/**
 * Monotonic advance. A lower-or-equal ack is a no-op. Serialized per
 * (agent, stream) so concurrent catch-up acks cannot regress the watermark.
 */
export async function advanceReadPosition(
  table: ReadPositionTable | null,
  agentId: string,
  stream: string,
  position: string,
  ctx?: unknown,
  now: () => string = () => new Date().toISOString(),
): Promise<AdvanceResult> {
  if (!position) {
    const current = table ? await getReadPosition(table, agentId, stream, ctx) : null;
    return { position: current ?? "", advanced: false };
  }
  if (!table) return { position, advanced: false };
  const id = readPositionId(agentId, stream);
  return enqueue(id, async () => {
    const existing = await readRow(table, id, ctx);
    const current = existing?.position ?? "";
    if (current && comparePosition(position, current) <= 0) {
      return { position: current, advanced: false };
    }
    const row: AgentReadPositionRow = {
      id,
      agentId,
      stream,
      position,
      updatedAt: now(),
    };
    try {
      await withDetachedTxn(ctx, () => table.put(row));
    } catch {
      const raced = await readRow(table, id, ctx);
      if (raced && comparePosition(raced.position, position) >= 0) {
        return { position: raced.position, advanced: false };
      }
      return { position: current || position, advanced: false };
    }
    return { position, advanced: true };
  });
}
