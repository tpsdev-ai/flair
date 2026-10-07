/**
 * embedding-stamp-contention-2307.test.ts — flair#2307, real Harper.
 *
 * The embedding-stamp migration re-embeds a stale Memory row whose id ends in
 * `.content` through the raw table handle (regenContentSuffixRow in
 * resources/migrations/embedding-stamp.ts): it re-reads the row, compares it
 * with the row it embedded, and writes the new vector in one owned
 * transaction. This case changes the row's content AFTER that transaction has
 * read it and BEFORE it writes: the spawned Harper carries the test-only pause
 * (resources/txn-pause-point.ts, enabled by FLAIR_ENABLE_TEST_FAULT_INJECTION
 * and FLAIR_TEST_PAUSE_DIR, set for this file's Harper only), the test arms it
 * before the row exists, waits until a migration cycle is paused inside that
 * transaction, commits a competing content change, then releases it.
 *
 * The competing content is kept, and the row stays pending: it keeps its stale
 * stamp and vector rather than being stamped current with the vector of the
 * text it no longer carries.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const POINT = "embedding-stamp-content-suffix";
const LEGACY_ID = "esc-legacy.content";
const STALE_MODEL = "some-ancient-model-v0";
const STALE_EMBEDDING = [0.1, 0.1, 0.1];
const ORIGINAL = "the original legacy text the migration read and embedded";
const EDITED = "a competing edit committed while the migration was paused";

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
/** The file's text once it exists (read, never stat-then-read); null on timeout. */
async function readWhenPresent(path: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return null;
}

beforeAll(async () => {
  pauseDir = mkdtempSync(join(tmpdir(), "flair-esc-pause-"));
  // Armed before the row exists, so whichever cycle first re-embeds it (the
  // boot pass or a follow-up recheck) pauses.
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
    // The spawned Harper has its copy; no later Harper in this process inherits it.
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  authHeader = "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");
  await opsCall({
    operation: "insert", database: "flair", table: "Memory",
    records: [{
      id: LEGACY_ID, agentId: "esc-agent", content: ORIGINAL,
      embedding: STALE_EMBEDDING, embeddingModel: STALE_MODEL, createdAt: new Date().toISOString(),
    }],
  });
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper).catch(() => {});
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
});

describe("flair#2307 — the `.content`-suffix re-embed under a change committed after its read (real Harper)", () => {
  it("the competing content is kept, and the row stays pending with its stale stamp", async () => {
    // A boot pass or the first follow-up recheck (30 s after it) reaches the row.
    const paused = await waitFor(join(pauseDir, `paused.${POINT}`), 150_000);
    expect(paused, "no migration cycle paused inside the re-embed transaction").toBe(true);
    try {
      await opsCall({
        operation: "update", database: "flair", table: "Memory", records: [{ id: LEGACY_ID, content: EDITED }],
      });
    } finally {
      writeFileSync(join(pauseDir, `go.${POINT}`), "");
    }
    expect(await readWhenPresent(join(pauseDir, `released.${POINT}`), 30_000), "the pause ended by timeout, not by this test").toBe("go");
    // The transaction writes (or does not) right after its release; the next
    // follow-up recheck is at least 30 s away.
    await new Promise((r) => setTimeout(r, 5_000));
    const row = await readRow(LEGACY_ID);
    console.log("row after the re-embed:", JSON.stringify({ content: row?.content, embeddingModel: row?.embeddingModel, dims: row?.embedding?.length }));
    expect(row?.content).toBe(EDITED); // assertion: the competing content is kept
    expect(row?.embeddingModel, "the row was stamped current with the vector of text it no longer carries").toBe(STALE_MODEL);
    expect(row?.embedding).toEqual(STALE_EMBEDDING);
  }, 200_000);
});
