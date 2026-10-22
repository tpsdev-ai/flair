/**
 * owner-guard-2468-real-harper-load.test.ts — flair#2468.
 *
 * Needs loopback listeners: starts real Harper (runs in CI's integration shards).
 * Addressed single-record PUT/PATCH loads the row at `Table.getResource` →
 * `resource._loadRecord` before the resource method; a no-argument `super.get()`
 * returns the cached row. With an injected initial load failure, a non-admin
 * agent's write is refused by the auth middleware's early stored-owner check
 * (resources/auth-middleware.ts), which reads the stored row before Harper
 * loads it, with the named 503 `owner_lookup_failed`; the resource owner guard
 * (resources/owner-scoped-write-policy.ts) does not answer, because the
 * middleware's read fails first. An administrator's write is not decided by
 * that check and reaches Harper's load, which answers Harper's own 500. This
 * test does not cover collection paths.
 *
 * How the failure is injected: test/helpers/owner-guard-load-failure-component.ts
 * composes a private copy of the built component whose `_loadRecord` throws for
 * ids carrying the marker, ARMED by a sentinel file under the instance ROOTPATH.
 * Seeding uses the ops API, which writes through the native bridge and does not
 * call `_loadRecord`, so the same instance serves normal traffic until the test
 * arms the switch. Production ships no such switch.
 *
 * Background migrations (flair#2748): the boot migration cycle and its delayed
 * follow-ups (resources/migration-boot.ts) stamp `visibility` on a Memory row
 * without one (visibility-backfill) and, with the embedding model present,
 * re-embed a Memory row without a current `embeddingModel` (embedding-stamp).
 * The seeded Memory row carries both, and the first test waits for a migration
 * cycle that starts after its rows are seeded and requires each registered
 * migration to report completed with no rows done or remaining before it
 * compares any row.
 *
 * MODEL: test/integration/credential-delete-authz.test.ts.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { startHarper, stopHarper, HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import {
  componentWithOwnerGuardLoadFailure,
  LOAD_FAILURE_MARKER,
  ARM_FILE,
  armFor,
  type FailingComponent,
} from "../helpers/owner-guard-load-failure-component";
import { getModelId } from "../../resources/embeddings-provider.ts";
import { DEFAULT_STAMP_RECHECK_DELAYS_MS } from "../../resources/migrations/recheck.ts";

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

let harper: HarperInstance;
let component: FailingComponent;
const owner = mkAgent("loadfail-owner"); // non-admin principal that owns the rows
const other = mkAgent("loadfail-other"); // non-admin principal that does NOT own them

const adminBasic = () => `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}`;
async function adminOp(op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminBasic() },
    body: JSON.stringify(op),
  });
}
async function readRow(table: string, id: string): Promise<Record<string, unknown>> {
  const res = await adminOp({
    operation: "search_by_value", database: "flair", table,
    search_attribute: "id", search_type: "equals", search_value: id, get_attributes: ["*"],
  });
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(Array.isArray(body)).toBe(true);
  expect(body).toHaveLength(1);
  expect(body[0].id).toBe(id);
  return body[0];
}
async function authFetch(m: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { Authorization: ed25519Header(m, method, path), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

interface MigrationStatus {
  cyclePhase: string;
  lastCycleAt: string | null;
  lastCycleError: string | null;
  migrations: Array<{ id: string } & Record<string, unknown>>;
}

/** The instance's migration-cycle status, read from /HealthDetail as the administrator. */
async function migrationStatus(): Promise<MigrationStatus> {
  const res = await fetch(`${harper.httpURL}/HealthDetail`, { headers: { Authorization: adminBasic() } });
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.migrations, "/HealthDetail returned no migrations block").toBeTruthy();
  return body.migrations;
}

/** Wait (bounded) for a migration cycle to finish after `since`, an earlier
 *  finished cycle's lastCycleAt (null: any finished cycle). */
async function waitForCycleAfter(since: string | null, timeoutMs: number): Promise<MigrationStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: MigrationStatus | undefined;
  while (Date.now() < deadline) {
    last = await migrationStatus();
    if (last.cyclePhase === "done" && last.lastCycleAt !== null && (since === null || last.lastCycleAt > since)) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no migration cycle finished after ${since ?? "boot"} within ${timeoutMs} ms; last status: ${JSON.stringify(last)}`);
}

/** The boot migration cycle's status, read once it finished (beforeAll). */
let bootCycle: MigrationStatus;

/** Arm / disarm the injected load failure via the ROOTPATH sentinel. */
function arm(): void { writeFileSync(join(harper.installDir, ARM_FILE), "1"); }
function disarm(): void { const p = join(harper.installDir, ARM_FILE); if (existsSync(p)) rmSync(p, { force: true }); }

/** A marker id whose stored-row read will fail while armed. */
function markerId(tag: string): string { return `${LOAD_FAILURE_MARKER}-${tag}-${randomUUID()}`; }

beforeAll(async () => {
  component = componentWithOwnerGuardLoadFailure();
  harper = await startHarper({ cwd: component.dir });
  const bootLog = (harper.getLog?.() ?? "").split("\n").filter((l) => l.includes("owner-guard-load-failure")).join("\n");
  console.log("[2468] injected-module boot log:\n" + (bootLog || "(module did not log)"));
  // Nothing is seeded until the boot migration cycle has finished (flair#2748).
  bootCycle = await waitForCycleAfter(null, 60_000);
  expect(bootCycle.lastCycleError, "the boot migration cycle failed").toBeNull();
  for (const a of [owner, other]) {
    const res = await adminOp({
      operation: "insert", database: "flair", table: "Agent",
      records: [{ id: a.id, name: a.id, role: "agent", publicKey: a.publicKey, createdAt: new Date().toISOString() }],
    });
    expect(res.status).toBe(200);
  }
}, 180_000);

afterAll(async () => {
  if (harper) { disarm(); await stopHarper(harper); }
  if (component) component.cleanup();
}, HARPER_STOP_BUDGET_MS);

describe("flair#2468 — initial row-load failures on addressed single-record Harper requests", () => {
  test("addressed single-record PUT/PATCH: an unreadable stored row is refused with the named 503 owner_lookup_failed, and an administrator gets Harper's 500", async () => {
    const seeded: Array<{ table: string; id: string; seed: Record<string, any>; put: Record<string, any>; patch: Record<string, any> }> = [
      {
        table: "Asset", id: markerId("asset"),
        seed: { agentId: owner.id, memoryId: "m", contentType: "image/png", createdAt: new Date().toISOString() },
        put: { memoryId: "m", contentType: "image/png" },
        patch: { contentType: "image/png" },
      },
      {
        table: "Credential", id: markerId("credential"),
        seed: { principalId: owner.id, kind: "bearer-token", status: "active" },
        put: { principalId: owner.id, kind: "bearer-token" },
        patch: { status: "revoked" },
      },
      {
        table: "Integration", id: markerId("integration"),
        seed: { agentId: owner.id, platform: "slack", username: "u" },
        put: { platform: "slack", username: "u" },
        patch: { platform: "slack", username: "u" },
      },
      {
        table: "Memory", id: markerId("memory"),
        // The visibility visibility-backfill derives for a row without
        // durability, and the instance's current embedding stamp (header).
        seed: { agentId: owner.id, content: "stored", visibility: "private", embeddingModel: getModelId() },
        put: { content: "hi" },
        patch: { content: "hi" },
      },
      {
        table: "MemoryCandidate", id: markerId("candidate"),
        seed: { agentId: owner.id, claim: "c", generatedAt: new Date().toISOString(), status: "pending" },
        put: { status: "pending" },
        patch: { status: "promoted" },
      },
      {
        table: "MemoryGrant", id: markerId("grant"),
        seed: { ownerId: owner.id, granteeId: "g", scope: "all" },
        put: { ownerId: owner.id },
        patch: { scope: "all" },
      },
      {
        table: "OrgEvent", id: markerId("orgevent"),
        seed: { authorId: owner.id, kind: "note", summary: "s", createdAt: new Date().toISOString() },
        put: { summary: "s" },
        patch: { summary: "s" },
      },
      {
        table: "Relationship", id: markerId("relationship"),
        seed: { agentId: owner.id, subject: "a", predicate: "owns", object: "b", createdAt: new Date().toISOString() },
        put: { object: "o" },
        patch: { object: "o" },
      },
      {
        table: "WorkspaceState", id: markerId("wsstate"),
        seed: { agentId: owner.id, ref: "main", provider: "git", timestamp: new Date().toISOString(), createdAt: new Date().toISOString() },
        put: { ref: "main" },
        patch: { ref: "main" },
      },
    ];

    const before = new Map<string, Record<string, unknown>>();

    // Seed each row with the ops API (native bridge — does not call _loadRecord).
    for (const c of seeded) {
      const res = await adminOp({
        operation: "insert", database: "flair", table: c.table,
        records: [{ id: c.id, createdAt: new Date().toISOString(), ...c.seed }],
      });
      expect(res.status, `seed ${c.table} ${c.id} returned ${res.status}`).toBe(200);
      before.set(c.id, await readRow(c.table, c.id));
    }

    // flair#2748: the first follow-up cycle starts at least its delay after the
    // boot cycle finished, so it starts after the seeding above; each registered
    // migration must report completed with no rows done or remaining.
    const firstDelay = DEFAULT_STAMP_RECHECK_DELAYS_MS[0];
    expect(Date.now(), "seeding outlasted the first follow-up delay").toBeLessThan(Date.parse(bootCycle.lastCycleAt!) + firstDelay);
    const cycle = await waitForCycleAfter(bootCycle.lastCycleAt, firstDelay + 30_000);
    console.log(`[2748] migration cycle after seeding: ${JSON.stringify(cycle)}`);
    expect(cycle.lastCycleError).toBeNull();
    expect(cycle.migrations.map((m) => m.id)).toEqual(expect.arrayContaining(["embedding-stamp", "visibility-backfill"]));
    for (const m of cycle.migrations) {
      expect(m, `migration ${m.id} after seeding (seed rows that already satisfy it)`).toEqual({ id: m.id, rowsDone: 0, rowsRemaining: 0, state: "completed" });
    }

    arm();

    for (const c of seeded) {
      for (const verb of ["put", "patch"] as const) {
        const prior = await readRow(c.table, c.id);
        expect(prior).toEqual(before.get(c.id)!);
        const path = `/${c.table}/${c.id}`;
        const res = await authFetch(owner, verb.toUpperCase(), path, c[verb]);
        const text = await res.text();
        let parsed: any = {};
        try { parsed = JSON.parse(text); } catch { /* non-JSON */ }

        // RECORD what the client sees.
        console.log(`[2468] ${c.table}.${verb} (owner, unreadable row) -> ${res.status} ${text.slice(0, 240)}`);

        expect(res.status, `${c.table}.${verb} returned ${res.status}: ${text.slice(0, 240)}`).toBe(503);
        expect(parsed.error, `${c.table}.${verb} must answer with the middleware's named refusal`).toBe("owner_lookup_failed");
        // The resource guard's named refusal must NOT be what answers: the
        // middleware's stored-owner read fails first, one layer up, so the
        // resource never runs.
        expect(parsed.error, `${c.table}.${verb} answered with the resource guard's named refusal`).not.toBe("owner_check_unavailable");
        expect(await readRow(c.table, c.id), `${c.table}.${verb} must leave the full row unchanged`).toEqual(prior);

        // An administrator's write is not decided by that guard: Harper's own
        // initial load runs first and returns its 500 problem detail.
        const adminRes = await fetch(`${harper.httpURL}${path}`, {
          method: verb.toUpperCase(),
          headers: { Authorization: adminBasic(), "Content-Type": "application/json" },
          body: JSON.stringify(c[verb]),
        });
        const adminText = await adminRes.text();
        let adminParsed: any = {};
        try { adminParsed = JSON.parse(adminText); } catch { /* non-JSON */ }
        console.log(`[2468] ${c.table}.${verb} (admin, unreadable row) -> ${adminRes.status} ${adminText.slice(0, 240)}`);
        expect(adminRes.status, `${c.table}.${verb} (admin) returned ${adminRes.status}: ${adminText.slice(0, 240)}`).toBe(500);
        expect(adminParsed.status).toBe(500);
        expect(String(adminParsed.title ?? ""), "the 500 must be the injected load failure, i.e. Harper's load ran first").toContain("forced stored-row read failure");
        expect(await readRow(c.table, c.id), `${c.table}.${verb} (admin) must leave the full row unchanged`).toEqual(prior);
      }
    }
  }, 150_000);

  test("control: armed injection permits a non-marker PUT and ownership refuses a cross-agent PATCH", async () => {
    arm();
    const id = `control-${randomUUID()}`;
    const content = { principalId: owner.id, kind: "bearer-token", label: "persisted control" };
    const putRes = await authFetch(owner, "PUT", `/Credential/${id}`, content);
    console.log(`[2468] control Credential.PUT (non-marker) -> ${putRes.status}`);
    expect(putRes.status).toBe(204);
    const prior = await readRow("Credential", id);
    expect(prior).toMatchObject({ id, ...content, status: "active" });
    expect(typeof prior.createdAt).toBe("string");
    expect(typeof prior.updatedAt).toBe("string");

    expect(existsSync(join(harper.installDir, ARM_FILE))).toBe(true);
    const patchRes = await authFetch(other, "PATCH", `/Credential/${id}`, { status: "revoked" });
    const patchBody = await patchRes.json();
    console.log(`[2468] control cross-agent PATCH (non-marker) -> ${patchRes.status} ${JSON.stringify(patchBody)}`);
    expect(patchRes.status).toBe(403);
    expect(patchBody).toEqual({ error: "forbidden: cannot modify Credential owned by another principal" });
    expect(await readRow("Credential", id)).toEqual(prior);
  }, 60_000);
});

describe("OrgEvent and WorkspaceState delete lookups refuse a failed stored-row read", () => {
  const deletable = () => [
    { table: "OrgEvent", tag: "orgevent-del", seed: { authorId: owner.id, kind: "note", summary: "s", createdAt: new Date().toISOString() } },
    { table: "WorkspaceState", tag: "wsstate-del", seed: { agentId: owner.id, ref: "main", provider: "git", timestamp: new Date().toISOString(), createdAt: new Date().toISOString() } },
  ];
  async function seedRow(table: string, id: string, seed: Record<string, unknown>): Promise<void> {
    const res = await adminOp({ operation: "insert", database: "flair", table, records: [{ id, ...seed }] });
    expect(res.status, `seed ${table} ${id} returned ${res.status}`).toBe(200);
  }

  for (const table of ["OrgEvent", "WorkspaceState"]) test(`${table}: the owner's DELETE gets the named 503 owner_lookup_failed when the delete lookup's read fails, and the row stays`, async () => {
    for (const c of deletable().filter((d) => d.table === table)) {
      const id = markerId(c.tag);
      await seedRow(c.table, id, c.seed);
      const prior = await readRow(c.table, id);
      // The shared owner rule's read is this id's first load and succeeds; the
      // delete lookup's read is the next one and fails.
      writeFileSync(join(harper.installDir, ARM_FILE), armFor(id, 1));
      let res: Response;
      let text: string;
      try {
        res = await authFetch(owner, "DELETE", `/${c.table}/${id}`);
        text = await res.text();
      } finally {
        disarm();
      }
      console.log(`[2468] ${c.table}.delete (owner, delete lookup unreadable) -> ${res.status} ${text.slice(0, 240)}`);
      expect(res.status, `${c.table} DELETE returned ${res.status}: ${text.slice(0, 240)}`).toBe(503);
      expect(JSON.parse(text).error).toBe("owner_lookup_failed");
      expect(await readRow(c.table, id), `${c.table} DELETE must leave the row`).toEqual(prior);
    }
  }, 60_000);

  test("control: with both reads succeeding, the owner's DELETE removes the row", async () => {
    disarm();
    for (const c of deletable()) {
      const id = markerId(c.tag);
      await seedRow(c.table, id, c.seed);
      await readRow(c.table, id);
      const res = await authFetch(owner, "DELETE", `/${c.table}/${id}`);
      expect(res.status, `${c.table} DELETE returned ${res.status}`).toBeLessThan(300);
      const after = await adminOp({
        operation: "search_by_value", database: "flair", table: c.table,
        search_attribute: "id", search_type: "equals", search_value: id, get_attributes: ["id"],
      });
      expect(await after.json(), `${c.table} DELETE must remove the row`).toEqual([]);
    }
  }, 60_000);
});
