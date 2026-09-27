// flair#1940 slice 1 — ROUND 5 real-Harper assertions.
//
// Run: env HOME=<scratch> FLAIR_TEST_FAIL_HOST_POINTER_WRITE=1 FLAIR_TEST_FAIL_HOST_POINTER_DELETE=1 bun test/repro/host-source-r5-probe.ts
//
// One HOME-isolated ephemeral Harper, real schemas + resources, with the
// test-only seams that force the POINTER write/delete ITSELF to throw (the
// table stays present — no "table unavailable" shortcut). Asserts, not logs:
//   t1  a POST whose pointer write throws leaves NO Memory row;
//   t2  a PUT whose pointer write throws leaves the pre-existing row byte-identical;
//   c3  a failing pointer delete fails the Memory delete and the row is still there;
//   r4-http  POST/PUT/PATCH/DELETE to MemoryHostSource are refused (non-admin AND admin) with nothing written.
// Exits non-zero (throws) if any expectation fails.
import { randomUUID } from "node:crypto";
import nacl from "tweetnacl";
import { startHarper, stopHarper } from "../helpers/harper-lifecycle";

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

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "PASS" : "FAIL"} — ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) failures++;
}

const harper = await startHarper({});
try {
  const adminBasic = `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}`;
  const admin = async (op: Record<string, any>) =>
    fetch(harper.opsURL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: adminBasic }, body: JSON.stringify(op) });
  const readMemory = async (id: string) => {
    const res = await admin({ operation: "search_by_value", database: "flair", table: "Memory", search_attribute: "id", search_type: "equals", search_value: id, get_attributes: ["*"] });
    let rows: any[] = [];
    try { rows = JSON.parse(await res.text()); } catch { /* ignore */ }
    return rows;
  };
  const readPointer = async (memoryId: string) => {
    const res = await admin({ operation: "search_by_value", database: "flair", table: "MemoryHostSource", search_attribute: "memoryId", search_type: "equals", search_value: memoryId, get_attributes: ["*"] });
    let rows: any[] = [];
    try { rows = JSON.parse(await res.text()); } catch { /* ignore */ }
    return rows;
  };
  const authFetch = async (agent: TestAgent, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) =>
    fetch(`${harper.httpURL}${path}`, {
      method,
      headers: { Authorization: ed25519Header(agent, method, path), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...extraHeaders },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const adminWrite = async (method: string, path: string, body?: unknown) =>
    fetch(`${harper.httpURL}${path}`, { method, headers: { Authorization: adminBasic, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });

  const agent = mkAgent("probe-r5-agent");
  await admin({ operation: "insert", database: "flair", table: "Agent", records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }] });

  const POINTER = { v: 1, host: "openclaw", kind: "run", id: "run-aaaaaaaa" };

  // ── t2 pre-existing row (written with NO pointer, before the failure) ──
  const t2id = `probe-t2-${Date.now()}`;
  const seed = await authFetch(agent, "POST", "/Memory", { id: t2id, agentId: agent.id, content: "PRE-EXISTING", visibility: "shared" });
  check("t2 seed POST is 201", seed.status === 201, `status=${seed.status}`);
  const before = JSON.stringify(await readMemory(t2id));

  // ── t1: POST whose pointer write throws ──
  const t1id = `probe-t1-${Date.now()}`;
  const t1 = await authFetch(agent, "POST", "/Memory", { id: t1id, agentId: agent.id, content: "t1", visibility: "shared", hostSource: POINTER, hostSourceScope: "record" });
  const t1body = await t1.text();
  check("t1 POST is 500 host_source_persist_failed", t1.status === 500 && t1body.includes("host_source_persist_failed"), `status=${t1.status} body=${t1body.slice(0, 120)}`);
  check("t1 leaves NO Memory row", (await readMemory(t1id)).length === 0);

  // ── t2: PUT whose pointer write throws leaves the pre-existing row byte-identical ──
  const t2 = await authFetch(agent, "PUT", `/Memory/${t2id}`, { id: t2id, agentId: agent.id, content: "CHANGED", visibility: "shared", hostSource: POINTER, hostSourceScope: "record" });
  check("t2 PUT is 500", t2.status === 500, `status=${t2.status}`);
  const after = JSON.stringify(await readMemory(t2id));
  check("t2 pre-existing row is byte-identical", before === after);

  // ── c3: a failing pointer DELETE fails the Memory delete; the row stays ──
  const c3id = `probe-c3-${Date.now()}`;
  await admin({ operation: "insert", database: "flair", table: "MemoryHostSource", records: [{ memoryId: c3id, hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: agent.id, receivedAt: new Date().toISOString() }] });
  await admin({ operation: "insert", database: "flair", table: "Memory", records: [{ id: c3id, agentId: agent.id, content: "c3", contentHash: "h", visibility: "shared", createdAt: new Date().toISOString(), archived: false }] });
  const c3 = await authFetch(agent, "DELETE", `/Memory/${c3id}`);
  check("c3 DELETE is 500", c3.status === 500, `status=${c3.status}`);
  check("c3 Memory row is still there", (await readMemory(c3id)).length === 1);

  // ── r4-http: MemoryHostSource refuses every REST write verb, non-admin AND admin ──
  const rid = `probe-r4-${Date.now()}`;
  const attempts: Array<[string, string, Response]> = [];
  attempts.push(["non-admin POST", "post", await authFetch(agent, "POST", "/MemoryHostSource", { memoryId: rid, hostSource: JSON.stringify(POINTER) })]);
  attempts.push(["non-admin PUT", "put", await authFetch(agent, "PUT", `/MemoryHostSource/${rid}`, { memoryId: rid, hostSource: JSON.stringify(POINTER) })]);
  attempts.push(["non-admin PATCH", "patch", await authFetch(agent, "PATCH", `/MemoryHostSource/${rid}`, { memoryId: rid, scopeAtWrite: "shared" })]);
  attempts.push(["non-admin DELETE", "delete", await authFetch(agent, "DELETE", `/MemoryHostSource/${rid}`)]);
  attempts.push(["admin POST", "post", await adminWrite("POST", "/MemoryHostSource", { memoryId: rid, hostSource: JSON.stringify(POINTER) })]);
  attempts.push(["admin PUT", "put", await adminWrite("PUT", `/MemoryHostSource/${rid}`, { memoryId: rid, hostSource: JSON.stringify(POINTER) })]);
  attempts.push(["admin PATCH", "patch", await adminWrite("PATCH", `/MemoryHostSource/${rid}`, { memoryId: rid, scopeAtWrite: "shared" })]);
  attempts.push(["admin DELETE", "delete", await adminWrite("DELETE", `/MemoryHostSource/${rid}`)]);
  for (const [label, _verb, res] of attempts) {
    check(`r4-http ${label} refused (403)`, res.status === 403, `status=${res.status}`);
  }
  check("r4-http nothing written", (await readPointer(rid)).length === 0);

  console.log(`\nPROBE RESULT — failures: ${failures}`);
  if (failures > 0) throw new Error(`host-source r5 probe: ${failures} assertion(s) failed`);
} finally {
  await stopHarper(harper);
}
