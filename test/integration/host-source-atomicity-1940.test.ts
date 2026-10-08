/**
 * host-source-atomicity-1940.test.ts — flair#1940 slice 1, A1-iv items 6/7.
 *
 * Real-Harper assertions for the host pointer, run against a composed copy of
 * the built component whose pointer-table adapter is replaced with a failing
 * one (test/helpers/host-pointer-failing-component.ts) — so the POINTER write
 * and delete themselves throw while everything else is production. Setup and
 * every read status is checked; a false result fails the test (no log-only
 * probes). Runs in CI's integration job.
 *
 *   t1  a POST whose pointer write throws leaves NO Memory row;
 *   t2  a PUT whose pointer write throws leaves the pre-existing row byte-identical;
 *   c3  a failing pointer delete fails the Memory delete and the row is still there;
 *   c5  a failing pointer delete fails POST /MemoryPurge by name after the row is removed (pointer rows
 *       are deleted only for rows a read after the commit finds gone); maintenance deletes the pointer row;
 *   r4-http  POST/PUT/PATCH/DELETE to MemoryHostSource are refused (non-admin AND admin), nothing written.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import nacl from "tweetnacl";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { componentWithFailingHostPointer, ADAPTER_REL, FAILING_ADAPTER_SRC, type FailingComponent } from "../helpers/host-pointer-failing-component";

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
const agent = mkAgent("atomicity-agent");
const POINTER = { v: 1, host: "openclaw", kind: "run", id: "run-aaaaaaaa" };

const adminBasic = () => `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}`;
async function adminOp(op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: adminBasic() }, body: JSON.stringify(op) });
}
async function adminFetch(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, { method, headers: { Authorization: adminBasic(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
}
async function authFetch(m: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, { method, headers: { Authorization: ed25519Header(m, method, path), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
}
async function readRows(table: string, attr: string, value: string): Promise<any[]> {
  const res = await adminOp({ operation: "search_by_value", database: "flair", table, search_attribute: attr, search_type: "equals", search_value: value, get_attributes: ["*"] });
  expect(res.status).toBe(200); // assertion: the read succeeded
  const text = await res.text();
  return JSON.parse(text);
}

beforeAll(async () => {
  component = componentWithFailingHostPointer();
  harper = await startHarper({ cwd: component.dir });
  const seed = await adminOp({ operation: "insert", database: "flair", table: "Agent", records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }] });
  expect(seed.status).toBe(200); // assertion: setup seeded the agent
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (component) component.cleanup();
});

describe("flair#1940 A1-iv item 7 — real-Harper atomicity + REST refusal", () => {
  it("ctrl: the composed copy IS the ESM failing adapter and its injected failure is observed", async () => {
    // Positive control, judged BEFORE any rollback assertion: prove the failing
    // adapter actually loaded, so t1/t2/c3 below can only pass because it did.
    const onDisk = readFileSync(join(component.dir, ADAPTER_REL), "utf8");
    expect(onDisk).toContain("export async function putPointerRow"); // assertion: ESM export, not CJS exports.*
    expect(onDisk).toContain("forced host-pointer write failure"); // assertion: OUR injected failure
    const id = `it-ctrl-${Date.now()}`;
    const res = await authFetch(agent, "POST", "/Memory", { id, agentId: agent.id, content: "ctrl", visibility: "shared", hostSource: POINTER, hostSourceScope: "record" });
    expect(res.status).toBe(500); // assertion: the injected failure IS observed on the wire
    expect((await readRows("Memory", "id", id)).length).toBe(0); // assertion: nothing was written
  }, 60_000);

  it("t1: a POST whose pointer write throws leaves NO Memory row", async () => {
    const id = `it-t1-${Date.now()}`;
    const res = await authFetch(agent, "POST", "/Memory", { id, agentId: agent.id, content: "t1", visibility: "shared", hostSource: POINTER, hostSourceScope: "record" });
    expect(res.status).toBe(500); // assertion: the write failed
    expect((await readRows("Memory", "id", id)).length).toBe(0); // assertion: no Memory row
  }, 60_000);

  it("t2: a PUT whose pointer write throws leaves the pre-existing row byte-identical", async () => {
    const id = `it-t2-${Date.now()}`;
    const seed = await authFetch(agent, "POST", "/Memory", { id, agentId: agent.id, content: "PRE-EXISTING", visibility: "shared" });
    expect(seed.status).toBe(201); // assertion: the pre-existing row was written
    const before = JSON.stringify(await readRows("Memory", "id", id));
    const res = await authFetch(agent, "PUT", `/Memory/${id}`, { id, agentId: agent.id, content: "CHANGED", visibility: "shared", hostSource: POINTER, hostSourceScope: "record" });
    expect(res.status).toBe(500); // assertion: the update failed
    expect(JSON.stringify(await readRows("Memory", "id", id))).toBe(before); // assertion: the row is unchanged
  }, 60_000);

  it("c3: a failing pointer delete fails the Memory delete and the row is still there", async () => {
    const id = `it-c3-${Date.now()}`;
    const seedMem = await adminOp({ operation: "insert", database: "flair", table: "Memory", records: [{ id, agentId: agent.id, content: "c3", contentHash: "h", visibility: "shared", createdAt: new Date().toISOString(), archived: false, instanceToken: randomUUID() }] });
    expect(seedMem.status).toBe(200); // assertion: seeded the Memory row
    const seedPtr = await adminOp({ operation: "insert", database: "flair", table: "MemoryHostSource", records: [{ memoryId: id, hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: agent.id, memoryInstanceToken: "x", receivedAt: new Date().toISOString() }] });
    expect(seedPtr.status).toBe(200); // assertion: seeded the pointer row
    const res = await authFetch(agent, "DELETE", `/Memory/${id}`);
    expect(res.status).toBe(500); // assertion: the delete failed
    expect((await readRows("Memory", "id", id)).length).toBe(1); // assertion: the Memory row remains
  }, 60_000);

  it("c5: a failing pointer delete fails POST /MemoryPurge by name after the row is removed; the maintenance orphan sweep deletes the pointer row", async () => {
    const id = `it-c5-${Date.now()}`;
    const instanceToken = randomUUID();
    const seedMem = await adminOp({ operation: "insert", database: "flair", table: "Memory", records: [{ id, agentId: agent.id, content: "c5", contentHash: "h", visibility: "shared", durability: "permanent", createdAt: new Date().toISOString(), archived: false, instanceToken }] });
    expect(seedMem.status).toBe(200); // assertion: seeded the Memory row
    const seedPtr = await adminOp({ operation: "insert", database: "flair", table: "MemoryHostSource", records: [{ memoryId: id, hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: agent.id, memoryInstanceToken: instanceToken, receivedAt: new Date().toISOString() }] });
    expect(seedPtr.status).toBe(200); // assertion: seeded the pointer row
    expect(await readRows("MemoryDeletionHistory", "memoryId", id)).toEqual([]); // assertion: no history yet
    const res = await adminFetch("POST", "/MemoryPurge", { ids: [id] });
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBe(500); // assertion: the purge failed
    expect(JSON.parse(text)).toMatchObject({ error: "memory_purge_pointer_cleanup_failed", ids: [id], removedIds: [id] }); // assertion: by name, and the row is listed as removed
    expect(await readRows("Memory", "id", id)).toEqual([]); // assertion: the row is removed
    expect((await readRows("MemoryDeletionHistory", "memoryId", id)).length).toBe(1); // assertion: its removal is recorded
    expect((await readRows("MemoryHostSource", "memoryId", id)).length).toBe(1); // assertion: its pointer row is left
    const sweep = await adminFetch("POST", "/MemoryMaintenance", { agentId: agent.id });
    expect(sweep.status).toBe(200); // assertion: maintenance ran
    expect(await readRows("MemoryHostSource", "memoryId", id)).toEqual([]); // assertion: the orphan sweep deleted the pointer row
  }, 60_000);

  it("r4-http: every MemoryHostSource REST write verb is refused (non-admin and admin), nothing written", async () => {
    const id = `it-r4-${Date.now()}`;
    const attempts = [
      await authFetch(agent, "POST", "/MemoryHostSource", { memoryId: id, hostSource: JSON.stringify(POINTER) }),
      await authFetch(agent, "PUT", `/MemoryHostSource/${id}`, { memoryId: id, hostSource: JSON.stringify(POINTER) }),
      await authFetch(agent, "PATCH", `/MemoryHostSource/${id}`, { memoryId: id, scopeAtWrite: "shared" }),
      await authFetch(agent, "DELETE", `/MemoryHostSource/${id}`),
      await adminFetch("POST", "/MemoryHostSource", { memoryId: id, hostSource: JSON.stringify(POINTER) }),
      await adminFetch("PUT", `/MemoryHostSource/${id}`, { memoryId: id, hostSource: JSON.stringify(POINTER) }),
      await adminFetch("PATCH", `/MemoryHostSource/${id}`, { memoryId: id, scopeAtWrite: "shared" }),
      await adminFetch("DELETE", `/MemoryHostSource/${id}`),
    ];
    for (const res of attempts) expect(res.status).toBe(403); // assertion: refused
    expect((await readRows("MemoryHostSource", "memoryId", id)).length).toBe(0); // assertion: nothing written
  }, 60_000);
});
