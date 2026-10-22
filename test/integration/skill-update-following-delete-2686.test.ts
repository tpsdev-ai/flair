/**
 * skill-update-following-delete-2686.test.ts — real Harper: a skill update
 * whose subject gains a following delete version that Flair's own delete path
 * cannot produce (flair#2686, part 2).
 *
 * Flair's delete path selects the live head and derives the version hash link
 * from the head, so a delete version that names a different row, or whose
 * previous-version hash is not this update's record hash, is created here by
 * inserting the version row directly. The cases pin the outcomes the code gives
 * today on that state:
 *
 * - with the successor still open, the update answers 200 and the successor is
 *   the sole live head;
 * - with the successor closed, the update answers 500
 *   `skill_update_compensation_failed` and both rows stay closed;
 * - the control deletes the successor through Flair's own path, where both
 *   writes succeed and the delete version names and hash-links the successor.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { assertOwnInstance } from "../helpers/own-harper-instance";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }
const mkAgent = (id: string): TestAgent => {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
};

const sfx = Date.now().toString(36);
const A = mkAgent(`agent-a-${sfx}`);
const B = mkAgent(`agent-b-${sfx}`);
const now = () => new Date().toISOString();

let harper: HarperInstance;
let pauseDir = "";

const basicAuth = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify(operation),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBe(200);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

async function memoryRow(id: string): Promise<any | null> {
  const rows = await ops({ operation: "search_by_id", database: "flair", table: "Memory", ids: [id], get_attributes: ["*"] });
  return rows[0] ?? null;
}

async function liveHeads(subjectId: string): Promise<string[]> {
  const rows = await ops({
    operation: "search_by_value", database: "flair", table: "Memory",
    search_attribute: "skillSubjectId", search_value: subjectId, get_attributes: ["id", "validTo", "archived"],
  });
  return (rows as any[])
    .filter((row) => row.archived !== true && !(typeof row.validTo === "string" && row.validTo.length > 0))
    .map((row) => String(row.id));
}

async function versionsOf(subjectId: string): Promise<any[]> {
  const rows = await ops({
    operation: "search_by_value", database: "flair", table: "InstructionVersion",
    search_attribute: "subjectId", search_value: subjectId, get_attributes: ["*"],
  });
  return (rows as any[]).sort((a, b) => Number(a.version) - Number(b.version));
}

function ed25519(who: TestAgent, method: string, path: string): string {
  const ts = String(Date.now());
  const nonce = randomUUID();
  const sig = nacl.sign.detached(new TextEncoder().encode(`${who.id}:${ts}:${nonce}:${method}:${path}`), who.secretKey);
  return `TPS-Ed25519 ${who.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

async function call(auth: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(harper.httpURL + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: ed25519(auth, method, path) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}

const memPath = (id: string) => `/Memory/${encodeURIComponent(id)}`;

async function skillEventsOf(subjectId: string): Promise<any[]> {
  const rows = await ops({
    operation: "search_by_value", database: "flair", table: "OrgEvent",
    search_attribute: "kind", search_value: "skill.changed", get_attributes: ["*"],
  });
  return (rows as any[]).filter((event) => JSON.parse(event.detail).subjectId === subjectId);
}

function skillBody(id: string, content: string, extra: Record<string, unknown> = {}) {
  return { id, agentId: A.id, content, trigger: `when to ${content}`, tags: ["skill"], durability: "persistent", ...extra };
}

let seq = 0;
const nextId = (label: string) => `suc-${label}-${sfx}-${++seq}`;

async function waitFor(path: string, timeoutMs: number, content?: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path) && (content === undefined || readFileSync(path, "utf8") === content)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** Arm `point`, start `trigger`, run `compete` once it is paused, release, await it. */
async function withPaused(point: string, trigger: () => Promise<Response>, compete: () => Promise<void>) {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${point}`), "");
  const pending = trigger();
  const paused = await waitFor(join(pauseDir, `paused.${point}`), 20_000);
  try {
    if (paused) await compete();
  } finally {
    writeFileSync(join(pauseDir, `go.${point}`), "");
  }
  const response = await pending;
  const released = paused ? readFileSync(join(pauseDir, `released.${point}`), "utf8") : "never paused";
  return { response, released, paused };
}

/** Commit a newer full record to the skill row, outside the version write lock. */
async function commitNewerSkillWrite(id: string, content: string, extra: Record<string, unknown> = {}): Promise<void> {
  const current = await memoryRow(id);
  expect(current, "the skill row is missing before the competing write").not.toBeNull();
  await ops({
    operation: "put", database: "flair", table: "Memory",
    records: [{ ...current, content, updatedAt: now(), ...extra }],
  });
  expect((await memoryRow(id))?.content, "the competing write is not visible while the update is paused").toBe(content);
}

type MalformedVariant = { label: string; rowId: (successorId: string, otherRowId: string) => string; previousVersionHash: (recordHash: string) => string };

const VARIANTS: MalformedVariant[] = [
  {
    label: "names a different row",
    rowId: (_successorId, otherRowId) => otherRowId,
    previousVersionHash: (recordHash) => recordHash,
  },
  {
    label: "is not hash-linked to this update",
    rowId: (successorId) => successorId,
    previousVersionHash: () => "not-this-updates-record-hash",
  },
];

/** Insert the following delete version directly; Flair's writer cannot produce this shape. */
async function insertFollowingDelete(args: {
  subjectId: string;
  versionId: string;
  rowId: string;
  previousVersionHash: string;
}): Promise<void> {
  await ops({
    operation: "insert", database: "flair", table: "InstructionVersion", records: [{
      id: args.versionId, subjectType: "skill", subjectId: args.subjectId, agentId: A.id, key: null,
      version: 3, kind: "delete",
      rowId: args.rowId,
      valueHash: null,
      previousVersionHash: args.previousVersionHash,
      soulSnapshot: null, memoryId: null, visibility: "shared",
      actorKind: "agent", actorId: A.id, sourceClass: "agent",
      createdAt: now(), guarded: false, expectedVersion: null, recordHash: "following-delete-3",
    }],
  });
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2686-pause-"));
  harper = await startHarper({ serverEnv: { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir } });
  // Before the first test request, reject external instances and check the live
  // spawned process, owned temporary install directory, and distinct 127.0.0.1
  // ports outside the helper's denylist.
  assertOwnInstance(harper);
  await ops({
    operation: "upsert", database: "flair", table: "Agent",
    records: [A, B].map((agent) => ({ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: now() })),
  });
  await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
  await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#2686 part 2 — a follow-on delete version inserted directly", () => {
  for (const variant of VARIANTS) {
    it(`a following delete inserted directly (not written by Flair) that ${variant.label} leaves today's 200 when the successor is still open`, async () => {
      const predecessorId = nextId("open-predecessor");
      const created = await call(A, "PUT", memPath(predecessorId), skillBody(predecessorId, "v1"));
      expect(created.status, (await created.text()).slice(0, 300)).toBeLessThan(300);
      const successorId = nextId("open-successor");
      const otherRowId = nextId("other-row");
      const followingVersionId = `skill:${predecessorId}:3`;

      const { response, paused, released } = await withPaused(
        "skill-update-confirm",
        () => call(A, "POST", "/Memory", skillBody(successorId, "v2", { supersedes: predecessorId })),
        async () => {
          const appended = (await versionsOf(predecessorId)).at(-1);
          expect(appended?.id, "this request's version did not commit").toBe(`skill:${predecessorId}:2`);
          expect(appended?.memoryId).toBe(successorId);
          expect(typeof (await memoryRow(successorId))?.validTo === "string" ? (await memoryRow(successorId)).validTo : null,
            "the successor is already closed before the inserted version").toBeNull();
          // The inserted delete names a row Flair's writer would not choose, or
          // does not hash-link to this update; it does not close the successor.
          await insertFollowingDelete({
            subjectId: predecessorId,
            versionId: followingVersionId,
            rowId: variant.rowId(successorId, otherRowId),
            previousVersionHash: variant.previousVersionHash(appended!.recordHash),
          });
        },
      );
      expect(paused, "the skill update did not pause before confirmation").toBe(true);
      expect(released).toBe("go");
      const text = await response.text();
      expect(response.status, text.slice(0, 300)).toBe(200);
      expect(JSON.parse(text).id).toBe(successorId);

      const predecessor = await memoryRow(predecessorId);
      const successor = await memoryRow(successorId);
      expect(typeof predecessor?.validTo, `the predecessor was not closed: ${JSON.stringify({ predecessor, response: text })}`).toBe("string");
      expect(typeof successor?.validTo === "string" ? successor.validTo : null, "the successor was closed").toBeNull();
      expect(successor?.supersedes, JSON.stringify(successor)).toBe(predecessorId);
      expect(await liveHeads(predecessorId), "the successor is not the sole live head").toEqual([successorId]);

      const versions = await versionsOf(predecessorId);
      expect(versions.map((v) => [Number(v.version), v.kind]), JSON.stringify(versions)).toEqual([[1, "create"], [2, "update"], [3, "delete"]]);
      expect(versions.map((v) => v.id), JSON.stringify(versions)).toEqual([`skill:${predecessorId}:1`, `skill:${predecessorId}:2`, followingVersionId]);
      expect(versions[2].rowId).toBe(variant.rowId(successorId, otherRowId));
      expect(versions[2].previousVersionHash).toBe(variant.previousVersionHash(versions[1].recordHash));

      const events = await skillEventsOf(predecessorId);
      expect(events.map((e) => e.refId).sort(), JSON.stringify(events)).toEqual([versions[0].id, versions[1].id].sort());
    }, 120_000);

    it(`a following delete inserted directly (not written by Flair) that ${variant.label} leaves today's 500 when the successor is closed`, async () => {
      const predecessorId = nextId("closed-predecessor");
      const created = await call(A, "PUT", memPath(predecessorId), skillBody(predecessorId, "v1"));
      expect(created.status, (await created.text()).slice(0, 300)).toBeLessThan(300);
      const successorId = nextId("closed-successor");
      const otherRowId = nextId("other-row");
      const followingVersionId = `skill:${predecessorId}:3`;

      const { response, paused, released } = await withPaused(
        "skill-update-confirm",
        () => call(A, "POST", "/Memory", skillBody(successorId, "v2", { supersedes: predecessorId })),
        async () => {
          const appended = (await versionsOf(predecessorId)).at(-1);
          expect(appended?.id, "this request's version did not commit").toBe(`skill:${predecessorId}:2`);
          // Close the successor, then insert the following delete version
          // directly; the version does not name or hash-link the successor in a
          // way Flair's writer would produce.
          await commitNewerSkillWrite(successorId, "v2", { validTo: now() });
          await insertFollowingDelete({
            subjectId: predecessorId,
            versionId: followingVersionId,
            rowId: variant.rowId(successorId, otherRowId),
            previousVersionHash: variant.previousVersionHash(appended!.recordHash),
          });
        },
      );
      expect(paused, "the skill update did not pause before confirmation").toBe(true);
      expect(released).toBe("go");
      const text = await response.text();
      expect(response.status, text.slice(0, 300)).toBe(500);
      expect(JSON.parse(text).error).toBe("skill_update_compensation_failed");

      const predecessor = await memoryRow(predecessorId);
      const successor = await memoryRow(successorId);
      expect(typeof predecessor?.validTo, `the predecessor is not closed: ${JSON.stringify({ predecessor, response: text })}`).toBe("string");
      expect(typeof successor?.validTo, "the successor is not closed").toBe("string");

      const versions = await versionsOf(predecessorId);
      expect(versions.map((v) => [Number(v.version), v.kind]), JSON.stringify(versions)).toEqual([[1, "create"], [2, "update"], [3, "delete"]]);
      expect(versions.map((v) => v.id), JSON.stringify(versions)).toEqual([`skill:${predecessorId}:1`, `skill:${predecessorId}:2`, followingVersionId]);

      const events = await skillEventsOf(predecessorId);
      expect(events.map((e) => e.refId).sort(), JSON.stringify(events)).toEqual([versions[0].id, versions[1].id].sort());
    }, 120_000);

    it(`CONTROL (${variant.label} variant): a completed delete through Flair's own path succeeds today and links its version to the successor`, async () => {
      const predecessorId = nextId("control-predecessor");
      const created = await call(A, "PUT", memPath(predecessorId), skillBody(predecessorId, "v1"));
      expect(created.status, (await created.text()).slice(0, 300)).toBeLessThan(300);
      const successorId = nextId("control-successor");
      const updated = await call(A, "POST", "/Memory", skillBody(successorId, "v2", { supersedes: predecessorId }));
      const updateText = await updated.text();
      expect(updated.status, updateText.slice(0, 300)).toBe(200);
      expect(JSON.parse(updateText).id).toBe(successorId);

      const deleted = await call(A, "DELETE", memPath(successorId));
      const deleteText = await deleted.text();
      expect(deleted.status, deleteText.slice(0, 300)).toBeLessThan(300);
      expect(JSON.parse(deleteText).deleted).toBe(true);

      expect(typeof (await memoryRow(predecessorId))?.validTo, "the predecessor is not closed").toBe("string");
      expect(typeof (await memoryRow(successorId))?.validTo, "the successor is not closed").toBe("string");
      expect(await liveHeads(predecessorId), "the deleted lineage still has a live head").toEqual([]);

      const versions = await versionsOf(predecessorId);
      expect(versions.map((v) => [Number(v.version), v.kind]), JSON.stringify(versions)).toEqual([[1, "create"], [2, "update"], [3, "delete"]]);
      expect(versions[1].memoryId, "the update version does not name the successor").toBe(successorId);
      expect(versions[1].previousVersionHash).toBe(versions[0].recordHash);
      expect(versions[2].rowId, "the delete version does not name the successor").toBe(successorId);
      expect(versions[2].memoryId ?? null).toBeNull();
      expect(versions[2].previousVersionHash, "the delete version does not follow the update's version").toBe(versions[1].recordHash);

      const events = await skillEventsOf(predecessorId);
      expect(events.map((e) => e.refId).sort(), JSON.stringify(events)).toEqual(versions.map((v) => v.id).sort());
      for (const event of events) {
        const version = versions.find((v) => v.id === event.refId);
        expect(event.id).toBe(`instruction-change:${event.refId}`);
        expect(JSON.parse(event.detail).changeKind).toBe(version?.kind);
      }
    }, 120_000);
  }
});
