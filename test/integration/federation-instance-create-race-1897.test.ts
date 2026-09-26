// federation-instance-create-race-1897.test.ts — REAL Harper. The first-boot
// create in `GET /FederationInstance` must serialise (flair#1897 slice 1): three
// concurrent GETs on a cleared table mint exactly ONE identity row, and every
// caller is answered with it.
//
// Two thread counts: the default 1 (the harness pins THREADS_COUNT=1), and a
// `threads: 2` case that is the cross-WORKER tripwire — the lock is a filesystem
// ticket precisely because `globalThis` is per worker. Darwin forces one worker
// (Harper configValidator), so the 2-thread case skips there.
//
// It is the TRIPWIRE, not the proof: the deterministic cross-realm proof is
// test/unit/instance-create-lock-cross-realm-1897.test.ts.

import { describe, test, beforeAll, afterAll, expect } from "bun:test";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const ROUNDS = 50;

function auth(h: HarperInstance): string {
  return "Basic " + Buffer.from(`${h.admin.username}:${h.admin.password}`).toString("base64");
}

async function ops(h: HarperInstance, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${h.opsURL.replace(/\/$/, "")}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth(h) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ops ${String(body.operation)} failed (${res.status}): ${await res.text()}`);
  return await res.json().catch(() => null);
}

async function instanceRows(h: HarperInstance): Promise<any[]> {
  const parsed = await ops(h, { operation: "sql", sql: "SELECT id, publicKey FROM flair.Instance" });
  const rows = Array.isArray(parsed) ? parsed : parsed?.results;
  if (!Array.isArray(rows)) throw new Error(`sql read returned no row array: ${JSON.stringify(parsed)}`);
  return rows;
}

async function clearInstanceRows(h: HarperInstance): Promise<void> {
  for (const row of await instanceRows(h)) {
    await ops(h, { operation: "delete", database: "flair", table: "Instance", hash_values: [row.id] });
  }
}

async function getInstance(h: HarperInstance, jitterMs: number): Promise<{ status: number; id?: string; publicKey?: string }> {
  await new Promise((r) => setTimeout(r, jitterMs));
  const res = await fetch(`${h.httpURL.replace(/\/$/, "")}/FederationInstance`, { headers: { Authorization: auth(h) } });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* non-json */
  }
  return { status: res.status, id: body?.id, publicKey: body?.publicKey };
}

/** Fire three concurrent first-boot GETs across ROUNDS jittered rounds. */
async function runRounds(h: HarperInstance, label: string): Promise<number> {
  let failedRounds = 0;
  const failures: string[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    await clearInstanceRows(h);
    const results = await Promise.all([
      getInstance(h, Math.random() * 3),
      getInstance(h, Math.random() * 3),
      getInstance(h, Math.random() * 3),
    ]);
    const rows = await instanceRows(h);
    const badStatus = results.some((r) => r.status < 200 || r.status >= 300);
    const oneRow = rows.length === 1;
    const allAgree = oneRow && results.every((r) => r.id === rows[0].id && r.publicKey === rows[0].publicKey);
    if (badStatus || !oneRow || !allAgree) {
      failedRounds++;
      if (failures.length < 3) failures.push(`round ${round}: rows=${rows.length} ids=${JSON.stringify(results.map((r) => r.id))}`);
    }
  }
  console.log(`race-1897[${label}]: ${failedRounds}/${ROUNDS} rounds failed.`);
  expect(failures.join("\n")).toBe("");
  return failedRounds;
}

describe("GET /FederationInstance first-boot create is serialised (flair#1897 slice 1)", () => {
  let harper: HarperInstance;
  beforeAll(async () => {
    harper = await startHarper();
  }, 240_000);
  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  test(`three concurrent first-boot GETs create exactly one row across ${ROUNDS} jittered rounds (1 thread)`, async () => {
    expect(await runRounds(harper, "1-thread")).toBe(0);
  }, 240_000);
});

describe("GET /FederationInstance create across TWO workers (flair#1897 slice 1)", () => {
  let harper: HarperInstance;
  beforeAll(async () => {
    harper = await startHarper({ threads: 2 });
  }, 240_000);
  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  // Harper forces one worker on darwin; the two-worker case cannot exist there.
  test.skipIf(process.platform === "darwin")(`three concurrent first-boot GETs create exactly one row across ${ROUNDS} jittered rounds (2 threads)`, async () => {
    expect(await runRounds(harper, "2-thread")).toBe(0);
  }, 240_000);
});
