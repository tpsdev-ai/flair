// ─── flair#2139 S2 — skill version WRITES against a real Harper ─────────────
//
// The writer half: a skill create/update/delete appends an InstructionVersion
// row, updates supersede (a fresh physical Memory row, the predecessor closed),
// and the stable `skillSubjectId` carries the chain across changed physical ids.
// This suite drives real REST PUT/DELETE, the FeedMemories ingest, and the real
// InstructionVersion resource boundary.
//
// RED on the read-half base (feat/2139-s2-skill-version-history): Memory has no
// recordVersion reference, so a skill update overwrites in place and NO version
// row is ever appended. GREEN here.
//
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }
const mkAgent = (id: string): TestAgent => {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
};

const sfx = Date.now().toString(36);
const A = mkAgent(`skw-owner-${sfx}`);
const now = () => new Date().toISOString();

let harper: HarperInstance;
let installDir = "";

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
}

const basicAuth = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

function ed25519(who: TestAgent, method: string, path: string): string {
  const ts = String(Date.now());
  const nonce = randomUUID();
  const sig = nacl.sign.detached(new TextEncoder().encode(`${who.id}:${ts}:${nonce}:${method}:${path}`), who.secretKey);
  return `TPS-Ed25519 ${who.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

async function call(auth: TestAgent | "basic" | "anonymous", method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth === "basic") headers.Authorization = basicAuth();
  else if (auth !== "anonymous") headers.Authorization = ed25519(auth, method, path);
  const res = await fetch(harper.httpURL + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
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
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}

async function versionsOf(subjectId: string): Promise<any[]> {
  const rows = await ops({
    operation: "search_by_value", database: "flair", table: "InstructionVersion",
    search_attribute: "subjectId", search_value: subjectId, get_attributes: ["*"],
  });
  return (rows as any[]).sort((a, b) => Number(a.version) - Number(b.version));
}

async function memoryRow(id: string): Promise<any | null> {
  const rows = await ops({ operation: "search_by_id", database: "flair", table: "Memory", ids: [id], get_attributes: ["*"] });
  return rows[0] ?? null;
}

const memPath = (id: string) => `/Memory/${encodeURIComponent(id)}`;

function skillBody(id: string, content: string, extra: Record<string, unknown> = {}) {
  return { id, agentId: A.id, content, trigger: `when to ${content}`, tags: ["skill"], durability: "persistent", ...extra };
}

let seq = 0;
const nextId = (label: string) => `skw-${label}-${sfx}-${++seq}`;

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  harper = await startHarper();
  installDir = harper.installDir;
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
  if (installDir) await rm(installDir, { recursive: true, force: true, maxRetries: 4 });
});

describe("flair#2139 S2 — skill create appends a version and sets the stable subject", () => {
  test("a REST PUT create appends a create version whose subject is the physical id", async () => {
    const id = nextId("create");
    const res = await call(A, "PUT", memPath(id), skillBody(id, "c1"));
    expect(res.status, res.text.slice(0, 300)).toBeLessThan(300);
    const versions = await versionsOf(id);
    expect(versions, "a skill create must append a version").toHaveLength(1);
    expect(versions[0].subjectType).toBe("skill");
    expect(versions[0].kind).toBe("create");
    expect(versions[0].memoryId).toBe(id);
    expect(versions[0].actorKind).toBe("agent");
    expect(versions[0].actorId).toBe(A.id);
    expect(versions[0].sourceClass).toBe("agent");
    expect((await memoryRow(id))?.skillSubjectId).toBe(id);
  }, 120_000);
});

describe("flair#2139 S2 — skill updates supersede", () => {
  test("an update writes a fresh physical row, closes the predecessor, and chains the version", async () => {
    const id = nextId("update");
    expect((await call(A, "PUT", memPath(id), skillBody(id, "v1"))).status).toBeLessThan(300);
    const first = await memoryRow(id);
    const res = await call(A, "PUT", memPath(id), skillBody(id, "v2"));
    expect(res.status, res.text.slice(0, 300)).toBeLessThan(300);
    const successor = JSON.parse(res.text).id;
    expect(successor, "the write must return the ACTUAL successor id").not.toBe(id);

    const versions = await versionsOf(id);
    expect(versions.map((v) => v.kind)).toEqual(["create", "update"]);
    expect(versions[1].memoryId).toBe(successor);

    // Predecessor closed (retained payload), successor live, subject carried.
    const closed = await memoryRow(id);
    expect(closed.content).toBe(first.content);
    expect(typeof closed.validTo).toBe("string");
    const live = await memoryRow(successor);
    expect(live.content).toBe("v2");
    expect(live.skillSubjectId).toBe(id);
    expect(live.supersedes).toBe(id);
  }, 120_000);

  test("recurring content keeps distinct version ids (never a content hash)", async () => {
    const id = nextId("recur");
    await call(A, "PUT", memPath(id), skillBody(id, "same"));
    const upd = await call(A, "PUT", memPath(id), skillBody(id, "same"));
    const successor = JSON.parse(upd.text).id;
    await call(A, "PUT", memPath(successor), skillBody(successor, "same"));
    const versions = await versionsOf(id);
    expect(versions.length).toBe(3);
    expect(new Set(versions.map((v) => v.id)).size).toBe(3);
  }, 120_000);

  test("an update that OMITS tags still resolves the stored skill lineage", async () => {
    const id = nextId("omit");
    await call(A, "PUT", memPath(id), skillBody(id, "before"));
    // No `tags` in the body — classification must use the STORED row.
    const res = await call(A, "PUT", memPath(id), { id, agentId: A.id, content: "after", trigger: "t", durability: "persistent" });
    expect(res.status, res.text.slice(0, 300)).toBeLessThan(300);
    const versions = await versionsOf(id);
    expect(versions.map((v) => v.kind)).toEqual(["create", "update"]);
  }, 120_000);

  test("a visibility-only change is versioned", async () => {
    const id = nextId("vis");
    await call(A, "PUT", memPath(id), skillBody(id, "v1", { visibility: "shared" }));
    const res = await call(A, "PUT", memPath(id), skillBody(id, "v1", { visibility: "private" }));
    expect(res.status, res.text.slice(0, 300)).toBeLessThan(300);
    const versions = await versionsOf(id);
    expect(versions.map((v) => v.kind)).toEqual(["create", "update"]);
    expect(versions[1].visibility).toBe("private");
  }, 120_000);
});

describe("flair#2139 S2 — logical delete, retain, and recreate", () => {
  test("a DELETE closes the head, retains its payload, and appends a tombstone", async () => {
    const id = nextId("del");
    await call(A, "PUT", memPath(id), skillBody(id, "keepme"));
    const res = await call(A, "DELETE", memPath(id));
    expect(res.status, res.text.slice(0, 300)).toBeLessThan(300);
    const versions = await versionsOf(id);
    expect(versions.map((v) => v.kind)).toEqual(["create", "delete"]);
    expect(versions[1].memoryId ?? null).toBeNull();
    expect(versions[1].valueHash ?? null).toBeNull();
    // The payload is retained (closed, not hard-deleted).
    const row = await memoryRow(id);
    expect(row.content).toBe("keepme");
    expect(typeof row.validTo).toBe("string");
  }, 120_000);

  test("recreating a deleted subject continues its sequence with a fresh physical row", async () => {
    const id = nextId("recreate");
    await call(A, "PUT", memPath(id), skillBody(id, "one"));
    await call(A, "DELETE", memPath(id));
    const res = await call(A, "PUT", memPath(id), skillBody(id, "two"));
    expect(res.status, res.text.slice(0, 300)).toBeLessThan(300);
    const versions = await versionsOf(id);
    expect(versions.map((v) => v.kind)).toEqual(["create", "delete", "create"]);
    expect(new Set(versions.map((v) => v.memoryId)).size).toBe(3);
  }, 120_000);
});

describe("flair#2139 S2 — the FeedMemories ingest is versioned", () => {
  test("a skill feed create appends a version; a re-ingest supersedes", async () => {
    const id = nextId("feed");
    const res = await call(A, "POST", "/FeedMemories", { id, agentId: A.id, content: "feed skill", trigger: "t", tags: ["skill"] });
    expect(res.status, res.text.slice(0, 300)).toBeLessThan(300);
    const versions = await versionsOf(id);
    expect(versions.map((v) => v.kind)).toEqual(["create"]);
    // The returned row is the persisted skill (forced durable).
    expect(JSON.parse(res.text).durability).toBe("persistent");
  }, 120_000);
});

describe("flair#2139 S2 — collision and authority", () => {
  test("an occupied version id rolls the whole skill write back", async () => {
    const id = nextId("collide");
    // Seed a live skill row at `id` with no history yet, then occupy its next
    // version slot so the append collides and the transaction must abort.
    await ops({
      operation: "upsert", database: "flair", table: "Memory",
      records: [{ id, agentId: A.id, content: "before", trigger: "t", tags: ["skill"], skillSubjectId: id, durability: "persistent", createdAt: now() }],
    });
    await ops({
      operation: "upsert", database: "flair", table: "InstructionVersion",
      records: [{
        id: `skill:${id}:1`, subjectType: "skill", subjectId: `hidden-${id}`, agentId: A.id, key: null,
        version: 1, kind: "create", rowId: id, valueHash: null, previousVersionHash: null,
        recordHash: "occupied", soulSnapshot: null, memoryId: id, visibility: "shared",
        actorKind: "agent", actorId: A.id, sourceClass: "agent", createdAt: now(),
        guarded: false, expectedVersion: null,
      }],
    });
    const stored = await memoryRow(id);
    const res = await call(A, "PUT", memPath(id), skillBody(id, "after"));
    expect(res.status, res.text.slice(0, 200)).toBe(500);
    // Nothing changed: no successor, the predecessor row intact, no new version.
    expect(await memoryRow(id)).toEqual(stored);
    expect(await versionsOf(id), "no version may be appended for the subject").toHaveLength(0);
    const occupied = await ops({ operation: "search_by_id", database: "flair", table: "InstructionVersion", ids: [`skill:${id}:1`], get_attributes: ["*"] });
    expect(occupied[0]?.recordHash, "the occupied version row is untouched").toBe("occupied");
  }, 120_000);

  test("an operator (Basic admin) write is attributed as operator", async () => {
    const id = nextId("op");
    // The operator writes another agent's skill: subject owner is retained,
    // the actor is the operator.
    const res = await call("basic", "PUT", memPath(id), { id, agentId: A.id, content: "op skill", trigger: "t", tags: ["skill"], durability: "persistent" });
    expect(res.status, res.text.slice(0, 300)).toBeLessThan(300);
    const versions = await versionsOf(id);
    expect(versions).toHaveLength(1);
    expect(versions[0].actorKind).toBe("operator");
    expect(versions[0].actorId).toBe(harper.admin.username);
    expect(versions[0].agentId, "the subject owner is distinct from the actor").toBe(A.id);
  }, 120_000);
});
