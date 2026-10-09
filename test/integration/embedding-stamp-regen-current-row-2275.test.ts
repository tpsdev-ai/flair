/**
 * embedding-stamp-regen-current-row-2275.test.ts — flair#2275, real Harper.
 *
 * The embedding-stamp migration reads a stale Memory row, then re-embeds it
 * through a loopback request to Memory (resources/migrations/embedding-stamp.ts).
 * This case commits a competing content edit after the migration has read the
 * row and before that request runs: the spawned Harper carries the test-only
 * `embedding-stamp-regen-pre` pause (resources/txn-pause-point.ts, enabled by
 * FLAIR_ENABLE_TEST_FAULT_INJECTION and FLAIR_TEST_PAUSE_DIR, set for this
 * file's Harper only). The test arms it before the row exists, waits until a
 * migration cycle is paused there, commits the edit, then releases it.
 *
 * The competing edit is kept, and the row is still re-embedded.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const POINT = "embedding-stamp-regen-pre";
const ROW_ID = `esr-${randomUUID()}`;
const STALE_MODEL = "some-ancient-model-v0";
const STALE_EMBEDDING = [0.1, 0.1, 0.1];
const ORIGINAL = "the original text the migration read before it re-embedded the row";
const EDITED = "a competing edit committed after the migration read the row";

let harper: HarperInstance;
let pauseDir: string;
let authHeader: string;

function assertOwnInstance(instance: HarperInstance): void {
  const http = new URL(instance.httpURL);
  const ops = new URL(instance.opsURL);
  for (const u of [http, ops]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !instance.process?.pid || !instance.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${instance.httpURL} / ${instance.opsURL} is not an instance this test started`);
  }
}

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
  pauseDir = mkdtempSync(join(tmpdir(), "flair-esr-2275-pause-"));
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
  assertOwnInstance(harper);
  authHeader = "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");
  await opsCall({
    operation: "insert", database: "flair", table: "Memory",
    records: [{
      id: ROW_ID, agentId: "agent-a", content: ORIGINAL, visibility: "shared", durability: "persistent",
      embedding: STALE_EMBEDDING, embeddingModel: STALE_MODEL, createdAt: new Date().toISOString(),
    }],
  });
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper).catch(() => {});
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
});

describe("flair#2275 — the embedding-stamp re-embed under a change committed after its read (real Harper)", () => {
  it("a content edit committed after the migration read the row is kept, and the row is re-embedded", async () => {
    // A boot pass or the first follow-up recheck (30 s after it) reaches the row.
    const paused = await waitFor(join(pauseDir, `paused.${POINT}`), 150_000);
    expect(paused, "no migration cycle paused before the re-embed request").toBe(true);
    try {
      await opsCall({
        operation: "update", database: "flair", table: "Memory", records: [{ id: ROW_ID, content: EDITED }],
      });
    } finally {
      writeFileSync(join(pauseDir, `go.${POINT}`), "");
    }
    expect(await readWhenPresent(join(pauseDir, `released.${POINT}`), 30_000), "the pause ended by timeout, not by this test").toBe("go");
    // The re-embed request runs right after the release; wait for its stamp.
    let row: any = null;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      row = await readRow(ROW_ID);
      if (row?.embeddingModel !== STALE_MODEL) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    console.log("row after the re-embed:", JSON.stringify({ content: row?.content, embeddingModel: row?.embeddingModel, dims: row?.embedding?.length }));
    expect(row?.content).toBe(EDITED); // assertion: the competing edit is kept
    expect(typeof row?.embeddingModel === "string" && row.embeddingModel.length > 0 && row.embeddingModel !== STALE_MODEL,
      `the row was not re-embedded: ${JSON.stringify(row?.embeddingModel)}`).toBe(true);
  }, 200_000);
});
