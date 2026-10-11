/**
 * host-source-citation.ts — the bootstrap prose citation for a bound host
 * pointer (flair#1940 A6). PURE and Harper-free (it depends only on the A2
 * validator), so it is unit-testable directly and usable from the prose path.
 *
 * A6 asks for ONE exported citation format. The citation names the host object
 * the WRITER CLAIMED — host/kind, then the first 8 characters of the id — and
 * marks the claim `(unverified)`: flair does not verify the host object and does
 * not sign the pointer body, so the citation attributes a claim, it never
 * asserts host authorship. The 8-character id is display-only; the STORED id is
 * never truncated. The full URL never appears here (A6 reserves it for MCP/CLI
 * detail output), and the rendered citation is well under the 20-token budget
 * (`HOST_SOURCE_CITATION_MAX_TOKENS`) for any accepted pointer.
 *
 * `formatHostSourceCitation` takes the GATED join's rendered value — the
 * validated pointer OBJECT (see host-source-visibility.ts's `projectHostSource`),
 * the literal `"withheld"`, or nothing — NOT the raw stored string. So the
 * citation inherits the server's redaction decision and can never render a
 * pointer the reader could not see.
 */

/** The citation format template (A6). Exported so the test asserting the
 *  rendered shape and the caller share one definition. */
export const HOST_SOURCE_CITATION_FORMAT = "[via {host}/{kind} {id8} (unverified)]";

/** The number of id characters shown (A6: display-only; the stored id is never
 *  truncated). */
export const HOST_SOURCE_ID_DISPLAY_CHARS = 8;

/** The marker rendered in place of a pointer the reader may not see (A3). */
export const HOST_SOURCE_WITHHELD_CITATION = "[via withheld]";

/** The per-cited-item token ceiling A6 sets. */
export const HOST_SOURCE_CITATION_MAX_TOKENS = 20;

/** The validated pointer value the gated join renders (host-source-visibility.ts),
 *  the withheld literal, or nothing. */
export type RenderedHostSource =
  | { v: 1; host: string; kind: string; id: string; url?: string }
  | typeof HOST_SOURCE_WITHHELD_CITATION
  | "withheld"
  | null
  | undefined;

/**
 * Render the bootstrap citation for one joined pointer value, or null when the
 * record has no renderable pointer (no pointer, an unbound/archived pointer, or
 * a value that does not re-validate). A `"withheld"` pointer renders the
 * withheld marker, so the "externally sourced" signal survives without
 * revealing the host object (A3).
 */
export function formatHostSourceCitation(rendered: RenderedHostSource): string | null {
  if (rendered === "withheld" || rendered === HOST_SOURCE_WITHHELD_CITATION) {
    return HOST_SOURCE_WITHHELD_CITATION;
  }
  if (!rendered || typeof rendered !== "object") return null;
  const { host, kind, id } = rendered as { host?: unknown; kind?: unknown; id?: unknown };
  if (typeof host !== "string" || typeof kind !== "string" || typeof id !== "string" || id.length === 0) {
    return null;
  }
  return `[via ${host}/${kind} ${id.slice(0, HOST_SOURCE_ID_DISPLAY_CHARS)} (unverified)]`;
}
