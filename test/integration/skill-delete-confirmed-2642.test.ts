/**
 * skill-delete-confirmed-2642.test.ts — a skill-tagged Memory DELETE confirms
 * the version close in the committed store before answering success
 * (flair#2642).
 *
 * A skill DELETE does not remove the row: it closes the live head (a full
 * `put` carrying `validTo`) and appends a tombstone. Harper can resolve a
 * transaction's commit while dropping that full put — it loses to a newer
 * write of the same row — and still commit the transaction's other writes, so
 * the tombstone and the pointer write land while the close does not. This test
 * holds the DELETE at its in-transaction pause point while a lock-bypassing
 * test writer commits a newer row, then releases it and reads back the
 * committed state.
 *
 * Real Harper, ephemeral instance; every URL is asserted to be this test's own
 * instance before the first call.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }
const mkAgent = (id: string): TestAgent => {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
};

const sfx = Date.now().toString(36);
const A = mkAgent(`sdc-owner-${sfx}`);
const now = () => new Date().toISOString();

let harper: HarperInstance;
let pauseDir = "";

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
  expect(h.process?.pid).toBeGreaterThan(0);
}

const basicAuth = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify(operation),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBe(200);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

async function memoryRow(id: string): Promise<any | null> {
  const rows = await ops({ operation: "search_by_id", database: "flair", table: "Memory", ids: [id], get_attributes: ["*"] });
  return rows[0] ?? null;
}

async function versionsOf(subjectId: string): Promise<any[]> {
  const rows = await ops({
    operation: "search_by_value", database: "flair", table: "InstructionVersion",
    search_attribute: "subjectId", search_value: subjectId, get_attributes: ["*"],
  });
  return (rows as any[]).sort((a, b) => Number(a.version) - Number(b.version));
}

function ed25519(who: TestAgent, method: string, path: string): string {
  const ts = String(Date.now());
  const nonce = randomUUID();
  const sig = nacl.sign.detached(new TextEncoder().encode(`${who.id}:${ts}:${nonce}:${method}:${path}`), who.secretKey);
  return `TPS-Ed25519 ${who.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

async function call(auth: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(harper.httpURL + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: ed25519(auth, method, path) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}

const memPath = (id: string) => `/Memory/${encodeURIComponent(id)}`;

function skillBody(id: string, content: string) {
  return { id, agentId: A.id, content, trigger: `when to ${content}`, tags: ["skill"], durability: "persistent" };
}

let seq = 0;
const nextId = (label: string) => `sdc-${label}-${sfx}-${++seq}`;

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** Arm `point`, start `trigger`, run `compete` once it is paused, release, await it. */
async function withPaused(point: string, trigger: () => Promise<Response>, compete: () => Promise<void>) {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${point}`), "");
  const pending = trigger();
  const paused = await waitFor(join(pauseDir, `paused.${point}`), 20_000);
  try {
    if (paused) await compete();
  } finally {
    writeFileSync(join(pauseDir, `go.${point}`), "");
  }
  const response = await pending;
  const released = paused ? readFileSync(join(pauseDir, `released.${point}`), "utf8") : "never paused";
  return { response, released, paused };
}

/** Commit a newer full record to the skill row, outside the version write lock. */
async function commitNewerSkillWrite(id: string, content: string): Promise<void> {
  const current = await memoryRow(id);
  expect(current, "the skill row is missing before the competing write").not.toBeNull();
  await ops({
    operation: "put", database: "flair", table: "Memory",
    records: [{ ...current, content, updatedAt: now() }],
  });
  expect((await memoryRow(id))?.content, "the competing write is not visible while the DELETE is paused").toBe(content);
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2642-pause-"));
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
    records: [{ id: A.id, name: A.id, role: "agent", publicKey: A.publicKey, createdAt: now() }],
  });
  await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
  await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#2642 — a skill DELETE confirms the version close before success", () => {
  it("a newer write committed while the DELETE is paused does not let it answer success with the head still open", async () => {
    const id = nextId("race");
    const created = await call(A, "PUT", memPath(id), skillBody(id, "v1"));
    expect(created.status, (await created.text()).slice(0, 300)).toBeLessThan(300);
    const before = await memoryRow(id);
    expect(typeof before?.validTo === "string" ? before.validTo : null, "the seeded skill is already closed").toBeNull();

    const { response, paused, released } = await withPaused(
      "skill-close-staged",
      () => call(A, "DELETE", memPath(id)),
      () => commitNewerSkillWrite(id, "v2-committed-during-delete"),
    );
    expect(paused, "the skill DELETE was not paused").toBe(true);
    expect(released).toBe("go");
    const text = await response.text();
    expect(response.status, text.slice(0, 300)).toBe(200);

    const row = await memoryRow(id);
    const versions = await versionsOf(id);
    const head = versions.at(-1);
    // The guarantee: a 200 means the version close is visible in the committed
    // store — the head carries a closing `validTo`, the tombstone is the head,
    // and the close and the tombstone agree on which row they closed.
    expect(typeof row?.validTo, `200 with the skill head still open: ${JSON.stringify({ row, response: text, head })}`).toBe("string");
    expect(row?.content, "the close did not keep the row the newer write left").toBe("v2-committed-during-delete");
    expect(head?.kind, JSON.stringify(versions)).toBe("delete");
    expect(head?.rowId, JSON.stringify(versions)).toBe(id);
    expect(versions.map((v) => v.kind), JSON.stringify(versions)).toEqual(["create", "delete"]);
  }, 120_000);

  it("CONTROL: with no competitor the DELETE closes the head and appends the tombstone", async () => {
    const id = nextId("control");
    const created = await call(A, "PUT", memPath(id), skillBody(id, "only"));
    expect(created.status, (await created.text()).slice(0, 300)).toBeLessThan(300);
    const res = await call(A, "DELETE", memPath(id));
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBe(200);
    const row = await memoryRow(id);
    expect(typeof row?.validTo, JSON.stringify(row)).toBe("string");
    const versions = await versionsOf(id);
    expect(versions.map((v) => v.kind)).toEqual(["create", "delete"]);
  }, 120_000);
});
