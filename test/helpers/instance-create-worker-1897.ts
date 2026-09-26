// instance-create-worker-1897.ts — a worker_threads entry for the cross-realm
// witness (flair#1897). It loads the create-lock module IN ITS OWN REALM and
// runs findOrCreateInstance against a fake Instance table shared through a JSON
// file, aligned with the sibling worker by an Atomics START barrier.
import { parentPort, workerData } from "node:worker_threads";
import { readFileSync, appendFileSync, writeFileSync as _wfs, readdirSync } from "node:fs";
import { join } from "node:path";
import { threadId as _tid } from "node:worker_threads";
import { pathToFileURL } from "node:url";

const { modulePath, tableFile, home, wantWorkers } = workerData as {
  modulePath: string;
  tableFile: string;
  home: string;
  wantWorkers: number;
};

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

const mod: any = await import(pathToFileURL(modulePath).href);

// FILESYSTEM ready-barrier (reliable across realms; a SharedArrayBuffer is not
// shared across bun workers): each worker drops ready-<threadId>, then waits for
// ALL expected workers before ANY create runs — so a realm-local chain has both
// read zero rows before either puts.
_wfs(join(home, `ready-${_tid}`), String(_tid));
const readyDeadline = Date.now() + 5000;
while (readdirSync(home).filter((n) => n.startsWith("ready-")).length < wantWorkers) {
  if (Date.now() > readyDeadline) throw new Error("worker barrier timed out");
  await new Promise((r) => setTimeout(r, 5));
}

let seq = 0;
const outcome = await mod.findOrCreateInstance({
  home,
  readAll: async () => readRows(),
  put: async (row: any) => {
    await new Promise((r) => setTimeout(r, 20)); // widen the window
    appendFileSync(tableFile, JSON.stringify(row) + "\n"); // append-only: two mints = two lines
  },
  setSeed: () => {},
  seedPresent: () => true,
  mint: () => {
    const n = ++seq;
    return { id: `flair_w${process.pid}_${n}`, publicKey: `pk${n}`, secretKey: new Uint8Array(32).fill(n % 255) };
  },
  log: () => {},
});

parentPort?.postMessage({ kind: "done", outcome, tid: _tid });
