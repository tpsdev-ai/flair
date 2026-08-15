// ─── flair#1207 — budget accounting must not drop a relevant finding ──────────
//
// #1199 folded a per-item structured overhead (STRUCT_ITEM_OVERHEAD_TOKENS = 70)
// AND a scaffolding reserve (structOverheadReserve = min(600, 15% of maxTokens))
// INTO the content-SELECTION budget. That silently shrank how much on-task
// content ships for the same `maxTokens` (the reported 6 findings → 3), and —
// because the task-relevant packing loop is score-ordered and `continue`s past
// an over-budget record — a LARGE, HIGH-relevance record whose (shrunk-budget)
// cost exceeded the budget was skipped while smaller, lower-relevance records
// downstream still fit. The ranker was never implicated (scoring.ts /
// semantic-retrieval-core.ts are byte-identical v0.44.6..v0.44.8).
//
// The fix (Kern Option A): decouple measurement from budgeting. `tokenEstimate`
// keeps measuring the real serialized payload; the structural overhead is NO
// LONGER charged against the selection budget (the per-item +70 and the reserve
// are removed), so the content budget is `maxTokens` again — 0.44.6 capacity.
//
// This test encodes the concrete repro with REAL embeddings: a store with ONE
// large, top-relevance record + several smaller, lower-relevance ones, and a
// `maxTokens` tuned so the 0.44.8 budget (maxTokens − reserve, +70/item) drops
// the large on-task record while the fixed budget (maxTokens) includes it. The
// large record's shrunk-budget cost (est + 70) EXCEEDS `maxTokens − reserve`,
// so 0.44.8 drops it regardless of packing order; the fixed budget admits it
// AND every smaller record (they all fit under `maxTokens`). Mutation check:
// re-introducing the reserve + per-item overhead drops the large record and this
// test fails.
//
// Pattern (real Harper + real embeddings via the signed PUT write path):
// test/integration/bootstrap-teammate-findings-e2e.test.ts.
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

/** Signed PUT to /Memory/<id> — the HTTP-reachable create path, so the embedding
 *  is generated for real (Memory.ts put() → getEmbedding()), not synthesized. */
async function putMemory(harper: HarperInstance, agent: TestAgent, id: string, body: Record<string, any>): Promise<void> {
  const path = `/Memory/${id}`;
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "PUT",
    headers: { Authorization: ed25519Header(agent, "PUT", path), "Content-Type": "application/json" },
    body: JSON.stringify({ id, ...body }),
  });
  if (![200, 204].includes(res.status)) throw new Error(`seed PUT ${id} → ${res.status}: ${await res.text()}`);
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

const est = (s: string) => Math.ceil(s.length / 4);

let harper: HarperInstance;
const caller = mkAgent(`t1207-${randomUUID()}`);

// Tightly-aligned domain so every seeded record clears MemoryBootstrap's raw
// score > 0.3 floor against currentTask deterministically (the same technique
// bootstrap-teammate-findings-e2e uses), while keeping each record's actual
// words distinct enough to never trip Memory.ts's write-time dedup co-gate
// (cosine >= 0.95 AND lexical Jaccard >= 0.5).
const CURRENT_TASK = "Reconcile the Q3 Meridian account migration saga-ledger: opening balances, transfer batches, and the settlement variance.";
const LARGE_MARKER = `LEDGER-LARGE-${randomUUID()}`;
const SMALL_MARKERS = [0, 1, 2, 3].map((i) => `LEDGER-SMALL-${i}-${randomUUID()}`);

// The large "saga-ledger" record — the highest-relevance, largest record.
// Built to ~7.2k chars (est ~1800 tokens) so, at maxTokens=2000, its
// shrunk-0.44.8 cost (est + 70) exceeds the 0.44.8 budget (2000 − 300 reserve =
// 1700) and it is DROPPED, while the fixed budget (2000) admits it.
const LARGE_BODY = `${LARGE_MARKER}: Q3 Meridian account migration saga-ledger. `
  + ("Opening balances were carried from the legacy Meridian sub-ledgers into the migrated account tree; each transfer batch reconciles against the settlement variance report for the Meridian migration, batch by batch, with the running saga-ledger totals. "
     .repeat(28));
const SMALL_BODIES = [
  `${SMALL_MARKERS[0]}: Meridian migration transfer batch 7 posted a settlement variance of 214 basis points against the saga-ledger.`,
  `${SMALL_MARKERS[1]}: The Meridian account migration opening balance for the reconciliation was locked on the first business day of Q3.`,
  `${SMALL_MARKERS[2]}: Saga-ledger reconciliation for the Meridian migration flagged batch 3 for a manual settlement variance review.`,
  `${SMALL_MARKERS[3]}: Q3 Meridian migration transfer batches 1 through 5 cleared the saga-ledger settlement variance threshold cleanly.`,
];

// Backdated well beyond the 30-day recent window so these records surface ONLY
// via the currentTask-scored (task-relevant) path — the exact packing loop under
// test — never via the permanent/recent lifecycle sections.
const BACKDATED = new Date(Date.now() - 40 * 24 * 3600_000).toISOString();
const MAX_TOKENS = 2000;

describe("flair#1207 — content-selection budget must not drop the large on-task record (real Harper, real embeddings)", () => {
  beforeAll(async () => {
    harper = await startHarper();
    await registerAgent(harper, caller);
    await putMemory(harper, caller, `${caller.id}-large`, {
      agentId: caller.id, content: LARGE_BODY, durability: "standard", createdAt: BACKDATED,
    });
    for (let i = 0; i < SMALL_BODIES.length; i++) {
      await putMemory(harper, caller, `${caller.id}-small-${i}`, {
        agentId: caller.id, content: SMALL_BODIES[i], durability: "standard", createdAt: BACKDATED,
      });
    }
  }, 300_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  test("the large top-relevance record is INCLUDED at maxTokens where the 0.44.8 shrunk budget would drop it; every smaller record also fits", async () => {
    // Pre-flight: the sizing that makes this a real 0.44.8-vs-fixed differential.
    // The large record's 0.44.8 cost (est + 70 overhead) must exceed the 0.44.8
    // budget (maxTokens − reserve), while its est alone fits the fixed budget.
    const RESERVE = Math.min(600, Math.floor(MAX_TOKENS * 0.15)); // the removed #1199 reserve
    const largeLineEst = est(`📝 ${LARGE_BODY} (2026-07-06)`);   // ~ formatMemory's line
    expect(largeLineEst, `large est ${largeLineEst} must fit the fixed budget ${MAX_TOKENS}`).toBeLessThanOrEqual(MAX_TOKENS);
    expect(
      largeLineEst + 70,
      `large 0.44.8 cost (${largeLineEst}+70) must EXCEED the 0.44.8 budget ${MAX_TOKENS - RESERVE} (else the repro is not exercising the regression)`,
    ).toBeGreaterThan(MAX_TOKENS - RESERVE);

    const body = await bootstrap(harper, caller, { agentId: caller.id, maxTokens: MAX_TOKENS, currentTask: CURRENT_TASK });

    const contents: string[] = (body.memories ?? []).map((m: any) => m.content);
    const relevantContents = contents.filter((c) => c.includes("LEDGER-"));

    // The load-bearing assertion: the large, top-relevance record ships. Under
    // the 0.44.8 shrunk budget it was dropped; the fix (budget = maxTokens)
    // includes it. Reverting the fix fails HERE (mutation-check anchor).
    expect(
      relevantContents.some((c) => c.includes(LARGE_MARKER)),
      `the large on-task record must be INCLUDED — relevant contents: ${JSON.stringify(relevantContents.map((c) => c.slice(0, 40)))}`,
    ).toBe(true);

    // Count >= the pre-#1199 (0.44.6) behavior: at maxTokens=2000 all five
    // on-task records fit the restored budget (0.44.6 fit them too). 0.44.8's
    // shrunk budget dropped the large one → 4. So 5 proves no regression.
    expect(
      relevantContents.length,
      `all five on-task records must ship (0.44.6 parity) — got ${relevantContents.length}`,
    ).toBe(1 + SMALL_MARKERS.length);

    // Nothing was size-skipped: everything fit the restored budget. Under the
    // reverted (0.44.8) budget the large record is skipped and this becomes ≥ 1.
    expect(body.memoriesTruncated, "no relevant finding is size-skipped under the restored budget").toBe(0);

    // The cap contract holds: selected CONTENT stays within maxTokens even though
    // the honest tokenEstimate (structured scaffolding included) may exceed it.
    expect(
      body.soulTokens + body.memoryTokens,
      `selected content (${body.soulTokens}+${body.memoryTokens}) ≤ maxTokens ${MAX_TOKENS}`,
    ).toBeLessThanOrEqual(MAX_TOKENS);
  }, 120_000);

  // flair#1207 (Sherlock's self-describing-size-skip note) — a size-skip in the
  // score-ordered task-relevant loop is no longer silent. At a maxTokens too
  // small for the large record even at the restored budget, it is skipped for
  // size and that skip is REPORTED on `memoriesTruncated` (own denominator), so
  // a client can tell "a relevant finding didn't fit" from "no relevant finding".
  // In this store the ONLY path that can bump memoriesTruncated is the
  // task-relevant loop (no permanent/recent/predicted records), so this isolates
  // the counter added in #1207. Mutation check: dropping the `else
  // memoriesTruncated++` on the size-skip leaves this at 0 and the test fails.
  test("a task-relevant record skipped for size is REPORTED (memoriesTruncated), not silently dropped", async () => {
    const tight = 1000; // < the large record's ~1770-token line: it cannot fit
    const body = await bootstrap(harper, caller, { agentId: caller.id, maxTokens: tight, currentTask: CURRENT_TASK });
    const relevant = (body.memories ?? []).map((m: any) => m.content).filter((c: string) => c.includes("LEDGER-"));
    // The large record cannot fit → it is size-skipped, and the skip is surfaced.
    expect(relevant.some((c: string) => c.includes(LARGE_MARKER)), "the oversized large record does not fit this tight budget").toBe(false);
    expect(body.memoriesTruncated, "the size-skip is reported on memoriesTruncated, not silent").toBeGreaterThanOrEqual(1);
    // The separate teammate-denominator counter is always present (no teammates here).
    expect(typeof body.teammateFindingsTruncated, "teammateFindingsTruncated is always present").toBe("number");
  }, 120_000);
});
