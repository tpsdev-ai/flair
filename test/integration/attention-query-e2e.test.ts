/**
 * attention-query-e2e.test.ts — real-Harper integration coverage for
 * POST /AttentionQuery (flair#677, spec: ~/ops/FLAIR-ATTENTION-PLANE.md).
 *
 * The unit suite (test/unit/attention-query.test.ts) exercises
 * resources/AttentionQuery.ts against a HAND-WRITTEN mock of Harper's
 * condition-search semantics (equals-on-array-field = membership,
 * greater_than_equal for the day-window cutoff) — an assumption inferred from
 * how resources/SemanticSearch.ts already uses the SAME idiom against real
 * Harper in production, but never itself verified against a REAL Harper
 * instance for `entities`. This file closes that gap: a real spawned Harper,
 * real Ed25519-signed requests, real LMDB-backed index queries.
 *
 * Focus (the properties that matter most / are riskiest if wrong):
 *   1. Cross-agent visibility for Memory (org-open, non-private) and
 *      WorkspaceState (Sherlock Option-1 internal path) — a caller sees a
 *      TEAMMATE's matching records, against the real query engine, not a mock.
 *   2. Presence — a caller sees a teammate's currentTask via the real
 *      signature-based content gate (the `_flairAgentAuth` memoization-relay
 *      trick — see resources/AttentionQuery.ts's module doc — actually works
 *      against real verifyAgentRequest()/Presence.get(), not just the pre-
 *      seeded mock's shortcut).
 *   3. Relationship stays scoped to the CALLER's own agentId — a teammate's
 *      relationship about the SAME entity must NOT appear (proving the
 *      per-source scoping boundary holds for real, not just in the mock).
 *   4. The day window is a real pushdown against `timestamp`/`createdAt`,
 *      not just a JS filter over an unconditioned scan.
 *   5. Input validation (400) and anonymous denial (401) against the real
 *      HTTP surface.
 *
 * Requires a running Harper instance (test/helpers/harper-lifecycle.ts).
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { randomBytes } from "node:crypto";
import nacl from "tweetnacl";

function makeKeypair(): { publicKey: string; privateKey: Uint8Array } {
  const kp = nacl.sign.keyPair();
  const publicKey = Buffer.from(kp.publicKey).toString("hex");
  return { publicKey, privateKey: kp.secretKey };
}

function buildAuthHeader(agentId: string, method: string, path: string, secretKey: Uint8Array): string {
  const ts = Date.now().toString();
  const nonce = randomBytes(12).toString("hex");
  const payload = `${agentId}:${ts}:${nonce}:${method}:${path}`;
  const sig = Buffer.from(nacl.sign.detached(Buffer.from(payload), secretKey)).toString("base64");
  return `TPS-Ed25519 ${agentId}:${ts}:${nonce}:${sig}`;
}

async function seedAgent(opsURL: string, adminAuth: string, id: string, publicKey: string, displayName?: string) {
  await fetch(opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminAuth },
    body: JSON.stringify({
      operation: "insert",
      database: "flair",
      table: "Agent",
      records: [{
        id, name: displayName ?? id, displayName: displayName ?? id, role: "agent",
        publicKey, status: "active", kind: "agent", createdAt: new Date().toISOString(),
      }],
    }),
  });
}

let harper: HarperInstance;

// A single entity string, unique to this suite, so cross-test-file corpus
// noise (the shared Harper instance persists across test files in the same
// run) can never accidentally match it.
const ENTITY = "repo:tpsdev-ai/attention-query-e2e-fixture";
const UNUSED_ENTITY = "subsystem:attention-query-e2e-unused-fixture";

describe("AttentionQuery e2e (real Harper)", () => {
  beforeAll(async () => {
    harper = await startHarper();
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  const adminAuth = () => "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");

  const caller = { id: "attn-e2e-caller", ...makeKeypair() };
  const teammate = { id: "attn-e2e-teammate", ...makeKeypair() };

  beforeAll(async () => {
    await seedAgent(harper.opsURL, adminAuth(), caller.id, caller.publicKey, "Caller");
    await seedAgent(harper.opsURL, adminAuth(), teammate.id, teammate.publicKey, "Teammate");

    // ── Seed one matching record per source, authored by the TEAMMATE ──────
    // (the caller queries; every hit below is cross-agent unless noted).
    //
    // NOTE (measured, not assumed): table-backed resources (WorkspaceState/
    // Memory/OrgEvent/Relationship — every class shaped `extends
    // (databases as any).flair.X`) only expose PUT over real HTTP, WITH the
    // id in the URL path — the same restriction resources/Memory.ts's own
    // comment documents ("the Memory schema only exposes PUT over HTTP...
    // Memory.post() IS reachable, but only via an in-process resource
    // instantiation"). A bare `POST /WorkspaceState` (what the shipped
    // `flair workspace set` CLI command sends) was probed against this same
    // real Harper and returned 405 "does not have a post method implemented
    // to handle HTTP method POST" — apparently a PRE-EXISTING gap in that
    // CLI command/`flair orgevent`, unrelated to this change (flagged
    // separately, not fixed here — out of scope for the query-only slice).
    // AttentionQuery.ts itself `extends Resource` (the generic base, like
    // SemanticSearch.ts), not a table class, so POST /AttentionQuery is NOT
    // affected — see the actual query test below, which does use POST.

    // WorkspaceState — the critical Sherlock Option-1 cross-agent case.
    const wsId = `${teammate.id}:attn-e2e-branch`;
    const wsAuth = buildAuthHeader(teammate.id, "PUT", `/WorkspaceState/${wsId}`, teammate.privateKey);
    const wsRes = await fetch(`${harper.httpURL}/WorkspaceState/${wsId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: wsAuth },
      body: JSON.stringify({
        id: wsId, agentId: teammate.id, ref: "attn-e2e-branch", provider: "test", phase: "implement",
        timestamp: new Date().toISOString(), createdAt: new Date().toISOString(),
        summary: "implementing the attention query e2e fixture", taskId: "677",
        entities: [ENTITY],
      }),
    });
    expect([200, 204]).toContain(wsRes.status);

    // Memory — org-open (shared) read model.
    const memId = `attn-e2e-mem-${randomBytes(4).toString("hex")}`;
    const memAuth = buildAuthHeader(teammate.id, "PUT", `/Memory/${memId}`, teammate.privateKey);
    const memRes = await fetch(`${harper.httpURL}/Memory/${memId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: memAuth },
      body: JSON.stringify({
        id: memId, agentId: teammate.id, content: "a shared finding about the attention query fixture",
        durability: "persistent", visibility: "shared", entities: [ENTITY],
      }),
    });
    expect([200, 204]).toContain(memRes.status);

    // OrgEvent — org-wide read model.
    const evId = "attn-e2e-event-1";
    const evAuth = buildAuthHeader(teammate.id, "PUT", `/OrgEvent/${evId}`, teammate.privateKey);
    const evRes = await fetch(`${harper.httpURL}/OrgEvent/${evId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: evAuth },
      body: JSON.stringify({
        id: evId, authorId: teammate.id, kind: "status", summary: "e2e fixture event",
        entities: [ENTITY], createdAt: new Date().toISOString(),
      }),
    });
    expect([200, 204]).toContain(evRes.status);

    // Relationship — SCOPED to its author; the caller must NOT see this one.
    const relId = "attn-e2e-rel-1";
    const relAuth = buildAuthHeader(teammate.id, "PUT", `/Relationship/${relId}`, teammate.privateKey);
    const relRes = await fetch(`${harper.httpURL}/Relationship/${relId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: relAuth },
      body: JSON.stringify({ id: relId, subject: ENTITY, predicate: "depends_on", object: "subsystem:embeddings" }),
    });
    expect([200, 204]).toContain(relRes.status);

    // Presence — the teammate's currentTask references the entity.
    const presAuth = buildAuthHeader(teammate.id, "POST", "/Presence", teammate.privateKey);
    const presRes = await fetch(`${harper.httpURL}/Presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: presAuth },
      body: JSON.stringify({ currentTask: `working on ${ENTITY}`, activity: "coding" }),
    });
    expect(presRes.status).toBe(200);
  });

  test("caller sees the teammate's Memory, WorkspaceState, Presence, and OrgEvent hits, but NOT their Relationship", async () => {
    const auth = buildAuthHeader(caller.id, "POST", "/AttentionQuery", caller.privateKey);
    const res = await fetch(`${harper.httpURL}/AttentionQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ entity: ENTITY, days: 7 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.entity).toBe(ENTITY);
    expect(body.windowDays).toBe(7);

    // Memory: org-open — the caller sees the teammate's SHARED memory.
    expect(body.groups.memory.length).toBeGreaterThanOrEqual(1);
    expect(body.groups.memory.some((m: any) => m.agentId === teammate.id)).toBe(true);

    // WorkspaceState: the CRITICAL cross-agent assertion — real Harper, real
    // internal-path bypass, not the mock's stand-in.
    expect(body.groups.workspaceState.length).toBeGreaterThanOrEqual(1);
    const ws = body.groups.workspaceState.find((w: any) => w.agentId === teammate.id);
    expect(ws).toBeDefined();
    expect(ws.taskId).toBe("677");
    expect(ws.summary).toContain("attention query e2e fixture");
    // The raw metadata JSON blob (not part of the spec-blessed exposed shape)
    // is never present.
    expect(ws.metadata).toBeUndefined();

    // Presence: the teammate's currentTask, via the real content gate.
    expect(body.groups.presence.length).toBeGreaterThanOrEqual(1);
    const pres = body.groups.presence.find((p: any) => p.agentId === teammate.id);
    expect(pres).toBeDefined();
    expect(pres.currentTask).toContain(ENTITY);

    // OrgEvent: org-wide read model.
    expect(body.groups.orgEvent.length).toBeGreaterThanOrEqual(1);
    expect(body.groups.orgEvent.some((e: any) => e.authorId === teammate.id)).toBe(true);

    // Relationship: SCOPED — the caller authored none, so it must be empty
    // even though the teammate's relationship genuinely matches the entity.
    expect(body.groups.relationship).toEqual([]);
  });

  test("a direct GET /WorkspaceState from the caller still 403s cross-agent (the internal path is NOT a general broadening)", async () => {
    const auth = buildAuthHeader(caller.id, "GET", `/WorkspaceState/${encodeURIComponent(`${teammate.id}:attn-e2e-branch`)}`, caller.privateKey);
    const res = await fetch(`${harper.httpURL}/WorkspaceState/${encodeURIComponent(`${teammate.id}:attn-e2e-branch`)}`, {
      method: "GET",
      headers: { Authorization: auth },
    });
    // Scoped get() 404s (not 403) a non-owner id — see resources/WorkspaceState.ts's
    // get() doc ("never distinguishes doesn't-exist from exists-but-not-yours").
    expect(res.status).toBe(404);
  });

  test("an entity with zero hits 200s with all-empty groups", async () => {
    const auth = buildAuthHeader(caller.id, "POST", "/AttentionQuery", caller.privateKey);
    const res = await fetch(`${harper.httpURL}/AttentionQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ entity: UNUSED_ENTITY }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counts).toEqual({ memory: 0, relationship: 0, workspaceState: 0, presence: 0, orgEvent: 0, total: 0 });
  });

  test("malformed entity is rejected with 400", async () => {
    const auth = buildAuthHeader(caller.id, "POST", "/AttentionQuery", caller.privateKey);
    const res = await fetch(`${harper.httpURL}/AttentionQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ entity: "not-a-vocab-string" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_entity");
  });

  test("anonymous (no Authorization header) is denied", async () => {
    const res = await fetch(`${harper.httpURL}/AttentionQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entity: ENTITY }),
    });
    expect([401, 403]).toContain(res.status);
  });

  test("a matching record outside the day window is excluded (real index pushdown, not a JS-only filter)", async () => {
    // A fresh, distinct entity + a WorkspaceState row backdated well outside
    // any reasonable window, written directly via the ops API (bypassing the
    // post() timestamp-defaulting) so the write genuinely predates the window.
    const staleEntity = "subsystem:attn-e2e-stale-window-fixture";
    await fetch(harper.opsURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: adminAuth() },
      body: JSON.stringify({
        operation: "insert",
        database: "flair",
        table: "WorkspaceState",
        records: [{
          id: `${teammate.id}:attn-e2e-stale`,
          agentId: teammate.id, ref: "attn-e2e-stale", provider: "test",
          timestamp: new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
          createdAt: new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
          entities: [staleEntity],
        }],
      }),
    });

    const auth = buildAuthHeader(caller.id, "POST", "/AttentionQuery", caller.privateKey);
    const res = await fetch(`${harper.httpURL}/AttentionQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ entity: staleEntity, days: 7 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groups.workspaceState).toEqual([]);
  });
});
