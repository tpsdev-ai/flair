/**
 * flair#2032 — boot warm, mid-build queries, and status transitions.
 *
 * Harper is mocked. The build counts ids, then admits documents, and pauses
 * once (test seam) so a query can arrive while the same buildPromise is in
 * flight. A legacy corpus scan is a select that carries `summary` — the
 * retrieval core's DEFAULT_SELECT. The index build never asks for `summary`.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { threadId } from "node:worker_threads";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";

type ScanKind = "id-count" | "index" | "legacy" | "embedding" | "other";

let memoryStore: Map<string, Record<string, unknown>>;
let scans: ScanKind[];
let searchThrows: Error | null = null;
let subscribeMode: "infinite" | "error" = "infinite";

function classify(query: any): ScanKind {
  if (query?.sort?.attribute === "embedding") return "embedding";
  const select: string[] = Array.isArray(query?.select) ? query.select : [];
  if (select.length === 1 && select[0] === "id") return "id-count";
  if (select.includes("summary")) return "legacy";
  if (select.includes("content")) return "index";
  return "other";
}

function project(record: Record<string, unknown>, select?: string[]): Record<string, unknown> {
  if (!select) return { ...record };
  const out: Record<string, unknown> = {};
  for (const k of select) if (k in record) out[k] = record[k];
  return out;
}

function memorySearch(query: any) {
  if (searchThrows) throw searchThrows;
  scans.push(classify(query));
  const select: string[] | undefined = Array.isArray(query?.select) ? query.select : undefined;
  async function* gen() {
    const records = [...memoryStore.values()].sort((a, b) => String(a.id) < String(b.id) ? -1 : 1);
    for (const r of records) yield project(r, select);
  }
  return gen();
}

mock.module("harper", () => ({
  databases: {
    flair: {
      Memory: {
        search: (q: any) => memorySearch(q),
        get: async (id: string) => memoryStore.get(id) ?? null,
        subscribe: async () => {
          if (subscribeMode === "error") {
            return {
              async *[Symbol.asyncIterator]() {
                throw new Error("socket closed");
              },
            };
          }
          return {
            async *[Symbol.asyncIterator]() {
              for (;;) await new Promise(() => {});
            },
          };
        },
      },
    },
  },
  Resource: class {},
}));

const svc = await import("../../resources/bm25-index-service.ts");
const { retrieveCandidates } = await import("../../resources/semantic-retrieval-core.ts");

function seed(n: number): void {
  memoryStore = new Map();
  for (let i = 0; i < n; i++) {
    const id = `m${String(i).padStart(3, "0")}`;
    memoryStore.set(id, {
      id,
      content: i === 0 ? "uniquezebra lives here" : `note ${i} about apples`,
      agentId: "agent-a",
      visibility: "shared",
      archived: false,
      createdAt: "2026-06-01T00:00:00.000Z",
    });
  }
}

async function poll(pred: () => boolean, label: string, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) {
      throw new Error(`timed out waiting for ${label}; status=${JSON.stringify(svc.bm25IndexStatus())}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("flair#2032 — BM25 boot warm and build status", () => {
  beforeEach(() => {
    seed(0);
    scans = [];
    searchThrows = null;
    subscribeMode = "infinite";
    delete process.env.FLAIR_BM25_INDEX;
    delete process.env.THREADS_COUNT;
    svc.__resetBm25IndexForTests();
  });

  afterEach(() => {
    svc.__setBm25BuildPauseForTests?.(null);
    svc.__resetBm25IndexForTests();
    delete process.env.FLAIR_BM25_INDEX;
    delete process.env.THREADS_COUNT;
  });

  it("after startup with N memories and no query, status reaches ready with N docs", async () => {
    seed(4);
    expect(typeof svc.scheduleBm25BootWarm).toBe("function");
    svc.scheduleBm25BootWarm();
    await poll(() => svc.bm25IndexStatus().state === "ready", "ready");
    const status = svc.bm25IndexStatus();
    expect(status.state).toBe("ready");
    expect(status.size).toBe(4);
    expect(status.built).toBe(4);
    expect(status.total).toBe(4);
    expect(status.summary).toMatch(/^ready · 4 docs · built in /);
    expect(scans.filter((k) => k === "legacy")).toEqual([]);
    expect(scans.filter((k) => k === "id-count")).toHaveLength(1);
    expect(scans.filter((k) => k === "index")).toHaveLength(1);
  });

  it("a query issued mid-build awaits the index build and does not scan", async () => {
    seed(5);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    svc.__setBm25BuildPauseForTests(async () => { await gate; });
    svc.scheduleBm25BootWarm();
    await poll(() => {
      const s = svc.bm25IndexStatus();
      return s.state === "building" && s.built === 1 && s.total === 5;
    }, "mid-build");
    const mid = svc.bm25IndexStatus();
    expect(mid.built).toBeGreaterThanOrEqual(0);
    expect(mid.built).toBeLessThanOrEqual(mid.total);
    expect(mid.summary).toMatch(/^building 1\/5 docs \(20%\) · started /);

    let settled = false;
    const pending = retrieveCandidates({
      q: "uniquezebra",
      queryEmbedding: null,
      conditions: [],
      limit: 10,
      mode: "bm25-only",
      scoring: "raw",
      minScore: 0,
    } as any).then((rows) => {
      settled = true;
      return rows;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    expect(scans.filter((k) => k === "legacy")).toEqual([]);

    release();
    const rows = await pending;
    expect(settled).toBe(true);
    expect(rows.map((r: any) => r.id)).toEqual(["m000"]);
    expect(scans.filter((k) => k === "legacy")).toEqual([]);
    expect(scans.filter((k) => k === "id-count")).toHaveLength(1);
    expect(scans.filter((k) => k === "index")).toHaveLength(1);
    expect(svc.bm25IndexStatus().state).toBe("ready");
  });

  it("status during a build reports a count between 0 and total", async () => {
    seed(8);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    svc.__setBm25BuildPauseForTests(async () => { await gate; });
    svc.scheduleBm25BootWarm();
    await poll(() => svc.bm25IndexStatus().state === "building" && svc.bm25IndexStatus().total === 8, "counted");
    const status = svc.bm25IndexStatus();
    expect(status.built).toBeGreaterThanOrEqual(0);
    expect(status.built).toBeLessThanOrEqual(status.total);
    expect(status.total).toBe(8);
    expect(status.summary).toMatch(/^building \d+\/8 docs \(\d+%\) · started /);
    release();
    await poll(() => svc.bm25IndexStatus().state === "ready", "ready after release");
  });

  it("disabled shows its reason", async () => {
    seed(2);
    subscribeMode = "error";
    await svc.indexedBm25Ids({ q: "uniquezebra", conditions: [], limit: 10 });
    await poll(() => svc.bm25IndexStatus().state === "disabled", "disabled");
    const status = svc.bm25IndexStatus();
    expect(status.state).toBe("disabled");
    expect(status.reason).toContain("socket closed");
    expect(status.summary).toBe(`disabled — ${status.reason}`);
    expect(status.summary.startsWith("building")).toBe(false);
  });

  it("a build failure is reported as disabled with its reason, not left building", async () => {
    seed(3);
    searchThrows = new Error("disk gone");
    await svc.indexedBm25Ids({ q: "uniquezebra", conditions: [], limit: 10 });
    const status = svc.bm25IndexStatus();
    expect(status.state).not.toBe("building");
    expect(status.state).toBe("disabled");
    expect(status.reason).toContain("disk gone");
    expect(status.summary).toMatch(/^disabled — /);
    expect(status.summary).toContain("disk gone");
    await new Promise((r) => setTimeout(r, 40));
    expect(svc.bm25IndexStatus().state).toBe("disabled");
    expect(svc.bm25IndexStatus().summary).toContain("disk gone");
  });

  it("empty, before the warm starts, says what clears it", () => {
    const status = svc.bm25IndexStatus();
    expect(status.state).toBe("empty");
    expect(status.summary).toMatch(/not built yet/);
    expect(status.summary).toMatch(/text search/);
    expect(status.summary).not.toMatch(/cold boot/i);
  });

  it("status names this worker when THREADS_COUNT is greater than 1", () => {
    process.env.THREADS_COUNT = "4";
    const status = svc.bm25IndexStatus();
    expect(status.scope).toBe("this-worker");
    expect(status.workerThreadId).toBe(threadId);
    expect(status.threadsCount).toBe(4);
    expect(status.summary).toContain(`worker ${threadId} of 4`);
  });

  it("the kill switch is disabled with a reason", () => {
    process.env.FLAIR_BM25_INDEX = "0";
    const status = svc.bm25IndexStatus();
    expect(status.state).toBe("disabled");
    expect(status.summary).toBe("disabled — FLAIR_BM25_INDEX is off");
  });
});
