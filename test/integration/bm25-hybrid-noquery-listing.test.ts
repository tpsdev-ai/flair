// Regression guard: SemanticSearch with NEITHER `q` NOR `queryEmbedding` (the
// "list everything in my scope" call — e.g. browse-by-agentId/tag/subject with
// no search text) must return the full scoped listing REGARDLESS of the
// FLAIR_HYBRID_RETRIEVAL flag.
//
// Found while preparing to activate the BM25 + union-RRF hybrid path
// (FLAIR-BM25-HYBRID-RETRIEVAL): resources/SemanticSearch.ts's hybrid branch
// only ever populates `semIds` when `qEmb` is present and `bm25Ids` when `q`
// is present. With neither, `fuseRrfNormalized([], [])` returns an empty map,
// so the union-RRF loop silently emitted ZERO results — while the legacy
// (hybrid flag OFF) path's final no-embedding branch full-scans and returns
// every scope-matching record. Confirmed by forcing FLAIR_HYBRID_RETRIEVAL=true
// against test/integration/memory-visibility-scoping-e2e.test.ts, which relies
// on exactly this no-q listing shape and failed 2/16 before the fix.
//
// Fixed in resources/SemanticSearch.ts's hybrid branch: when `!q && !qEmb`,
// emit every record already collected in `allowedById` (the SAME
// conditions[]-filtered, isAllowedBm25Candidate-gated candidate set the BM25
// pass would have scored) directly at rawScore 0, instead of routing through
// the (necessarily-empty) RRF fusion. This test pins that fix so it can never
// silently regress again.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

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
async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(op),
  });
}

let harper: HarperInstance;
const agent = mkAgent("hybrid-noq-listing");
const LIVE_ID = "hybrid-noq-live";
const ARCHIVED_ID = "hybrid-noq-archived";

describe("SemanticSearch no-q/no-embedding listing (hybrid flag ON — regression guard)", () => {
  beforeAll(async () => {
    // Spawn with the flag ON from the start — startHarper() inherits
    // process.env at spawn time, so this must be set before the call.
    const prev = process.env.FLAIR_HYBRID_RETRIEVAL;
    process.env.FLAIR_HYBRID_RETRIEVAL = "true";
    try {
      harper = await startHarper();
    } finally {
      if (prev === undefined) delete process.env.FLAIR_HYBRID_RETRIEVAL; else process.env.FLAIR_HYBRID_RETRIEVAL = prev;
    }

    const res = await adminOp(harper, {
      operation: "insert", database: "flair", table: "Agent",
      records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
    });
    expect(res.status).toBe(200);

    for (const [id, archived] of [[LIVE_ID, false], [ARCHIVED_ID, true]] as const) {
      const path = `/Memory/${id}`;
      const r = await fetch(`${harper.httpURL}${path}`, {
        method: "PUT",
        headers: { Authorization: ed25519Header(agent, "PUT", path), "Content-Type": "application/json" },
        body: JSON.stringify({ id, agentId: agent.id, content: `record ${id}`, durability: "standard", archived, createdAt: new Date().toISOString() }),
      });
      if (![200, 204].includes(r.status)) throw new Error(`seed PUT ${id} → ${r.status}: ${await r.text()}`);
    }
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  test("no q, no queryEmbedding → full scoped listing (not empty), archived still excluded", async () => {
    const path = "/SemanticSearch";
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "POST",
      headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: agent.id, limit: 100 }),
    });
    const text = await res.text();
    expect(res.status, `SemanticSearch → ${res.status}: ${text.slice(0, 300)}`).toBe(200);
    const body: any = JSON.parse(text);
    const ids = new Set((body.results ?? []).map((r: any) => r.id));

    // Pre-fix: this was an empty array (0 results) under hybrid ON.
    expect(ids.has(LIVE_ID), `expected the live record in a no-q listing under hybrid ON, got ${JSON.stringify([...ids])}`).toBe(true);
    expect(ids.has(ARCHIVED_ID)).toBe(false);
  }, 60_000);
});
