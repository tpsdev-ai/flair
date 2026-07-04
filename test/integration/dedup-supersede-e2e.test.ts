// dedup / supersede / memory_update e2e — real-Harper integration tests (ops-2gby).
//
// PR #553 fixed a memory-integrity bug (silent-write-loss on the dedup/
// supersede path) with: a cosine+lexical co-gate for dedup, a memory_update
// code path, and transactional supersede logic. That fix was proven at the
// UNIT level (test/unit/memory-integrity.test.ts) against a MOCKED Harper
// whose `getEmbedding()` is faked to return a constant vector (cosine is
// ALWAYS 1.0 in that file — only the REAL jaccard/lexical math is exercised
// for real). This file closes the gap: it spawns a REAL Harper (real
// embeddings model, real HNSW-backed cosine search) and drives the SAME
// resources/Memory.ts code paths through real signed HTTP requests, so any
// divergence between the mock's assumptions and real Harper's actual
// behavior (id semantics, PUT full-replace semantics, real embedding
// similarity, response shapes) would show up here even if the unit suite
// stays green.
//
// MODEL: test/integration/ed25519-auth-hnsw.test.ts (real embeddings / HNSW,
// signed writes trusted synchronously — no separate "wait for embedding
// ready" step; Memory.put() computes/awaits the embedding inline before
// returning) and test/integration/auth-middleware-e2e.test.ts (TPS-Ed25519
// signing helpers + admin-op seeding pattern).
//
// GOTCHA (load-bearing for every scenario below): resources/Memory.ts's own
// doc comments establish that the Memory schema only exposes HTTP PUT — a
// raw HTTP POST /Memory 404s with "Memory does not have a post method
// implemented". Memory.post() IS reachable, but only via an in-process
// resource instantiation (resources/mcp-tools.ts), never over real HTTP. So
// every write in this file is a signed HTTP PUT with an explicit id — which
// is also the MORE representative choice: Memory.ts's own comments note the
// real #526 field bug flowed through put(), not post().
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

// ─── Crypto / header helpers (same pattern as ed25519-auth-hnsw.test.ts /
//      auth-middleware-e2e.test.ts) ──────────────────────────────────────────

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

/**
 * Build a TPS-Ed25519 Authorization header. GOTCHA: the server verifies the
 * signature over `url.pathname + url.search`, so `path` must include the
 * query string for GET requests. GOTCHA: every request needs a fresh nonce.
 */
function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  const sigB64 = Buffer.from(sig).toString("base64");
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${sigB64}`;
}

/** Signed PUT to /Memory/<id> — the only HTTP-reachable create/update path. */
async function putMemory(harper: HarperInstance, agent: TestAgent, id: string, body: Record<string, any>): Promise<Response> {
  const path = `/Memory/${id}`;
  return fetch(`${harper.httpURL}${path}`, {
    method: "PUT",
    headers: { Authorization: ed25519Header(agent, "PUT", path), "Content-Type": "application/json" },
    body: JSON.stringify({ id, ...body }),
  });
}

/** Signed GET /Memory/<id>. */
async function getMemory(harper: HarperInstance, agent: TestAgent, id: string): Promise<Response> {
  const path = `/Memory/${id}`;
  return fetch(`${harper.httpURL}${path}`, {
    headers: { Authorization: ed25519Header(agent, "GET", path) },
  });
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

async function registerAgent(harper: HarperInstance, agent: TestAgent): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(res.status, `Agent insert for ${agent.id} returned ${res.status}`).toBe(200);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DISCOVERED BEHAVIORAL DIVERGENCE (real Harper vs. the mocked unit suite) —
 * ops-2gby's original reason for existing, RESOLVED by ops-ume4.
 *
 * test/unit/memory-integrity.test.ts's in-memory mock computes the cosine
 * "$distance" synchronously in plain JS (a real, always-populated number) for
 * every query. Real Harper's HNSW-backed `sort: {attribute:"embedding",
 * distance:"cosine"}` query, when combined with a `conditions` filter (e.g.
 * `agentId equals X` — exactly findConservativeDedupMatch's shape in
 * resources/Memory.ts), does NOT behave this way: when that query's
 * post-filter result set has exactly ONE matching record (a SINGLETON
 * candidate set — in practice, an agent's SECOND-ever memory compared
 * against its first), `$distance` comes back `undefined` for it — even for a
 * BYTE-IDENTICAL duplicate — regardless of how many prior queries have run
 * for that agentId or how long you wait. The moment a SECOND matching record
 * exists, `$distance` is populated correctly, even on the very first query
 * ever issued for that agentId. findConservativeDedupMatch previously
 * computed `const cosine = 1 - (top.$distance ?? 1)`, so the undefined
 * `$distance` silently resolved to `cosine = 0` — below any sane threshold —
 * meaning EVERY agent's very first near-duplicate comparison, ever, was
 * GUARANTEED to be flagged `deduplicated: false` regardless of true
 * similarity (ops-ume4).
 *
 * This was NOT the never-suppress write-safety invariant breaking — the
 * WRITE always landed. It was the `deduplicated` SIGNAL silently failing to
 * fire on literally the first opportunity it ever gets for a given agent,
 * which is exactly the shape of bug a synchronous, always-correct mock can
 * never surface.
 *
 * FIXED in resources/Memory.ts's findConservativeDedupMatch: when
 * `$distance` comes back undefined, it now fetches the one candidate's full
 * record by id (a plain point lookup, unaffected by the sort-query quirk
 * above) and computes cosine similarity itself in JS from the real stored
 * embedding vectors (dedup.ts's cosineSimilarity). No warm-up write is
 * needed any more — Scenario 2 below now asserts this directly on a
 * completely fresh agent's first-ever near-dup comparison. (The formerly-used
 * warmUpAgentDedupGate() workaround is removed — see git history for its
 * implementation if you need the pre-fix reproduction shape.)
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Secondary, separate concern from the cold-start bug above: even once the
 * co-gate is warmed up, a live probe showed a freshly-written record can
 * take a short (sub-second) while to become reachable via the SAME
 * HNSW-cosine query — an ordinary indexing-propagation window, not the
 * cold-start bug. findConservativeDedupMatch has no fallback for this
 * either (unlike SemanticSearch, which the 0.5.3 regression forced a
 * keyword-fallback onto for the identical class of lag — see
 * test/integration/concurrent-writes.test.ts's comment). This helper polls
 * SemanticSearch's `q`-based path — which exercises the IDENTICAL
 * `sort: {attribute:"embedding", distance:"cosine"}` query as
 * findConservativeDedupMatch (resources/SemanticSearch.ts) — until the
 * target id is indexed, so Scenario 2 asserts against a settled record
 * rather than a race.
 */
async function waitForSemanticallyIndexed(
  harper: HarperInstance,
  agent: TestAgent,
  targetId: string,
  queryText: string,
  { maxAttempts = 12, intervalMs = 750 }: { maxAttempts?: number; intervalMs?: number } = {},
): Promise<void> {
  const path = "/SemanticSearch";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "POST",
      headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: agent.id, q: queryText, limit: 10 }),
    });
    if (res.status === 200) {
      const body: any = await res.json();
      if (Array.isArray(body.results) && body.results.some((r: any) => r.id === targetId)) return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `waitForSemanticallyIndexed: ${targetId} never became cosine-searchable after ${maxAttempts * intervalMs}ms ` +
    `(HNSW indexing-lag exceeded the poll budget)`,
  );
}

// ─── Fixture text — SAME strings as test/unit/memory-integrity.test.ts's #526
// replay, deliberately, so the real-Harper result can be compared directly
// against what the mocked unit test asserts. In the unit file, cosine is
// mocked to a constant 1.0 and only jaccard/lexical is real; here BOTH sides
// of the co-gate are real (real embedding model, real HNSW cosine search).
const FINDING_A =
  "Federation replication direction is governed by a per-pair sends and receives knob in the pairing config.";
const FINDING_B_DISTINCT =
  "DDL and schema changes never replicate automatically across a federation pair; you must apply column additions manually on each spoke.";
const FINDING_A_REWORDED =
  "Federation replication direction is controlled by a per-pair sends/receives knob inside the pairing configuration.";

let harper: HarperInstance;

describe("dedup / supersede / memory_update e2e (real Harper, ops-2gby)", () => {
  beforeAll(async () => {
    harper = await startHarper();
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Scenario 1 — #526 replay: two topically-close but DISTINCT writes both
  // persist. Real embedding cosine for these two sentences (both about
  // federation "replication", substantively different facts) may or may not
  // be high, but jaccard/lexical overlap is low regardless — the co-gate
  // must not flag them, and even if it DID, the write must never be
  // suppressed. Both defaults (cosine 0.95 / lexical 0.5) are used — no
  // threshold override — to prove the gate behaves correctly out of the box.
  // ═══════════════════════════════════════════════════════════════════════
  test("Scenario 1 (#526): two topically-close but DISTINCT findings BOTH persist, neither dropped or merged", async () => {
    const agent = mkAgent(`dedup-distinct-${randomUUID()}`);
    await registerAgent(harper, agent);

    const idA = `${agent.id}-a`;
    const idB = `${agent.id}-b`;

    const resA = await putMemory(harper, agent, idA, { agentId: agent.id, content: FINDING_A, durability: "standard" });
    const textA = await resA.text();
    expect(resA.status, `PUT finding A returned ${resA.status}: ${textA.slice(0, 300)}`).toBe(200);
    const bodyA: any = JSON.parse(textA);
    expect(bodyA.written).toBe(true);
    expect(bodyA.id).toBe(idA);

    const resB = await putMemory(harper, agent, idB, { agentId: agent.id, content: FINDING_B_DISTINCT, durability: "standard" });
    const textB = await resB.text();
    expect(resB.status, `PUT finding B returned ${resB.status}: ${textB.slice(0, 300)}`).toBe(200);
    const bodyB: any = JSON.parse(textB);

    // THE regression: the second write must be written as its own record —
    // never silently dropped or merged into the first, no matter what the
    // real cosine similarity between the two sentences turns out to be.
    expect(bodyB.written).toBe(true);
    expect(bodyB.id).toBe(idB);
    expect(bodyB.id).not.toBe(bodyA.id);

    // Retrieve both back and assert both are present with DISTINCT content.
    const getA = await getMemory(harper, agent, idA);
    expect(getA.status).toBe(200);
    const recA: any = await getA.json();
    expect(recA.content).toBe(FINDING_A);

    const getB = await getMemory(harper, agent, idB);
    expect(getB.status).toBe(200);
    const recB: any = await getB.json();
    expect(recB.content).toBe(FINDING_B_DISTINCT);
  }, 60_000);

  // ═══════════════════════════════════════════════════════════════════════
  // Scenario 2 — never-silent-loss AND ops-ume4 regression guard: a true
  // near-duplicate is FLAGGED (deduplicated:true + matchedId) but STILL
  // written as a brand-new record with the reworded content intact (never
  // swapped for the old record's content). This agent's near-dup write below
  // is its SECOND memory ever (compared against its first, idOrig) — exactly
  // the singleton-candidate-set query ops-ume4 fixed (before the fix, this
  // exact shape was a GUARANTEED miss: `deduplicated:false` regardless of
  // true similarity, on every fresh agent's first near-dup comparison, with
  // no warm-up query able to change that). No warm-up write precedes this
  // one — that IS the regression proof: this test fails on pre-fix code.
  // Jaccard/lexical overlap between FINDING_A and
  // FINDING_A_REWORDED is real and high (same math the unit test pins
  // >= 0.5). The cosine side is exercised against the REAL embedding model —
  // dedupThreshold is passed as an explicit, permissive per-write tuning
  // hint (a first-class, client-supplied field per runDedupGate/Memory.ts)
  // so the assertion doesn't hinge on guessing the exact real-cosine value a
  // quantized embedding model produces for this specific paraphrase; what's
  // being proven is the REAL end-to-end mechanism (real embedding generation
  // + real HNSW cosine search + real jaccard) wired correctly, using the
  // exact knob production callers use to tune it.
  // ═══════════════════════════════════════════════════════════════════════
  test("Scenario 2 (ops-ume4): a FRESH agent's FIRST-EVER near-duplicate write is flagged deduplicated:true + matchedId, AND still written as a new record with the reworded content", async () => {
    const agent = mkAgent(`dedup-nearmatch-${randomUUID()}`);
    await registerAgent(harper, agent);

    const idOrig = `${agent.id}-orig`;
    const idReword = `${agent.id}-reword`;

    const resOrig = await putMemory(harper, agent, idOrig, { agentId: agent.id, content: FINDING_A, durability: "standard" });
    const textOrig = await resOrig.text();
    expect(resOrig.status, `PUT original returned ${resOrig.status}: ${textOrig.slice(0, 300)}`).toBe(200);
    const bodyOrig: any = JSON.parse(textOrig);
    expect(bodyOrig.written).toBe(true);

    // See waitForSemanticallyIndexed's doc comment: a live probe against
    // this harness showed findConservativeDedupMatch's cosine search can
    // miss a record written moments earlier (HNSW indexing-lag) — wait
    // until idOrig is actually reachable via the SAME cosine-sort query
    // before issuing the assertion-bearing write below.
    await waitForSemanticallyIndexed(harper, agent, idOrig, FINDING_A);

    const resReword = await putMemory(harper, agent, idReword, {
      agentId: agent.id,
      content: FINDING_A_REWORDED,
      durability: "standard",
      // Permissive cosine floor — the real cosine for this paraphrase must
      // still independently clear it; this only avoids over-fitting the
      // assertion to one embedding model's exact numeric output.
      dedupThreshold: 0.6,
      lexicalThreshold: 0.5,
    });
    const textReword = await resReword.text();
    expect(resReword.status, `PUT reworded returned ${resReword.status}: ${textReword.slice(0, 300)}`).toBe(200);
    const bodyReword: any = JSON.parse(textReword);

    console.log(`[dedup-supersede-e2e] Scenario 2 real matchConfidence: ${JSON.stringify(bodyReword.matchConfidence)}`);

    // Never-silent-loss: written regardless.
    expect(bodyReword.written).toBe(true);
    expect(bodyReword.id).toBe(idReword);

    // The collision signal fired against the REAL top-cosine candidate. Per
    // ops-ume4: this query's underlying result set is a SINGLETON (exactly
    // one candidate, idOrig) — the case where Harper's raw `$distance` field
    // itself is undefined BY DESIGN (that never changes; findConservativeDedupMatch's
    // fix doesn't make Harper populate it, it computes cosine itself from the
    // stored embedding vectors instead — see resources/Memory.ts's doc
    // comment). So the correct regression assertion here is NOT "$distance is
    // a real number" (it structurally isn't, for this exact query shape) —
    // it's that the SIGNAL this function computes (matchConfidence.cosine)
    // is a real, non-zero number reflecting genuine similarity (not the
    // pre-fix sentinel of exactly 0, which a real-but-undefined-$distance
    // forces via `1 - (undefined ?? 1)`).
    expect(bodyReword.deduplicated).toBe(true);
    expect(bodyReword.matchedId).toBe(idOrig);
    expect(typeof bodyReword.matchConfidence?.cosine).toBe("number");
    expect(bodyReword.matchConfidence.cosine).not.toBe(0);
    expect(bodyReword.matchConfidence.cosine).toBeGreaterThanOrEqual(0.6);
    expect(bodyReword.matchConfidence.lexical).toBeGreaterThanOrEqual(0.5);

    // Critical assertion: BOTH records now exist in the store — the flagged
    // write must NOT have been suppressed or swapped for the old content.
    const getOrig = await getMemory(harper, agent, idOrig);
    expect(getOrig.status).toBe(200);
    const recOrig: any = await getOrig.json();
    expect(recOrig.content).toBe(FINDING_A);

    const getReword = await getMemory(harper, agent, idReword);
    expect(getReword.status).toBe(200);
    const recReword: any = await getReword.json();
    // The new record's content is the REWORDED text — never overwritten to
    // match the old one.
    expect(recReword.content).toBe(FINDING_A_REWORDED);
    expect(recReword.content).not.toBe(FINDING_A);
  }, 90_000);

  // ═══════════════════════════════════════════════════════════════════════
  // Scenario 3 — #548 replay: memory_update's default (non-preserveHistory)
  // code path is a same-id overwrite: read the existing record, merge new
  // content on top (Harper PUT is full-record replacement — never send a
  // bare partial), clear the stale embedding fields so the server
  // regenerates them, PUT to the SAME id (resources/mcp-tools.ts's
  // memoryUpdate(); dedup-bypassed because Memory.put() sees a PRE-EXISTING
  // id, per resources/Memory.ts put()'s "content.id" branch). This
  // reimplements memoryUpdate()'s exact default-mode logic over the real
  // signed-HTTP surface (memoryUpdate() itself calls the Memory resource
  // in-process, not over HTTP — HTTP PUT is the real-world equivalent entry
  // point flair-client's MemoryApi.update() actually uses, and per Memory.ts
  // put()'s own doc comments, PUT is the only HTTP-reachable write route).
  // ═══════════════════════════════════════════════════════════════════════
  test("Scenario 3 (#548): memory_update same-id overwrite reflects NEW content — no stale read of the pre-update content", async () => {
    const agent = mkAgent(`memupdate-${randomUUID()}`);
    await registerAgent(harper, agent);

    const id = `${agent.id}-evolving`;
    const initialContent = "Deploy status: pending review (evolving state, long enough for the dedup gate).";
    const updatedContent = "Deploy status: shipped and verified in prod (evolving state, long enough for the dedup gate).";

    const resInitial = await putMemory(harper, agent, id, { agentId: agent.id, content: initialContent, durability: "standard" });
    const textInitial = await resInitial.text();
    expect(resInitial.status, `initial PUT returned ${resInitial.status}: ${textInitial.slice(0, 300)}`).toBe(200);
    const bodyInitial: any = JSON.parse(textInitial);
    expect(bodyInitial.written).toBe(true);

    // memory_update default mode: GET existing, merge new content on top,
    // strip the stale embedding so the server regenerates it, PUT to the
    // SAME id.
    const getExisting = await getMemory(harper, agent, id);
    expect(getExisting.status).toBe(200);
    const existing: any = await getExisting.json();
    expect(existing.content).toBe(initialContent);

    const merged: Record<string, any> = { ...existing, content: updatedContent, updatedAt: new Date().toISOString() };
    delete merged.embedding;
    delete merged.embeddingModel;

    const resUpdate = await putMemory(harper, agent, id, merged);
    const textUpdate = await resUpdate.text();
    expect(resUpdate.status, `memory_update PUT returned ${resUpdate.status}: ${textUpdate.slice(0, 300)}`).toBe(200);
    const bodyUpdate: any = JSON.parse(textUpdate);
    expect(bodyUpdate.written).toBe(true);
    expect(bodyUpdate.id).toBe(id);
    // Dedup-bypassed: the id already existed, so this is an intentional
    // overwrite, never flagged as a duplicate of itself/anything else.
    expect(bodyUpdate.deduplicated).toBe(false);

    // Reading back by the ORIGINAL id resolves to the CURRENT (updated)
    // content — never a stale read of the pre-update content (the #548 bug).
    const getAfter = await getMemory(harper, agent, id);
    expect(getAfter.status).toBe(200);
    const recAfter: any = await getAfter.json();
    expect(recAfter.content).toBe(updatedContent);
    expect(recAfter.content).not.toBe(initialContent);
    expect(recAfter.id).toBe(id);
  }, 60_000);

  // ═══════════════════════════════════════════════════════════════════════
  // Scenario 4 — supersede closes the old record + authorization boundary.
  // ═══════════════════════════════════════════════════════════════════════
  describe("Scenario 4: supersede closes the old record + cross-agent authorization boundary", () => {
    test("same-owner supersede: old record gets validTo set, new record exists, no grant required", async () => {
      const agent = mkAgent(`supersede-owner-${randomUUID()}`);
      await registerAgent(harper, agent);

      const idOld = `${agent.id}-v1`;
      const idNew = `${agent.id}-v2`;

      const resOld = await putMemory(harper, agent, idOld, {
        agentId: agent.id,
        content: "Original finding text, long enough for the dedup gate to consider.",
        durability: "standard",
      });
      expect(resOld.status).toBe(200);

      const resNew = await putMemory(harper, agent, idNew, {
        agentId: agent.id,
        content: "Updated finding text, long enough for the dedup gate to consider.",
        durability: "standard",
        supersedes: idOld,
      });
      const textNew = await resNew.text();
      expect(resNew.status, `supersede PUT returned ${resNew.status}: ${textNew.slice(0, 300)}`).toBe(200);
      const bodyNew: any = JSON.parse(textNew);
      expect(bodyNew.written).toBe(true);
      expect(bodyNew.id).toBe(idNew);

      // The OLD record is now closed (validTo set) — no longer open-ended.
      const getOld = await getMemory(harper, agent, idOld);
      expect(getOld.status).toBe(200);
      const recOld: any = await getOld.json();
      expect(recOld.validTo).toBeTruthy();

      // The NEW record exists as a fresh, independent write.
      const getNew = await getMemory(harper, agent, idNew);
      expect(getNew.status).toBe(200);
      const recNew: any = await getNew.json();
      expect(recNew.content).toBe("Updated finding text, long enough for the dedup gate to consider.");
      expect(recNew.supersedes).toBe(idOld);
    }, 60_000);

    test("cross-agent supersede with ONLY a read grant is DENIED (403) — write grant required", async () => {
      const owner = mkAgent(`supersede-cross-owner-${randomUUID()}`);
      const grantee = mkAgent(`supersede-cross-reader-${randomUUID()}`);
      await registerAgent(harper, owner);
      await registerAgent(harper, grantee);

      const idOld = `${owner.id}-v1`;
      const resOld = await putMemory(harper, owner, idOld, {
        agentId: owner.id,
        content: "Owner's original finding, long enough for the dedup gate to consider.",
        durability: "standard",
      });
      expect(resOld.status).toBe(200);

      // Provision the grantee with a READ-only MemoryGrant on the owner —
      // same seeding pattern as auth-middleware-e2e.test.ts's family
      // read-gate fixtures (direct admin-op insert).
      const grantId = `${owner.id}:${grantee.id}:read`;
      const grantRes = await adminOp(harper, {
        operation: "insert", database: "flair", table: "MemoryGrant",
        records: [{ id: grantId, ownerId: owner.id, granteeId: grantee.id, scope: "read", createdAt: new Date().toISOString() }],
      });
      expect(grantRes.status).toBe(200);

      const idAttempt = `${grantee.id}-attempt`;
      const resAttempt = await putMemory(harper, grantee, idAttempt, {
        agentId: grantee.id,
        content: "Cross-agent replacement content, long enough for the gate too.",
        durability: "standard",
        supersedes: idOld,
      });
      const textAttempt = await resAttempt.text();
      expect(resAttempt.status, `read-grant-only cross-agent supersede returned ${resAttempt.status}: ${textAttempt.slice(0, 300)}`).toBe(403);

      // The old record must remain untouched (still open-ended) — the
      // denied attempt must not have closed it.
      const getOld = await getMemory(harper, owner, idOld);
      expect(getOld.status).toBe(200);
      const recOld: any = await getOld.json();
      expect(recOld.validTo).toBeFalsy();
    }, 60_000);

    test("cross-agent supersede WITH a write grant succeeds and closes the old record", async () => {
      const owner = mkAgent(`supersede-cross-writer-owner-${randomUUID()}`);
      const grantee = mkAgent(`supersede-cross-writer-${randomUUID()}`);
      await registerAgent(harper, owner);
      await registerAgent(harper, grantee);

      const idOld = `${owner.id}-v1`;
      const resOld = await putMemory(harper, owner, idOld, {
        agentId: owner.id,
        content: "Owner's original finding, long enough for the dedup gate to consider.",
        durability: "standard",
      });
      expect(resOld.status).toBe(200);

      const grantId = `${owner.id}:${grantee.id}:write`;
      const grantRes = await adminOp(harper, {
        operation: "insert", database: "flair", table: "MemoryGrant",
        records: [{ id: grantId, ownerId: owner.id, granteeId: grantee.id, scope: "write", createdAt: new Date().toISOString() }],
      });
      expect(grantRes.status).toBe(200);

      const idNew = `${grantee.id}-v2`;
      const resNew = await putMemory(harper, grantee, idNew, {
        agentId: grantee.id,
        content: "Granted agent's replacement content, long enough for the gate too.",
        durability: "standard",
        supersedes: idOld,
      });
      const textNew = await resNew.text();
      expect(resNew.status, `write-granted cross-agent supersede returned ${resNew.status}: ${textNew.slice(0, 300)}`).toBe(200);
      const bodyNew: any = JSON.parse(textNew);
      expect(bodyNew.written).toBe(true);

      const getOld = await getMemory(harper, owner, idOld);
      expect(getOld.status).toBe(200);
      const recOld: any = await getOld.json();
      expect(recOld.validTo).toBeTruthy();
    }, 60_000);
  });
});
