/**
 * memory-post-routing-2847.test.ts — real-Harper routing pin for Memory.
 *
 * A bare, agent-signed POST /Memory (no id in the path) reaches Memory.post():
 * the create answers 201, the row it generated reads back with the content and
 * the signing agent as agentId, and a body naming another agent's agentId meets
 * post()'s own attribution rule rather than a generic table insert.
 *
 * Mutation: ignore stampAttribution's denial in Memory.post() (resources/Memory.ts:2413)
 * and the foreign-agent case below fails on the status (the write is accepted).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";
import { HARPER_STOP_BUDGET_MS, HarperInstance, startHarper, stopHarper } from "../helpers/harper-lifecycle";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FOREIGN_OWNER = "post-routing-2847-agent-b";
const FOREIGN_REFUSAL = "forbidden: cannot write memory owned by another agent";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }
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
const agent = mkAgent("post-routing-2847-agent-a");

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (!h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} is not an instance this test started`);
  }
}
const basic = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);
async function adminOp(op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic() },
    body: JSON.stringify(op),
  });
}
async function authFetch(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { Authorization: ed25519Header(agent, method, path), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
/** The number of Memory rows in this instance, read through the ops surface. */
async function memoryRowCount(): Promise<number> {
  const res = await adminOp({ operation: "search_by_value", database: "flair", table: "Memory", search_attribute: "id", search_value: "*", get_attributes: ["id"] });
  const text = await res.text();
  expect(res.status, text.slice(0, 200)).toBe(200);
  return (JSON.parse(text) as any[]).length;
}

beforeAll(async () => {
  harper = await startHarper({ cwd: ROOT });
  assertOwnInstance(harper);
  const seed = await adminOp({
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(seed.status).toBe(200);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
}, HARPER_STOP_BUDGET_MS);

describe("flair#2847 — a bare POST /Memory reaches Memory.post() through real Harper", () => {
  it("creates with 201, generates the id and stores the signer as agentId", async () => {
    const content = `post-routing-2847 body ${randomUUID()}`;
    // post() writes through Harper's collection create (resources/Memory.ts:137),
    // which marks the request's created resource; REST answers 201 for it.
    const res = await authFetch("POST", "/Memory", { agentId: agent.id, content, visibility: "shared" });
    const text = await res.text();
    expect(res.status, `bare POST /Memory → ${res.status}: ${text.slice(0, 300)}`).toBe(201);
    const written = JSON.parse(text) as { id?: string; written?: boolean };
    expect(written.written).toBe(true);
    expect(typeof written.id).toBe("string");
    // post() passes `content.id ?? null` to the collection create, whose
    // getNewId() is randomUUID(): a v4 UUID.
    expect(written.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const read = await authFetch("GET", `/Memory/${written.id}`);
    const readText = await read.text();
    expect(read.status, `GET /Memory/${written.id} → ${read.status}: ${readText.slice(0, 300)}`).toBe(200);
    const row = JSON.parse(readText) as { id?: string; content?: string; agentId?: string };
    expect(row.id).toBe(written.id!);
    expect(row.content).toBe(content);
    expect(row.agentId).toBe(agent.id);
  }, 60_000);

  it("refuses a body that names another agent's agentId, and stores nothing", async () => {
    const before = await memoryRowCount();
    const res = await authFetch("POST", "/Memory", { agentId: FOREIGN_OWNER, content: `post-routing-2847 foreign ${randomUUID()}`, visibility: "shared" });
    const text = await res.text();
    // Memory.post() applies RECORD_TYPES.Memory.attribution.post "validate-truthy"
    // (resources/Memory.ts:2412-2413): a present agentId other than the signer is refused.
    expect(res.status, `foreign-agent POST /Memory → ${res.status}: ${text.slice(0, 300)}`).toBe(403);
    expect((JSON.parse(text) as { error?: string }).error).toBe(FOREIGN_REFUSAL);
    const after = await memoryRowCount();
    expect(after, `foreign-agent POST stored a row (before ${before}, after ${after})`).toBe(before);
  }, 60_000);
});
