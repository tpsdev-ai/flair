// instance-create-lock-cross-realm-1897.test.ts — the cross-REALM witness for
// flair#1897 slice 1. Two worker_threads load the create-lock module IN THEIR OWN
// REALM (each worker is its own module registry, like a Harper HTTP worker
// loading dist/resources/*.js) and run findOrCreateInstance against a fake
// Instance table shared through one JSON file. An Atomics barrier makes BOTH
// workers read zero rows before either puts.
//
// RED before (a realm-local promise chain): each worker's chain is its own, both
// read [], both mint → TWO rows. GREEN after (the filesystem ticket lock): one
// row, both callers answered it.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dirname, "..", "..");
const MODULE = join(ROOT, "resources", "instance-create-lock.ts");
const WORKER = join(ROOT, "test", "helpers", "instance-create-worker-1897.ts");

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) {
    try { c(); } catch { /* best effort */ }
  }
});

function runWorker(workerData: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL(WORKER, import.meta.url), { workerData });
    w.on("message", (m) => {
      if (m?.kind === "done") {
        w.terminate();
        resolve(m);
      }
    });
    w.once("error", reject);
  });
}

describe("cross-realm create lock (flair#1897)", () => {
  it("two worker realms mint ONE row and both are answered it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-xrealm-"));
    const tableFile = join(dir, "table.json");
    writeFileSync(tableFile, "");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const data = { modulePath: MODULE, tableFile, home: dir, wantWorkers: 2 };
    const [a, b] = await Promise.all([runWorker(data), runWorker(data)]);

    const rows = readFileSync(tableFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(rows.length).toBe(1);
    const idA = a?.outcome?.kind === "row" ? a.outcome.row.id : null;
    const idB = b?.outcome?.kind === "row" ? b.outcome.row.id : null;
    expect(idA).toBe(rows[0].id);
    expect(idB).toBe(rows[0].id);
  }, 60_000);
});
