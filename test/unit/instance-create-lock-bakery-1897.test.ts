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
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
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

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("filesystem bakery lock — the two schedules (flair#1897 round 4)", () => {
  it("S-a: a live CHOOSING marker blocks the sibling — it holds only AFTER that marker is gone; exactly one row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-bakery-sa-"));
    dirs.push(dir);
    const tableFile = join(dir, "table.jsonl");
    const eventsFile = join(dir, "events.jsonl");
    const resumeFile = join(dir, "resume-A");
    const lockDir = instanceCreateLockDir(dir);
    writeFileSync(tableFile, "");
    writeFileSync(eventsFile, "");
    const sab = new SharedArrayBuffer(4 * 4);
    // wantWorkers: 1 — A must be paused with its marker visible BEFORE B starts,
    // so the two are started in order rather than racing.
    const base = { modulePath: MODULE, tableFile, home: dir, eventsFile, sab, wantWorkers: 1, putDelayMs: 200, resumeFile };

    // A pauses at afterChoosing (its marker is visible, no ticket yet)…
    const pa = runWorker({ ...base, schedule: "pause-after-choosing" });
    await waitFor(() => {
      try {
        return readdirSync(lockDir).some((x) => x.startsWith("choosing-"));
      } catch {
        return false;
      }
    }, 10_000);
    // …then B runs CHOOSE → TICKET → WAIT; with a CORRECT lock B waits while A's
    // marker is live.
    const pb = runWorker({ ...base, schedule: "normal" });
    await waitFor(() => {
      try {
        return readdirSync(lockDir).some((x) => x.startsWith("ticket-"));
      } catch {
        return false;
      }
    }, 10_000);
    // NOBODY has held yet — B must not run through while A's marker is visible.
    expect(readJsonl(eventsFile).some((e) => e.ev === "hold")).toBe(false);

    await new Promise((r) => setTimeout(r, 200));
    const resumedAt = Date.now();
    writeFileSync(resumeFile, "go"); // release A

    const [a, b] = await Promise.all([pa, pb]);
    const rows = readJsonl(tableFile);
    const events = readJsonl(eventsFile);
    const bHold = events.find((e) => e.tid === b.tid && e.ev === "hold");
    const aHold = events.find((e) => e.tid === a.tid && e.ev === "hold");
    const bRelease = events.find((e) => e.tid === b.tid && e.ev === "release");
    expect(bHold).toBeDefined();
    expect(aHold).toBeDefined();
    // B held only AFTER A was released, and A only after B released → serialised.
    expect(bHold!.t).toBeGreaterThan(resumedAt);
    expect(aHold!.t).toBeGreaterThan(bRelease!.t);
    expect(rows.length).toBe(1);
  }, 60_000);

  it("S-b: a visible claim that cannot be parsed is a live blocker (the contender waits), never skipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-bakery-sb-"));
    dirs.push(dir);
    const lockDir = instanceCreateLockDir(dir);
    mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    // A claim file that exists but is INCOMPLETE (as `writeFileSync` exposes it
    // before its bytes land): a live contender's marker, mid-write.
    writeFileSync(join(lockDir, "choosing-" + String(process.pid) + "-0-deadbeef.json"), '{"pid":', "utf8");

    const out = await acquireInstanceCreateLock({ home: dir, deadlineMs: 300 });
    expect(out.ok).toBe(false); // RED before: skipped → held
    if (out.ok) throw new Error("unreachable");
    expect(out.detail).toContain("choosing-" + String(process.pid) + "-0-deadbeef.json");
    expect(readdirSync(lockDir)).toEqual(["choosing-" + String(process.pid) + "-0-deadbeef.json"]); // claim survives
  }, 30_000);
});

describe("bakery round 5 — body/filename, exits, and discriminating tests (flair#1897)", () => {
  it("item 1: a recognised claim whose BODY disagrees with its filename pid is a live blocker and SURVIVES", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-bakery-r5a-"));
    dirs.push(dir);
    const lockDir = instanceCreateLockDir(dir);
    const bad = `choosing-${process.pid}-0-deadbeef.json`; // filename pid = OUR live pid
    mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(lockDir, bad), JSON.stringify({ pid: -1 }), "utf8");
    const out = await acquireInstanceCreateLock({ home: dir, deadlineMs: 300 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.detail).toContain(bad);
    expect(existsSync(join(lockDir, bad))).toBe(true); // never unlinked by another contender
  }, 30_000);

  it("item 1: a ticket whose FILENAME pid is provably dead (ESRCH) is unlinked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-bakery-r5b-"));
    dirs.push(dir);
    const lockDir = instanceCreateLockDir(dir);
    const dead = "ticket-000000000001-999999-0-deadbeef.json";
    mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(lockDir, dead), JSON.stringify({ pid: 999999 }), "utf8");
    const out = await acquireInstanceCreateLock({ home: dir, deadlineMs: 500 });
    expect(out.ok).toBe(true);
    if (out.ok) out.release();
    expect(existsSync(join(lockDir, dead))).toBe(false);
  }, 30_000);

  it("item 2: a hook that THROWS leaves no claim file behind and the error propagates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-bakery-r5c-"));
    dirs.push(dir);
    const lockDir = instanceCreateLockDir(dir);
    await expect(
      acquireInstanceCreateLock({ home: dir, hooks: { afterChoosing: () => { throw new Error("boom-choose"); } } }),
    ).rejects.toThrow("boom-choose");
    expect(readdirSync(lockDir)).toEqual([]);
    await expect(
      acquireInstanceCreateLock({ home: dir, hooks: { afterTicket: () => { throw new Error("boom-ticket"); } } }),
    ).rejects.toThrow("boom-ticket");
    expect(readdirSync(lockDir)).toEqual([]);
  }, 30_000);

  it("item 2: a contender paused in CHOOSING past a short deadline refuses and removes its marker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-bakery-r5d-"));
    dirs.push(dir);
    const lockDir = instanceCreateLockDir(dir);
    const out = await acquireInstanceCreateLock({ home: dir, deadlineMs: 120, hooks: { afterChoosing: async () => { await new Promise((r) => setTimeout(r, 300)); } } });
    expect(out.ok).toBe(false); // RED before: the clock did not cover CHOOSING
    expect(readdirSync(lockDir)).toEqual([]);
  }, 30_000);
});
