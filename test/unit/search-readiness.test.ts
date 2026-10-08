/**
 * search-readiness.test.ts — flair#1326.
 *
 * /Health used to answer {ok:true} as soon as the Health resource was
 * loaded. That is a green light that lies when /Memory and /SemanticSearch
 * are still Harper catch-all 404s, and again after restart while the BM25
 * index is still empty or building (a text search waits for the background
 * build; the wait grows with store size). The decision lives in
 * resources/search-readiness.ts so
 * this file drives the shipped function — no Harper, no 66k-row store.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  buildPublicHealthBody,
  MISSING_REGISTRY_WARN,
  SEARCH_READY_REASON_REGISTRY_UNAVAILABLE_TABLE_ONLY,
  SEARCH_READY_REASON_VERIFIED_VIA_ROUTE_REGISTRY,
  _resetMissingRegistryWarnForTests,
  resolveSearchReadiness,
  type ResourceRegistry,
} from "../../resources/search-readiness.ts";
import { MEMORY_REEMBED_PATCH_CAPABILITY } from "../../src/lib/reembed-server-support.ts";

function registry(names: string[]): ResourceRegistry {
  const set = new Set(names);
  return {
    get: (name) => (set.has(name) ? { Resource: class {} } : undefined),
  };
}

const memoryTable = { search: () => ({}) };
const mounted = registry(["Memory", "SemanticSearch"]);

describe("resolveSearchReadiness (flair#1326)", () => {
  test("routes not mounted → not healthy (503), reason names the missing route", () => {
    const r = resolveSearchReadiness({
      resources: registry(["Health"]),
      memoryTable,
      bm25: { state: "ready" },
      hybridEnabled: true,
    });
    expect(r).toEqual({
      searchReady: false,
      ok: false,
      status: 503,
      searchReadyReason: "search routes not mounted (Memory, SemanticSearch)",
    });
  });

  test("only Memory mounted → 503 names SemanticSearch, not a blanket healthy", () => {
    const r = resolveSearchReadiness({
      resources: registry(["Memory"]),
      memoryTable,
      bm25: { state: "ready" },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
    expect(r.searchReady).toBe(false);
    expect(r.searchReadyReason).toBe("search routes not mounted (SemanticSearch)");
  });

  test("memory table not queryable → 503 even when routes look mounted", () => {
    const r = resolveSearchReadiness({
      resources: mounted,
      memoryTable: {},
      bm25: { state: "ready" },
    });
    expect(r).toEqual({
      searchReady: false,
      ok: false,
      status: 503,
      searchReadyReason: "memory table not queryable",
    });
  });

  test("no registry (Harper server.resources absent) does not fail-closed if the table answers", () => {
    const r = resolveSearchReadiness({
      resources: null,
      memoryTable,
      bm25: { state: "ready" },
      hybridEnabled: true,
    });
    expect(r.searchReady).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.searchReadyReason).toBe(SEARCH_READY_REASON_REGISTRY_UNAVAILABLE_TABLE_ONLY);
  });

  test("empty BM25 index after restart → 200 liveness, searchReady false says what clears it", () => {
    const r = resolveSearchReadiness({
      resources: mounted,
      memoryTable,
      bm25: { state: "empty" },
      hybridEnabled: true,
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.searchReady).toBe(false);
    expect(r.searchReadyReason).toMatch(/not built yet/i);
    expect(r.searchReadyReason).toMatch(/text search/i);
    expect(r.searchReadyReason).not.toMatch(/cold boot/i);
    expect(r.searchReadyReason).not.toMatch(/scans the corpus/i);
  });

  test("public /Health lag reports a skipped warm without publishing its configuration or error", () => {
    const rawReason = "background build skipped: FLAIR_BM25_INDEX=0, retrieval mode bm25-only, private table error";
    const readiness = resolveSearchReadiness({
      resources: mounted,
      memoryTable,
      bm25: { state: "empty", reason: rawReason },
      retrievalMode: "hybrid",
    });
    const body = buildPublicHealthBody(readiness, { version: "dev", buildCommit: null });
    expect(body.searchReady).toBe(false);
    expect(body.searchReadyReason).toBe("bm25 index not built yet — background build was skipped; a text search builds it");
    expect(JSON.stringify(body)).not.toContain(rawReason);
    expect(JSON.stringify(body)).not.toContain("FLAIR_BM25_INDEX");
    expect(JSON.stringify(body)).not.toContain("retrieval mode");
    expect(JSON.stringify(body)).not.toContain("private table error");
  });

  test("public lag names a stale index without exposing feed contents", () => {
    const readiness = resolveSearchReadiness({
      resources: mounted,
      memoryTable,
      bm25: { state: "empty", reason: "unhandled feed event type private-event" },
      retrievalMode: "bm25-only",
    });
    const body = buildPublicHealthBody(readiness, { version: "dev", buildCommit: null });
    expect(body.searchReady).toBe(false);
    expect(body.searchReadyReason).toBe("bm25 index not built yet — previous index became stale; a text search rebuilds it");
    expect(JSON.stringify(body)).not.toContain("private-event");
  });

  test("public Health omits lag text for ready, disabled, failed, and vector-only states", () => {
    for (const bm25 of [
      { state: "ready", reason: "" },
      { state: "disabled", reason: "FLAIR_BM25_INDEX is off" },
      { state: "disabled", reason: "retrieval mode is vector-only; the index is not used" },
      { state: "failed", reason: "build failed: private error" },
    ]) {
      const readiness = resolveSearchReadiness({ resources: mounted, memoryTable, bm25 });
      const body = buildPublicHealthBody(readiness, { version: "dev", buildCommit: null });
      expect(body.searchReady).toBe(true);
      expect("searchReadyReason" in body).toBe(false);
    }
    const vectorOnly = resolveSearchReadiness({
      resources: mounted,
      memoryTable,
      bm25: { state: "empty", reason: "unhandled feed event type private-event" },
      retrievalMode: "vector-only",
    });
    expect("searchReadyReason" in buildPublicHealthBody(vectorOnly, { version: "dev", buildCommit: null })).toBe(false);
  });

  test("BM25 still building → names the in-flight build, does not claim search-ready", () => {
    const r = resolveSearchReadiness({
      resources: mounted,
      memoryTable,
      bm25: { state: "building" },
      hybridEnabled: true,
    });
    expect(r.searchReady).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.searchReadyReason).toMatch(/bm25 index: building/i);
    expect(r.searchReadyReason).toMatch(/waits for this build/i);
    expect(r.searchReadyReason).not.toMatch(/scans the corpus/i);
  });

  test("building with a progress summary uses that line (flair#2032)", () => {
    const r = resolveSearchReadiness({
      resources: mounted,
      memoryTable,
      bm25: {
        state: "building",
        summary: "building 312/817 docs (38%) · started 4s ago",
      },
      hybridEnabled: true,
    });
    expect(r.searchReady).toBe(false);
    expect(r.searchReadyReason).toBe("bm25 index: building 312/817 docs (38%) · started 4s ago");
  });

  test("a failed build is still serving via the scan, so searchReady stays true (flair#2032)", () => {
    const r = resolveSearchReadiness({
      resources: mounted,
      memoryTable,
      bm25: { state: "failed", reason: "build failed: disk gone" },
      hybridEnabled: true,
    });
    expect(r.searchReady).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
  });

  test("BM25 ready + routes mounted → searchReady true, registry-verified reason", () => {
    const r = resolveSearchReadiness({
      resources: mounted,
      memoryTable,
      bm25: { state: "ready" },
      hybridEnabled: true,
    });
    expect(r.searchReady).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.searchReadyReason).toBe(SEARCH_READY_REASON_VERIFIED_VIA_ROUTE_REGISTRY);
  });

  test("hybrid off: a cold BM25 index is not a lie — lexical fallback is the path", () => {
    const r = resolveSearchReadiness({
      resources: mounted,
      memoryTable,
      bm25: { state: "empty" },
      hybridEnabled: false,
    });
    expect(r.searchReady).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
  });

  test("retrievalMode 'vector-only': a cold BM25 index is not a lie — no lexical leg in the path", () => {
    const r = resolveSearchReadiness({
      resources: mounted,
      memoryTable,
      bm25: { state: "empty" },
      retrievalMode: "vector-only",
    });
    expect(r.searchReady).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
  });

  test("retrievalMode 'bm25-only': the lexical index IS the path, so a cold index is named as lag", () => {
    const r = resolveSearchReadiness({
      resources: mounted,
      memoryTable,
      bm25: { state: "empty" },
      retrievalMode: "bm25-only",
    });
    expect(r.searchReady).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.searchReadyReason).toMatch(/not built yet/);
    expect(r.searchReadyReason).not.toMatch(/cold boot/i);
  });

  test("retrievalMode is authoritative over the legacy hybridEnabled boolean", () => {
    // hybridEnabled:false (legacy vector-only) but an explicit bm25-only mode:
    // the mode is what the process actually runs, so the cold index IS lag.
    const r = resolveSearchReadiness({
      resources: mounted,
      memoryTable,
      bm25: { state: "empty" },
      hybridEnabled: false,
      retrievalMode: "bm25-only",
    });
    expect(r.searchReady).toBe(false);
    expect(r.searchReadyReason).toMatch(/not built yet/);
    expect(r.searchReadyReason).not.toMatch(/cold boot/i);
  });

  test("FLAIR_BM25_INDEX off: empty is the kill-switch steady state, not cold lag", () => {
    // ensureReady never builds when the index is killed, so status stays
    // empty for the process lifetime while hybrid still serves the legacy
    // per-query scan. searchReady must not stay false forever.
    const r = resolveSearchReadiness({
      resources: mounted,
      memoryTable,
      bm25: { state: "empty" },
      hybridEnabled: true,
      bm25IndexEnabled: false,
    });
    expect(r.searchReady).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.searchReadyReason).toBe(SEARCH_READY_REASON_VERIFIED_VIA_ROUTE_REGISTRY);
  });

  test("BM25 disabled (legacy per-query scan) is still serving, so searchReady stays true", () => {
    const r = resolveSearchReadiness({
      resources: mounted,
      memoryTable,
      bm25: { state: "disabled", reason: "change feed ended" },
      hybridEnabled: true,
    });
    expect(r.searchReady).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.searchReadyReason).toBe(SEARCH_READY_REASON_VERIFIED_VIA_ROUTE_REGISTRY);
  });
});

describe("missing registry once-warn (flair#1411)", () => {
  beforeEach(() => {
    _resetMissingRegistryWarnForTests();
  });

  test("opts.resources null: warn fires once across two calls; reason is table-only", () => {
    const warns: string[] = [];
    const opts = {
      resources: null,
      memoryTable,
      bm25: { state: "ready" as const },
      hybridEnabled: true,
      warn: (message: string) => { warns.push(message); },
    };
    const first = resolveSearchReadiness(opts);
    const second = resolveSearchReadiness(opts);
    expect(warns).toEqual([MISSING_REGISTRY_WARN]);
    expect(first.searchReady).toBe(true);
    expect(second.searchReady).toBe(true);
    expect(first.searchReadyReason).toBe(SEARCH_READY_REASON_REGISTRY_UNAVAILABLE_TABLE_ONLY);
    expect(second.searchReadyReason).toBe(SEARCH_READY_REASON_REGISTRY_UNAVAILABLE_TABLE_ONLY);
  });

  test("registry present and routes mounted: verified reason, warn does not fire", () => {
    const warns: string[] = [];
    const r = resolveSearchReadiness({
      resources: mounted,
      memoryTable,
      bm25: { state: "ready" },
      hybridEnabled: true,
      warn: (message) => { warns.push(message); },
    });
    expect(warns).toEqual([]);
    expect(r.searchReady).toBe(true);
    expect(r.searchReadyReason).toBe(SEARCH_READY_REASON_VERIFIED_VIA_ROUTE_REGISTRY);
  });
});

describe("buildPublicHealthBody (flair#1326)", () => {
  const identity = { version: "0.46.0", buildCommit: "a".repeat(40) };

  test("searchReady is always present — never omitted the way a silent green light was", () => {
    const ready = buildPublicHealthBody(
      { searchReady: true, ok: true, status: 200 },
      identity,
    );
    expect(ready).toEqual({
      ok: true,
      version: "0.46.0",
      buildCommit: identity.buildCommit,
      searchReady: true,
      capabilities: [MEMORY_REEMBED_PATCH_CAPABILITY],
    });
    expect("searchReadyReason" in ready).toBe(false);

    // Ready-path verification constants stay off the public body (flair#1411).
    const verified = buildPublicHealthBody(
      {
        searchReady: true,
        ok: true,
        status: 200,
        searchReadyReason: SEARCH_READY_REASON_VERIFIED_VIA_ROUTE_REGISTRY,
      },
      identity,
    );
    expect("searchReadyReason" in verified).toBe(false);
    const tableOnly = buildPublicHealthBody(
      {
        searchReady: true,
        ok: true,
        status: 200,
        searchReadyReason: SEARCH_READY_REASON_REGISTRY_UNAVAILABLE_TABLE_ONLY,
      },
      identity,
    );
    expect("searchReadyReason" in tableOnly).toBe(false);

    const cold = buildPublicHealthBody(
      {
        searchReady: false,
        ok: true,
        status: 200,
        searchReadyReason: "bm25 index not built yet — builds in the background after startup, or on the first text search",
      },
      identity,
    );
    expect(cold.ok).toBe(true);
    expect(cold.searchReady).toBe(false);
    expect(cold.searchReadyReason).toMatch(/bm25 index not built/);
  });

  test("routes-down body carries ok:false so a status-only reader is not the only honest signal", () => {
    const body = buildPublicHealthBody(
      {
        searchReady: false,
        ok: false,
        status: 503,
        searchReadyReason: "search routes not mounted (SemanticSearch)",
      },
      { version: "dev", buildCommit: null },
    );
    expect(body.ok).toBe(false);
    expect(body.searchReady).toBe(false);
    expect(body.buildCommit).toBeNull();
  });
});
