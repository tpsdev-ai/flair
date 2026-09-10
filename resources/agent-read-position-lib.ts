/**
 * agent-read-position-lib.ts — pure per-agent read-position (watermark) helpers.
 *
 * This is the reusable catch-up floor (flair#931), not OrgEvent-table plumbing.
 * OrgEventCatchup is the first consumer; light-comms (#1583) inherits the same
 * (agentId, stream) → position primitive when the board lands.
 *
 * Position is a monotonic total order, NOT a wall-clock `since`:
 *   `${createdAt}\t${id}`
 * ISO-8601 timestamps sort lexicographically; `id` breaks same-ms ties so a
 * sort without a tie-break cannot drop an event. Compare with `<` / `>`.
 *
 * Harper-free so unit tests can pin encoding, paging, and init without a store.
 */

import { compareKey } from "./sort-comparators.js";

/** First shipped stream. Additional streams (message-board, …) are additive. */
export const ORG_EVENT_STREAM = "org-event";

export const POSITION_SEP = "\t";

export const DEFAULT_CATCHUP_PAGE_SIZE = 50;
export const MAX_CATCHUP_PAGE_SIZE = 500;

/** Env: bounded backfill on first watermark. Unset = 24h (retired window, once). `0` = "now". */
export const CATCHUP_BACKFILL_MS_ENV = "FLAIR_CATCHUP_BACKFILL_MS";
export const DEFAULT_CATCHUP_BACKFILL_MS = 24 * 3600_000;

export function readPositionId(agentId: string, stream: string): string {
  return `${agentId}:${stream}`;
}

/** Total-order position for a record that has `createdAt` + `id`. */
export function recordPosition(record: { createdAt?: string | null; id?: string | null }): string {
  return `${record.createdAt ?? ""}${POSITION_SEP}${record.id ?? ""}`;
}

/** Exclusive cursor just after every record at-or-before this ISO timestamp. */
export function positionAfterTimestamp(iso: string): string {
  return `${iso}${POSITION_SEP}`;
}

export function comparePosition(a: string, b: string): number {
  return compareKey(a, b);
}

/** Leading createdAt of a position, or null if the cursor has no timestamp. */
export function createdAtFloorFromPosition(position: string): string | null {
  if (!position) return null;
  const sep = position.indexOf(POSITION_SEP);
  const ts = sep === -1 ? position : position.slice(0, sep);
  return ts || null;
}

export function laterTimestamp(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b || null;
  if (!b) return a;
  return a >= b ? a : b;
}

export function parseBackfillMs(raw: string | undefined = process.env[CATCHUP_BACKFILL_MS_ENV]): number {
  if (raw === undefined || raw === "") return DEFAULT_CATCHUP_BACKFILL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CATCHUP_BACKFILL_MS;
  return n;
}

/**
 * Sane first watermark. Default a 24h bounded backfill (the retired bootstrap
 * window, applied once); `FLAIR_CATCHUP_BACKFILL_MS=0` is Flint's "now"
 * (fresh agent does not replay history). After init the durable position governs.
 */
export function initialPosition(nowMs: number = Date.now(), backfillMs: number = parseBackfillMs()): string {
  const floor = Math.max(0, nowMs - Math.max(0, backfillMs));
  return positionAfterTimestamp(new Date(floor).toISOString());
}

export function parsePageSize(
  raw: string | number | null | undefined,
  fallback: number = DEFAULT_CATCHUP_PAGE_SIZE,
  max: number = MAX_CATCHUP_PAGE_SIZE,
): number {
  const n = typeof raw === "number" ? raw : raw != null && raw !== "" ? Number(raw) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

export interface PositionPage<T extends { position: string }> {
  page: T[];
  hasMore: boolean;
  nextAfter: string;
}

/** Exclusive `after`, already-sorted by position ascending. Never silent-truncates. */
export function pageAfter<T extends { position: string }>(
  ordered: T[],
  after: string,
  pageSize: number,
): PositionPage<T> {
  const slice = ordered.filter((row) => comparePosition(row.position, after) > 0);
  const hasMore = slice.length > pageSize;
  const page = hasMore ? slice.slice(0, pageSize) : slice;
  const nextAfter = page.length > 0 ? page[page.length - 1].position : after;
  return { page, hasMore, nextAfter };
}
