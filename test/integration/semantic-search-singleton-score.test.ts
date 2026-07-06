// SemanticSearch scores a SINGLETON semantic-search result as 0
// ("DEGRADED") even though embeddings are loaded and the memory genuinely
// matches its own paraphrase.
//
// This is the SAME Harper quirk already root-caused and fixed for the dedup
// path (resources/Memory.ts findConservativeDedupMatch /
// resources/dedup.ts cosineSimilarity): a cosine-sort query's `$distance`
// annotation comes back `undefined` when its post-filter result set contains
// EXACTLY ONE matching record — sort ORDER is still correct, only the numeric
// distance is missing. resources/SemanticSearch.ts's legacy HNSW path (hybrid
// flag OFF, the default) computed
//   distanceToSimilarity(record.$distance ?? 1)
// so a singleton hit fell through `?? 1` → similarity 0 → the memory reads as
// totally dissimilar to a paraphrase of ITSELF.
//
// The read-scope Layer 1 change made this trigger easily: before, the no-grants agent scope
// was ALWAYS a compound `{operator:"or", conditions:[{agentId},{visibility==
// "office"}]}` condition; resolveReadScope() now emits a PLAIN single
// `{agentId==X}` condition for the common (no-grants) case, so an agent with
// exactly one matching memory hits the singleton-$distance quirk directly.
// This is exactly the shape of the clean-VM CI gate's single-memory init
// probe (#533), which as a result misreports "Semantic search DEGRADED —
// embeddings not loaded" — a MISLEADING message; embeddings are fine, only
// the score computation is wrong.
//
// Pattern: test/integration/ed25519-auth-hnsw.test.ts (real Ed25519-signed
// PUT so the embedding is generated through the real write path) +
// test/integration/memory-visibility-scoping-e2e.test.ts (adminOp agent
// seeding). Each test file gets its own freshly-spawned Harper (see
// test/helpers/harper-lifecycle.ts) with an empty Memory table, so writing
// exactly ONE memory for this agent guarantees the scoped search below sees a
// true singleton result set — no other test's records can leak in.
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
const agent = mkAgent("syzm-singleton");
const MEMORY_ID = "syzm-singleton-memory-1";
// Genuinely-related content + paraphrase, worded differently enough that the
// keyword-substring bump (`content.includes(q)`) never fires — the score we
// assert on is semanticScore alone, exactly the quantity this singleton-scoring bug corrupts.
const CONTENT = "Our quarterly budget review meeting is scheduled for next Tuesday afternoon in the main conference room downtown.";
const PARAPHRASE_QUERY = "When are we getting together to go over quarterly spending numbers?";

describe("SemanticSearch singleton-result scoring (real Harper, real embeddings)", () => {
  beforeAll(async () => {
    harper = await startHarper();
    const res = await adminOp(harper, {
      operation: "insert", database: "flair", table: "Agent",
      records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
    });
    expect(res.status).toBe(200);

    // Exactly ONE memory for this agent — and this Harper instance's Memory
    // table is otherwise empty (fresh spawn) — guarantees the scoped search
    // below is a true singleton post-filter result set. Real Ed25519-signed
    // PUT so the embedding is generated through the actual write path
    // (resources/Memory.ts put() → getEmbedding()), not synthesized.
    const path = `/Memory/${MEMORY_ID}`;
    const put = await fetch(`${harper.httpURL}${path}`, {
      method: "PUT",
      headers: { Authorization: ed25519Header(agent, "PUT", path), "Content-Type": "application/json" },
      body: JSON.stringify({ id: MEMORY_ID, agentId: agent.id, content: CONTENT, durability: "permanent" }),
    });
    if (![200, 204].includes(put.status)) throw new Error(`seed PUT ${MEMORY_ID} → ${put.status}: ${await put.text()}`);
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  test("SemanticSearch singleton-result scoring: a singleton semantic-search result scores as a real positive similarity, not 0/DEGRADED", async () => {
    const path = "/SemanticSearch";
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "POST",
      headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: agent.id, q: PARAPHRASE_QUERY, limit: 10, scoring: "raw" }),
    });
    const text = await res.text();
    expect(res.status, `SemanticSearch → ${res.status}: ${text.slice(0, 300)}`).toBe(200);
    const body: any = JSON.parse(text);

    // Confirm this really was the singleton case the bug depends on: exactly
    // one result, and it's our seeded memory.
    expect(body.results.length, `expected exactly 1 singleton result, got ${JSON.stringify(body.results).slice(0, 300)}`).toBe(1);
    expect(body.results[0].id).toBe(MEMORY_ID);

    const score = body.results[0]._score;
    console.log(`[singleton-score] singleton semantic score observed: ${score}`);
    // Pre-fix this is EXACTLY 0 (distanceToSimilarity(1) via the `?? 1`
    // fallback on an undefined $distance). A real paraphrase of the memory's
    // own content must score as genuinely similar — well above 0, not just
    // "not exactly zero" (guards against a trivial epsilon regression).
    expect(score, `singleton semantic score was ${score} — expected a real positive similarity for a paraphrase of the memory's own content`).toBeGreaterThan(0.2);
  }, 60_000);
});
