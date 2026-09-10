/**
 * org-event-catchup-lib.ts — Harper-free OrgEvent catch-up filters + paging.
 *
 * Targeting / expiry / position-order live here so OrgEventCatchup and
 * MemoryBootstrap share one definition (and unit tests can pin it without
 * spinning Harper). Watermark storage is resources/agent-read-position.ts.
 */

import {
  comparePosition,
  createdAtFloorFromPosition,
  laterTimestamp,
  pageAfter,
  recordPosition,
  type PositionPage,
} from "./agent-read-position-lib.js";

export function eventTargetsParticipant(
  event: { targetIds?: string[] | null },
  participantId: string,
): boolean {
  const targets = event.targetIds;
  return !targets || targets.length === 0 || targets.includes(participantId);
}

export function eventIsExpired(event: { expiresAt?: string | null }, now: Date = new Date()): boolean {
  return Boolean(event.expiresAt && new Date(event.expiresAt) < now);
}

export function withEventPosition<T extends { createdAt?: string | null; id?: string | null }>(
  event: T,
): T & { position: string } {
  return { ...event, position: recordPosition(event) };
}

export interface CatchupCollectOpts {
  participantId: string;
  /** Exclusive position cursor (watermark or page `after`). */
  after: string;
  /** Optional createdAt lower bound (legacy `since` / bootstrap `lastBootAt`). */
  since?: string | null;
  now?: Date;
}

export function catchupSeekTimestamp(after: string, since?: string | null): string | null {
  return laterTimestamp(createdAtFloorFromPosition(after), since ?? null);
}

export function isCatchupEligible(
  event: { createdAt?: string | null; id?: string | null; targetIds?: string[] | null; expiresAt?: string | null },
  opts: CatchupCollectOpts,
): boolean {
  if (!event.createdAt) return false;
  if (opts.since && event.createdAt < opts.since) return false;
  if (comparePosition(recordPosition(event), opts.after) <= 0) return false;
  if (!eventTargetsParticipant(event, opts.participantId)) return false;
  if (eventIsExpired(event, opts.now ?? new Date())) return false;
  return true;
}

export async function collectCatchupEvents<T extends {
  createdAt?: string | null;
  id?: string | null;
  targetIds?: string[] | null;
  expiresAt?: string | null;
}>(
  rows: AsyncIterable<T> | Iterable<T>,
  opts: CatchupCollectOpts,
): Promise<Array<T & { position: string }>> {
  const results: Array<T & { position: string }> = [];
  for await (const event of rows as AsyncIterable<T>) {
    if (!isCatchupEligible(event, opts)) continue;
    results.push(withEventPosition(event));
  }
  results.sort((a, b) => comparePosition(a.position, b.position));
  return results;
}

export function pageCatchupEvents<T extends { position: string }>(
  ordered: T[],
  after: string,
  pageSize: number,
): PositionPage<T> {
  return pageAfter(ordered, after, pageSize);
}
