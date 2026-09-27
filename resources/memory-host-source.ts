/**
 * memory-host-source.ts — the MemoryHostSource table's non-resource helpers
 * (flair#1940 slice 1 / A1'). The pointer lives in its OWN table keyed by
 * memoryId; Memory rows never carry it.
 *
 * This module holds:
 *   - the WRITE-BODY-ONLY pointer inputs and their extraction, so every
 *     Memory writer strips them from the row before persist (A1' item 1);
 *   - the pointer row builder (canonical hostSource + scopeAtWrite +
 *     server-stamped authorId/receivedAt) (A1' items 1, 3);
 *   - the ONE batched pointer read the gated join uses (A1' item 4: never one
 *     query per row);
 *   - the federation refusal predicate (A1' item 5).
 */
import { databases } from "harper";
import type { PointerRow } from "./host-source-visibility.js";

/** The table name, so callers and tests never re-type it as a literal. */
export const MEMORY_HOST_SOURCE_TABLE = "MemoryHostSource";

/** The write-body-only pointer inputs (A1' item 1): accepted ONLY by
 *  Memory.post()/put() and MemoryHostSource's own resource. `hostSource` is
 *  the pointer; `hostSourceScope` is the write-time opt-in; a
 *  `hostSourceVisibility` supplied by a client is a FORGERY of the server's
 *  write-time stamp and is dropped (never read). */
export const POINTER_INPUT_KEYS = Object.freeze(["hostSource", "hostSourceScope", "hostSourceVisibility"] as const);

export interface PointerInputs {
  /** The raw pointer value as supplied (any type — validated downstream). */
  hostSource: unknown;
  /** The write-time opt-in scope ("record" is the only accepted value). */
  hostSourceScope: unknown;
  /** Present iff a client tried to supply the server's own write-time stamp. */
  forgedVisibility: boolean;
}

/**
 * Consume the pointer inputs out of a Memory write body, IN PLACE, so they can
 * never be persisted on the Memory row (A1' item 1). Returns what was found.
 */
export function extractPointerInputs(content: unknown): PointerInputs {
  const out: PointerInputs = { hostSource: undefined, hostSourceScope: undefined, forgedVisibility: false };
  if (!content || typeof content !== "object" || Array.isArray(content)) return out;
  const obj = content as Record<string, unknown>;
  out.hostSource = obj.hostSource;
  out.hostSourceScope = obj.hostSourceScope;
  out.forgedVisibility = obj.hostSourceVisibility !== undefined && obj.hostSourceVisibility !== null;
  for (const key of POINTER_INPUT_KEYS) delete obj[key];
  return out;
}

/** A row as stored in MemoryHostSource (keyed by memoryId). */
export interface MemoryHostSourceRow extends PointerRow {
  memoryId: string;
  hostSource: string;
  scopeAtWrite: string | null;
  authorId: string;
  receivedAt: string;
}

/** Build the pointer row to persist alongside a Memory row. `scopeAtWrite` is
 *  the record's visibility at write when the write opted in with
 *  `hostSourceScope: "record"`, else null (author-only). `authorId` and
 *  `receivedAt` are SERVER-stamped (A1' item 3) — never taken from the body. */
export function buildPointerRow(args: {
  memoryId: string;
  canonical: string;
  scopeAtWrite: string | null;
  authorId: string;
  receivedAt: string;
}): MemoryHostSourceRow {
  return {
    memoryId: args.memoryId,
    hostSource: args.canonical,
    scopeAtWrite: args.scopeAtWrite ?? null,
    authorId: args.authorId,
    receivedAt: args.receivedAt,
  };
}

function pointerTable(): any {
  return (databases as any).flair?.[MEMORY_HOST_SOURCE_TABLE];
}

/**
 * Read the pointer rows for a WHOLE result set in ONE batched query (A1'
 * item 4). Empty input issues no query. Returns memoryId -> row.
 */
export async function loadPointerRows(ids: readonly string[]): Promise<Map<string, PointerRow>> {
  const wanted = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
  const map = new Map<string, PointerRow>();
  if (wanted.length === 0) return map;
  const table = pointerTable();
  if (!table?.search) return map;
  // ONE search: an OR of exact-id conditions (a batched IN, never N queries).
  const query = {
    operator: "or",
    conditions: wanted.map((id) => ({ attribute: "memoryId", comparator: "equals", value: id })),
  };
  const result = table.search(query);
  for await (const row of result as AsyncIterable<PointerRow>) {
    if (row && typeof (row as PointerRow).memoryId === "string") map.set((row as PointerRow).memoryId, row);
  }
  return map;
}

/** The Memory attributes that would carry a pointer into an inbound federated
 *  row (A1' item 5). A record carrying any of these is refused, not merged. */
const FEDERATION_POINTER_FIELDS = ["hostSource", "hostSourceScope", "hostSourceVisibility"] as const;

/** True when an inbound federated record's data carries a pointer field. */
export function inboundCarriesPointer(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  return FEDERATION_POINTER_FIELDS.some((f) => (data as Record<string, unknown>)[f] !== undefined);
}
