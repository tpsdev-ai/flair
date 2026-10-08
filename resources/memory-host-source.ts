/**
 * memory-host-source.ts — the MemoryHostSource table's non-resource helpers
 * (flair#1940 slice 1 / A1'). The pointer lives in its OWN table keyed by
 * memoryId. Supported writes store host pointers only in `MemoryHostSource`: a pointer
 * reaches a non-admin reader only through the gated join. For non-admin `Memory.get`,
 * `Memory.search`, and `SemanticSearch` results, the gated projection removes inline
 * pointer fields and renders a pointer only from a bound `MemoryHostSource` row.
 *
 * This module holds:
 *   - the WRITE-BODY-ONLY pointer inputs and their extraction; The named
 *     application write paths remove pointer fields before persisting Memory
 *     rows. Federation filters its outbound and inbound Memory rows separately.
 *     Trusted raw table operations remain outside these resource guards (A1' item 1);
 *   - the pointer row builder (canonical hostSource + scopeAtWrite +
 *     server-stamped authorId/receivedAt) (A1' items 1, 3);
 *   - the ONE batched pointer read the gated join uses (A1' item 4: never one
 *     query per row);
 *   - the federation refusal predicate (A1' item 5); The outbound reader
 *     projects declared Memory attributes. The inbound merge removes undeclared
 *     attributes except the named bookkeeping fields (A1'' item 8) (f1-out/f1-in).
 */
import { databases } from "harper";
import { validateHostSource } from "./host-source.js";
import { projectHostSource, stripInlinePointerFields, type PointerRow } from "./host-source-visibility.js";

/** The table name, so callers and tests never re-type it as a literal. */
export const MEMORY_HOST_SOURCE_TABLE = "MemoryHostSource";

/** The write-body-only pointer inputs (A1' item 1). Only `Memory.post()` and
 *  `Memory.put()` accept pointer inputs; the `MemoryHostSource` resource refuses
 *  every REST write verb. `hostSource` is
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
  memoryInstanceToken: string | null;
  receivedAt: string;
}

/** Build the pointer row to persist alongside a Memory row. `scopeAtWrite` is
 *  the record's visibility at write when the write opted in with
 *  `hostSourceScope: "record"`, else null (author-only). `authorId`,
 *  `memoryInstanceToken` and `receivedAt` are SERVER-stamped (A1' item 3,
 *  A1-iv item 1) — never taken from the body. */
export function buildPointerRow(args: {
  memoryId: string;
  canonical: string;
  scopeAtWrite: string | null;
  authorId: string;
  memoryInstanceToken: string | null;
  receivedAt: string;
}): MemoryHostSourceRow {
  return {
    memoryId: args.memoryId,
    hostSource: args.canonical,
    scopeAtWrite: args.scopeAtWrite ?? null,
    authorId: args.authorId,
    memoryInstanceToken: args.memoryInstanceToken ?? null,
    receivedAt: args.receivedAt,
  };
}

function pointerTable(): any {
  return (databases as any).flair?.[MEMORY_HOST_SOURCE_TABLE];
}

/**
 * flair#1940 A1'' item 6 (adjudication B, hardened in round 5/adjudication 0e)
 * — is an incoming hostSource an ECHO of the STORED pointer? Preservation (do
 * not replace the stored row) is a NARROW, unforgeable case:
 *   - the current writer MUST be the stored pointer row's `authorId` — a
 *     different writer echoing the value must not keep another agent's
 *     pointer; and
 *   - the incoming value must match the stored canonical EXACTLY, full URL
 *     included. Matching after DROPPING the query and fragment was forgeable:
 *     a value with a DIFFERENT query rendered identically and was wrongly
 *     treated as an echo, so a real change was masked. A different query is a
 *     new value, not an echo.
 * (A rendered read strips the URL, so a client that wants the stored pointer
 * kept echoes the stored value itself, not the stripped render.)
 */
export function isPointerEchoOf(
  input: unknown,
  storedPointer: PointerRow | null | undefined,
  writerAuthorId: string | null | undefined,
): boolean {
  if (!storedPointer || typeof storedPointer.hostSource !== "string") return false;
  const author =
    typeof storedPointer.authorId === "string" && storedPointer.authorId.length > 0 ? storedPointer.authorId : null;
  if (author === null || writerAuthorId == null || author !== writerAuthorId) return false;
  const incoming = validateHostSource(input);
  if (!incoming.ok) return false;
  return incoming.canonical === storedPointer.hostSource;
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
  // Harper refuses an `or` with fewer than two conditions, so a single id uses
  // a plain equals condition and a set uses an `or`. Either way it is ONE call.
  const query =
    wanted.length === 1
      ? { conditions: [{ attribute: "memoryId", comparator: "equals", value: wanted[0] }] }
      : { operator: "or", conditions: wanted.map((id) => ({ attribute: "memoryId", comparator: "equals", value: id })) };
  const result = table.search(query);
  for await (const row of result as AsyncIterable<PointerRow>) {
    if (row && typeof (row as PointerRow).memoryId === "string") map.set((row as PointerRow).memoryId, row);
  }
  return map;
}

/**
 * The ids among `ids` that still have a stored pointer row: the check POST
 * /MemoryPurge runs after its pointer deletes commit. Unlike loadPointerRows
 * (the reader join, which reads a missing table as "no pointers"), it throws
 * when the table cannot be searched, so a failed check never reads as "no
 * pointer row left".
 */
export async function storedPointerIds(ids: readonly string[]): Promise<Set<string>> {
  if (typeof pointerTable()?.search !== "function") {
    throw new Error(`${MEMORY_HOST_SOURCE_TABLE} table unavailable`);
  }
  return new Set((await loadPointerRows(ids)).keys());
}

/**
 * flair#1940 A1-iv item 2 — the ONE reader helper. `Memory.get()`,
 * `Memory.search()` and `SemanticSearch` render pointers through the pointer
 * helper. Other Memory projections, bootstrap included, do not render pointers
 * in this slice. It fetches the pointer rows for the WHOLE result set in ONE
 * batched query and applies the join, so no reader can forget the join and no
 * module needs to touch the MemoryHostSource table itself. `readerAgentId` is
 * the non-admin reader; an admin/operator read is the named exception (see
 * MemoryHostSource.ts).
 *
 * What the join receives differs by reader path, and both carry the binding
 * fields it reads (`id`, `agentId`, `instanceToken`, `archived`,
 * `visibility`). For a non-admin `Memory.get`/`Memory.search`, the join runs
 * on the FULL stored row, not on whatever the caller asked for: those reads
 * ignore the caller's `select`/`property` — the auth middleware drops the
 * selection from a REST request URL before Harper parses it, and the direct
 * contextual read drops it before the base read. `SemanticSearch` instead
 * hands the join its server-owned retrieval projection (`DEFAULT_SELECT`,
 * optionally widened with `provenance`/`metadata`/`trigger`), which is fixed
 * server-side and not caller-shaped either; the binding fields are in that
 * projection as well as in the full row. An inline pointer field on the Memory
 * row is removed (or replaced by the gated rendering) before the projected row
 * is returned, so no inline pointer field reaches a non-admin reader.
 */
export async function projectRowsThroughPointers<T extends { id?: unknown }>(
  rows: readonly T[],
  readerAgentId: string | null | undefined,
): Promise<T[]> {
  const ids = rows.map((r) => r?.id).filter((id): id is string => typeof id === "string" && id.length > 0);
  const pointers = await loadPointerRows(ids);
  return rows.map((row) => {
    const id = row?.id;
    return typeof id === "string" ? projectHostSource(row, readerAgentId, pointers.get(id) ?? null) : stripInlinePointerFields(row);
  });
}

/** Read ONE stored pointer row (the write path's echo check). Kept here so the
 *  MemoryHostSource table is touched ONLY by this module. */
export async function loadStoredPointer(memoryId: string): Promise<PointerRow | null> {
  return (await loadPointerRows([memoryId])).get(memoryId) ?? null;
}

/** The Memory attributes that would carry a pointer into an inbound federated
 *  row (A1' item 5). A record carrying any of these is refused, not merged. */
const FEDERATION_POINTER_FIELDS = ["hostSource", "hostSourceScope", "hostSourceVisibility"] as const;

/** True when an inbound federated record's data carries a pointer field. */
export function inboundCarriesPointer(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  return FEDERATION_POINTER_FIELDS.some((f) => (data as Record<string, unknown>)[f] !== undefined);
}
