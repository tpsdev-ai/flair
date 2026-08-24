/**
 * types.ts — shared vocabulary for the flair-bench eval layers.
 *
 * Layer 1 (deterministic recall eval, #17) and Layer 2 (LongMemEval_s, #1216-b)
 * both describe their input as "session history to write into Flair" and their
 * retrieval as "context for a query", so those shapes live here once.
 */
import type { HarperEndpoint, TestAgent } from "./signed-fetch.js";

/** Durability level a memory is written at — mirrors Flair's Memory schema.
 *  Held fixed by the corpus for a deterministic eval; a Layer 2 ablation may
 *  vary it, which is exactly why it travels on the event, not the ingest opts. */
export type Durability = "permanent" | "persistent" | "standard" | "ephemeral";

/**
 * One turn / event of a conversation — the atomic unit Flair actually ingests.
 * Flair writes one Memory per event (`memory_service.py`'s
 * `_deterministic_record_id(app, user, session, event)`), so the bench ingests
 * at the SAME granularity: one Memory per SessionEvent. This is the locked
 * ingestion decision for #1216 (per-turn / per-event — the headline; any other
 * granularity is a labelled ablation, never the default).
 */
export interface SessionEvent {
  /** Stable id for this event. Becomes (part of) the Memory id, so a labelled
   *  relevance target can point at it. Required — the whole eval keys on it. */
  id: string;
  /** The memory text written to Flair. */
  content: string;
  /** Optional role (user/assistant/…) — carried for Layer 2 fidelity; Layer 1
   *  leaves it unset. Not written to the Memory body unless a future opt asks. */
  role?: string;
  /** Absolute creation time. Preserved verbatim so temporal ordering survives
   *  ingestion (LongMemEval's temporal ability depends on it). Accepts an ISO
   *  string or epoch ms. When omitted, ingest stamps `now` and records that it
   *  did — a bench must never silently invent a timestamp it depends on. */
  createdAt?: string | number;
  /** Durability the memory is written at. Defaults to "standard" when unset. */
  durability?: Durability;
}

/** A single session's ordered events. */
export interface SessionHistory {
  sessionId: string;
  events: SessionEvent[];
}

/** Everything the plumbing needs to reach a running ephemeral Harper as one
 *  identity. Bundled so `ingestSessionHistory` / `retrieveContext` match Kern's
 *  `(userId, …)` intent while keeping the transport explicit. */
export interface BenchClient {
  harper: HarperEndpoint;
  agent: TestAgent;
}

export interface IngestOptions {
  /** Ingestion granularity. Only "per-event" is implemented (the locked #1216
   *  decision); the field exists so a Layer 2 ablation is a labelled, explicit
   *  opt-in, never a silent default change. */
  granularity?: "per-event";
  /** Max concurrent writes. Kept modest — the ephemeral instance runs
   *  THREADS_COUNT=1 and the native embed engine serialises internally, so
   *  more concurrency buys queueing, not throughput. */
  concurrency?: number;
}

export interface IngestResult {
  /** How many Memory records were written (one per event). */
  written: number;
  /** Event ids, in write order — the id space the relevance labels reference. */
  ids: string[];
  /** True if any event lacked a createdAt and the ingest stamped `now`. A
   *  temporal eval that sees this true against a corpus it believed carried
   *  timestamps has a bug upstream, not a recall finding. */
  syntheticTimestamps: boolean;
  /** Wall-clock for the whole ingest pass (ms) — a one-time setup cost,
   *  reported separately from per-query latency. */
  elapsedMs: number;
}

export interface RetrieveOptions {
  /** Number of candidates to request. The eval retrieves WIDE (so the
   *  candidate pool covers the corpus — SemanticSearch's candidateLimit is
   *  limit×5) and scores at k afterwards. Defaults are chosen per corpus by the
   *  caller; see retrieve.ts. */
  limit?: number;
  /** Scoring mode. Defaults to "raw" — the production default since flair#623
   *  (composite's unconditional durability/recency multiplier was net-harmful
   *  to precision once hybrid retrieval went live). */
  scoring?: "raw" | "composite";
}

export interface RetrievedItem {
  id: string;
  score: number;
  content?: string;
  /** ISO createdAt of the memory as returned by SemanticSearch (DEFAULT_SELECT
   *  includes it). Layer 2's reader payload (v2-dated) prefixes each retrieved
   *  memory with its date so temporal questions have something to reason over. */
  createdAt?: string;
}

export interface RetrievedContext {
  /** Retrieved memory ids in rank order (rank 0 = best). The recall metrics
   *  consume exactly this. */
  rankedIds: string[];
  /** Full results (id + score + content) for callers that need more than ids
   *  (Layer 2's reader consumes the content). */
  items: RetrievedItem[];
  /** Round-trip wall-clock for this one query (ms). */
  latencyMs: number;
}
