// instance-create-worker-1897.ts — a worker_threads entry for the cross-realm /
// schedule witnesses (flair#1897). It loads the create-lock module IN ITS OWN
// REALM and runs the create against a fake Instance table shared through a JSONL
// file. It is driven by a `schedule` name and synchronises with its sibling
// through a shared Int32Array and a filesystem ready-barrier.
//
// Shared Int32Array indices: [1] = the first worker to read has HELD;
//                            [2] = how many workers have finished their first read.
import { parentPort, workerData, threadId as _tid } from "node:worker_threads";
import { readFileSync, appendFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { modulePath, tableFile, home, wantWorkers, schedule, sab, eventsFile, putDelayMs } = workerData as {
  modulePath: string;
  tableFile: string;
  home: string;
  wantWorkers: number;
  schedule: "normal" | "pause-after-choosing" | "realm-chain";
  sab: SharedArrayBuffer;
  eventsFile: string;
  putDelayMs: number;
  pauseChoosingMs?: number;
};
const flags = new Int32Array(sab);
const pauseChoosingMs = (workerData as any).pauseChoosingMs ?? 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readRows(): any[] {
  try {
    return readFileSync(tableFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
function record(ev: string, extra: Record<string, unknown> = {}): void {
  appendFileSync(eventsFile, JSON.stringify({ tid: _tid, ev, t: Date.now(), ...extra }) + "\n");
}
function mintRow(n: number) {
  const now = new Date().toISOString();
  return { id: `flair_w${process.pid}_${n}`, publicKey: `pk${process.pid}_${n}`, role: "spoke", status: "active", createdAt: now, updatedAt: now };
}

async function readyBarrier(): Promise<void> {
  writeFileSync(join(home, `ready-${_tid}`), String(_tid));
  const deadline = Date.now() + 8000;
  while (readdirSync(home).filter((n) => n.startsWith("ready-")).length < wantWorkers) {
    if (Date.now() > deadline) throw new Error("worker ready-barrier timed out");
    await sleep(5);
  }
}

const mod: any = await import(pathToFileURL(modulePath).href);

if (schedule === "realm-chain") {
  // CONTROL only. A per-realm promise chain (never in production code) plus a
  // POST-READ barrier: both workers read zero before either puts, so a lock that
  // is only realm-local lets both mint. This MUST produce two rows.
  (globalThis as any).__flairChain = (globalThis as any).__flairChain || Promise.resolve();
  const realmChain = async (fn: () => Promise<void>): Promise<void> => {
    const prev = (globalThis as any).__flairChain;
    let release!: () => void;
    (globalThis as any).__flairChain = new Promise<void>((r) => (release = r));
    await prev;
    try {
      await fn();
    } finally {
      release();
    }
  };
  await readyBarrier();
  await realmChain(async () => {
    record("hold");
    const rows = readRows();
    if (rows.length === 0) {
      Atomics.add(flags, 2, 1);
      const deadline = Date.now() + 8000;
      while (Atomics.load(flags, 2) < wantWorkers) {
        if (Date.now() > deadline) throw new Error("post-read barrier timed out");
        await sleep(5);
      }
    }
    const row = mintRow(1);
    await sleep(putDelayMs);
    appendFileSync(tableFile, JSON.stringify(row) + "\n");
    record("release");
    parentPort?.postMessage({ kind: "done", outcome: { kind: "row", row }, tid: _tid });
  });
} else {
  await readyBarrier();
  let firstCount = -1;
  let seq = 0;
  const hooks =
    schedule === "pause-after-choosing"
      ? {
          afterChoosing: async () => {
            // A fixed scheduler pause (the schedule's point is "paused after it
            // chose"): with a CORRECT bakery the sibling sees this marker and
            // waits; with a lock that ignores live `choosing` markers the sibling
            // runs through and HOLDS, so both hold → RED.
            await sleep(pauseChoosingMs);
          },
        }
      : undefined;
  const outcome = await mod.findOrCreateInstance({
    home,
    hooks,
    readAll: async () => {
      const rows = readRows();
      if (firstCount === -1) {
        firstCount = rows.length;
        record("hold");
        record("firstread", { n: rows.length });
        Atomics.store(flags, 1, 1); // the first reader has HELD
      }
      return rows;
    },
    put: async (row: any) => {
      await sleep(putDelayMs);
      appendFileSync(tableFile, JSON.stringify(row) + "\n");
    },
    setSeed: () => {},
    seedPresent: () => true,
    mint: () => {
      const n = ++seq;
      return { id: `flair_w${process.pid}_${n}`, publicKey: `pk${process.pid}_${n}`, secretKey: new Uint8Array(32).fill(n % 255) };
    },
    log: () => {},
  });
  record("release");
  parentPort?.postMessage({ kind: "done", outcome, tid: _tid, firstCount });
}
