/**
 * quality.ts — extracted from src/cli.ts (flair#1636, epic #1618).
 *
 * Pure move, ZERO behavior change: `flair quality` and `flair quality --emit` plus the pure metric-computation helpers (memory-quality-observability arc).
 * Shared cli-locals stay in cli.ts and are injected via bindCli() before
 * register(); this module never imports src/cli.ts. Top-level imports only
 * (no require(), #1653). Compiled strictly via tsconfig.check.src.json.
 */
import { Command } from "commander";
import { SigningIdentitySource } from "../lib/signing-identity.js";
import * as render from "../render.js";
import { EMBEDDING_STAMP_ID, describeStampOutstanding, resolveCurrentModelId } from "../stamp-outstanding.js";
import { join } from "node:path";

export type QualityCli = {
  api: (...args: any[]) => any;
  fetchHealthDetail: (...args: any[]) => any;
  publishOrgEvent: (...args: any[]) => any;
  relativeTime: (...args: any[]) => any;
  resolveSigningAgentId: (...args: any[]) => any;
  __pkgVersion: any;
};

let cli: QualityCli;

/** Bind the cli-locals this module depends on. */
export function bindCli(fns: QualityCli): void {
  cli = fns;
}

function api(...args: any[]): any {
  return cli.api(...args);
}

function fetchHealthDetail(...args: any[]): any {
  return cli.fetchHealthDetail(...args);
}

function publishOrgEvent(...args: any[]): any {
  return cli.publishOrgEvent(...args);
}

function relativeTime(...args: any[]): any {
  return cli.relativeTime(...args);
}

function resolveSigningAgentId(...args: any[]): any {
  return cli.resolveSigningAgentId(...args);
}

export const QUALITY_QUIET_THRESHOLD_DAYS = 7;

/** Mirrors resources/health.ts's own hash-fallback warning threshold (kept as
 *  a literal constant here rather than imported — health.ts computes its
 *  warning string server-side, this recomputes the same judgment CLI-side
 *  from the raw counts so quality doesn't depend on parsing warning text). */

export const QUALITY_HASH_FALLBACK_DEGRADED_PCT = 10;

/** Recall spot-check (Slice 1d) defaults — how many of the querying agent's
 *  own memories to sample, and the top-k depth each is searched at. Same
 *  "first-pass default, tunable later" spirit as the thresholds above. */

export const QUALITY_RECALL_SAMPLE_SIZE = 10;

export const QUALITY_RECALL_K = 5;

/**
 * Fields the recall spot-check and the quality-snapshot lookup actually
 * read. Harper REST `select(...)` (same syntax adk-flair-js's listMemories
 * already uses) projects these server-side so the nightly sweep never
 * pulls embedding vectors inline — the defect in flair#1360 was an
 * unfiltered `GET /Memory?agentId=…` that returned every row's 768-d
 * vector (~66 MB × 2 per `--emit` run on a 3k-row store) just to sample
 * 10 memories. `archived` is projected so the planner can drop basemented
 * rows before sampling (flair#857 — SemanticSearch excludes them, so an
 * archived row in the sample is a guaranteed miss). `type` is intentionally
 * omitted: it is not a declared Memory column (see schemas/memory.graphql);
 * snapshot exclusion keys off `subject` (`quality-snapshot/…`).
 */

export const QUALITY_MEMORY_LIST_SELECT = ["id", "subject", "content", "createdAt", "archived"] as const;

/**
 * Extra most-recent rows fetched beyond `sampleSize` so
 * `planRecallSpotCheck` can drop the sweep's own quality-snapshot
 * bookkeeping and still fill a 10-row window — without scanning the
 * table. Nightly `--emit` writes one snapshot per run; 16 is a buffer
 * for a few extra `--emit`s in the same recency window, not a second
 * full-table read.
 */

export const QUALITY_RECALL_SNAPSHOT_OVERFETCH = 16;

/** Injectable GET/POST used by the quality I/O helpers so tests can lock
 *  the Memory listing URL (flair#1360) without a live Harper. */

export type QualityApi = (
  method: string,
  path: string,
  body?: unknown,
  options?: { baseUrl?: string; keysDir?: string; agentId?: string | null },
) => Promise<any>;

/**
 * Harper REST collection path for the recall spot-check's sample fetch:
 * agent-scoped, projected (never `embedding`), recency-sorted, bounded.
 * `limit(start,end)` is Harper's offset window — same as
 * packages/adk-flair-js/src/memory_service.ts.
 */

export function qualityRecallSamplePath(
  agentId: string,
  sampleSize: number = QUALITY_RECALL_SAMPLE_SIZE,
): string {
  const select = QUALITY_MEMORY_LIST_SELECT.join(",");
  const end = sampleSize + QUALITY_RECALL_SNAPSHOT_OVERFETCH;
  return `/Memory?agentId=${encodeURIComponent(agentId)}&select(${select})&sort(-createdAt)&limit(0,${end})`;
}

/**
 * Harper REST collection path for the previous quality-snapshot lookup:
 * same projection as the sample fetch (never `embedding`). Subject is
 * passed as a query equals (indexed) plus a client-side re-filter —
 * Memory.search() historically did not turn bare query params into
 * conditions beyond the signed agent scope, so the client-side filter
 * in fetchPreviousQualitySnapshot stays as defense in depth. No `limit`:
 * a bounded window could miss yesterday's snapshot after a busy day of
 * writes, and without a reliable server-side subject pushdown that
 * would silently look like a first run.
 */

export function qualitySnapshotLookupPath(agentId: string, subject: string): string {
  const select = QUALITY_MEMORY_LIST_SELECT.join(",");
  return `/Memory?agentId=${encodeURIComponent(agentId)}&subject=${encodeURIComponent(subject)}&select(${select})&sort(-createdAt)`;
}


export interface QualityMetricGap {
  metric: string;
  reason: string;
}

/** Leading-word cap on the content-derived cue. 25, matching the arm of the
 *  flair#967 A/B that was actually measured (same 10 memories, same instance,
 *  same minute: subject cue → recall@5 0.60 / MRR 0.16; first-25-words-of-
 *  content cue → 1.00 / 0.78). Still a PARTIAL cue by construction — capped,
 *  never the whole memory for anything longer than the cap. */

const RECALL_CUE_CONTENT_WORD_LIMIT = 25;

/**
 * Is `subject` DISCRIMINATIVE enough to be handed to semantic search as a
 * query in its own right? (flair#967.)
 *
 * The old bar was `length >= 3`, which is a check on whether the subject
 * EXISTS, not on whether it is a query. Measured consequence: slug-shaped
 * subjects — `pr-1359`, `kern-2026-08-23`, the spot-check's own
 * `quality-snapshot/127.0.0.1:9926` — carry almost no semantic signal, so
 * searching one is a query for nothing in particular (searching `pr-1359` on
 * rockit production returned, as top-1, a review note about PR #1275 from five
 * days earlier). Worse, every memory sharing such a subject issues the
 * IDENTICAL query and gets the IDENTICAL result list, so siblings must
 * mutually displace each other and all but one are scored as misses no matter
 * how healthy retrieval is.
 *
 * The rule, stated plainly — a subject is used as the cue only when it is:
 *   1. at least 3 characters (the original bar, kept), AND
 *   2. NOT opaque-identifier-shaped: an unspaced token carrying a digit or an
 *      identifier separator (`/ : _ . # @ \`) is a slug, not a phrase.
 *      Whitespace is the primary discriminator — `Harper 5.2 upgrade` is
 *      prose and stays a cue; `kern-2026-08-23` is not. A bare hyphen does
 *      NOT make a slug, so ordinary compounds (`two-gate`) survive, AND
 *   3. carrying at least one alphabetic run of 3+ characters — a subject with
 *      no word in it (`---`, `42`) is not a query either.
 *
 * Fails CLOSED: anything that isn't clearly a phrase falls back to content,
 * which the A/B measured as the strictly better cue. Pure — no I/O.
 */

export function isDiscriminativeSubject(subject: string | null | undefined): boolean {
  const s = (subject ?? "").trim();
  if (s.length < 3) return false;
  if (!/\s/.test(s) && /[0-9/:_.#@\\]/.test(s)) return false;
  if (!/[A-Za-z]{3}/.test(s)) return false;
  return true;
}

/**
 * Derive a PARTIAL search cue from a memory — used by the recall spot-check
 * (Slice 1d) to query for a memory without handing back its full content.
 * Prefers `subject` ONLY when it is discriminative (isDiscriminativeSubject
 * above — flair#967); otherwise falls back to the first sentence of
 * `content`, capped to the leading ~25 words so the cue stays a genuine
 * partial cue rather than the whole memory. Pure — no I/O.
 */

export function deriveRecallCue(memory: { subject?: string | null; content?: string | null }): string {
  const subject = (memory.subject ?? "").trim();
  if (isDiscriminativeSubject(subject)) return subject;
  const content = (memory.content ?? "").trim();
  if (!content) return "";
  const sentenceMatch = content.match(/^[^.!?\n]+[.!?]?/);
  const firstSentence = (sentenceMatch ? sentenceMatch[0] : content).trim();
  const words = firstSentence.split(/\s+/).filter(Boolean);
  const cueWordLimit = RECALL_CUE_CONTENT_WORD_LIMIT;
  return words.length <= cueWordLimit ? firstSentence : words.slice(0, cueWordLimit).join(" ");
}


export interface RecallSpotCheckScore {
  /** Fraction of sampled memories whose own id appeared in its search's top-k. */
  recallAtK: number;
  /** Mean reciprocal rank of the target memory across the sample (0 for a miss). */
  mrr: number;
  sampleSize: number;
  k: number;
}

/**
 * Pure scorer for the recall spot-check (Slice 1d): given the ids of the
 * sampled memories and, for each, the list of memory ids its derived-cue
 * search returned (already agent-scoped via the same read path `flair
 * memory search` uses), compute recall@k + MRR. `perQueryResultIds[i]` is
 * truncated to the first `k` entries here (not assumed pre-truncated by the
 * caller) so a caller that over-fetches still gets a correct top-k score.
 * Never throws; an empty sample scores 0/0 rather than dividing by zero —
 * callers are expected to treat an empty sample as a `gaps` case, not a
 * real 0.0 score (see fetchRecallSpotCheckData / computeQualityReport).
 */

export function computeRecallSpotCheck(
  sampledIds: string[],
  perQueryResultIds: string[][],
  k: number,
): RecallSpotCheckScore {
  const sampleSize = sampledIds.length;
  if (sampleSize === 0) {
    return { recallAtK: 0, mrr: 0, sampleSize: 0, k };
  }
  let hits = 0;
  let reciprocalSum = 0;
  for (let i = 0; i < sampleSize; i++) {
    const targetId = sampledIds[i];
    const topK = (perQueryResultIds[i] ?? []).slice(0, k);
    const rank = topK.indexOf(targetId);
    if (rank !== -1) {
      hits += 1;
      reciprocalSum += 1 / (rank + 1);
    }
  }
  return {
    recallAtK: Math.round((hits / sampleSize) * 100) / 100,
    mrr: Math.round((reciprocalSum / sampleSize) * 100) / 100,
    sampleSize,
    k,
  };
}

/**
 * The I/O ↔ pure boundary for the recall spot-check: what
 * fetchRecallSpotCheckData (below) hands to computeQualityReport.
 * `ok: false` covers every graceful-degradation case (no agent identity,
 * too few memories to sample, a search error) — always via `skipReason`,
 * never a partial/malformed `ok: true`.
 */

export interface RecallSpotCheckFetchResult {
  ok: boolean;
  agentId?: string;
  /** ids of the sampled memories, in sample order. */
  sampledIds?: string[];
  /** perQueryResultIds[i] = the ids returned by searching sampledIds[i]'s derived cue. */
  perQueryResultIds?: string[][];
  k?: number;
  /** Present when ok is false — why the spot-check was skipped. */
  skipReason?: string;
  /** Present whenever a window was actually assembled (healthy or not) —
   *  flair#967's fail-closed sample guard. `healthy: false` is the one skip
   *  reason that is a statement ABOUT THE SAMPLE rather than about the
   *  instance, so it's carried structurally, not just in prose. */
  sampleHealth?: RecallSampleHealth;
}

/**
 * Can the sampled window be scored fairly at all? (flair#967, direction 4 in
 * the issue — "an alert that cannot explain itself cannot be triaged", made
 * structural.)
 *
 * The spot-check scores each sampled memory by searching ONE cue and asking
 * whether that memory came back. If two sampled memories derive the SAME cue,
 * they are one query with one answer list, so at most one of them can be found
 * and the rest are counted as misses no matter how healthy retrieval is. That
 * is not a low score, it is an UNSCORABLE window — and the honest output is to
 * say so rather than to publish the number anyway.
 */

export interface RecallSampleHealth {
  healthy: boolean;
  /** Self-describing, human-readable — becomes the `gaps` entry's reason. */
  reason?: string;
  /** The cue values that more than one sampled memory derived. */
  duplicateCues?: string[];
  /** How many sampled memories derived NO cue at all (no subject, no content). */
  emptyCueCount?: number;
}

/** What planRecallSpotCheck decided: which memories to query, with what cue,
 *  and whether the resulting window is scorable. */

export interface RecallSpotCheckPlan {
  sampled: Array<{ id: string; cue: string }>;
  health: RecallSampleHealth;
  /** How many of the tool's own quality-snapshot rows were excluded before
   *  sampling (flair#967 cause 2 — self-referential bookkeeping is never
   *  scored: its subject is a hostname slug and its content is boilerplate
   *  JSON, so it is a guaranteed miss and a permanent constant penalty). */
  excludedSnapshotRows: number;
  /** How many archived (basemented) rows were dropped before sampling
   *  (flair#857 — SemanticSearch excludes them, so they cannot be scored). */
  excludedArchivedRows: number;
}

/** Rows the spot-check writes itself, and therefore must never grade itself
 *  on — see RecallSpotCheckPlan['excludedSnapshotRows']. */

function isQualitySnapshotRow(m: { subject?: string | null; type?: string | null }): boolean {
  return m?.type === "quality-snapshot" || (m?.subject ?? "").startsWith("quality-snapshot/");
}

/**
 * Pure planner for the recall spot-check: raw memory rows → the window to
 * query (id + cue) plus that window's health. Extracted from
 * fetchRecallSpotCheckData so the sampling, cue-derivation and
 * fail-closed health rules are testable without any I/O (flair#967).
 *
 * Order of operations, and why:
 *  1. drop archived rows (SemanticSearch excludes them — flair#857 — so a
 *     basemented row in the sample is a guaranteed miss, not a recall signal);
 *  2. drop the tool's own quality-snapshot rows (never grade your own
 *     bookkeeping);
 *  3. take the `sampleSize` most-recently-written remaining rows (unchanged —
 *     recency is still the sampling frame; see the issue's direction 3 for the
 *     stratified-sampling follow-up this deliberately does NOT take on);
 *  4. derive each cue via deriveRecallCue;
 *  5. judge the window: any duplicate cue, or any empty cue, makes it
 *     UNSCORABLE — reported as unhealthy, never silently scored.
 */

export function planRecallSpotCheck(
  memories: Array<{ id?: unknown; subject?: string | null; content?: string | null; createdAt?: string | null; type?: string | null; archived?: boolean | null }>,
  opts: { sampleSize?: number } = {},
): RecallSpotCheckPlan {
  const sampleSize = opts.sampleSize ?? QUALITY_RECALL_SAMPLE_SIZE;
  const rows = Array.isArray(memories) ? memories : [];
  // `archived !== true` matches SemanticSearch / AdminMemory: unset and
  // false stay in the live pool; only an explicit basement is dropped.
  const live = rows.filter((m) => m?.archived !== true);
  const scorable = live.filter((m) => !isQualitySnapshotRow(m ?? {}));
  const excludedArchivedRows = rows.length - live.length;
  const excludedSnapshotRows = live.length - scorable.length;

  const sorted = scorable.slice().sort((a: any, b: any) => {
    const ta = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });
  const sampled = sorted.slice(0, sampleSize).map((m: any) => ({ id: String(m?.id), cue: deriveRecallCue(m ?? {}) }));

  const counts = new Map<string, number>();
  let emptyCueCount = 0;
  for (const s of sampled) {
    if (!s.cue) {
      emptyCueCount += 1;
      continue;
    }
    counts.set(s.cue, (counts.get(s.cue) ?? 0) + 1);
  }
  const duplicateCues = [...counts.entries()].filter(([, n]) => n > 1).map(([cue]) => cue);

  if (duplicateCues.length === 0 && emptyCueCount === 0) {
    return { sampled, health: { healthy: true }, excludedSnapshotRows, excludedArchivedRows };
  }

  const parts: string[] = [];
  if (duplicateCues.length > 0) {
    const shown = duplicateCues.slice(0, 3).map((c) => `"${c.length > 60 ? `${c.slice(0, 57)}...` : c}"`).join(", ");
    const dupMemberCount = duplicateCues.reduce((n, c) => n + (counts.get(c) ?? 0), 0);
    parts.push(
      `${dupMemberCount} of the ${sampled.length} sampled memories derive the same cue as another (${shown}${duplicateCues.length > 3 ? `, +${duplicateCues.length - 3} more` : ""}) — identical cues are one query with one result list, so those memories must displace each other and cannot all be found`,
    );
  }
  if (emptyCueCount > 0) {
    parts.push(`${emptyCueCount} of the ${sampled.length} sampled memories have no derivable cue (no subject and no content)`);
  }
  return {
    sampled,
    health: {
      healthy: false,
      reason: `sample unhealthy — ${parts.join("; ")}. No score recorded for this run (flair#967: fail closed rather than publish an unscorable number).`,
      duplicateCues,
      emptyCueCount,
    },
    excludedSnapshotRows,
    excludedArchivedRows,
  };
}


export interface QualityAgentActivity {
  id: string;
  memoryCount: number;
  writes24h: number;
  lastWriteAt: string | null;
  /** null when the agent has never written (nothing to measure "days since" from). */
  daysSinceLastWrite: number | null;
  /** true if daysSinceLastWrite >= QUALITY_QUIET_THRESHOLD_DAYS, or the agent has never written. */
  quiet: boolean;
}


export interface QualityReport {
  agentFilter: string | null;
  instance: {
    up: boolean;
    /** null when /HealthDetail returned no migrations block at all. */
    migrationsClean: boolean | null;
    haltedMigrations: Array<{ id: string; state: string; reason?: string }>;
    embeddingsStatus: "ok" | "degraded" | "unknown";
    embeddingsDetail: string;
  };
  embeddingCoverage: {
    total: number;
    withEmbeddings: number;
    hashFallback: number;
    coveragePct: number;
  } | null;
  staleness: {
    scope: "instance";
    total: number;
    expired: number;
    stalePct: number;
  } | null;
  signalDensity: {
    /** "write-and-citation" once /HealthDetail's per-agent rows carry
     *  usageCount (current server); "write-volume" when talking to an older
     *  server that predates it (degraded — see module doc above). */
    scope: "write-volume" | "write-and-citation";
    perAgent: Array<{
      id: string;
      memoryCount: number;
      writes24h: number;
      lastWriteAt: string | null;
      /** Only present when scope === "write-and-citation". */
      usageCount?: number;
      /** Average uses per memory — memoryCount > 0 ? round(usageCount / memoryCount, 2) : 0.
       *  Only present when scope === "write-and-citation". A usage-density
       *  signal, not a trust/quality verdict — see module doc above. */
      citationRate?: number;
    }>;
  } | null;
  quietAgents: {
    thresholdDays: number;
    perAgent: QualityAgentActivity[];
    quietCount: number;
  } | null;
  /**
   * flair-quality Slice 1c: instance-wide near-duplicate CLUSTER count,
   * read from /HealthDetail's `dedup` field (resources/health.ts), which in
   * turn is a cheap read of a small stat file a nightly server-side REM
   * step computes (resources/MemoryDedupStats.ts) — see that file + Slice
   * 1c's spec for why the computation is server-side (embeddings never
   * leave the server) and why storage is NOT this field's own new endpoint.
   * `null` when the server hasn't computed one yet (fresh instance, REM
   * nightly not yet run, or an older server that predates this field) —
   * NEVER a false zero; always paired with a `gaps` entry in that case.
   * An ops/health signal ("is memory silting up with duplicates"), never a
   * trust judgment — same framing discipline as signalDensity/quietAgents.
   */
  dedupClusters: {
    clusterCount: number;
    largestClusterSize: number;
    totalMemoriesInClusters: number;
    /** ISO timestamp of the REM nightly cycle that computed this — the
     *  stat is only ever as fresh as the last nightly run. */
    computedAt: string;
  } | null;
  /**
   * flair-quality Slice 1d: recall SPOT-CHECK — is semantic search actually
   * functioning right now, or has it quietly broken (embeddings down, index
   * busted)? A cheap, instance-agnostic HEALTH SIGNAL, NOT a benchmark and
   * NOT a trust judgment (see computeRecallSpotCheck + fetchRecallSpotCheckData
   * doc above for the full framing). For a sample of the querying agent's
   * own memories, each is searched for via a cue DERIVED from itself,
   * through the exact same authenticated read path `flair memory search`
   * uses (api() → authedRequest, POST /SemanticSearch) — no new endpoint.
   * `agentId` is the identity the spot-check queried AS (the --agent value,
   * or FLAIR_AGENT_ID). `null` when there's no agent identity to query as,
   * too few scorable memories to sample, the sampled window was UNHEALTHY
   * (duplicate/empty cues — flair#967's fail-closed guard), or a search
   * errored — NEVER a false 0.0 masquerading as a real (broken) score, and
   * never a number computed over a window that could not produce one; always
   * paired with a `gaps` entry carrying the reason.
   *
   * REPORT-ONLY since flair#967: this number is printed and snapshotted for
   * observability, and emits no OrgEvent at any delta. Recall REGRESSIONS are
   * detected by test/integration-heavy/recall-eval-gate.test.ts.
   */
  recallSpotCheck: {
    agentId: string | null;
    /** Fraction of sampled memories whose own id appeared in its search's top-k. */
    recallAtK: number;
    /** Mean reciprocal rank of the target memory across the sample (0 if not in top-k). */
    mrr: number;
    sampleSize: number;
    k: number;
  } | null;
  gaps: QualityMetricGap[];
}

/**
 * Pure computation: /HealthDetail response (+ reachability) → quality report.
 * Never throws — every missing data source degrades to a null section + a
 * `gaps` entry (same graceful-degradation contract as `flair doctor`), so a
 * partially-populated instance still gets a partial, honest report instead
 * of a crash.
 *
 * `opts.recallSpotCheckData` is the ONE exception to "fed purely from
 * /HealthDetail": the recall spot-check (Slice 1d) requires live queries
 * (fetchRecallSpotCheckData, run by the `quality` command BEFORE calling
 * here, same "I/O happens outside, this function only computes" split as
 * fetchHealthDetail/computeQualityReport itself). Passing nothing degrades
 * to a `gaps` entry, same as every other metric.
 */

export function computeQualityReport(
  healthy: boolean,
  healthData: any,
  opts: { agentId?: string | null; now?: number; recallSpotCheckData?: RecallSpotCheckFetchResult } = {},
): QualityReport {
  const now = opts.now ?? Date.now();
  const agentFilter = opts.agentId ?? null;
  const gaps: QualityMetricGap[] = [];

  // ── Instance health: migrations ──
  let migrationsClean: boolean | null = null;
  let haltedMigrations: Array<{ id: string; state: string; reason?: string }> = [];
  const migList = healthData?.migrations?.migrations;
  if (Array.isArray(migList)) {
    haltedMigrations = migList
      .filter((m: any) => m?.state === "halted" || m?.state === "failed")
      .map((m: any) => ({ id: m.id, state: m.state, reason: m.reason }));
    migrationsClean = haltedMigrations.length === 0;
  } else {
    gaps.push({ metric: "instance.migrationsClean", reason: "no migrations block in /HealthDetail response" });
  }

  // ── Instance health: embeddings operational ──
  // Inferred from stored coverage stats (hash-fallback %, mixed embedding
  // models) — NOT a live semantic round-trip like `flair doctor` runs
  // (verifySemanticSearch writes a probe memory to verify recall-by-meaning,
  // which this read-only command must not do).
  let embeddingsStatus: "ok" | "degraded" | "unknown" = "unknown";
  let embeddingsDetail = "no memory stats available";
  const memories = healthData?.memories;
  if (memories && typeof memories.total === "number") {
    if (memories.total === 0) {
      embeddingsDetail = "no memories written yet";
    } else {
      const hashFallback = memories.hashFallback ?? 0;
      const pct = Math.round((hashFallback / memories.total) * 100);
      const modelCounts = (memories.modelCounts ?? {}) as Record<string, number>;
      const migBlock = healthData?.migrations;
      const stampRow = Array.isArray(migBlock?.migrations)
        ? migBlock.migrations.find((m: { id?: string }) => m?.id === EMBEDDING_STAMP_ID)
        : undefined;
      const stamp = describeStampOutstanding({
        modelCounts,
        currentModelId: resolveCurrentModelId(modelCounts),
        audience: "client",
        cyclePhase: typeof migBlock?.cyclePhase === "string" ? migBlock.cyclePhase : undefined,
        lastCycleError:
          typeof migBlock?.lastCycleError === "string"
            ? migBlock.lastCycleError
            : migBlock?.lastCycleError === null
              ? null
              : undefined,
        migration: stampRow && typeof stampRow.state === "string"
          ? {
              id: EMBEDDING_STAMP_ID,
              state: stampRow.state,
              rowsDone: stampRow.rowsDone,
              rowsRemaining: stampRow.rowsRemaining,
              reason: stampRow.reason,
            }
          : undefined,
      });
      if (pct >= QUALITY_HASH_FALLBACK_DEGRADED_PCT) {
        embeddingsStatus = "degraded";
        embeddingsDetail = `${hashFallback}/${memories.total} (${pct}%) memories are hash-fallback`;
      } else if (stamp.outstanding) {
        embeddingsStatus = "degraded";
        embeddingsDetail = stamp.warning;
      } else {
        embeddingsStatus = "ok";
        embeddingsDetail = `${memories.total - hashFallback}/${memories.total} memories have real embeddings`;
      }
    }
  }

  // ── Embedding coverage ──
  let embeddingCoverage: QualityReport["embeddingCoverage"] = null;
  if (memories && typeof memories.total === "number") {
    const total = memories.total;
    const hashFallback = memories.hashFallback ?? 0;
    const withEmbeddings = typeof memories.withEmbeddings === "number" ? memories.withEmbeddings : Math.max(0, total - hashFallback);
    const coveragePct = total > 0 ? Math.round((withEmbeddings / total) * 100) : 0;
    embeddingCoverage = { total, withEmbeddings, hashFallback, coveragePct };
  } else {
    gaps.push({ metric: "embeddingCoverage", reason: "no memory stats available in /HealthDetail response" });
  }

  // ── Staleness (instance-wide only — see module doc above) ──
  let staleness: QualityReport["staleness"] = null;
  if (memories && typeof memories.total === "number" && typeof memories.expired === "number") {
    const total = memories.total;
    const expired = memories.expired;
    const stalePct = total > 0 ? Math.round((expired / total) * 100) : 0;
    staleness = { scope: "instance", total, expired, stalePct };
    gaps.push({
      metric: "staleness",
      reason: "instance-wide only — /HealthDetail's `expired` count isn't broken down per agent, so --agent doesn't scope this metric; the \"old + never-recalled\" dead-weight variant also isn't computed (no read API exposes per-memory last-recalled data)",
    });
  } else {
    gaps.push({ metric: "staleness", reason: "no expired-memory count available in /HealthDetail response" });
  }

  // ── Per-agent rows (shared source for signal density + quiet agents) ──
  const perAgentAll: Array<{
    id: string;
    memoryCount: number;
    hashFallback: number;
    writes24h: number;
    lastWriteAt: string | null;
    /** Absent (not 0) when talking to a server that predates Slice 1b's
     *  /HealthDetail aggregation — see module doc above. */
    usageCount?: number;
  }> = Array.isArray(healthData?.agents?.perAgent) ? healthData.agents.perAgent : [];
  const havePerAgent = Array.isArray(healthData?.agents?.perAgent);
  const scopedAgents = agentFilter ? perAgentAll.filter((r) => r.id === agentFilter) : perAgentAll;
  // Detected from the UNFILTERED rows (not scopedAgents) so `--agent` never
  // masquerades server capability as data-scoping — vacuously true on an
  // empty perAgent array (nothing to prove otherwise, and both scopes render
  // identically empty either way).
  const haveUsageCount = perAgentAll.every((r) => typeof r.usageCount === "number");

  // ── Signal density (write volume, + citation rate when the server supports it) ──
  let signalDensity: QualityReport["signalDensity"] = null;
  if (havePerAgent && haveUsageCount) {
    signalDensity = {
      scope: "write-and-citation",
      perAgent: scopedAgents.map((r) => {
        const usageCount = r.usageCount ?? 0;
        const citationRate = r.memoryCount > 0 ? Math.round((usageCount / r.memoryCount) * 100) / 100 : 0;
        return { id: r.id, memoryCount: r.memoryCount, writes24h: r.writes24h, lastWriteAt: r.lastWriteAt, usageCount, citationRate };
      }),
    };
  } else if (havePerAgent) {
    signalDensity = {
      scope: "write-volume",
      perAgent: scopedAgents.map((r) => ({ id: r.id, memoryCount: r.memoryCount, writes24h: r.writes24h, lastWriteAt: r.lastWriteAt })),
    };
    gaps.push({
      metric: "signalDensity",
      reason: "citation rate unavailable — server predates per-agent usageCount in /HealthDetail; upgrade the server",
    });
  } else {
    gaps.push({ metric: "signalDensity", reason: "no per-agent stats available in /HealthDetail response" });
  }

  // ── Quiet agents (ops fact — not a trust signal) ──
  let quietAgents: QualityReport["quietAgents"] = null;
  if (havePerAgent) {
    const rows: QualityAgentActivity[] = scopedAgents.map((r) => {
      const daysSinceLastWrite = r.lastWriteAt ? Math.floor((now - new Date(r.lastWriteAt).getTime()) / 86_400_000) : null;
      const quiet = daysSinceLastWrite === null ? true : daysSinceLastWrite >= QUALITY_QUIET_THRESHOLD_DAYS;
      return { id: r.id, memoryCount: r.memoryCount, writes24h: r.writes24h, lastWriteAt: r.lastWriteAt, daysSinceLastWrite, quiet };
    });
    quietAgents = { thresholdDays: QUALITY_QUIET_THRESHOLD_DAYS, perAgent: rows, quietCount: rows.filter((r) => r.quiet).length };
  } else {
    gaps.push({ metric: "quietAgents", reason: "no per-agent stats available in /HealthDetail response" });
  }

  // ── Dedup clusters (instance-wide near-duplicate count — flair-quality
  // Slice 1c) — an ops/health signal, not a trust judgment (see module doc
  // and QualityReport['dedupClusters'] doc above). Always instance-wide;
  // --agent does not scope it (matches staleness's precedent — the
  // underlying stat has no per-agent breakdown, by design: per-memory
  // cluster membership is a disclosure surface Sherlock's review explicitly
  // ruled out storing at all).
  let dedupClusters: QualityReport["dedupClusters"] = null;
  const dedup = healthData?.dedup;
  if (
    dedup &&
    typeof dedup.clusterCount === "number" &&
    typeof dedup.largestClusterSize === "number" &&
    typeof dedup.totalMemoriesInClusters === "number" &&
    typeof dedup.computedAt === "string"
  ) {
    dedupClusters = {
      clusterCount: dedup.clusterCount,
      largestClusterSize: dedup.largestClusterSize,
      totalMemoriesInClusters: dedup.totalMemoriesInClusters,
      computedAt: dedup.computedAt,
    };
  } else {
    gaps.push({
      metric: "dedupClusters",
      reason: "no dedup-cluster stat yet — computed nightly by REM (see `flair rem nightly enable`); run `flair rem nightly run-once` or wait for the first scheduled cycle",
    });
  }

  // ── Recall spot-check (flair-quality Slice 1d) — see module doc above and
  // QualityReport['recallSpotCheck'] doc for the full framing. Fed by
  // fetchRecallSpotCheckData's already-fetched raw ids (not by healthData —
  // this is the one metric here that needed a live query, not a
  // /HealthDetail read); scored by the pure computeRecallSpotCheck.
  let recallSpotCheck: QualityReport["recallSpotCheck"] = null;
  const rsc = opts.recallSpotCheckData;
  if (rsc?.ok && rsc.sampledIds && rsc.perQueryResultIds && typeof rsc.k === "number") {
    const scored = computeRecallSpotCheck(rsc.sampledIds, rsc.perQueryResultIds, rsc.k);
    recallSpotCheck = { agentId: rsc.agentId ?? agentFilter ?? null, ...scored };
  } else {
    gaps.push({
      metric: "recallSpotCheck",
      reason: rsc?.skipReason ?? "recall spot-check not attempted — no data passed to computeQualityReport",
    });
  }

  return {
    agentFilter,
    instance: { up: healthy, migrationsClean, haltedMigrations, embeddingsStatus, embeddingsDetail },
    embeddingCoverage,
    staleness,
    signalDensity,
    quietAgents,
    dedupClusters,
    recallSpotCheck,
    gaps,
  };
}

/**
 * The I/O half of the recall spot-check (Slice 1d): fetch a sample of
 * `agentId`'s own memories and, for each, search for a cue derived from it.
 * Reuses the EXACT read path `flair memory search` / `flair memory list`
 * use — `api()` (→ authedRequest's 5-tier resolver) for both the
 * projected, bounded `GET /Memory?…&select(…)&limit(…)` sample fetch
 * (flair#1360 — never the unfiltered collection with embeddings inline)
 * and the `POST /SemanticSearch` queries — so this has zero new endpoint
 * and zero new auth mechanism; it is scoped to `agentId`'s own memories
 * exactly as those commands already are. Never throws: every failure mode
 * (no agentId, fewer than `sampleSize` memories, a fetch/search error)
 * returns `{ ok: false, skipReason }` for computeQualityReport to turn
 * into a `gaps` entry.
 */

export async function fetchRecallSpotCheckData(
  agentId: string | null,
  baseUrl: string,
  opts: { sampleSize?: number; k?: number; request?: QualityApi } = {},
): Promise<RecallSpotCheckFetchResult> {
  const sampleSize = opts.sampleSize ?? QUALITY_RECALL_SAMPLE_SIZE;
  const k = opts.k ?? QUALITY_RECALL_K;
  const request = opts.request ?? api;

  if (!agentId) {
    return { ok: false, skipReason: "no agent identity to query as — pass --agent or set FLAIR_AGENT_ID" };
  }

  let all: any[];
  try {
    const raw = await request("GET", qualityRecallSamplePath(agentId, sampleSize), undefined, { baseUrl, agentId });
    all = Array.isArray(raw) ? raw : (raw?.results ?? raw?.items ?? []);
  } catch (err: any) {
    return { ok: false, agentId, skipReason: `could not fetch memories to sample: ${err?.message ?? String(err)}` };
  }

  // Deterministic sample + cue derivation + fail-closed health judgment, all
  // pure (planRecallSpotCheck above). Archived rows (flair#857) and snapshot
  // rows are excluded there, so the "enough memories" check has to run on the
  // PLANNED window, not on the raw row count — an instance whose recent writes
  // are mostly basemented or the sweep's own bookkeeping should skip with a
  // reason, not score a short window.
  const plan = planRecallSpotCheck(all, { sampleSize });
  if (plan.sampled.length < sampleSize) {
    const exclusionParts: string[] = [];
    if (plan.excludedArchivedRows > 0) {
      exclusionParts.push(
        `${plan.excludedArchivedRows} archived row(s) excluded — SemanticSearch cannot return basemented memories; restore with \`flair memory restore <id>\` if they should be live`,
      );
    }
    if (plan.excludedSnapshotRows > 0) {
      exclusionParts.push(
        `${plan.excludedSnapshotRows} quality-snapshot row(s) excluded — the spot-check never grades its own bookkeeping`,
      );
    }
    const excluded = exclusionParts.length > 0 ? ` (${exclusionParts.join("; ")})` : "";
    return {
      ok: false,
      agentId,
      skipReason: `agent '${agentId}' has ${plan.sampled.length} scorable memories, fewer than the ${sampleSize} needed to sample${excluded}`,
    };
  }

  // flair#967: a window whose cues collide cannot be scored fairly — report
  // that fact instead of a number, and don't spend the searches either.
  if (!plan.health.healthy) {
    return { ok: false, agentId, skipReason: plan.health.reason, sampleHealth: plan.health };
  }

  const sampledIds: string[] = [];
  const perQueryResultIds: string[][] = [];
  try {
    for (const { id, cue } of plan.sampled) {
      const body = { agentId, q: cue, limit: k };
      const res = await request("POST", "/SemanticSearch", body, { baseUrl, agentId });
      const results: any[] = Array.isArray(res) ? res : (res?.results ?? []);
      sampledIds.push(id);
      perQueryResultIds.push(results.map((r: any) => String(r.id)));
    }
  } catch (err: any) {
    return { ok: false, agentId, skipReason: `recall spot-check search failed: ${err?.message ?? String(err)}` };
  }

  return { ok: true, agentId, sampledIds, perQueryResultIds, k, sampleHealth: plan.health };
}

// ─── flair quality --emit (Slice 2 of the memory-quality-observability arc:
// quality OrgEvents) ─────────────────────────────────────────────────────────
//
// Design (K&S-approved in the arc round, honored exactly here):
//
// - NO schema change, NO new table/resource. Events ride the existing
//   OrgEvent surface (schemas/event.graphql: kind/scope/summary/detail/
//   targetIds/refId — see `flair orgevent` above) via the exact same
//   PUT /OrgEvent/{id} write shape, extracted into `publishOrgEvent()` below
//   so both commands share one call site rather than two hand-rolled fetches.
// - The threshold/diff DECISION is CLI-side (diffQualitySnapshots, pure,
//   fixture-tested below); emission is a thin write via that existing
//   surface. Kind is one of two: `quality.threshold_crossed` (an absolute
//   line was crossed since the last snapshot) or `quality.regression` (a
//   metric moved backward by more than its delta threshold since the last
//   snapshot) — see QualityEventFinding.
// - Snapshots are stored AS Flair memories (durability persistent, subject
//   `quality-snapshot/<host>` — qualitySnapshotSubject() below) — free
//   history + search, dogfoods the product, no new storage surface. Content
//   is the COMPACT numeric core only (QualitySnapshotCore), never the full
//   human report — see buildQualitySnapshot().
// - Sherlock's constraint: events carry BEHAVIORAL FACTS only, never trust
//   judgments — "embedding coverage dropped to 85% (threshold 90%)", never
//   "agent X is low quality". Every summary string below is written to that
//   discipline; keep it that way in any future edit here.
// - Edge-triggered, not level-triggered: every threshold/regression check
//   below fires only on the TRANSITION since the immediately-previous
//   snapshot (e.g. quietAgents requires "was NOT quiet last snapshot, IS
//   quiet now" — the spec's own "NEWLY quiet" wording), not on every run
//   while a condition merely persists. Without this, a metric that stays
//   below threshold across many `--emit` runs would re-emit an event every
//   single run — pure noise. First run (no previous snapshot) therefore
//   always emits nothing (diffQualitySnapshots(current, null) === []) — there
//   is no prior state to diff against, so nothing can have "crossed" or
//   "regressed" yet; that run only establishes the baseline.
// - Missing data (a null/gap section on either side of the diff) never
//   produces an event — absence of data is a gap, not a regression. Encoded
//   by requiring BOTH current and previous to carry a given metric before
//   diffing it at all.

/** First-pass defaults for the Slice 2 diff/thresholds — same "documented
 *  heuristic, tunable later against a real fleet" spirit as
 *  QUALITY_QUIET_THRESHOLD_DAYS / QUALITY_HASH_FALLBACK_DEGRADED_PCT above.
 *  Deliberately NOT exposed as CLI flags (per the arc design: the diff
 *  decision stays CLI-side and legible in one place, not ad-hoc per
 *  invocation) — change these constants and their fixture tests together. */

export const QUALITY_EVENT_COVERAGE_ABS_THRESHOLD_PCT = 90;

export const QUALITY_EVENT_COVERAGE_DROP_THRESHOLD_PCT = 5;

export const QUALITY_EVENT_STALENESS_ABS_THRESHOLD_PCT = 10;
/**
 * RETAINED AT ITS ORIGINAL VALUE AND DELIBERATELY UNWIRED (flair#967).
 *
 * Nothing in diffQualitySnapshots reads this any more — the recall spot-check
 * is report-only and emits no event at any delta (see the Slice 1d framing in
 * the module doc for the 32-run σ = 0.291 / precision-0 measurement behind
 * that). The constant stays, unchanged at 0.2, as the standing evidence that
 * the fix was "remove alerting authority from a metric that never earned it",
 * NOT "widen the gate until it stops talking" — a silenced check and a
 * de-authorised one look identical in a changelog and are opposites in
 * practice, and 0.2 sitting here at 0.69σ is the arithmetic that makes the
 * difference legible. If this probe is ever re-armed, the replacement
 * threshold must be DERIVED from the measured run-to-run variance of the
 * FIXED cue derivation, not typed in — do not just re-reference this literal.
 * Asserted unchanged by test/unit/quality-recall-spotcheck-967.test.ts.
 */

export const QUALITY_EVENT_RECALL_DROP_THRESHOLD = 0.2;

export const QUALITY_EVENT_DEDUP_GROWTH_PCT_THRESHOLD = 0.5; // >50%

export const QUALITY_EVENT_DEDUP_GROWTH_ABS_THRESHOLD = 5; // AND by >= 5 clusters

/** Schema for the compact snapshot stored as a memory's `content` (JSON).
 *  Deliberately just the numeric/boolean core the diff needs — never the
 *  full human report (no per-agent memory counts, no raw dedup/recall
 *  detail beyond what threshold math requires). `schemaVersion` lets a
 *  future slice evolve the shape without silently misreading an old
 *  snapshot as the new one. */

export interface QualitySnapshotCore {
  schemaVersion: 1;
  computedAt: string;
  agentFilter: string | null;
  embeddingCoverage: { coveragePct: number } | null;
  staleness: { stalePct: number } | null;
  recallSpotCheck: { recallAtK: number; mrr: number } | null;
  quietAgents: { perAgent: Array<{ id: string; quiet: boolean; daysSinceLastWrite: number | null }> } | null;
  dedupClusters: { clusterCount: number } | null;
}

/** Pure: full QualityReport → compact snapshot core. Any section that's
 *  `null` in the report (a gap) stays `null` in the snapshot — the diff step
 *  treats that as "no event", never a false 0. */

export function buildQualitySnapshot(report: QualityReport, computedAt?: string): QualitySnapshotCore {
  return {
    schemaVersion: 1,
    computedAt: computedAt ?? new Date().toISOString(),
    agentFilter: report.agentFilter,
    embeddingCoverage: report.embeddingCoverage ? { coveragePct: report.embeddingCoverage.coveragePct } : null,
    staleness: report.staleness ? { stalePct: report.staleness.stalePct } : null,
    recallSpotCheck: report.recallSpotCheck
      ? { recallAtK: report.recallSpotCheck.recallAtK, mrr: report.recallSpotCheck.mrr }
      : null,
    quietAgents: report.quietAgents
      ? { perAgent: report.quietAgents.perAgent.map((a) => ({ id: a.id, quiet: a.quiet, daysSinceLastWrite: a.daysSinceLastWrite })) }
      : null,
    dedupClusters: report.dedupClusters ? { clusterCount: report.dedupClusters.clusterCount } : null,
  };
}


export type QualityEventKind = "quality.threshold_crossed" | "quality.regression";

/** One finding from diffQualitySnapshots — maps 1:1 to one OrgEvent PUT.
 *  `summary` is the exact behavioral-fact string that becomes the OrgEvent's
 *  `summary` field (Sherlock's constraint: facts, never trust judgments).
 *  `detail` becomes the OrgEvent's `detail` field, JSON-stringified.
 *  `targetIds` is set only for per-agent findings (quietAgents). */

export interface QualityEventFinding {
  kind: QualityEventKind;
  scope: "quality";
  summary: string;
  detail: { metric: string; before: number | boolean | null; after: number | boolean | null; threshold: number };
  targetIds?: string[];
}

/**
 * Pure diff: current snapshot + previous snapshot (or null on a first run)
 * → the list of OrgEvent findings to emit. Never throws. See the module doc
 * above for the edge-triggered / missing-data-means-no-event rules; fixture
 * tests live in test/unit/quality-report.test.ts.
 */

export function diffQualitySnapshots(current: QualitySnapshotCore, previous: QualitySnapshotCore | null): QualityEventFinding[] {
  const findings: QualityEventFinding[] = [];
  if (!previous) return findings; // first run — nothing to diff against yet

  // ── embedding coverage: absolute floor (edge-triggered) + delta drop ──
  if (current.embeddingCoverage && previous.embeddingCoverage) {
    const before = previous.embeddingCoverage.coveragePct;
    const after = current.embeddingCoverage.coveragePct;
    if (after < QUALITY_EVENT_COVERAGE_ABS_THRESHOLD_PCT && before >= QUALITY_EVENT_COVERAGE_ABS_THRESHOLD_PCT) {
      findings.push({
        kind: "quality.threshold_crossed",
        scope: "quality",
        summary: `embedding coverage dropped to ${after}% (threshold ${QUALITY_EVENT_COVERAGE_ABS_THRESHOLD_PCT}%)`,
        detail: { metric: "embeddingCoverage.coveragePct", before, after, threshold: QUALITY_EVENT_COVERAGE_ABS_THRESHOLD_PCT },
      });
    }
    if (before - after > QUALITY_EVENT_COVERAGE_DROP_THRESHOLD_PCT) {
      findings.push({
        kind: "quality.regression",
        scope: "quality",
        summary: `embedding coverage dropped ${before - after} points since last snapshot (${before}% → ${after}%)`,
        detail: { metric: "embeddingCoverage.coveragePct", before, after, threshold: QUALITY_EVENT_COVERAGE_DROP_THRESHOLD_PCT },
      });
    }
  }

  // ── staleness: absolute ceiling only (edge-triggered) ──
  if (current.staleness && previous.staleness) {
    const before = previous.staleness.stalePct;
    const after = current.staleness.stalePct;
    if (after > QUALITY_EVENT_STALENESS_ABS_THRESHOLD_PCT && before <= QUALITY_EVENT_STALENESS_ABS_THRESHOLD_PCT) {
      findings.push({
        kind: "quality.threshold_crossed",
        scope: "quality",
        summary: `staleness rose to ${after}% past validTo (threshold ${QUALITY_EVENT_STALENESS_ABS_THRESHOLD_PCT}%)`,
        detail: { metric: "staleness.stalePct", before, after, threshold: QUALITY_EVENT_STALENESS_ABS_THRESHOLD_PCT },
      });
    }
  }

  // ── recall spot-check: REPORT-ONLY, no branch here on purpose (flair#967) ──
  //
  // This metric used to emit two quality.regression events (recall@k and MRR,
  // both at QUALITY_EVENT_RECALL_DROP_THRESHOLD). It no longer emits anything,
  // at any delta. Measured, on rockit production:
  //
  //   32 nightly runs · population σ 0.291 · mean |run-to-run delta| 0.223
  //   threshold 0.2  →  0.69σ, i.e. BELOW the metric's own noise floor
  //   6 findings-mails in 34 runs, replay-predicted 6/6 from these branches,
  //   all 6 oscillation  →  lifetime precision 0
  //
  // Removing an emission is not the same move as raising a threshold, and the
  // distinction is the whole point: raising 0.2 would leave a check that still
  // claims to detect recall regressions while detecting none, whereas this
  // hands that job to the instrument that can actually do it — the
  // deterministic, fixed-label, CI-gated eval in
  // test/integration-heavy/recall-eval-gate.test.ts (test/bench/recall-eval),
  // whose floors sit ≥2 whole queries below the measured value against a
  // 0.000 noise band. QUALITY_EVENT_RECALL_DROP_THRESHOLD is left at 0.2,
  // unwired, so that stays checkable rather than asserted.
  //
  // current.recallSpotCheck / previous.recallSpotCheck are still SNAPSHOTTED
  // (buildQualitySnapshot above) — the history that made this diagnosis
  // possible keeps accumulating, and `flair quality` still prints the number.

  // ── quiet agents: per-agent, NEWLY quiet only (was false last snapshot,
  // true now) — never re-fires for an agent that was already quiet last
  // snapshot, and never fires for an agent absent from the previous snapshot
  // (a brand-new agent can't have "regressed" from a state we never saw). ──
  if (current.quietAgents && previous.quietAgents) {
    const prevQuietById = new Map(previous.quietAgents.perAgent.map((a) => [a.id, a.quiet]));
    for (const a of current.quietAgents.perAgent) {
      if (a.quiet && prevQuietById.get(a.id) === false) {
        const days = a.daysSinceLastWrite;
        findings.push({
          kind: "quality.threshold_crossed",
          scope: "quality",
          summary: days == null ? `agent ${a.id} quiet — no recorded write` : `agent ${a.id} quiet for ${days}d (threshold ${QUALITY_QUIET_THRESHOLD_DAYS}d)`,
          detail: { metric: "quietAgents", before: false, after: true, threshold: QUALITY_QUIET_THRESHOLD_DAYS },
          targetIds: [a.id],
        });
      }
    }
  }

  // ── dedup clusters: BOTH >50% relative growth AND >=5 absolute growth ──
  if (current.dedupClusters && previous.dedupClusters) {
    const before = previous.dedupClusters.clusterCount;
    const after = current.dedupClusters.clusterCount;
    const growth = after - before;
    const growthPct = before > 0 ? growth / before : (after > 0 ? Infinity : 0);
    if (growthPct > QUALITY_EVENT_DEDUP_GROWTH_PCT_THRESHOLD && growth >= QUALITY_EVENT_DEDUP_GROWTH_ABS_THRESHOLD) {
      findings.push({
        kind: "quality.regression",
        scope: "quality",
        summary: `dedup cluster count grew from ${before} to ${after} since last snapshot`,
        detail: { metric: "dedupClusters.clusterCount", before, after, threshold: QUALITY_EVENT_DEDUP_GROWTH_PCT_THRESHOLD },
      });
    }
  }

  return findings;
}

/** Subject convention for quality snapshots stored as Flair memories: one
 *  lineage per (agent, Flair instance) pair — an agent that runs
 *  `quality --emit` against more than one target gets independent diff
 *  baselines per target, keyed on HOST (not the full URL, so a bare port
 *  change on the same box doesn't fork the lineage; a different host/instance
 *  correctly starts its own). */

export function qualitySnapshotSubject(baseUrl: string): string {
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    host = baseUrl.replace(/^[a-zA-Z]+:\/\//, "").replace(/\/.*$/, "");
  }
  return `quality-snapshot/${host}`;
}

/** Fetch the most recent prior quality snapshot for `agentId` at `baseUrl`,
 *  via the same signed `GET /Memory` read path fetchRecallSpotCheckData
 *  uses (self-scoped by the signed request's own agent identity — no new
 *  endpoint). Projects the same fields (never embeddings — flair#1360) and
 *  asks for `subject` as a query equals; still filters client-side by
 *  subject because Memory.search() historically did not turn bare query
 *  params into search conditions beyond the signed agentId scope (see
 *  resources/Memory.ts's search()), same client-side-filter pattern
 *  `memory list --hash-fallback` already uses. Returns null on: no prior
 *  snapshot, a fetch error, or a snapshot row whose content isn't
 *  parseable/versioned JSON (never throws — a corrupt or foreign row
 *  degrades to "no snapshot", same as a genuine first run, rather than
 *  crashing `--emit`). */

export async function fetchPreviousQualitySnapshot(
  agentId: string,
  baseUrl: string,
  subject: string,
  opts: { request?: QualityApi } = {},
): Promise<QualitySnapshotCore | null> {
  const request = opts.request ?? api;
  let all: any[];
  try {
    const raw = await request("GET", qualitySnapshotLookupPath(agentId, subject), undefined, { baseUrl, agentId });
    all = Array.isArray(raw) ? raw : (raw?.results ?? raw?.items ?? []);
  } catch {
    return null;
  }
  const matches = all.filter((m: any) => m?.subject === subject);
  if (matches.length === 0) return null;
  matches.sort((a: any, b: any) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });
  try {
    const parsed = JSON.parse(matches[0].content);
    if (parsed && typeof parsed === "object" && parsed.schemaVersion === 1) return parsed as QualitySnapshotCore;
    return null;
  } catch {
    return null;
  }
}

/** Store `snapshot` as a new persistent-durability memory (subject
 *  `quality-snapshot/<host>`) — the diff baseline the NEXT `--emit` run reads
 *  back via fetchPreviousQualitySnapshot. Content is the compact JSON core
 *  only (buildQualitySnapshot's output), never the full human report. Same
 *  `PUT /Memory/{id}` write shape `memory write-task-summary` already uses.
 *  Throws on a write failure — the CLI action below is responsible for
 *  surfacing that as a clear error, same as every other write path here. */

async function storeQualitySnapshot(agentId: string, agentIdSource: SigningIdentitySource, baseUrl: string, subject: string, snapshot: QualitySnapshotCore): Promise<string> {
  const memId = `${agentId}-quality-snapshot-${Date.now()}`;
  const body: Record<string, unknown> = {
    id: memId,
    agentId,
    content: JSON.stringify(snapshot),
    durability: "persistent",
    tags: ["quality-snapshot"],
    subject,
    type: "quality-snapshot",
    createdAt: new Date().toISOString(),
  };
  const out = await api("PUT", `/Memory/${encodeURIComponent(memId)}`, body, { baseUrl, agentId, agentIdSource });
  if (out?.error) throw new Error(String(out.error));
  return memId;
}

// ─── flair quality ────────────────────────────────────────────────────────────

export function register(program: Command): void {
  const __pkgVersion = cli.__pkgVersion;

// ─── flair quality — pure metric computation ─────────────────────────────────
// Slice 1a of the memory-quality-observability arc (ops/proposals/
// flair-quality-slice1-spec.md, K&S design-approved). Same "extract the pure
// decision logic" idiom as summarizeDoctorRun above (flair#721) and
// derivePresenceStatus (resources/Presence.ts): the CLI action spawns a
// network fetch + a long console.log sequence, which is high-effort/
// low-value to drive directly in a test — this is the actual metric math,
// fed a fixture-shaped /HealthDetail body.
//
// ZERO new server surface. Every field this reads already exists in
// resources/health.ts's response (the same one `flair status`/`flair doctor`
// consume) — no new query pattern, no new endpoint. That's what makes the
// Sherlock "read-scope holds by construction" argument hold: quality can
// never see anything status/doctor couldn't already see, because it reads
// the identical payload.
//
// One metric from the design doc is deliberately NOT computed at full
// fidelity here — it degrades gracefully into a `gaps` entry instead of
// failing:
//   - staleness: /HealthDetail's `memories.expired` count is instance-wide
//     only (resources/health.ts never buckets it per agent), so --agent
//     does not scope this metric. The "old + never-recalled" variant isn't
//     computed at all — no read API exposes per-memory last-recalled data.
//
// Slice 1b (flair-quality-slice1b): signal density now ALSO carries citation
// rate. Kern's design nod: extend /HealthDetail's per-agent aggregation
// server-side (resources/health.ts sums Memory.usageCount — a field already
// loaded by the existing memory loop, no new query) rather than have the CLI
// join against `GET /Memory` itself — keeps quality's read footprint
// identical to status/doctor's by construction. `citationRate` here is
// computed CLI-side from the two numbers the server hands back
// (usageCount/memoryCount), same "server aggregates, CLI computes" split as
// every other metric in this file.
//
// Backward compatibility: an OLDER server's /HealthDetail predates
// per-agent `usageCount` entirely (field is `undefined` on the row, not
// `0` — Slice 1a's payload literally didn't have the key). That's detected
// per-row and the whole report degrades to the Slice-1a write-volume-only
// shape + a gap note, rather than silently reporting citationRate 0 as if
// it were real data from a server that never sent it.
//
// Naming (Sherlock security finding on the design round, reaffirmed for
// citation rate): "signal density" / "citation rate" describes a USAGE
// PATTERN, never a trust/quality verdict. A low citation rate means "writes
// exploratory content that's rarely cited", not "noisy" or "untrustworthy"
// — same for "quiet agents": an ops fact (days since last write), not a
// trust signal. Keep that framing in any copy touching this code.
//
// Slice 1c (flair-quality-slice1c-dedup-spec.md, K&S-resolved to "Option C,
// server-side"): dedup-cluster count — how many near-duplicate memory
// CLUSTERS exist instance-wide. Sherlock's hard security line: embeddings
// are the most sensitive data in the system and must never leave the
// server, so — unlike every other metric in this file — the computation
// does NOT happen here. A nightly server-side REM step
// (resources/MemoryDedupStats.ts, wired into src/rem/runner.ts) computes it
// server-side via a bounded-k ANN sweep (reusing the HNSW-backed retrieval
// core) and persists ONLY the aggregate `{clusterCount, largestClusterSize,
// totalMemoriesInClusters, computedAt}` to a small server-side stat file.
// /HealthDetail does a CHEAP read of that file (resources/health.ts) —
// still zero new query pattern from the CLI's perspective, same "quality
// reads a precomputed number from /HealthDetail" contract as every other
// metric here. Nightly-stale by construction (only as fresh as the last
// REM cycle) — that's an accepted trade-off, not a bug: it's a "silting up"
// trend signal, not a real-time alert. Absent (fresh instance, REM never
// run, or an older server) degrades to `null` + a `gaps` entry, never a
// false zero.
//
// Slice 1d (memory-quality arc, self-referential design — no hardcoded canned
// queries): recall SPOT-CHECK. Unlike every metric above, this ISN'T read
// from /HealthDetail at all — it's the one metric in this file that requires
// live QUERIES, because it's checking whether querying itself still works.
// For a sample of the querying agent's OWN memories (fetchRecallSpotCheckData
// below, a projected+bounded GET /Memory — flair#1360: never the unfiltered
// collection with embeddings inline), a CUE is derived from each memory
// (deriveRecallCue — its `subject` if present, else the leading ~8 words /
// first sentence of `content`; a PARTIAL cue, never the full content) and
// searched for through the EXACT SAME authenticated read path `flair memory
// search` uses: `api("POST", "/SemanticSearch", ...)`, which resolves auth
// via the shared authedRequest() 5-tier resolver (src/lib/auth-resolve.ts) —
// identical code path, so read-scope holds by construction (no new
// endpoint, no cross-agent/private data, scoped to the querying agent's own
// memories same as `flair memory search` always was). computeRecallSpotCheck
// (below) is the pure scorer: recall@k = fraction of sampled memories whose
// own id appears in its search's top-k; MRR = mean reciprocal rank (0 if
// not found within k).
//
// Framing — this is a REPORT-ONLY HEALTH SPOT-CHECK, not a benchmark, not a
// trust judgment, and (since flair#967) not an alerting signal either.
// Querying by a cue derived FROM the target memory is easier than a real
// user query, so a high score means "recall is functioning", not "recall is
// optimal". NOTE (#1216): this cue-from-the-memory design is self-polluting
// as a recall-QUALITY metric — relevance is query/corpus overlap by
// construction, so near-duplicate density reads as a recall collapse
// (flair#967 / #857 / #996). It is deliberately NOT the recall-quality
// number; that authority is the deterministic, fixed-label, CI-gated eval at
// test/bench/recall-eval, wired as a gate in
// test/integration-heavy/recall-eval-gate.test.ts.
//
// flair#967 — WHY THIS METRIC NO LONGER EMITS AN EVENT. Measured on rockit
// production over 32 nightly runs: population σ = 0.291, mean absolute
// run-to-run delta = 0.223, against a QUALITY_EVENT_RECALL_DROP_THRESHOLD of
// 0.2. The alarm sat at 0.69σ — BELOW the metric's own noise floor, so the
// median night-to-night wobble already exceeded the delta that declared a
// regression. Replaying diffQualitySnapshots over the stored snapshot series
// predicts the sweep's 6 findings-mails in 34 runs exactly, 6 for 6, and all
// six were oscillation: lifetime precision 0. So the emission is gone. The
// score is still computed, still printed, still snapshotted (history and the
// cratering signal are both preserved) — it just no longer has the authority
// to page anyone, because it never once earned it. That authority stays with
// the deterministic CI gate above, which is fixed-label, hermetic and
// actually detects ranking regressions. Re-arming this probe is a data
// question, not a taste question: it needs a measured precision on the FIXED
// cue derivation first, and a threshold DERIVED from that run-to-run variance
// (≥2σ on the sample design), not another literal.
//
// Requires an actual agent identity to query AS (semantic search is
// agent-scoped) — no identity, fewer than the sample-size memories to sample,
// an UNHEALTHY sample (planRecallSpotCheck below: duplicate or empty cues, so
// the window cannot be scored fairly) or a search error all degrade to `null`
// + a `gaps` entry, same graceful-degradation contract as every metric here —
// NEVER a false 0.0 masquerading as a real (broken) score, and never a number
// quietly computed over a window that could not produce one.

/** First-pass default, same "documented heuristic, not derived from data we
 *  don't have" spirit as health.ts's own 10%-hash-fallback threshold below.
 *  Tunable later if a real fleet shows this is too loud/quiet. */

program
  .command("quality")
  .description("Memory-quality report: embedding coverage, staleness, signal density, quiet agents, recall spot-check (read-only)")
  .option("--port <port>", "Harper HTTP port")
  .option("--url <url>", "Flair base URL (overrides --port)")
  .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET; alias for --url)")
  .option("--json", "Output as JSON")
  .option("--agent <id>", "Scope per-agent metrics to one agent id (or set FLAIR_AGENT_ID); default = all agents")
  .option(
    "--emit",
    "Slice 2: snapshot this report, diff it against the previous quality-snapshot memory, and emit OrgEvents (quality.threshold_crossed / quality.regression) for any crossings/regressions found. Requires an agent identity (--agent or FLAIR_AGENT_ID) — the opt-in write boundary; without this flag `flair quality` remains fully read-only",
  )
  .action(async (opts) => {
    const { agentId, source } = resolveSigningAgentId(opts, "quality");
    const { healthy, baseUrl, healthData } = await fetchHealthDetail(opts, agentId, source);

    if (opts.emit && !agentId) {
      console.error("Error: --emit requires an agent identity. Pass --agent <id> or set FLAIR_AGENT_ID.");
      process.exit(1);
    }

    // Recall spot-check needs live queries (not just /HealthDetail), so only
    // attempt it when the instance is actually reachable — no point probing
    // memory reads against a server fetchHealthDetail already found down.
    const recallSpotCheckData: RecallSpotCheckFetchResult = healthy
      ? await fetchRecallSpotCheckData(agentId, baseUrl)
      : { ok: false, skipReason: "instance unreachable" };
    const report = computeQualityReport(healthy, healthData, { agentId, recallSpotCheckData });

    // ── Slice 2: --emit is the opt-in write boundary. Everything above this
    // point is unchanged from pre-Slice-2 behavior; everything in this block
    // only runs when the flag is passed AND the instance is reachable (an
    // unreachable instance has nothing to diff against and no live write
    // target — it falls through to the existing "unreachable" exit(1) below,
    // same as always). ──
    let emitResult: {
      firstRun: boolean;
      emittedEvents: Array<QualityEventFinding & { orgEventId?: string }>;
      snapshotId: string | null;
      errors: string[];
    } | null = null;
    if (opts.emit && healthy && agentId) {
      const subject = qualitySnapshotSubject(baseUrl);
      const previous = await fetchPreviousQualitySnapshot(agentId, baseUrl, subject);
      const current = buildQualitySnapshot(report);
      const findings = diffQualitySnapshots(current, previous); // [] on a first run (previous === null)
      emitResult = { firstRun: previous === null, emittedEvents: [], snapshotId: null, errors: [] };
      for (const finding of findings) {
        const published = await publishOrgEvent({
          agentId,
          baseUrl,
          kind: finding.kind,
          scope: finding.scope,
          summary: finding.summary,
          detail: JSON.stringify(finding.detail),
          targetIds: finding.targetIds,
        });
        if (published.ok) {
          emitResult.emittedEvents.push({ ...finding, orgEventId: published.id });
        } else {
          emitResult.errors.push(`${finding.kind} (${finding.detail.metric}): ${published.error}`);
        }
      }
      try {
        emitResult.snapshotId = await storeQualitySnapshot(agentId, source, baseUrl, subject, current);
      } catch (err: any) {
        emitResult.errors.push(`snapshot store failed: ${err?.message ?? String(err)}`);
      }
    }

    const mode = render.resolveOutputMode(opts);

    if (mode === "json") {
      const out: any = { healthy, url: baseUrl, flairVersion: __pkgVersion, ...report };
      // flair#967: when a window was assembled, say whether it was scorable —
      // structurally, not only as prose inside a `gaps` reason. An unhealthy
      // sample is a FACT ABOUT THE RUN that a consumer must be able to read
      // without string-matching.
      if (recallSpotCheckData.sampleHealth) out.recallSampleHealth = recallSpotCheckData.sampleHealth;
      if (emitResult) {
        out.emit = { firstRun: emitResult.firstRun, snapshotId: emitResult.snapshotId, errors: emitResult.errors };
        out.emittedEvents = emitResult.emittedEvents.map((e) => ({
          kind: e.kind,
          scope: e.scope,
          summary: e.summary,
          detail: e.detail,
          targetIds: e.targetIds,
          orgEventId: e.orgEventId,
        }));
      }
      console.log(render.asJSON(out));
      if (!healthy) process.exit(1);
      return;
    }

    if (!healthy) {
      console.log(`Flair v${__pkgVersion} — 🔴 unreachable`);
      console.log(`  URL:  ${baseUrl}`);
      console.log(`\n  Run: flair start  or  flair doctor`);
      process.exit(1);
    }

    const scopeLabel = agentId ? ` ${render.wrap(render.c.dim, `(agent: ${agentId})`)}` : "";
    console.log(`${render.wrap(render.c.bold, "Flair quality report")}${scopeLabel}`);
    console.log(render.kv("URL", baseUrl));

    // Instance health
    console.log(`\n${render.wrap(render.c.bold, "Instance health")}`);
    console.log(render.kv("Up", report.instance.up ? `${render.icons.ok} yes` : `${render.icons.error} no`));
    if (report.instance.migrationsClean === null) {
      console.log(render.kv("Migrations", `${render.icons.info} unknown ${render.wrap(render.c.dim, "(no data)")}`));
    } else if (report.instance.migrationsClean) {
      console.log(render.kv("Migrations", `${render.icons.ok} clean`));
    } else {
      console.log(render.kv("Migrations", `${render.icons.error} ${report.instance.haltedMigrations.length} halted/failed`));
      for (const m of report.instance.haltedMigrations) {
        console.log(`    ${render.icons.error} ${m.id}: ${m.state}${m.reason ? ` — ${m.reason}` : ""}`);
      }
    }
    const embIcon =
      report.instance.embeddingsStatus === "ok" ? render.icons.ok :
      report.instance.embeddingsStatus === "degraded" ? render.icons.error :
      render.icons.info;
    console.log(render.kv("Embeddings", `${embIcon} ${report.instance.embeddingsStatus} ${render.wrap(render.c.dim, `(${report.instance.embeddingsDetail})`)}`));

    // Embedding coverage
    if (report.embeddingCoverage) {
      const ec = report.embeddingCoverage;
      console.log(`\n${render.wrap(render.c.bold, "Embedding coverage")}`);
      console.log(render.kv("Coverage", `${render.wrap(render.c.bold, `${ec.coveragePct}%`)} ${render.wrap(render.c.dim, `(${ec.withEmbeddings}/${ec.total} real, ${ec.hashFallback} hash-fallback)`)}`));
    }

    // Staleness
    if (report.staleness) {
      const st = report.staleness;
      console.log(`\n${render.wrap(render.c.bold, "Staleness")}`);
      console.log(render.kv("Past validTo", `${render.wrap(render.c.bold, `${st.stalePct}%`)} ${render.wrap(render.c.dim, `(${st.expired}/${st.total}, instance-wide)`)}`));
    }

    // Signal density
    if (report.signalDensity) {
      console.log(`\n${render.wrap(render.c.bold, "Signal density")} ${render.wrap(render.c.dim, "(write + citation activity — a usage pattern, not a trust signal)")}`);
      if (agentId && report.signalDensity.perAgent.length === 0) {
        console.log(`  ${render.icons.info} no data for agent '${agentId}'`);
      } else {
        const showCitation = report.signalDensity.scope === "write-and-citation";
        const cols: render.TableColumn[] = [
          { label: "id", key: "id" },
          { label: "memories", key: "memoryCount", align: "right" },
          { label: "writes_24h", key: "writes24h", align: "right" },
          ...(showCitation
            ? [
                { label: "citations", key: "usageCount", align: "right" as const },
                { label: "citation_rate", key: "citationRate", align: "right" as const },
              ]
            : []),
          { label: "last_write", key: "lastWriteAt", format: (v) => render.relativeTime(v as string | null) },
        ];
        console.log(render.table(cols, report.signalDensity.perAgent as unknown as Array<Record<string, unknown>>));
        if (showCitation) {
          console.log(`  ${render.wrap(render.c.dim, "citation_rate = avg citations per memory; a low rate means \"writes exploratory content that's rarely cited\", not \"noisy\"")}`);
        } else {
          console.log(`  ${render.wrap(render.c.dim, "citation rate not shown — server predates per-agent usageCount in /HealthDetail (see Gaps); low write volume means \"writes exploratory content\", not \"noisy\"")}`);
        }
      }
    }

    // Quiet agents
    if (report.quietAgents) {
      console.log(`\n${render.wrap(render.c.bold, "Quiet agents")} ${render.wrap(render.c.dim, `(no write in ${report.quietAgents.thresholdDays}+ days — an ops fact, not a trust signal)`)}`);
      if (agentId && report.quietAgents.perAgent.length === 0) {
        console.log(`  ${render.icons.info} no data for agent '${agentId}'`);
      } else {
        const quiet = report.quietAgents.perAgent.filter((r) => r.quiet);
        if (quiet.length === 0) {
          console.log(`  ${render.icons.ok} none`);
        } else {
          for (const r of quiet) {
            const label = r.daysSinceLastWrite == null ? "never written" : `quiet for ${r.daysSinceLastWrite}d`;
            console.log(`  ${render.icons.warn} ${r.id} — ${label}`);
          }
        }
      }
    }

    // Dedup clusters (flair-quality Slice 1c) — an ops/health signal, not a
    // trust judgment. Labeled with the nightly REM run that produced it, per
    // spec, since it's only ever as fresh as the last nightly cycle.
    if (report.dedupClusters) {
      const dc = report.dedupClusters;
      console.log(`\n${render.wrap(render.c.bold, "Dedup clusters")} ${render.wrap(render.c.dim, `(as of last REM run ${render.relativeTime(dc.computedAt)}, ${dc.computedAt})`)}`);
      console.log(render.kv("Clusters", `${render.wrap(render.c.bold, String(dc.clusterCount))} ${render.wrap(render.c.dim, `(${dc.totalMemoriesInClusters} memories, largest cluster ${dc.largestClusterSize})`)}`));
      console.log(`  ${render.wrap(render.c.dim, "an ops signal — near-duplicate memories piling up, not a trust judgment")}`);
    }

    // Recall spot-check (flair-quality Slice 1d) — a REPORT-ONLY health
    // spot-check: not a benchmark, not a trust judgment, and since flair#967
    // not an alerting signal either. See QualityReport['recallSpotCheck'] doc
    // and the Slice 1d module doc for the full framing.
    if (report.recallSpotCheck) {
      const rc = report.recallSpotCheck;
      console.log(`\n${render.wrap(render.c.bold, "Recall spot-check")} ${render.wrap(render.c.dim, `(agent ${rc.agentId ?? "—"}, report-only — not a benchmark, not an alert)`)}`);
      console.log(render.kv(`recall@${rc.k}`, `${render.wrap(render.c.bold, rc.recallAtK.toFixed(2))} ${render.wrap(render.c.dim, `(MRR ${rc.mrr.toFixed(2)}, ${rc.sampleSize} sampled)`)}`));
      console.log(`  ${render.wrap(render.c.dim, "observability only — recall REGRESSIONS are detected by the deterministic CI gate (test/bench/recall-eval), not by this number")}`);
    }

    // Gaps
    if (report.gaps.length > 0) {
      console.log(`\n${render.wrap(render.c.bold, "Gaps")} ${render.wrap(render.c.dim, "(degraded or unavailable from existing read APIs)")}`);
      for (const g of report.gaps) {
        console.log(`  ${render.icons.info} ${g.metric}: ${g.reason}`);
      }
    }

    // Events (flair-quality Slice 2 — only present when --emit was passed)
    if (emitResult) {
      console.log(`\n${render.wrap(render.c.bold, "Events")} ${render.wrap(render.c.dim, "(--emit: snapshot + diff against the previous quality-snapshot memory)")}`);
      if (emitResult.firstRun) {
        console.log(`  ${render.icons.info} first run — no prior snapshot to diff against; stored a baseline, emitted nothing`);
      } else if (emitResult.emittedEvents.length === 0) {
        console.log(`  ${render.icons.ok} no threshold crossings or regressions since the last snapshot`);
      } else {
        console.log(`  ${render.wrap(render.c.bold, String(emitResult.emittedEvents.length))} event(s) emitted:`);
        for (const e of emitResult.emittedEvents) {
          const icon = e.kind === "quality.regression" ? render.icons.warn : render.icons.info;
          console.log(`    ${icon} [${e.kind}] ${e.summary}`);
        }
      }
      if (emitResult.snapshotId) {
        console.log(`  ${render.wrap(render.c.dim, `snapshot stored: ${emitResult.snapshotId}`)}`);
      }
      for (const err of emitResult.errors) {
        console.log(`  ${render.icons.error} ${err}`);
      }
    }
    console.log("");
  });

}
