/**
 * skill-update-close-confirmed-2645.test.ts — a skill UPDATE confirms that its
 * predecessor close landed in the committed store before answering success
 * (flair#2645).
 *
 * A skill update writes a successor row and closes the predecessor with a full
 * `put` in the same transaction that appends the version. Harper can resolve
 * that transaction's commit while dropping the queued full put — it loses to a
 * newer write of the same row — and still commit the successor and version
 * writes, so a 200 could leave two live heads. This test holds the update at its
 * in-transaction pause point while a lock-bypassing test writer commits a newer
 * full record to the predecessor, then releases it and reads back the committed
 * state.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { assertOwnInstance } from "../helpers/own-harper-instance";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }
const mkAgent = (id: string): TestAgent => {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
};

const sfx = Date.now().toString(36);
const A = mkAgent(`agent-a-${sfx}`);
const B = mkAgent(`agent-b-${sfx}`);
const now = () => new Date().toISOString();

let harper: HarperInstance;
let pauseDir = "";

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

async function liveHeads(subjectId: string): Promise<string[]> {
  const rows = await ops({
    operation: "search_by_value", database: "flair", table: "Memory",
    search_attribute: "skillSubjectId", search_value: subjectId, get_attributes: ["id", "validTo", "archived"],
  });
  return (rows as any[])
    .filter((row) => row.archived !== true && !(typeof row.validTo === "string" && row.validTo.length > 0))
    .map((row) => String(row.id));
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

function skillBody(id: string, content: string, extra: Record<string, unknown> = {}) {
  return { id, agentId: A.id, content, trigger: `when to ${content}`, tags: ["skill"], durability: "persistent", ...extra };
}

let seq = 0;
const nextId = (label: string) => `suc-${label}-${sfx}-${++seq}`;

async function waitFor(path: string, timeoutMs: number, content?: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path) && (content === undefined || readFileSync(path, "utf8") === content)) return true;
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

const closePoints = ["skill-close-staged", "skill-update-retry-first", "skill-update-retry-second", "skill-update-retry-third"];

async function withPausedCloses(points: string[], trigger: () => Promise<Response>, compete: (index: number) => Promise<void>) {
  for (const point of points) {
    for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
    writeFileSync(join(pauseDir, `arm.${point}`), "");
  }
  const pending = trigger();
  try {
    for (const [index, point] of points.entries()) {
      expect(await waitFor(join(pauseDir, `paused.${point}`), 20_000), point).toBe(true);
      await compete(index);
      writeFileSync(join(pauseDir, `go.${point}`), "");
      expect(await waitFor(join(pauseDir, `released.${point}`), 5_000, "go"), point).toBe(true);
      expect(readFileSync(join(pauseDir, `released.${point}`), "utf8"), point).toBe("go");
    }
    return await pending;
  } finally {
    for (const point of points) {
      writeFileSync(join(pauseDir, `go.${point}`), "");
      rmSync(join(pauseDir, `arm.${point}`), { force: true });
    }
    await pending;
  }
}


/** Commit a newer full record to the skill row, outside the version write lock. */
async function commitNewerSkillWrite(id: string, content: string, extra: Record<string, unknown> = {}): Promise<void> {
  const current = await memoryRow(id);
  expect(current, "the skill row is missing before the competing write").not.toBeNull();
  await ops({
    operation: "put", database: "flair", table: "Memory",
    records: [{ ...current, content, updatedAt: now(), ...extra }],
  });
  expect((await memoryRow(id))?.content, "the competing write is not visible while the update is paused").toBe(content);
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2645-pause-"));
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
  // Before the first test request, reject external instances and check the live
  // spawned process, owned temporary install directory, and distinct 127.0.0.1
  // ports outside the helper's denylist.
  assertOwnInstance(harper);
  await ops({
    operation: "upsert", database: "flair", table: "Agent",
    records: [A, B].map((agent) => ({ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: now() })),
  });
  await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
  await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#2645 — a skill UPDATE confirms the predecessor close before success", () => {
  it("a newer write committed while the update is paused still leaves one live head", async () => {
    const predecessorId = nextId("race");
    const created = await call(A, "PUT", memPath(predecessorId), skillBody(predecessorId, "v1"));
    expect(created.status, (await created.text()).slice(0, 300)).toBeLessThan(300);
    const successorId = nextId("race-successor");
    const { response, paused, released } = await withPaused(
      "skill-close-staged",
      () => call(A, "PUT", memPath(successorId), skillBody(successorId, "v2", { supersedes: predecessorId })),
      () => commitNewerSkillWrite(predecessorId, "v2-committed-during-update"),
    );
    expect(paused, "the skill update was not paused").toBe(true);
    expect(released).toBe("go");
    const text = await response.text();
    expect(response.status, text.slice(0, 300)).toBe(200);

    const predecessor = await memoryRow(predecessorId);
    const successor = await memoryRow(successorId);
    const versions = await versionsOf(predecessorId);
    expect(typeof predecessor?.validTo, `200 with the predecessor still open: ${JSON.stringify({ predecessor, response: text })}`).toBe("string");
    expect(predecessor?.content, "the close did not keep the row the newer write left").toBe("v2-committed-during-update");
    expect(successor?.supersedes, JSON.stringify(successor)).toBe(predecessorId);
    expect(typeof successor?.validTo === "string" ? successor.validTo : null, "the successor is closed").toBeNull();
    expect(versions.map((v) => v.kind), JSON.stringify(versions)).toEqual(["create", "update"]);
    expect(versions.at(-1)?.memoryId, "the version head does not name the successor").toBe(successorId);
    expect(await liveHeads(predecessorId), "the lineage does not have exactly one live head").toEqual([successorId]);
  }, 120_000);

  it("a same-id replacement while the update is paused is refused and the successor rolled back", async () => {
    const predecessorId = nextId("replaced");
    const created = await call(A, "PUT", memPath(predecessorId), skillBody(predecessorId, "v1"));
    expect(created.status, (await created.text()).slice(0, 300)).toBeLessThan(300);
    const successorId = nextId("replaced-successor");
    const { response, paused, released } = await withPaused(
      "skill-close-staged",
      () => call(A, "PUT", memPath(successorId), skillBody(successorId, "v2", { supersedes: predecessorId })),
      () => commitNewerSkillWrite(predecessorId, "replacement", { agentId: "agent-b" }),
    );
    expect(paused, "the skill update was not paused").toBe(true);
    expect(released).toBe("go");
    const text = await response.text();
    expect(response.status, text.slice(0, 300)).toBe(409);
    expect(JSON.parse(text).error, "replaced predecessor refusal error").toBe("stored_row_changed");

    const predecessor = await memoryRow(predecessorId);
    expect(typeof predecessor?.validTo === "string" ? predecessor.validTo : null, "the replaced row was closed").toBeNull();
    expect(await memoryRow(successorId), "the successor row was not rolled back").toBeNull();
    expect((await versionsOf(predecessorId)).map((v) => v.kind), "the refused update left a version row").toEqual(["create"]);
  }, 120_000);

  it("exhausted retries confirm rollback after commit while holding the version lock", async () => {
    const id = nextId("exhausted");
    const successorId = nextId("exhausted-successor");
    const created = await call(A, "PUT", memPath(id), skillBody(id, "v1"));
    expect(created.status, await created.text()).toBeLessThan(300);
    const points = [...closePoints, "skill-version-rollback-staged", "skill-version-rollback-committed"];
    const response = await withPausedCloses(points,
      () => call(A, "PUT", memPath(successorId), skillBody(successorId, "v2", { supersedes: id })),
      async (index) => {
        if (index < closePoints.length) await commitNewerSkillWrite(id, `competitor-${index}`);
        else {
          expect((await versionsOf(id)).map((v) => v.kind)).toEqual(index === closePoints.length ? ["create", "update"] : ["create"]);
          expect(await memoryRow(successorId)).not.toBeNull();
          const competingId = nextId("locked");
          const competing = await call(A, "PUT", memPath(competingId), skillBody(competingId, "other"));
          expect(competing.status, await competing.clone().text()).toBe(409);
          expect((await competing.json()).error).toBe("instruction_version_busy");
        }
      });
    const text = await response.text();
    expect(response.status, text).toBe(409);
    expect(JSON.parse(text).error).toBe("skill_update_not_closed");
    expect((await memoryRow(id))?.validTo ?? null).toBeNull();
    expect((await memoryRow(id))?.content).toBe("competitor-3");
    expect(await memoryRow(successorId)).toBeNull();
    expect((await versionsOf(id)).map((v) => v.kind)).toEqual(["create"]);
    expect(await liveHeads(id)).toEqual([id]);
  }, 120_000);

  it("a grant revoked after a retry stages its close refuses and rolls back the successor", async () => {
    const headId = nextId("retry-revoked");
    const created = await call(B, "PUT", memPath(headId), skillBody(headId, "v1", { agentId: B.id }));
    expect(created.status, await created.text()).toBeLessThan(300);
    const grantId = `${B.id}:${A.id}:write`;
    await ops({ operation: "insert", database: "flair", table: "MemoryGrant", records: [{
      id: grantId, ownerId: B.id, granteeId: A.id, scope: "write", createdAt: now(),
    }] });
    const successorId = nextId("revoked-successor");
    const response = await withPausedCloses(closePoints.slice(0, 2),
      () => call(A, "PUT", memPath(successorId), skillBody(successorId, "v3", { supersedes: headId })),
      async (index) => {
        if (index === 0) await commitNewerSkillWrite(headId, "retry keeps this content");
        else {
          await ops({ operation: "delete", database: "flair", table: "MemoryGrant", ids: [grantId] });
          expect(await ops({ operation: "search_by_id", database: "flair", table: "MemoryGrant", ids: [grantId], get_attributes: ["*"] })).toEqual([]);
        }
      });
    const text = await response.text();
    expect(response.status, text).toBe(409);
    expect(JSON.parse(text).error).toBe("granted_close_revoked");
    const row = await memoryRow(headId);
    expect(row?.agentId).toBe(B.id);
    expect(row?.validTo ?? null).toBeNull();
    expect(row?.content).toBe("retry keeps this content");
    expect(await memoryRow(successorId)).toBeNull();
    expect((await versionsOf(headId)).map((v) => v.kind)).toEqual(["create"]);
    expect(await liveHeads(headId)).toEqual([headId]);
  }, 120_000);

  it("CONTROL: with no competitor the update closes the predecessor and appends the version", async () => {
    const predecessorId = nextId("control");
    const created = await call(A, "PUT", memPath(predecessorId), skillBody(predecessorId, "v1"));
    expect(created.status, (await created.text()).slice(0, 300)).toBeLessThan(300);
    const successorId = nextId("control-successor");
    const res = await call(A, "PUT", memPath(successorId), skillBody(successorId, "v2", { supersedes: predecessorId }));
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBe(200);
    expect(typeof (await memoryRow(predecessorId))?.validTo, "the predecessor was not closed").toBe("string");
    expect((await versionsOf(predecessorId)).map((v) => v.kind)).toEqual(["create", "update"]);
  }, 120_000);
});
