// flair#1940 slice 1, item 2 — the host-pointer transaction probe.
//
// Run: bun test/repro/host-source-txn-probe.ts
//
// Boots a HOME-isolated ephemeral Harper against THIS repo (real schemas +
// resources), writes a Memory row with a hostSource over the real REST surface,
// then reads the MemoryHostSource table back through the admin ops API. The
// question this answers: does a real Memory write actually persist its pointer
// row, and does the internal table write join the request transaction?
//
// Not a `.test.ts`: the unit lane must not boot Harper. This is a one-shot
// probe whose output is recorded in the PR report.
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
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}`,
      },
      body: JSON.stringify(op),
    });
  const authFetch = async (agent: TestAgent, method: string, path: string, body?: unknown) =>
    fetch(`${harper.httpURL}${path}`, {
      method,
      headers: {
        Authorization: ed25519Header(agent, method, path),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  const agent = mkAgent("probe-txn-agent");
  const seed = await admin({
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  console.log("SEED Agent status:", seed.status);

  const id = `probe-txn-${Date.now()}`;
  const POINTER = { v: 1, host: "openclaw", kind: "run", id: "run-aaaaaaaa" };
  const put = await authFetch(agent, "POST", "/Memory", {
    id, agentId: agent.id, content: "probe pointer row", visibility: "shared",
    hostSource: POINTER, hostSourceScope: "record",
  });
  console.log("POST /Memory status:", put.status);
  console.log("POST /Memory body:", (await put.text()).slice(0, 300));

  // Read the pointer row back through the admin ops API (bypasses the resource).
  const read = await admin({
    operation: "search_by_value", database: "flair", table: "MemoryHostSource",
    search_attribute: "memoryId", search_type: "equals", search_value: id, get_attributes: ["*"],
  });
  const body = await read.text();
  console.log("POINTER READ status:", read.status);
  console.log("POINTER READ body:", body.slice(0, 400));

  const memRead = await admin({
    operation: "search_by_value", database: "flair", table: "Memory",
    search_attribute: "id", search_type: "equals", search_value: id, get_attributes: ["id", "visibility", "content"],
  });
  console.log("MEMORY READ status:", memRead.status);
  console.log("MEMORY READ body:", (await memRead.text()).slice(0, 400));
} finally {
  await stopHarper(harper);
}
