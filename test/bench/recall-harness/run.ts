#!/usr/bin/env bun
/**
 * recall-harness/run.ts — ISOLATED recall-eval harness.
 *
 * WHY: the two existing recall tools both have a gap this closes.
 *   - ops/tools/agent-fabric/recall-eval.mjs measures against flint's LIVE
 *     production memory corpus over the network. It only runs ON the live
 *     server, mutates it (retrievalCount bumps on every query), and its
 *     ground truth rots as that corpus changes day to day — there is no way
 *     to safely try a scoring/retrieval change without touching production.
 *   - ops/tools/agent-fabric/recall-bench.mjs IS isolated (seeds a synthetic
 *     corpus, measures, tears down) but its corpus is 4 maximally-distant
 *     topic clusters — a "flattering upper bound" that caps p@3 at 1.0 and
 *     can't discriminate between a config that helps and one that hurts.
 *
 * This harness is isolated (spawns an EPHEMERAL Harper via
 * test/helpers/harper-lifecycle.ts — zero contact with the live :9926
 * service or ~/ops/flair) AND uses a harder, representative corpus
 * (./corpus.ts — near-duplicate clusters, lexical-overlap traps, varied
 * durability/recency) that can actually discriminate. It reproduces, in
 * isolation, the exact finding that flair#623 (commit 624299c, 2026-07-08)
 * made by measuring the LIVE corpus: scoring="composite" measurably
 * underperforms scoring="raw" once BM25 hybrid retrieval is active, because
 * compositeScore's durability-weight × recency-decay multiplier
 * (resources/scoring.ts) applies unconditionally and can invert a ranking
 * the raw semantic/BM25 score got right.
 *
 * WHAT IT MEASURES: for each (hybrid, rerank) config it spawns ONE ephemeral
 * Harper, seeds ./corpus.ts's CORPUS, and against that SAME seeded instance
 * runs every query in QUERIES under BOTH scoring="raw" and
 * scoring="composite" — reporting precision@3 and MRR for each, overall and
 * broken out by query "kind" (stress/trap/hard/clean — see corpus.ts). This
 * repeats `--runs` times (fresh spawn+seed+teardown each time, for
 * independence — HNSW graph construction and embedding-engine warmup both
 * introduce run-to-run noise) and aggregates as mean ± standard error.
 *
 * SAFETY: every Harper instance is a fresh `mkdtemp` ROOTPATH/HOME
 * (test/helpers/harper-lifecycle.ts), bound to OS-assigned free ports, and
 * killed + removed at the end of each run. This script never imports, reads
 * from, or writes to ~/ops/flair or any live Flair service. FLAIR_MODELS_DIR
 * may be pointed at an EXISTING flair install's models/ directory (read-only
 * — just the GGUF weight files) to skip re-downloading the embedding model;
 * see README.md.
 *
 * USAGE:
 *   bun run test/bench/recall-harness/run.ts                  # full sweep: hybrid on+off, 3 runs each
 *   bun run test/bench/recall-harness/run.ts --runs 1          # quick single-run pass (less trustworthy)
 *   bun run test/bench/recall-harness/run.ts --hybrid on        # only the production-default config
 *   bun run test/bench/recall-harness/run.ts --hybrid on --rerank  # also spawn a hybrid+rerank config
 *   bun run test/bench/recall-harness/run.ts --verbose          # print every query's rank, not just aggregates
 *   bun run test/bench/recall-harness/run.ts --keep-on-fail     # leave a failed run's Harper installDir on disk
 *
 * Reads nothing from the network except what Harper itself needs (model
 * files from FLAIR_MODELS_DIR or a HuggingFace download on first use).
 */
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../../helpers/harper-lifecycle";
import { CORPUS, QUERIES, type QueryKind, type CorpusRecord } from "./corpus";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const AGENT_ID = "recall-harness-corpus";

// Harper loads compiled resources per config.yaml's `jsResource: files:
// dist/resources/*.js` — NOT the TypeScript source directly. dist/ is
// gitignored build output, so a fresh worktree/clone has none until built.
// Without this check, every request 404s with a bare "Not found" body and
// the real cause (stale or missing build) is easy to misread as an auth or
// routing bug.
function assertBuilt(): void {
  const marker = path.join(REPO_ROOT, "dist", "resources", "SemanticSearch.js");
  if (!existsSync(marker)) {
    console.error(`FATAL: ${marker} not found. Harper serves resources from dist/, not TypeScript source.`);
    console.error(`Run \`npm run build\` (or \`bun run build\`) in ${REPO_ROOT} first, then re-run this harness.`);
    process.exit(2);
  }
}

// ─── CLI args ────────────────────────────────────────────────────────────────
function argVal(flag: string, dflt: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const RUNS = Math.max(1, parseInt(argVal("--runs", "3"), 10) || 3);
const HYBRID_ARG = argVal("--hybrid", "both"); // "both" | "on" | "off"
const WITH_RERANK = process.argv.includes("--rerank");
const VERBOSE = process.argv.includes("--verbose");
const KEEP_ON_FAIL = process.argv.includes("--keep-on-fail");
const SEARCH_LIMIT = 20; // candidateLimit = limit*5 = 100 > CORPUS.length(87) → full HNSW coverage
// flair#683: run ONLY the usage-injection rematch (see "USAGE-FEEDBACK
// REMATCH" section below) instead of the base composite-vs-raw sweep above.
const USAGE_REMATCH = process.argv.includes("--usage-rematch");

const hybridValues: boolean[] = HYBRID_ARG === "on" ? [true] : HYBRID_ARG === "off" ? [false] : [true, false];

// ─── Ed25519 TPS-signed fetch (same pattern as test/integration's own suite) ─
interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }
function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}
function ed25519Header(agent: TestAgent, method: string, p: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${p}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}
async function signedFetch(harper: HarperInstance, agent: TestAgent, method: string, p: string, body?: unknown): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(`${harper.httpURL}${p}`, {
    method,
    headers: { Authorization: ed25519Header(agent, method, p), "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { ok: res.ok, status: res.status, body: parsed };
}
async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64") },
    body: JSON.stringify(op),
  });
}

// ─── Seeding ─────────────────────────────────────────────────────────────────
const idFor = (marker: string) => `${AGENT_ID}-${marker.replace(/::/g, "-")}`;

async function registerAgent(harper: HarperInstance, agent: TestAgent): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, kind: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  if (!res.ok) throw new Error(`registerAgent: HTTP ${res.status} ${await res.text().catch(() => "")}`);
}

async function seedRecord(harper: HarperInstance, agent: TestAgent, rec: CorpusRecord): Promise<void> {
  const id = idFor(rec.marker);
  const createdAt = new Date(Date.now() - rec.ageDays * 24 * 3600_000).toISOString();
  const path = `/Memory/${id}`;
  const res = await signedFetch(harper, agent, "PUT", path, {
    id, agentId: agent.id, content: rec.text, durability: rec.durability, createdAt,
  });
  if (!res.ok) throw new Error(`seed ${rec.marker} (${id}) failed: HTTP ${res.status} ${JSON.stringify(res.body ?? null).slice(0, 500)}`);
}

// Batched concurrency — enough to cut wall time without hammering a
// THREADS_COUNT=1 ephemeral instance.
async function seedCorpus(harper: HarperInstance, agent: TestAgent): Promise<void> {
  const BATCH = 6;
  for (let i = 0; i < CORPUS.length; i += BATCH) {
    await Promise.all(CORPUS.slice(i, i + BATCH).map(rec => seedRecord(harper, agent, rec)));
  }
}

// Canary poll: confirm the corpus is actually semantically searchable (not
// just written) before measuring. Memory.put() awaits embedding generation
// before responding, but poll anyway — HNSW index visibility has a
// documented async lag in this codebase (see recall-bench.mjs's own
// waitUntilSearchable). Uses one real ground-truth pair as the canary.
async function waitSearchable(harper: HarperInstance, agent: TestAgent, timeoutMs = 45_000): Promise<void> {
  const canary = QUERIES[0];
  const expectId = idFor(canary.expectMarker);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await signedFetch(harper, agent, "POST", "/SemanticSearch", { agentId: agent.id, q: canary.q, limit: 10, scoring: "raw" });
    if (res.ok && Array.isArray(res.body?.results) && res.body.results.some((r: any) => r.id === expectId)) return;
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error(`waitSearchable: canary query never surfaced ${expectId} within ${timeoutMs}ms (embedding engine slow/down?)`);
}

// ─── Measurement ─────────────────────────────────────────────────────────────
interface QueryRow { q: string; kind: QueryKind; expectMarker: string; rank: number /* 0-based, -1 = not found */ }
interface KindStats { p3: number; mrr: number; n: number }
interface ScoringResult { scoring: "raw" | "composite"; p3: number; mrr: number; n: number; byKind: Record<QueryKind, KindStats>; rows: QueryRow[] }

function statsFor(rows: QueryRow[]): { p3: number; mrr: number; n: number } {
  if (!rows.length) return { p3: 0, mrr: 0, n: 0 };
  const hits3 = rows.filter(r => r.rank >= 0 && r.rank < 3).length;
  const rr = rows.reduce((s, r) => s + (r.rank >= 0 ? 1 / (r.rank + 1) : 0), 0);
  return { p3: hits3 / rows.length, mrr: rr / rows.length, n: rows.length };
}

async function runQueries(harper: HarperInstance, agent: TestAgent, scoring: "raw" | "composite"): Promise<ScoringResult> {
  const rows: QueryRow[] = [];
  for (const { q, expectMarker, kind } of QUERIES) {
    const expectId = idFor(expectMarker);
    const res = await signedFetch(harper, agent, "POST", "/SemanticSearch", { agentId: agent.id, q, limit: SEARCH_LIMIT, scoring });
    if (!res.ok) throw new Error(`search failed (scoring=${scoring}) for "${q}": HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
    const ids: string[] = (res.body.results || []).map((r: any) => r.id);
    const rank = ids.indexOf(expectId);
    rows.push({ q, kind, expectMarker, rank });
  }
  const overall = statsFor(rows);
  const kinds: QueryKind[] = ["stress", "trap", "hard", "clean"];
  const byKind = Object.fromEntries(kinds.map(k => [k, statsFor(rows.filter(r => r.kind === k))])) as Record<QueryKind, KindStats>;
  return { scoring, ...overall, byKind, rows };
}

// One independent (spawn → register → seed → wait → measure[raw,composite] →
// teardown) cycle for a given (hybrid, rerank) config.
async function runOnce(hybrid: boolean, rerank: boolean, runIdx: number, totalRuns: number): Promise<{ raw: ScoringResult; composite: ScoringResult }> {
  const label = `[hybrid=${hybrid} rerank=${rerank} run ${runIdx}/${totalRuns}]`;
  const prevHybrid = process.env.FLAIR_HYBRID_RETRIEVAL;
  const prevRerank = process.env.FLAIR_RERANK_ENABLED;
  process.env.FLAIR_HYBRID_RETRIEVAL = hybrid ? "true" : "false";
  if (rerank) process.env.FLAIR_RERANK_ENABLED = "true"; else delete process.env.FLAIR_RERANK_ENABLED;

  let harper: HarperInstance | undefined;
  try {
    console.log(`${label} spawning ephemeral Harper...`);
    harper = await startHarper({ cwd: REPO_ROOT, harperBinDir: REPO_ROOT });
    console.log(`${label} up at ${harper.httpURL} (installDir=${harper.installDir})`);

    const agent = mkAgent(AGENT_ID);
    await registerAgent(harper, agent);
    console.log(`${label} seeding ${CORPUS.length} records...`);
    await seedCorpus(harper, agent);
    await waitSearchable(harper, agent);
    console.log(`${label} corpus searchable, measuring ${QUERIES.length} queries × 2 scoring modes...`);

    // raw FIRST, then composite, against the SAME seeded instance — matches
    // recall-eval.mjs's own convention. CAVEAT (same as recall-eval.mjs):
    // SemanticSearch bumps retrievalCount on every returned doc regardless of
    // scoring mode, so the composite pass's retrievalBoost is very slightly
    // influenced by docs the raw pass already surfaced. Bounded to +10%
    // (RBOOST_CAP) and gated by RBOOST_RELEVANCE_FLOOR — small next to the
    // durability/recency effect this harness targets, but worth naming.
    const raw = await runQueries(harper, agent, "raw");
    const composite = await runQueries(harper, agent, "composite");
    return { raw, composite };
  } finally {
    if (harper) await stopHarper(harper, { keepInstallDir: false });
    if (prevHybrid === undefined) delete process.env.FLAIR_HYBRID_RETRIEVAL; else process.env.FLAIR_HYBRID_RETRIEVAL = prevHybrid;
    if (prevRerank === undefined) delete process.env.FLAIR_RERANK_ENABLED; else process.env.FLAIR_RERANK_ENABLED = prevRerank;
  }
}

// ─── Aggregation: mean ± standard error over repeated runs ──────────────────
function aggStats(vals: number[]): { mean: number; se: number | null } {
  const mean = vals.reduce((s, x) => s + x, 0) / vals.length;
  if (vals.length < 2) return { mean, se: null };
  const variance = vals.reduce((s, x) => s + (x - mean) ** 2, 0) / (vals.length - 1);
  return { mean, se: Math.sqrt(variance) / Math.sqrt(vals.length) };
}
const fmt = (x: number, d = 3) => x.toFixed(d);
const fmtAgg = (a: { mean: number; se: number | null }, d = 3) => a.se != null ? `${fmt(a.mean, d)} ± ${fmt(a.se, d)}` : fmt(a.mean, d);

async function main() {
  assertBuilt();
  console.log(`recall-harness — ISOLATED recall eval (corpus=${CORPUS.length} records, queries=${QUERIES.length})`);
  console.log(`config: runs=${RUNS} hybrid=${hybridValues.join(",")} rerank=${WITH_RERANK ? "on(hybrid=true only)+off" : "off"}\n`);
  if (process.env.FLAIR_MODELS_DIR) console.log(`FLAIR_MODELS_DIR=${process.env.FLAIR_MODELS_DIR} (reusing pre-downloaded models)\n`);

  // Build the (hybrid, rerank) config list. rerank is opt-in and only ever
  // tested alongside hybrid=true (the production-default combination) — a
  // full 2×2×2 sweep triples runtime for a knob this PR's validation doesn't
  // depend on; see README for how to run a fuller sweep manually.
  const configs: { hybrid: boolean; rerank: boolean }[] = hybridValues.map(h => ({ hybrid: h, rerank: false }));
  if (WITH_RERANK && hybridValues.includes(true)) configs.push({ hybrid: true, rerank: true });

  type Agg = { p3: number[]; mrr: number[]; byKind: Record<QueryKind, { p3: number[]; mrr: number[] }> };
  const emptyAgg = (): Agg => ({ p3: [], mrr: [], byKind: { stress: { p3: [], mrr: [] }, trap: { p3: [], mrr: [] }, hard: { p3: [], mrr: [] }, clean: { p3: [], mrr: [] } } });

  const results: Record<string, { raw: Agg; composite: Agg }> = {};

  for (const cfg of configs) {
    const key = `hybrid=${cfg.hybrid} rerank=${cfg.rerank}`;
    results[key] = { raw: emptyAgg(), composite: emptyAgg() };
    for (let i = 1; i <= RUNS; i++) {
      const { raw, composite } = await runOnce(cfg.hybrid, cfg.rerank, i, RUNS);
      for (const [scoring, res] of [["raw", raw], ["composite", composite]] as const) {
        const agg = results[key][scoring];
        agg.p3.push(res.p3); agg.mrr.push(res.mrr);
        for (const k of Object.keys(res.byKind) as QueryKind[]) {
          agg.byKind[k].p3.push(res.byKind[k].p3);
          agg.byKind[k].mrr.push(res.byKind[k].mrr);
        }
        console.log(`  run ${i}/${RUNS} [${key}] scoring=${scoring}: p@3=${fmt(res.p3, 3)} MRR=${fmt(res.mrr, 3)}`);
        if (VERBOSE) {
          for (const row of res.rows) {
            const status = row.rank < 0 ? "MISS" : row.rank < 3 ? "HIT " : "meh ";
            console.log(`      ${status} rank=${row.rank < 0 ? ">k" : row.rank + 1}  [${row.kind}]  expect=${row.expectMarker}  q="${row.q.slice(0, 60)}"`);
          }
        }
      }
    }
  }

  // ── Report ──────────────────────────────────────────────────────────────
  console.log(`\n══ AGGREGATE (mean ± SE over ${RUNS} run${RUNS > 1 ? "s" : ""}) ══\n`);
  for (const cfg of configs) {
    const key = `hybrid=${cfg.hybrid} rerank=${cfg.rerank}`;
    console.log(`── ${key} ──`);
    for (const scoring of ["raw", "composite"] as const) {
      const agg = results[key][scoring];
      const p3 = aggStats(agg.p3), mrr = aggStats(agg.mrr);
      console.log(`  scoring=${scoring.padEnd(9)} p@3=${fmtAgg(p3)}   MRR=${fmtAgg(mrr)}`);
    }
    const rawP3 = aggStats(results[key].raw.p3), compP3 = aggStats(results[key].composite.p3);
    const rawMrr = aggStats(results[key].raw.mrr), compMrr = aggStats(results[key].composite.mrr);
    const dP3 = compP3.mean - rawP3.mean, dMrr = compMrr.mean - rawMrr.mean;
    console.log(`  Δ (composite − raw)   p@3=${dP3 >= 0 ? "+" : ""}${fmt(dP3)}   MRR=${dMrr >= 0 ? "+" : ""}${fmt(dMrr)}`);
    console.log(`  by kind (composite − raw p@3):`);
    for (const k of ["stress", "trap", "hard", "clean"] as QueryKind[]) {
      const r = aggStats(results[key].raw.byKind[k].p3), c = aggStats(results[key].composite.byKind[k].p3);
      console.log(`    ${k.padEnd(6)} raw=${fmt(r.mean)}  composite=${fmt(c.mean)}  Δ=${(c.mean - r.mean) >= 0 ? "+" : ""}${fmt(c.mean - r.mean)}`);
    }
    console.log();
  }

  // ── Headline discrimination check (the ask this PR validates) ───────────
  const primaryKey = `hybrid=true rerank=false`;
  if (results[primaryKey]) {
    const rawP3 = aggStats(results[primaryKey].raw.p3).mean, compP3 = aggStats(results[primaryKey].composite.p3).mean;
    const rawMrr = aggStats(results[primaryKey].raw.mrr).mean, compMrr = aggStats(results[primaryKey].composite.mrr).mean;
    const discriminates = compP3 < rawP3 || compMrr < rawMrr;
    console.log(`HEADLINE (hybrid=true, the production default): composite p@3=${fmt(compP3)} vs raw p@3=${fmt(rawP3)}; composite MRR=${fmt(compMrr)} vs raw MRR=${fmt(rawMrr)}.`);
    console.log(discriminates
      ? "  → Corpus DISCRIMINATES: composite measurably underperforms raw, reproducing flair#623 in isolation."
      : "  → Corpus did NOT discriminate this run — see README's 'if it doesn't discriminate' notes before trusting this config as safe.");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// USAGE-FEEDBACK REMATCH (flair#683) — the usage-injection code path.
//
// THE CRUX (FLAIR-USAGE-FEEDBACK-SIGNAL.md): does a usage SIGNAL make
// composite beat raw, unlike the retrievalCount signal #623 measured composite
// losing on? Real usage hasn't accrued yet (it only accrues over time via the
// live /RecordUsage endpoint), so this simulates usageCount directly against
// the seeded corpus and re-runs the SAME composite-vs-raw measurement
// (runQueries() above — unchanged) under three regimes:
//
//   POSITIVE        — usageCount on the GROUND-TRUTH-relevant docs (simulates
//                      "the relevant docs are the ones that actually get
//                      used"). Hypothesis: composite ≥ raw (usageBoost helps).
//   NEGATIVE CONTROL — usageCount on whatever MERELY SURFACES in a plain raw
//                      search (top-K of every query, regardless of whether it
//                      was the right answer) — the SAME shape of signal
//                      retrievalCount already provides today. Should
//                      REPRODUCE composite's #623 loss — proving the earlier
//                      fix is about signal QUALITY, not the boost mechanism
//                      itself (Kern's Q2: the positive test alone is
//                      question-begging; the contrast is what proves it).
//   NOISE SWEEP      — ground-truth usage PLUS random non-ground-truth usage
//                      at increasing ratios (imperfect real-world reporting),
//                      to find the SNR tolerance: at what noise level does
//                      composite-with-usage degrade back to raw-level? That
//                      number gates the real-world default-flip decision
//                      once live usage has accrued (see recall-eval.mjs).
//
// Honest framing (this file's header applies here too): this validates the
// MECHANISM via simulation. Real-world proof needs ACCRUED usage from the
// live /RecordUsage endpoint on the live corpus — ship this, let usage
// accumulate under dogfooding, then re-measure with recall-eval.mjs before
// touching the raw-vs-composite DEFAULT (this PR does not flip it).
//
// Runs against a SINGLE seeded Harper instance (hybrid=true — the production
// default combination), overwriting usageCount between scenarios rather than
// re-spawning + re-seeding each time (a fresh 87-record corpus + embedding
// warm-up is the expensive part of every run above). This trades the base
// sweep's run-to-run HNSW-variance independence for a single, fast,
// deterministic discrimination pass — appropriate for a mechanism check, not
// a claim about run-to-run noise. Use --runs-style repetition manually
// (rerun the whole script) if you need a variance estimate for a specific
// scenario.
// ═══════════════════════════════════════════════════════════════════════════

// Ground-truth marker set: every DISTINCT record any QUERY expects (a few
// markers — e.g. FIN::1 — are the expected answer for more than one query,
// so this is deliberately deduped, not QUERIES.length-sized).
const GT_MARKERS: string[] = [...new Set(QUERIES.map(q => q.expectMarker))];
const NON_GT_MARKERS: string[] = CORPUS.map(c => c.marker).filter(m => !GT_MARKERS.includes(m));
const ID_TO_MARKER: Record<string, string> = Object.fromEntries(CORPUS.map(c => [idFor(c.marker), c.marker]));

// usageCount value assigned to every "used" record. Chosen comfortably past
// usageBoost's saturation point (min(1.0 + 0.1·log2(n), 1.1) — the 1.1 cap is
// already hit by n≈2) so every scenario differs only in WHICH records get the
// (fully-saturated) boost, never by how much — isolating signal QUALITY as
// the one variable under test, matching resources/scoring.ts's usageBoost doc.
const USAGE_AMOUNT = 5;

// Deterministic PRNG (mulberry32) — NOT Math.random(): the noise sweep's
// "which non-ground-truth records get picked" must be reproducible across
// re-runs of this script, or a noise-ratio result couldn't be sanity-checked
// by re-running it.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededShuffle<T>(arr: T[], seed: number): T[] {
  const rng = mulberry32(seed);
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** POSITIVE: usageCount on every distinct ground-truth-relevant marker. */
function buildPositiveUsage(): Record<string, number> {
  return Object.fromEntries(GT_MARKERS.map(m => [m, USAGE_AMOUNT]));
}

/**
 * NOISE: the positive usage map PLUS `ratio × GT_MARKERS.length` random
 * NON-ground-truth records also marked "used" at the same amount (imperfect
 * real-world usage reporting — a caller reports use of something that turns
 * out not to be the query's real answer, or of an adjacent-but-wrong record).
 * ratio=0 is identical to buildPositiveUsage(); ratio=1 means as much noise
 * as signal; ratio>1 means noise outweighs signal.
 */
function buildNoiseUsage(ratio: number, seed = 683): Record<string, number> {
  const usage = buildPositiveUsage();
  const noiseCount = Math.min(NON_GT_MARKERS.length, Math.round(ratio * GT_MARKERS.length));
  const picked = seededShuffle(NON_GT_MARKERS, seed).slice(0, noiseCount);
  for (const m of picked) usage[m] = USAGE_AMOUNT;
  return usage;
}

/**
 * NEGATIVE CONTROL: usageCount correlated with mere SURFACING, not
 * relevance — the exact shape of signal retrievalCount already provides
 * (SemanticSearch.ts bumps retrievalCount on every returned result,
 * regardless of correctness). Runs every query once under scoring="raw" at a
 * realistic "what a caller actually sees" window (topK, default 5 — matching
 * memory_search's own default limit in resources/mcp-tools.ts) and tallies
 * how many queries surfaced each record ANYWHERE in that window — a naive
 * "usage" logger that fires on retrieval indiscriminately, the exact
 * pathology #623 root-caused. Deliberately does NOT check whether the
 * surfaced record was the query's actual right answer.
 */
async function surfacingUsage(harper: HarperInstance, agent: TestAgent, topK = 5): Promise<Record<string, number>> {
  const tally: Record<string, number> = {};
  for (const { q } of QUERIES) {
    const res = await signedFetch(harper, agent, "POST", "/SemanticSearch", { agentId: agent.id, q, limit: topK, scoring: "raw" });
    if (!res.ok) throw new Error(`surfacingUsage: search failed for "${q}": HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
    for (const r of (res.body.results || [])) {
      const marker = ID_TO_MARKER[r.id];
      if (marker) tally[marker] = (tally[marker] ?? 0) + 1;
    }
  }
  return tally;
}

/**
 * Overwrite EVERY corpus record's usageCount in one admin-op batch — markers
 * absent from `usage` are explicitly zeroed, so scenarios never leak into one
 * another on this REUSED seeded instance (see the module doc above for why a
 * single seeded instance is reused across scenarios instead of a fresh spawn
 * per scenario). `operation: "update"` is Harper's PARTIAL-merge raw op
 * (confirmed by src/cli.ts's own key-rotation code, which updates a single
 * field the same way) — unlike a Table `.put()`, it does not require or
 * clobber the rest of each record.
 */
async function applyUsage(harper: HarperInstance, usage: Record<string, number>): Promise<void> {
  const records = CORPUS.map(c => ({ id: idFor(c.marker), usageCount: usage[c.marker] ?? 0 }));
  const res = await adminOp(harper, { operation: "update", database: "flair", table: "Memory", records });
  if (!res.ok) throw new Error(`applyUsage: HTTP ${res.status} ${await res.text().catch(() => "")}`);
}

async function measureScenario(harper: HarperInstance, agent: TestAgent, label: string): Promise<{ raw: ScoringResult; composite: ScoringResult }> {
  const raw = await runQueries(harper, agent, "raw");
  const composite = await runQueries(harper, agent, "composite");
  const dP3 = composite.p3 - raw.p3, dMrr = composite.mrr - raw.mrr;
  console.log(`  [${label}]`.padEnd(46) + `raw p@3=${fmt(raw.p3)} MRR=${fmt(raw.mrr)}   composite p@3=${fmt(composite.p3)} MRR=${fmt(composite.mrr)}   Δp@3=${dP3 >= 0 ? "+" : ""}${fmt(dP3)} ΔMRR=${dMrr >= 0 ? "+" : ""}${fmt(dMrr)}`);
  return { raw, composite };
}

async function runUsageRematch(): Promise<void> {
  assertBuilt();
  console.log(`recall-harness — USAGE-FEEDBACK REMATCH (flair#683)`);
  console.log(`corpus=${CORPUS.length} records, queries=${QUERIES.length}, ${GT_MARKERS.length} distinct ground-truth markers, hybrid=true (production default)`);
  console.log(`Single seeded instance — usageCount overwritten between scenarios (see module doc for why this is NOT the averaged multi-run sweep above).\n`);
  if (process.env.FLAIR_MODELS_DIR) console.log(`FLAIR_MODELS_DIR=${process.env.FLAIR_MODELS_DIR} (reusing pre-downloaded models)\n`);

  const prevHybrid = process.env.FLAIR_HYBRID_RETRIEVAL;
  process.env.FLAIR_HYBRID_RETRIEVAL = "true";
  let harper: HarperInstance | undefined;
  try {
    console.log("spawning ephemeral Harper...");
    harper = await startHarper({ cwd: REPO_ROOT, harperBinDir: REPO_ROOT });
    console.log(`up at ${harper.httpURL} (installDir=${harper.installDir})`);

    const agent = mkAgent(AGENT_ID);
    await registerAgent(harper, agent);
    console.log(`seeding ${CORPUS.length} records...`);
    await seedCorpus(harper, agent);
    await waitSearchable(harper, agent);
    console.log(`corpus searchable — measuring scenarios (${QUERIES.length} queries × 2 scoring modes each)...\n`);

    // ── POSITIVE: usage correlated with ground-truth relevance ────────────
    await applyUsage(harper, buildPositiveUsage());
    const positive = await measureScenario(harper, agent, "POSITIVE  usage∝relevance");

    // ── NEGATIVE CONTROL: usage correlated with mere surfacing ─────────────
    // Measured against the SAME usageCount=0 state the positive scenario's
    // baseline started from — surfacingUsage() itself queries under
    // scoring="raw", so it is unaffected by whatever usageCount the positive
    // scenario just set (raw never reads usageCount).
    const surfacing = await surfacingUsage(harper, agent, 5);
    await applyUsage(harper, surfacing);
    const negative = await measureScenario(harper, agent, "NEGATIVE  usage∝surfacing");

    // ── NOISE SWEEP: ground truth + random noise at increasing ratios ──────
    const ratios = [0, 0.25, 0.5, 1, 2, 4];
    const noiseResults: { ratio: number; raw: ScoringResult; composite: ScoringResult }[] = [];
    for (const ratio of ratios) {
      await applyUsage(harper, buildNoiseUsage(ratio));
      const r = await measureScenario(harper, agent, `NOISE ratio=${ratio}`);
      noiseResults.push({ ratio, ...r });
    }

    // ── Report ──────────────────────────────────────────────────────────────
    console.log(`\n══ USAGE REMATCH SUMMARY (hybrid=true) ══\n`);
    console.log(`ground-truth markers (${GT_MARKERS.length}): ${GT_MARKERS.join(", ")}\n`);

    const dPosP3 = positive.composite.p3 - positive.raw.p3, dPosMrr = positive.composite.mrr - positive.raw.mrr;
    console.log(`POSITIVE (usage∝relevance):`);
    console.log(`  raw       p@3=${fmt(positive.raw.p3)}   MRR=${fmt(positive.raw.mrr)}`);
    console.log(`  composite p@3=${fmt(positive.composite.p3)}   MRR=${fmt(positive.composite.mrr)}`);
    console.log(`  Δ (composite − raw)   p@3=${dPosP3 >= 0 ? "+" : ""}${fmt(dPosP3)}   MRR=${dPosMrr >= 0 ? "+" : ""}${fmt(dPosMrr)}\n`);

    const dNegP3 = negative.composite.p3 - negative.raw.p3, dNegMrr = negative.composite.mrr - negative.raw.mrr;
    console.log(`NEGATIVE CONTROL (usage∝surfacing, topK=5):`);
    console.log(`  raw       p@3=${fmt(negative.raw.p3)}   MRR=${fmt(negative.raw.mrr)}`);
    console.log(`  composite p@3=${fmt(negative.composite.p3)}   MRR=${fmt(negative.composite.mrr)}`);
    console.log(`  Δ (composite − raw)   p@3=${dNegP3 >= 0 ? "+" : ""}${fmt(dNegP3)}   MRR=${dNegMrr >= 0 ? "+" : ""}${fmt(dNegMrr)}\n`);

    console.log(`NOISE SWEEP (ground-truth usage=${USAGE_AMOUNT} + random noise at ratio×${GT_MARKERS.length} distinct non-ground-truth records):`);
    for (const nr of noiseResults) {
      const dP3 = nr.composite.p3 - nr.raw.p3, dMrr = nr.composite.mrr - nr.raw.mrr;
      console.log(`  ratio=${String(nr.ratio).padEnd(5)} composite p@3=${fmt(nr.composite.p3)} MRR=${fmt(nr.composite.mrr)}   Δp@3=${dP3 >= 0 ? "+" : ""}${fmt(dP3)}  ΔMRR=${dMrr >= 0 ? "+" : ""}${fmt(dMrr)}`);
    }

    // ── Mechanism verdict ─────────────────────────────────────────────────
    const positiveHelps = positive.composite.p3 >= positive.raw.p3 && positive.composite.mrr >= positive.raw.mrr;
    const negativeLoses = negative.composite.p3 < negative.raw.p3 || negative.composite.mrr < negative.raw.mrr;
    // The SNR tolerance: the smallest tested ratio at which composite drops
    // BELOW raw on p@3 (the noise level the real-world default-flip decision
    // needs to stay under, once live usage has accrued).
    const firstLoss = noiseResults.find(nr => nr.composite.p3 < nr.raw.p3 || nr.composite.mrr < nr.raw.mrr);
    console.log(`\nMECHANISM CHECK:`);
    console.log(`  positive usage (∝relevance) ${positiveHelps ? "HELPS" : "does NOT help"} — composite ${positiveHelps ? "≥" : "<"} raw.`);
    console.log(`  negative-control usage (∝surfacing) ${negativeLoses ? "REPRODUCES the #623 loss" : "does NOT reproduce the loss"} — composite ${negativeLoses ? "<" : "≥"} raw.`);
    console.log(firstLoss
      ? `  SNR tolerance: composite-with-usage falls back to (or below) raw-level once noise ≥ ${firstLoss.ratio}× the ground-truth signal.`
      : `  SNR tolerance: composite-with-usage held ≥ raw across the full tested noise range (0–${ratios[ratios.length - 1]}×) — did not find the fallback point on this corpus.`);
    console.log(`\nHonest framing: this validates the MECHANISM via simulated usage. The raw-vs-composite DEFAULT stays "raw" — a real default-flip decision needs usage accrued from the live /RecordUsage endpoint, measured with recall-eval.mjs on the live corpus.`);
  } finally {
    if (harper) await stopHarper(harper, { keepInstallDir: false });
    if (prevHybrid === undefined) delete process.env.FLAIR_HYBRID_RETRIEVAL; else process.env.FLAIR_HYBRID_RETRIEVAL = prevHybrid;
  }
}

if (USAGE_REMATCH) {
  runUsageRematch().catch(e => {
    console.error("FATAL:", e?.stack || e?.message || e);
    if (!KEEP_ON_FAIL) console.error("(pass --keep-on-fail to leave a failed run's Harper installDir on disk for inspection)");
    process.exit(1);
  });
} else {
  main().catch(e => {
    console.error("FATAL:", e?.stack || e?.message || e);
    if (!KEEP_ON_FAIL) console.error("(pass --keep-on-fail to leave a failed run's Harper installDir on disk for inspection)");
    process.exit(1);
  });
}
