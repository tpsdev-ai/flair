/**
 * grant-visibility-owner-controlled.test.ts — real Harper.
 *
 * A "write" MemoryGrant lets the grantee write a successor of the owner's
 * record. It does not include changing the record's visibility: visibility is
 * set by the owner or an admin. For the grant-authorized successor write, the
 * successor carries the predecessor's visibility when the write omits one, and
 * a write naming one that reads differently is refused with a named 403 and
 * writes nothing, unless an earlier validation refuses it first (an ephemeral
 * write naming "shared" gets the ephemeral private-only rule's 400; an
 * ephemeral or session skill write gets the skill-durability gate's 400). An
 * ordinary ephemeral successor that omits visibility on a shared predecessor
 * carries "shared" and gets the same ephemeral-rule 400 (a case below). A
 * predecessor whose visibility changes before the close's final committed-state
 * re-read is covered by grant-visibility-close-contention.test.ts. The rule
 * governs that write: an ordinary successor is the grantee's own row, and the
 * grantee may later change that row's visibility as its owner (a control below
 * pins this).
 *
 * Each grantee write path is covered in both directions (naming shared on a
 * private predecessor, and private on a shared one): PUT /Memory and POST
 * /Memory for a skill successor and for an ordinary memory successor, and POST
 * /FeedMemories for a skill successor. Control cases show the owner, a Basic
 * administrator, and a grantee writing with the predecessor's visibility (or
 * omitting it) are unaffected, and that PATCH or PUT addressed at the owner's
 * own row stays refused.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import nacl from "tweetnacl";
import { HarperInstance, startHarper, stopHarper } from "../helpers/harper-lifecycle";

const REFUSAL = "grant_cannot_change_visibility";

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

let harper: HarperInstance;
const owner = mkAgent("gv-owner");
const grantee = mkAgent("gv-grantee");

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (!h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} is not an instance this test started`);
  }
}
const basic = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);
async function adminOp(op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic() },
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
async function basicSend(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { Authorization: basic(), "Content-Type": "application/json" },
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

const skill = (id: string, agentId: string, content: string, visibility?: string) => ({
  id, agentId, content, trigger: `when to ${content}`, tags: ["skill"], durability: "persistent",
  ...(visibility === undefined ? {} : { visibility }),
});
const skillSuccessor = (id: string, supersedes: string, content: string, visibility?: string) => ({
  id, agentId: grantee.id, supersedes, content, trigger: `when to ${content}`, tags: ["skill"], durability: "persistent",
  ...(visibility === undefined ? {} : { visibility }),
});
const memory = (id: string, agentId: string, content: string, durability: string, visibility?: string) => ({
  id, agentId, content, durability, ...(visibility === undefined ? {} : { visibility }),
});
const memorySuccessor = (id: string, supersedes: string, content: string, durability: string, visibility?: string) => ({
  id, agentId: grantee.id, supersedes, content, durability, ...(visibility === undefined ? {} : { visibility }),
});

async function ownerSkill(label: string, visibility: string): Promise<string> {
  const id = `gv-${label}-${randomUUID()}`;
  const res = await send(owner, "PUT", `/Memory/${id}`, skill(id, owner.id, `${label} owner skill version one`, visibility));
  const text = await res.text();
  expect(res.status, `owner skill create returned ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
  expect((await stored(id))?.visibility).toBe(visibility);
  return id;
}
async function ownerMemory(label: string, durability: string, visibility: string): Promise<string> {
  const id = `gv-${label}-${randomUUID()}`;
  const res = await send(owner, "PUT", `/Memory/${id}`, memory(id, owner.id, `${label} owner memory text`, durability, visibility));
  const text = await res.text();
  expect(res.status, `owner memory create returned ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
  expect((await stored(id))?.visibility).toBe(visibility);
  return id;
}

/** The refusal: a 403 naming the rule, nothing written, nothing closed. */
async function expectRefused(res: Response, predecessorId: string, successorId: string, isSkill: boolean): Promise<void> {
  const text = await res.text();
  expect(res.status, `grantee write returned ${res.status}: ${text.slice(0, 300)}`).toBe(403);
  const body = JSON.parse(text);
  expect(body.error).toBe(REFUSAL);
  expect(Object.keys(body).sort(), "the refusal carries only its name and fixed message").toEqual(["error", "message"]);
  expect(text.includes(predecessorId), "the refusal echoes the predecessor id").toBe(false);
  expect(await stored(successorId), "a successor row was written").toBeNull();
  expect((await stored(predecessorId))?.validTo ?? null, "the predecessor was closed").toBeNull();
  if (isSkill) expect(await versionCount(predecessorId), "a version row was appended").toBe(1);
}

beforeAll(async () => {
  harper = await startHarper();
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
});

describe("a write grant does not include changing a skill's visibility", () => {
  it("PUT /Memory: a grantee's skill successor naming visibility shared on a private skill is refused", async () => {
    const pred = await ownerSkill("put-skill-shared", "private");
    const succ = `gv-succ-${randomUUID()}`;
    const res = await send(grantee, "PUT", `/Memory/${succ}`, skillSuccessor(succ, pred, "put-skill-shared grantee version two", "shared"));
    await expectRefused(res, pred, succ, true);
  }, 60_000);

  it("POST /Memory: a grantee's skill successor naming visibility shared on a private skill is refused", async () => {
    const pred = await ownerSkill("post-skill-shared", "private");
    const succ = `gv-succ-${randomUUID()}`;
    const res = await send(grantee, "POST", "/Memory", skillSuccessor(succ, pred, "post-skill-shared grantee version two", "shared"));
    await expectRefused(res, pred, succ, true);
  }, 60_000);

  it("POST /FeedMemories: a grantee's skill successor naming visibility shared on a private skill is refused", async () => {
    const pred = await ownerSkill("feed-skill-shared", "private");
    const succ = `gv-succ-${randomUUID()}`;
    const res = await send(grantee, "POST", "/FeedMemories", skillSuccessor(succ, pred, "feed-skill-shared grantee version two", "shared"));
    await expectRefused(res, pred, succ, true);
  }, 60_000);

  it("POST /Memory: a grantee's skill successor naming visibility private on a shared skill is refused", async () => {
    const pred = await ownerSkill("post-skill-private", "shared");
    const succ = `gv-succ-${randomUUID()}`;
    const res = await send(grantee, "POST", "/Memory", skillSuccessor(succ, pred, "post-skill-private grantee version two", "private"));
    await expectRefused(res, pred, succ, true);
  }, 60_000);

  it("PUT /Memory: a grantee's skill successor naming visibility private on a shared skill is refused", async () => {
    const pred = await ownerSkill("put-skill-private", "shared");
    const succ = `gv-succ-${randomUUID()}`;
    const res = await send(grantee, "PUT", `/Memory/${succ}`, skillSuccessor(succ, pred, "put-skill-private grantee version two", "private"));
    await expectRefused(res, pred, succ, true);
  }, 60_000);

  it("POST /FeedMemories: a grantee's skill successor naming visibility private on a shared skill is refused", async () => {
    const pred = await ownerSkill("feed-skill-private", "shared");
    const succ = `gv-succ-${randomUUID()}`;
    const res = await send(grantee, "POST", "/FeedMemories", skillSuccessor(succ, pred, "feed-skill-private grantee version two", "private"));
    await expectRefused(res, pred, succ, true);
  }, 60_000);

  it("control: a grantee's skill successor that omits visibility carries the predecessor's", async () => {
    for (const [verb, path] of [["PUT", "/Memory/"], ["POST", "/FeedMemories"]] as const) {
      const pred = await ownerSkill(`omit-${verb}`, "private");
      const succ = `gv-succ-${randomUUID()}`;
      const res = await send(grantee, verb, verb === "PUT" ? `${path}${succ}` : path, skillSuccessor(succ, pred, `omit-${verb} grantee version two`));
      const text = await res.text();
      expect(res.status, `${verb} granted successor returned ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
      const row = await stored(succ);
      expect(row?.agentId).toBe(owner.id);
      expect(row?.visibility, `${verb} successor visibility`).toBe("private");
      expect((await send(grantee, "GET", `/Memory/${succ}`)).status, "the grantee reads the private successor").toBe(404);
    }
  }, 60_000);

  it("control: a grantee's skill successor naming the predecessor's own visibility lands", async () => {
    const pred = await ownerSkill("same-vis", "private");
    const succ = `gv-succ-${randomUUID()}`;
    const res = await send(grantee, "PUT", `/Memory/${succ}`, skillSuccessor(succ, pred, "same-vis grantee version two", "private"));
    const text = await res.text();
    expect(res.status, `granted successor returned ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
    expect((await stored(succ))?.visibility).toBe("private");
    expect((await stored(pred))?.validTo, "the predecessor was not closed").toBeTruthy();
  }, 60_000);

  it("control: the owner's skill successor may change visibility", async () => {
    const pred = await ownerSkill("owner-change", "private");
    const succ = `gv-succ-${randomUUID()}`;
    const res = await send(owner, "PUT", `/Memory/${succ}`, { ...skill(succ, owner.id, "owner-change owner version two", "shared"), supersedes: pred });
    const text = await res.text();
    expect(res.status, `owner successor returned ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
    expect((await stored(succ))?.visibility).toBe("shared");
  }, 60_000);

  it("control: a Basic administrator's skill successor may change visibility", async () => {
    const pred = await ownerSkill("admin-change", "private");
    const succ = `gv-succ-${randomUUID()}`;
    const res = await basicSend("PUT", `/Memory/${succ}`, { ...skill(succ, owner.id, "admin-change admin version two", "shared"), supersedes: pred });
    const text = await res.text();
    expect(res.status, `admin successor returned ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
    expect((await stored(succ))?.visibility).toBe("shared");
  }, 60_000);

  it("control: PATCH and PUT addressed at the owner's skill row stay refused for the grantee", async () => {
    const pred = await ownerSkill("addressed", "private");
    const patch = await send(grantee, "PATCH", `/Memory/${pred}`, { visibility: "shared" });
    expect(patch.status, (await patch.text()).slice(0, 200)).toBe(403);
    const put = await send(grantee, "PUT", `/Memory/${pred}`, { ...skill(pred, owner.id, "addressed rewrite", "shared") });
    expect(put.status, (await put.text()).slice(0, 200)).toBe(403);
    expect((await stored(pred))?.visibility).toBe("private");
  }, 60_000);
});

describe("a write grant does not include changing a memory's visibility", () => {
  it("PUT /Memory: a grantee's successor naming visibility private on a shared memory is refused", async () => {
    const pred = await ownerMemory("put-mem-private", "standard", "shared");
    const succ = `gv-succ-${randomUUID()}`;
    const res = await send(grantee, "PUT", `/Memory/${succ}`, memorySuccessor(succ, pred, "put-mem-private grantee text", "standard", "private"));
    await expectRefused(res, pred, succ, false);
  }, 60_000);

  it("PUT /Memory: a grantee's successor naming visibility shared on a private memory is refused", async () => {
    const pred = await ownerMemory("put-mem-shared", "persistent", "private");
    const succ = `gv-succ-${randomUUID()}`;
    const res = await send(grantee, "PUT", `/Memory/${succ}`, memorySuccessor(succ, pred, "put-mem-shared grantee text", "persistent", "shared"));
    await expectRefused(res, pred, succ, false);
  }, 60_000);

  it("POST /Memory: a grantee's successor naming visibility private on a shared memory is refused", async () => {
    const pred = await ownerMemory("post-mem-private", "standard", "shared");
    const succ = `gv-succ-${randomUUID()}`;
    const res = await send(grantee, "POST", "/Memory", memorySuccessor(succ, pred, "post-mem-private grantee text", "standard", "private"));
    await expectRefused(res, pred, succ, false);
  }, 60_000);

  it("POST /Memory: a grantee's successor naming visibility shared on a private memory is refused", async () => {
    const pred = await ownerMemory("post-mem-shared", "persistent", "private");
    const succ = `gv-succ-${randomUUID()}`;
    const res = await send(grantee, "POST", "/Memory", memorySuccessor(succ, pred, "post-mem-shared grantee text", "persistent", "shared"));
    await expectRefused(res, pred, succ, false);
  }, 60_000);

  it("PUT /Memory: a grantee's successor that omits visibility carries the predecessor's, not the durability default", async () => {
    const pred = await ownerMemory("put-mem-omit", "standard", "shared");
    const succ = `gv-succ-${randomUUID()}`;
    const res = await send(grantee, "PUT", `/Memory/${succ}`, memorySuccessor(succ, pred, "put-mem-omit grantee text", "standard"));
    const text = await res.text();
    expect(res.status, `granted successor returned ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
    expect((await stored(succ))?.visibility, "successor visibility").toBe("shared");
    expect((await stored(pred))?.validTo, "the predecessor was not closed").toBeTruthy();
  }, 60_000);

  it("POST /Memory: a grantee's successor that omits visibility carries the predecessor's, not the durability default", async () => {
    const pred = await ownerMemory("post-mem-omit", "persistent", "private");
    const succ = `gv-succ-${randomUUID()}`;
    const res = await send(grantee, "POST", "/Memory", memorySuccessor(succ, pred, "post-mem-omit grantee text", "persistent"));
    const text = await res.text();
    expect(res.status, `granted successor returned ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
    expect((await stored(succ))?.visibility, "successor visibility").toBe("private");
  }, 60_000);

  it("PUT /Memory: a grantee's ephemeral successor of a shared memory carries shared, which the ephemeral tier refuses", async () => {
    const pred = await ownerMemory("put-mem-ephemeral", "standard", "shared");
    const succ = `gv-succ-${randomUUID()}`;
    const res = await send(grantee, "PUT", `/Memory/${succ}`, memorySuccessor(succ, pred, "put-mem-ephemeral grantee text", "ephemeral"));
    const text = await res.text();
    expect(res.status, `grantee write returned ${res.status}: ${text.slice(0, 300)}`).toBe(400);
    expect(JSON.parse(text).error).toBe("invalid_visibility_for_durability");
    expect(await stored(succ), "a successor row was written").toBeNull();
    expect((await stored(pred))?.validTo ?? null, "the predecessor was closed").toBeNull();
  }, 60_000);

  it("control: the owner's successor and the owner's own update may change visibility", async () => {
    const pred = await ownerMemory("owner-mem", "standard", "private");
    const succ = `gv-succ-${randomUUID()}`;
    const res = await send(owner, "PUT", `/Memory/${succ}`, { ...memory(succ, owner.id, "owner-mem owner successor", "standard", "shared"), supersedes: pred });
    expect(res.status, (await res.text()).slice(0, 300)).toBeLessThan(300);
    expect((await stored(succ))?.visibility).toBe("shared");
    const patch = await send(owner, "PATCH", `/Memory/${succ}`, { visibility: "private" });
    expect(patch.status, (await patch.text()).slice(0, 300)).toBeLessThan(300);
    expect((await stored(succ))?.visibility).toBe("private");
  }, 60_000);

  it("control: a Basic administrator's successor may change visibility", async () => {
    const pred = await ownerMemory("admin-mem", "standard", "private");
    const succ = `gv-succ-${randomUUID()}`;
    const res = await basicSend("PUT", `/Memory/${succ}`, { ...memory(succ, owner.id, "admin-mem admin successor", "standard", "shared"), supersedes: pred });
    expect(res.status, (await res.text()).slice(0, 300)).toBeLessThan(300);
    expect((await stored(succ))?.visibility).toBe("shared");
  }, 60_000);

  it("control: the grantee may later change its own ordinary successor's visibility as that row's owner", async () => {
    const pred = await ownerMemory("later-owner-write", "standard", "private");
    const succ = `gv-succ-${randomUUID()}`;
    const res = await send(grantee, "PUT", `/Memory/${succ}`, memorySuccessor(succ, pred, "later-owner-write grantee text", "standard"));
    expect(res.status, (await res.text()).slice(0, 300)).toBeLessThan(300);
    const row = await stored(succ);
    expect([row?.agentId, row?.visibility], "the successor is the grantee's row with the carried visibility").toEqual([grantee.id, "private"]);
    const patch = await send(grantee, "PATCH", `/Memory/${succ}`, { visibility: "shared" });
    expect(patch.status, (await patch.text()).slice(0, 300)).toBeLessThan(300);
    expect((await stored(succ))?.visibility).toBe("shared");
    expect((await stored(pred))?.visibility, "the owner's predecessor keeps its visibility").toBe("private");
  }, 60_000);

  it("control: the grantee sets visibility on its own memory without a predecessor", async () => {
    const id = `gv-own-${randomUUID()}`;
    const res = await send(grantee, "PUT", `/Memory/${id}`, memory(id, grantee.id, "grantee own text", "standard", "shared"));
    expect(res.status, (await res.text()).slice(0, 300)).toBeLessThan(300);
    const patch = await send(grantee, "PATCH", `/Memory/${id}`, { visibility: "private" });
    expect(patch.status, (await patch.text()).slice(0, 300)).toBeLessThan(300);
    expect((await stored(id))?.visibility).toBe("private");
  }, 60_000);

  it("control: PATCH addressed at the owner's memory row stays refused for the grantee", async () => {
    const pred = await ownerMemory("addressed-mem", "standard", "private");
    const patch = await send(grantee, "PATCH", `/Memory/${pred}`, { visibility: "shared" });
    expect(patch.status, (await patch.text()).slice(0, 200)).toBe(403);
    expect((await stored(pred))?.visibility).toBe("private");
  }, 60_000);
});
