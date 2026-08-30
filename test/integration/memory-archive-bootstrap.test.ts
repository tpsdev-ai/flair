// memory-archive-bootstrap.test.ts — flair#1472 Deliverable A acceptance.
//
// Makes the `archived` boolean real end-to-end:
//   1. MemoryBootstrap honors `archived` (the three query paths now exclude
//      archived records — the headline bug: a retired permanent memory was
//      force-injected into bootstrap every session).
//   2. A user-facing basement/restore action exists (POST /MemoryArchive) and
//      is scoped to the caller's own lane.
//
// Acceptance a–f (each must FAIL on main before the fix):
//   a. durability:permanent + archived:true is ABSENT from bootstrap.
//   b. security-tagged memories basemented → none in bootstrap; restored → all
//      present (assert the set difference).
//   c. basement → memory_get still returns it; default search does NOT;
//      search(includeArchived:true) does; restore is lossless and leaves
//      durability unchanged (orthogonality).
//   d. positive control: an unarchived permanent memory still appears.
//   e. own-lane scope: a caller cannot basement another agent's memory.
//   f. mutation-check: every test here is a real assertion (no vacuous pass).
//
// Pattern: test/integration/bootstrap-supersede-resurface.test.ts.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

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

async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(op),
  });
}

async function registerAgent(harper: HarperInstance, agent: TestAgent): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(res.status, `Agent insert for ${agent.id} returned ${res.status}`).toBe(200);
}

async function putMemory(harper: HarperInstance, agent: TestAgent, id: string, body: Record<string, any>): Promise<Response> {
  const path = `/Memory/${id}`;
  return fetch(`${harper.httpURL}${path}`, {
    method: "PUT",
    headers: { Authorization: ed25519Header(agent, "PUT", path), "Content-Type": "application/json" },
    body: JSON.stringify({ id, ...body }),
  });
}

async function getMemory(harper: HarperInstance, agent: TestAgent, id: string): Promise<Response> {
  const path = `/Memory/${id}`;
  return fetch(`${harper.httpURL}${path}`, {
    headers: { Authorization: ed25519Header(agent, "GET", path) },
  });
}

async function archive(harper: HarperInstance, agent: TestAgent, id: string, action: "basement" | "restore"): Promise<Response> {
  const path = "/MemoryArchive";
  return fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
    body: JSON.stringify({ id, action }),
  });
}

async function search(harper: HarperInstance, agent: TestAgent, body: Record<string, any>): Promise<any> {
  const path = "/SemanticSearch";
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  expect(res.status, `SemanticSearch → ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}

async function bootstrap(harper: HarperInstance, agent: TestAgent, body: Record<string, any>): Promise<any> {
  const path = "/BootstrapMemories";
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  expect(res.status, `BootstrapMemories → ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}

let harper: HarperInstance;
const owner = mkAgent(`archive-owner-${randomUUID()}`);
const other = mkAgent(`archive-other-${randomUUID()}`);

// Distinctive content markers so bootstrap-context substring assertions are
// unambiguous and the search query is a close paraphrase of the content.
const PERM_ARCHIVED = `${owner.id}-perm-archived`;
const PERM_LIVE = `${owner.id}-perm-live`;
const SEC_A = `${owner.id}-sec-a`;
const SEC_B = `${owner.id}-sec-b`;
const ROUNDTRIP = `${owner.id}-roundtrip`;
const OTHER_MEM = `${other.id}-owned`;

const CONTENT_PERM_ARCHIVED = "archive-1472 marker: the retired Q1 vendor contract was superseded by the Q2 master agreement.";
const CONTENT_PERM_LIVE = "archive-1472 marker: the office lease renewal was signed off by facilities in April.";
const CONTENT_SEC_A = "archive-1472 security marker: the production database root credential was rotated on Tuesday.";
const CONTENT_SEC_B = "archive-1472 security marker: the VPN gateway certificate expires at the end of the quarter.";
const CONTENT_ROUNDTRIP = "archive-1472 roundtrip marker: the annual compliance audit is scheduled for next winter.";
const CONTENT_OTHER = "archive-1472 other-lane marker: this memory belongs to a different agent entirely.";

describe("flair#1472 Deliverable A — archived is real end-to-end", () => {
  beforeAll(async () => {
    harper = await startHarper();
    await registerAgent(harper, owner);
    await registerAgent(harper, other);

    // a/d: permanent memories — one to be basemented, one left live.
    const putPermArchived = await putMemory(harper, owner, PERM_ARCHIVED, {
      agentId: owner.id, content: CONTENT_PERM_ARCHIVED, durability: "permanent",
    });
    expect(putPermArchived.status, `seed ${PERM_ARCHIVED} → ${putPermArchived.status}`).toBe(200);
    const putPermLive = await putMemory(harper, owner, PERM_LIVE, {
      agentId: owner.id, content: CONTENT_PERM_LIVE, durability: "permanent",
    });
    expect(putPermLive.status, `seed ${PERM_LIVE} → ${putPermLive.status}`).toBe(200);

    // b: security-tagged memories.
    const putSecA = await putMemory(harper, owner, SEC_A, {
      agentId: owner.id, content: CONTENT_SEC_A, durability: "standard", tags: ["security"],
    });
    expect(putSecA.status, `seed ${SEC_A} → ${putSecA.status}`).toBe(200);
    const putSecB = await putMemory(harper, owner, SEC_B, {
      agentId: owner.id, content: CONTENT_SEC_B, durability: "standard", tags: ["security"],
    });
    expect(putSecB.status, `seed ${SEC_B} → ${putSecB.status}`).toBe(200);

    // c: roundtrip memory (standard durability, to assert orthogonality).
    const putRoundtrip = await putMemory(harper, owner, ROUNDTRIP, {
      agentId: owner.id, content: CONTENT_ROUNDTRIP, durability: "standard",
    });
    expect(putRoundtrip.status, `seed ${ROUNDTRIP} → ${putRoundtrip.status}`).toBe(200);

    // e: a memory owned by `other`.
    const putOther = await putMemory(harper, other, OTHER_MEM, {
      agentId: other.id, content: CONTENT_OTHER, durability: "standard",
    });
    expect(putOther.status, `seed ${OTHER_MEM} → ${putOther.status}`).toBe(200);
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  test("a. a durability:permanent memory with archived=true is ABSENT from bootstrap", async () => {
    // Basement the permanent memory (the user-facing action).
    const res = await archive(harper, owner, PERM_ARCHIVED, "basement");
    expect(res.status, `basement ${PERM_ARCHIVED} → ${res.status}: ${await res.text()}`).toBe(200);

    const body = await bootstrap(harper, owner, { agentId: owner.id, maxTokens: 8000 });
    const context: string = body.context ?? "";
    expect(context, `archived permanent memory ${PERM_ARCHIVED} force-injected into bootstrap`).not.toContain(CONTENT_PERM_ARCHIVED);
  }, 60_000);

  test("d. positive control: an unarchived permanent memory still appears in bootstrap", async () => {
    const body = await bootstrap(harper, owner, { agentId: owner.id, maxTokens: 8000 });
    const context: string = body.context ?? "";
    expect(context, `live permanent memory ${PERM_LIVE} dropped from bootstrap (over-filter)`).toContain(CONTENT_PERM_LIVE);
  }, 60_000);

  test("b. security-tagged memories: basemented → none in bootstrap; restored → all present", async () => {
    // Basement both security-tagged memories.
    for (const id of [SEC_A, SEC_B]) {
      const res = await archive(harper, owner, id, "basement");
      expect(res.status, `basement ${id} → ${res.status}: ${await res.text()}`).toBe(200);
    }

    const basemented = await bootstrap(harper, owner, { agentId: owner.id, maxTokens: 8000 });
    const basementedCtx: string = basemented.context ?? "";
    expect(basementedCtx, `basemented security memory ${SEC_A} still in bootstrap`).not.toContain(CONTENT_SEC_A);
    expect(basementedCtx, `basemented security memory ${SEC_B} still in bootstrap`).not.toContain(CONTENT_SEC_B);

    // Restore both.
    for (const id of [SEC_A, SEC_B]) {
      const res = await archive(harper, owner, id, "restore");
      expect(res.status, `restore ${id} → ${res.status}: ${await res.text()}`).toBe(200);
    }

    const restored = await bootstrap(harper, owner, { agentId: owner.id, maxTokens: 8000 });
    const restoredCtx: string = restored.context ?? "";
    expect(restoredCtx, `restored security memory ${SEC_A} missing from bootstrap`).toContain(CONTENT_SEC_A);
    expect(restoredCtx, `restored security memory ${SEC_B} missing from bootstrap`).toContain(CONTENT_SEC_B);
  }, 60_000);

  test("c. basement → get returns it; default search excludes; includeArchived includes; restore is lossless + durability unchanged", async () => {
    // Basement the roundtrip memory.
    const basementRes = await archive(harper, owner, ROUNDTRIP, "basement");
    expect(basementRes.status, `basement ${ROUNDTRIP} → ${basementRes.status}`).toBe(200);

    // memory_get still returns it, with archived=true.
    const getAfterBasement = await getMemory(harper, owner, ROUNDTRIP);
    expect(getAfterBasement.status).toBe(200);
    const recArchived: any = await getAfterBasement.json();
    expect(recArchived.archived, "basement must set archived=true").toBe(true);
    expect(recArchived.archivedAt, "basement must stamp archivedAt").toBeTruthy();

    // Default search does NOT return it.
    const defaultSearch = await search(harper, owner, { agentId: owner.id, q: "annual compliance audit schedule", limit: 20 });
    const defaultIds = (defaultSearch.results ?? []).map((r: any) => r.id);
    expect(defaultIds, `archived memory ${ROUNDTRIP} returned by default search`).not.toContain(ROUNDTRIP);

    // includeArchived:true DOES return it.
    const archivedSearch = await search(harper, owner, { agentId: owner.id, q: "annual compliance audit schedule", limit: 20, includeArchived: true });
    const archivedIds = (archivedSearch.results ?? []).map((r: any) => r.id);
    expect(archivedIds, `archived memory ${ROUNDTRIP} missing from includeArchived search`).toContain(ROUNDTRIP);

    // Restore is lossless and leaves durability unchanged.
    const restoreRes = await archive(harper, owner, ROUNDTRIP, "restore");
    expect(restoreRes.status, `restore ${ROUNDTRIP} → ${restoreRes.status}`).toBe(200);
    const getAfterRestore = await getMemory(harper, owner, ROUNDTRIP);
    expect(getAfterRestore.status).toBe(200);
    const recRestored: any = await getAfterRestore.json();
    expect(recRestored.archived, "restore must clear archived").not.toBe(true);
    expect(recRestored.archivedAt, "restore must clear archivedAt").toBeFalsy();
    expect(recRestored.durability, "restore must not change durability (orthogonality)").toBe("standard");
    expect(recRestored.content, "restore must be lossless (content unchanged)").toBe(CONTENT_ROUNDTRIP);
  }, 60_000);

  test("e. own-lane scope: a caller cannot basement another agent's memory", async () => {
    // `other` attempts to basement `owner`'s memory (and vice-versa is covered
    // by the same gate). The read-scope gate (Memory.get) or the ownership gate
    // (Memory.put) must reject — 403 or 404, never 200.
    const res = await archive(harper, other, ROUNDTRIP, "basement");
    expect(res.status, `cross-agent basement must be rejected, got ${res.status}`).not.toBe(200);

    // The memory must remain un-basemented (the write must not have landed).
    const getRes = await getMemory(harper, owner, ROUNDTRIP);
    const rec: any = await getRes.json();
    expect(rec.archived, "cross-agent basement must not mutate the target memory").not.toBe(true);
  }, 60_000);
});
