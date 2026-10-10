/**
 * integrity-retention-2229.test.ts — the watermark-bounded deletion-history
 * read and the opt-in retention command, on a REAL ephemeral Harper.
 *
 * (a) The scan reads history at or after the checkpoint watermark minus a
 *     margin: a record for a row deleted beneath Flair and dated just before the
 *     watermark is still read and attributes it, while one dated outside the
 *     margin is not read and its row stays an unexplained loss.
 * (b) `flair integrity prune-history` prunes only history older than the OLDEST
 *     named checkpoint watermark minus the margin, never a row the older
 *     checkpoint still needs, respects the per-run cap, and prunes nothing when a
 *     checkpoint is missing.
 * (c) Retention is opt-in: a dry run deletes nothing, and a plain scan deletes
 *     nothing by age.
 *
 * Throwaway HOME + data dir, ephemeral ports.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { ensureCliBuild } from "../helpers/build-cli-once.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const CLI = join(REPO_ROOT, "dist", "cli.js");
const MARGIN_MS = 5 * 60_000;
setDefaultTimeout(200_000);

let harper: HarperInstance;
let home: string;

const checkpointPath = () => join(home, ".flair", "integrity-checkpoint.json");
const adminAuth = () => "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");
const opsPort = () => new URL(harper.opsURL).port;

async function ops(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminAuth() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  expect(res.status, JSON.stringify(body)).toBe(200);
  return res.json();
}

async function insertMemory(id: string, durability: string): Promise<string> {
  const instanceToken = randomUUID();
  await ops({
    operation: "insert", database: "flair", table: "Memory",
    records: [{ id, agentId: "integrity-e2e", content: `row ${id}`, durability, instanceToken, createdAt: new Date().toISOString() }],
  });
  return instanceToken;
}

async function deleteMemoryBeneath(id: string): Promise<void> {
  // A raw operations-API delete leaves no deletion history.
  await ops({ operation: "delete", database: "flair", table: "Memory", hash_values: [id] });
}

async function insertHistory(id: string, memoryId: string, memoryInstanceToken: string, at: string): Promise<void> {
  await ops({
    operation: "insert", database: "flair", table: "MemoryDeletionHistory",
    records: [{ id, memoryId, memoryInstanceToken, durability: "permanent", actor: null, sourceClass: "internal", at }],
  });
}

async function historyIds(): Promise<string[]> {
  const rows = await ops({ operation: "search_by_value", database: "flair", table: "MemoryDeletionHistory", search_attribute: "id", search_value: "*", get_attributes: ["id"] });
  return (rows as any[]).map(r => r.id).sort();
}

interface Run { code: number | null; json: any; out: string }

function runCli(args: string[]): Run {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf-8",
    env: { ...process.env, HOME: home, FLAIR_ADMIN_PASS: harper.admin.password, FLAIR_ADMIN_USER: harper.admin.username },
    timeout: 90_000,
    killSignal: "SIGTERM",
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  let json: any = null;
  try { json = JSON.parse(out.trim().split("\n").pop() ?? ""); } catch { /* leave null */ }
  return { code: r.status, json, out };
}

const runCheck = () => runCli(["integrity", "check", "--json", "--ops-port", opsPort()]);
const runPrune = (extra: string[] = []) => runCli(["integrity", "prune-history", "--json", "--ops-port", opsPort(), ...extra]);

beforeAll(async () => {
  ensureCliBuild();
  home = mkdtempSync(join(tmpdir(), "flair-2229-home-"));
  harper = await startHarper();
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("flair#2229 — deletion-history bounded read and retention on a real Harper", () => {
  test("the deletion-history table declares replicate: true explicitly", async () => {
    const desc = await ops({ operation: "describe_table", database: "flair", table: "MemoryDeletionHistory" });
    expect(desc.replicate).toBe(true);
  });

  test("(a) the scan reads the window: a record just before the watermark is read, one outside it is not", async () => {
    const tokenX = await insertMemory("itg-x", "permanent");
    await insertMemory("itg-y", "permanent");
    expect(runCheck().json?.status).toBe("baseline");
    const watermark = JSON.parse(readFileSync(checkpointPath(), "utf8")).watermark as string;
    expect(typeof watermark).toBe("string");

    // Both rows removed beneath Flair: no history of their own.
    await deleteMemoryBeneath("itg-x");
    await deleteMemoryBeneath("itg-y");
    const w = Date.parse(watermark);
    // Just before the watermark (within the margin) — must be read.
    await insertHistory("hist-x", "itg-x", tokenX, new Date(w - 10_000).toISOString());
    // Outside the margin — must NOT be read.
    await insertHistory("hist-y", "itg-y", randomUUID(), new Date(w - MARGIN_MS - 10_000).toISOString());

    const r = runCheck();
    expect(r.code, r.out).toBe(2);
    expect(r.json?.status).toBe("alert");
    const attributed = (r.json?.attributedDeletes ?? []).map((d: any) => d.id);
    const lost = (r.json?.losses ?? []).map((l: any) => l.id);
    expect(attributed).toContain("itg-x"); // read because it is within the margin
    expect(lost).toContain("itg-y");        // not read because it is outside the margin
    expect(lost).not.toContain("itg-x");
  }, 150_000);

  test("(b) retention uses the OLDEST checkpoint watermark, respects the cap, and never prunes a needed row", async () => {
    rmSync(checkpointPath(), { force: true });
    const w1 = "2026-09-01T00:00:00.000Z";
    const w2 = "2026-09-03T00:00:00.000Z"; // newest — a max-watermark bug would use this
    const cutoff = new Date(Date.parse(w1) - MARGIN_MS).toISOString();
    const cpA = join(home, "cp-oldest.json");
    const cpB = join(home, "cp-newest.json");
    writeFileSync(cpA, JSON.stringify({ version: 2, scannedAt: w1, watermark: w1, byDurability: { permanent: 1, persistent: 0, standard: 0, ephemeral: 0 }, ids: { "needed-row": "permanent" }, instanceTokens: { "needed-row": "tok" }, historyIds: [] }));
    writeFileSync(cpB, JSON.stringify({ version: 2, scannedAt: w2, watermark: w2, byDurability: { permanent: 0, persistent: 0, standard: 0, ephemeral: 0 }, ids: {}, instanceTokens: {}, historyIds: [] }));

    // A row cpA still needs (its id is present with a matching token): older than
    // the NEWEST watermark minus the margin, so a max-watermark bug would prune it.
    await insertHistory("h-needed", "needed-row", "tok", new Date(Date.parse(w1) + 60_000).toISOString());
    // Rows older than the oldest watermark minus the margin: eligible.
    await insertHistory("h-old-1", "gone-1", "t", new Date(Date.parse(w1) - MARGIN_MS - 120_000).toISOString());
    await insertHistory("h-old-2", "gone-2", "t", new Date(Date.parse(w1) - MARGIN_MS - 60_000).toISOString());
    // Newer than the cutoff: kept.
    await insertHistory("h-kept", "gone-3", "t", new Date(Date.parse(w1) - MARGIN_MS + 60_000).toISOString());

    const before = await historyIds();

    // Dry run: plans exactly the two old rows, deletes nothing.
    const dry = runPrune(["--checkpoint", cpA, "--checkpoint", cpB]);
    expect(dry.code, dry.out).toBe(0);
    expect(dry.json?.status).toBe("planned");
    expect(dry.json?.cutoff).toBe(cutoff);
    expect(dry.json?.planned).toBe(2);
    expect(dry.json?.pruned).toBe(0);
    expect(await historyIds()).toEqual(before);

    // Apply with a cap of one: one row deleted, more remain, the needed row kept.
    const capped = runPrune(["--checkpoint", cpA, "--checkpoint", cpB, "--apply", "--max", "1"]);
    expect(capped.code, capped.out).toBe(0);
    expect(capped.json?.status).toBe("pruned");
    expect(capped.json?.pruned).toBe(1);
    expect(capped.json?.more).toBe(true);
    const afterCap = await historyIds();
    expect(afterCap).toContain("h-needed");
    expect(afterCap).not.toContain("h-old-1");

    // Apply again with no cap: the second old row goes; the needed row stays.
    const rest = runPrune(["--checkpoint", cpA, "--checkpoint", cpB, "--apply"]);
    expect(rest.json?.pruned).toBe(1);
    expect(rest.json?.more).toBe(false);
    const after = await historyIds();
    expect(after).toContain("h-needed");
    expect(after).toContain("h-kept");
    expect(after).not.toContain("h-old-2");
  }, 150_000);

  test("(b) a missing checkpoint prunes nothing", async () => {
    const before = await historyIds();
    const missing = join(home, "absent-checkpoint.json");
    const r = runPrune(["--checkpoint", missing, "--apply"]);
    expect(r.code, r.out).toBe(3);
    expect(r.json?.status).toBe("refused");
    expect(r.json?.reason).toContain("no checkpoint");
    expect(await historyIds()).toEqual(before);
  }, 150_000);

  test("(c) retention is opt-in: a dry run deletes nothing", async () => {
    // A fresh scan establishes a checkpoint with a watermark (the scan path is
    // unchanged — see the check's own unit tests).
    expect(runCheck().json?.status).toBe("baseline");
    // An eligible row: older than the watermark minus the margin.
    await insertHistory("h-ancient", "gone-ancient", "t", "2020-01-01T00:00:00.000Z");
    const before = await historyIds();
    // Without --apply, the retention command reports and deletes nothing.
    const dry = runPrune(["--checkpoint", checkpointPath()]);
    expect(dry.code, dry.out).toBe(0);
    expect(dry.json?.status).toBe("planned");
    expect(dry.json?.planned).toBe(1);
    expect(dry.json?.pruned).toBe(0);
    expect(await historyIds()).toEqual(before);
  }, 150_000);
});
