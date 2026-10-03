// ─── flair#2139 S2 COMPLETION (slice 2c) against a real Harper ──────────────
//
// The deferred items 1–5 of PR #2246, each exercised end-to-end through the real
// resource boundary:
//   (1) the decision-3 read predicate on RETAINED (closed) skill payloads via
//       Memory GET/search — a reader who may not read a version cannot read its
//       retained payload either; live-row semantics for a current skill are
//       unchanged.
//   (2) `_reindex` stays bookkeeping only — a re-PUT that would change a skill's
//       instruction fields / ownership / visibility / lineage is refused, and a
//       bookkeeping re-PUT preserves the subject.
//   (3) the seed reservation covers the logical LINEAGE, not only the physical
//       seed id.
//   (5) the TEST-ONLY per-step fault hook (resources/skill-write-fault.ts): a
//       failure at the successor write, predecessor close, pointer write or
//       version append aborts the whole transaction — no successor, no close,
//       no version row.
//
// RED on #2246's head (no closed-payload predicate, no reindex refusal, no
// lineage reservation, no fault hook); GREEN here.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";
import { SEED_SKILL_ROW_ID } from "../../resources/seed-ids.js";
import { ENABLE_TEST_FAULTS_ENV, TEST_FAULT_AGENT_PREFIX } from "../../resources/skill-write-fault.js";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }
const mkAgent = (id: string): TestAgent => {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
};

const sfx = Date.now().toString(36);
const A = mkAgent(`skc-owner-${sfx}`);
const B = mkAgent(`skc-other-${sfx}`);
const ADMIN_AGENT = mkAgent(`skc-admin-${sfx}`);
const STEPS = ["successor", "close", "pointer", "append"] as const;
const FAULT = Object.fromEntries(STEPS.map((s) => [s, mkAgent(`${TEST_FAULT_AGENT_PREFIX}${s}`)])) as
  Record<(typeof STEPS)[number], TestAgent>;
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

async function memoryRowsBySubject(subjectId: string): Promise<any[]> {
  const rows = await ops({
    operation: "search_by_value", database: "flair", table: "Memory",
    search_attribute: "skillSubjectId", search_value: subjectId, get_attributes: ["id"],
  });
  return rows as any[];
}

async function memoryRow(id: string): Promise<any | null> {
  const rows = await ops({ operation: "search_by_id", database: "flair", table: "Memory", ids: [id], get_attributes: ["*"] });
  return rows[0] ?? null;
}

const memPath = (id: string) => `/Memory/${encodeURIComponent(id)}`;
const searchByQuery = (param: string, value: string) => `/Memory/?${param}=${encodeURIComponent(value)}`;

function skillBody(who: TestAgent, id: string, content: string, extra: Record<string, unknown> = {}) {
  return { id, agentId: who.id, content, trigger: `when to ${content}`, tags: ["skill"], durability: "persistent", ...extra };
}

let seq = 0;
const nextId = (label: string) => `skc-${label}-${sfx}-${++seq}`;

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  // Arm the test-only fault hook for THIS spawned Harper (inherited env). The
  // hook still needs a reserved agent id, so no other write here can fault.
  process.env[ENABLE_TEST_FAULTS_ENV] = "1";
  harper = await startHarper();
  installDir = harper.installDir;
  assertOwnInstance(harper);
  await ops({
    operation: "upsert", database: "flair", table: "Agent",
    records: [...[A, B, ...STEPS.map((s) => FAULT[s])].map((a) => ({ id: a.id, name: a.id, role: "agent", publicKey: a.publicKey, createdAt: now() })),
      { id: ADMIN_AGENT.id, name: ADMIN_AGENT.id, role: "admin", admin: true, publicKey: ADMIN_AGENT.publicKey, createdAt: now() }],
  });
  await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
  await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);
}, 240_000);

afterAll(async () => {
  delete process.env[ENABLE_TEST_FAULTS_ENV];
  if (harper) await stopHarper(harper);
  if (installDir) await rm(installDir, { recursive: true, force: true, maxRetries: 4 });
});

// ─── Item 1: retained-payload predicate on Memory GET/search ────────────────

describe("flair#2139 S2c (1) — retained closed skill payloads obey decision 3", () => {
  test("a retained shared payload is denied to a reader once the subject is private", async () => {
    const id = nextId("retained");
    expect((await call(A, "PUT", memPath(id), skillBody(A, id, "v1", { visibility: "shared" }))).status).toBeLessThan(300);
    const upd = await call(A, "PUT", memPath(id), skillBody(A, id, "v2", { visibility: "private" }));
    expect(upd.status, upd.text.slice(0, 200)).toBeLessThan(300);
    const successor = JSON.parse(upd.text).id;
    expect(successor).not.toBe(id);
    // The predecessor is closed and retains its shared payload.
    const predecessor = await memoryRow(id);
    expect(typeof predecessor.validTo).toBe("string");
    expect(predecessor.visibility).toBe("shared");

    // The other agent cannot read the retained payload (current subject is private).
    expect((await call(B, "GET", memPath(id))).status, "retained payload must be denied once the subject is private").toBe(404);
    // The owner still reads it.
    expect((await call(A, "GET", memPath(id))).status).toBe(200);
  }, 120_000);

  test("the by-id read of a current (open) skill keeps its live semantics", async () => {
    const id = nextId("live");
    await call(A, "PUT", memPath(id), skillBody(A, id, "live", { visibility: "shared" }));
    expect((await call(B, "GET", memPath(id))).status, "an open shared skill stays readable").toBe(200);
  }, 120_000);

  test("the collection read does not surface a denied retained payload", async () => {
    const id = nextId("search");
    await call(A, "PUT", memPath(id), skillBody(A, id, "s1", { visibility: "shared" }));
    await call(A, "PUT", memPath(id), skillBody(A, id, "s2", { visibility: "private" }));
    const asB = await call(B, "GET", searchByQuery("id", id));
    expect(asB.status, asB.text.slice(0, 200)).toBe(200);
    expect(JSON.parse(asB.text).map((r: any) => r.id)).not.toContain(id);
    const asA = await call(A, "GET", searchByQuery("id", id));
    expect(JSON.parse(asA.text).map((r: any) => r.id)).toContain(id);
  }, 120_000);

  test("after a logical delete the tombstone's last authority governs the retained payload", async () => {
    const shared = nextId("tomb-shared");
    await call(A, "PUT", memPath(shared), skillBody(A, shared, "keep", { visibility: "shared" }));
    expect((await call(A, "DELETE", memPath(shared))).status).toBeLessThan(300);
    expect((await call(B, "GET", memPath(shared))).status, "a shared tombstone keeps the payload readable").toBe(200);

    const priv = nextId("tomb-private");
    await call(A, "PUT", memPath(priv), skillBody(A, priv, "keep", { visibility: "private" }));
    expect((await call(A, "DELETE", memPath(priv))).status).toBeLessThan(300);
    expect((await call(B, "GET", memPath(priv))).status, "a private tombstone revokes the payload").toBe(404);
  }, 120_000);
});

// ─── Item 2: `_reindex` is bookkeeping only ─────────────────────────────────

describe("flair#2139 S2c (2) — _reindex is bookkeeping only", () => {
  test("a re-PUT that would change a skill's content is refused (409)", async () => {
    const id = nextId("reindex");
    await call(A, "PUT", memPath(id), skillBody(A, id, "original"));
    const stored = await memoryRow(id);
    const res = await call(ADMIN_AGENT, "PUT", memPath(id), { ...stored, content: "changed", _reindex: true });
    expect(res.status, res.text.slice(0, 200)).toBe(409);
    expect(JSON.parse(res.text).error).toBe("reindex_would_change_row");
    expect((await memoryRow(id)).content).toBe("original");
  }, 120_000);

  test("a bookkeeping re-PUT preserves the skill subject and ownership", async () => {
    const id = nextId("reindex-ok");
    await call(A, "PUT", memPath(id), skillBody(A, id, "steady"));
    const stored = await memoryRow(id);
    const res = await call(ADMIN_AGENT, "PUT", memPath(id), { ...stored, _reindex: true });
    expect(res.status, res.text.slice(0, 200)).toBeLessThan(300);
    const after = await memoryRow(id);
    expect(after.content).toBe("steady");
    expect(after.agentId).toBe(A.id);
    expect(after.skillSubjectId).toBe(stored.skillSubjectId);
  }, 120_000);
});

// ─── Item 3: seed reservation across the logical lineage ────────────────────

describe("flair#2139 S2c (3) — the seed reservation covers the lineage", () => {
  test("a non-operator write whose SUBJECT is the seed's is refused; the operator may write it", async () => {
    const successor = nextId("seed-lineage");
    await ops({
      operation: "upsert", database: "flair", table: "Memory",
      records: [{
        id: successor, agentId: A.id, content: "seed skill", trigger: "t", tags: ["skill"],
        skillSubjectId: SEED_SKILL_ROW_ID, durability: "persistent", visibility: "shared", createdAt: now(),
      }],
    });
    const denied = await call(A, "PUT", memPath(successor), skillBody(A, successor, "edited"));
    expect(denied.status, denied.text.slice(0, 200)).toBe(403);
    expect(JSON.parse(denied.text).error).toContain("seed_subject_reserved");

    const allowed = await call("basic", "PUT", memPath(successor), skillBody(A, successor, "edited"));
    expect(allowed.status, allowed.text.slice(0, 200)).toBeLessThan(300);
  }, 120_000);
});

// ─── Item 5: REAL-Harper per-step failure injection ─────────────────────────

describe("flair#2139 S2c (5) — a per-step failure aborts the whole skill write", () => {
  for (const step of STEPS) {
    test(`a fault at '${step}' leaves no successor, no close and no version`, async () => {
      const agent = FAULT[step];
      const id = nextId(`fault-${step}`);
      await ops({
        operation: "upsert", database: "flair", table: "Memory",
        records: [{
          id, agentId: agent.id, content: "v1", trigger: "t", tags: ["skill"],
          skillSubjectId: id, durability: "persistent", visibility: "shared", createdAt: now(),
        }],
      });
      const before = await memoryRow(id);

      const res = await call(agent, "PUT", memPath(id), skillBody(agent, id, "v2", { visibility: "shared" }));
      expect(res.status, `fault at ${step}: ${res.text.slice(0, 200)}`).toBe(500);

      // The predecessor is unchanged: same content, still open, same subject.
      const after = await memoryRow(id);
      expect(after.content).toBe("v1");
      expect(after.validTo ?? null).toBeNull();
      expect(after.skillSubjectId).toBe(id);
      expect(after.updatedAt).toBe(before.updatedAt);

      // No successor row was left behind, and no version was appended.
      expect((await memoryRowsBySubject(id)).map((r: any) => r.id), "no successor may survive").toEqual([id]);
      expect(await versionsOf(id), "no version row may survive").toHaveLength(0);
      // No residue of the failed content for this owner at all.
      const owned = await ops({
        operation: "search_by_value", database: "flair", table: "Memory",
        search_attribute: "agentId", search_value: agent.id, get_attributes: ["id", "content"],
      });
      expect((owned as any[]).filter((r) => r.content === "v2")).toEqual([]);
    }, 120_000);
  }
});
