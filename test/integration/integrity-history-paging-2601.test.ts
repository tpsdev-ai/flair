import { afterAll, beforeAll, expect, test } from "bun:test";
import { readExactCountSince } from "../../src/lib/ops-table-count.js";
import { buildOpsPost, readTableByIdPaged } from "../../src/memory-id-checkpoint.js";
import {
  startHarper, stopHarper, HARPER_START_BUDGET_MS, HARPER_STOP_BUDGET_MS, type HarperInstance,
} from "../helpers/harper-lifecycle";

let harper: HarperInstance;

beforeAll(async () => { harper = await startHarper(); }, HARPER_START_BUDGET_MS);
afterAll(async () => { if (harper) await stopHarper(harper); }, HARPER_STOP_BUDGET_MS);

test("bounded deletion-history keyset pages return the exact in-range ids and count on real Harper", async () => {
  const ops = buildOpsPost(harper.opsURL, harper.admin.username, harper.admin.password);
  const since = "2026-09-01T00:00:00.000Z";
  const older = "2026-08-31T23:59:59.999Z";
  const newer = "2026-09-01T00:00:01.000Z";
  const inRange = ["hist-a", "hist-b", "hist-e", "hist-g", "hist-h"];
  const records = [
    { id: "hist-0", at: older },
    { id: "hist-a", at: since },
    { id: "hist-b", at: newer },
    { id: "hist-d", at: older },
    { id: "hist-e", at: newer },
    { id: "hist-g", at: newer },
    { id: "hist-h", at: newer },
    { id: "hist-z", at: older },
  ].map(row => ({
    ...row, memoryId: `memory-${row.id}`, sourceClass: "internal",
    memoryInstanceToken: `token-${row.id}`, durability: "permanent", actor: null,
  }));
  const inserted = await ops({
    operation: "insert", database: "flair", table: "MemoryDeletionHistory", records,
  }) as { inserted_hashes: string[] };
  expect([...inserted.inserted_hashes].sort()).toEqual(records.map(row => row.id).sort());

  const expected = await readExactCountSince(ops, "MemoryDeletionHistory", "at", since);
  expect(expected).toBe(5);
  const pages: string[][] = [];
  const rows = await readTableByIdPaged(async body => {
    const page = await ops(body) as { id: string }[];
    pages.push(page.map(row => row.id));
    return page;
  }, {
    table: "MemoryDeletionHistory",
    select: "id, memoryId, memoryInstanceToken, durability, at",
    filter: `at >= '${since}'`,
    expected,
    pageSize: 2,
  });
  expect(pages).toEqual([["hist-a", "hist-b"], ["hist-e", "hist-g"], ["hist-h"]]);
  expect(rows.map(row => row.id)).toEqual(inRange);
  expect(rows).toHaveLength(5);
  expect(await readExactCountSince(ops, "MemoryDeletionHistory", "at", since)).toBe(5);

  const cappedQueries: string[] = [];
  const capped = await readTableByIdPaged(async body => {
    cappedQueries.push(String(body.sql));
    return ops(body);
  }, {
    table: "MemoryDeletionHistory", select: "id, memoryId, memoryInstanceToken, durability, at",
    filter: `at >= '${since}'`, expected, pageSize: expected, maxPages: 1,
  });
  expect(capped.map(row => row.id)).toEqual(inRange);
  expect(cappedQueries).toEqual([
    `SELECT id, memoryId, memoryInstanceToken, durability, at FROM flair.MemoryDeletionHistory WHERE (at >= '${since}') ORDER BY id LIMIT 5`,
    `SELECT id FROM flair.MemoryDeletionHistory WHERE (at >= '${since}') AND id > 'hist-h' ORDER BY id LIMIT 1`,
  ]);
}, 90_000);
