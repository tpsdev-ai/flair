// ─── flair#2139 S1 — Soul version history against a real Harper ──────────────
//
// Harper routes each REST verb to its own resource method, so the append
// integration runs over HTTP against a spawned, HOME-isolated Harper:
//   - create → PUT → PATCH → delete → recreate leaves an ordered, chained
//     InstructionVersion history with a tombstone and a recreated successor;
//     recurring values keep distinct ids and each subject has its own sequence.
//   - a repeated CLI-shaped PUT keeps the original Soul createdAt.
//   - concurrent same-subject writes form one ordered chain.
//   - the version read is default-deny per subjectType: anonymous denied, a
//     verified agent reads a soul version, an unhandled subjectType denied.
//   - every mutation verb on InstructionVersion is denied to every principal,
//     Basic admin included.
//   - spoofed audit fields on a Soul write are ignored.
//
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";
import { FLAIR_AGENT_PERMISSION } from "../../src/lib/flair-agent-role";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }
const mkAgent = (id: string): TestAgent => {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
};

const sfx = Date.now().toString(36);
const A = mkAgent(`iv-a-${sfx}`);
const B = mkAgent(`iv-b-${sfx}`);
const ADMIN_AGENT = mkAgent(`iv-admin-${sfx}`);
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

const upsert = (table: string, records: Record<string, unknown>[]) =>
  ops({ operation: "upsert", database: "flair", table, records });

/** The version field list the record digest covers, in the same order as
 *  resources/instruction-version-record.ts. Reimplemented here because
 *  importing that module outside Harper opens a data directory. */
const RECORD_HASH_FIELDS = [
  "id", "subjectType", "subjectId", "agentId", "key", "version", "kind", "rowId",
  "valueHash", "previousVersionHash", "soulSnapshot", "memoryId", "visibility",
  "actorKind", "actorId", "sourceClass", "createdAt", "guarded", "expectedVersion",
];
const norm = (v: unknown) => (typeof v === "bigint" ? v.toString() : v === undefined ? null : v);
const recordHashOf = (row: Record<string, unknown>) =>
  createHash("sha256")
    .update(JSON.stringify(RECORD_HASH_FIELDS.map((f) => [f, f === "version" ? String(row[f]) : norm(row[f])])), "utf8")
    .digest("hex");

async function versionsOf(subjectId: string): Promise<any[]> {
  const rows = await ops({
    operation: "search_by_value", database: "flair", table: "InstructionVersion",
    search_attribute: "subjectId", search_value: subjectId, get_attributes: ["*"],
  });
  return rows.sort((a: any, b: any) => Number(a.version) - Number(b.version));
}

async function soulRow(id: string): Promise<any | null> {
  const rows = await ops({ operation: "search_by_id", database: "flair", table: "Soul", ids: [id], get_attributes: ["*"] });
  return rows[0] ?? null;
}

const soulPath = (id: string) => `/Soul/${encodeURIComponent(id)}`;
const versionPath = (id: string) => `/InstructionVersion/${encodeURIComponent(id)}`;

async function createSoul(id: string, agentId: string, key: string, value: string): Promise<void> {
  const res = await call("basic", "POST", "/Soul/", { id, agentId, key, value, durability: "permanent" });
  expect(res.status, `Soul POST ${id}: ${res.text.slice(0, 200)}`).toBeLessThan(300);
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  harper = await startHarper();
  installDir = harper.installDir;
  assertOwnInstance(harper);
  await upsert("Agent", [
    ...[A, B].map((a) => ({ id: a.id, name: a.id, role: "agent", publicKey: a.publicKey, createdAt: now() })),
    { id: ADMIN_AGENT.id, name: ADMIN_AGENT.id, role: "admin", admin: true, publicKey: ADMIN_AGENT.publicKey, createdAt: now() },
  ]);
  await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
  await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (installDir) await rm(installDir, { recursive: true, force: true, maxRetries: 4 });
});

describe("flair#2139 S1 — the version read path", () => {
  test("anonymous is denied; a verified agent reads a soul version; an unhandled subjectType is denied", async () => {
    const key = `iv-read-${sfx}`;
    const id = `${A.id}:${key}`;
    const subjectId = `${A.id}:${key}`;
    await createSoul(id, A.id, key, "readable");
    const rows = await versionsOf(subjectId);
    expect(rows).toHaveLength(1);

    const anon = await call("anonymous", "GET", versionPath(rows[0].id));
    expect([401, 403], `anonymous GET returned ${anon.status}`).toContain(anon.status);

    const asB = await call(B, "GET", versionPath(rows[0].id));
    expect(asB.status, asB.text.slice(0, 200)).toBe(200);
    expect(JSON.parse(asB.text).subjectType).toBe("soul");

    // A row of a subjectType slice 1 does not authorize is denied on the by-id
    // read, and does not appear in the collection. Written through the ops API
    // (the documented unaudited exception) since the resource denies all verbs.
    const skillId = `skill:${sfx}:1`;
    await upsert("InstructionVersion", [{
      id: skillId, subjectType: "skill", subjectId: `skill-subject-${sfx}`, agentId: A.id, key: null,
      version: 1, kind: "create", rowId: `mem-${sfx}`, valueHash: null, previousVersionHash: null,
      recordHash: "raw", soulSnapshot: null, memoryId: `mem-${sfx}`, visibility: "private",
      actorKind: "internal", actorId: null, sourceClass: "internal", createdAt: now(),
      guarded: false, expectedVersion: null,
    }]);
    const asBSkill = await call(B, "GET", versionPath(skillId));
    expect(asBSkill.status, `an unhandled subjectType must be denied, got ${asBSkill.status}`).toBe(404);
    expect(asBSkill.text).not.toContain("skill-subject");

    const collection = await call(B, "GET", "/InstructionVersion/");
    expect(collection.status, collection.text.slice(0, 200)).toBe(200);
    const listed = JSON.parse(collection.text).map((r: any) => r.id);
    expect(listed, "the collection must include the readable soul version").toContain(rows[0].id);
    expect(listed, "the collection must not include an unhandled subjectType").not.toContain(skillId);
  }, 120_000);
});

describe("flair#2139 S1 — every mutation verb is denied", () => {
  test("post, put, patch and delete are denied to an agent, an admin-agent key and Basic admin", async () => {
    const key = `iv-mut-${sfx}`;
    const id = `${A.id}:${key}`;
    await createSoul(id, A.id, key, "before");
    const rows = await versionsOf(`${A.id}:${key}`);
    const victim = rows[0].id;
    const before = await versionsOf(`${A.id}:${key}`);

    const row = {
      id: `iv-raw-${sfx}`, subjectType: "soul", subjectId: `raw-${sfx}`, agentId: A.id, key: "raw",
      version: 1, kind: "create", rowId: `raw-${sfx}`, recordHash: "x", createdAt: now(), guarded: false,
    };
    for (const who of ["basic", ADMIN_AGENT, A] as const) {
      const attempts: Array<[string, string, unknown]> = [
        ["POST", "/InstructionVersion/", row],
        ["PUT", versionPath(victim), { ...row, id: victim }],
        ["PATCH", versionPath(victim), { kind: "delete" }],
        ["DELETE", versionPath(victim), undefined],
      ];
      for (const [method, path, body] of attempts) {
        const res = await call(who, method, path, body);
        expect(res.status, `${String(who)} ${method} ${path}: ${res.status} ${res.text.slice(0, 120)}`).toBe(403);
      }
    }
    // Nothing changed: no new row, the existing row intact.
    expect(await versionsOf(`${A.id}:${key}`)).toEqual(before);
  }, 120_000);

  test("the canonical role grant is read-only for InstructionVersion", () => {
    expect(FLAIR_AGENT_PERMISSION.flair.tables.InstructionVersion).toEqual({ read: true, insert: false, update: false, delete: false, attribute_permissions: [] });
  });
});

describe("flair#2139 S1 — Soul lifecycle leaves a chained history", () => {
  test("collection DELETE is refused and leaves Soul rows and history unchanged", async () => {
    const fixtures = [A, B].map((agent) => {
      const key = `iv-collection-${sfx}`;
      return { id: `${agent.id}:${key}`, agentId: agent.id, key };
    });
    for (const row of fixtures) await createSoul(row.id, row.agentId, row.key, "retained");
    const before = await Promise.all(fixtures.map(async (row) => ({
      row: await soulRow(row.id), versions: await versionsOf(`${row.agentId}:${row.key}`),
    })));
    for (const path of ["/Soul/", `/Soul/?agentId=${encodeURIComponent(A.id)}`]) {
      const result = await call("basic", "DELETE", path);
      expect(result.status, result.text).toBe(400);
      expect(JSON.parse(result.text)).toEqual({ error: "soul_delete_requires_one_record" });
      for (const [index, row] of fixtures.entries()) {
        expect(await soulRow(row.id)).toEqual(before[index].row);
        expect(await versionsOf(`${row.agentId}:${row.key}`)).toEqual(before[index].versions);
      }
    }
  }, 120_000);

  test("create, PUT, PATCH, delete and recreate leave ordered chained records, a tombstone and distinct ids", async () => {
    const key = `iv-life-${sfx}`;
    const id = `${A.id}:${key}`;
    const subjectId = `${A.id}:${key}`;
    await createSoul(id, A.id, key, "v1");

    expect((await call("basic", "PUT", soulPath(id), { id, agentId: A.id, key, value: "v2" })).status).toBeLessThan(300);
    expect((await call("basic", "PATCH", soulPath(id), { value: "v3" })).status).toBeLessThan(300);
    expect((await call("basic", "DELETE", soulPath(id))).status).toBeLessThan(300);
    // Recreate with the SAME value as v1: recurring content, still a new id.
    await createSoul(id, A.id, key, "v1");

    const rows = await versionsOf(subjectId);
    expect(rows.map((r) => r.kind)).toEqual(["create", "update", "update", "delete", "create"]);
    expect(rows.map((r) => Number(r.version))).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(5);
    expect(rows[4].id).not.toBe(rows[0].id);

    // Unbroken chain: each record's predecessor is the previous record's digest.
    expect(rows[0].previousVersionHash).toBeNull();
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].previousVersionHash, `version ${i + 1} must chain to version ${i}`).toBe(rows[i - 1].recordHash);
    }
    for (const r of rows) expect(r.recordHash).toBe(recordHashOf(r));

    // Snapshot values; the tombstone carries none.
    const snap = (r: any) => (r.soulSnapshot == null ? null : JSON.parse(r.soulSnapshot).value);
    expect(rows.map(snap)).toEqual(["v1", "v2", "v3", null, "v1"]);
    expect(rows[3].valueHash).toBeNull();
    expect(rows[3].soulSnapshot).toBeNull();

    // The recreated live row is back, with value v1.
    expect((await soulRow(id))?.value).toBe("v1");

    // An unrelated subject holds its own sequence.
    const otherKey = `iv-other-${sfx}`;
    await createSoul(`${B.id}:${otherKey}`, B.id, otherKey, "x");
    expect((await versionsOf(`${B.id}:${otherKey}`)).map((r) => Number(r.version))).toEqual([1]);
  }, 180_000);

  test("repeated CLI-shaped PUTs keep the original createdAt", async () => {
    const key = `iv-clock-${sfx}`;
    const id = `${A.id}:${key}`;
    const subjectId = `${A.id}:${key}`;
    await createSoul(id, A.id, key, "c0");
    const created = (await soulRow(id))!.createdAt;

    for (const [i, when] of ["2020-01-01T00:00:00.000Z", "2021-01-01T00:00:00.000Z", "2022-01-01T00:00:00.000Z"].entries()) {
      const res = await call("basic", "PUT", soulPath(id), { id, agentId: A.id, key, value: `c${i + 1}`, createdAt: when, updatedAt: when });
      expect(res.status, res.text.slice(0, 200)).toBeLessThan(300);
      const row = await soulRow(id);
      const latest = (await versionsOf(subjectId)).at(-1)!;
      expect(JSON.parse(latest.soulSnapshot)).toEqual(row);
      expect(Date.parse(latest.createdAt)).toBeGreaterThanOrEqual(Date.parse(row.updatedAt));
      expect(latest.createdAt).not.toBe(created);
      expect(row.createdAt, `PUT ${i + 1} reset createdAt`).toBe(created);
      expect(row.updatedAt).not.toBe(when);
    }
    // Every version snapshots the preserved creation clock, never the body value.
    for (const r of await versionsOf(subjectId)) {
      expect(JSON.parse(r.soulSnapshot).createdAt).toBe(created);
    }
  }, 120_000);

  test("concurrent same-subject writes form one ordered chain", async () => {
    const key = `iv-conc-${sfx}`;
    const id = `${A.id}:${key}`;
    const subjectId = `${A.id}:${key}`;
    await createSoul(id, A.id, key, "seed");
    const refs = Array.from({ length: 8 }, (_, i) => `iv-ref-${i}-${sfx}`);
    const results = await Promise.all(refs.map((value) => call("basic", "PATCH", soulPath(id), { value })));
    expect(results.map((r) => r.status).filter((s) => s >= 300)).toEqual([]);
    const rows = await versionsOf(subjectId);
    expect(rows.map((r) => Number(r.version))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].previousVersionHash, `version ${i + 1} must chain to version ${i}`).toBe(rows[i - 1].recordHash);
    }
  }, 180_000);

  test("POST and PUT without body ids snapshot the physical stored row", async () => {
    const key = `iv-no-id-${sfx}`;
    const subjectId = `${A.id}:${key}`;
    const posted = await call("basic", "POST", "/Soul/", { agentId: A.id, key, value: "first", originatorInstanceId: "forged" });
    expect(posted.status, posted.text).toBeLessThan(300);
    const [created] = await versionsOf(subjectId);
    const id = created.rowId;
    expect(id).not.toBe(subjectId);
    expect(JSON.parse(created.soulSnapshot)).toEqual(await soulRow(id));
    const put = await call("basic", "PUT", soulPath(id), { agentId: A.id, key, value: "second", originatorInstanceId: "forged" });
    expect(put.status, put.text).toBeLessThan(300);
    const updated = (await versionsOf(subjectId)).at(-1)!;
    expect(updated.rowId).toBe(id);
    expect(JSON.parse(updated.soulSnapshot)).toEqual(await soulRow(id));
  }, 120_000);

  test("overlapping PATCHes retain different fields in the final snapshot", async () => {
    const key = `iv-overlap-${sfx}`;
    const id = `${A.id}:${key}`;
    await createSoul(id, A.id, key, "before");
    const results = await Promise.all([
      call("basic", "PATCH", soulPath(id), { value: "after", originatorInstanceId: "forged" }),
      call("basic", "PATCH", soulPath(id), { durability: "persistent", createdAt: "forged" }),
    ]);
    expect(results.every((r) => r.status < 300)).toBe(true);
    const row = await soulRow(id);
    const versions = await versionsOf(`${A.id}:${key}`);
    expect(versions).toHaveLength(3);
    expect(row.value).toBe("after");
    expect(row.durability).toBe("persistent");
    expect(row.originatorInstanceId).not.toBe("forged");
    expect(row.createdAt).toBe(JSON.parse(versions[0].soulSnapshot).createdAt);
    expect(JSON.parse(versions[2].soulSnapshot)).toEqual(row);
  }, 120_000);

  test("an agentId-only update to an unoccupied destination closes the old window", async () => {
    // PUT — the verb the operator CLI's `soul set` and `restore` issue.
    const putKey = `iv-agentid-put-${sfx}`;
    const putId = `${A.id}:${putKey}`;
    await createSoul(putId, A.id, putKey, "before");
    const put = await call("basic", "PUT", soulPath(putId), { id: putId, agentId: B.id, key: putKey, value: "after" });
    expect(put.status, put.text.slice(0, 200)).toBeLessThan(300);
    expect((await versionsOf(`${A.id}:${putKey}`)).map((r) => r.kind)).toEqual(["create", "delete"]);
    const putNew = await versionsOf(`${B.id}:${putKey}`);
    expect(putNew.map((r) => r.kind)).toEqual(["update"]);
    expect(putNew[0].agentId).toBe(B.id);
    expect(putNew[0].previousVersionHash).toBeNull();

    // PATCH.
    const patchKey = `iv-agentid-patch-${sfx}`;
    const patchId = `${A.id}:${patchKey}`;
    await createSoul(patchId, A.id, patchKey, "before");
    const patch = await call("basic", "PATCH", soulPath(patchId), { agentId: B.id });
    expect(patch.status, patch.text.slice(0, 200)).toBeLessThan(300);
    expect((await versionsOf(`${A.id}:${patchKey}`)).map((r) => r.kind)).toEqual(["create", "delete"]);
    const patchNew = await versionsOf(`${B.id}:${patchKey}`);
    expect(patchNew.map((r) => r.kind)).toEqual(["update"]);
    expect(patchNew[0].agentId).toBe(B.id);
  }, 180_000);

  for (const method of ["PUT", "PATCH"] as const) {
    test(`${method} closes the old window for colon-colliding identity pairs`, async () => {
      const id = `iv-colon-${method}-${sfx}`;
      const agentId = `iv-colon-agent-${method}-${sfx}`;
      const oldSubject = `:${JSON.stringify([agentId, "b:c"])}`;
      const newSubject = `:${JSON.stringify([`${agentId}:b`, "c"])}`;
      await createSoul(id, agentId, "b:c", "before");
      const result = await call("basic", method, soulPath(id), { agentId: `${agentId}:b`, key: "c", value: "after" });
      expect(result.status, result.text).toBeLessThan(300);
      const oldVersions = await versionsOf(oldSubject);
      const newVersions = await versionsOf(newSubject);
      expect(oldVersions.map((r) => r.kind)).toEqual(["create", "delete"]);
      expect(oldVersions[1].previousVersionHash).toBe(oldVersions[0].recordHash);
      expect(newVersions.map((r) => r.kind)).toEqual(["update"]);
      expect(newVersions[0].previousVersionHash).toBeNull();
      expect(newVersions[0].agentId).toBe(`${agentId}:b`);
      expect(newVersions[0].key).toBe("c");
      const read = await call(B, "GET", versionPath(oldVersions[1].id));
      expect(read.status, read.text).toBe(200);
      expect(JSON.parse(read.text).kind).toBe("delete");
      expect((await soulRow(id)).agentId).toBe(`${agentId}:b`);
    }, 120_000);

    test(`${method} refuses an occupied destination without changing either row or history`, async () => {
      for (const field of ["agentId", "key"] as const) {
        const key = `iv-occupied-${method}-${field}-${sfx}`;
        const id = `${A.id}:${key}`;
        const destination = field === "agentId" ? { agentId: B.id, key } : { agentId: A.id, key: `${key}-other` };
        const destinationId = `destination-${method}-${field}-${sfx}`;
        await createSoul(id, A.id, key, "before");
        await createSoul(destinationId, destination.agentId, destination.key, "occupied");
        const beforeRows = await Promise.all([soulRow(id), soulRow(destinationId)]);
        const beforeVersions = await Promise.all([versionsOf(`${A.id}:${key}`), versionsOf(`${destination.agentId}:${destination.key}`)]);
        const result = await call("basic", method, soulPath(id), { ...destination, value: "after" });
        expect(result.status, result.text).toBe(409);
        expect(JSON.parse(result.text)).toEqual({ error: "soul_subject_occupied" });
        expect(await Promise.all([soulRow(id), soulRow(destinationId)])).toEqual(beforeRows);
        expect(await Promise.all([versionsOf(`${A.id}:${key}`), versionsOf(`${destination.agentId}:${destination.key}`)])).toEqual(beforeVersions);
      }
    }, 120_000);
  }

  test("legacy colon history remains readable and an update links to its pair's head", async () => {
    const agentId = `iv-legacy-${sfx}`;
    const key = "b:c";
    const id = `legacy-row-${sfx}`;
    const subjectId = `${agentId}:${key}`;
    const createdAt = now();
    const soul = { id, agentId, key, value: "before", durability: "permanent", createdAt, updatedAt: createdAt };
    const legacy = {
      id: `soul:${subjectId}:1`, subjectType: "soul", subjectId, agentId, key, version: 1,
      kind: "create", rowId: id, valueHash: createHash("sha256").update(soul.value, "utf8").digest("hex"),
      previousVersionHash: null, soulSnapshot: JSON.stringify(soul),
      memoryId: null, visibility: null, actorKind: "operator", actorId: null, sourceClass: "operator",
      createdAt, guarded: false, expectedVersion: null, recordHash: "",
    };
    legacy.recordHash = recordHashOf(legacy);
    await upsert("Soul", [soul]);
    await upsert("InstructionVersion", [legacy]);
    const read = await call(B, "GET", versionPath(legacy.id));
    expect(read.status, read.text).toBe(200);
    expect(JSON.parse(read.text).recordHash).toBe(legacy.recordHash);
    const result = await call("basic", "PATCH", soulPath(id), { value: "after" });
    expect(result.status, result.text).toBeLessThan(300);
    const [next] = await versionsOf(`:${JSON.stringify([agentId, key])}`);
    expect(Number(next.version)).toBe(2);
    expect(next.previousVersionHash).toBe(legacy.recordHash);
    expect((await versionsOf(subjectId))[0].recordHash).toBe(legacy.recordHash);
  }, 120_000);

  test("an identity no-op Soul update opens no new window", async () => {
    const key = `iv-agentid-noop-${sfx}`;
    const id = `${A.id}:${key}`;
    await createSoul(id, A.id, key, "before");
    const put = await call("basic", "PUT", soulPath(id), { id, agentId: A.id, key, value: "v1" });
    expect(put.status, put.text.slice(0, 200)).toBeLessThan(300);
    const patch = await call("basic", "PATCH", soulPath(id), { value: "v2" });
    expect(patch.status, patch.text.slice(0, 200)).toBeLessThan(300);
    const versions = await versionsOf(`${A.id}:${key}`);
    expect(versions.map((r) => r.kind)).toEqual(["create", "update", "update"]);
    expect(versions.map((r) => Number(r.version))).toEqual([1, 2, 3]);
    expect(versions.some((r) => r.kind === "delete")).toBe(false);
    expect(await versionsOf(`${B.id}:${key}`)).toEqual([]);
  }, 120_000);

  test("ordinary and key-change duplicate ids preserve the prior version and Soul row", async () => {
    for (const collision of ["ordinary", "tombstone", "successor"]) {
      const key = `iv-duplicate-${collision}-${sfx}`;
      const id = `${A.id}:${key}`;
      const newKey = collision === "ordinary" ? key : `${key}-new`;
      const before = { id, agentId: A.id, key, value: "before", createdAt: "2020-01-01T00:00:00.000Z" };
      await upsert("Soul", [before]);
      const occupiedSubject = collision === "successor" ? `${A.id}:${newKey}` : id;
      const occupiedId = `soul:${occupiedSubject}:1`;
      await upsert("InstructionVersion", [{
        id: occupiedId, subjectType: "soul", subjectId: `hidden-${collision}-${sfx}`, agentId: A.id,
        key, version: 1, kind: "create", rowId: id, recordHash: "unchanged", createdAt: now(), guarded: false,
        actorKind: "operator", sourceClass: "operator",
      }]);
      const occupied = await ops({ operation: "search_by_id", database: "flair", table: "InstructionVersion", ids: [occupiedId], get_attributes: ["*"] });
      const stored = await soulRow(id);
      const result = await call("basic", "PUT", soulPath(id), { agentId: A.id, key: newKey, value: "after" });
      expect(result.status, result.text).toBe(500);
      expect(await soulRow(id)).toEqual(stored);
      expect(await ops({ operation: "search_by_id", database: "flair", table: "InstructionVersion", ids: [occupiedId], get_attributes: ["*"] })).toEqual(occupied);
      expect(await versionsOf(id)).toEqual([]);
      if (newKey !== key) expect(await versionsOf(`${A.id}:${newKey}`)).toEqual([]);
    }
  }, 120_000);

  test("spoofed audit fields on a Soul write are ignored", async () => {
    const key = `iv-spoof-${sfx}`;
    const id = `${A.id}:${key}`;
    const subjectId = `${A.id}:${key}`;
    const res = await call("basic", "POST", "/Soul/", {
      id, agentId: A.id, key, value: "spoofed", durability: "permanent",
      actorKind: "agent", actorId: "forged", sourceClass: "forged",
      guarded: true, expectedVersion: "forged", recordHash: "forged", version: 999,
    });
    expect(res.status, res.text.slice(0, 200)).toBeLessThan(300);
    const [row] = await versionsOf(subjectId);
    expect(row.actorKind).toBe("operator");
    expect(row.actorId).toBe(harper.admin.username);
    expect(row.sourceClass).toBe("operator");
    expect(row.guarded).toBe(false);
    expect(row.expectedVersion).toBeNull();
    expect(Number(row.version)).toBe(1);
    expect(row.recordHash).toBe(recordHashOf(row));
  }, 120_000);
});
