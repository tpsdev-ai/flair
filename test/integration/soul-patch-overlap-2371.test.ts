/**
 * soul-patch-overlap-2371.test.ts — flair#2371, real Harper.
 *
 * Soul.patch (resources/Soul.ts) read the stored row and merged the request onto
 * it in one transaction. Harper has no compare-or-set on a table write: a
 * transaction does not fail when a row it read is changed by another write
 * before it commits, so a PATCH built from an earlier read can drop a field a
 * concurrent write set, while both report success.
 *
 * The fix reads the row, merges and writes per attempt, then re-reads the
 * COMMITTED row before the transaction commits; a concurrent change aborts the
 * staged write (no version appended) and the attempt retries from the committed
 * row. A replaced row (a different subject, or gone) is refused with a named
 * error instead of written.
 *
 * These cases drive a real HTTP PATCH against a spawned Harper carrying the
 * test-only pause (resources/txn-pause-point.ts, enabled by
 * FLAIR_ENABLE_TEST_FAULT_INJECTION and FLAIR_TEST_PAUSE_DIR, set for this
 * file's Harper only). The PATCH is paused after its read; a competing write
 * to a different field commits while it is paused; the PATCH then confirms,
 * aborts and retries. A same-worker second PATCH would wait on the per-key
 * instruction lock (instruction_version_busy), so the competing write is a raw
 * table update — the interleaving, not the writer's identity, is what this
 * exercises.
 *
 * Retry exhaustion (the bounded attempts ending in the named conflict) is
 * covered deterministically in test/unit-isolated/instruction-version-record.test.ts:
 * the pause point pauses one call per armed file, so a real-Harper window that
 * holds every attempt is not armable.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";

const POINT = "soul-patch";
const sfx = Date.now().toString(36);
const now = () => new Date().toISOString();
const MARKERS = ["claimed", "paused", "go", "released"];

let harper: HarperInstance;
let pauseDir = "";
const marker = (name: string) => join(pauseDir, `${name}.${POINT}`);
const clearMarkers = () => { for (const m of MARKERS) rmSync(marker(m), { force: true }); };

/** Refuse any target that is not the ephemeral instance this file started. */
function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
}

const basicAuth = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(harper.httpURL + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify(operation),
  });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`ops ${operation.operation} returned ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** A raw table update of one Soul row (no instruction lock, no version). */
const rawSoulUpdate = (id: string, patch: Record<string, unknown>) =>
  ops({ operation: "update", database: "flair", table: "Soul", records: [{ id, ...patch }] }).then(() => 200);

async function versionsOf(subjectId: string): Promise<any[]> {
  const rows = await ops({
    operation: "search_by_value", database: "flair", table: "InstructionVersion",
    search_attribute: "subjectId", search_value: subjectId, get_attributes: ["*"],
  });
  return rows.sort((a: any, b: any) => Number(a.version) - Number(b.version));
}

async function soulRow(id: string): Promise<any | null> {
  const rows = await ops({ operation: "search_by_id", database: "flair", table: "Soul", ids: [id], get_attributes: ["*"] });
  return rows[0] ?? null;
}

const soulPath = (id: string) => `/Soul/${encodeURIComponent(id)}`;

async function createSoul(id: string, agentId: string, key: string, value: string): Promise<void> {
  const res = await call("POST", "/Soul/", { id, agentId, key, value, durability: "permanent" });
  expect(res.status, `Soul POST ${id}: ${res.text.slice(0, 200)}`).toBeLessThan(300);
}

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/**
 * Arm the pause, start `trigger`, and once it is paused inside its transaction
 * run `compete`, then release it. Returns the trigger's response and how the
 * pause ended.
 */
async function withPaused<T>(trigger: () => Promise<{ status: number; text: string }>, compete: () => Promise<T>) {
  clearMarkers();
  writeFileSync(marker("arm"), "");
  const pending = trigger();
  const paused = await waitFor(marker("paused"), 20_000);
  let competed: T | undefined;
  try {
    if (paused) competed = await compete();
  } finally {
    writeFileSync(marker("go"), "");
  }
  const response = await pending;
  const released = paused ? readFileSync(marker("released"), "utf8") : "never paused";
  return { response, competed, released, paused };
}


beforeAll(async () => {
  pauseDir = mkdtempSync(join(tmpdir(), "flair-soul-patch-pause-"));
  const saved = {
    FLAIR_ENABLE_TEST_FAULT_INJECTION: process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION,
    FLAIR_TEST_PAUSE_DIR: process.env.FLAIR_TEST_PAUSE_DIR,
  };
  process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
  process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
  try {
    harper = await startHarper();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assertOwnInstance(harper);
  await ops({
    operation: "upsert", database: "flair", table: "Agent",
    records: [`soul-a-${sfx}`, `soul-b-${sfx}`, `soul-c-${sfx}`].map((id) => ({
      id, name: id, role: "agent", publicKey: "unused", createdAt: now(),
    })),
  });
  await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
  await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
});

describe("flair#2371 — a Soul PATCH keeps every field when another write overlaps (real Harper)", () => {
  test("the value writer commits last: the durability writer's field is not dropped", async () => {
    const key = `overlap-value-last-${sfx}`;
    const id = `soul-a-${sfx}:${key}`;
    await createSoul(id, `soul-a-${sfx}`, key, "before");

    const { response, competed, released } = await withPaused(
      () => call("PATCH", soulPath(id), { value: "after", originatorInstanceId: "forged" }),
      async () => {
        await rawSoulUpdate(id, { durability: "persistent" });
        return (await soulRow(id))?.durability;
      },
    );
    expect(released, "the value PATCH was not paused and released by this test").toBe("go");
    expect(competed, "the competing durability write did not land").toBe("persistent");
    expect(response.status, response.text.slice(0, 300)).toBeLessThan(300);

    const row = await soulRow(id);
    expect(row.value).toBe("after");
    expect(row.durability).toBe("persistent");
    const versions = await versionsOf(`soul-a-${sfx}:${key}`);
    expect(versions).toHaveLength(2);
    expect(JSON.parse(versions.at(-1)!.soulSnapshot)).toEqual(row);
  }, 60_000);

  test("the durability writer commits last: the value writer's field is not dropped", async () => {
    const key = `overlap-durability-last-${sfx}`;
    const id = `soul-a-${sfx}:${key}`;
    await createSoul(id, `soul-a-${sfx}`, key, "before");

    const { response, competed, released } = await withPaused(
      () => call("PATCH", soulPath(id), { durability: "persistent", createdAt: "forged" }),
      () => rawSoulUpdate(id, { value: "after" }),
    );
    expect(released, "the durability PATCH was not paused and released by this test").toBe("go");
    expect(competed, "the competing value write failed").toBe(200);
    expect(response.status, response.text.slice(0, 300)).toBeLessThan(300);

    const row = await soulRow(id);
    expect(row.value).toBe("after");
    expect(row.durability).toBe("persistent");
    const versions = await versionsOf(`soul-a-${sfx}:${key}`);
    expect(versions).toHaveLength(2);
    expect(JSON.parse(versions.at(-1)!.soulSnapshot)).toEqual(row);
  }, 60_000);

  test("a PATCH whose soul row's owner changes mid-request is refused and changes nothing", async () => {
    const key = `overlap-owner-${sfx}`;
    const id = `soul-a-${sfx}:${key}`;
    await createSoul(id, `soul-a-${sfx}`, key, "before");
    const before = await versionsOf(`soul-a-${sfx}:${key}`);

    const { response, competed, released } = await withPaused(
      // A re-own from soul-a to soul-b, decided against the row as it read it.
      () => call("PATCH", soulPath(id), { agentId: `soul-b-${sfx}` }),
      // The row's owner changes to a third agent while the PATCH is paused.
      () => rawSoulUpdate(id, { agentId: `soul-c-${sfx}` }),
    );
    expect(released, "the owner-changing PATCH was not paused and released by this test").toBe("go");
    expect(competed, "the competing owner change failed").toBe(200);
    expect(response.status, response.text.slice(0, 300)).toBe(409);
    expect(JSON.parse(response.text)).toEqual({ error: "soul_patch_row_changed" });

    // Nothing the refused PATCH decided was written: the competing owner stands
    // and no version was appended for either subject.
    expect((await soulRow(id))?.agentId).toBe(`soul-c-${sfx}`);
    expect(await versionsOf(`soul-a-${sfx}:${key}`)).toEqual(before);
    expect(await versionsOf(`soul-b-${sfx}:${key}`)).toEqual([]);
  }, 60_000);
});
