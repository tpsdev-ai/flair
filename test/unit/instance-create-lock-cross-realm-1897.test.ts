// instance-create-lock-cross-realm-1897.test.ts — the cross-REALM witness for
// flair#1897 slice 1. Two worker_threads load the create-lock module IN THEIR OWN
// REALM (each worker is its own module registry, like a Harper HTTP worker
// loading dist/resources/*.js) and run the create against a fake Instance table
// shared through one JSONL file.
//
// Two cases:
//   CONTROL — a realm-local promise chain (inside the helper, never production)
//     with a POST-READ barrier: both workers read zero before either puts, so the
//     realm-local lock lets BOTH mint → TWO rows. It is kept as a permanent
//     control that proves the barrier can see a broken lock.
//   REAL — the filesystem bakery lock with the barrier BEFORE contention: one
//     row, both callers answered it, and exactly ONE worker's FIRST read saw zero
//     while the other's saw one (proof it was serialised).

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dirname, "..", "..");
const MODULE = join(ROOT, "resources", "instance-create-lock.ts");
const WORKER = join(ROOT, "test", "helpers", "instance-create-worker-1897.ts");

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function runWorker(workerData: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL(WORKER, import.meta.url), { workerData });
    w.on("message", (m) => {
      if (m?.kind === "done") { w.terminate(); resolve(m); }
    });
    w.once("error", reject);
  });
}

function readJsonl(path: string): any[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function makeRun(schedule: string) {
  const dir = mkdtempSync(join(tmpdir(), "flair-xrealm-"));
  dirs.push(dir);
  const tableFile = join(dir, "table.jsonl");
  const eventsFile = join(dir, "events.jsonl");
  writeFileSync(tableFile, "");
  writeFileSync(eventsFile, "");
  const sab = new SharedArrayBuffer(4 * 4);
  const data = { modulePath: MODULE, tableFile, home: dir, eventsFile, sab, wantWorkers: 2, putDelayMs: 20, schedule };
  return { dir, tableFile, eventsFile, data };
}

describe("cross-realm create lock (flair#1897)", () => {
  it("CONTROL: a realm-local chain with a post-read barrier mints TWO rows (the barrier sees a broken lock)", async () => {
    const { tableFile, data } = makeRun("realm-chain");
    await Promise.all([runWorker(data), runWorker(data)]);
    const rows = readJsonl(tableFile);
    expect(rows.length).toBe(2); // the realm-local lock is not a lock across realms
  }, 60_000);

  it("REAL: the filesystem bakery lock mints ONE row; exactly one worker's first read saw zero", async () => {
    const { tableFile, data } = makeRun("normal");
    const [a, b] = await Promise.all([runWorker(data), runWorker(data)]);
    const rows = readJsonl(tableFile);
    expect(rows.length).toBe(1);
    const idA = a?.outcome?.kind === "row" ? a.outcome.row.id : null;
    const idB = b?.outcome?.kind === "row" ? b.outcome.row.id : null;
    expect(idA).toBe(rows[0].id);
    expect(idB).toBe(rows[0].id);
    // Serialised: one worker read zero rows first (it minted), the other read one.
    expect([a.firstCount, b.firstCount].sort()).toEqual([0, 1]);
  }, 60_000);
});
