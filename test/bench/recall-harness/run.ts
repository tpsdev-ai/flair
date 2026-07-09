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

main().catch(e => {
  console.error("FATAL:", e?.stack || e?.message || e);
  if (!KEEP_ON_FAIL) console.error("(pass --keep-on-fail to leave a failed run's Harper installDir on disk for inspection)");
  process.exit(1);
});
