/**
 * memory-purge-unconfirmed-2290.test.ts — POST /MemoryPurge when Harper skips
 * a queued delete at commit.
 *
 * Runs against a composed copy of the built component whose pointer-table
 * adapter (test/helpers/host-pointer-failing-component.ts,
 * CONCURRENT_WRITE_ADAPTER_SRC) commits a newer write of the Memory row in a
 * separate transaction before deleting the pointer row. The purge's queued
 * delete of that row then loses at commit, so the row is still stored
 * afterwards. The call must fail by name, keep no deletion-history record for
 * the row, and must not list it as removed.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import {
  componentWithFailingHostPointer,
  ADAPTER_REL,
  CONCURRENT_WRITE_ADAPTER_SRC,
  type FailingComponent,
} from "../helpers/host-pointer-failing-component";

let harper: HarperInstance;
let component: FailingComponent;

const adminBasic = () => `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}`;

async function adminOp(op: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminBasic() },
    body: JSON.stringify(op),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  expect(res.status, `${op.operation}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}

const rows = (table: string, attribute: string, value: string) =>
  adminOp({ operation: "search_by_value", database: "flair", table, search_attribute: attribute, search_value: value, get_attributes: ["*"] });

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  component = componentWithFailingHostPointer({ adapterSrc: CONCURRENT_WRITE_ADAPTER_SRC });
  harper = await startHarper({ cwd: component.dir });
  for (const url of [harper.httpURL, harper.opsURL]) {
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(new URL(url).port);
  }
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (component) component.cleanup();
});

describe("POST /MemoryPurge confirms removal against the committed store", () => {
  it("a delete that loses to a newer write fails the call by name, keeps no history record, and is not listed as removed", async () => {
    expect(readFileSync(join(component.dir, ADAPTER_REL), "utf8")).toBe(CONCURRENT_WRITE_ADAPTER_SRC); // the composed copy carries the test adapter
    const id = `purge-unconfirmed-${Date.now()}`;
    await adminOp({
      operation: "insert", database: "flair", table: "Memory",
      records: [{ id, agentId: "agent-a", content: "original", durability: "permanent", createdAt: new Date().toISOString(), archived: false, instanceToken: randomUUID() }],
    });

    const res = await fetch(`${harper.httpURL}/MemoryPurge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: adminBasic() },
      body: JSON.stringify({ ids: [id] }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBe(409);
    expect(JSON.parse(text)).toMatchObject({ error: "memory_purge_unconfirmed", ids: [id], removedIds: [] });

    const stored = await rows("Memory", "id", id);
    expect(stored.map((r: any) => r.content)).toEqual(["rewritten by a separate transaction"]); // the newer write won
    expect(await rows("MemoryDeletionHistory", "memoryId", id)).toEqual([]);
  }, 60_000);
});
