/**
 * graph-heal.ts — the recall graph-heal OBSERVABILITY migration.
 *
 * WHAT ACTUALLY HEALS: nothing in this file. The heal is entirely
 * schema-driven — `schemas/memory.graphql`'s `embedding` field now declares
 * `@indexed(type: "HNSW", M: 16)` (M:16 = Harper's own default, a zero
 * behavior change). On the first boot after upgrade, Harper structurally
 * diffs the persisted per-attribute HNSW descriptor (built with NO options on
 * every pre-this-change install) against the schema and, because
 * `canonicalizeIndexOptions` does NOT inject defaults (`{type:"HNSW"}` and
 * `{type:"HNSW",M:16}` are DIFFERENT canonical keys — verified against the
 * installed @harperfast/harper source, resources/databases.js:
 * canonicalizeIndexOptions + the `indexOptionsChanged` reset of
 * `lastIndexedKey` to undefined), clears the graph store and rebuilds it
 * CLEANLY from the already-correct stored vectors. That rebuild is immune to
 * the stale/asymmetric reverse-edge corruption Harper's INCREMENTAL HNSW
 * update leaves behind after a bulk in-place re-embed (the July
 * embedding-stamp re-embed that collapsed prod recall). No re-embed happens —
 * only the graph is rebuilt from the vectors already on disk.
 *
 * WHY THIS MIGRATION EXISTS ANYWAY: the heal is invisible — Harper triggers
 * it, this code cannot force it, and there is no Harper API to observe it
 * directly. So this migration's ONLY job is to VERIFY + LEDGER that recall is
 * healthy after the boot, so the heal is auditable and version-gated (runs
 * once per upgrade, then the runner's state-file short-circuit — state.ts —
 * skips it). It touches ZERO rows: riskClass 'derived-only', countPending()
 * is always 0, run() writes one structural-only OrgEvent and returns
 * `processed: 0`. The runner (resources/migrations/runner.ts) then records
 * success in the state file, short-circuiting every subsequent boot at this
 * version.
 *
 * NON-THROWING throughout (invariant II — the runner halts-not-bricks): a
 * canary that can't run, an index still mid-rebuild, or a ledger-write
 * failure all degrade to "not verified this boot, retry next boot" or a
 * best-effort skip — never an exception into the boot path.
 *
 * ROOT-CAUSE GUARD (the recurrence-proof rule this migration is the current
 * instance of): any BULK re-embed of the corpus MUST be paired with a
 * structural graph REBUILD (a full runIndexing pass), never left to Harper's
 * incremental `index()` updates, which diverge from a clean rebuild under
 * bulk in-place vector replacement. Today the only lever flair has for that
 * rebuild is smuggling a structural-schema change (the M:16 descriptor bump
 * that ships with this migration) — see the guard comments in
 * resources/migrations/embedding-stamp.ts and the `flair reembed` path in
 * src/cli.ts. The clean recurrence-proof fix is a supported Harper
 * vector-index rebuild API (filed upstream separately); until then, NEVER use
 * resources/MemoryReindex.ts's `_reindex` for graph correctness — it re-PUTs
 * the same vector through the same buggy incremental path and does not
 * rebuild the graph.
 */
import { databases } from "@harperfast/harper";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Migration, RunBatchResult } from "./types.js";

export const GRAPH_HEAL_ID = "graph-heal";

/** How many rows to scan for a canary that carries a real embedding. Bounded — detect() must stay cheap. */
const CANARY_SCAN_LIMIT = 8;

export interface MemoryTableLike {
  search(query: unknown): AsyncIterable<Record<string, unknown>>;
  get(id: string): Promise<Record<string, unknown> | null>;
}

export interface OrgEventTableLike {
  put(content: unknown): Promise<unknown>;
}

function defaultMemoryTable(): MemoryTableLike {
  return (databases as unknown as { flair: { Memory: MemoryTableLike } }).flair.Memory;
}

function defaultOrgEventTable(): OrgEventTableLike {
  return (databases as unknown as { flair: { OrgEvent: OrgEventTableLike } }).flair.OrgEvent;
}

/**
 * Same "resolve the running package's own version" idiom as
 * resources/health.ts / resources/migration-boot.ts. Inlined (not imported
 * from migration-boot) to avoid an import cycle: migration-boot → registry →
 * graph-heal. Purely informational — it only stamps the ledger detail blob;
 * a "dev" fallback is harmless.
 */
function resolveRunningVersionLocal(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, "..", "..", "..", "package.json"), // dist/resources/migrations → root
      join(here, "..", "..", "package.json"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, "utf-8"));
        if (pkg.version) return String(pkg.version);
      }
    }
  } catch {
    /* fall through */
  }
  return process.env.npm_package_version ?? "dev";
}

/**
 * Pick a canary row that carries a real embedding vector: scan a bounded
 * handful of rows and `.get()` the first one whose stored `embedding` is a
 * non-empty array. `.get()` (a primary-key read) always returns the full
 * record including `embedding`, independent of any `select`/projection
 * quirk. Returns null when the corpus has no embedded rows at all — a fresh
 * or empty instance, where there is simply nothing to heal or verify.
 */
async function pickCanary(table: MemoryTableLike): Promise<{ id: string; embedding: number[] } | null> {
  for await (const row of table.search({ select: ["id"], limit: CANARY_SCAN_LIMIT })) {
    const id = String((row as { id?: unknown }).id ?? "");
    if (!id) continue;
    const full = await table.get(id);
    const emb = (full as { embedding?: unknown } | null)?.embedding;
    if (Array.isArray(emb) && emb.length > 0) return { id, embedding: emb as number[] };
  }
  return null;
}

/**
 * The id of the HNSW nearest neighbor of `target` — the exact cosine-sort
 * query the retrieval path (resources/semantic-retrieval-core.ts) uses,
 * bounded to rank 1. Throws if the index is unavailable / mid-rebuild; the
 * caller treats a throw as "not verified this boot".
 */
async function topNeighborId(table: MemoryTableLike, target: number[]): Promise<string | null> {
  for await (const row of table.search({
    sort: { attribute: "embedding", target, distance: "cosine" },
    select: ["id"],
    limit: 1,
  })) {
    const id = (row as { id?: unknown }).id;
    return id ? String(id) : null;
  }
  return null;
}

/**
 * Canary self-recall: a healthy HNSW graph returns the canary row itself as
 * the rank-1 neighbor of its OWN stored vector. Cheap, read-only, bounded —
 * and the cleanest black-box proof the graph rebuilt and is serving (a
 * mid-rebuild index throws or returns nothing; a store with no embedded rows
 * has no canary). Never throws (invariant II).
 */
async function recallHealthy(table: MemoryTableLike): Promise<{ verified: boolean; hasData: boolean }> {
  try {
    const canary = await pickCanary(table);
    if (!canary) return { verified: false, hasData: false };
    const top = await topNeighborId(table, canary.embedding);
    return { verified: top === canary.id, hasData: true };
  } catch {
    return { verified: false, hasData: true };
  }
}

/** Count rows carrying a real (non-hash-fallback) embedding — the vectors that live in the HNSW graph. Best-effort. */
async function countEmbeddedVectors(table: MemoryTableLike): Promise<number | null> {
  try {
    let n = 0;
    for await (const row of table.search({ select: ["embeddingModel"] })) {
      const m = (row as { embeddingModel?: unknown }).embeddingModel;
      if (typeof m === "string" && m.length > 0 && m !== "hash-512d") n++;
    }
    return n;
  } catch {
    return null;
  }
}

interface HealObservation {
  verified: boolean;
  embeddedVectorCount: number | null;
  runningVersion: string;
  at: string;
}

/**
 * Structural-only ledger OrgEvent (Sherlock discipline, same as
 * resources/migrations/ledger.ts): counts, outcome, version — NEVER a memory
 * id or content (the canary row's id is deliberately omitted). Written via an
 * internal (no-HTTP-context) put — resolveAgentAuth(undefined) → internal, the
 * same trusted server-internal write path the migration ledger already uses.
 */
async function writeGraphHealEvent(obs: HealObservation, table: OrgEventTableLike): Promise<void> {
  const countNote =
    obs.embeddedVectorCount != null
      ? ` (${obs.embeddedVectorCount} embedded vector${obs.embeddedVectorCount === 1 ? "" : "s"})`
      : "";
  await table.put({
    id: `migration-graph-heal-verified-${obs.at}`,
    authorId: "flair-migrations",
    kind: "migration",
    scope: "full",
    summary: `HNSW graph-heal: recall ${obs.verified ? "verified healthy" : "unconfirmed"}${countNote}`,
    detail: JSON.stringify({
      migrationId: GRAPH_HEAL_ID,
      verified: obs.verified,
      canaryRank1: obs.verified,
      embeddedVectorCount: obs.embeddedVectorCount,
      runningVersion: obs.runningVersion,
      verifiedAt: obs.at,
    }),
    refId: GRAPH_HEAL_ID,
    createdAt: obs.at,
  });
}

/**
 * `getTable`/`getOrgEventTable`/`getVersion`/`now` are injectable so tests can
 * exercise detect/countPending/run against fakes (matching the mocking style
 * of embedding-stamp.ts / the unit tests). The real HNSW self-recall + ledger
 * path is exercised end-to-end in
 * test/integration/hnsw-graph-heal-e2e.test.ts.
 */
export function createGraphHealMigration(
  getTable: () => MemoryTableLike = defaultMemoryTable,
  getOrgEventTable: () => OrgEventTableLike = defaultOrgEventTable,
  getVersion: () => string = resolveRunningVersionLocal,
  now: () => Date = () => new Date(),
): Migration {
  return {
    id: GRAPH_HEAL_ID,
    riskClass: "derived-only",
    affectsTables: ["Memory"],

    /**
     * True only when recall is confirmed healthy AND there is embedded data
     * to verify — i.e. the graph rebuilt and is serving. Returns false (the
     * runner marks the migration completed for this boot WITHOUT writing a
     * success state entry, so detect() runs again next boot) when the index
     * is still mid-rebuild or the store has nothing embedded yet. This is the
     * enrollment gate: only a confirmed-healthy boot proceeds to run() +
     * ledger + the version short-circuit.
     */
    async detect(): Promise<boolean> {
      const { verified } = await recallHealthy(getTable());
      return verified;
    },

    /** Observe-only — never any pending row work. */
    async countPending(): Promise<number> {
      return 0;
    },

    /**
     * Called exactly once (countPending() is 0 → the runner's batch loop runs
     * once and breaks). Re-verifies recall for the ledger snapshot, counts
     * the embedded vectors, writes ONE structural-only OrgEvent, and returns
     * `processed: 0` so the completion gate (count+marker, derived-only)
     * passes and the runner records success → short-circuit next boot.
     */
    async run(_batchSize: number): Promise<RunBatchResult> {
      const table = getTable();
      const { verified } = await recallHealthy(table);
      const embeddedVectorCount = await countEmbeddedVectors(table);
      try {
        await writeGraphHealEvent(
          { verified, embeddedVectorCount, runningVersion: getVersion(), at: now().toISOString() },
          getOrgEventTable(),
        );
      } catch {
        // Observability must never brick the runner — a ledger-write failure
        // is swallowed; the heal itself already happened schema-side.
      }
      return { processed: 0, touchedIds: [] };
    },
  };
}
