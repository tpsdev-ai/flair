/**
 * owner-guard-2468-real-harper-load.test.ts — flair#2468.
 *
 * The shared owner-field guard (resources/owner-field-guard.ts) was made to
 * fail CLOSED when its own stored-row read throws. The unit tests mock
 * `() => super.get()` rejecting. This test establishes what a real Harper 5.3.1
 * request does, because on the HTTP path that thunk does NOT perform a fresh
 * read: Harper's REST layer loads the row at `Table.getResource` →
 * `resource._loadRecord` (dist/resources/Table.js ~1631/1640) BEFORE the resource
 * method runs and binds it to `this.#record`, and a no-argument `super.get()`
 * returns that cached record (Table.ts, the final fallback branch). So the
 * realistic stored-row read failure on the HTTP path happens ONE LAYER UP, at
 * the load, and the client sees Harper's own error — not the guard's
 * `owner_check_unavailable`.
 *
 * How the failure is injected: test/helpers/owner-guard-load-failure-component.ts
 * composes a private copy of the built component whose `_loadRecord` throws for
 * ids carrying the marker, ARMED by a sentinel file under the instance ROOTPATH.
 * Seeding uses the ops API, which writes through the native bridge and does not
 * call `_loadRecord`, so the same instance serves normal traffic until the test
 * arms the switch. Production ships no such switch.
 *
 * MODEL: test/integration/credential-delete-authz.test.ts.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import {
  componentWithOwnerGuardLoadFailure,
  LOAD_FAILURE_MARKER,
  ARM_FILE,
  type FailingComponent,
} from "../helpers/owner-guard-load-failure-component";

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
async function rowExists(table: string, id: string): Promise<boolean> {
  const res = await adminOp({
    operation: "search_by_value", database: "flair", table,
    search_attribute: "id", search_type: "equals", search_value: id, get_attributes: ["id"],
  });
  expect(res.status).toBe(200);
  const body: any = await res.json();
  return Array.isArray(body) && body.length > 0;
}
async function authFetch(m: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { Authorization: ed25519Header(m, method, path), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

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
});

describe("flair#2468 — an unreadable stored row on a real Harper request", () => {
  test("owner-guarded PUT/PATCH on an existing row: the client sees Harper's own 500, not the guard's refusal", async () => {
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
        seed: { agentId: owner.id, content: "stored" },
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

    // Seed each row with the ops API (native bridge — does not call _loadRecord).
    for (const c of seeded) {
      const res = await adminOp({
        operation: "insert", database: "flair", table: c.table,
        records: [{ id: c.id, createdAt: new Date().toISOString(), ...c.seed }],
      });
      expect(res.status, `seed ${c.table} ${c.id} returned ${res.status}`).toBe(200);
      expect(await rowExists(c.table, c.id), `${c.table} seed row should exist`).toBe(true);
    }

    arm();

    for (const c of seeded) {
      for (const verb of ["put", "patch"] as const) {
        const path = `/${c.table}/${c.id}`;
        const res = await authFetch(owner, verb.toUpperCase(), path, c[verb]);
        const text = await res.text();
        let parsed: any = {};
        try { parsed = JSON.parse(text); } catch { /* non-JSON */ }

        // RECORD what the client sees.
        console.log(`[2468] ${c.table}.${verb} (owner, unreadable row) -> ${res.status} ${text.slice(0, 240)}`);

        // The guard's named refusal must NOT be what answers: on this path the
        // failure is Harper's load, one layer up, so the resource never runs.
        expect(parsed.error, `${c.table}.${verb} answered with the guard's named refusal`).not.toBe("owner_check_unavailable");
        // It is Harper's own error, before the resource: a 5xx problem detail.
        expect(res.status, `${c.table}.${verb} returned ${res.status}: ${text.slice(0, 240)}`).toBe(500);
        expect(parsed.status).toBe(500);
        expect(String(parsed.title ?? ""), "the 500 must be the injected load failure, i.e. Harper's load ran first").toContain("forced stored-row read failure");

        // Nothing was written: the row is unchanged and still present.
        expect(await rowExists(c.table, c.id), `${c.table} row must survive the refused write`).toBe(true);
      }
    }
  }, 60_000);

  test("control: the same write on a NON-marker row is untouched by the injection", async () => {
    const id = `control-${randomUUID()}`;
    // Credential PUT as owner creates the row normally.
    const putRes = await authFetch(owner, "PUT", `/Credential/${id}`, { principalId: owner.id, kind: "bearer-token" });
    expect(await rowExists("Credential", id)).toBe(true);
    console.log(`[2468] control Credential.PUT (non-marker) -> ${putRes.status}`);
    expect(putRes.status).toBeLessThan(500);

    disarm();
    // A non-marker stored row still loads: PATCH as a DIFFERENT non-admin principal
    // is refused by the ownership layer, not by a 500.
    const patchRes = await authFetch(other, "PATCH", `/Credential/${id}`, { status: "revoked" });
    const patchText = await patchRes.text();
    console.log(`[2468] control cross-agent PATCH (non-marker) -> ${patchRes.status} ${patchText.slice(0, 200)}`);
    expect(patchRes.status, `cross-agent PATCH returned ${patchRes.status}`).toBeLessThan(500);
    arm();
  }, 60_000);
});
