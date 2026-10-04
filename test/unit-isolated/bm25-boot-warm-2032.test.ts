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
let subscribeMode: "infinite" | "error" | "queue" = "infinite";
/** Resolved to let the first index scan's generator return after its last row. */
let holdFirstIndexTail: Promise<void> | null = null;
let indexScansSeen = 0;
let feedPush: ((ev: Record<string, unknown>) => void) | null = null;

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
  const kind = classify(query);
  scans.push(kind);
  const select: string[] | undefined = Array.isArray(query?.select) ? query.select : undefined;
  // Park only the first admitting scan after its last row, inside the
  // consumer's final for-await next(). That is the window where an aborted
  // build resumes and used to clear a replacement build's buffer.
  const tail = kind === "index" && indexScansSeen++ === 0 ? holdFirstIndexTail : null;
  async function* gen() {
    const records = [...memoryStore.values()].sort((a, b) => String(a.id) < String(b.id) ? -1 : 1);
    for (const r of records) yield project(r, select);
    if (tail) await tail;
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
          if (subscribeMode === "queue") {
            const queue: Record<string, unknown>[] = [];
            let wake: (() => void) | null = null;
            feedPush = (ev) => {
              queue.push(ev);
              const w = wake;
              wake = null;
              w?.();
            };
            return {
              async *[Symbol.asyncIterator]() {
                for (;;) {
                  while (queue.length === 0) await new Promise<void>((r) => { wake = r; });
                  yield queue.shift();
                }
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
    holdFirstIndexTail = null;
    indexScansSeen = 0;
    feedPush = null;
    delete process.env.FLAIR_BM25_INDEX;
    delete process.env.THREADS_COUNT;
    delete process.env.FLAIR_RETRIEVAL_MODE;
    svc.__resetBm25IndexForTests();
  });

  afterEach(() => {
    svc.__setBm25BuildPauseForTests?.(null);
    svc.__resetBm25IndexForTests();
    delete process.env.FLAIR_BM25_INDEX;
    delete process.env.THREADS_COUNT;
    delete process.env.FLAIR_RETRIEVAL_MODE;
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

  it("an aborted build does not clear a replacement build's event buffer", async () => {
    seed(3);
    subscribeMode = "queue";
    let releaseScan!: () => void;
    holdFirstIndexTail = new Promise<void>((r) => { releaseScan = r; });

    const buildA = svc.indexedBm25Ids({ q: "uniquezebra", conditions: [], limit: 10 });
    await poll(() => {
      const s = svc.bm25IndexStatus();
      return s.state === "building" && s.built === 3 && s.total === 3;
    }, "build A admitted");

    svc.markBm25IndexStale("unhandled feed event type reload");
    expect(svc.bm25IndexStatus().state).toBe("empty");

    let releaseB!: () => void;
    svc.__setBm25BuildPauseForTests(async () => { await new Promise<void>((r) => { releaseB = r; }); });
    let settledB = false;
    const buildB = svc.indexedBm25Ids({ q: "apples", conditions: [], limit: 10 }).then((ids) => {
      settledB = true;
      return ids;
    });
    await poll(() => {
      const s = svc.bm25IndexStatus();
      return s.state === "building" && s.built === 1 && s.total === 3;
    }, "build B paused");

    const early = {
      id: "m998",
      content: "earlyzebra lives here",
      agentId: "agent-a",
      visibility: "shared",
      archived: false,
      createdAt: "2026-06-01T00:00:00.000Z",
    };
    svc.noteMemoryUpsert(early);

    releaseScan();
    expect(await buildA).toBeNull();

    expect(feedPush).toBeTypeOf("function");
    feedPush!({
      type: "put",
      value: {
        id: "m999",
        content: "heldzebra lives here",
        agentId: "agent-a",
        visibility: "shared",
        archived: false,
        createdAt: "2026-06-01T00:00:00.000Z",
      },
    });
    await new Promise((r) => setImmediate(r));

    const mid = svc.bm25IndexStatus();
    expect(mid.state).toBe("building");
    expect(mid.state).not.toBe("disabled");
    expect(settledB).toBe(false);

    releaseB();
    await buildB;
    expect(svc.bm25IndexStatus().state).toBe("ready");
    const earlyIds = await svc.indexedBm25Ids({ q: "earlyzebra", conditions: [], limit: 10 });
    const heldIds = await svc.indexedBm25Ids({ q: "heldzebra", conditions: [], limit: 10 });
    expect(earlyIds).toContain("m998");
    expect(heldIds).toContain("m999");
  });

  it("the kill switch is disabled with a reason", () => {
    process.env.FLAIR_BM25_INDEX = "0";
    const status = svc.bm25IndexStatus();
    expect(status.state).toBe("disabled");
    expect(status.summary).toBe("disabled — FLAIR_BM25_INDEX is off");
  });

  it("vector-only retrieval does not warm an index nothing reads", async () => {
    seed(4);
    process.env.FLAIR_RETRIEVAL_MODE = "vector-only";
    svc.scheduleBm25BootWarm();
    await new Promise((r) => setTimeout(r, 60));
    expect(scans).toEqual([]);
    const status = svc.bm25IndexStatus();
    expect(status.state).toBe("disabled");
    expect(status.size).toBe(0);
    expect(status.summary).toBe("disabled — retrieval mode is vector-only; the index is not used");
    expect(status.summary).not.toMatch(/text search/);
  });

  it("the kill switch does not warm the index", async () => {
    seed(4);
    process.env.FLAIR_BM25_INDEX = "false";
    svc.scheduleBm25BootWarm();
    await new Promise((r) => setTimeout(r, 60));
    expect(scans).toEqual([]);
    expect(svc.bm25IndexStatus().size).toBe(0);
  });

  it("bm25-only retrieval still warms the index", async () => {
    seed(4);
    process.env.FLAIR_RETRIEVAL_MODE = "bm25-only";
    svc.scheduleBm25BootWarm();
    await poll(() => svc.bm25IndexStatus().state === "ready", "ready");
    expect(svc.bm25IndexStatus().size).toBe(4);
  });
});
