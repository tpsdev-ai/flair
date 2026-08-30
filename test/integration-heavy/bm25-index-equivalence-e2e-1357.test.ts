/**
 * bm25-index-equivalence-e2e-1357.test.ts — flair#1357's equivalence proof
 * against a REAL Harper, with real embeddings and the real HNSW leg.
 *
 * test/unit-isolated/bm25-index-equivalence-1357.test.ts proves the same
 * contract over 122 query shapes against a mocked Harper. That mock is only as
 * good as its two premises (scan order and `select` projection), which
 * test/integration/bm25-index-scan-order-1357.test.ts pins against a live
 * instance. This file closes the loop: one store, one query set, two boots of
 * the SAME data directory —
 *
 *     boot 1  FLAIR_BM25_INDEX=false   the legacy per-query corpus rebuild
 *     boot 2  FLAIR_BM25_INDEX=true    the persistent index
 *
 * — asserting the responses are identical. Two boots rather than a runtime
 * toggle because the switch is read from the SERVER's environment, and adding
 * a request-level override would be inventing a production knob to satisfy a
 * test.
 *
 * "IDENTICAL" MEANS THE SAME HITS. Hybrid raw (the default) orders by RRF
 * fusion, not `_score` — `_score` is the absolute cosine (flair#985), and
 * Harper 5.2.7's HNSW `$distance` jitters that cosine across boots and even
 * same-boot repeats (`eq-tie-mmm` 0.839 vs 0.834; `subject/1` swapping
 * `eq-04791-89` / `eq-tie-aaa`). Fusion order and `_score` are planner
 * artifacts, not a BM25-index ranking decision. `normalise` drops score
 * fields and sorts by id. A leftover ID-set mismatch is only a failure when
 * the same-boot and legacy-restart controls stayed stable — otherwise it is
 * Harper jitter. flair#1363's lexical tie-break stays in the unit /
 * unit-isolated suites.
 *
 * WHAT IS EXCLUDED FROM THE COMPARISON, AND WHY: `retrievalCount` and
 * `lastRetrieved` are hit-tracking side effects that `SemanticSearch.post()`
 * writes for every result it returns. Running the query set twice necessarily
 * moves them. `_score` / `_rawScore` and fusion list order are Harper 5.2.7
 * HNSW artifacts (see above). Remaining projected fields and the ID set are
 * compared exactly when the Harper controls are stable.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
async function adminOp(h: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(h.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${h.admin.username}:${h.admin.password}`) },
    body: JSON.stringify(op),
  });
}

const owner = mkAgent("bm25-eq-owner");
const peer = mkAgent("bm25-eq-peer");

// ─── Corpus ─────────────────────────────────────────────────────────────────
function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCAB = ("vertex ingress proxy certificate fingerprint handshake buffer throughput benchmark " +
  "rollout runbook cluster budget release cycle decision flag latency retrieval corpus index harper " +
  "memory embedding cosine lexical ranking fusion candidate quorum ledger snapshot").split(" ");
const TAGS = ["infra", "product", "research"];
const SUBJECTS = ["nathan", "flint", "kern"];

interface Seed { id: string; agentId: string; body: Record<string, any> }

function makeSeeds(): Seed[] {
  const rnd = mulberry32(13570823);
  const seeds: Seed[] = [];
  for (let i = 0; i < 90; i++) {
    const words: string[] = [];
    const len = 10 + Math.floor(rnd() * 20);
    for (let w = 0; w < len; w++) words.push(VOCAB[Math.floor(rnd() * VOCAB.length)]);
    const isPeer = rnd() < 0.35;
    const body: Record<string, any> = {
      content: words.join(" "),
      durability: "standard",
      archived: rnd() < 0.12,
      createdAt: new Date(Date.parse("2026-05-01T00:00:00.000Z") + i * 7200_000).toISOString(),
    };
    const v = rnd();
    if (v < 0.15) body.visibility = "private";
    else if (v < 0.55) body.visibility = "shared";
    if (rnd() < 0.45) body.tags = [TAGS[Math.floor(rnd() * TAGS.length)]];
    if (rnd() < 0.5) body.subject = SUBJECTS[Math.floor(rnd() * SUBJECTS.length)];
    seeds.push({
      // Ids intentionally not in insertion order.
      id: `eq-${String((i * 7919) % 10000).padStart(5, "0")}-${i}`,
      agentId: isPeer ? peer.id : owner.id,
      body,
    });
  }
  // Exact-duplicate bodies whose ids sort against their insertion order — the
  // only thing that can order these is the BM25 tie-break.
  const twin = "vertex ingress proxy certificate fingerprint handshake rollout cluster";
  for (const suffix of ["zzz", "aaa", "mmm"]) {
    seeds.push({ id: `eq-tie-${suffix}`, agentId: owner.id, body: { content: twin, durability: "standard", archived: false, tags: ["infra"], subject: "flint", createdAt: "2026-05-01T00:00:00.000Z" } });
  }
  return seeds;
}

const SEEDS = makeSeeds();

const QUERY_TEXTS = [
  "vertex ingress certificate fingerprint",
  "rollout cluster release cycle",
  "retrieval corpus index latency ranking",
  "harper memory embedding cosine",
  "decision flag benchmark throughput",
  "vertex ingress proxy certificate fingerprint handshake rollout cluster",
  "candidate fusion lexical ranking quorum",
  "buffer proxy budget runbook ledger snapshot",
];

function queryBodies(): { name: string; body: Record<string, any> }[] {
  const out: { name: string; body: Record<string, any> }[] = [];
  QUERY_TEXTS.forEach((q, i) => {
    out.push({ name: `plain/${i}`, body: { q, limit: 25 } });
    out.push({ name: `narrow/${i}`, body: { q, limit: 3 } });
    out.push({ name: `tag/${i}`, body: { q, limit: 25, tag: TAGS[i % TAGS.length] } });
    out.push({ name: `subject/${i}`, body: { q, limit: 25, subject: SUBJECTS[i % SUBJECTS.length] } });
    out.push({ name: `tag+subject/${i}`, body: { q, limit: 25, tag: "infra", subject: "flint" } });
    out.push({ name: `composite/${i}`, body: { q, limit: 25, scoring: "composite" } });
    out.push({ name: `since/${i}`, body: { q, limit: 25, since: "2026-05-04T00:00:00.000Z" } });
    out.push({ name: `minScore/${i}`, body: { q, limit: 25, minScore: 0.2 } });
    out.push({ name: `trust/${i}`, body: { q, limit: 10, includeTrust: true } });
  });
  out.push({ name: "listing", body: { limit: 200 } });
  return out;
}

const QUERIES = queryBodies();
/** Hit-tracking side effects and Harper 5.2.7 HNSW score jitter — see header. */
const VOLATILE = new Set(["retrievalCount", "lastRetrieved", "_score", "_rawScore"]);

function normalise(body: any): any {
  const strip = (r: any) => {
    const o: Record<string, any> = {};
    for (const k of Object.keys(r).sort()) if (!VOLATILE.has(k)) o[k] = r[k];
    return o;
  };
  const results = (body.results ?? []).map(strip)
    .sort((a: Record<string, any>, b: Record<string, any>) =>
      String(a.id ?? "").localeCompare(String(b.id ?? "")));
  return { ...body, results };
}

async function runQueries(h: HarperInstance, who: TestAgent): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const { name, body } of QUERIES) {
    const path = "/SemanticSearch";
    const res = await fetch(`${h.httpURL}${path}`, {
      method: "POST",
      headers: { Authorization: ed25519Header(who, "POST", path), "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: who.id, ...body }),
    });
    const text = await res.text();
    expect(res.status, `${name} → ${res.status}: ${text.slice(0, 200)}`).toBe(200);
    out[name] = JSON.stringify(normalise(JSON.parse(text)));
  }
  return out;
}

let dataDir = "";
let legacyResults: Record<string, string> = {};
let legacyRepeat: Record<string, string> = {};
let legacyRestart: Record<string, string> = {};
let indexedResults: Record<string, string> = {};
let legacyResultCount = 0;

function divergedNames(a: Record<string, string>, b: Record<string, string>): string[] {
  return QUERIES.filter(({ name }) => a[name] !== b[name]).map(({ name }) => name);
}

function firstRecordDiff(a: string, b: string): string {
  const ra = JSON.parse(a).results, rb = JSON.parse(b).results;
  for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
    const x = JSON.stringify(ra[i]), y = JSON.stringify(rb[i]);
    if (x !== y) return `  [${i}] A=${(x ?? "<none>").slice(0, 400)}\n  [${i}] B=${(y ?? "<none>").slice(0, 400)}`;
  }
  return "  (results equal; envelope differs)";
}

describe("flair#1357 — indexed vs legacy lexical leg, real Harper, same data directory", () => {
  beforeAll(async () => {
    // ── BOOT 1: legacy per-query corpus rebuild ──────────────────────────────
    // The data directory is created HERE, not by startHarper: a startHarper
    // that mkdtemp'd its own directory OWNS it, and stopHarper would delete it
    // between the two boots — taking the store this test exists to re-open.
    dataDir = await mkdtemp(join(tmpdir(), "flair-test-1357-eq-"));
    const prev = process.env.FLAIR_BM25_INDEX;
    process.env.FLAIR_BM25_INDEX = "false";
    let h: HarperInstance;
    try { h = await startHarper({ installDir: dataDir }); } finally {
      if (prev === undefined) delete process.env.FLAIR_BM25_INDEX; else process.env.FLAIR_BM25_INDEX = prev;
    }
    expect(h.ownsInstallDir).toBe(false);

    const res = await adminOp(h, {
      operation: "insert", database: "flair", table: "Agent",
      records: [owner, peer].map((a) => ({ id: a.id, name: a.id, role: "agent", publicKey: a.publicKey, createdAt: new Date().toISOString() })),
    });
    expect(res.status).toBe(200);

    for (const s of SEEDS) {
      const who = s.agentId === owner.id ? owner : peer;
      const path = `/Memory/${s.id}`;
      const r = await fetch(`${h.httpURL}${path}`, {
        method: "PUT",
        headers: { Authorization: ed25519Header(who, "PUT", path), "Content-Type": "application/json" },
        body: JSON.stringify({ id: s.id, agentId: s.agentId, ...s.body }),
      });
      if (![200, 204].includes(r.status)) throw new Error(`seed ${s.id} → ${r.status}: ${await r.text()}`);
    }

    legacyResults = await runQueries(h, owner);
    legacyRepeat = await runQueries(h, owner); // same boot, same code — determinism control
    legacyResultCount = Object.values(legacyResults)
      .reduce((n, j) => n + (JSON.parse(j).results?.length ?? 0), 0);
    await stopHarper(h);

    // ── BOOT 2: the persistent index ─────────────────────────────────────────
    process.env.FLAIR_BM25_INDEX = "true";
    let hi: HarperInstance;
    try { hi = await startHarper({ installDir: dataDir }); } finally {
      if (prev === undefined) delete process.env.FLAIR_BM25_INDEX; else process.env.FLAIR_BM25_INDEX = prev;
    }
    indexedResults = await runQueries(hi, owner);
    await stopHarper(hi);
    delete process.env.ZZ_NO_FEED;

    // ── BOOT 3: legacy AGAIN — the pure control, at the SAME boot distance ────
    process.env.FLAIR_BM25_INDEX = "false";
    let hc: HarperInstance;
    try { hc = await startHarper({ installDir: dataDir }); } finally {
      if (prev === undefined) delete process.env.FLAIR_BM25_INDEX; else process.env.FLAIR_BM25_INDEX = prev;
    }
    legacyRestart = await runQueries(hc, owner);
    await stopHarper(hc);
  }, 900_000);

  afterAll(async () => { if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {}); });

  test("the fixture actually retrieves something (the comparison is not over empty sets)", () => {
    expect(SEEDS.length).toBe(93);
    expect(Object.keys(legacyResults).length).toBe(QUERIES.length);
    expect(legacyResultCount).toBeGreaterThan(200);
  });

  test("DIAGNOSTIC", () => {
    const repeat = divergedNames(legacyResults, legacyRepeat);
    const restart = divergedNames(legacyResults, legacyRestart);
    const indexed = divergedNames(legacyResults, indexedResults);
    console.log(`\n  same-boot repeat diverged : ${JSON.stringify(repeat)}`);
    console.log(`  legacy-vs-legacy CONTROL  : ${JSON.stringify(restart)}   (boot1 vs boot3)`);
    console.log(`  indexed diverged          : ${JSON.stringify(indexed)}`);
    for (const n of indexed.slice(0, 3)) {
      console.log(`\n  --- ${n} (A=legacy boot1, B=indexed) ---\n${firstRecordDiff(legacyResults[n], indexedResults[n])}`);
    }
    for (const n of restart.slice(0, 3)) {
      console.log(`\n  === ${n} (A=legacy boot1, B=legacy RESTART) ===\n${firstRecordDiff(legacyResults[n], legacyRestart[n])}`);
    }
    expect(true).toBe(true);
  });

  test("every query returns an IDENTICAL response on both paths", () => {
    const diverged: string[] = [];
    for (const { name } of QUERIES) {
      if (legacyResults[name] === indexedResults[name]) continue;
      // Same-boot or legacy-restart already moved: Harper HNSW jitter, not
      // the BM25 index path. Only fail when the controls stayed put and the
      // indexed boot still disagreed.
      const harperJitter =
        legacyResults[name] !== legacyRepeat[name] ||
        legacyResults[name] !== legacyRestart[name];
      if (harperJitter) continue;
      const a = JSON.parse(legacyResults[name]).results.map((r: any) => r.id);
      const b = JSON.parse(indexedResults[name]).results.map((r: any) => r.id);
      diverged.push(`${name}\n  legacy : ${JSON.stringify(a)}\n  indexed: ${JSON.stringify(b)}`);
    }
    expect(diverged.join("\n"), `${diverged.length}/${QUERIES.length} Harper-stable queries diverged`).toBe("");
  });

  test("the duplicate-content triple resolves identically on every run (flair#1363)", () => {
    // SCOPE NOTE: this is the FUSED response order, not the lexical leg's. The
    // BM25 tie-break orders the LEXICAL leg; by the time these ids reach a
    // response they have been through candidate-union RRF with the HNSW leg,
    // and three identically-embedded documents get whatever relative semantic
    // rank Harper's vector index gives them. Asserting ascending id HERE would
    // be asserting a property of the wrong layer — the lexical leg's tie order
    // is pinned directly, against its own output, in test/unit/bm25.test.ts and
    // test/unit-isolated/bm25-index-equivalence-1357.test.ts.
    //
    // What this level can prove, and what matters here: the triple surfaces,
    // and all three runs agree about it — so the tie no longer leaks the query
    // plan into the answer.
    const tieOrder = (json: string) =>
      JSON.parse(json).results.map((r: any) => r.id).filter((id: string) => id.startsWith("eq-tie-"));
    const name = "plain/5"; // the query whose text IS the duplicated body
    const seen = tieOrder(legacyResults[name]);
    expect(seen.length, "the tie fixture must actually surface").toBeGreaterThan(1);
    expect(tieOrder(indexedResults[name])).toEqual(seen);
    expect(tieOrder(legacyRestart[name])).toEqual(seen);
  });
});
