// A PATCH that stores an embedding stamp trips the embedding-space latch
// (flair#2425).
//
// Memory.patch() routes past put(), so before this fix an ordinary
// PATCH /Memory/<id> whose body carried `embedding`/`embeddingModel` stored
// them WITHOUT calling the write-maintained latch (noteWriteStamp) that
// Memory.post()/put() call. A row could then carry a model stamp the latch
// never recorded, so a later recall would cosine it as if it were the current
// space (garbage across vector spaces). The fix routes the PATCH write through
// the same latch as POST/PUT.
//
// This is a real-Harper test: it drives the real HTTP PATCH through the real
// Memory resource and observes the latch the way an outside caller can —
// SemanticSearch reports the mixed-space degrade in its `_warning` when the
// store is no longer uniform in the CURRENT space
// (resources/SemanticSearch.ts). Rows are seeded through the administrator ops
// API and the semantic leg is forced with a caller-supplied `queryEmbedding`,
// so the test needs no embedding model.
//
// Mutation check (fails-on-unfixed): remove the noteWriteStamp call from
// resources/Memory.ts patch() and the "trips the latch" assertion goes red.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const AGENT = "latch-agent";
const ROW = "latch-row-1";
// A stamp in a DIFFERENT vector space from the default current gguf model.
const FOREIGN = "other-engine:not-the-current-space";

let harper: HarperInstance;
let basic: string;

/** Refuse to talk to anything but this test's own ephemeral instance: loopback,
 *  the OS-assigned ports it was started on, never a production port, and a data
 *  directory under the temp dir. */
function assertOwnInstance(h: HarperInstance): void {
  const http = new URL(h.httpURL);
  const ops = new URL(h.opsURL);
  const httpPort = Number(http.port);
  const opsPort = Number(ops.port);
  for (const [label, u, port] of [["http", http, httpPort], ["ops", ops, opsPort]] as const) {
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${label} target ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (httpPort === opsPort || !h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} / ${h.opsURL} is not an instance this test started`);
  }
}

async function adminOp(op: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic },
    body: JSON.stringify(op),
  });
  const text = await res.text();
  expect(res.status, `${op.operation} returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
  return JSON.parse(text);
}

async function patch(body: Record<string, unknown>): Promise<{ status: number; text: string }> {
  const path = `/Memory/${ROW}`;
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: basic },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: (await res.text()).slice(0, 300) };
}

/** The mixed-space degrade the guard reports, or undefined when the store is
 *  uniform in the current space. */
async function semanticWarning(): Promise<string | undefined> {
  const path = "/SemanticSearch";
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic },
    body: JSON.stringify({ agentId: AGENT, q: "any keyword", queryEmbedding: [1, 0, 0, 0] }),
  });
  const text = await res.text();
  expect(res.status, `SemanticSearch → ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text)._warning;
}

async function rowEmbeddingModel(): Promise<string | null> {
  const rows = await adminOp({
    operation: "search_by_id", database: "flair", table: "Memory", ids: [ROW], get_attributes: ["embeddingModel"],
  });
  return Array.isArray(rows) && rows.length > 0 ? (rows[0].embeddingModel ?? null) : null;
}

describe("a PATCH that stores an embedding stamp trips the embedding-space latch (flair#2425, real Harper)", () => {
  beforeAll(async () => {
    harper = await startHarper();
    assertOwnInstance(harper);
    basic = "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);
    const now = new Date().toISOString();
    await adminOp({
      operation: "insert", database: "flair", table: "Memory", records: [
        { id: ROW, agentId: AGENT, content: "seeded row", visibility: "shared", createdAt: now, updatedAt: now },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    if (harper) {
      const { rm } = await import("node:fs/promises");
      const installDir = harper.installDir;
      await stopHarper(harper);
      await rm(installDir, { recursive: true, force: true, maxRetries: 4 }).catch(() => {});
    }
  }, 30_000);

  test("a PATCH with no embedding fields is unchanged; a PATCH that stores an embedding stamp trips the latch", async () => {
    // Baseline: the store is uniform in the current space — no mixed-space degrade.
    expect(await semanticWarning()).toBeUndefined();

    // A PATCH whose body carries no embedding field is unchanged: the latch stays open.
    const plain = await patch({ content: "patched without an embedding" });
    expect(plain.status, plain.text).toBeLessThan(300);
    expect(await semanticWarning()).toBeUndefined();

    // A PATCH that stores an embedding stamp: the row carries it, and the latch
    // records it (the store is no longer uniform).
    const stamped = await patch({ embedding: [0, 1, 0, 0], embeddingModel: FOREIGN });
    expect(stamped.status, stamped.text).toBeLessThan(300);
    expect(await rowEmbeddingModel()).toBe(FOREIGN);

    expect(String(await semanticWarning())).toContain("mixed embedding spaces");
  }, 60_000);
});
