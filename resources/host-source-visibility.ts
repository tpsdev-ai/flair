/**
 * host-source-visibility.ts — A3: the hostSource read projection (flair#1940
 * slice 1 / A1'). PURE beyond the A2 validator and the visibility predicate,
 * so it is unit-testable and usable from the read paths.
 *
 * A1' moved the pointer OFF the Memory row and into its OWN table
 * (`MemoryHostSource`, keyed by memoryId). Supported writes store host pointers
 * only in `MemoryHostSource`. A pointer reaches a non-admin reader only through
 * the gated join. For non-admin `Memory.get`, `Memory.search`, and
 * `SemanticSearch` results, the gated projection removes inline pointer fields
 * and renders a pointer only from a bound `MemoryHostSource` row.
 * So the projection no longer reads a field off the record: the caller reads the
 * pointer ROW and passes it in. The three outcomes of the join (A1' item 4) are:
 *   - no pointer row           → the record is returned with any inline
 *                                `hostSource` removed (hostSource absent/null —
 *                                byte-identical to a pointerless record, which
 *                                is what every legacy row is);
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
 * or MCP layer can un-redact. `Memory.get()`, `Memory.search()`,
 * `SemanticSearch` and bootstrap render pointers through the pointer helper;
 * bootstrap renders a visible pointer as a prose citation (A6; see
 * resources/MemoryBootstrap.ts).
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
  memoryInstanceToken?: string | null;
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

/** The canonical hostSource VALUE to RENDER: the full pointer, with any URL
 *  reduced to scheme/host/path (query + fragment stripped, A3). A1'' item 6:
 *  reads return the validated OBJECT (not the stored canonical string), so a
 *  read-then-full-update round trip hands the validator a value it accepts. */
function renderableCanonical(stored: string): { v: 1; host: string; kind: string; id: string; url?: string } | typeof HOST_SOURCE_WITHHELD {
  const parsed = parseHostSource(stored);
  if (!parsed) return HOST_SOURCE_WITHHELD; // a stored value that will not re-validate never renders raw
  return parsed.url !== undefined ? { ...parsed, url: renderHostSourceUrl(parsed.url) } : parsed;
}

/**
 * Whether a reader may see a pointer row, given the record it belongs to. The
 * single decision point the three outcomes fall out of:
 *   "none"     — no pointer row (the record is returned unchanged);
 *   "pointer"  — render the canonical pointer;
 *   "withheld" — render HOST_SOURCE_WITHHELD.
 *
 * A1-iv item 1 (the binding): the pointer is returned (or withheld) ONLY when
 * ALL of these hold — otherwise it is as if no pointer existed, so a stale
 * pointer can never be returned, whichever write path forgot to clean it up:
 *   - pointer.authorId === record.agentId (the pointer's authenticated author
 *     is the row's CURRENT owner);
 *   - pointer.memoryInstanceToken === record.instanceToken (the SAME row
 *     incarnation — a deleted-and-recreated id gets a NEW token);
 *   - the record is not archived.
 * (pointer.memoryId === record.id is implicit: the caller reads the pointer by
 * the record's id.)
 */
export function pointerOutcomeFor(
  record: any,
  readerAgentId: string | null | undefined,
  pointer: PointerRow | null | undefined,
): "none" | "pointer" | "withheld" {
  if (!pointer || typeof pointer.hostSource !== "string" || pointer.hostSource.length === 0) return "none";
  // A1'' item 4: the author is the POINTER row's `authorId`, stamped from the
  // authenticated principal at Memory write time (resources/Memory.ts).
  const author = typeof pointer.authorId === "string" && pointer.authorId.length > 0 ? pointer.authorId : null;
  if (author === null) return "none";
  // A1-iv item 1: the binding. authorId must equal the row's CURRENT agentId,
  // the incarnation token must match, and the row must not be archived.
  if (typeof record?.agentId !== "string" || author !== record.agentId) return "none";
  const rowToken = typeof record?.instanceToken === "string" && record.instanceToken.length > 0 ? record.instanceToken : null;
  const ptrToken = typeof pointer.memoryInstanceToken === "string" && pointer.memoryInstanceToken.length > 0 ? pointer.memoryInstanceToken : null;
  if (rowToken === null || ptrToken === null || rowToken !== ptrToken) return "none";
  if (record?.archived === true) return "none";
  const isAuthor = readerAgentId != null && author === readerAgentId;
  if (isAuthor) return "pointer";
  const scopeAtWrite = pointer.scopeAtWrite;
  if (scopeAtWrite === undefined || scopeAtWrite === null) return "withheld"; // author-only
  const effective = narrowerVisibility(scopeAtWrite, record?.visibility);
  return isPrivateVisibility(effective) ? "withheld" : "pointer";
}

/** The pointer-input keys the named non-admin read paths remove from their
 *  output (A1' item 1). A supported write strips them before persist; a RAW
 *  writer can leave one on the row, so the named non-admin reads (Memory.get,
 *  Memory.search, SemanticSearch) strip them. Bootstrap projects through the
 *  pointer helper too, so its inline fields are dropped as well; it never
 *  returns a raw row. */
const INLINE_POINTER_FIELDS = ["hostSource", "hostSourceScope", "hostSourceVisibility"] as const;

/** Return `record` with every inline pointer-input field removed. Returns the
 *  SAME reference when there is nothing to remove, so a clean record is
 *  byte-identical to today. The one helper the named non-admin reads
 *  (Memory.get, Memory.search, SemanticSearch) use to drop inline pointer
 *  fields independently of the gated join. */
export function stripInlinePointerFields<T>(record: T): T {
  if (!record || typeof record !== "object") return record;
  const r = record as any;
  if (!INLINE_POINTER_FIELDS.some((k) => k in r)) return record;
  const out = { ...r };
  for (const k of INLINE_POINTER_FIELDS) delete out[k];
  return out as T;
}

/**
 * Project a record's pointer for a given reader, given that record's pointer
 * row (or null). Every call to `projectHostSource` removes inline pointer fields.
 * Other response paths must remove them independently or exclude them from their
 * selected fields:
 *   - no pointer row (or one that is unbound/token-mismatched) → the record is
 *     returned with any inline `hostSource` removed;
 *   - otherwise `hostSource` is set to the canonical pointer or
 *     HOST_SOURCE_WITHHELD.
 */
export function projectHostSource<T>(record: T, readerAgentId: string | null | undefined, pointer?: PointerRow | null): T {
  if (!record || typeof record !== "object") return record;
  const decision = pointerOutcomeFor(record, readerAgentId, pointer);
  if (decision === "none") return stripInlinePointerFields(record);
  // Always write the rendering onto a FRESH object: `stripInlinePointerFields`
  // returns the SAME reference when there is nothing to strip, so assigning
  // `hostSource` onto it would mutate the caller's (possibly stored) row. A
  // materialized read is a copy in production, but the gated join must not
  // depend on that — the pointer decision reads the STORED row unchanged.
  const out: any = { ...(stripInlinePointerFields(record) as any) };
  if (decision === "withheld") {
    out.hostSource = HOST_SOURCE_WITHHELD;
  } else {
    out.hostSource = renderableCanonical((pointer as PointerRow).hostSource);
  }
  return out as T;
}
