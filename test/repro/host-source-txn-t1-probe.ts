// flair#1940 slice 1, item 2 — the host-pointer ATOMICITY probe (t1/t2).
//
// Run: bun test/repro/host-source-txn-t1-probe.ts
//
// Boots a HOME-isolated ephemeral Harper against THIS repo and forces the
// MemoryHostSource pointer write to FAIL (the table is dropped through the
// admin ops API) while the Memory write is staged, to observe whether the
// request transaction rolls the Memory row back. This is the real-Harper t1/t2
// evidence the round-4 brief asks for.
//
// t1: a POST whose pointer write throws leaves NO Memory row.
// t2: a PUT update of an existing record whose pointer write throws leaves the
//     PRE-EXISTING row byte-identical.
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

const harper = await startHarper({});
try {
  const admin = async (op: Record<string, any>) =>
    fetch(harper.opsURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}` },
      body: JSON.stringify(op),
    });
  const authFetch = async (agent: TestAgent, method: string, path: string, body?: unknown) =>
    fetch(`${harper.httpURL}${path}`, {
      method,
      headers: { Authorization: ed25519Header(agent, method, path), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const readMemory = async (id: string) => {
    const res = await admin({
      operation: "search_by_value", database: "flair", table: "Memory",
      search_attribute: "id", search_type: "equals", search_value: id, get_attributes: ["*"],
    });
    const body = await res.text();
    let rows: any[] = [];
    try { rows = JSON.parse(body); } catch { /* ignore */ }
    return rows;
  };

  const agent = mkAgent("probe-txn-agent");
  await admin({
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });

  const POINTER = { v: 1, host: "openclaw", kind: "run", id: "run-aaaaaaaa" };

  // ── Seed the t2 pre-existing row BEFORE dropping the pointer table ──
  const t2id = `probe-t2-${Date.now()}`;
  const seedT2 = await authFetch(agent, "POST", "/Memory", { id: t2id, agentId: agent.id, content: "PRE-EXISTING", visibility: "shared" });
  console.log("t2 SEED POST status:", seedT2.status);
  const before = JSON.stringify(await readMemory(t2id));
  console.log("t2 row BEFORE:", before);

  // ── Force the pointer write to fail: drop the MemoryHostSource table ──
  const drop = await admin({ operation: "drop_table", schema: "flair", table: "MemoryHostSource" });
  console.log("DROP TABLE MemoryHostSource status:", drop.status);
  console.log("DROP TABLE body:", (await drop.text()).slice(0, 200));

  // ── t1: POST with a pointer ──
  const t1id = `probe-t1-${Date.now()}`;
  const post = await authFetch(agent, "POST", "/Memory", {
    id: t1id, agentId: agent.id, content: "t1 pointer must fail", visibility: "shared",
    hostSource: POINTER, hostSourceScope: "record",
  });
  console.log("t1 POST /Memory status:", post.status);
  console.log("t1 POST body:", (await post.text()).slice(0, 200));
  const t1rows = await readMemory(t1id);
  console.log("t1 MEMORY READ rows:", t1rows.length);
  console.log("t1 RESULT — no Memory row left:", t1rows.length === 0);

  // ── t2: PUT update of the pre-existing row with a pointer ──
  const put = await authFetch(agent, "PUT", `/Memory/${t2id}`, {
    id: t2id, agentId: agent.id, content: "CHANGED", visibility: "shared",
    hostSource: POINTER, hostSourceScope: "record",
  });
  console.log("t2 PUT /Memory status:", put.status);
  console.log("t2 PUT body:", (await put.text()).slice(0, 200));
  const after = JSON.stringify(await readMemory(t2id));
  console.log("t2 row AFTER :", after);
  console.log("t2 RESULT — pre-existing row byte-identical:", before === after);
} finally {
  await stopHarper(harper);
}
