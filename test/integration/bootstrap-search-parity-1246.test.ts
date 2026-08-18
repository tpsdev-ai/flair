// flair#1246 — bootstrap/search RANKING PARITY (real Harper, real embeddings).
//
// Bootstrap's teammate/task-relevant pass and memory_search now invoke the
// SAME retrieval core in the SAME mode (hybrid + q — one ranker, one scale).
// Before #1246, bootstrap forced `hybrid: false` (HNSW-only, an accident of
// early code): the two surfaces ranked the same store+query on DIFFERENT
// signals, so a record whose task-relevance is LEXICAL (exact task terms
// inside semantically-atypical prose) fused to rank 1 in search while
// bootstrap's pure-cosine ranking buried it under bland-generic noise — and
// at field scale (corpus >> candidatePoolK) dropped it from the K-bounded
// pool entirely. This test is the CI tripwire for any future re-divergence of
// the two retrieval paths (the issue's original ask).
//
// FIXTURE — the measurement's v5 "max dilution" shape (6-variant measurement
// on the shipped nomic model, ephemeral instance @ 39120e58): ONE on-task
// record carrying the exact task terms once, buried in long unrelated prose,
// plus a 20-record bland-generic noise cluster. Measured at this exact shape
// (N=21): on-task cosine 0.5656 vs noise max 0.6086 → HNSW-only rank 6 under
// five noise records; BM25 rank 1 (score 6.485 vs noise max 2.946) → fused
// rank 1. So:
//
//   hybrid+q (post-#1246):  bootstrap teammate pick #1 == search result #1
//                           == the on-task record  → this test PASSES.
//   hybrid:false (mutation): search still fuses on-task to rank 1, but
//                           bootstrap's teammate list leads with bland noise
//                           (on-task sinks to ~rank 6) → the rank-1 parity
//                           assertions FAIL. Verified both directions when
//                           this landed.
//
// N=21 deliberately does NOT truncate the candidate pool (candidatePoolK >=
// MIN_CANDIDATE_POOL=50), so plain membership can't be the tripwire here —
// the fused-rank-1 vs HNSW-rank-~6 DIVERGENCE is (per the measurement, the
// pool-exclusion form of the same inversion needs corpus >> K, too slow for
// CI). Membership is still asserted for the issue's literal "present in
// both" parity ask.
//
// MODEL-GATED like recall-eval-gate.test.ts: skips VISIBLY when the
// embedding model isn't present rather than triggering a HuggingFace pull
// mid-suite. The integration lane pre-downloads the model, so the gate fires
// in CI.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

const MODEL_FILE = "nomic-embed-text-v1.5.Q4_K_M.gguf";
function modelPresent(): boolean {
  const dirs = [process.env.FLAIR_MODELS_DIR, path.join(process.cwd(), "models")].filter(Boolean) as string[];
  return dirs.some((d) => existsSync(path.join(d, MODEL_FILE)));
}
const HAS_MODEL = modelPresent();
const gate = HAS_MODEL ? describe : describe.skip;
if (!HAS_MODEL) {
  console.warn(`[bootstrap-search-parity-1246] SKIPPING: embedding model ${MODEL_FILE} not found in FLAIR_MODELS_DIR or <cwd>/models.`);
}

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

function ed25519Header(agent: TestAgent, method: string, urlPath: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${urlPath}`;
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

/** Signed PUT to /Memory/<id> — the real write path, so the embedding is
 *  generated for real (Memory.ts put() → getEmbedding()), never synthesized. */
async function putMemory(harper: HarperInstance, agent: TestAgent, id: string, body: Record<string, any>): Promise<void> {
  const urlPath = `/Memory/${id}`;
  const res = await fetch(`${harper.httpURL}${urlPath}`, {
    method: "PUT",
    headers: { Authorization: ed25519Header(agent, "PUT", urlPath), "Content-Type": "application/json" },
    body: JSON.stringify({ id, ...body }),
  });
  if (![200, 204].includes(res.status)) {
    throw new Error(`seed PUT ${id} → ${res.status}: ${await res.text()}`);
  }
}

async function post(harper: HarperInstance, agent: TestAgent, urlPath: string, body: Record<string, any>): Promise<any> {
  const res = await fetch(`${harper.httpURL}${urlPath}`, {
    method: "POST",
    headers: { Authorization: ed25519Header(agent, "POST", urlPath), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  expect(res.status, `${urlPath} → ${res.status}: ${text.slice(0, 500)}`).toBe(200);
  return JSON.parse(text);
}

// ── The v5 "max dilution" fixture (verbatim from the #1246 measurement) ──────
// The SAME string is bootstrap's currentTask AND search's q — parity is only
// meaningful on an identical store+query.
const CURRENT_TASK =
  "Pick up the connector-chronicle work: the conformance fixture parity eval needs to pass " +
  "before we can cut the release candidate this week";

// On-task: the exact task terms appear ONCE, buried in long unrelated prose —
// lexically decisive (BM25 rank 1), semantically atypical (cosine BELOW the
// bland noise cluster's best: 0.5656 vs 0.6086 measured).
const ONTASK_CONTENT =
  "Long weekend at the coast. The tide charts were wrong twice, so the kayaks went out late " +
  "and came back later. Drove the ridge road with the windows down, stopped for peaches at " +
  "the farm stand, argued amiably about whether the lighthouse is older than the pier. " +
  "Somewhere in the glovebox is a napkin where I scrawled connector-chronicle conformance " +
  "fixture parity eval so I would not forget it before Monday. The cottage stove smokes when " +
  "the wind turns east, the board games are missing half their pieces, and the neighbor's dog " +
  "adopted us for the duration. Sunburn on the left arm only, from trolling the dinghy. The " +
  "drive home took four hours with the roadwork detour past the quarry.";

// Bland-generic work prose — the kind that wins weak-pool cosine (measured
// 0.44–0.63 against this task) while sharing no distinctive task term.
const NOISE: string[] = [
  "Team sync notes: reviewed the sprint board, moved two cards to done, and flagged the onboarding doc for a refresh.",
  "Updated the status dashboard with the latest migration progress and pinged the group about the weekly demo.",
  "Wrote up the retro summary: what went well, what to improve, and the action items we agreed on.",
  "Checked in with the design crew about the new landing page copy and the button color debate.",
  "Backlog grooming: closed stale tickets, merged duplicates, and re-prioritized the top of the queue.",
  "Drafted the quarterly roadmap slide and shared it in the planning channel for comments.",
  "Quick fix landed for the flaky nightly job; also tidied the runbook while I was in there.",
  "Standup recap: blocked on the vendor response, otherwise steady progress across the board.",
  "Documented the deploy checklist and added a section about rollback steps for the ops folks.",
  "Paired with a teammate on the analytics report and cleaned up the spreadsheet formulas.",
  "Migration status: three services moved over, two remaining, no incidents reported this week.",
  "Collected feedback from the beta group and summarized the top requests for the product huddle.",
  "Refreshed the internal wiki homepage and archived the outdated meeting notes from last quarter.",
  "Budget review prep: pulled the invoice totals and drafted talking points for the finance sync.",
  "Interview loop debrief written up and shared with the hiring committee for tomorrow's decision.",
  "Set up the new monitoring alert thresholds and confirmed the on-call rotation for next month.",
  "Customer call summary: they like the new flow, asked about export options and pricing tiers.",
  "Cleaned up the shared drive folders and standardized the naming for the project archives.",
  "Weekly metrics roundup posted: signups steady, churn slightly down, support queue healthy.",
  "Offsite logistics: confirmed the venue, collected dietary notes, and drafted the agenda.",
];

let harper: HarperInstance;
const teammate = mkAgent(`t1246-teammate-${randomUUID()}`);
const reader = mkAgent(`t1246-reader-${randomUUID()}`);
const ONTASK_ID = `${teammate.id}-ontask`;
const noiseId = (i: number) => `${teammate.id}-noise-${String(i + 1).padStart(2, "0")}`;

// Backdated so nothing rides a recency window (teammate records never enter
// the reader's own-context sections anyway; this keeps the fixture inert to
// future recency-window changes).
const BACKDATED = new Date(Date.now() - 40 * 24 * 3600_000).toISOString();

gate("flair#1246 — bootstrap teammate ranking agrees with memory_search (one ranker, one scale)", () => {
  beforeAll(async () => {
    harper = await startHarper();
    await registerAgent(harper, teammate);
    await registerAgent(harper, reader);
    await putMemory(harper, teammate, ONTASK_ID, {
      agentId: teammate.id, content: ONTASK_CONTENT, durability: "standard", visibility: "shared", createdAt: BACKDATED,
    });
    for (let i = 0; i < NOISE.length; i++) {
      await putMemory(harper, teammate, noiseId(i), {
        agentId: teammate.id, content: NOISE[i], durability: "standard", visibility: "shared", createdAt: BACKDATED,
      });
    }
  }, 300_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  test("the on-task record is search's top result AND bootstrap's top teammate pick — and the two picks agree", async () => {
    // ── Search half: the fused ranking is the reference ranker. ──
    const search = await post(harper, reader, "/SemanticSearch", {
      agentId: reader.id, q: CURRENT_TASK, limit: 10, scoring: "raw",
    });
    const searchIds: string[] = (search.results ?? []).map((r: any) => r.id);
    expect(searchIds.length, `search returned no results: ${JSON.stringify(search).slice(0, 300)}`).toBeGreaterThan(0);
    // Present in search (the issue's literal parity ask) ...
    expect(searchIds, "on-task record missing from search results entirely").toContain(ONTASK_ID);
    // ... and fused to rank 1 (BM25 rank-1 rescue; measured fused rank 1 at
    // this exact fixture shape).
    expect(searchIds[0], `search top result was ${searchIds[0]} — fused ranking should put the lexically-decisive on-task record first`).toBe(ONTASK_ID);

    // ── Bootstrap half: the SAME store + query through the teammate pass. ──
    const boot = await post(harper, reader, "/BootstrapMemories", {
      agentId: reader.id, maxTokens: 16000, currentTask: CURRENT_TASK,
    });
    const findings: any[] = boot.teammateFindings ?? [];
    const findingIds: string[] = findings.map((f: any) => f.id);
    expect(findingIds.length, `no teammateFindings at all — hint: ${boot.teammateFindingsHint ?? "none"}`).toBeGreaterThan(0);

    // Present in bootstrap's teammate picks (parity: present in BOTH) ...
    expect(findingIds, "on-task record missing from bootstrap's teammate findings — bootstrap's ranking diverged from search").toContain(ONTASK_ID);

    // ... and the TOP pick (fused rank 1). THIS is the mutation tripwire:
    // under hybrid:false the teammate list leads with bland noise (on-task
    // measured at HNSW rank 6 in this exact fixture) while search still
    // fuses it to rank 1 — membership alone stays green at N=21 because the
    // candidate pool never truncates, but the top pick flips.
    expect(findingIds[0], `bootstrap's top teammate pick was ${findingIds[0]} — the two retrieval surfaces rank the same store+query differently`).toBe(ONTASK_ID);

    // The parity statement itself: bootstrap's #1 teammate pick IS search's
    // #1 result. Stated independently of ONTASK_ID so a future fixture edit
    // can't quietly turn this into two unrelated pins.
    expect(findingIds[0], "bootstrap's top teammate pick and search's top result disagree").toBe(searchIds[0]);

    // #1199 count contract holds with no relevance floor (flair#1246):
    // matched == included + truncated ("matched" = entered the scored pool).
    expect(boot.teammateFindingsIncluded + boot.teammateFindingsTruncated).toBe(boot.teammateFindingsMatched);
  }, 120_000);
});
