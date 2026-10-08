/**
 * owner-delete-recheck-2355.test.ts — flair#2355, real Harper.
 *
 * A non-admin owner-scoped delete (Memory, Credential, MemoryGrant,
 * WorkspaceState, MemoryCandidate, Relationship) re-reads the row and confirms
 * the COMMITTED row's owner before the row is removed. A skill-tagged Memory
 * delete closes the subject's live head, which a stale id resolves to a
 * different row, and confirms that head's committed owner as well. Credential,
 * MemoryGrant, WorkspaceState, MemoryCandidate and Relationship confirm through
 * resources/owner-delete-recheck.ts, while a transaction the delete owns is
 * open. Memory's ordinary-row check is inline in resources/Memory.ts (through
 * withSharedWriteTransaction, which JOINS a request-owned transaction when one
 * exists); its skill-tagged check is inline in the same file's version writer.
 * These cases change a row's owner around that transaction (a raw table update,
 * as an operator would make); one skill case removes the head instead:
 *
 *   - (pause) the delete pauses between the ownership read and the delete
 *     (resources/txn-pause-point.ts, enabled by
 *     FLAIR_ENABLE_TEST_FAULT_INJECTION and FLAIR_TEST_PAUSE_DIR, set for this
 *     file's Harper only). The test arms the pause, starts the delete, waits
 *     until it is paused, commits the competing owner change, then releases it.
 *     The change is visible at the confirmation read, so the delete is refused
 *     (409 `owner_changed`) and the row survives with the competing owner.
 *   - (pre) the competing owner change commits first: the pause holds the
 *     delete before its transactional re-read or staging, the change commits,
 *     and the delete's in-transaction re-read sees it. The delete is refused and
 *     the row survives.
 *
 * Unchanged ownership still succeeds (the control cases).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { HarperInstance, startHarper, stopHarper } from "../helpers/harper-lifecycle";
import { getModelId } from "../../resources/embeddings-provider.ts";

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
async function insertRow(harper: HarperInstance, table: string, row: Record<string, unknown>): Promise<void> {
  const res = await adminOp(harper, { operation: "insert", database: "flair", table, records: [row] });
  expect(res.status, `raw insert into ${table} returned ${res.status}: ${(await res.text()).slice(0, 200)}`).toBe(200);
}
async function readRow(harper: HarperInstance, table: string, id: string): Promise<any> {
  const res = await adminOp(harper, {
    operation: "search_by_value", database: "flair", table,
    search_attribute: "id", search_type: "equals", search_value: id, get_attributes: ["*"],
  });
  const text = await res.text();
  expect(res.status, `row read of ${table}/${id} returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
  return (JSON.parse(text) as any[])[0] ?? null;
}
async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

interface ResourceCase {
  name: string;
  table: string;
  ownerField: string;
  /** The in-transaction pause point (between the ownership read and the delete). */
  point: string;
  /** The pause point after the pre-read, before the delete's transaction opens. */
  prePoint: string;
  /** A row for `id`, owned by `ownerId`. */
  seed: (id: string, ownerId: string) => Record<string, unknown>;
}

let harper: HarperInstance;
let pauseDir: string;
const owner = mkAgent("odr-owner");
const other = mkAgent("odr-other");

const IDS = {
  Memory: "odr-memory-target",
  Credential: "odr-credential-target",
  MemoryGrant: "odr-grant-target",
  WorkspaceState: "odr-workspace-target",
  MemoryCandidate: "odr-candidate-target",
  Relationship: "odr-relationship-target",
} as const;

/** A fresh row id per (resource, case) so the three cases never share a row. */
const idFor = (c: ResourceCase, which: string) => `${IDS[c.name as keyof typeof IDS]}-${which}`;

const CASES: ResourceCase[] = [
  {
    name: "Memory", table: "Memory", ownerField: "agentId",
    point: "memory-delete", prePoint: "memory-delete-pre",
    seed: (id, ownerId) => ({
      id, agentId: ownerId, content: "owner-delete target body, long enough for the gate.", contentHash: id,
      visibility: "shared", archived: false, instanceToken: randomUUID(), createdAt: "2026-01-01T00:00:00.000Z",
      embedding: [0.1, 0.1, 0.1], embeddingModel: getModelId(),
    }),
  },
  {
    name: "Credential", table: "Credential", ownerField: "principalId",
    point: "credential-delete", prePoint: "credential-delete-pre",
    seed: (id, ownerId) => ({ id, principalId: ownerId, kind: "bearer-token", status: "active", createdAt: "2026-01-01T00:00:00.000Z" }),
  },
  {
    name: "MemoryGrant", table: "MemoryGrant", ownerField: "ownerId",
    point: "grant-delete", prePoint: "grant-delete-pre",
    seed: (id, ownerId) => ({ id, ownerId, granteeId: other.id, scope: "read", createdAt: "2026-01-01T00:00:00.000Z" }),
  },
  {
    name: "WorkspaceState", table: "WorkspaceState", ownerField: "agentId",
    point: "workspace-delete", prePoint: "workspace-delete-pre",
    seed: (id, ownerId) => ({ id, agentId: ownerId, ref: "main", provider: "github", timestamp: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" }),
  },
  {
    name: "MemoryCandidate", table: "MemoryCandidate", ownerField: "agentId",
    point: "candidate-delete", prePoint: "candidate-delete-pre",
    seed: (id, ownerId) => ({ id, agentId: ownerId, claim: "owner-delete target claim", generatedAt: "2026-01-01T00:00:00.000Z", status: "pending" }),
  },
  {
    name: "Relationship", table: "Relationship", ownerField: "agentId",
    point: "relationship-delete", prePoint: "relationship-delete-pre",
    seed: (id, ownerId) => ({ id, agentId: ownerId, subject: "host-a", predicate: "manages", object: "agent-a", createdAt: "2026-01-01T00:00:00.000Z" }),
  },
];

function pointsFor(point: string) {
  return {
    arm: join(pauseDir, `arm.${point}`),
    paused: join(pauseDir, `paused.${point}`),
    released: join(pauseDir, `released.${point}`),
    go: join(pauseDir, `go.${point}`),
  };
}

/** Arm `point`, start the delete, once it is paused commit `compete`, then release it. */
async function withPausedDelete<T>(point: string, del: () => Promise<Response>, compete: () => Promise<T>) {
  const p = pointsFor(point);
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
  writeFileSync(p.arm, "");
  const pending = del();
  const paused = await waitFor(p.paused, 15_000);
  let competed: T | undefined;
  try {
    if (paused) competed = await compete();
  } finally {
    writeFileSync(p.go, "");
  }
  const response = await pending;
  const released = paused ? readFileSync(p.released, "utf8") : "never paused";
  return { response, competed, released };
}

/** Change `id`'s owner to `other` with a raw table update. */
function changeOwner(c: ResourceCase, id: string) {
  return adminOp(harper, {
    operation: "update", database: "flair", table: c.table, records: [{ id, [c.ownerField]: other.id }],
  }).then((r) => r.status);
}

beforeAll(async () => {
  pauseDir = mkdtempSync(join(tmpdir(), "flair-odr-2355-pause-"));
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
  await seedAgent(harper, owner);
  await seedAgent(harper, other);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
});

describe("flair#2355 — an owner-scoped delete confirms the committed owner while its write transaction is open (real Harper)", () => {
  for (const c of CASES) {
    it(`${c.name}: unchanged ownership still deletes`, async () => {
      const id = idFor(c, "ctl");
      await insertRow(harper, c.table, c.seed(id, owner.id));
      const res = await authSend(harper, owner, "DELETE", `/${c.table}/${id}`);
      const text = await res.text();
      expect([200, 204], `${c.name} owner DELETE returned ${res.status}: ${text.slice(0, 300)}`).toContain(res.status);
      expect(await readRow(harper, c.table, id), `${c.name} row survived an owner delete`).toBeNull();
    }, 60_000);

    it(`${c.name} (pause): an owner change committed while the delete is paused is refused and the row survives`, async () => {
      const id = idFor(c, "pause");
      const row = c.seed(id, owner.id);
      await insertRow(harper, c.table, row);
      const { response, competed, released } = await withPausedDelete(
        c.point,
        () => authSend(harper, owner, "DELETE", `/${c.table}/${id}`),
        () => changeOwner(c, id),
      );
      expect(released, `${c.name} delete was not paused and released by this test`).toBe("go");
      expect(competed, `the competing owner change failed for ${c.name}`).toBe(200);
      const text = await response.text();
      expect(response.status, `${c.name} DELETE returned ${response.status}: ${text.slice(0, 300)}`).toBe(409);
      expect(JSON.parse(text).error, `${c.name} refusal error`).toBe("owner_changed");
      const after = await readRow(harper, c.table, id);
      expect(after, `${c.name} row was deleted although its owner changed`).not.toBeNull();
      expect(after?.[c.ownerField], `${c.name} competing owner change not kept`).toBe(other.id);
    }, 60_000);

    it(`${c.name} (pre): an owner change committed before the delete's transactional re-read is refused and the row survives`, async () => {
      const id = idFor(c, "pre");
      const row = c.seed(id, owner.id);
      await insertRow(harper, c.table, row);
      const { response, competed, released } = await withPausedDelete(
        c.prePoint,
        () => authSend(harper, owner, "DELETE", `/${c.table}/${id}`),
        () => changeOwner(c, id),
      );
      expect(released, `${c.name} delete was not paused and released by this test`).toBe("go");
      expect(competed, `the competing owner change failed for ${c.name}`).toBe(200);
      const text = await response.text();
      expect(response.status, `${c.name} DELETE returned ${response.status}: ${text.slice(0, 300)}`).toBe(409);
      expect(JSON.parse(text).error, `${c.name} refusal error`).toBe("owner_changed");
      const after = await readRow(harper, c.table, id);
      expect(after, `${c.name} row was deleted although its owner changed`).not.toBeNull();
      expect(after?.[c.ownerField], `${c.name} competing owner change not kept`).toBe(other.id);
    }, 60_000);
  }
});

describe("flair#2355 — a skill-tagged Memory delete confirms the committed owner of the row it addresses and of the head it closes (real Harper)", () => {
  const SKILL: ResourceCase = {
    name: "Memory(skill)", table: "Memory", ownerField: "agentId",
    point: "memory-skill-delete", prePoint: "memory-skill-delete-pre",
    seed: (id, ownerId) => ({
      id, agentId: ownerId, tags: ["skill"], skillSubjectId: id,
      content: "owner-delete skill target body, long enough for the gate.",
      durability: "persistent", visibility: "shared", archived: false,
      instanceToken: randomUUID(), createdAt: "2026-01-01T00:00:00.000Z",
      embedding: [0.1, 0.1, 0.1], embeddingModel: getModelId(),
    }),
  };

  it("unchanged ownership still closes the row", async () => {
    const id = idFor(SKILL, "ctl");
    await insertRow(harper, SKILL.table, SKILL.seed(id, owner.id));
    const res = await authSend(harper, owner, "DELETE", `/${SKILL.table}/${id}`);
    const text = await res.text();
    expect(res.status, `skill DELETE returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
    const after = await readRow(harper, SKILL.table, id);
    expect(after, "the skill row was physically removed").not.toBeNull();
    expect(typeof after.validTo === "string" && after.validTo.length > 0, "the skill row was not closed").toBe(true);
  }, 60_000);

  it("(pause): an owner change committed while the delete is paused is refused and the row survives", async () => {
    const id = idFor(SKILL, "pause");
    await insertRow(harper, SKILL.table, SKILL.seed(id, owner.id));
    const { response, competed, released } = await withPausedDelete(
      SKILL.point,
      () => authSend(harper, owner, "DELETE", `/${SKILL.table}/${id}`),
      () => changeOwner(SKILL, id),
    );
    expect(released, "skill delete was not paused and released by this test").toBe("go");
    expect(competed, "the competing owner change failed for the skill row").toBe(200);
    const text = await response.text();
    expect(response.status, `skill DELETE returned ${response.status}: ${text.slice(0, 300)}`).toBe(409);
    expect(JSON.parse(text).error, "skill refusal error").toBe("owner_changed");
    const after = await readRow(harper, SKILL.table, id);
    expect(after, "the skill row was closed although its owner changed").not.toBeNull();
    expect(after?.agentId, "competing owner change not kept").toBe(other.id);
  }, 60_000);

  it("(pre): an owner change committed before the delete's transaction opens is refused and the row survives", async () => {
    const id = idFor(SKILL, "pre");
    await insertRow(harper, SKILL.table, SKILL.seed(id, owner.id));
    const { response, competed, released } = await withPausedDelete(
      SKILL.prePoint,
      () => authSend(harper, owner, "DELETE", `/${SKILL.table}/${id}`),
      () => changeOwner(SKILL, id),
    );
    expect(released, "skill delete was not paused and released by this test").toBe("go");
    expect(competed, "the competing owner change failed for the skill row").toBe(200);
    const text = await response.text();
    expect(response.status, `skill DELETE returned ${response.status}: ${text.slice(0, 300)}`).toBe(409);
    expect(JSON.parse(text).error, "skill refusal error").toBe("owner_changed");
    const after = await readRow(harper, SKILL.table, id);
    expect(after, "the skill row was closed although its owner changed").not.toBeNull();
    expect(after?.agentId, "competing owner change not kept").toBe(other.id);
  }, 60_000);

  /** Create a skill and update it through the version writer: the created row
   *  is then closed (a stale id) and the update's successor is the live head. */
  async function staleSkillLineage(which: string): Promise<{ staleId: string; headId: string }> {
    const staleId = idFor(SKILL, which);
    const body = (content: string) => ({
      id: staleId, agentId: owner.id, content, trigger: `when to ${content}`, tags: ["skill"], durability: "persistent",
    });
    const created = await authSend(harper, owner, "PUT", `/Memory/${staleId}`, body("first skill version"));
    expect(created.status, `skill create returned ${created.status}: ${(await created.text()).slice(0, 300)}`).toBeLessThan(300);
    const updated = await authSend(harper, owner, "PUT", `/Memory/${staleId}`, body("second skill version"));
    const text = await updated.text();
    expect(updated.status, `skill update returned ${updated.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
    const headId = String(JSON.parse(text).id);
    expect(headId, "the update did not write a successor row").not.toBe(staleId);
    const stale = await readRow(harper, "Memory", staleId);
    expect(typeof stale?.validTo === "string" && stale.validTo.length > 0, "the addressed row is not closed").toBe(true);
    return { staleId, headId };
  }
  const isClosed = (row: any) => typeof row?.validTo === "string" && row.validTo.length > 0;

  it("stale id, unchanged ownership: the delete closes the live head", async () => {
    const { staleId, headId } = await staleSkillLineage("stale-ctl");
    const res = await authSend(harper, owner, "DELETE", `/Memory/${staleId}`);
    const text = await res.text();
    expect(res.status, `stale-id DELETE returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
    expect(JSON.parse(text).id, "the delete closed a row other than the live head").toBe(headId);
    expect(isClosed(await readRow(harper, "Memory", headId)), "the live head was not closed").toBe(true);
  }, 60_000);

  it("stale id (pause): an owner change to the live head committed while the delete is paused is refused and the head stays open", async () => {
    const { staleId, headId } = await staleSkillLineage("stale-pause");
    const { response, competed, released } = await withPausedDelete(
      SKILL.point,
      () => authSend(harper, owner, "DELETE", `/Memory/${staleId}`),
      () => changeOwner(SKILL, headId),
    );
    expect(released, "stale-id delete was not paused and released by this test").toBe("go");
    expect(competed, "the competing owner change to the head failed").toBe(200);
    const text = await response.text();
    expect(response.status, `stale-id DELETE returned ${response.status}: ${text.slice(0, 300)}`).toBe(409);
    expect(JSON.parse(text).error, "stale-id refusal error").toBe("owner_changed");
    const head = await readRow(harper, "Memory", headId);
    expect(head?.agentId, "competing owner change to the head not kept").toBe(other.id);
    expect(isClosed(head), "the live head was closed although its owner changed").toBe(false);
  }, 60_000);

  it("stale id (pre): an owner change to the live head committed before the delete's transactional re-read is refused and the head stays open", async () => {
    const { staleId, headId } = await staleSkillLineage("stale-pre");
    const { response, competed, released } = await withPausedDelete(
      SKILL.prePoint,
      () => authSend(harper, owner, "DELETE", `/Memory/${staleId}`),
      () => changeOwner(SKILL, headId),
    );
    expect(released, "stale-id delete was not paused and released by this test").toBe("go");
    expect(competed, "the competing owner change to the head failed").toBe(200);
    const text = await response.text();
    // The transaction reads the head with its new owner, and the caller holds
    // no write grant from that owner.
    expect(response.status, `stale-id DELETE returned ${response.status}: ${text.slice(0, 300)}`).toBe(403);
    expect(JSON.parse(text).error, "stale-id refusal error").toBe("forbidden: cannot write a skill owned by another agent without a write grant");
    const head = await readRow(harper, "Memory", headId);
    expect(head?.agentId, "competing owner change to the head not kept").toBe(other.id);
    expect(isClosed(head), "the live head was closed although its owner changed").toBe(false);
  }, 60_000);

  it("stale id (pause): a live head removed while the delete is paused is refused and not written back", async () => {
    const { staleId, headId } = await staleSkillLineage("stale-gone");
    const { response, competed, released } = await withPausedDelete(
      SKILL.point,
      () => authSend(harper, owner, "DELETE", `/Memory/${staleId}`),
      () => adminOp(harper, { operation: "delete", database: "flair", table: "Memory", ids: [headId] }).then((r) => r.status),
    );
    expect(released, "stale-id delete was not paused and released by this test").toBe("go");
    expect(competed, "the competing removal of the head failed").toBe(200);
    const text = await response.text();
    expect(response.status, `stale-id DELETE returned ${response.status}: ${text.slice(0, 300)}`).toBe(409);
    expect(JSON.parse(text).error, "stale-id refusal error").toBe("skill_head_missing");
    expect(await readRow(harper, "Memory", headId), "the removed head was written back").toBeNull();
  }, 60_000);
});
