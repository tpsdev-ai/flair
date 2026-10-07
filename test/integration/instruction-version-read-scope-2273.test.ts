// ─── flair#2273 — read scope applies before limit/offset and before projection ──
//
// Authorization must run on the readable set, not on the paged/projected result:
// with N readable and M unreadable rows interleaved, `limit(k)` returns the first
// min(k, N) readable rows and `offset` pages through exactly the readable set; a
// `select`/single-property read returns a row the caller may read (owner and admin)
// and nothing a non-owner may not. Rows are seeded through the administrator
// operations API (InstructionVersion refuses every REST write), and the read path
// is exercised over real HTTP.
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
const OWNER = mkAgent(`rs-owner-${sfx}`);
const OTHER = mkAgent(`rs-other-${sfx}`);
const ADMIN = mkAgent(`rs-admin-${sfx}`);
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

async function call(auth: TestAgent | "anonymous", method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth !== "anonymous") headers.Authorization = ed25519(auth, method, path);
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

async function insertVersion(record: Record<string, unknown>): Promise<void> {
  const merged = {
    key: null, valueHash: null, previousVersionHash: null,
    soulSnapshot: null, memoryId: null, visibility: null, actorKind: "agent", actorId: null,
    sourceClass: "agent", createdAt: now(), guarded: false, expectedVersion: null, kind: "create",
    ...record,
  } as Record<string, unknown>;
  if (merged.recordHash == null) merged.recordHash = `raw-${String(merged.id)}`;
  await ops({ operation: "upsert", database: "flair", table: "InstructionVersion", records: [merged] });
}

async function upsertMemory(id: string, agentId: string, visibility: string, skillSubjectId: string): Promise<void> {
  await ops({
    operation: "upsert", database: "flair", table: "Memory",
    records: [{
      id, agentId, content: `skill ${id}`, trigger: `trigger ${id}`, tags: ["skill"],
      skillSubjectId, visibility, durability: "persistent", createdAt: now(),
    }],
  });
}

function idsOf(text: string): string[] {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error(`expected a collection, got: ${text.slice(0, 200)}`);
  for (const row of parsed) {
    expect(row).toHaveProperty("id");
    expect(row).toHaveProperty("subjectType");
  }
  return parsed.map((row: any) => row.id);
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  harper = await startHarper();
  installDir = harper.installDir;
  assertOwnInstance(harper);
  await ops({
    operation: "upsert", database: "flair", table: "Agent",
    records: [
      { id: OWNER.id, name: OWNER.id, role: "agent", publicKey: OWNER.publicKey, createdAt: now() },
      { id: OTHER.id, name: OTHER.id, role: "agent", publicKey: OTHER.publicKey, createdAt: now() },
      { id: ADMIN.id, name: ADMIN.id, role: "admin", admin: true, publicKey: ADMIN.publicKey, createdAt: now() },
    ],
  });
  await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
  await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (installDir) await rm(installDir, { recursive: true, force: true, maxRetries: 4 });
});

describe("flair#2273 — read scope applies before paging and projection", () => {
  const READABLE = ["pg01-soul", "pg03-soul", "pg05-soul", "pg07-soul", "pg09-soul"];
  const UNREADABLE = ["pg02-skill", "pg04-skill", "pg06-skill", "pg08-skill"];

  test("limit and offset page over exactly the readable rows, interleaved with unreadable ones", async () => {
    // Readable Soul rows interleaved by id with skill references the caller may
    // not read (another agent's private skill). Both are readable subject types,
    // so the scope condition cannot remove the unreadable ones — only the
    // per-row decision does, which is why paging must run over the filtered stream.
    for (let i = 1; i <= 9; i++) {
      const readable = i % 2 === 1;
      const id = `pg0${i}-${readable ? "soul" : "skill"}`;
      await insertVersion(readable
        ? { id, subjectType: "soul", subjectId: `subj-${id}`, agentId: OWNER.id, version: i, rowId: `row-${id}` }
        : { id, subjectType: "skill", subjectId: `subj-${id}`, agentId: OTHER.id, version: i, rowId: `row-${id}`, visibility: "private" });
    }

    const page = async (paging: string, sort = "id") => {
      const res = await call(OWNER, "GET", `/InstructionVersion/?sort(${sort})${paging}`);
      expect(res.status, res.text.slice(0, 200)).toBe(200);
      return idsOf(res.text);
    };

    // The full collection is the readable set, and nothing unreadable.
    expect(await page("")).toEqual(READABLE);

    // limit(k) returns min(k, N) readable rows — never fewer because unreadable
    // rows were scanned first.
    expect(await page("&limit(3)")).toEqual(READABLE.slice(0, 3));
    expect(await page("&limit(1)")).toEqual(["pg01-soul"]);
    expect(await page("&limit(1,4)", "-id")).toEqual(["pg07-soul", "pg05-soul", "pg03-soul"]);

    // Offset pages through exactly the readable set: concatenated pages equal the
    // readable set, no duplicates, nothing unreadable.
    const pages = [
      await page("&limit(0,2)"),
      await page("&limit(2,4)"),
      await page("&limit(4,6)"),
    ];
    expect(pages.flat()).toEqual(READABLE);
    expect(new Set(pages.flat()).size).toBe(READABLE.length);
    for (const id of UNREADABLE) expect(pages.flat()).not.toContain(id);
  }, 120_000);

  test("select and single-property reads authorize the full row before projecting", async () => {
    const subject = `rs-skill-${sfx}`;
    const memId = `mem-${subject}`;
    const id = `skill:${subject}:1`;
    await upsertMemory(memId, OWNER.id, "private", subject);
    await insertVersion({ id, subjectType: "skill", subjectId: subject, agentId: OWNER.id, version: 1, rowId: memId, memoryId: memId, visibility: "private" });

    const byId = `/InstructionVersion/${encodeURIComponent(id)}`;

    // The owner may read it: a selection narrows the row, it does not hide it.
    // (`select(id)` renders to the id — the property value for a one-attribute select.)
    const ownerSelect = await call(OWNER, "GET", `${byId}?select(id)`);
    expect(ownerSelect.status, ownerSelect.text.slice(0, 200)).toBe(200);
    expect(JSON.parse(ownerSelect.text)).toBe(id);

    const ownerProp = await call(OWNER, "GET", `${byId}.subjectType`);
    expect(ownerProp.status, ownerProp.text.slice(0, 200)).toBe(200);
    expect(ownerProp.text.trim()).toBe("\"skill\"");

    // An admin may read it too (the same unfiltered skill exception get() keeps).
    const adminSelect = await call(ADMIN, "GET", `${byId}?select(id)`);
    expect(adminSelect.status).toBe(200);
    expect(JSON.parse(adminSelect.text)).toBe(id);
    const adminProp = await call(ADMIN, "GET", `${byId}.subjectType`);
    expect(adminProp.status).toBe(200);
    expect(JSON.parse(adminProp.text)).toBe("skill");

    // A non-owner may not, with or without a selection.
    expect((await call(OTHER, "GET", `${byId}?select(id)`)).status).toBe(404);
    expect((await call(OTHER, "GET", `${byId}.subjectType`)).status).toBe(404);

    // A Soul row is readable by any verified agent, and its selection is honored.
    const soulId = `rs-soul-${sfx}`;
    await insertVersion({ id: soulId, subjectType: "soul", subjectId: `subj-${soulId}`, agentId: OWNER.id, version: 1, rowId: `row-${soulId}` });
    const soulSelect = await call(OTHER, "GET", `/InstructionVersion/${encodeURIComponent(soulId)}?select(id)`);
    expect(soulSelect.status).toBe(200);
    expect(JSON.parse(soulSelect.text)).toBe(soulId);
    const soulProp = await call(OTHER, "GET", `/InstructionVersion/${encodeURIComponent(soulId)}.subjectType`);
    expect(soulProp.status).toBe(200);
    expect(JSON.parse(soulProp.text)).toBe("soul");
  }, 120_000);

  test("a collection select returns the readable rows, never an unreadable one", async () => {
    // A row no caller may read (an unknown subject type), to pin that the scope
    // condition still removes it from the collection read.
    await insertVersion({ id: "pg10-opaque", subjectType: "opaque", subjectId: "subj-pg10", agentId: OWNER.id, version: 10, rowId: "row-pg10" });
    const subject = `rs-coll-${sfx}`;
    const memId = `mem-${subject}`;
    const id = `skill:${subject}:1`;
    await upsertMemory(memId, OWNER.id, "private", subject);
    await insertVersion({ id, subjectType: "skill", subjectId: subject, agentId: OWNER.id, version: 1, rowId: memId, memoryId: memId, visibility: "private" });

    const res = await call(OWNER, "GET", "/InstructionVersion/?sort(id)&select(id)");
    expect(res.status, res.text.slice(0, 200)).toBe(200);
    const listed = idsOf(res.text);
    expect(JSON.parse(res.text).find((row: any) => row.id === id)).toMatchObject({
      id, subjectType: "skill", subjectId: subject, agentId: OWNER.id, memoryId: memId, visibility: "private",
    });
    expect(listed, "a readable skill version must be listed").toContain(id);
    expect(listed, "a readable Soul version must be listed").toContain("pg01-soul");
    for (const unreadable of [...UNREADABLE, "pg10-opaque"]) {
      expect(listed, `an unreadable row (${unreadable}) must not be listed`).not.toContain(unreadable);
    }

    // The same collection read by a non-owner lists neither the skill version nor
    // the unreadable rows, but still lists the Soul rows.
    const asOther = await call(OTHER, "GET", "/InstructionVersion/?sort(id)&select(id)");
    expect(asOther.status).toBe(200);
    const otherListed = idsOf(asOther.text);
    expect(otherListed).not.toContain(id);
    expect(otherListed).toContain("pg01-soul");
  }, 120_000);
});
