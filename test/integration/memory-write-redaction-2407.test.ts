/**
 * memory-write-redaction-2407.test.ts — server-side credential redaction on the
 * real HTTP Memory write surface (flair#2407).
 *
 * Complements test/unit-isolated/memory-write-redaction-2407.test.ts: this file
 * runs against a REAL Harper (test/helpers/harper-lifecycle.ts), so the
 * redaction is proven through Harper's own resource dispatch and response
 * serialization — not a stand-in table. It drives the direct authenticated REST
 * verbs an agent uses: POST (create), PUT (update) and PATCH.
 *
 * The MCP `memory_store` / `memory_update` tools and `flair memory add` reach
 * these same server-side Memory write methods (resources/mcp-tools.ts calls
 * Memory.post()/put(); the CLI issues the PUT).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface TestAgent {
  id: string;
  publicKey: string;
  secretKey: Uint8Array;
}
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
const agent = mkAgent("redact-agent-a");

const adminBasic = () => `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}`;
async function adminOp(op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminBasic() },
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
async function readRow(id: string): Promise<any> {
  const res = await adminOp({
    operation: "search_by_value",
    database: "flair",
    table: "Memory",
    search_attribute: "id",
    search_type: "equals",
    search_value: id,
    get_attributes: ["*"],
  });
  expect(res.status).toBe(200);
  const rows = JSON.parse(await res.text());
  return rows.find((r: any) => r.id === id);
}

const GITHUB_TOKEN = `ghp_${"a".repeat(24)}`;
const AWS_KEY = `AKIA${"B".repeat(16)}`;
const SLACK_TOKEN = `xoxb-${"c".repeat(12)}`;
const REDACTED = "[redacted]";

beforeAll(async () => {
  harper = await startHarper({ cwd: ROOT });
  const seed = await adminOp({
    operation: "insert",
    database: "flair",
    table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(seed.status).toBe(200);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
});

describe("flair#2407 — real-Harper REST write paths redact and report the count", () => {
  it("POST /Memory stores the redacted content and reports one redacted value", async () => {
    const id = `r2407-post-${randomUUID()}`;
    const original = `stored CI token ${GITHUB_TOKEN} for the deploy job`;
    const res = await authFetch("POST", "/Memory", { id, agentId: agent.id, content: original, visibility: "shared" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.redactedValues).toBe(1);
    const row = await readRow(id);
    expect(row.content).toBe(`stored CI token ${REDACTED} for the deploy job`);
  }, 60_000);

  it("PUT /Memory/<id> stores the redacted content and reports one redacted value", async () => {
    const id = `r2407-put-${randomUUID()}`;
    const seed = await authFetch("POST", "/Memory", { id, agentId: agent.id, content: "seed row before the update", visibility: "shared" });
    expect(seed.status).toBe(201);
    const original = `backup uses the key ${AWS_KEY} every night`;
    const res = await authFetch("PUT", `/Memory/${id}`, { id, agentId: agent.id, content: original, visibility: "shared" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.redactedValues).toBe(1);
    expect((await readRow(id)).content).toBe(`backup uses the key ${REDACTED} every night`);
  }, 60_000);

  it("PATCH /Memory/<id> stores the redacted content and reports one redacted value", async () => {
    const id = `r2407-patch-${randomUUID()}`;
    const seed = await authFetch("POST", "/Memory", { id, agentId: agent.id, content: "seed row before the patch", visibility: "shared" });
    expect(seed.status).toBe(201);
    const res = await authFetch("PATCH", `/Memory/${id}`, { content: `notify via ${SLACK_TOKEN}` });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.redactedValues).toBe(1);
    expect((await readRow(id)).content).toBe(`notify via ${REDACTED}`);
  }, 60_000);

  it("POST /Memory with a string that merely starts like a prefix stores it byte-identical, no count", async () => {
    const id = `r2407-clean-${randomUUID()}`;
    const original = "the placeholder ghp_tooshort and sk-abc are not credentials";
    const res = await authFetch("POST", "/Memory", { id, agentId: agent.id, content: original, visibility: "shared" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.redactedValues).toBeUndefined();
    expect((await readRow(id)).content).toBe(original);
  }, 60_000);

  it("POST /FeedMemories stores the redacted content and reports one redacted value", async () => {
    const id = `r2407-feed-${randomUUID()}`;
    const original = `feed body carrying ${SLACK_TOKEN} for the team`;
    const res = await authFetch("POST", "/FeedMemories", { id, agentId: agent.id, content: original, durability: "permanent" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.redactedValues).toBe(1);
    expect((await readRow(id)).content).toBe(`feed body carrying ${REDACTED} for the team`);
  }, 60_000);
});
