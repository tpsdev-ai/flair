/**
 * host-source-visibility.ts — A3: the hostSource read projection (flair#1940
 * slice 1). PURE: zero imports beyond the A2 validator and the visibility
 * predicate, so it is unit-testable and usable from every read path.
 *
 * The rule (A3): a pointer is content, never wider than its record.
 *   - Default (no `hostSourceScope: "record"` at write): the pointer is visible
 *     ONLY to the record's author.
 *   - Opted in: the write stored the record's visibility AS IT WAS AT WRITE
 *     (`hostSourceVisibility`); the pointer's EFFECTIVE visibility is the
 *     NARROWER of that stored value and the record's CURRENT visibility, so a
 *     later widening of the record never widens the pointer.
 *   - A reader who may read the record but not the pointer gets
 *     `hostSource: "withheld"` — present but unrendered, so the "externally
 *     sourced" signal survives.
 *
 * The decision is made HERE, on the server, in the read projection — no client
 * or MCP layer can un-redact. Every read surface that returns Memory records
 * calls projectHostSource()/projectHostSourceResult() (see the drift tripwire
 * in test/unit/host-source-visibility.test.ts).
 */
import { parseHostSource } from "./host-source.js";
import { isPrivateVisibility } from "./memory-visibility.js";

/** The literal a reader gets in place of a pointer they may not see (A3). */
export const HOST_SOURCE_WITHHELD = "withheld";

/** The server-stamped, authenticated author id from provenance — NEVER a
 *  writer-supplied field (A6: attribution is the server's, not the claim's). */
export function hostSourceAuthor(record: any): string | null {
  const raw = record?.provenance;
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const p = JSON.parse(raw);
    const id = p?.verified?.agentId;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
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
 * Project a record's `hostSource` for a given reader. Returns:
 *   - the record's value unchanged when there is none (null/undefined), so a
 *     record with no pointer is byte-identical to today;
 *   - the canonical pointer (URL query/fragment stripped) when the reader is
 *     the author, OR the pointer was opted into the record's scope and the
 *     reader may read the record at the pointer's effective visibility;
 *   - HOST_SOURCE_WITHHELD otherwise.
 */
export function projectHostSource<T>(record: T, readerAgentId: string | null | undefined): T {
  if (!record || typeof record !== "object") return record;
  const r = record as any;
  const stored = r.hostSource;
  if (stored === undefined || stored === null) return record; // nothing to project (A1 migration-equivalence)
  if (typeof stored === "string" && stored === HOST_SOURCE_WITHHELD) return record; // idempotent

  const author = hostSourceAuthor(record);
  const isAuthor = author !== null && readerAgentId != null && author === readerAgentId;
  const out = { ...r };

  if (!isAuthor) {
    // Opted in only when the write recorded a write-time visibility next to
    // the pointer; otherwise the pointer is author-only.
    const storedVisibility = r.hostSourceVisibility;
    if (storedVisibility === undefined || storedVisibility === null) {
      out.hostSource = HOST_SOURCE_WITHHELD;
      return out as T;
    }
    const effective = narrowerVisibility(storedVisibility, r.visibility);
    if (isPrivateVisibility(effective)) {
      // Effective private → only the author may read the pointer; the reader
      // is not the author (above), so withhold.
      out.hostSource = HOST_SOURCE_WITHHELD;
      return out as T;
    }
    // Shared effective + the reader already passed the record read gate → the
    // pointer is readable. Fall through to render.
  }

  out.hostSource = renderableCanonical(stored);
  return out as T;
}

/** Apply projectHostSource to an async-iterable / thenable / single Memory
 *  search result (same shape handling as hit-tracking's overlayHitStatsResult). */
export function projectHostSourceResult(result: any, readerAgentId: string | null | undefined): any {
  if (result && typeof result.then === "function") {
    return result.then((value: any) => projectHostSourceResult(value, readerAgentId));
  }
  if (!result || result instanceof Response) return result;
  if (typeof result[Symbol.asyncIterator] === "function") {
    return (async function* projectSources() {
      for await (const row of result) {
        yield projectHostSource(row, readerAgentId);
      }
    })();
  }
  return projectHostSource(result, readerAgentId);
}
