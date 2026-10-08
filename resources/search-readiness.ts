/**
 * search-readiness.ts — the honest /Health search-ready signal (flair#1326).
 *
 * Harper's process can answer /health (and Flair's /Health resource can
 * answer {ok:true}) while search is still unusable:
 *
 *   1. Boot window — jsResources register incrementally. /Health can be up
 *      while /Memory and /SemanticSearch still 404 from Harper's catch-all
 *      (documented in packages/adk-flair-js/test/helpers/boot-harper.mjs).
 *   2. BM25 index still empty or building — the persistent index warms in
 *      the background after embeddings boot (bm25-index-service.ts). Until
 *      that build finishes, a text search waits for it. /Health answering
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
 *   - Routes up but the BM25 index is still empty or building → process is
 *     live (ok:true, HTTP 200) and searchReady:false names the lag. We do
 *     NOT 503 on an unready index: a health check must not be what builds
 *     it, and 503-until-warm would make a traffic gate wait on a scan the
 *     gate itself is not supposed to run. The background warm (or a text
 *     search) is what clears `empty`.
 */

import type { RetrievalMode } from "./bm25.js";
import { bm25SearchLagReason } from "./bm25-status.js";
import { MEMORY_REEMBED_PATCH_CAPABILITY } from "../src/lib/reembed-server-support.js";

/**
 * How a ready result was verified. Constant strings — no interpolation
 * (flair#1411). Public /Health still omits this field when searchReady is
 * true; the values live on the decision object so a caller of
 * resolveSearchReadiness can tell registry-verified from table-only.
 */
export const SEARCH_READY_REASON_VERIFIED_VIA_ROUTE_REGISTRY =
  "verified via route registry";
export const SEARCH_READY_REASON_REGISTRY_UNAVAILABLE_TABLE_ONLY =
  "registry unavailable, table check only";

/** Once-warn when the route-mount check is skipped (flair#1411). */
export const MISSING_REGISTRY_WARN =
  "search route-mount verification is degraded; searchReady now rests on the table check alone";

let warnedMissingRegistry = false;

/** Test-only: forget the one-shot missing-registry warning. */
export function _resetMissingRegistryWarnForTests(): void {
  warnedMissingRegistry = false;
}

export type SearchReadiness = {
  /** False when search routes/table are down OR the hybrid index is still cold. */
  searchReady: boolean;
  /** Liveness: the Flair app can answer. False only when search cannot be served at all. */
  ok: boolean;
  /** HTTP status for the public /Health endpoint. */
  status: number;
  /**
   * When !searchReady: names the lag instead of implying "healthy."
   * When searchReady: names how readiness was verified (route registry vs
   * table check only). Public /Health still omits the field when ready —
   * that shape is unchanged (flair#1411).
   */
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
  /** Operator line from bm25IndexStatus(), when the caller has it. */
  summary?: string;
} | null | undefined;

function routeMounted(resources: ResourceRegistry, name: string): boolean {
  const entry = resources.get?.(name) ?? resources.getMatch?.(name);
  return Boolean(entry?.Resource);
}

/**
 * Decide whether search is actually usable, and whether /Health should claim
 * the process is healthy.
 *
 * `resources` is optional. Stated fail-open (Sherlock on #1406 / flair#1411):
 * when the registry is missing we skip the route-mount check rather than
 * 503 forever. A table handle can exist while `/Memory` and `/SemanticSearch`
 * still 404, so this is weaker than the primary defense. We do not fail
 * closed. We warn once and name the degradation on `searchReadyReason`.
 */
export function resolveSearchReadiness(opts: {
  resources?: ResourceRegistry | null;
  memoryTable?: MemoryTable;
  bm25?: Bm25Status;
  hybridEnabled?: boolean;
  /**
   * The active retrieval mode (retrievalMode() in ./bm25.ts). Preferred over
   * `hybridEnabled` when supplied: the persistent BM25 index is in the
   * retrieval path for "hybrid" AND "bm25-only", and out of it for
   * "vector-only". Unset ⇒ derived from `hybridEnabled` (undefined/true ⇒
   * hybrid, false ⇒ vector-only), so existing callers are unaffected.
   */
  retrievalMode?: RetrievalMode;
  /** Persistent BM25 index kill switch (`FLAIR_BM25_INDEX`). Default on. */
  bm25IndexEnabled?: boolean;
  /** Optional sink for the missing-registry once-warn (live path: harper logger). */
  warn?: (message: string) => void;
}): SearchReadiness {
  let readyReason: string = SEARCH_READY_REASON_REGISTRY_UNAVAILABLE_TABLE_ONLY;
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
    readyReason = SEARCH_READY_REASON_VERIFIED_VIA_ROUTE_REGISTRY;
  } else {
    if (!warnedMissingRegistry) {
      warnedMissingRegistry = true;
      opts.warn?.(MISSING_REGISTRY_WARN);
    }
  }

  if (!opts.memoryTable || typeof opts.memoryTable.search !== "function") {
    return notServing("memory table not queryable");
  }

  // Hybrid + the persistent index are default-on. An empty or in-flight BM25
  // index means a text search waits for the build — the #1326 lag. Name it;
  // do not fail liveness.
  //
  // `disabled` (feed/build failure) and `FLAIR_BM25_INDEX=false` both fall
  // back to the per-query scan. The kill switch never calls ensureReady, so
  // the underlying state stays `empty` while status() reports `disabled` —
  // that is serving, not an unready index. Treating the kill switch as lag
  // would make searchReady false forever and refuse a node that is already
  // answering recall. Callers pass `bm25IndexEnabled: false` for that case.
  // The persistent BM25 index is in the retrieval path for "hybrid" and
  // "bm25-only"; a "vector-only" process has no lexical leg to keep warm.
  // `retrievalMode` is the current selector; `hybridEnabled` is the legacy
  // boolean callers passed before it — an unset retrievalMode falls back to it
  // exactly (false ⇒ vector-only, so the shipped behavior is unchanged).
  const effectiveMode: RetrievalMode =
    opts.retrievalMode ?? (opts.hybridEnabled === false ? "vector-only" : "hybrid");
  const indexInPath = effectiveMode !== "vector-only" && opts.bm25IndexEnabled !== false;
  if (indexInPath && opts.bm25) {
    if (opts.bm25.state === "building" || opts.bm25.state === "empty") {
      return namesLag(bm25SearchLagReason(opts.bm25));
    }
  }

  return { searchReady: true, ok: true, status: 200, searchReadyReason: readyReason };
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
    // flair#2337: this build advertises the re-embed PATCH token.
    // The shared constant aligns this build's CLI and server literals.
    capabilities: [MEMORY_REEMBED_PATCH_CAPABILITY],
  };
  // Ready-path verification constants stay on the decision object (flair#1411).
  if (!readiness.searchReady && readiness.searchReadyReason) {
    body.searchReadyReason = readiness.searchReadyReason;
  }
  return body;
}
