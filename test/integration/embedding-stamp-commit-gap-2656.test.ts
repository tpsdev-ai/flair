/**
 * embedding-stamp-commit-gap-2656.test.ts — real Harper.
 *
 * The embedding-stamp migration's `.content`-suffix re-embed writes only the
 * embedding fields in an owned transaction, confirms the committed row before
 * the commit, and (flair#2656) verifies after the commit that a fresh committed
 * read shows those staged fields. This case holds the re-embed after that final
 * confirmation and before its commit while a newer content write commits, so
 * the commit can resolve with the re-embed's effect discarded: the row must not
 * be counted as processed. A later cycle re-reads the newer row and converges.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { getModelId } from "../../resources/embeddings-provider.ts";
import { computeContentHash } from "../../resources/memory-feed-lib.ts";

const POINT = "embedding-stamp-content-suffix-commit";
const LEGACY_ID = "esc-gap-legacy.content";
const STALE_MODEL = "some-ancient-model-v0";
const STALE_EMBEDDING = [0.1, 0.1, 0.1];
const ORIGINAL = "the legacy text the migration read and embedded";
const EDITED = "a competing edit committed in the confirmation-to-commit gap";
const CURRENT_MODEL_ID = getModelId();

let harper: HarperInstance;
let pauseDir: string;
let authHeader: string;

async function opsCall(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ops call failed: HTTP ${res.status} — ${await res.text()}`);
  return res.json();
}
async function readRow(id: string): Promise<any> {
  const rows = await opsCall({
    operation: "search_by_hash", database: "flair", table: "Memory", hash_values: [id], get_attributes: ["*"],
  });
  return Array.isArray(rows) ? rows[0] ?? null : rows;
}
async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}
/** Non-empty release text; null on timeout. */
async function readWhenPresent(path: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = readFileSync(path, "utf8");
      if (text) return text;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

beforeAll(async () => {
  pauseDir = mkdtempSync(join(tmpdir(), "flair-esc-gap-pause-"));
  writeFileSync(join(pauseDir, `arm.${POINT}`), "");
  const saved = {
    FLAIR_ENABLE_TEST_FAULT_INJECTION: process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION,
    FLAIR_TEST_PAUSE_DIR: process.env.FLAIR_TEST_PAUSE_DIR,
  };
  process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
  process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
  try {
    harper = await startHarper();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  authHeader = "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");
  await opsCall({
    operation: "insert", database: "flair", table: "Memory",
    records: [{
      id: LEGACY_ID, agentId: "esc-gap-agent", content: ORIGINAL,
      embedding: STALE_EMBEDDING, embeddingModel: STALE_MODEL, createdAt: new Date().toISOString(),
    }],
  });
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper).catch(() => {});
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#2656 — the `.content`-suffix re-embed under a write committed in its commit gap (real Harper)", () => {
  it("the re-embed is retried after the gap, and the stored vector is bound to the newer text", async () => {
    const paused = await waitFor(join(pauseDir, `paused.${POINT}`), 150_000);
    expect(paused, "no migration cycle paused at the re-embed's commit gap").toBe(true);
    try {
      await opsCall({
        operation: "update", database: "flair", table: "Memory", records: [{ id: LEGACY_ID, content: EDITED }],
      });
    } finally {
      writeFileSync(join(pauseDir, `go.${POINT}`), "");
    }
    expect(await readWhenPresent(join(pauseDir, `released.${POINT}`), 30_000), "the pause ended by timeout, not by this test").toBe("go");

    // The first attempt's commit dropped or superseded its write; the retry
    // re-reads the newer text and must land the vector for it before the next
    // migration cycle (at least 30 s away).
    const deadline = Date.now() + 10_000;
    let row = await readRow(LEGACY_ID);
    while (Date.now() < deadline) {
      if (row?.embeddingModel === CURRENT_MODEL_ID && row?.embeddedContentHash === computeContentHash("esc-gap-agent", EDITED)) break;
      await new Promise((r) => setTimeout(r, 250));
      row = await readRow(LEGACY_ID);
    }
    expect(row?.content, "the retried re-embed changed the text").toBe(EDITED);
    expect(row?.embeddingModel, "the retried re-embed did not stamp the current model").toBe(CURRENT_MODEL_ID);
    expect(row?.embeddedContentHash, "the stored vector is not bound to the newer text").toBe(computeContentHash("esc-gap-agent", EDITED));
    expect(Array.isArray(row?.embedding) && row.embedding.length > 3, "the retried re-embed stored no usable vector").toBe(true);
  }, 260_000);
});
