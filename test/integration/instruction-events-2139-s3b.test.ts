// ─── flair#2139 S3b — instruction-change events against a real Harper ────────
//
// The application writers append an OrgEvent by raw create (no upsert):
// soul.changed / skill.changed, id
// `instruction-change:<version id>`, refId = version id, createdAt copied from
// the version, detail built from the ten allowlisted fields only. A private
// skill's event omits the three value-derived hashes (D1), including on the
// tombstone, whose stored visibility is the closed head's last state. An event
// insert that cannot land aborts the version write and the row write with it.
//
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }
const mkAgent = (id: string): TestAgent => {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
};

const sfx = Date.now().toString(36);
const A = mkAgent(`ie-a-${sfx}`);
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

async function eventsOf(versionIds: string[]): Promise<Record<string, any>> {
  if (versionIds.length === 0) return {};
  const rows = await ops({
    operation: "search_by_id", database: "flair", table: "OrgEvent",
    ids: versionIds.map((id) => `instruction-change:${id}`), get_attributes: ["*"],
  });
  const byId = new Map<string, any>((rows as any[]).map((row) => [row.id, row]));
  return Object.fromEntries(versionIds.map((id) => [id, byId.get(`instruction-change:${id}`)]));
}

async function soulRow(id: string): Promise<any | null> {
  const rows = await ops({ operation: "search_by_id", database: "flair", table: "Soul", ids: [id], get_attributes: ["*"] });
  return rows[0] ?? null;
}

const soulPath = (id: string) => `/Soul/${encodeURIComponent(id)}`;
const memPath = (id: string) => `/Memory/${encodeURIComponent(id)}`;

async function createSoul(id: string, agentId: string, key: string, value: string): Promise<void> {
  const res = await call("basic", "POST", "/Soul/", { id, agentId, key, value, durability: "permanent" });
  expect(res.status, `Soul POST ${id}: ${res.text.slice(0, 200)}`).toBeLessThan(300);
}

function skillBody(id: string, content: string, extra: Record<string, unknown> = {}) {
  return { id, agentId: A.id, content, trigger: `when to ${content}`, tags: ["skill"], durability: "persistent", ...extra };
}

let seq = 0;
const nextId = (label: string) => `ie-${label}-${sfx}-${++seq}`;

const TEN_FIELDS = [
  "actorId", "actorKind", "changeKind", "key", "previousVersionHash", "recordHash",
  "sourceClass", "subjectId", "subjectType", "valueHash",
].sort();

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
}, HARPER_STOP_BUDGET_MS);

describe("flair#2139 S3b — Soul application-writer events", () => {
  test("create, update and delete each append exactly one event with the ten fields", async () => {
    const key = `ie-soul-${sfx}`;
    const id = `${A.id}:${key}`;
    const subjectId = `${A.id}:${key}`;
    await createSoul(id, A.id, key, "v1");
    expect((await call("basic", "PUT", soulPath(id), { id, agentId: A.id, key, value: "v2" })).status).toBeLessThan(300);
    expect((await call("basic", "DELETE", soulPath(id))).status).toBeLessThan(300);

    const versions = await versionsOf(subjectId);
    expect(versions.map((v) => v.kind)).toEqual(["create", "update", "delete"]);
    const events = await eventsOf(versions.map((v) => v.id));
    const subjectEvents = await ops({
      operation: "search_by_value", database: "flair", table: "OrgEvent",
      search_attribute: "kind", search_value: "soul.changed", get_attributes: ["*"],
    });
    expect(subjectEvents.filter((event: any) => JSON.parse(event.detail).subjectId === subjectId)).toHaveLength(versions.length);

    for (const version of versions) {
      const matching = await ops({
        operation: "search_by_value", database: "flair", table: "OrgEvent",
        search_attribute: "refId", search_value: version.id, get_attributes: ["*"],
      });
      expect(matching).toHaveLength(1);
      const event = events[version.id];
      expect(event, `no event for version ${version.id}`).toBeTruthy();
      expect(event.id).toBe(`instruction-change:${version.id}`);
      expect(event.refId).toBe(version.id);
      expect(event.kind).toBe("soul.changed");
      expect(event.scope).toBe(A.id);
      expect(event.authorId).toBe("flair:internal");
      expect(event.createdAt).toBe(version.createdAt);
      expect(event.expiresAt).toBeUndefined();
      expect(event.targetIds).toEqual([]);
      const detail = JSON.parse(event.detail);
      expect(Object.keys(detail).sort()).toEqual(TEN_FIELDS);
      expect(detail).toEqual({
        subjectType: "soul",
        subjectId: version.subjectId,
        key,
        changeKind: version.kind,
        actorKind: version.actorKind,
        actorId: version.actorId,
        sourceClass: version.sourceClass,
        valueHash: version.valueHash,
        previousVersionHash: version.previousVersionHash,
        recordHash: version.recordHash,
      });
      expect(detail.actorKind).toBe("operator");
      expect(detail.sourceClass).toBe("operator");
    }
    expect(JSON.parse(events[versions[2].id].detail).valueHash).toBeNull();
  }, 180_000);

  test("a soul identity move appends an event for the old tombstone and the new subject", async () => {
    const key = `ie-move-${sfx}`;
    const moved = `ie-moved-${sfx}`;
    const id = `${A.id}:${key}`;
    await createSoul(id, A.id, key, "old");
    const res = await call("basic", "PATCH", soulPath(id), { key: moved });
    expect(res.status, res.text.slice(0, 300)).toBeLessThan(300);

    const oldVersions = await versionsOf(`${A.id}:${key}`);
    const newVersions = await versionsOf(`${A.id}:${moved}`);
    expect(oldVersions.map((v) => v.kind)).toEqual(["create", "delete"]);
    expect(newVersions.map((v) => v.kind)).toEqual(["update"]);
    const events = await eventsOf([...oldVersions, ...newVersions].map((v) => v.id));
    for (const version of [...oldVersions, ...newVersions]) {
      expect(events[version.id], `no event for version ${version.id}`).toBeTruthy();
      expect(events[version.id].refId).toBe(version.id);
    }
    expect(JSON.parse(events[oldVersions[1].id].detail)).toMatchObject({
      subjectId: `${A.id}:${key}`, key, changeKind: "delete",
    });
    expect(JSON.parse(events[newVersions[0].id].detail)).toMatchObject({
      subjectId: `${A.id}:${moved}`, key: moved, changeKind: "update",
    });
  }, 120_000);

  test("an event insert that cannot land aborts the version and the row write", async () => {
    const key = `ie-atomic-${sfx}`;
    const id = `${A.id}:${key}`;
    const subjectId = `${A.id}:${key}`;
    // Occupy the exact event id the first append will use, so its raw create
    // collides. Planted through the raw operations API (the documented
    // exception), as an ordinary event so 3a's own guard is not the actor.
    await ops({
      operation: "upsert", database: "flair", table: "OrgEvent",
      records: [{
        id: `instruction-change:soul:${subjectId}:1`, authorId: "agent-a", kind: "status",
        summary: "planted", createdAt: now(),
      }],
    });
    const res = await call("basic", "POST", "/Soul/", { id, agentId: A.id, key, value: "must-not-land" });
    expect(res.status, res.text.slice(0, 300)).toBe(500);
    expect(JSON.parse(res.text).error).toBe("instruction_version_append_failed");
    expect(await soulRow(id), "the Soul row must not survive a failed event insert").toBeNull();
    expect(await versionsOf(subjectId), "no version may survive a failed event insert").toHaveLength(0);
  }, 120_000);
});

describe("flair#2139 S3b — skill events and the private-skill hash gate", () => {
  test("repeated private skill updates reach default bootstrap once per version ref without content", async () => {
    const id = nextId("bootstrap");
    const contents = ["INSTRUCTION-EVENT-CONTENT-A", "INSTRUCTION-EVENT-CONTENT-B", "INSTRUCTION-EVENT-CONTENT-C"];
    for (const content of contents) {
      const res = await call(A, "PUT", memPath(id), skillBody(id, content, { visibility: "private" }));
      expect(res.status, res.text.slice(0, 300)).toBeLessThan(300);
    }
    const versions = await versionsOf(id);
    expect(versions.map((version) => version.kind)).toEqual(["create", "update", "update"]);
    const storedEvents = await ops({
      operation: "search_by_value", database: "flair", table: "OrgEvent",
      search_attribute: "kind", search_value: "skill.changed", get_attributes: ["*"],
    });
    const relevant = storedEvents.filter((event: any) => JSON.parse(event.detail).subjectId === id);
    expect(relevant).toHaveLength(3);
    const res = await call(A, "POST", "/BootstrapMemories", { agentId: A.id, includeContext: false, maxTokens: 16000 });
    expect(res.status, res.text.slice(0, 300)).toBe(200);
    const events = JSON.parse(res.text).events.filter((event: any) => relevant.some((stored: any) => stored.id === event.id));
    expect(events).toHaveLength(3);
    expect(new Set(events.map((event: any) => event.refId)).size).toBe(3);
    expect(events.map((event: any) => event.refId).sort()).toEqual(versions.map((version) => version.id).sort());
    for (const event of events) {
      expect(event.scope).toBe(A.id);
      expect(event.id).toBe(`instruction-change:${event.refId}`);
      const detail = JSON.parse(event.detail);
      expect(Object.keys(detail).sort()).toEqual(TEN_FIELDS.filter((field) => !["valueHash", "previousVersionHash", "recordHash"].includes(field)));
      expect(detail.actorKind).toBe("agent");
      expect(detail.actorId).toBe(A.id);
      expect(detail.sourceClass).toBe("agent");
      expect(detail.key).toBeNull();
      expect(detail).not.toHaveProperty("content");
      for (const content of contents) expect(JSON.stringify(event)).not.toContain(content);
    }
  }, 180_000);

  test("a shared skill carries the hashes and a null key; a private one omits them, tombstone included", async () => {
    const sharedId = nextId("shared");
    expect((await call(A, "PUT", memPath(sharedId), skillBody(sharedId, "s1"))).status).toBeLessThan(300);
    const [sharedVersion] = await versionsOf(sharedId);
    const sharedEvent = (await eventsOf([sharedVersion.id]))[sharedVersion.id];
    expect(sharedEvent.kind).toBe("skill.changed");
    expect(sharedEvent.scope).toBe(A.id);
    const sharedDetail = JSON.parse(sharedEvent.detail);
    expect(sharedDetail.key).toBeNull();
    expect(Object.keys(sharedDetail).sort()).toEqual(TEN_FIELDS);
    expect(sharedDetail.valueHash).toBe(sharedVersion.valueHash);
    expect(sharedDetail.previousVersionHash).toBe(sharedVersion.previousVersionHash);
    expect(sharedDetail.recordHash).toBe(sharedVersion.recordHash);
    expect(sharedDetail.actorKind).toBe("agent");

    const privateId = nextId("private");
    expect((await call(A, "PUT", memPath(privateId), skillBody(privateId, "p1", { visibility: "private" }))).status).toBeLessThan(300);
    const created = await versionsOf(privateId);
    expect(created).toHaveLength(1);
    expect(created[0].visibility).toBe("private");
    expect(JSON.parse(JSON.stringify(created[0].valueHash))).not.toBeNull();

    // Tightening the successor is also private, and the delete's tombstone
    // carries the closed head's last state.
    expect((await call(A, "PUT", memPath(privateId), skillBody(privateId, "p2", { visibility: "private" }))).status).toBeLessThan(300);
    expect((await call(A, "DELETE", memPath(privateId))).status).toBeLessThan(300);
    const versions = await versionsOf(privateId);
    expect(versions.map((v) => v.kind)).toEqual(["create", "update", "delete"]);
    expect(versions.every((v) => v.visibility === "private")).toBe(true);
    const events = await eventsOf(versions.map((v) => v.id));
    for (const version of versions) {
      const detail = JSON.parse(events[version.id].detail);
      expect(detail.key).toBeNull();
      expect(detail.subjectType).toBe("skill");
      expect(Object.keys(detail).sort()).toEqual(
        TEN_FIELDS.filter((field) => !["valueHash", "previousVersionHash", "recordHash"].includes(field)),
      );
      expect(events[version.id].detail).not.toContain(version.valueHash ?? "\u0000");
      expect(events[version.id].detail).not.toContain(version.recordHash);
    }
  }, 180_000);
});
