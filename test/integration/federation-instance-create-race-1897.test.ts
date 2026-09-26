// federation-instance-create-race-1897.test.ts — REAL Harper. The first-boot
// create in `GET /FederationInstance` must serialise in-process (flair#1897
// slice 1): three concurrent GETs on a cleared table mint exactly ONE identity
// row, and every caller is answered with it.
//
// RED before the change: without the lock, concurrent GETs each read "none" and
// mint their own row (two or three rows), and the bodies disagree. This drives
// the race ≥ 50 rounds with jittered start offsets, so a one-shot interleaving
// cannot hide it. HOME is temp-isolated by the harness and swept by stopHarper.

import { describe, test, beforeAll, afterAll, expect } from "bun:test";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

let harper: HarperInstance;
const ROUNDS = 50;

function auth(): string {
  return "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");
}

async function ops(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${harper.opsURL.replace(/\/$/, "")}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ops ${String(body.operation)} failed (${res.status}): ${await res.text()}`);
  return await res.json().catch(() => null);
}

async function instanceRows(): Promise<any[]> {
  const parsed = await ops({ operation: "sql", sql: "SELECT id, publicKey FROM flair.Instance" });
  const rows = Array.isArray(parsed) ? parsed : parsed?.results;
  if (!Array.isArray(rows)) throw new Error(`sql read returned no row array: ${JSON.stringify(parsed)}`);
  return rows;
}

async function clearInstanceRows(): Promise<void> {
  for (const row of await instanceRows()) {
    await ops({ operation: "delete", database: "flair", table: "Instance", hash_values: [row.id] });
  }
}

/** One concurrent GET, unawaited until Promise.all; a jittered start offset. */
async function getInstance(jitterMs: number): Promise<{ status: number; id?: string; publicKey?: string }> {
  await new Promise((r) => setTimeout(r, jitterMs));
  const res = await fetch(`${harper.httpURL.replace(/\/$/, "")}/FederationInstance`, {
    headers: { Authorization: auth() },
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* non-json */
  }
  return { status: res.status, id: body?.id, publicKey: body?.publicKey };
}

describe("GET /FederationInstance first-boot create is serialised (flair#1897 slice 1)", () => {
  beforeAll(async () => {
    harper = await startHarper();
  }, 240_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  test(`three concurrent first-boot GETs create exactly one row across ${ROUNDS} jittered rounds`, async () => {
    let failedRounds = 0;
    const failures: string[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      await clearInstanceRows();
      // Fire three GETs as unawaited fetches with jittered start offsets.
      const results = await Promise.all([
        getInstance(Math.random() * 3),
        getInstance(Math.random() * 3),
        getInstance(Math.random() * 3),
      ]);
      // Capture every body BEFORE asserting anything.
      const rows = await instanceRows();
      const statuses = results.map((r) => r.status);
      const badStatus = statuses.some((s) => s < 200 || s >= 300);
      const oneRow = rows.length === 1;
      const allAgree =
        oneRow && results.every((r) => r.id === rows[0].id && r.publicKey === rows[0].publicKey);
      if (badStatus || !oneRow || !allAgree) {
        failedRounds++;
        if (failures.length < 5) {
          failures.push(
            `round ${round}: statuses=${JSON.stringify(statuses)} rows=${rows.length} rowId=${rows[0]?.id} ids=${JSON.stringify(results.map((r) => r.id))}`,
          );
        }
      }
    }
    console.log(`race-1897: ${failedRounds}/${ROUNDS} rounds failed (pre-fix count is the post-fix 0).`);
    expect(failures.join("\n")).toBe("");
    expect(failedRounds).toBe(0);
  }, 240_000);
});
