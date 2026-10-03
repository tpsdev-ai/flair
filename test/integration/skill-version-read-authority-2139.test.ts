// ─── flair#2139 S2 — skill version READ authority against a real Harper ──────
//
// Ordinary skill readers require readable stored visibility and current authority:
// matching subjects, a live skill row owned by the head's owner, or a delete head
// with null memoryId; references require nonempty owners and private/shared visibility.
// Unknown subject types deny; admin/internal keep unfiltered skill reads.
//
// Skill version rows are inserted through the administrator operations API (the
// documented unaudited exception) because the REST write surface refuses every
// mutation verb; the read path is exercised over real HTTP GET.
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
const A = mkAgent(`skr-owner-${sfx}`);
const B = mkAgent(`skr-other-${sfx}`);
const ADMIN_AGENT = mkAgent(`skr-admin-${sfx}`);
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

const versionPath = (id: string) => `/InstructionVersion/${encodeURIComponent(id)}`;
const collectionPath = "/InstructionVersion/";

let subjectSeq = 0;
function nextSubjectId(label: string): string {
  subjectSeq += 1;
  return `skr-${label}-${sfx}-${subjectSeq}`;
}

async function upsertMemory(id: string, agentId: string, visibility: string, skillSubjectId: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await ops({
    operation: "upsert", database: "flair", table: "Memory",
    records: [{ id, agentId, content: `skill ${id}`, trigger: `trigger ${id}`, tags: ["skill"], skillSubjectId, visibility, durability: "persistent", createdAt: now(), ...overrides }],
  });
}

interface VersionInput {
  subjectId: string; agentId: string; visibility: string | null; memoryId: string | null;
  kind?: string; version: number; id?: string; subjectType?: string;
}
async function insertVersion(input: VersionInput): Promise<string> {
  const id = input.id ?? `skill:${input.subjectId}:${input.version}`;
  await ops({
    operation: "upsert", database: "flair", table: "InstructionVersion",
    records: [{
      id, subjectType: input.subjectType ?? "skill", subjectId: input.subjectId, agentId: input.agentId, key: null,
      version: input.version, kind: input.kind ?? "create", rowId: input.memoryId ?? `row-${id}`,
      valueHash: null, previousVersionHash: null, recordHash: `raw-${id}`,
      soulSnapshot: null, memoryId: input.memoryId, visibility: input.visibility,
      actorKind: "agent", actorId: input.agentId, sourceClass: "agent", createdAt: now(),
      guarded: false, expectedVersion: null,
    }],
  });
  return id;
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  harper = await startHarper();
  installDir = harper.installDir;
  assertOwnInstance(harper);
  await ops({
    operation: "upsert", database: "flair", table: "Agent",
    records: [
      ...([A, B] as TestAgent[]).map((a) => ({ id: a.id, name: a.id, role: "agent", publicKey: a.publicKey, createdAt: now() })),
      { id: ADMIN_AGENT.id, name: ADMIN_AGENT.id, role: "admin", admin: true, publicKey: ADMIN_AGENT.publicKey, createdAt: now() },
    ],
  });
  await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
  await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (installDir) await rm(installDir, { recursive: true, force: true, maxRetries: 4 });
});

describe("flair#2139 S2 — skill version read authority", () => {
  test("a shared skill version is readable by another verified agent", async () => {
    const subject = nextSubjectId("shared");
    const memId = `mem-${subject}`;
    await upsertMemory(memId, A.id, "shared", subject);
    const id = await insertVersion({ subjectId: subject, agentId: A.id, visibility: "shared", memoryId: memId, version: 1 });

    const asOther = await call(B, "GET", versionPath(id));
    expect(asOther.status, asOther.text.slice(0, 200)).toBeLessThan(300);
    expect(JSON.parse(asOther.text).subjectType).toBe("skill");
  }, 120_000);

  test("a private skill version is denied to a non-owner; the owner and an admin agent read it", async () => {
    const subject = nextSubjectId("private");
    const memId = `mem-${subject}`;
    await upsertMemory(memId, A.id, "shared", subject);
    const id = await insertVersion({ subjectId: subject, agentId: A.id, visibility: "private", memoryId: memId, version: 1 });

    expect((await call(B, "GET", versionPath(id))).status).toBe(404);
    expect((await call(A, "GET", versionPath(id))).status).toBe(200);
    expect((await call(ADMIN_AGENT, "GET", versionPath(id))).status).toBe(200);
  }, 120_000);

  test("current private revokes an earlier shared version (revocation is non-widening)", async () => {
    const subject = nextSubjectId("revoke");
    const sharedMem = `mem-${subject}-shared`;
    const privateMem = `mem-${subject}-private`;
    await upsertMemory(sharedMem, A.id, "shared", subject);
    await upsertMemory(privateMem, A.id, "private", subject);
    const v1 = await insertVersion({ subjectId: subject, agentId: A.id, visibility: "shared", memoryId: sharedMem, version: 1 });
    const v2 = await insertVersion({ subjectId: subject, agentId: A.id, visibility: "shared", memoryId: privateMem, version: 2, kind: "update" });

    expect((await call(B, "GET", versionPath(v1))).status, "an earlier shared version must be revoked once the subject is private").toBe(404);
    expect((await call(B, "GET", versionPath(v2))).status).toBe(404);
    expect((await call(A, "GET", versionPath(v1))).status).toBe(200);
  }, 120_000);

  test("after a logical delete, the tombstone's last authority governs the chain", async () => {
    const shared = nextSubjectId("tomb-shared");
    const sharedMem = `mem-${shared}`;
    await upsertMemory(sharedMem, A.id, "shared", shared);
    const s1 = await insertVersion({ subjectId: shared, agentId: A.id, visibility: "shared", memoryId: sharedMem, version: 1 });
    await insertVersion({ subjectId: shared, agentId: A.id, visibility: "shared", memoryId: null, version: 2, kind: "delete" });
    expect((await call(B, "GET", versionPath(s1))).status, "a shared tombstone keeps the chain readable").toBe(200);

    const priv = nextSubjectId("tomb-private");
    const privMem = `mem-${priv}`;
    await upsertMemory(privMem, A.id, "shared", priv);
    const p1 = await insertVersion({ subjectId: priv, agentId: A.id, visibility: "shared", memoryId: privMem, version: 1 });
    await insertVersion({ subjectId: priv, agentId: A.id, visibility: "private", memoryId: null, version: 2, kind: "delete" });
    expect((await call(B, "GET", versionPath(p1))).status, "a private tombstone revokes the chain").toBe(404);
  }, 120_000);

  test("a missing current Memory row denies, and legacy missing visibility denies", async () => {
    const missing = nextSubjectId("missing");
    const m1 = await insertVersion({ subjectId: missing, agentId: A.id, visibility: "shared", memoryId: `no-such-${missing}`, version: 1 });
    expect((await call(B, "GET", versionPath(m1))).status, "a missing live Memory row must deny, not read as public").toBe(404);

    const legacy = nextSubjectId("legacy");
    const legacyMem = `mem-${legacy}`;
    await upsertMemory(legacyMem, A.id, "shared", legacy);
    const l1 = await insertVersion({ subjectId: legacy, agentId: A.id, visibility: null, memoryId: legacyMem, version: 1 });
    expect((await call(B, "GET", versionPath(l1))).status, "missing write-time visibility must not read as public").toBe(404);
  }, 120_000);

  test("the collection read includes only authorized skill versions", async () => {
    const okSubject = nextSubjectId("coll-ok");
    const okMem = `mem-${okSubject}`;
    await upsertMemory(okMem, A.id, "shared", okSubject);
    const okId = await insertVersion({ subjectId: okSubject, agentId: A.id, visibility: "shared", memoryId: okMem, version: 1 });

    const badSubject = nextSubjectId("coll-bad");
    const badMem = `mem-${badSubject}`;
    await upsertMemory(badMem, A.id, "shared", badSubject);
    const badId = await insertVersion({ subjectId: badSubject, agentId: A.id, visibility: "private", memoryId: badMem, version: 1 });

    const collection = await call(B, "GET", collectionPath);
    expect(collection.status, collection.text.slice(0, 200)).toBe(200);
    const listed = JSON.parse(collection.text).map((r: any) => r.id);
    expect(listed, "an authorized skill version must be listed").toContain(okId);
    expect(listed, "an unauthorized skill version must not be listed").not.toContain(badId);
  }, 120_000);

  for (const [label, memoryOverrides, versionOverrides] of [
    ["unrelated shared Memory", { skillSubjectId: "unrelated" }, {}],
    ["non-skill Memory", { tags: [] }, {}],
    ["owner mismatch", { agentId: B.id }, {}],
    ["archived Memory", { archived: true }, {}],
    ["closed Memory", { validTo: "2020-01-01T00:00:00.000Z" }, {}],
    ["empty Memory owner", { agentId: "" }, {}],
    ["unknown Memory visibility", { visibility: "public" }, {}],
    ["empty version owner", {}, { agentId: "" }],
    ["unknown version visibility", {}, { visibility: "public" }],
    ["unknown subject type", {}, { subjectType: "unknown" }],
    ["malformed tombstone", {}, { kind: "delete" }],
  ] as const) {
    test(`${label} denies by-id and collection reads`, async () => {
      const subject = nextSubjectId("invalid");
      const memId = `mem-${subject}`;
      await upsertMemory(memId, A.id, "shared", subject, memoryOverrides);
      const id = await insertVersion({ subjectId: subject, agentId: A.id, visibility: "shared", memoryId: memId, version: 1, ...versionOverrides });
      for (const reader of [A, B]) {
        expect((await call(reader, "GET", versionPath(id))).status).toBe(404);
        const collection = await call(reader, "GET", collectionPath);
        expect(collection.status).toBe(200);
        expect(JSON.parse(collection.text).map((r: any) => r.id)).not.toContain(id);
      }
    }, 120_000);
  }

  test("anonymous is denied on both the by-id and collection reads", async () => {
    const subject = nextSubjectId("anon");
    const memId = `mem-${subject}`;
    await upsertMemory(memId, A.id, "shared", subject);
    const id = await insertVersion({ subjectId: subject, agentId: A.id, visibility: "shared", memoryId: memId, version: 1 });
    expect([401, 403]).toContain((await call("anonymous", "GET", versionPath(id))).status);
    expect([401, 403]).toContain((await call("anonymous", "GET", collectionPath)).status);
  }, 120_000);
});
