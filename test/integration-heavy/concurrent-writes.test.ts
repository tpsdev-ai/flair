// Concurrent-write → immediate-search integration test.
//
// Guards the read-your-writes path: an agent writes N memories in parallel,
// then immediately searches. If any write is still in-flight when the search
// runs, the keyword-fallback path must still return it — embedding generation
// can lag, but the row itself must be durable and searchable by subject/id.
//
// This is the class of race the 0.5.x cycle kept re-discovering piecemeal:
//   - 0.5.2: scoped search returned 0 rows for authenticated agents
//   - 0.5.3: embedding queue was blocking Memory.search's response
//   - 0.5.5: cross-agent scope leak on four endpoints
// Each of those was found by a human running the CLI fast. This pins the
// pattern so CI finds the next one instead.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

interface TestAgent {
  id: string;
  publicKey: string;
  secretKey: Uint8Array;
}

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return {
    id,
    publicKey: Buffer.from(kp.publicKey).toString("base64"),
    secretKey: kp.secretKey,
  };
}

function buildEd25519Auth(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  const sigB64 = Buffer.from(sig).toString("base64");
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${sigB64}`;
}

async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify(op),
  });
}

async function seedAgent(harper: HarperInstance, agent: TestAgent): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert",
    database: "flair",
    table: "Agent",
    records: [{
      id: agent.id,
      name: agent.id,
      role: "agent",
      publicKey: agent.publicKey,
      createdAt: new Date().toISOString(),
    }],
  });
  expect(res.status).toBe(200);
}

async function authFetch(
  harper: HarperInstance,
  agent: TestAgent,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const auth = buildEd25519Auth(agent, method, path);
  const headers: Record<string, string> = { Authorization: auth };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

let harper: HarperInstance;
const carol = mkAgent("carol-concurrent");
const SUBJECT = "concurrent-writes-test";
const COUNT = 50;
const MARKER_INDEX = 25;
const UNIQUE_MARKER = "zx9q7-midpoint-marker";

function memoryContent(i: number): string {
  if (i === MARKER_INDEX) return `carol note ${i}: ${UNIQUE_MARKER} embedded for keyword lookup`;
  return `carol note ${i}: generic content item ${i}`;
}

describe("Concurrent writes → immediate read consistency", () => {
  beforeAll(async () => {
    harper = await startHarper();
    await seedAgent(harper, carol);
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  test("50 parallel PUT /Memory writes all succeed", async () => {
    const writes = Array.from({ length: COUNT }, (_, i) => {
      const id = `carol-concurrent-${i}`;
      return authFetch(harper, carol, "PUT", `/Memory/${id}`, {
        id,
        agentId: carol.id,
        content: memoryContent(i),
        subject: SUBJECT,
        durability: "standard",
      });
    });
    const responses = await Promise.all(writes);
    for (let i = 0; i < responses.length; i++) {
      const res = responses[i];
      if (![200, 204].includes(res.status)) {
        const text = await res.text();
        throw new Error(`PUT /Memory/carol-concurrent-${i} failed ${res.status}: ${text}`);
      }
    }
  }, 120_000);

  test("immediate scoped search returns all 50 rows (no sleep between write and read)", async () => {
    // No `q` — exercises the keyword-fallback path that doesn't depend on the
    // embedding queue. Every row must be visible as soon as the write fetch
    // resolves; if not, the write wasn't actually durable when we thought.
    const res = await authFetch(harper, carol, "POST", "/SemanticSearch", {
      agentId: carol.id,
      subject: SUBJECT,
      limit: 100,
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results.length).toBe(COUNT);
    for (const r of body.results) expect(r.agentId).toBe(carol.id);
  }, 30_000);

  test("keyword search for the unique marker finds the midpoint write", async () => {
    // If the embedding queue is still catching up, this query MUST route
    // through the keyword path and still return the row. That's the contract
    // the 0.5.3 regression broke.
    const res = await authFetch(harper, carol, "POST", "/SemanticSearch", {
      agentId: carol.id,
      subject: SUBJECT,
      q: UNIQUE_MARKER,
      limit: 10,
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(Array.isArray(body.results)).toBe(true);
    const hit = body.results.find((r: any) => r.id === `carol-concurrent-${MARKER_INDEX}`);
    expect(hit).toBeDefined();
    expect(hit.content).toContain(UNIQUE_MARKER);
  }, 30_000);

  test("GET /Memory/{id} for every written id succeeds right after the write barrier", async () => {
    // Defense in depth: even if search had some staleness window, direct
    // id-lookup must be immediately consistent. 50 parallel GETs.
    const gets = Array.from({ length: COUNT }, (_, i) =>
      authFetch(harper, carol, "GET", `/Memory/carol-concurrent-${i}`),
    );
    const responses = await Promise.all(gets);
    for (let i = 0; i < responses.length; i++) {
      expect(responses[i].status).toBe(200);
    }
  }, 60_000);
});
