// ─── bootstrap LARGE-STORE conformance — the contract under real admission load ───
//
// flair#1290 (step 6 of the powered-invariants plan). WHAT THIS POWERS: every
// bootstrap invariant the connector-conformance suite declares — countCoherence,
// countEqualsDelivered, budgetCap, tokenEstimate, hintWhenEmpty, dedup, the
// container rules — had only ever run against single-digit seed stores, where
// the budget never truncates and the admission loops barely iterate. The count/
// budget bug class this contract exists for (#1199/#1207) only EXPRESSES itself
// under pressure: sub-budget overflows, section re-admission, truncation
// bookkeeping. This file is CI's first large-store admission workout: the full
// conform() contract against a bootstrap whose budget is genuinely fought over.
//
// FIXTURE — corpus-v2 (test/bench/recall-harness/corpus-v2.ts): the authored-
// synthetic recall corpus, 30 clusters, privacy-cleared for CI (Sherlock on
// #1290 — grep-verified no real names/hosts/IPs/URLs). NOTE: its own header
// says "9 records each = 270", but the shipped array holds 251 (8 clusters
// carry 7-8 records) — this file sizes everything from CORPUS.length, never
// the header's arithmetic. Partitioned across 8 synthetic agents in the
// live-flint profile's ownership skew — recordsPerAgentSorted
// [898, 64, 46, 41, 21, 4, 4, 2] of 1080 (test/bench/corpus-profiler/profiles/
// live-flint-2026-07.json, numbers-only), apportioned to the corpus size by
// largest remainder with a 1-record floor — one heavy agent (the bootstrap
// caller, as in the live profile) + seven light teammates. Seeded through the
// REAL memory_store write path (TOOLS.memory_store.impl → Memory.post →
// getEmbedding), so every record carries a genuine embedding and enters the
// HNSW candidate pool — an ops-inserted row never would (see the conformance
// suite's count-fixture note). Light agents' records are written
// visibility:"shared" so cross-agent (teammate) retrieval has a real pool;
// their few ephemeral rows stay private (ephemeral is private-only, flair#1257
// — the server refuses ephemeral+shared) and are simply not cross-agent
// retrievable, which is the true product behavior.
//
// The bootstrap itself: the heavy agent, a corpus ground-truth query as
// currentTask (chosen so its answer record belongs to a LIGHT agent — the
// teammate path has something real to find), maxTokens deliberately far below
// what 224 own records need — truncation and the shared-budget accounting all
// engage, then the FULL conform() contract runs on the result.
//
// MODEL-GATED like bootstrap-search-parity-1246.test.ts: skips VISIBLY when
// the embedding model isn't present rather than triggering a HuggingFace pull
// mid-suite. Its CI lane pre-downloads the model, so the gate opens there.
//
// PLACEMENT — test/integration-heavy/, its own CI job ("Integration Tests
// (heavy)" in .github/workflows/test.yml), NOT the main Integration job.
// Measured, not vibes: on a GitHub ubuntu-latest runner the 251-record seed
// took 253.4s of CPU embedding generation (vs 5.8s on an M-series dev
// machine, ~44x), and riding in the main Integration job pushed that lane to
// 30m21s — past its 30-minute ceiling — so the whole lane was cancelled with
// every already-passed result discarded (first two Integration runs on PR
// #1299). The main job's file glob (`find test/integration -name
// '*.test.ts'`) does not descend into this SIBLING directory (same structural
// exclusion test/integration-isolated/ relies on), so the seed cost stays
// isolated in a lane sized for it, and its runtime is visible as its own
// check instead of invisible pressure on someone else's ceiling.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, mkdir, cp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { TOOLS } from "../../resources/mcp-tools";
import { CORPUS, QUERIES } from "../bench/recall-harness/corpus-v2";
// The SAME assertion engine the connector-conformance suite runs — one checker,
// two drivers (it was extracted to this shared helper by flair#1290 precisely
// so this file could not drift into asserting a subset of the contract).
import { conform } from "../helpers/mcp-conformance";

const MODEL_FILE = "nomic-embed-text-v1.5.Q4_K_M.gguf";
function modelPresent(): boolean {
  const dirs = [process.env.FLAIR_MODELS_DIR, path.join(process.cwd(), "models")].filter(Boolean) as string[];
  return dirs.some((d) => existsSync(path.join(d, MODEL_FILE)));
}
const HAS_MODEL = modelPresent();
const gate = HAS_MODEL ? describe : describe.skip;
if (!HAS_MODEL) {
  console.warn(`[bootstrap-large-store-conformance] SKIPPING: embedding model ${MODEL_FILE} not found in FLAIR_MODELS_DIR or <cwd>/models.`);
}

const REPO_ROOT = process.cwd();
const FIXTURE = join(REPO_ROOT, "test", "fixtures", "inproc-app");

// Live-flint ownership skew (recordsPerAgentSorted, live-flint-2026-07.json),
// apportioned to the ACTUAL corpus size by largest remainder (Hamilton), then
// a 1-record floor taken from the largest holder (an agent with zero records
// isn't an agent). For the shipped 251-record corpus this yields
// [208, 15, 11, 9, 5, 1, 1, 1].
const LIVE_SKEW = [898, 64, 46, 41, 21, 4, 4, 2];
function apportion(skew: number[], total: number): number[] {
  const liveTotal = skew.reduce((a, b) => a + b, 0);
  const raw = skew.map((s) => (s * total) / liveTotal);
  const out = raw.map((r) => Math.floor(r));
  const byFrac = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  let left = total - out.reduce((a, b) => a + b, 0);
  for (let k = 0; left > 0; k++, left--) out[byFrac[k % byFrac.length].i]++;
  for (let i = 0; i < out.length; i++) {
    if (out[i] === 0) { out[i] = 1; out[out.indexOf(Math.max(...out))]--; }
  }
  return out;
}
const AGENT_RECORD_COUNTS = apportion(LIVE_SKEW, CORPUS.length);
const TOTAL = AGENT_RECORD_COUNTS.reduce((a, b) => a + b, 0);
// The content-selection budget the bootstrap fights under. 224 own records at
// corpus-v2's prose length need far more than this, so recent/task-relevant
// sub-budgets overflow and the truncation bookkeeping genuinely runs.
const MAX_TOKENS = 3000;

const sfx = Date.now().toString(36);
const agentIds = AGENT_RECORD_COUNTS.map((_, i) => `lsconf-a${i}-${sfx}`);
const HEAVY = agentIds[0];

// The bootstrap query: the first ground-truth query whose answer record falls
// in a LIGHT agent's slice and is not ephemeral (ephemeral stays private, so a
// private answer record would make the teammate-pool assertion vacuous).
const markerToIndex = new Map(CORPUS.map((r, i) => [r.marker, i] as const));
const HEAVY_COUNT = AGENT_RECORD_COUNTS[0];
const QUERY = QUERIES.find((q) => {
  const i = markerToIndex.get(q.expectMarker);
  return i !== undefined && i >= HEAVY_COUNT && CORPUS[i].durability !== "ephemeral";
});

let harper: HarperInstance;
let appDir: string;
let seedMs = 0;
let heavyLanded = 0;

async function fleet(op: string, body: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${harper.httpURL}/AgentFleet/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify({ op, ...body }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`AgentFleet ${op} → HTTP ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

async function tool(name: string, args: Record<string, unknown>, agentId: string): Promise<any> {
  const res = await fleet("mcpTool", { agentId, tool: name, args, isAdmin: false });
  expect(res.ok, `mcpTool ${name} as ${agentId} failed: ${JSON.stringify(res).slice(0, 500)}`).toBe(true);
  return res.value;
}

gate("flair#1290 — large-store bootstrap conformance (corpus-v2 across live-skew agents, real embeddings)", () => {
  beforeAll(async () => {
    appDir = await mkdtemp(join(tmpdir(), "flair-inproc-lsconf-"));
    await cp(FIXTURE, appDir, { recursive: true });
    await mkdir(join(appDir, "node_modules", "@tpsdev-ai"), { recursive: true });
    await symlink(REPO_ROOT, join(appDir, "node_modules", "@tpsdev-ai", "flair"), "dir");
    harper = await startHarper({ cwd: appDir, harperBinDir: REPO_ROOT });

    for (const id of agentIds) await fleet("register", { id });

    // Partition CORPUS in order over the skew and write through the REAL
    // memory_store path (genuine embeddings — this is what makes the store a
    // real HNSW candidate pool rather than 270 invisible rows).
    const t0 = Date.now();
    let cursor = 0;
    for (let a = 0; a < agentIds.length; a++) {
      const isHeavy = a === 0;
      for (let n = 0; n < AGENT_RECORD_COUNTS[a]; n++) {
        const rec = CORPUS[cursor++];
        const args: Record<string, unknown> = { content: rec.text, durability: rec.durability };
        // Light agents share their records so the caller's teammate retrieval
        // has a pool; ephemeral rows stay private (flair#1257 — the server
        // refuses ephemeral+shared). The heavy caller keeps the server's
        // durability-keyed default: own records are read back regardless.
        if (!isHeavy && rec.durability !== "ephemeral") args.visibility = "shared";
        const echo = await tool("memory_store", args, agentIds[a]);
        // The dedup gate FLAGS near-duplicates but never suppresses the write
        // (Memory.post's conservative-duplicate gate), so every acknowledged
        // store is a landed row — count them all.
        if (isHeavy && echo?.id) heavyLanded++;
      }
    }
    seedMs = Date.now() - t0;
    expect(cursor, "the whole corpus was partitioned").toBe(TOTAL);
  }, 900_000);

  afterAll(async () => {
    const dataDir = harper?.installDir;
    if (harper) await stopHarper(harper);
    if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 4 });
    if (appDir) await rm(appDir, { recursive: true, force: true });
  });

  test("the full declared contract holds on a store where the budget is actually fought over", async () => {
    expect(QUERY, "corpus-v2 must contain a ground-truth query answered by a light agent's non-ephemeral record").toBeDefined();
    const bootArgs = { currentTask: QUERY!.q, maxTokens: MAX_TOKENS };
    const t0 = Date.now();
    const body = await tool("bootstrap", bootArgs, HEAVY);
    const bootstrapMs = Date.now() - t0;
    console.log(`[large-store] seeded ${TOTAL} records across ${agentIds.length} agents in ${(seedMs / 1000).toFixed(1)}s; bootstrap took ${bootstrapMs}ms`);

    // ── The FULL declared contract, through the SAME engine the conformance
    // suite runs (no seededEvents: this fixture seeds no OrgEvent rows, so the
    // noOpEventsSuppressed seeded-row leg has nothing to key on; its
    // per-element leg still runs, and the suppression class is exercised with
    // its positive control in the conformance suite's fixture).
    conform("bootstrap", body, TOOLS.bootstrap.contract, { args: bootArgs });

    // ── The scale is REAL (each pinned so the workout can't silently shrink) ─
    // The independent own-count sees everything the write path acknowledged.
    expect(body.memoriesAvailable, "memoriesAvailable equals the heavy agent's landed writes").toBe(heavyLanded);
    expect(body.memoriesAvailable, "the heavy store really is large").toBeGreaterThan(200);
    // The budget genuinely truncated (this is the admission workout — a run
    // where nothing is truncated is NOT exercising the arithmetic).
    expect(body.memoriesIncluded, "some own memories admitted").toBeGreaterThan(0);
    expect(body.memoriesTruncated, "the tight budget really truncated own memories").toBeGreaterThan(0);
    // Cross-agent retrieval engaged: the scored pool saw teammate records
    // (the query's answer record belongs to a light agent and is shared).
    expect(body.teammateFindingsMatched, "teammate records entered the scored pool").toBeGreaterThan(0);
  }, 300_000);
});
