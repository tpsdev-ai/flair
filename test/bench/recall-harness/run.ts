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
 * service or any live checkout) AND uses a harder, representative corpus
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
 * from, or writes to any live checkout or any live Flair service. FLAIR_MODELS_DIR
 * may be pointed at an EXISTING flair install's models/ directory (read-only
 * — just the GGUF weight files) to skip re-downloading the embedding model;
 * see README.md.
 *
 * USAGE:
 *   bun run test/bench/recall-harness/run.ts                  # full sweep: hybrid on+off, 3 runs each, corpus=v1
 *   bun run test/bench/recall-harness/run.ts --runs 1          # quick single-run pass (less trustworthy)
 *   bun run test/bench/recall-harness/run.ts --hybrid on        # only the production-default config
 *   bun run test/bench/recall-harness/run.ts --hybrid on --rerank  # also spawn a hybrid+rerank config
 *   bun run test/bench/recall-harness/run.ts --verbose          # print every query's rank, not just aggregates
 *   bun run test/bench/recall-harness/run.ts --keep-on-fail     # leave a failed run's Harper installDir on disk
 *   bun run test/bench/recall-harness/run.ts --corpus v2        # eval instrument v2 (corpus-v2.ts) — the
 *                                                                # standing gate for future embedding/scoring
 *                                                                # changes; --corpus defaults to "v1" so every
 *                                                                # existing published number stays reproducible
 *                                                                # verbatim without passing this flag. See
 *                                                                # corpus-v2.ts's header and README.md.
 *
 * Reads nothing from the network except what Harper itself needs (model
 * files from FLAIR_MODELS_DIR or a HuggingFace download on first use).
 */
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../../helpers/harper-lifecycle";
import * as CorpusV1 from "./corpus";
import * as CorpusV2 from "./corpus-v2";
import type { QueryKind, CorpusRecord } from "./corpus";

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
// flair#683: run ONLY the usage-injection rematch (see "USAGE-FEEDBACK
// REMATCH" section below) instead of the base composite-vs-raw sweep above.
const USAGE_REMATCH = process.argv.includes("--usage-rematch");
// flair#504 Phase 2 (nomic search prefixes, FLIPPED ON): THE GATE
// (EMBEDDING_PREFIXES_ENABLED in resources/embeddings-provider.ts) now
// defaults ON on strategic grounds (measured recall delta was noise-scale —
// see that file's header), so "on" = the real, unmodified default code path
// (no hatch needed at all) and "off" = the harness-only
// FLAIR_RECALL_HARNESS_FORCE_PREFIX escape hatch, which force-disables the
// SAME gate the production code checks — see that file's header for why a
// real env toggle in PRODUCTION code was rejected but this harness-only one
// is fine: the call sites never read it, only prefixesEnabled() does. This
// is what lets the harness keep measuring BOTH arms even though production
// only ever exercises "on". The hatch is bidirectional
// (`harnessPrefixOverride()` reads `"true"`/`"false"`, not just presence) so
// it stays correct across any future re-flip without a second hatch.
const PREFIXES_ARG = argVal("--prefixes", "both"); // "both" | "on" | "off"
// Run ONLY the mixed-space canary (see "MIXED-SPACE CANARY" section below)
// instead of the main sweep.
const RUN_CANARY = process.argv.includes("--canary");
// eval instrument v2 (flair#504 checkpoint 2): "v1" (default) keeps every
// existing published number byte-reproducible — corpus.ts is NEVER imported
// conditionally in a way that changes its content, so a bare `bun run
// run.ts` with no --corpus flag behaves identically to before this flag
// existed. "v2" swaps in corpus-v2.ts (test/bench/recall-harness/corpus-v2.ts)
// — a larger, harder instrument with enough queries per "kind" to make a
// kind-level delta a real signal instead of 1-2 queries shifting rank at
// v1's N=30. See corpus-v2.ts's header and README.md's "v2" section.
const CORPUS_ARG = argVal("--corpus", "v1"); // "v1" | "v2"
if (CORPUS_ARG !== "v1" && CORPUS_ARG !== "v2") {
  console.error(`FATAL: --corpus must be "v1" or "v2", got "${CORPUS_ARG}"`);
  process.exit(2);
}
const { CORPUS, QUERIES } = CORPUS_ARG === "v2" ? CorpusV2 : CorpusV1;
// bench-only model-file override (Q4/Q8 GGUF A/B — see
// resources/embeddings-boot.ts's `benchModelPathOverride()` for the mechanism
// this flag drives): an absolute or cwd-relative path to a GGUF file,
// forwarded to the spawned Harper process as FLAIR_RECALL_HARNESS_MODEL_PATH
// so harper-fabric-embeddings' `register()` loads THAT file directly
// (bypassing its modelName/modelsDir registry+download resolution) for every
// config this invocation runs. Unset (the default) keeps the existing
// resolveModelsDir()+modelName path — byte-identical to before this flag
// existed. One value per invocation, not swept per-config like
// hybrid/prefixes/rerank: comparing two GGUF files means comparing two
// separate harness invocations' aggregate numbers, not two arms measured
// against the same seeded corpus.
const MODEL_FILE_ARG = argVal("--model-file", "");
if (MODEL_FILE_ARG) {
  const resolvedModelFile = path.resolve(MODEL_FILE_ARG);
  if (!existsSync(resolvedModelFile)) {
    console.error(`FATAL: --model-file ${resolvedModelFile} does not exist.`);
    process.exit(2);
  }
  process.env.FLAIR_RECALL_HARNESS_MODEL_PATH = resolvedModelFile;
}
// Every topic cluster present in whichever corpus got selected — drives the
// per-cluster reporting breakdown below. Computed once at module load since
// CORPUS is fixed for the whole process (selected by --corpus above).
const CLUSTERS: string[] = [...new Set(CORPUS.map(c => c.cluster))].sort();
const MARKER_TO_CLUSTER: Record<string, string> = Object.fromEntries(CORPUS.map(c => [c.marker, c.cluster]));
// Not every cluster necessarily has a query targeting it (not required by
// design — see corpus-v2.ts's header); the per-cluster report below only
// considers clusters that do, so a cluster with zero ground-truth queries
// doesn't show up as a fake "0.000 MRR" mover.
const CLUSTERS_WITH_QUERIES = new Set<string>(QUERIES.map(q => MARKER_TO_CLUSTER[q.expectMarker]).filter(Boolean));

// candidateLimit = limit*5 must exceed CORPUS.length or a correct answer can
// fall outside the candidate set entirely (an artifact of the harness, not a
// real recall signal) — v1's 20 (candidateLimit=100 > 87) is left EXACTLY as
// it was so --corpus v1 stays byte-identical to every previously-published
// number; v2's much larger corpus needs a proportionally larger limit.
const SEARCH_LIMIT = CORPUS_ARG === "v2" ? Math.ceil(CORPUS.length / 5) + 10 : 20;

const hybridValues: boolean[] = HYBRID_ARG === "on" ? [true] : HYBRID_ARG === "off" ? [false] : [true, false];
const prefixValues: boolean[] = PREFIXES_ARG === "on" ? [true] : PREFIXES_ARG === "off" ? [false] : [true, false];

// Frozen reference point (test/bench/recall-harness/README.md "Measured
// results", 2026-07-08): Phase-1 (no inputType at all — byte-identical wash)
// scoring=raw, hybrid=true. This PR's prefix-on numbers are compared against
// this AND against a live prefix-off measurement from the same session (see
// the report section) — the live comparison is the more rigorous one (same
// corpus/HNSW-build session), this frozen number is context for "did the
// Phase-1 baseline itself hold steady."
const PHASE1_BASELINE = { p3: 0.967, mrr: 0.892 };

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
// THREADS_COUNT=1 ephemeral instance. `records` defaults to the full CORPUS;
// the mixed-space canary passes a subset (see below).
async function seedCorpus(harper: HarperInstance, agent: TestAgent, records: CorpusRecord[] = CORPUS): Promise<void> {
  const BATCH = 6;
  for (let i = 0; i < records.length; i += BATCH) {
    await Promise.all(records.slice(i, i + BATCH).map(rec => seedRecord(harper, agent, rec)));
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
interface QueryRow { q: string; kind: QueryKind; cluster: string; expectMarker: string; rank: number /* 0-based, -1 = not found */ }
interface KindStats { p3: number; mrr: number; n: number }
interface ScoringResult { scoring: "raw" | "composite"; p3: number; mrr: number; n: number; byKind: Record<QueryKind, KindStats>; byCluster: Record<string, KindStats>; rows: QueryRow[] }

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
    rows.push({ q, kind, cluster: MARKER_TO_CLUSTER[expectMarker] ?? "UNKNOWN", expectMarker, rank });
  }
  const overall = statsFor(rows);
  const kinds: QueryKind[] = ["stress", "trap", "hard", "clean"];
  const byKind = Object.fromEntries(kinds.map(k => [k, statsFor(rows.filter(r => r.kind === k))])) as Record<QueryKind, KindStats>;
  const byCluster = Object.fromEntries(CLUSTERS.map(c => [c, statsFor(rows.filter(r => r.cluster === c))])) as Record<string, KindStats>;
  return { scoring, ...overall, byKind, byCluster, rows };
}

// One independent (spawn → register → seed → wait → measure[raw,composite] →
// teardown) cycle for a given (hybrid, rerank, prefixesOn) config.
// prefixesOn=false forces the harness-only prefix override to "false" (see
// resources/embeddings-provider.ts's `harnessPrefixOverride` doc) so this
// arm's writes/queries measure "as if THE GATE were flipped off" against the
// SAME gate-on-by-default dist build the on-arm uses — isolating the prefix
// effect from every other variable (corpus, HNSW build, embedding-engine
// warmup). prefixesOn=true needs no hatch — it IS the shipped default.
async function runOnce(hybrid: boolean, rerank: boolean, prefixesOn: boolean, runIdx: number, totalRuns: number): Promise<{ raw: ScoringResult; composite: ScoringResult }> {
  const label = `[hybrid=${hybrid} rerank=${rerank} prefixes=${prefixesOn ? "on" : "off"} run ${runIdx}/${totalRuns}]`;
  const prevHybrid = process.env.FLAIR_HYBRID_RETRIEVAL;
  const prevRerank = process.env.FLAIR_RERANK_ENABLED;
  const prevPrefix = process.env.FLAIR_RECALL_HARNESS_FORCE_PREFIX;
  process.env.FLAIR_HYBRID_RETRIEVAL = hybrid ? "true" : "false";
  if (rerank) process.env.FLAIR_RERANK_ENABLED = "true"; else delete process.env.FLAIR_RERANK_ENABLED;
  if (prefixesOn) delete process.env.FLAIR_RECALL_HARNESS_FORCE_PREFIX; else process.env.FLAIR_RECALL_HARNESS_FORCE_PREFIX = "false";

  let harper: HarperInstance | undefined;
  try {
    console.log(`${label} spawning ephemeral Harper...`);
    harper = await startHarper({ cwd: REPO_ROOT, harperBinDir: REPO_ROOT });
    console.log(`${label} up at ${harper.httpURL} (installDir=${harper.installDir})`);

    const agent = mkAgent(AGENT_ID);
    await registerAgent(harper, agent);
    console.log(`${label} seeding ${CORPUS.length} records...`);
    // Wall-clock the seed pass — a simple, comparable embed-latency proxy for
    // A/B'ing model files (--model-file): each seedRecord's PUT awaits
    // embedding generation before responding (Memory.put()'s contract, see
    // waitSearchable's comment below), and the native engine serializes embed
    // calls on its own internal queue (engine.js's `#queue`) even though
    // seedCorpus fires BATCH=6 concurrent HTTP requests — so total elapsed
    // divided by record count is a cleaner per-embed estimate than timing any
    // single concurrent PUT in isolation (which would include queueing wait
    // behind its batch-mates, not pure compute).
    const seedStart = performance.now();
    await seedCorpus(harper, agent);
    const seedMs = performance.now() - seedStart;
    console.log(`${label} seeded ${CORPUS.length} records in ${seedMs.toFixed(0)}ms (${(seedMs / CORPUS.length).toFixed(1)}ms/record avg)`);
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
    if (prevPrefix === undefined) delete process.env.FLAIR_RECALL_HARNESS_FORCE_PREFIX; else process.env.FLAIR_RECALL_HARNESS_FORCE_PREFIX = prevPrefix;
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

// Per-cluster "notable movers" between two arms (e.g. prefixes on vs off, or
// composite vs raw) — added for eval instrument v2 (flair#504 checkpoint 2):
// v1's 12 clusters are few enough to just read off the by-kind breakdown,
// but v2's 30 clusters need this to avoid burying the signal in noise. Only
// clusters where BOTH arms actually had at least one query targeting them
// (n>0) are considered; sorted by MRR delta (b − a), most-improved first,
// with the biggest regressions printed at the bottom of the same list so a
// reader sees both tails without two separate dumps. `topN` caps how many
// gainers/losers are printed per side — the full per-cluster numbers are
// always available by re-running with a narrower --hybrid/--prefixes filter
// if a reader needs more than the notable movers.
function printClusterMovers(
  aByCluster: Record<string, { p3: number[]; mrr: number[] }>,
  bByCluster: Record<string, { p3: number[]; mrr: number[] }>,
  labelA: string,
  labelB: string,
  topN = 5,
): void {
  const movers: { cluster: string; aMrr: number; bMrr: number; delta: number }[] = [];
  for (const cluster of CLUSTERS) {
    if (!CLUSTERS_WITH_QUERIES.has(cluster)) continue; // no query targets this cluster — nothing to compare
    const aVals = aByCluster[cluster]?.mrr ?? [];
    const bVals = bByCluster[cluster]?.mrr ?? [];
    if (!aVals.length || !bVals.length) continue;
    const aMrr = aggStats(aVals).mean, bMrr = aggStats(bVals).mean;
    movers.push({ cluster, aMrr, bMrr, delta: bMrr - aMrr });
  }
  if (!movers.length) { console.log(`  (no per-cluster data — corpus has no cluster-tagged queries)`); return; }
  movers.sort((x, y) => y.delta - x.delta);
  const gainers = movers.filter(m => m.delta > 0).slice(0, topN);
  const losers = movers.filter(m => m.delta < 0).slice(-topN).reverse();
  const flat = movers.filter(m => m.delta === 0).length;
  console.log(`  per-cluster MRR movers (${labelB} − ${labelA}, ${movers.length} clusters with data, ${flat} flat):`);
  if (gainers.length) {
    console.log(`    gained:`);
    for (const m of gainers) console.log(`      ${m.cluster.padEnd(14)} ${labelA}=${fmt(m.aMrr)}  ${labelB}=${fmt(m.bMrr)}  Δ=+${fmt(m.delta)}`);
  }
  if (losers.length) {
    console.log(`    lost:`);
    for (const m of losers) console.log(`      ${m.cluster.padEnd(14)} ${labelA}=${fmt(m.aMrr)}  ${labelB}=${fmt(m.bMrr)}  Δ=${fmt(m.delta)}`);
  }
  if (!gainers.length && !losers.length) console.log(`    (all clusters flat)`);
}

async function main() {
  assertBuilt();
  console.log(`recall-harness — ISOLATED recall eval (corpus=${CORPUS_ARG}: ${CORPUS.length} records / ${CLUSTERS.length} clusters, queries=${QUERIES.length})`);
  console.log(`config: runs=${RUNS} hybrid=${hybridValues.join(",")} prefixes=${prefixValues.map(p => p ? "on" : "off").join(",")} rerank=${WITH_RERANK ? "on(hybrid=true,prefixes=true only)+off" : "off"}\n`);
  if (process.env.FLAIR_MODELS_DIR) console.log(`FLAIR_MODELS_DIR=${process.env.FLAIR_MODELS_DIR} (reusing pre-downloaded models)\n`);
  if (MODEL_FILE_ARG) console.log(`--model-file ${process.env.FLAIR_RECALL_HARNESS_MODEL_PATH} (overriding model selection for this invocation)\n`);

  // Build the (hybrid, rerank, prefixesOn) config list. rerank is opt-in and
  // only ever tested alongside hybrid=true, prefixes=true (the
  // production-default combination) — a full sweep including rerank
  // multiplies runtime for a knob this PR's validation doesn't depend on;
  // see README for how to run a fuller sweep manually.
  const configs: { hybrid: boolean; rerank: boolean; prefixesOn: boolean }[] = [];
  for (const h of hybridValues) for (const p of prefixValues) configs.push({ hybrid: h, rerank: false, prefixesOn: p });
  if (WITH_RERANK && hybridValues.includes(true) && prefixValues.includes(true)) configs.push({ hybrid: true, rerank: true, prefixesOn: true });

  type Agg = { p3: number[]; mrr: number[]; byKind: Record<QueryKind, { p3: number[]; mrr: number[] }>; byCluster: Record<string, { p3: number[]; mrr: number[] }> };
  const emptyAgg = (): Agg => ({
    p3: [], mrr: [],
    byKind: { stress: { p3: [], mrr: [] }, trap: { p3: [], mrr: [] }, hard: { p3: [], mrr: [] }, clean: { p3: [], mrr: [] } },
    byCluster: Object.fromEntries(CLUSTERS.map(c => [c, { p3: [], mrr: [] }])),
  });

  const keyFor = (cfg: { hybrid: boolean; rerank: boolean; prefixesOn: boolean }) =>
    `hybrid=${cfg.hybrid} rerank=${cfg.rerank} prefixes=${cfg.prefixesOn ? "on" : "off"}`;

  const results: Record<string, { raw: Agg; composite: Agg }> = {};

  for (const cfg of configs) {
    const key = keyFor(cfg);
    results[key] = { raw: emptyAgg(), composite: emptyAgg() };
    for (let i = 1; i <= RUNS; i++) {
      const { raw, composite } = await runOnce(cfg.hybrid, cfg.rerank, cfg.prefixesOn, i, RUNS);
      for (const [scoring, res] of [["raw", raw], ["composite", composite]] as const) {
        const agg = results[key][scoring];
        agg.p3.push(res.p3); agg.mrr.push(res.mrr);
        for (const k of Object.keys(res.byKind) as QueryKind[]) {
          agg.byKind[k].p3.push(res.byKind[k].p3);
          agg.byKind[k].mrr.push(res.byKind[k].mrr);
        }
        for (const c of CLUSTERS) {
          agg.byCluster[c].p3.push(res.byCluster[c].p3);
          agg.byCluster[c].mrr.push(res.byCluster[c].mrr);
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
    const key = keyFor(cfg);
    console.log(`── ${key} ──`);
    for (const scoring of ["raw", "composite"] as const) {
      const agg = results[key][scoring];
      const p3 = aggStats(agg.p3), mrr = aggStats(agg.mrr);
      console.log(`  scoring=${scoring.padEnd(9)} p@3=${fmtAgg(p3)}   MRR=${fmtAgg(mrr)}`);
    }
    // Per-kind MRR for scoring=raw — same shape as BASELINE.json's `perKind`
    // block (n + mrr per kind), so a model/quant A/B's per-kind numbers are
    // directly diffable against that file without re-deriving them from the
    // p@3-only composite-vs-raw breakdown printed below. Collected in the same
    // loop as everything else above (agg.byKind[k].mrr) — this just prints
    // data that already existed but had no standalone print site.
    {
      const rawAgg = results[key].raw;
      const parts = (["stress", "trap", "hard", "clean"] as QueryKind[]).map(k => {
        const n = QUERIES.filter(q => q.kind === k).length;
        return `${k}(n=${n})=${fmtAgg(aggStats(rawAgg.byKind[k].mrr))}`;
      });
      console.log(`  scoring=raw per-kind MRR: ${parts.join("  ")}`);
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
    printClusterMovers(results[key].raw.byCluster, results[key].composite.byCluster, "raw", "composite");
    console.log();
  }

  // ── Headline discrimination check (composite vs raw, flair#623) ─────────
  // Prefers prefixes=on — the shipped production default now that THE GATE
  // (EMBEDDING_PREFIXES_ENABLED) is flipped on — when that arm is present in
  // this invocation; falls back to prefixes=off only if the invocation
  // exclusively requested that (comparison) arm.
  const primaryPrefixOn = prefixValues.includes(true);
  const primaryKey = keyFor({ hybrid: true, rerank: false, prefixesOn: primaryPrefixOn });
  if (results[primaryKey]) {
    const rawP3 = aggStats(results[primaryKey].raw.p3).mean, compP3 = aggStats(results[primaryKey].composite.p3).mean;
    const rawMrr = aggStats(results[primaryKey].raw.mrr).mean, compMrr = aggStats(results[primaryKey].composite.mrr).mean;
    const discriminates = compP3 < rawP3 || compMrr < rawMrr;
    console.log(`HEADLINE (hybrid=true prefixes=${primaryPrefixOn ? "on, the shipped production default" : "off (comparison arm — this invocation didn't include the on/default arm)"}): composite p@3=${fmt(compP3)} vs raw p@3=${fmt(rawP3)}; composite MRR=${fmt(compMrr)} vs raw MRR=${fmt(rawMrr)}.`);
    console.log(discriminates
      ? "  → Corpus DISCRIMINATES: composite measurably underperforms raw, reproducing flair#623 in isolation."
      : "  → Corpus did NOT discriminate this run — see README's 'if it doesn't discriminate' notes before trusting this config as safe.");
  }

  // ── PREFIX A/B (flair#504 Phase 2 — the ask THIS harness change validates) ─
  // scoring=raw only (the production default, and what PHASE1_BASELINE was
  // measured under) — composite is a separate, already-settled question
  // (flair#623 above). For each hybrid mode this sweep covers, compares the
  // LIVE prefixes=on vs prefixes=off measurement (same session, same corpus/
  // HNSW-build conditions — the rigorous comparison) and, where prefixes=on
  // is present, the delta vs the frozen Phase-1 PHASE1_BASELINE (context:
  // did the historical baseline itself hold steady).
  if (prefixValues.length === 2) {
    console.log(`\n══ PREFIX A/B (flair#504 Phase 2 — scoring=raw only) ══\n`);
    for (const h of hybridValues) {
      const onKey = keyFor({ hybrid: h, rerank: false, prefixesOn: true });
      const offKey = keyFor({ hybrid: h, rerank: false, prefixesOn: false });
      if (!results[onKey] || !results[offKey]) continue;
      const onP3 = aggStats(results[onKey].raw.p3), offP3 = aggStats(results[offKey].raw.p3);
      const onMrr = aggStats(results[onKey].raw.mrr), offMrr = aggStats(results[offKey].raw.mrr);
      const dP3 = onP3.mean - offP3.mean, dMrr = onMrr.mean - offMrr.mean;
      console.log(`── hybrid=${h} ──`);
      console.log(`  prefixes=off (comparison, via force-off hatch)  p@3=${fmtAgg(offP3)}   MRR=${fmtAgg(offMrr)}`);
      console.log(`  prefixes=on  (shipped default)                  p@3=${fmtAgg(onP3)}   MRR=${fmtAgg(onMrr)}`);
      console.log(`  Δ (on − off, live, same session)   p@3=${dP3 >= 0 ? "+" : ""}${fmt(dP3)}   MRR=${dMrr >= 0 ? "+" : ""}${fmt(dMrr)}`);
      // PHASE1_BASELINE was measured on v1's 87-record corpus — comparing a
      // v2 run against it would silently mix two different instruments'
      // numbers, so only print it for --corpus v1 (the default).
      if (CORPUS_ARG === "v1") {
        console.log(`  Δ (on − frozen Phase-1 baseline p@3=${PHASE1_BASELINE.p3} MRR=${PHASE1_BASELINE.mrr})   p@3=${(onP3.mean - PHASE1_BASELINE.p3) >= 0 ? "+" : ""}${fmt(onP3.mean - PHASE1_BASELINE.p3)}   MRR=${(onMrr.mean - PHASE1_BASELINE.mrr) >= 0 ? "+" : ""}${fmt(onMrr.mean - PHASE1_BASELINE.mrr)}`);
      }
      console.log(`  by kind (on − off, MRR):`);
      for (const k of ["stress", "trap", "hard", "clean"] as QueryKind[]) {
        const r = aggStats(results[offKey].raw.byKind[k].mrr), c = aggStats(results[onKey].raw.byKind[k].mrr);
        console.log(`    ${k.padEnd(6)} off=${fmt(r.mean)}  on=${fmt(c.mean)}  Δ=${(c.mean - r.mean) >= 0 ? "+" : ""}${fmt(c.mean - r.mean)}`);
      }
      printClusterMovers(results[offKey].raw.byCluster, results[onKey].raw.byCluster, "off", "on");
      console.log();
    }
    const primaryOnKey = keyFor({ hybrid: true, rerank: false, prefixesOn: true });
    const primaryOffKey = keyFor({ hybrid: true, rerank: false, prefixesOn: false });
    if (results[primaryOnKey] && results[primaryOffKey]) {
      const onP3 = aggStats(results[primaryOnKey].raw.p3).mean, offP3 = aggStats(results[primaryOffKey].raw.p3).mean;
      const onMrr = aggStats(results[primaryOnKey].raw.mrr).mean, offMrr = aggStats(results[primaryOffKey].raw.mrr).mean;
      const bump = onP3 >= offP3 && onMrr >= offMrr;
      console.log(`PREFIX HEADLINE (hybrid=true, the production default): prefixes=on p@3=${fmt(onP3)} MRR=${fmt(onMrr)} vs prefixes=off p@3=${fmt(offP3)} MRR=${fmt(offMrr)}.`);
      console.log(bump
        ? "  → Prefixes (the shipped default) match or beat the off comparison arm on THIS run — consistent with the flip decision, though a single run isn't the full re-baseline (see BASELINE.json + README's ratchet-gate process)."
        : "  → Prefixes trail the off comparison arm on p@3 or MRR this run — a single run isn't grounds to revert THE GATE on its own; re-run the full sweep and compare against BASELINE.json before considering a revert.");
    }
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

// ═══════════════════════════════════════════════════════════════════════════
// MIXED-SPACE CANARY (flair#504 Phase 2) — quantifies the transient risk a
// gate-flip re-embed pass carries while it's mid-flight (see THE GATE,
// `EMBEDDING_PREFIXES_ENABLED`, in resources/embeddings-provider.ts — now ON
// by default, re-baselined through this same measurement). Does NOT touch
// prod; ephemeral Harper only. This scenario already played out for THIS
// flip (the boot-keyed auto-migration runner re-embeds stale rows on next
// boot — see resources/migrations/embedding-stamp.ts) — the canary stays as
// a reusable tool for quantifying the same class of transient risk the NEXT
// time a variant-stamp change (a different embedding model, a new
// EMBEDDING_VARIANT bump) triggers a mass re-embed.
//
// The scenario this models: a re-embed pass against the LIVE corpus
// transiently holds BOTH old-stamp and new-stamp document vectors in the
// SAME corpus while it runs (batched, ~100ms apart) — a query embedded under
// the NEW stamp would then be cross-space against whichever documents the
// pass hasn't touched yet.
//
// This canary reproduces that mixed state in isolation: CORPUS is split by
// ALTERNATING index (not a contiguous first/second half — that would
// confound the measurement if a whole topic cluster or query kind happened
// to land in only one half; alternating approximates a re-embed pass that
// proceeds in id/insertion order, uncorrelated with topic). The even-index
// half is written FIRST with the harness-only hatch forced OFF (simulating
// not-yet-re-embedded rows, i.e. rows still on the OLD stamp — reachable
// now only via the hatch, since THE GATE itself defaults on); Harper is then
// STOPPED but its installDir is KEPT (mirrors flair#637's downgrade-boot
// restart pattern — test/compat/downgrade-boot.test.ts — the on-disk Memory
// table + HNSW index persist across the restart) and RESTARTED against the
// SAME installDir with no hatch (the real gate-on default, simulating the
// re-embed having caught up), which writes the odd-index half WITH the
// prefix. Queries run against this final instance, so they always get the
// real 'query' prefix — only the STORED document vectors are mixed.
//
// Reports the mixed-corpus p@3/MRR; compare against this same invocation's
// (or a prior `--hybrid on --prefixes on` run's) fully-consistent prefix-on
// numbers — the delta IS the quantified transient-degradation risk a re-embed
// pass carries while mid-flight.
// ═══════════════════════════════════════════════════════════════════════════
async function runMixedSpaceCanary(): Promise<void> {
  assertBuilt();
  const unprefixedHalf = CORPUS.filter((_, i) => i % 2 === 0);
  const prefixedHalf = CORPUS.filter((_, i) => i % 2 === 1);
  console.log(`recall-harness — MIXED-SPACE CANARY (flair#504 Phase 2 stage-2 prod-re-embed risk)`);
  console.log(`corpus=${CORPUS.length} records split by alternating index: ${unprefixedHalf.length} written UNPREFIXED first (simulating not-yet-re-embedded rows), ${prefixedHalf.length} written PREFIXED after a same-installDir Harper restart (simulating freshly re-embedded rows). Queries always use the real 'query' prefix. hybrid=true (production default), scoring=raw.\n`);
  if (process.env.FLAIR_MODELS_DIR) console.log(`FLAIR_MODELS_DIR=${process.env.FLAIR_MODELS_DIR} (reusing pre-downloaded models)\n`);

  const prevHybrid = process.env.FLAIR_HYBRID_RETRIEVAL;
  const prevPrefix = process.env.FLAIR_RECALL_HARNESS_FORCE_PREFIX;
  process.env.FLAIR_HYBRID_RETRIEVAL = "true";

  let inst1: HarperInstance | undefined;
  let inst2: HarperInstance | undefined;
  let installDir: string | undefined;
  try {
    // ── Phase A: unprefixed half, simulating pre-re-embed rows ────────────
    // THE GATE (EMBEDDING_PREFIXES_ENABLED) now defaults ON, so this half
    // needs the harness-only hatch forced to "false" to simulate the OLD,
    // not-yet-re-embedded stamp.
    process.env.FLAIR_RECALL_HARNESS_FORCE_PREFIX = "false";
    console.log(`[canary] spawning ephemeral Harper (phase A: prefix OFF via force-off hatch, simulating not-yet-re-embedded rows)...`);
    inst1 = await startHarper({ cwd: REPO_ROOT, harperBinDir: REPO_ROOT });
    installDir = inst1.installDir;
    console.log(`[canary] up at ${inst1.httpURL} (installDir=${installDir})`);
    const agent = mkAgent(AGENT_ID);
    await registerAgent(inst1, agent);
    console.log(`[canary] seeding ${unprefixedHalf.length} unprefixed records...`);
    await seedCorpus(inst1, agent, unprefixedHalf);
    // No waitSearchable() here — the canary marker query's expected record
    // may land in EITHER half depending on which alternating slot its marker
    // fell in, so a phase-A-only searchability poll isn't a valid gate (it's
    // done once, properly, against the FULL mixed corpus in phase B below).
    // Memory.put() awaits embedding generation before responding (seedRecord
    // already awaits each PUT), so the vectors themselves are computed and
    // persisted by the time we move on — but HNSW index visibility has a
    // documented async lag independent of the write response (see
    // waitSearchable's own comment above), so give it a beat before killing
    // the process, rather than risk stopping mid-index-build.
    await new Promise((r) => setTimeout(r, 3000));
    console.log(`[canary] stopping (keeping installDir for phase B restart)...`);
    await stopHarper(inst1, { keepInstallDir: true });
    inst1 = undefined;

    // ── Phase B: SAME installDir, prefix ON — the gate's real default now,
    // no hatch needed. Simulates the re-embed pass having caught this half up.
    delete process.env.FLAIR_RECALL_HARNESS_FORCE_PREFIX;
    console.log(`[canary] restarting SAME installDir (phase B: prefix ON, real gate-on default, simulating the re-embed pass catching up)...`);
    inst2 = await startHarper({ cwd: REPO_ROOT, harperBinDir: REPO_ROOT, installDir });
    console.log(`[canary] up at ${inst2.httpURL}`);
    console.log(`[canary] seeding ${prefixedHalf.length} prefixed records...`);
    await seedCorpus(inst2, agent, prefixedHalf);
    await waitSearchable(inst2, agent);
    console.log(`[canary] mixed corpus ready (${unprefixedHalf.length} unprefixed + ${prefixedHalf.length} prefixed) — measuring ${QUERIES.length} queries...`);
    const mixed = await runQueries(inst2, agent, "raw");
    console.log(`\n══ MIXED-SPACE CANARY RESULT ══\n`);
    console.log(`  MIXED-SPACE (hybrid=true, scoring=raw)   p@3=${fmt(mixed.p3)}   MRR=${fmt(mixed.mrr)}`);
    console.log(`  by kind:`);
    for (const k of ["stress", "trap", "hard", "clean"] as QueryKind[]) {
      console.log(`    ${k.padEnd(6)} p@3=${fmt(mixed.byKind[k].p3)}  MRR=${fmt(mixed.byKind[k].mrr)}  (n=${mixed.byKind[k].n})`);
    }
    console.log(`\n  Compare against a fully-consistent prefixes=on hybrid=true run (this PR's PREFIX A/B section above, or \`--hybrid on --prefixes on\`) — the gap IS the quantified stage-2 transient-degradation risk.`);
    // PHASE1_BASELINE was measured on v1's 87-record corpus — only a
    // meaningful reference point when the canary itself ran on v1.
    if (CORPUS_ARG === "v1") {
      console.log(`  Frozen Phase-1 reference: p@3=${PHASE1_BASELINE.p3} MRR=${PHASE1_BASELINE.mrr}.`);
    }
  } finally {
    if (inst2) await stopHarper(inst2, { keepInstallDir: false }); // ownsInstallDir=false (installDir passed explicitly) — never removes it
    else if (inst1) await stopHarper(inst1, { keepInstallDir: false });
    if (installDir) await rm(installDir, { recursive: true, force: true, maxRetries: 4 }).catch(() => {});
    if (prevHybrid === undefined) delete process.env.FLAIR_HYBRID_RETRIEVAL; else process.env.FLAIR_HYBRID_RETRIEVAL = prevHybrid;
    if (prevPrefix === undefined) delete process.env.FLAIR_RECALL_HARNESS_FORCE_PREFIX; else process.env.FLAIR_RECALL_HARNESS_FORCE_PREFIX = prevPrefix;
  }
}

if (USAGE_REMATCH) {
  runUsageRematch().catch(e => {
    console.error("FATAL:", e?.stack || e?.message || e);
    if (!KEEP_ON_FAIL) console.error("(pass --keep-on-fail to leave a failed run's Harper installDir on disk for inspection)");
    process.exit(1);
  });
} else if (RUN_CANARY) {
  runMixedSpaceCanary().catch(e => {
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
