// instance-create-lock-bakery-1897.test.ts — the two VERIFIED schedules (Gauge)
// for the filesystem bakery lock (flair#1897 round 4).
//
// S-a: a contender that has taken its stamp/marker and is then PAUSED must never
//      hold concurrently with a contender that ran through and held. RED before
//      (the stamp+grace lock): both hold while both have read zero → two mints.
// S-b: a visible claim that cannot be PARSED is a live blocker — the contender
//      waits; it is never skipped. RED before: an unparsable claim was skipped,
//      so the contender held at once.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireInstanceCreateLock, instanceCreateLockDir } from "../../resources/instance-create-lock.js";

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

describe("filesystem bakery lock — the two schedules (flair#1897 round 4)", () => {
  it("S-a: a contender paused after CHOOSING never holds concurrently; exactly one row is minted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-bakery-sa-"));
    dirs.push(dir);
    const tableFile = join(dir, "table.jsonl");
    const eventsFile = join(dir, "events.jsonl");
    writeFileSync(tableFile, "");
    writeFileSync(eventsFile, "");
    const sab = new SharedArrayBuffer(4 * 4);
    const base = { modulePath: MODULE, tableFile, home: dir, eventsFile, sab, wantWorkers: 2, putDelayMs: 500, pauseChoosingMs: 150 };

    const [a, b] = await Promise.all([
      runWorker({ ...base, schedule: "normal" }),
      runWorker({ ...base, schedule: "pause-after-choosing" }),
    ]);

    const rows = readJsonl(tableFile);
    const events = readJsonl(eventsFile);
    const interval = (tid: number): [number, number] | null => {
      const h = events.find((e) => e.tid === tid && e.ev === "hold");
      const r = events.find((e) => e.tid === tid && e.ev === "release");
      return h && r ? [h.t, r.t] : null;
    };
    const ia = interval(a.tid);
    const ib = interval(b.tid);
    expect(ia).not.toBeNull();
    expect(ib).not.toBeNull();
    const overlap = ia![0] < ib![1] && ib![0] < ia![1];
    expect(overlap).toBe(false); // RED before: two concurrent holders
    expect(rows.length).toBe(1); // RED before: two mints
  }, 60_000);

  it("S-b: a visible claim that cannot be parsed is a live blocker (the contender waits), never skipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-bakery-sb-"));
    dirs.push(dir);
    const lockDir = instanceCreateLockDir(dir);
    mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    // A claim file that exists but is INCOMPLETE (as `writeFileSync` exposes it
    // before its bytes land): a live contender's marker, mid-write.
    writeFileSync(join(lockDir, "choosing-424242-0-deadbeef.json"), '{"pid":', "utf8");

    const out = await acquireInstanceCreateLock({ home: dir, deadlineMs: 300 });
    expect(out.ok).toBe(false); // RED before: skipped → held
    if (out.ok) throw new Error("unreachable");
    expect(out.detail).toContain("choosing-424242-0-deadbeef.json");
  }, 30_000);
});
