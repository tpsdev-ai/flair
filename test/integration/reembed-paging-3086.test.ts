/**
 * reembed-paging-3086.test.ts — `flair reembed`'s Memory reads against a real
 * ephemeral Harper (flair#3086).
 *
 * The admin paths read every Memory page before the first write, keyed on the
 * primary key (`id` greater than the last id seen, sorted by `id`). These cases
 * use a page size of 3, seed rows across agents, insert a row between two page
 * reads, and re-embed a stale row that sits beyond the first page through the
 * same per-row path the command uses.
 *
 * Throwaway HOME + data dir, ephemeral ports; every key file is written under
 * that HOME. No administrator password or Authorization header is printed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { getModelId } from "../../resources/embeddings-provider.ts";
import { stripEnginePrefix } from "../../resources/embedding-space-guard.ts";
import {
  opsStoredModelReader,
  readAllMemoryRows,
  reembedRow,
  type MemoryReadCondition,
} from "../../src/commands/reembed.ts";

const CURRENT_MODEL_ID = getModelId();
const BARE_MODEL_ID = stripEnginePrefix(CURRENT_MODEL_ID);

type Agent = { id: string; publicKey: Uint8Array; secretKey: Uint8Array };
const newAgent = (id: string): Agent => ({ id, ...nacl.sign.keyPair() });
const agentA = newAgent("paging-agent-a");
const agentB = newAgent("paging-agent-b");
const agentC = newAgent("paging-agent-c");
const agentD = newAgent("paging-agent-d");

let harper: HarperInstance;
let home: string;

const adminAuth = () =>
  "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");

async function op(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminAuth() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}

/** An ops insert over an explicit fetch, for the between-pages case. */
async function insertVia(fetchImpl: typeof fetch, records: Record<string, unknown>[]): Promise<void> {
  const res = await fetchImpl(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminAuth() },
    body: JSON.stringify({ operation: "insert", database: "flair", table: "Memory", records }),
    signal: AbortSignal.timeout(20_000),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

const read = async (id: string) =>
  (await op({ operation: "search_by_id", database: "flair", table: "Memory", ids: [id], get_attributes: ["*"] }))[0];

function fixtureRow(id: string, agentId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    agentId,
    content: `Release checklist ${id}: verify the tarball checksum before tagging.`,
    contentHash: `${id}-hash`,
    visibility: "private",
    durability: "persistent",
    createdAt: "2021-03-01T00:00:00.000Z",
    updatedAt: "2021-03-02T00:00:00.000Z",
    embeddingModel: BARE_MODEL_ID,
    ...overrides,
  };
}

const ids = (rows: Record<string, unknown>[]) => rows.map((row) => String(row.id)).sort();

/** A "select this test's rows" condition on the indexed contentHash prefix. */
const prefix = (value: string): MemoryReadCondition => ({
  search_attribute: "contentHash",
  search_type: "starts_with",
  search_value: value,
});

const opsPort = () => new URL(harper.opsURL).port;

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  home = mkdtempSync(join(tmpdir(), "flair-3086-home-"));
  const keysDir = join(home, ".flair", "keys");
  mkdirSync(keysDir, { recursive: true });
  for (const agent of [agentA, agentB, agentC, agentD]) {
    writeFileSync(join(keysDir, `${agent.id}.key`), agent.secretKey.slice(0, 32), { mode: 0o600 });
  }
  harper = await startHarper();
  // Every request in this file goes to the ephemeral instance this test started.
  for (const url of [new URL(harper.httpURL), new URL(harper.opsURL)]) {
    expect(url.hostname).toBe("127.0.0.1");
    expect(["9925", "9926"]).not.toContain(url.port);
  }
  const now = new Date().toISOString();
  await op({
    operation: "upsert",
    database: "flair",
    table: "Agent",
    records: [agentA, agentB, agentC, agentD].map((a) => ({
      id: a.id, name: a.id, role: "agent", publicKey: Buffer.from(a.publicKey).toString("base64"), createdAt: now,
    })),
  });
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (home) rmSync(home, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

const keyPath = (agent: Agent) => join(home, ".flair", "keys", `${agent.id}.key`);

describe("flair#3086: flair reembed reads every Memory page", () => {
  test("a page size of 3 returns every id exactly once on both admin conditions", async () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => fixtureRow(`p1-a-${i + 1}`, agentA.id)),
      ...Array.from({ length: 3 }, (_, i) => fixtureRow(`p1-b-${i + 1}`, agentB.id)),
    ];
    await op({ operation: "insert", database: "flair", table: "Memory", records: rows });

    const all = await readAllMemoryRows({
      opsPort: opsPort(),
      opsAuth: adminAuth(),
      conditions: [prefix("p1-")],
      pageSize: 3,
    });
    expect(all.pages).toBe(3);
    expect(ids(all.rows)).toEqual(rows.map((row) => String(row.id)).sort());
    expect(new Set(ids(all.rows)).size).toBe(rows.length);

    const one = await readAllMemoryRows({
      opsPort: opsPort(),
      opsAuth: adminAuth(),
      conditions: [prefix("p1-"), { search_attribute: "agentId", search_type: "equals", search_value: agentA.id }],
      pageSize: 3,
    });
    expect(one.pages).toBe(2);
    expect(ids(one.rows)).toEqual(rows.filter((row) => row.agentId === agentA.id).map((row) => String(row.id)).sort());
  }, 120_000);

  test("a row inserted between page reads is neither skipped nor repeated", async () => {
    const seeded = Array.from({ length: 7 }, (_, i) => fixtureRow(`p2-c-${i + 1}`, agentC.id));
    await op({ operation: "insert", database: "flair", table: "Memory", records: seeded });
    const inserted = fixtureRow(`p2-c-35`, agentC.id);

    const realFetch = globalThis.fetch;
    let insertedOnce = false;
    globalThis.fetch = (async (url: unknown, init: unknown) => {
      const res = await realFetch(url as Parameters<typeof fetch>[0], init as Parameters<typeof fetch>[1]);
      const body = JSON.parse(String((init as { body?: unknown } | null)?.body ?? "{}"));
      if (!insertedOnce && body.operation === "search_by_conditions") {
        insertedOnce = true;
        await insertVia(realFetch, [inserted]);
      }
      return res;
    }) as typeof fetch;
    let pageRead: Awaited<ReturnType<typeof readAllMemoryRows>>;
    try {
      pageRead = await readAllMemoryRows({
        opsPort: opsPort(),
        opsAuth: adminAuth(),
        conditions: [prefix("p2-"), { search_attribute: "agentId", search_type: "equals", search_value: agentC.id }],
        pageSize: 3,
      });
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(insertedOnce).toBe(true);
    expect(pageRead.pages).toBe(3);
    expect(new Set(ids(pageRead.rows)).size).toBe(pageRead.rows.length);
    expect(ids(pageRead.rows)).toEqual([...seeded, inserted].map((row) => String(row.id)).sort());
  }, 120_000);

  test("a stale row beyond the first page is re-embedded through the command's row path", async () => {
    const stale = Array.from({ length: 6 }, (_, i) => fixtureRow(`p3-d-${i + 1}`, agentD.id, { embeddingModel: "old-model" }));
    const current = Array.from({ length: 2 }, (_, i) => fixtureRow(`p3-d-${i + 7}`, agentD.id));
    await op({ operation: "insert", database: "flair", table: "Memory", records: [...stale, ...current] });

    const pageRead = await readAllMemoryRows({
      opsPort: opsPort(),
      opsAuth: adminAuth(),
      conditions: [prefix("p3-"), { search_attribute: "agentId", search_type: "equals", search_value: agentD.id }],
      pageSize: 3,
    });
    expect(pageRead.pages).toBe(3);

    const candidates = pageRead.rows.filter((row) => {
      const stamp = row.embeddingModel;
      return stamp !== CURRENT_MODEL_ID && stamp !== BARE_MODEL_ID;
    });
    expect(ids(candidates)).toEqual(stale.map((row) => String(row.id)).sort());
    // p3-d-6 is the last stale row, on page 2, past the first page of 3.
    expect(ids(candidates)).toContain("p3-d-6");

    const readStoredModel = opsStoredModelReader(opsPort(), adminAuth());
    expect(await reembedRow(harper.httpURL, agentD.id, keyPath(agentD), "p3-d-6", CURRENT_MODEL_ID, readStoredModel)).toBe(true);
    const after = await read("p3-d-6");
    expect(after.embeddingModel).toBe(CURRENT_MODEL_ID);
    expect((await read("p3-d-7")).embeddingModel).toBe(BARE_MODEL_ID);
  }, 180_000);
});
