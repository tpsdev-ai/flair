// migrations-secure-file-reader-2840.ts — a worker_threads READER for the
// atomic-write witness (flair#2840 round 4b). It reads one file in a tight
// loop IN ITS OWN REALM, next to the writer, and reports what it saw: how many
// reads it made, how many threw, how many failed to parse, how many were neither
// of the two expected payloads, and up to five samples across them. The parent
// stops it by creating `stopFile` (a filesystem flag, not a message: the loop
// is synchronous, so the worker's own event loop cannot deliver a message while
// it spins).
//
// The loop is bounded twice — wall-clock deadline AND read count — so a parent
// that never writes `stopFile` still ends it.
import { parentPort, workerData } from "node:worker_threads";
import { existsSync, readFileSync } from "node:fs";

const { file, stopFile, expected, deadlineMs } = workerData as {
  file: string;
  stopFile: string;
  expected: string[];
  deadlineMs: number;
};

const MAX_READS = 1_000_000;
const deadline = Date.now() + deadlineMs;

let reads = 0;
let readErrors = 0;
let parseErrors = 0;
let unexpected = 0;
const samples: string[] = [];

while (!existsSync(stopFile) && reads < MAX_READS && Date.now() < deadline) {
  const n = reads++;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    readErrors++;
    if (samples.length < 5) samples.push(`read ${n}: read failed: ${(err as Error).message}`);
    continue;
  }
  try {
    JSON.parse(raw);
  } catch (err) {
    parseErrors++;
    if (samples.length < 5) samples.push(`read ${n}: ${(err as Error).message} (${raw.length} bytes)`);
  }
  if (!expected.includes(raw)) {
    unexpected++;
    if (samples.length < 5) samples.push(`read ${n}: unexpected content (${raw.length} bytes)`);
  }
}

parentPort?.postMessage({ kind: "done", reads, readErrors, parseErrors, unexpected, samples });
