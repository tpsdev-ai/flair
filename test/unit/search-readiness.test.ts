/**
 * search-readiness.test.ts — flair#1326.
 *
 * /Health used to answer {ok:true} as soon as the Health resource was
 * loaded. That is a green light that lies when /Memory and /SemanticSearch
 * are still Harper catch-all 404s, and again after restart when the hybrid
 * BM25 index is still empty (first search scans the corpus; the lag grows
 * with store size). The decision lives in resources/search-readiness.ts so
 * this file drives the shipped function — no Harper, no 66k-row store.
 */
import { describe, expect, test } from "bun:test";
import {
  buildPublicHealthBody,
  resolveSearchReadiness,
  type ResourceRegistry,
} from "../../resources/search-readiness.ts";

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
    expect(r).toEqual({ searchReady: true, ok: true, status: 200 });
  });

  test("cold BM25 index after restart → 200 liveness, searchReady false names the lag", () => {
    const r = resolveSearchReadiness({
      resources: mounted,
      memoryTable,
      bm25: { state: "empty" },
      hybridEnabled: true,
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.searchReady).toBe(false);
    expect(r.searchReadyReason).toMatch(/bm25 index not built/i);
    expect(r.searchReadyReason).toMatch(/first search scans the corpus/i);
  });

  test("BM25 still building → names the in-flight scan, does not claim search-ready", () => {
    const r = resolveSearchReadiness({
      resources: mounted,
      memoryTable,
      bm25: { state: "building" },
      hybridEnabled: true,
    });
    expect(r.searchReady).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.searchReadyReason).toMatch(/bm25 index building/i);
  });

  test("BM25 ready + routes mounted → searchReady true, no reason", () => {
    const r = resolveSearchReadiness({
      resources: mounted,
      memoryTable,
      bm25: { state: "ready" },
      hybridEnabled: true,
    });
    expect(r).toEqual({ searchReady: true, ok: true, status: 200 });
    expect(r.searchReadyReason).toBeUndefined();
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

  test("BM25 disabled (legacy per-query scan) is still serving, so searchReady stays true", () => {
    const r = resolveSearchReadiness({
      resources: mounted,
      memoryTable,
      bm25: { state: "disabled", reason: "change feed ended" },
      hybridEnabled: true,
    });
    expect(r.searchReady).toBe(true);
    expect(r.ok).toBe(true);
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
    });
    expect("searchReadyReason" in ready).toBe(false);

    const cold = buildPublicHealthBody(
      {
        searchReady: false,
        ok: true,
        status: 200,
        searchReadyReason: "bm25 index not built (cold boot; first search scans the corpus)",
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
