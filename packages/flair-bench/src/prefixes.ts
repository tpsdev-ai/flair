/**
 * prefixes.ts — the input-prefix convention table.
 *
 * Mirrors resources/embeddings-provider.ts's Phase 2 behavior (flair#504):
 * HFE 0.3.0's engine prepends a literal `"search_document: "` /
 * `"search_query: "` string ahead of the text it hands to the model, for
 * nomic-family models trained on that asymmetric-prefix convention. flair-
 * bench talks to node-llama-cpp directly (no HFE in the loop — see the
 * package README for why), so it has to replicate that string-prepend
 * itself rather than pass an `inputType` option through to a wrapper that
 * does it.
 *
 * KEYED ON MODEL FILENAME, for now — nomic is the only convention flair
 * ships today, and there's exactly one production model family to match.
 * This table is the seam for adding more: a future entry keys on another
 * filename pattern (or, if a GGUF ever carries a documented convention-id
 * in its own metadata, that becomes the preferred match — filename is a
 * pragmatic fallback, not a design commitment). Nomic upstream has a request
 * to carry this in the GGUF/HFE registration surface itself rather than
 * every consumer re-deriving it from a filename convention — see
 * harper-fabric-embeddings#4 (upstream proposal, not yet merged as of this
 * writing).
 *
 * A model whose filename matches no entry gets `undefined` from
 * `resolvePrefixConvention()` — texts are embedded unprefixed, and the
 * result is labeled accordingly rather than silently guessing.
 */

export interface PrefixConvention {
  /** Human-readable id, surfaced in output so a reader knows which convention (if any) applied. */
  id: string;
  documentPrefix: string;
  queryPrefix: string;
}

interface ConventionEntry {
  id: string;
  /** Matched against the GGUF's basename (case-insensitive). */
  filenamePattern: RegExp;
  convention: PrefixConvention;
}

const NOMIC_CONVENTION: PrefixConvention = {
  id: "nomic-search-prefix",
  documentPrefix: "search_document: ",
  queryPrefix: "search_query: ",
};

/**
 * The convention table. Order matters only in that the first match wins —
 * kept a flat array (not a Map) since patterns can overlap in principle
 * (e.g. a future family sharing a "nomic-embed" substring with a distinct
 * suffix) and an explicit ordered scan makes that resolvable without a key
 * collision.
 */
const CONVENTIONS: ConventionEntry[] = [
  {
    id: "nomic-embed-text-family",
    // nomic-embed-text-v1.5.*, nomic-embed-text-v2-moe.* — both nomic
    // families document the same search_document:/search_query: task-prefix
    // convention on their model cards.
    filenamePattern: /^nomic-embed-text/i,
    convention: NOMIC_CONVENTION,
  },
];

/** Resolve the prefix convention for a GGUF file, by basename. `undefined` = no known convention (embed unprefixed). */
export function resolvePrefixConvention(fileName: string): PrefixConvention | undefined {
  const base = fileName.replace(/^.*[/\\]/, "");
  for (const entry of CONVENTIONS) {
    if (entry.filenamePattern.test(base)) return entry.convention;
  }
  return undefined;
}

export function applyDocumentPrefix(text: string, convention: PrefixConvention | undefined): string {
  return convention ? `${convention.documentPrefix}${text}` : text;
}

export function applyQueryPrefix(text: string, convention: PrefixConvention | undefined): string {
  return convention ? `${convention.queryPrefix}${text}` : text;
}
