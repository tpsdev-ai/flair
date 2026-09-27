/**
 * host-source-visibility.ts — A3: the hostSource read projection (flair#1940
 * slice 1 / A1'). PURE beyond the A2 validator and the visibility predicate,
 * so it is unit-testable and usable from the read paths.
 *
 * A1' moved the pointer OFF the Memory row and into its OWN table
 * (`MemoryHostSource`, keyed by memoryId). So the projection no longer reads a
 * field off the record: the caller reads the pointer ROW and passes it in. The
 * three outcomes of the join (A1' item 4) are:
 *   - no pointer row           → the record is returned UNCHANGED (hostSource
 *                                absent/null — byte-identical to a pointerless
 *                                record, which is what every legacy row is);
 *   - a pointer the reader may NOT see → `hostSource: "withheld"` (present but
 *                                unrendered, so the "externally sourced" signal
 *                                survives);
 *   - a pointer the reader may see → the canonical pointer (URL query/fragment
 *                                stripped).
 *
 * The rule (A3): a pointer is content, never wider than its record.
 *   - Default (scopeAtWrite absent/null): the pointer is visible ONLY to the
 *     pointer row's AUTHOR (`authorId`).
 *   - Opted in: the pointer row stored the record's visibility AS IT WAS AT
 *     WRITE (`scopeAtWrite`); the pointer's EFFECTIVE visibility is the
 *     NARROWER of that stored value and the record's CURRENT visibility, so a
 *     later widening of the record never widens the pointer.
 *
 * A1'' item 4: the reader is compared with the POINTER ROW's `authorId`
 * (server-stamped from the authenticated principal at Memory write time),
 * never with Memory provenance.
 *
 * The decision is made HERE, on the server, in the read projection — no client
 * or MCP layer can un-redact. Every read surface that returns Memory records
 * calls this (see the handler-level tests in test/unit/memory-host-source.test.ts).
 */
import { parseHostSource } from "./host-source.js";
import { isPrivateVisibility } from "./memory-visibility.js";

/** The literal a reader gets in place of a pointer they may not see (A3). */
export const HOST_SOURCE_WITHHELD = "withheld";

/** A MemoryHostSource row, as the join needs it (A1'). */
export interface PointerRow {
  memoryId: string;
  hostSource: string;
  scopeAtWrite?: string | null;
  authorId?: string | null;
  receivedAt?: string | null;
}

/** The NARROWER of two visibilities (A3): "private" wins over anything else. */
export function narrowerVisibility(a: string | null | undefined, b: string | null | undefined): string {
  return isPrivateVisibility(a) || isPrivateVisibility(b) ? "private" : "shared";
}

/** Strip query and fragment so a rendered URL shows only scheme, host, path
 *  (A3). A value that is not a parseable absolute URL is returned unchanged. */
export function renderHostSourceUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

/** The canonical hostSource JSON to RENDER: the full pointer, with any URL
 *  reduced to scheme/host/path (query + fragment stripped, A3). */
function renderableCanonical(stored: string): string {
  const parsed = parseHostSource(stored);
  if (!parsed) return HOST_SOURCE_WITHHELD; // a stored value that will not re-validate never renders raw
  const out = parsed.url !== undefined ? { ...parsed, url: renderHostSourceUrl(parsed.url) } : parsed;
  return JSON.stringify(out);
}

/**
 * Whether a reader may see a pointer row, given the record it belongs to. The
 * single decision point the three outcomes fall out of:
 *   "none"     — no pointer row (the record is returned unchanged);
 *   "pointer"  — render the canonical pointer;
 *   "withheld" — render HOST_SOURCE_WITHHELD.
 */
export function pointerOutcomeFor(
  record: any,
  readerAgentId: string | null | undefined,
  pointer: PointerRow | null | undefined,
): "none" | "pointer" | "withheld" {
  if (!pointer || typeof pointer.hostSource !== "string" || pointer.hostSource.length === 0) return "none";
  // A1'' item 4: the author is the POINTER row's `authorId`, stamped from the
  // authenticated principal at Memory write time (resources/Memory.ts). The
  // projection NEVER uses Memory provenance — that is why SemanticSearch and
  // search can show an author their pointer without selecting a provenance
  // column.
  const author = typeof pointer.authorId === "string" && pointer.authorId.length > 0 ? pointer.authorId : null;
  const isAuthor = author !== null && readerAgentId != null && author === readerAgentId;
  if (isAuthor) return "pointer";
  const scopeAtWrite = pointer.scopeAtWrite;
  if (scopeAtWrite === undefined || scopeAtWrite === null) return "withheld"; // author-only
  const effective = narrowerVisibility(scopeAtWrite, record?.visibility);
  return isPrivateVisibility(effective) ? "withheld" : "pointer";
}

/**
 * Project a record's pointer for a given reader, given that record's pointer
 * row (or null). Returns the record UNCHANGED when there is no pointer row, so
 * a record with no pointer is byte-identical to today; otherwise sets
 * `hostSource` to the canonical pointer or HOST_SOURCE_WITHHELD.
 */
export function projectHostSource<T>(record: T, readerAgentId: string | null | undefined, pointer?: PointerRow | null): T {
  if (!record || typeof record !== "object") return record;
  const r = record as any;
  const decision = pointerOutcomeFor(record, readerAgentId, pointer);
  if (decision === "none") return record;
  const out = { ...r };
  if (decision === "withheld") {
    out.hostSource = HOST_SOURCE_WITHHELD;
  } else {
    out.hostSource = renderableCanonical((pointer as PointerRow).hostSource);
  }
  return out as T;
}
