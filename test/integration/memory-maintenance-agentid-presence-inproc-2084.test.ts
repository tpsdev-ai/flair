// MemoryMaintenance agentId presence on a direct in-process call, on a real
// Harper (flair#2084).
//
// An admin run is fleet-wide only when the request body has no `agentId` field.
// A JSON body cannot carry an `undefined` value, so the HTTP tests in
// memory-maintenance-owner-scope-2084.test.ts never send one; a Harper
// application that calls the resource directly can. This file drives that call
// through the in-process fixture (test/fixtures/inproc-app, op
// `maintainAsAdmin`: `collectionResource(MemoryMaintenance, adminContext(id))`),
// whose body has `agentId` as an own property whose value is `undefined`. That
// call must be refused with 400 naming the field, with every seeded Memory and
// pointer row unchanged on a fresh read; a body with no `agentId` key must still
// run fleet-wide and remove what the seed made removable.
//
// Real Harper, ephemeral instance; every URL is asserted to be this test's own
// instance before the first call.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { cp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModelId } from "../../resources/embeddings-provider.ts";
import { startHarper, stopHarper, HARPER_STOP_BUDGET_MS, type HarperInstance } from "../helpers/harper-lifecycle";

const SFX = Date.now().toString(36);
const PAST = "2000-01-01T00:00:00.000Z";
const POINTER = { v: 1, host: "host-a", kind: "run", id: "run-aaaaaaaa" };
const ADMIN_ID = `mm-presence-admin-${SFX}`;
const OWNER_ID = `mm-presence-owner-${SFX}`;

let harper: HarperInstance;
let appDir = "";

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    if (u.hostname !== "127.0.0.1" || u.port === "9925" || u.port === "9926" || !(Number(u.port) > 0)) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (!h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} is not an instance this test started`);
  }
}

const basicAuth = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

async function ops(op: Record<string, unknown>): Promise<string> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify(op),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  expect(res.status, `${op.operation}: ${text.slice(0, 300)}`).toBe(200);
  return text;
}

async function insertRows(table: string, records: unknown[]): Promise<void> {
  await ops({ operation: "insert", database: "flair", table, records });
}

/** Every stored attribute of the rows with this key, read through the operations
 *  API (outside any maintenance transaction) and serialised as read back. */
async function readRows(table: string, attribute: string, value: string): Promise<string> {
  const text = await ops({
    operation: "search_by_value",
    database: "flair",
    table,
    search_attribute: attribute,
    search_type: "equals",
    search_value: value,
    get_attributes: ["*"],
  });
  return JSON.stringify(JSON.parse(text));
}
const readPointer = (memoryId: string) => readRows("MemoryHostSource", "memoryId", memoryId);
const readMemory = (id: string) => readRows("Memory", "id", id);

function memoryRow(id: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id, agentId: OWNER_ID, content: `${id} body`, contentHash: id, visibility: "shared",
    durability: "permanent", createdAt: PAST, archived: false, instanceToken: randomUUID(),
    // Seeded with a current-model embedding stamp, so the background re-embed
    // has nothing to do and every row stays as seeded unless maintenance acts.
    embedding: [0.1, 0.1, 0.1], embeddingModel: getModelId(),
    ...extra,
  };
}

function pointerRow(memoryId: string, memoryInstanceToken: string): Record<string, unknown> {
  return {
    memoryId,
    hostSource: JSON.stringify(POINTER),
    scopeAtWrite: null,
    authorId: OWNER_ID,
    memoryInstanceToken,
    receivedAt: new Date().toISOString(),
  };
}

/** What one seeded id must look like after a fleet-wide run, which count it
 *  adds to, and its rows as read back right after seeding. */
type Fate = "removed" | "archived" | "kept" | "none";
interface Seeded {
  id: string;
  memory: Fate;
  pointer: Fate;
  counts: "expired" | "archived" | "orphans" | null;
  seededRows: string;
}

/** Every row this file seeded, in seeding order. */
const allSeeded: Seeded[] = [];

const rowsOf = async (id: string) => JSON.stringify({ memory: await readMemory(id), pointer: await readPointer(id) });

/** Seed one row of every kind a fleet-wide run acts on, plus a live control:
 *  an expired ephemeral memory (deleted with its pointer), a memory whose
 *  validity ended (archived, its pointer removed), an orphan pointer whose
 *  Memory row is missing and one whose Memory row is archived (both removed),
 *  and a live memory with its pointer (kept). */
async function seed(tag: string): Promise<Seeded[]> {
  const seeded: Seeded[] = [];
  const add = async (id: string, row: Record<string, unknown> | null, s: Omit<Seeded, "id" | "seededRows">) => {
    const token = row ? (row.instanceToken as string) : randomUUID();
    if (row) await insertRows("Memory", [row]);
    await insertRows("MemoryHostSource", [pointerRow(id, token)]);
    expect(JSON.parse(await readPointer(id)).length, `${id} pointer was seeded`).toBe(1);
    expect(JSON.parse(await readMemory(id)).length, `${id} Memory row was seeded as specified`).toBe(row ? 1 : 0);
    seeded.push({ id, ...s, seededRows: await rowsOf(id) });
  };
  const id = (kind: string) => `mm-presence-${tag}-${kind}-${SFX}`;
  await add(id("expired"), memoryRow(id("expired"), { durability: "ephemeral", expiresAt: PAST }), { memory: "removed", pointer: "removed", counts: "expired" });
  await add(id("ended"), memoryRow(id("ended"), { validTo: PAST }), { memory: "archived", pointer: "removed", counts: "archived" });
  await add(id("missing"), null, { memory: "none", pointer: "removed", counts: "orphans" });
  await add(id("archived"), memoryRow(id("archived"), { archived: true }), { memory: "kept", pointer: "removed", counts: "orphans" });
  await add(id("live"), memoryRow(id("live"), {}), { memory: "kept", pointer: "kept", counts: null });
  allSeeded.push(...seeded);
  return seeded;
}

interface InProcessReply {
  sent: { ownKeys: string[]; undefinedKeys: string[] };
  reply: { ok: true; value: any } | { ok: false; status?: number; body?: string; error?: string };
}

/** One admin maintenance run, called in-process through the fixture. */
async function maintainInProcess(body: Record<string, unknown>, undefinedKeys: string[]): Promise<InProcessReply> {
  const res = await fetch(`${harper.httpURL}/AgentFleet/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify({ op: "maintainAsAdmin", agentId: ADMIN_ID, body, undefinedKeys }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(200);
  const outer = JSON.parse(text);
  expect(outer.ok, text.slice(0, 300)).toBe(true); // control: the fixture op itself ran
  return outer.value as InProcessReply;
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  appDir = mkdtempSync(join(tmpdir(), "flair-2084-presence-app-"));
  await cp(join(process.cwd(), "test/fixtures/inproc-app"), appDir, { recursive: true });
  await mkdir(join(appDir, "node_modules/@tpsdev-ai"), { recursive: true });
  await symlink(process.cwd(), join(appDir, "node_modules/@tpsdev-ai/flair"), "dir");
  harper = await startHarper({ cwd: appDir, harperBinDir: process.cwd() });
  assertOwnInstance(harper);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (appDir) rmSync(appDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("MemoryMaintenance agentId presence on a direct in-process admin call (real Harper)", () => {
  it("an admin call whose body has agentId present with the value undefined is refused and changes nothing", async () => {
    const seeded = await seed("undef");

    const { sent, reply } = await maintainInProcess({}, ["agentId"]);
    expect(sent).toEqual({ ownKeys: ["agentId"], undefinedKeys: ["agentId"] }); // control: agentId was an own property holding undefined
    expect(reply.ok, JSON.stringify(reply)).toBe(false);
    if (reply.ok) return;
    expect(reply.status, JSON.stringify(reply)).toBe(400); // assertion: a supplied undefined is refused, not read as absent
    expect(JSON.parse(reply.body ?? "null")).toEqual({ error: "agentId must be a non-blank string" }); // assertion: the refusal names the field

    for (const s of seeded) {
      expect(await rowsOf(s.id), `${s.id} Memory or pointer row changed`).toBe(s.seededRows); // assertion: no Memory or pointer row changed (fresh reads)
    }
  }, 90_000);

  it("an admin call whose body has no agentId key runs fleet-wide", async () => {
    const own = await seed("absent");
    // Every seeded id still as seeded is in this run's scope: this test's own
    // rows, and the earlier test's rows when its refused call left them in place.
    const inPlay: Seeded[] = [];
    for (const s of allSeeded) if ((await rowsOf(s.id)) === s.seededRows) inPlay.push(s);
    expect(own.every((s) => inPlay.includes(s)), "this test's rows are stored as seeded").toBe(true);
    const expected = { expired: 0, archived: 0, orphans: 0 };
    for (const s of inPlay) if (s.counts) expected[s.counts]++;

    const { sent, reply } = await maintainInProcess({}, []);
    expect(sent).toEqual({ ownKeys: [], undefinedKeys: [] }); // control: the body has no agentId key
    expect(reply.ok, JSON.stringify(reply)).toBe(true);
    if (!reply.ok) return;
    const result = reply.value;
    expect(result.stats?.agent, JSON.stringify(result)).toBe("all"); // assertion: an absent agentId is fleet-wide
    expect(result.errors, JSON.stringify(result)).toBe(0);
    expect({ expired: result.expired, archived: result.archived, orphans: result.orphans }).toEqual(expected); // assertion: the run acted on every in-scope row

    for (const s of inPlay) {
      const seededRows = JSON.parse(s.seededRows);
      const memoryText = await readMemory(s.id);
      const memory = JSON.parse(memoryText);
      if (s.memory === "removed" || s.memory === "none") expect(memory, `${s.id} Memory row is stored`).toEqual([]);
      if (s.memory === "archived") expect(memory[0]?.archived, `${s.id} Memory row was not archived`).toBe(true);
      if (s.memory === "kept") expect(memoryText, `${s.id} Memory row changed`).toBe(seededRows.memory);
      const pointer = await readPointer(s.id);
      if (s.pointer === "removed") expect(pointer, `${s.id} pointer was not removed`).toBe("[]");
      if (s.pointer === "kept") expect(pointer, `${s.id} live pointer changed`).toBe(seededRows.pointer);
    }
  }, 90_000);
});
