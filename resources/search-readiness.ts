/**
 * search-readiness.ts — the honest /Health search-ready signal (flair#1326).
 *
 * Harper's process can answer /health (and Flair's /Health resource can
 * answer {ok:true}) while search is still unusable:
 *
 *   1. Boot window — jsResources register incrementally. /Health can be up
 *      while /Memory and /SemanticSearch still 404 from Harper's catch-all
 *      (documented in packages/adk-flair-js/test/helpers/boot-harper.mjs).
 *   2. Cold BM25 index — hybrid retrieval's persistent index is lazy-built
 *      on the first search, not at component start (bm25-index-service.ts).
 *      That first-query corpus scan grows with store size. /Health answering
 *      is not "recall is warm."
 *
 * This module is Harper-free so the decision is unit-testable against the
 * shipped function. Callers inject the registry / table / index status they
 * already have.
 *
 * Two layers, on purpose:
 *   - Routes/table not mounted → not healthy (ok:false, HTTP 503). A
 *     traffic-gating probe that only looks at status must not get a green
 *     light for a node whose search routes are not serving.
 *   - Routes up but index still cold → process is live (ok:true, HTTP 200)
 *     and searchReady:false names the lag. We do NOT 503 on a cold index:
 *     the index builds on the first search, and a health check must not
 *     trigger that scan (bm25-index-service.ts: "Eager building would add a
 *     full corpus scan to every boot including … health checks"). 503-until-
 *     warm would deadlock — health waits for the index, the index waits for
 *     a search that never comes.
 */

export type SearchReadiness = {
  /** False when search routes/table are down OR the hybrid index is still cold. */
  searchReady: boolean;
  /** Liveness: the Flair app can answer. False only when search cannot be served at all. */
  ok: boolean;
  /** HTTP status for the public /Health endpoint. */
  status: number;
  /** Present iff !searchReady — names the lag instead of implying "healthy." */
  searchReadyReason?: string;
};

export type ResourceRegistry = {
  get?(name: string): { Resource?: unknown } | undefined;
  getMatch?(name: string): { Resource?: unknown } | undefined;
};

export type MemoryTable = {
  search?: (query: unknown) => unknown;
} | null | undefined;

export type Bm25Status = {
  state: string;
  reason?: string;
} | null | undefined;

function routeMounted(resources: ResourceRegistry, name: string): boolean {
  const entry = resources.get?.(name) ?? resources.getMatch?.(name);
  return Boolean(entry?.Resource);
}

/**
 * Decide whether search is actually usable, and whether /Health should claim
 * the process is healthy.
 *
 * `resources` is optional: Harper's `server` export may not expose the
 * registry in every context. When it is missing we skip the route check
 * rather than fail-closed forever. The memory-table check still applies.
 */
export function resolveSearchReadiness(opts: {
  resources?: ResourceRegistry | null;
  memoryTable?: MemoryTable;
  bm25?: Bm25Status;
  hybridEnabled?: boolean;
}): SearchReadiness {
  if (opts.resources) {
    const memoryMounted = routeMounted(opts.resources, "Memory");
    const searchMounted = routeMounted(opts.resources, "SemanticSearch");
    if (!memoryMounted || !searchMounted) {
      const missing = [
        !memoryMounted ? "Memory" : null,
        !searchMounted ? "SemanticSearch" : null,
      ].filter(Boolean).join(", ");
      return notServing(`search routes not mounted (${missing})`);
    }
  }

  if (!opts.memoryTable || typeof opts.memoryTable.search !== "function") {
    return notServing("memory table not queryable");
  }

  // Hybrid is default-on. A cold or in-flight BM25 index means the first
  // search will pay a full corpus scan — the #1326 lag. Name it; do not
  // fail liveness. `disabled` falls back to the per-query scan (slow but
  // serving), so that is still search-ready.
  if (opts.hybridEnabled !== false && opts.bm25) {
    if (opts.bm25.state === "building") {
      return namesLag("bm25 index building — first search is still scanning the corpus");
    }
    if (opts.bm25.state === "empty") {
      return namesLag("bm25 index not built (cold boot; first search scans the corpus)");
    }
  }

  return { searchReady: true, ok: true, status: 200 };
}

function notServing(searchReadyReason: string): SearchReadiness {
  return { searchReady: false, ok: false, status: 503, searchReadyReason };
}

function namesLag(searchReadyReason: string): SearchReadiness {
  return { searchReady: false, ok: true, status: 200, searchReadyReason };
}

/** Public /Health JSON body. `searchReady` is always present (never omitted). */
export function buildPublicHealthBody(
  readiness: SearchReadiness,
  identity: { version: string; buildCommit: string | null },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ok: readiness.ok,
    version: identity.version,
    buildCommit: identity.buildCommit,
    searchReady: readiness.searchReady,
  };
  if (readiness.searchReadyReason) body.searchReadyReason = readiness.searchReadyReason;
  return body;
}
