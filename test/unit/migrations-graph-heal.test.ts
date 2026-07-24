/**
 * migrations-graph-heal.test.ts — resources/migrations/graph-heal.ts, the
 * verify-only recall graph-heal OBSERVABILITY migration. Exercises
 * detect/countPending/run against an in-memory fake Memory table + a fake
 * OrgEvent table (no real Harper). The actual schema-driven HNSW rebuild is
 * proven end-to-end in test/integration/hnsw-graph-heal-e2e.test.ts; this
 * covers the migration's own logic: canary self-recall health gate,
 * observe-only (zero row work) semantics, and the structural-only ledger
 * event.
 */
import { describe, it, expect } from "bun:test";

// graph-heal.ts imports `{ databases } from "@harperfast/harper"` for its
// DEFAULT accessors only (never used here — every test injects fakes). Same
// workaround as migrations-embedding-stamp.test.ts: mock the module before
// import so its import-time side effects never fire.
import { mock } from "bun:test";
mock.module("@harperfast/harper", () => ({ databases: {}, Resource: class {} }));

const { createGraphHealMigration, GRAPH_HEAL_ID } = await import("../../resources/migrations/graph-heal.ts");

type Row = Record<string, unknown> & { id: string };

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function makeFakeMemoryTable(rows: Row[], opts: { throwOnSort?: boolean } = {}) {
  const store = new Map<string, Row>(rows.map((r) => [r.id, { ...r }]));
  const table = {
    async get(id: string) {
      return store.has(id) ? { ...store.get(id)! } : null;
    },
    search(query: any): AsyncIterable<Row> {
      // Cosine-sort (HNSW nearest-neighbor) query.
      if (query?.sort?.distance === "cosine") {
        if (opts.throwOnSort) throw new Error("HNSW index unavailable (mid-rebuild)");
        const target = query.sort.target as number[];
        const limit = typeof query.limit === "number" ? query.limit : Infinity;
        const ranked = Array.from(store.values())
          .filter((r) => Array.isArray((r as any).embedding) && (r as any).embedding.length > 0)
          .map((r) => ({ r, c: cosine(target, (r as any).embedding) }))
          .sort((a, b) => b.c - a.c)
          .slice(0, limit)
          .map((x) => ({ id: x.r.id }) as Row);
        return (async function* () {
          for (const r of ranked) yield r;
        })();
      }
      // Plain listing / select query.
      const limit = typeof query?.limit === "number" ? query.limit : Infinity;
      const out = Array.from(store.values()).slice(0, limit).map((r) => ({ ...r }));
      return (async function* () {
        for (const r of out) yield r;
      })();
    },
  };
  return { store, table };
}

function makeFakeOrgEventTable() {
  const puts: any[] = [];
  return {
    puts,
    table: {
      async put(content: unknown) {
        puts.push(content);
        return content;
      },
    },
  };
}

const VERSION = "9.9.9-test";
const emb = (seed: number, dim = 8): number[] =>
  Array.from({ length: dim }, (_, i) => Math.sin(seed * 7.13 + i * 1.7));

describe("graph-heal migration — identity", () => {
  it("has the expected id, derived-only risk class, and Memory scope", () => {
    const { table } = makeFakeMemoryTable([]);
    const { table: oe } = makeFakeOrgEventTable();
    const m = createGraphHealMigration(() => table, () => oe, () => VERSION);
    expect(m.id).toBe(GRAPH_HEAL_ID);
    expect(m.riskClass).toBe("derived-only");
    expect(m.affectsTables).toEqual(["Memory"]);
  });

  it("countPending() is always 0 — the migration is observe-only, never touches rows", async () => {
    const { table } = makeFakeMemoryTable([
      { id: "m1", embedding: emb(1), embeddingModel: "real" },
    ]);
    const { table: oe } = makeFakeOrgEventTable();
    const m = createGraphHealMigration(() => table, () => oe, () => VERSION);
    expect(await m.countPending()).toBe(0);
  });
});

describe("graph-heal migration — detect() (canary self-recall health gate)", () => {
  it("false on an empty store (no embedded data → nothing to heal or verify)", async () => {
    const { table } = makeFakeMemoryTable([]);
    const { table: oe } = makeFakeOrgEventTable();
    const m = createGraphHealMigration(() => table, () => oe, () => VERSION);
    expect(await m.detect()).toBe(false);
  });

  it("false when rows exist but none carry an embedding", async () => {
    const { table } = makeFakeMemoryTable([
      { id: "m1", content: "no vector", embeddingModel: null },
    ]);
    const { table: oe } = makeFakeOrgEventTable();
    const m = createGraphHealMigration(() => table, () => oe, () => VERSION);
    expect(await m.detect()).toBe(false);
  });

  it("true when the canary self-recalls at rank 1 (healthy, serving graph)", async () => {
    const { table } = makeFakeMemoryTable([
      { id: "m1", embedding: emb(1), embeddingModel: "real" },
      { id: "m2", embedding: emb(2), embeddingModel: "real" },
      { id: "m3", embedding: emb(3), embeddingModel: "real" },
    ]);
    const { table: oe } = makeFakeOrgEventTable();
    const m = createGraphHealMigration(() => table, () => oe, () => VERSION);
    expect(await m.detect()).toBe(true);
  });

  it("false (non-throwing) when the HNSW index is unavailable / mid-rebuild (cosine query throws)", async () => {
    const { table } = makeFakeMemoryTable(
      [{ id: "m1", embedding: emb(1), embeddingModel: "real" }],
      { throwOnSort: true },
    );
    const { table: oe } = makeFakeOrgEventTable();
    const m = createGraphHealMigration(() => table, () => oe, () => VERSION);
    // Must resolve to false, never reject.
    await expect(m.detect()).resolves.toBe(false);
  });
});

describe("graph-heal migration — run() (verify + structural-only ledger)", () => {
  it("writes ONE structural-only OrgEvent (verified, vector count, version — never a memory id/content) and reports zero rows processed", async () => {
    const { table } = makeFakeMemoryTable([
      { id: "m1", content: "secret-alpha", embedding: emb(1), embeddingModel: "real" },
      { id: "m2", content: "secret-beta", embedding: emb(2), embeddingModel: "real" },
      { id: "m3", content: "secret-gamma", embedding: emb(3), embeddingModel: "hash-512d" }, // hash-fallback, not a real vector
    ]);
    const { table: oe, puts } = makeFakeOrgEventTable();
    const m = createGraphHealMigration(() => table, () => oe, () => VERSION);

    const result = await m.run(50);
    expect(result.processed).toBe(0);
    expect(result.touchedIds).toEqual([]);

    expect(puts).toHaveLength(1);
    const evt = puts[0];
    expect(evt.kind).toBe("migration");
    expect(evt.refId).toBe(GRAPH_HEAL_ID);
    expect(evt.authorId).toBe("flair-migrations");
    const detail = JSON.parse(evt.detail);
    expect(detail.migrationId).toBe(GRAPH_HEAL_ID);
    expect(detail.verified).toBe(true);
    expect(detail.embeddedVectorCount).toBe(2); // m1 + m2 (m3 is hash-fallback)
    expect(detail.runningVersion).toBe(VERSION);

    // Structural-only discipline: no memory id or content leaks into the event.
    const blob = JSON.stringify(evt);
    expect(blob).not.toContain("secret-");
    expect(blob).not.toContain("m1");
    expect(blob).not.toContain("m2");
  });

  it("never throws even if the OrgEvent write fails — observability must not brick the runner", async () => {
    const { table } = makeFakeMemoryTable([
      { id: "m1", embedding: emb(1), embeddingModel: "real" },
    ]);
    const throwingOrgEvent = {
      async put() {
        throw new Error("OrgEvent table unavailable");
      },
    };
    const m = createGraphHealMigration(() => table, () => throwingOrgEvent, () => VERSION);
    const result = await m.run(50);
    expect(result.processed).toBe(0);
  });
});
