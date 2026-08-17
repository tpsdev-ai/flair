// flair#1199 (trust-admission) — conformance budgetCap on the /mcp connector
// path (includeContext:false) with includeTrust:true.
//
// The connector-conformance suite declares the invariant
//   budgetCap: { estimate: "tokenEstimate", budget: "maxTokens", tolerance: 0.25 }
// i.e. tokenEstimate <= maxTokens * (1 + 0.25). tokenEstimate is measured over
// the FULL serialized response body (resources/MemoryBootstrap.ts response
// tail), which includes the opt-in `trust` array when includeTrust:true.
//
// The bug this test pins: each per-item trust block (buildTrustBlock(m) +
// the conditional matchQualityNote) is CONTENT — it scales with the number of
// included memories and ships serialized in the response — but it was built
// POST-admission (~line 1380) and never charged against tokenBudget. So on the
// /mcp path with includeTrust:true, the trust array inflated tokenEstimate by
// ~772 uncounted tokens (flint's field A/B on 0.44.11) and blew the budgetCap
// invariant. The fix charges each candidate's projected trust serialization
// against tokenBudget at the admission moment (all five sites), so the charged
// size and the shipped size can never drift.
//
// Positive control: this test FAILS on current main (trust blocks uncounted →
// tokenEstimate overshoots) and PASSES after the fix (trust blocks charged →
// fewer memories admitted → tokenEstimate within tolerance).
//
// #1207 control (second test): includeTrust:false must be byte-identical to
// pre-fix — the fix charges NO trust cost when trust is off, so the trust-off
// selection is unchanged (no flat per-item overhead against the content
// budget, which is exactly the #1199→#1207 regression this fix must not
// reintroduce).
//
// Pattern: test/integration/bootstrap-teammate-findings-e2e.test.ts (Ed25519
// signing, real embeddings via the signed PUT write path). Permanent memories
// are used because they ALWAYS render (no currentTask / recency window
// needed), so the seed deterministically exercises the permanent admission
// site and its trust blocks.
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

async function registerAgent(harper: HarperInstance, agent: TestAgent): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(res.status, `Agent insert for ${agent.id} returned ${res.status}`).toBe(200);
}

async function putMemory(harper: HarperInstance, agent: TestAgent, id: string, body: Record<string, any>): Promise<void> {
  const path = `/Memory/${id}`;
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "PUT",
    headers: { Authorization: ed25519Header(agent, "PUT", path), "Content-Type": "application/json" },
    body: JSON.stringify({ id, ...body }),
  });
  if (![200, 204].includes(res.status)) {
    throw new Error(`seed PUT ${id} → ${res.status}: ${await res.text()}`);
  }
}

async function bootstrap(harper: HarperInstance, agent: TestAgent, body: Record<string, any>): Promise<any> {
  const path = "/BootstrapMemories";
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  expect(res.status, `BootstrapMemories → ${res.status}: ${text.slice(0, 500)}`).toBe(200);
  return JSON.parse(text);
}

let harper: HarperInstance;
const agent = mkAgent(`t1199-${randomUUID()}`);

// 20 distinct PERMANENT memories — permanent records always render, so the
// seed deterministically fills the permanent admission site (and its trust
// blocks) without needing currentTask or a recency window. Content is kept
// genuinely distinct (distinctive rule number + phrasing) so Memory.ts's dedup
// co-gate (cosine >= 0.95 AND lexical Jaccard >= 0.5) never conflates them.
const SEED_COUNT = 20;
const SEED_CONTENT = Array.from({ length: SEED_COUNT }, (_, i) =>
  `flair-1199 marker: standing rule number ${i + 1} — before finalizing any vendor agreement, always verify the ${["indemnification cap", "termination notice window", "data-residency clause", "price-escalation cap", "SLA credit floor"][i % 5]} against the current legal playbook revision.`);

const MAX_TOKENS = 4000;
const TOLERANCE = 0.25;

describe("flair#1199 — trust-block admission charging (budgetCap conformance on /mcp)", () => {
  beforeAll(async () => {
    harper = await startHarper();
    await registerAgent(harper, agent);
    for (let i = 0; i < SEED_COUNT; i++) {
      await putMemory(harper, agent, `${agent.id}-perm-${i}`, {
        agentId: agent.id, content: SEED_CONTENT[i], durability: "permanent",
        createdAt: new Date(Date.now() - 40 * 24 * 3600_000).toISOString(),
      });
    }
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  test("budgetCap conformance: includeTrust:true on the /mcp path keeps tokenEstimate within maxTokens * (1 + tolerance)", async () => {
    const body = await bootstrap(harper, agent, {
      agentId: agent.id, maxTokens: MAX_TOKENS, includeTrust: true, includeContext: false,
    });

    // The trust array must actually be present and non-empty (the thing under
    // test — otherwise the invariant would hold vacuously).
    expect(Array.isArray(body.trust), "trust array must be present when includeTrust:true").toBe(true);
    expect(body.trust.length, "trust array must be non-empty").toBeGreaterThan(0);

    // The budgetCap invariant the connector-conformance suite asserts.
    expect(body.tokenEstimate, `tokenEstimate ${body.tokenEstimate} exceeded maxTokens ${body.maxTokens} * (1 + ${TOLERANCE}) = ${body.maxTokens * (1 + TOLERANCE)}`).toBeLessThanOrEqual(body.maxTokens * (1 + TOLERANCE));
  }, 60_000);

  test("#1207 control: includeTrust:false is byte-identical to pre-fix — no trust cost charged, selection unchanged", async () => {
    const trustOff = await bootstrap(harper, agent, {
      agentId: agent.id, maxTokens: MAX_TOKENS, includeTrust: false, includeContext: false,
    });

    // The trust-off response must carry NO `trust` key (byte-identical to
    // pre-slice-1), and must NOT charge any trust cost: every seeded permanent
    // memory is admitted (content-only budget), none truncated. If the fix
    // leaked trust cost into the trust-off path, some memories would be dropped
    // here — the #1199→#1207 regression (a flat per-item overhead charged
    // against the content budget).
    expect(trustOff.trust, "trust-off response must not carry a `trust` key").toBeUndefined();
    expect(trustOff.memoriesIncluded, `trust-off must admit all ${SEED_COUNT} seeded memories (no trust cost charged)`).toBe(SEED_COUNT);
    expect(trustOff.memoriesTruncated, "trust-off must truncate nothing").toBe(0);

    // And the trust-off path already conforms (no trust blocks to overrun).
    expect(trustOff.tokenEstimate).toBeLessThanOrEqual(trustOff.maxTokens * (1 + TOLERANCE));
  }, 60_000);
});
