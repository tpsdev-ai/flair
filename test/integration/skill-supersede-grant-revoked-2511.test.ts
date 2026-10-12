/**
 * skill-supersede-grant-revoked-2511.test.ts — flair#2511, real Harper.
 *
 * A grant-authorized cross-agent close of a SKILL version stands on a
 * "write" MemoryGrant the authorization check reads once. The close runs in the
 * version transaction and stages its write before that transaction commits; a
 * grant revoked and committed in that window is invisible to the authorization
 * read. Every caller of the shared skill-version writer passes the grant a
 * cross-agent close stands on, and the writer re-checks it on committed state
 * after it stages the close — through the shared write-back helper the non-skill
 * close uses (flair#2333 H10) — and refuses the whole write when a revocation is
 * visible: no close, no successor, no version row.
 *
 * These cases hold the skill close after its write is staged (the
 * "skill-close-staged" test pause, enabled by FLAIR_ENABLE_TEST_FAULT_INJECTION
 * and FLAIR_TEST_PAUSE_DIR, set for this file's Harper only), revoke the grant so
 * the revocation is committed, release the close, and assert the refusal and
 * that nothing was written. They cover each caller of the writer that can close
 * another agent's row: a supersede through PUT /Memory, a supersede through
 * POST /FeedMemories, and a DELETE whose live head is another agent's row.
 * Control cases show that each lands with the grant intact, and that a
 * same-agent supersede and an operator (Basic admin) supersede still land.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { HarperInstance, startHarper, stopHarper } from "../helpers/harper-lifecycle";

const POINT = "skill-close-staged";

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
function assertOwnInstance(harper: HarperInstance): void {
  const http = new URL(harper.httpURL);
  const ops = new URL(harper.opsURL);
  for (const u of [http, ops]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !harper.process?.pid || !harper.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${harper.httpURL} / ${harper.opsURL} is not an instance this test started`);
  }
}
async function authSend(harper: HarperInstance, agent: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { Authorization: ed25519Header(agent, method, path), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function basicSend(harper: HarperInstance, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(op),
  });
}
async function seedAgent(harper: HarperInstance, agent: TestAgent): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(res.status, `seed agent returned ${res.status}`).toBe(200);
}
async function grantWrite(harper: HarperInstance, ownerId: string, granteeId: string): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "MemoryGrant",
    records: [{ id: `${ownerId}:${granteeId}:write`, ownerId, granteeId, scope: "write", createdAt: new Date().toISOString() }],
  });
  expect(res.status, `write-grant insert returned ${res.status}`).toBe(200);
}
async function revokeWrite(harper: HarperInstance, ownerId: string, granteeId: string): Promise<number> {
  const res = await adminOp(harper, {
    operation: "delete", database: "flair", table: "MemoryGrant", ids: [`${ownerId}:${granteeId}:write`],
  });
  return res.status;
}
async function changeOwner(harper: HarperInstance, id: string, agentId: string): Promise<void> {
  const res = await adminOp(harper, { operation: "update", database: "flair", table: "Memory", records: [{ id, agentId }] });
  expect(res.status, `owner change of ${id} returned ${res.status}`).toBe(200);
}
async function readMemory(harper: HarperInstance, id: string): Promise<any> {
  const res = await adminOp(harper, { operation: "search_by_id", database: "flair", table: "Memory", ids: [id], get_attributes: ["*"] });
  const text = await res.text();
  expect(res.status, `search_by_id returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
  return (JSON.parse(text) as any[])[0] ?? null;
}
async function versionCount(harper: HarperInstance, subjectId: string): Promise<number> {
  const res = await adminOp(harper, {
    operation: "search_by_value", database: "flair", table: "InstructionVersion",
    search_attribute: "subjectId", search_value: subjectId, get_attributes: ["id"],
  });
  expect(res.status, `InstructionVersion search returned ${res.status}`).toBe(200);
  return (JSON.parse(await res.text()) as any[]).length;
}
function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (existsSync(path)) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  })();
}

/**
 * Arm the pause at `point`, start `write`, and once the skill close is paused
 * run `compete`, then release. Returns the write response and how the pause
 * ended.
 */
async function withPausedClose<T>(write: () => Promise<Response>, compete: () => Promise<T>) {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${POINT}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${POINT}`), "");
  const pending = write();
  const paused = await waitFor(join(pauseDir, `paused.${POINT}`), 15_000);
  let competed: T | undefined;
  try {
    if (paused) competed = await compete();
  } finally {
    writeFileSync(join(pauseDir, `go.${POINT}`), "");
  }
  const response = await pending;
  const released = paused ? readFileSync(join(pauseDir, `released.${POINT}`), "utf8") : "never paused";
  return { response, competed, released };
}

let harper: HarperInstance;
let pauseDir: string;
const owner = mkAgent("s2511-owner");
const grantee = mkAgent("s2511-grantee");
const skills: Record<string, string> = {};

const skillBody = (id: string, content: string) => ({
  id, agentId: owner.id, content, trigger: `when to ${content}`, tags: ["skill"], durability: "persistent",
});
const successorBody = (id: string, agentId: string, supersedes: string, content: string) => ({
  id, agentId, supersedes, content, trigger: `when to ${content}`, tags: ["skill"], durability: "persistent",
});

beforeAll(async () => {
  pauseDir = mkdtempSync(join(tmpdir(), "flair-s2511-pause-"));
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
  await seedAgent(harper, owner);
  await seedAgent(harper, grantee);
  // Each case gets its own owner-owned skill head to supersede.
  for (const label of ["control", "revoked", "same-agent", "operator", "feed-control", "feed-revoked"]) {
    const id = `s2511-${label}`;
    const created = await authSend(harper, owner, "PUT", `/Memory/${id}`, skillBody(id, `first ${label} skill version`));
    const text = await created.text();
    expect(created.status, `skill create ${label} returned ${created.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
    skills[label] = id;
  }
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
});

describe("flair#2511 — a grant-authorized cross-agent skill-version supersede re-checks its write grant (real Harper)", () => {
  it("control: with the grant intact the cross-agent supersede closes the predecessor and appends a version", async () => {
    await grantWrite(harper, owner.id, grantee.id);
    const successorId = "s2511-control-successor";
    const res = await authSend(harper, grantee, "PUT", `/Memory/${successorId}`, successorBody(successorId, grantee.id, skills.control, "second control skill version"));
    const text = await res.text();
    expect(res.status, `granted supersede returned ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
    expect(JSON.parse(text).id).toBe(successorId);
    const predecessor = await readMemory(harper, skills.control);
    expect(predecessor?.validTo, "the predecessor was not closed under an intact grant").toBeTruthy();
    expect(await readMemory(harper, successorId), "the successor row was not written").not.toBeNull();
    expect(await versionCount(harper, skills.control), "the supersede appended no version").toBe(2);
  }, 60_000);

  it("a grant revocation committed before the staged re-check refuses the write: no close, no successor, no version", async () => {
    await grantWrite(harper, owner.id, grantee.id);
    const successorId = "s2511-revoked-successor";
    const { response, competed, released } = await withPausedClose(
      () => authSend(harper, grantee, "PUT", `/Memory/${successorId}`, successorBody(successorId, grantee.id, skills.revoked, "second revoked skill version")),
      () => revokeWrite(harper, owner.id, grantee.id),
    );
    expect(released, "the skill close was not paused and released by this test").toBe("go");
    expect(competed, "the competing grant revocation failed").toBe(200);
    const text = await response.text();
    expect(response.status, `revoked supersede returned ${response.status}: ${text.slice(0, 300)}`).toBe(409);
    expect(JSON.parse(text).error, "revoked supersede refusal error").toBe("granted_close_revoked");
    const predecessor = await readMemory(harper, skills.revoked);
    expect(predecessor?.validTo ?? null, "the close landed after the authorizing grant was revoked").toBeNull();
    expect(await readMemory(harper, successorId), "the successor row was written despite the revoked grant").toBeNull();
    expect(await versionCount(harper, skills.revoked), "a version row was appended despite the revoked grant").toBe(1);
  }, 60_000);

  it("control: a same-agent skill supersede is unaffected", async () => {
    const successorId = "s2511-same-agent-successor";
    const res = await authSend(harper, owner, "PUT", `/Memory/${successorId}`, successorBody(successorId, owner.id, skills["same-agent"], "second same-agent skill version"));
    const text = await res.text();
    expect(res.status, `same-agent supersede returned ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
    expect((await readMemory(harper, skills["same-agent"]))?.validTo, "the same-agent close did not land").toBeTruthy();
    expect(await versionCount(harper, skills["same-agent"]), "the same-agent supersede appended no version").toBe(2);
  }, 60_000);

  it("control: an operator (Basic admin) skill supersede of another agent's row is unaffected", async () => {
    const successorId = "s2511-operator-successor";
    const res = await basicSend(harper, "PUT", `/Memory/${successorId}`, successorBody(successorId, owner.id, skills.operator, "second operator skill version"));
    const text = await res.text();
    expect(res.status, `operator supersede returned ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
    expect((await readMemory(harper, skills.operator))?.validTo, "the operator close did not land").toBeTruthy();
    expect(await versionCount(harper, skills.operator), "the operator supersede appended no version").toBe(2);
  }, 60_000);
});

describe("flair#2511 — a grant-authorized cross-agent skill supersede through POST /FeedMemories re-checks its write grant (real Harper)", () => {
  const feedBody = (id: string, supersedes: string, content: string) => ({
    id, agentId: grantee.id, supersedes, content, trigger: `when to ${content}`, tags: ["skill"], durability: "persistent",
  });

  it("control: with the grant intact the feed's cross-agent supersede closes the predecessor and appends a version", async () => {
    await grantWrite(harper, owner.id, grantee.id);
    const successorId = "s2511-feed-control-successor";
    const res = await authSend(harper, grantee, "POST", "/FeedMemories", feedBody(successorId, skills["feed-control"], "second feed-control skill version"));
    const text = await res.text();
    expect(res.status, `granted feed supersede returned ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
    expect(JSON.parse(text).id).toBe(successorId);
    expect((await readMemory(harper, skills["feed-control"]))?.validTo, "the predecessor was not closed under an intact grant").toBeTruthy();
    const successor = await readMemory(harper, successorId);
    expect(successor, "the successor row was not written").not.toBeNull();
    expect(successor?.agentId, "the successor does not keep the skill owner").toBe(owner.id);
    expect(await versionCount(harper, skills["feed-control"]), "the feed supersede appended no version").toBe(2);
  }, 60_000);

  it("a grant revocation committed before the staged re-check refuses the feed write: no close, no successor, no version", async () => {
    await grantWrite(harper, owner.id, grantee.id);
    const successorId = "s2511-feed-revoked-successor";
    const { response, competed, released } = await withPausedClose(
      () => authSend(harper, grantee, "POST", "/FeedMemories", feedBody(successorId, skills["feed-revoked"], "second feed-revoked skill version")),
      () => revokeWrite(harper, owner.id, grantee.id),
    );
    expect(released, "the feed's skill close was not paused and released by this test").toBe("go");
    expect(competed, "the competing grant revocation failed").toBe(200);
    const text = await response.text();
    expect(response.status, `revoked feed supersede returned ${response.status}: ${text.slice(0, 300)}`).toBe(409);
    expect(JSON.parse(text).error, "revoked feed supersede refusal error").toBe("granted_close_revoked");
    expect((await readMemory(harper, skills["feed-revoked"]))?.validTo ?? null, "the feed's close landed after the authorizing grant was revoked").toBeNull();
    expect(await readMemory(harper, successorId), "the feed's successor row was written despite the revoked grant").toBeNull();
    expect(await versionCount(harper, skills["feed-revoked"]), "the feed appended a version row despite the revoked grant").toBe(1);
  }, 60_000);
});

describe("flair#2511 — a grant-authorized DELETE that closes another agent's skill head re-checks its write grant (real Harper)", () => {
  /**
   * The grantee creates a skill and updates it, so its first row is closed (a
   * stale id) and the update's successor is the live head; an operator then
   * reassigns the head to the owner. A DELETE of the stale id closes the live
   * head — another agent's row — which the owner's "write" grant authorizes.
   */
  async function lineageWithOwnerHead(label: string): Promise<{ staleId: string; headId: string }> {
    const staleId = `s2511-${label}`;
    const body = (content: string) => ({
      id: staleId, agentId: grantee.id, content, trigger: `when to ${content}`, tags: ["skill"], durability: "persistent",
    });
    const created = await authSend(harper, grantee, "PUT", `/Memory/${staleId}`, body(`first ${label} skill version`));
    expect(created.status, `skill create returned ${created.status}: ${(await created.text()).slice(0, 300)}`).toBeLessThan(300);
    const updated = await authSend(harper, grantee, "PUT", `/Memory/${staleId}`, body(`second ${label} skill version`));
    const text = await updated.text();
    expect(updated.status, `skill update returned ${updated.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
    const headId = String(JSON.parse(text).id);
    expect(headId, "the update did not write a successor row").not.toBe(staleId);
    expect((await readMemory(harper, staleId))?.validTo, "the addressed row is not closed").toBeTruthy();
    await changeOwner(harper, headId, owner.id);
    return { staleId, headId };
  }

  it("control: with the grant intact the delete closes the other agent's head and appends a version", async () => {
    const { staleId, headId } = await lineageWithOwnerHead("delete-control");
    await grantWrite(harper, owner.id, grantee.id);
    const res = await authSend(harper, grantee, "DELETE", `/Memory/${staleId}`);
    const text = await res.text();
    expect(res.status, `granted DELETE returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
    expect(JSON.parse(text).id, "the delete closed a row other than the live head").toBe(headId);
    expect((await readMemory(harper, headId))?.validTo, "the head was not closed under an intact grant").toBeTruthy();
    expect(await versionCount(harper, staleId), "the delete appended no version").toBe(3);
  }, 60_000);

  it("a grant revocation committed before the staged re-check refuses the delete: the head stays open, no version", async () => {
    const { staleId, headId } = await lineageWithOwnerHead("delete-revoked");
    await grantWrite(harper, owner.id, grantee.id);
    const { response, competed, released } = await withPausedClose(
      () => authSend(harper, grantee, "DELETE", `/Memory/${staleId}`),
      () => revokeWrite(harper, owner.id, grantee.id),
    );
    expect(released, "the delete's close was not paused and released by this test").toBe("go");
    expect(competed, "the competing grant revocation failed").toBe(200);
    const text = await response.text();
    expect(response.status, `revoked DELETE returned ${response.status}: ${text.slice(0, 300)}`).toBe(409);
    expect(JSON.parse(text).error, "revoked DELETE refusal error").toBe("granted_close_revoked");
    const head = await readMemory(harper, headId);
    expect(head, "the head row is gone").not.toBeNull();
    expect(head?.validTo ?? null, "the delete closed the head after the authorizing grant was revoked").toBeNull();
    expect(await versionCount(harper, staleId), "the delete appended a version row despite the revoked grant").toBe(2);
  }, 60_000);
});
