/**
 * grant-visibility-close-contention.test.ts — real Harper.
 *
 * A write grant does not include changing a record's visibility. For the
 * grant-authorized successor write, after staging the close the writer
 * re-reads the predecessor's committed row; if that row's visibility no longer
 * reads the same as the successor's, the whole write is refused with the named
 * 409 predecessor_visibility_changed — no successor, no close, no version row
 * (resources/grant-visibility.ts). A change committed after that final re-read
 * and before the write commits is not seen by it; Harper orders the writes by
 * transaction timestamp.
 *
 * These cases change the predecessor's visibility while the grantee's close is
 * held by a test-only pause (resources/txn-pause-point.ts, enabled by
 * FLAIR_ENABLE_TEST_FAULT_INJECTION and FLAIR_TEST_PAUSE_DIR, which this file
 * sets in the test process's environment while it starts its Harper, then
 * restores), then release the close:
 *
 *   - an ordinary successor (Memory.ts stageGrantedClose, staged in the
 *     successor's transaction): the owner's own signed PUT changes the
 *     predecessor's visibility, once while the close is held before it stages
 *     its write ("granted-close", PUT /Memory) and once after
 *     ("granted-close-staged", POST /Memory). An owner edit that keeps the
 *     visibility is also refused, by name, as stored_row_changed: the close is
 *     staged at its transaction's timestamp and is not re-staged over a row
 *     changed during the write;
 *   - a skill successor (skill-version-write.ts): a skill row's own writes take
 *     the skill-version lock the grantee's write holds, so the competing change
 *     is a raw table update, as an operator would make, while the close is held
 *     after it stages its write ("skill-close-staged"), through PUT /Memory and
 *     POST /FeedMemories.
 *
 * Control cases show that a held close with no competing change lands, and
 * that a competing change to a skill row that leaves visibility as it was lets
 * the grant-authorized skill write land.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { HarperInstance, startHarper, stopHarper } from "../helpers/harper-lifecycle";

const REFUSAL = "predecessor_visibility_changed";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }
function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}
function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}
function assertOwnInstance(h: HarperInstance): void {
  const http = new URL(h.httpURL);
  const ops = new URL(h.opsURL);
  for (const u of [http, ops]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} / ${h.opsURL} is not an instance this test started`);
  }
}

let harper: HarperInstance;
let pauseDir: string;
const owner = mkAgent("gvc-owner");
const grantee = mkAgent("gvc-grantee");

async function adminOp(op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(op),
  });
}
async function send(agent: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { Authorization: ed25519Header(agent, method, path), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function stored(id: string): Promise<any> {
  const res = await adminOp({ operation: "search_by_id", database: "flair", table: "Memory", ids: [id], get_attributes: ["*"] });
  const text = await res.text();
  expect(res.status, `search_by_id returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
  return (JSON.parse(text) as any[])[0] ?? null;
}
async function versionCount(subjectId: string): Promise<number> {
  const res = await adminOp({
    operation: "search_by_value", database: "flair", table: "InstructionVersion",
    search_attribute: "subjectId", search_value: subjectId, get_attributes: ["id"],
  });
  expect(res.status, `InstructionVersion search returned ${res.status}`).toBe(200);
  return (JSON.parse(await res.text()) as any[]).length;
}
/** A raw table update of one field, as an operator would make. */
async function rawUpdate(id: string, fields: Record<string, unknown>): Promise<number> {
  return (await adminOp({ operation: "update", database: "flair", table: "Memory", records: [{ id, ...fields }] })).status;
}
async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/**
 * Arm the pause at `point`, start `write`, and once the close is paused run
 * `compete`, then release. Returns the write response, the competing step's
 * result and how the pause ended.
 */
async function withPausedClose<T>(point: string, write: () => Promise<Response>, compete: () => Promise<T>) {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${point}`), "");
  const pending = write();
  const paused = await waitFor(join(pauseDir, `paused.${point}`), 15_000);
  let competed: T | undefined;
  try {
    if (paused) competed = await compete();
  } finally {
    writeFileSync(join(pauseDir, `go.${point}`), "");
  }
  const response = await pending;
  const released = paused ? readFileSync(join(pauseDir, `released.${point}`), "utf8") : "never paused";
  return { response, competed, released };
}

const memory = (id: string, agentId: string, content: string, visibility?: string) => ({
  id, agentId, content, durability: "persistent", ...(visibility === undefined ? {} : { visibility }),
});
const skill = (id: string, agentId: string, content: string, visibility?: string) => ({
  id, agentId, content, trigger: `when to ${content}`, tags: ["skill"], durability: "persistent",
  ...(visibility === undefined ? {} : { visibility }),
});

async function ownerMemory(label: string, visibility: string): Promise<{ id: string; body: Record<string, any> }> {
  const id = `gvc-${label}-${randomUUID()}`;
  const body = memory(id, owner.id, `${label} owner memory text, long enough for the gate`, visibility);
  const res = await send(owner, "PUT", `/Memory/${id}`, body);
  expect(res.status, `owner memory create returned ${res.status}: ${(await res.text()).slice(0, 300)}`).toBeLessThan(300);
  expect((await stored(id))?.visibility).toBe(visibility);
  return { id, body };
}
async function ownerSkill(label: string, visibility: string): Promise<string> {
  const id = `gvc-${label}-${randomUUID()}`;
  const res = await send(owner, "PUT", `/Memory/${id}`, skill(id, owner.id, `${label} owner skill version one`, visibility));
  expect(res.status, `owner skill create returned ${res.status}: ${(await res.text()).slice(0, 300)}`).toBeLessThan(300);
  expect((await stored(id))?.visibility).toBe(visibility);
  return id;
}

/** The refusal: the named 409, no successor, the predecessor open with the competing visibility. */
async function expectRefused(response: Response, predecessorId: string, successorId: string, visibility: string, isSkill: boolean) {
  const text = await response.text();
  expect(response.status, `grantee write returned ${response.status}: ${text.slice(0, 300)}`).toBe(409);
  const body = JSON.parse(text);
  expect(body.error).toBe(REFUSAL);
  expect(Object.keys(body).sort(), "the refusal carries only its name and fixed message").toEqual(["error", "message"]);
  expect(await stored(successorId), "a successor row was written").toBeNull();
  const predecessor = await stored(predecessorId);
  expect(predecessor?.visibility, "the competing visibility change is kept").toBe(visibility);
  expect(predecessor?.validTo ?? null, "the predecessor was closed").toBeNull();
  if (isSkill) expect(await versionCount(predecessorId), "a version row was appended").toBe(1);
}

beforeAll(async () => {
  pauseDir = mkdtempSync(join(tmpdir(), "flair-gvc-pause-"));
  const saved = {
    FLAIR_ENABLE_TEST_FAULT_INJECTION: process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION,
    FLAIR_TEST_PAUSE_DIR: process.env.FLAIR_TEST_PAUSE_DIR,
  };
  process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
  process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
  try {
    harper = await startHarper();
  } finally {
    // The spawned Harper has its copy; no later Harper in this process inherits it.
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assertOwnInstance(harper);
  const seed = await adminOp({
    operation: "insert", database: "flair", table: "Agent",
    records: [owner, grantee].map((a) => ({ id: a.id, name: a.id, role: "agent", publicKey: a.publicKey, createdAt: new Date().toISOString() })),
  });
  expect(seed.status).toBe(200);
  const grant = await adminOp({
    operation: "insert", database: "flair", table: "MemoryGrant",
    records: [{ id: `${owner.id}:${grantee.id}:write`, ownerId: owner.id, granteeId: grantee.id, scope: "write", createdAt: new Date().toISOString() }],
  });
  expect(grant.status).toBe(200);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
});

describe("a grant-authorized ordinary successor: a predecessor visibility change before the close's final re-read refuses the write (real Harper)", () => {
  it("PUT /Memory: the owner makes the shared predecessor private while the close is held before staging: 409, nothing written", async () => {
    const pred = await ownerMemory("put-pre", "shared");
    const succ = `gvc-succ-${randomUUID()}`;
    const { response, competed, released } = await withPausedClose(
      "granted-close",
      () => send(grantee, "PUT", `/Memory/${succ}`, { ...memory(succ, grantee.id, "put-pre grantee successor, long enough for the gate"), supersedes: pred.id }),
      async () => (await send(owner, "PUT", `/Memory/${pred.id}`, { ...pred.body, visibility: "private" })).status,
    );
    expect(released, "the close was not paused and released by this test").toBe("go");
    expect(competed, "the owner's visibility change failed").toBeLessThan(300);
    await expectRefused(response, pred.id, succ, "private", false);
  }, 60_000);

  it("POST /Memory: the owner makes the private predecessor shared while the close is held after staging: 409, nothing written", async () => {
    const pred = await ownerMemory("post-staged", "private");
    const succ = `gvc-succ-${randomUUID()}`;
    const { response, competed, released } = await withPausedClose(
      "granted-close-staged",
      () => send(grantee, "POST", "/Memory", { ...memory(succ, grantee.id, "post-staged grantee successor, long enough for the gate"), supersedes: pred.id }),
      async () => (await send(owner, "PUT", `/Memory/${pred.id}`, { ...pred.body, visibility: "shared" })).status,
    );
    expect(released, "the close was not paused and released by this test").toBe("go");
    expect(competed, "the owner's visibility change failed").toBeLessThan(300);
    await expectRefused(response, pred.id, succ, "shared", false);
  }, 60_000);

  it("an owner edit that keeps the visibility refuses the write by name as stored_row_changed: nothing written, the edit kept", async () => {
    const pred = await ownerMemory("edit", "shared");
    const succ = `gvc-succ-${randomUUID()}`;
    const EDITED = "edit owner memory text AFTER the owner's edit, long enough for the gate";
    const { response, competed, released } = await withPausedClose(
      "granted-close",
      () => send(grantee, "PUT", `/Memory/${succ}`, { ...memory(succ, grantee.id, "edit grantee successor, long enough for the gate"), supersedes: pred.id }),
      async () => (await send(owner, "PUT", `/Memory/${pred.id}`, { ...pred.body, content: EDITED })).status,
    );
    expect(released, "the close was not paused and released by this test").toBe("go");
    expect(competed, "the owner's edit failed").toBeLessThan(300);
    const text = await response.text();
    expect(response.status, text.slice(0, 300)).toBe(409);
    expect(JSON.parse(text).error).toBe("stored_row_changed");
    expect(await stored(succ), "a successor row was written").toBeNull();
    const predecessor = await stored(pred.id);
    expect(predecessor?.content, "the owner's edit is kept").toBe(EDITED);
    expect(predecessor?.validTo ?? null, "the predecessor was closed").toBeNull();
  }, 60_000);

  it("control: a held close with no competing change lands with the successor", async () => {
    const pred = await ownerMemory("held", "private");
    const succ = `gvc-succ-${randomUUID()}`;
    const { response, competed, released } = await withPausedClose(
      "granted-close-staged",
      () => send(grantee, "PUT", `/Memory/${succ}`, { ...memory(succ, grantee.id, "held grantee successor, long enough for the gate"), supersedes: pred.id }),
      async () => "no competing change",
    );
    expect(released, "the close was not paused and released by this test").toBe("go");
    expect(competed).toBe("no competing change");
    expect(response.status, (await response.text()).slice(0, 300)).toBeLessThan(300);
    expect((await stored(succ))?.visibility, "successor visibility").toBe("private");
    expect((await stored(pred.id))?.validTo, "the close did not land").toBeTruthy();
  }, 60_000);
});

describe("a grant-authorized skill successor: a predecessor visibility change before the close's final re-read refuses the write (real Harper)", () => {
  it("PUT /Memory: the shared skill predecessor is made private while the close is staged: 409, no successor, no close, no version", async () => {
    const pred = await ownerSkill("skill-put", "shared");
    const succ = `gvc-succ-${randomUUID()}`;
    const { response, competed, released } = await withPausedClose(
      "skill-close-staged",
      () => send(grantee, "PUT", `/Memory/${succ}`, { ...skill(succ, grantee.id, "skill-put grantee version two"), supersedes: pred }),
      () => rawUpdate(pred, { visibility: "private" }),
    );
    expect(released, "the skill close was not paused and released by this test").toBe("go");
    expect(competed, "the competing visibility change failed").toBe(200);
    await expectRefused(response, pred, succ, "private", true);
  }, 60_000);

  it("POST /FeedMemories: the private skill predecessor is made shared while the close is staged: 409, no successor, no close, no version", async () => {
    const pred = await ownerSkill("skill-feed", "private");
    const succ = `gvc-succ-${randomUUID()}`;
    const { response, competed, released } = await withPausedClose(
      "skill-close-staged",
      () => send(grantee, "POST", "/FeedMemories", { ...skill(succ, grantee.id, "skill-feed grantee version two"), supersedes: pred }),
      () => rawUpdate(pred, { visibility: "shared" }),
    );
    expect(released, "the skill close was not paused and released by this test").toBe("go");
    expect(competed, "the competing visibility change failed").toBe(200);
    await expectRefused(response, pred, succ, "shared", true);
  }, 60_000);

  it("control: a competing change that keeps the visibility lets the grant-authorized skill successor land", async () => {
    const pred = await ownerSkill("skill-keep", "private");
    const succ = `gvc-succ-${randomUUID()}`;
    const { response, competed, released } = await withPausedClose(
      "skill-close-staged",
      () => send(grantee, "PUT", `/Memory/${succ}`, { ...skill(succ, grantee.id, "skill-keep grantee version two"), supersedes: pred }),
      () => rawUpdate(pred, { retrievalCount: 7 }),
    );
    expect(released, "the skill close was not paused and released by this test").toBe("go");
    expect(competed, "the competing update failed").toBe(200);
    expect(response.status, (await response.text()).slice(0, 300)).toBeLessThan(300);
    expect((await stored(succ))?.visibility, "successor visibility").toBe("private");
    expect(await versionCount(pred), "the supersede appended no version").toBe(2);
  }, 60_000);
});
