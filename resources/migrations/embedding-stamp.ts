/**
 * embedding-stamp.ts — the first registered migration (per the spec):
 * re-embeds every Memory row whose `embeddingModel` doesn't match
 * `getModelId()`. riskClass 'derived-only' — embeddings are recomputable
 * from `content` (SOURCE_FIELDS), never the only copy of anything
 * (invariant I), so this is the cheapest posture: metadata-only snapshot,
 * no content-hash gate (row-count + stamp convergence only).
 *
 * THE GATE (`EMBEDDING_PREFIXES_ENABLED` in resources/embeddings-provider.ts)
 * is now ON (flair#504, flipped and re-baselined through the ratchet gate),
 * so `getModelId()` returns `<base>+searchprefix` — every row written before
 * this flip was stamped with the bare base id, so it now reads as stale and
 * gets picked up by this migration on the next boot that reaches it. This is
 * this migration's first real payload: before the flip, `getModelId()`
 * returned the bare base id unconditionally, so this migration — live and
 * always-registered from the day it shipped — had nothing to detect. That
 * was intentional groundwork, not dead code: proving the detect/re-embed
 * mechanism end-to-end (this file, `test/integration/
 * migrations-embedding-stamp-e2e.test.ts`) before it ever had real work to
 * do was the point.
 *
 * Reuses Memory's OWN regen branch — never duplicates embedding logic —
 * via the SAME mechanism `flair reembed` (src/cli.ts) already uses in
 * production: a genuine `PUT /Memory/:id` HTTP request (admin-authenticated
 * loopback), not an in-process call on `databases.flair.Memory` directly.
 *
 * THIS IS LOAD-BEARING, confirmed empirically while building
 * test/integration/migrations-embedding-stamp-e2e.test.ts against real
 * Harper: `databases.flair.Memory` (the property Harper exposes to OTHER
 * modules, imported the same way resources/health.ts / MemoryReindex.ts /
 * etc. already do for READS) resolves to the RAW underlying table, not the
 * resources/Memory.ts SUBCLASS that carries the actual regen/dedup/auth
 * logic — that subclass is only reachable via Harper's own REST dispatch
 * for a genuine `/Memory` request. Calling `.put()` on the raw reference
 * writes the record fine (confirmed: fields land exactly as passed) but
 * silently skips every override in resources/Memory.ts, INCLUDING the
 * `if (content.content && !content.embedding) { regenerate } ` branch this
 * migration exists to trigger. Reads (`.search()`/`.get()`, used below for
 * detect/countPending/candidate-selection) are unaffected by this — only
 * `.put()` needs the real dispatch, hence the loopback HTTP call for
 * exactly that one step.
 *
 * Query correctness (also verified against real Harper): Harper's
 * `not_equal` comparator only matches rows where the attribute holds an
 * EXPLICIT value (including explicit `null`) — a row where the attribute
 * was NEVER SET AT ALL (`getIndexedValues()` returns `undefined` for a
 * truly-absent property, never indexed regardless of `indexNulls`) is
 * invisible to ANY condition-based query, not just `not_equal`. Clearing to
 * `null` (never `undefined`) on write is therefore load-bearing: if the
 * regen HTTP call fails (engine not yet warmed up, transient failure,
 * admin credential unavailable this cycle), the row must land back in an
 * EXPLICIT-null state — queryable and retried on the next boot — never a
 * truly-absent one that would be permanently invisible to this migration
 * again. The pending condition is an OR of `not_equal <current>` (catches a
 * stale non-null model string) and `equals null` (catches that
 * explicit-null state) — together they catch every state this migration's
 * OWN writes can ever produce. A row whose `embeddingModel` was NEVER
 * touched by anything (truly absent from its very first write — only
 * possible if the embeddings engine was down for that entire write) is a
 * known, narrow gap this bounded query cannot see;
 * resources/migration-boot.ts mitigates the common case by waiting for the
 * embeddings engine to settle before running migrations at all.
 */
import { databases } from "@harperfast/harper";
import { getModelId } from "../embeddings-provider.js";
import type { Migration, RunBatchResult } from "./types.js";

export interface MemoryTableLike {
  search(query: unknown): AsyncIterable<Record<string, unknown>>;
  get(id: string): Promise<Record<string, unknown> | null>;
}

function defaultMemoryTable(): MemoryTableLike {
  return (databases as unknown as { flair: { Memory: MemoryTableLike } }).flair.Memory;
}

export const EMBEDDING_STAMP_ID = "embedding-stamp";

const REGEN_HTTP_TIMEOUT_MS = 20_000; // a real embedding compute can be slow on constrained hardware

/** Same admin-password resolution as resources/auth-middleware.ts's getAdminPass(). */
function resolveAdminAuthHeader(): string | null {
  const pass = process.env.HDB_ADMIN_PASSWORD ?? process.env.FLAIR_ADMIN_PASSWORD;
  if (!pass) return null;
  return "Basic " + Buffer.from(`admin:${pass}`).toString("base64");
}

/** Same HTTP_PORT env resolution src/cli.ts sets on every Harper spawn (see that file's grep for HTTP_PORT). */
function resolveSelfBaseUrl(): string {
  const port = process.env.HTTP_PORT ?? "9926";
  return `http://127.0.0.1:${port}`;
}

/**
 * Triggers Memory.put()'s regen branch via a genuine loopback HTTP PUT —
 * the ONLY reliable way to reach resources/Memory.ts's subclass logic (see
 * module doc). Returns true iff the request succeeded (2xx); NEVER throws
 * — a failure just leaves the row in its current (queryable, explicit-null
 * or stale-string) state for the next attempt.
 */
async function regenViaHttpPut(
  id: string,
  existing: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const authHeader = resolveAdminAuthHeader();
  if (!authHeader) return false; // no admin credential available this cycle — retried next boot
  try {
    const res = await fetchImpl(`${resolveSelfBaseUrl()}/Memory/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({ ...existing, embedding: null, embeddingModel: null }),
      signal: AbortSignal.timeout(REGEN_HTTP_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * `getTable`/`getCurrentModelId`/`regen` are injectable so unit tests can
 * exercise this migration's full detect/countPending/run logic against an
 * in-memory fake table and a fake regen function (no real Harper, no real
 * HTTP needed) — matching the mocking technique used throughout
 * test/unit/*.ts (e.g. test/unit/instance-identity.test.ts). The real
 * loopback-HTTP regen path is exercised for real in
 * test/integration/migrations-embedding-stamp-e2e.test.ts.
 */
export function createEmbeddingStampMigration(
  getTable: () => MemoryTableLike = defaultMemoryTable,
  getCurrentModelId: () => string = getModelId,
  regen: (id: string, existing: Record<string, unknown>) => Promise<boolean> = (id, existing) =>
    regenViaHttpPut(id, existing, fetch),
): Migration {
  function staleCondition() {
    // OR-combined: `not_equal <current>` catches a stale non-null model
    // string; `equals null` catches the explicit-null state this
    // migration's own writes leave behind on a failed regen (see the
    // module doc above — Harper's index never sees a TRULY ABSENT
    // property, only an explicit null).
    return [
      {
        operator: "or",
        conditions: [
          { attribute: "embeddingModel", comparator: "not_equal", value: getCurrentModelId() },
          { attribute: "embeddingModel", comparator: "equals", value: null },
        ],
      },
    ];
  }

  return {
    id: EMBEDDING_STAMP_ID,
    riskClass: "derived-only",
    affectsTables: ["Memory"],

    async detect(): Promise<boolean> {
      const table = getTable();
      for await (const _row of table.search({ conditions: staleCondition(), limit: 1 })) {
        return true;
      }
      return false;
    },

    async countPending(): Promise<number> {
      const table = getTable();
      let n = 0;
      for await (const _row of table.search({ conditions: staleCondition() })) n++;
      return n;
    },

    async run(batchSize: number): Promise<RunBatchResult> {
      const table = getTable();
      const current = getCurrentModelId();

      const candidates: Record<string, unknown>[] = [];
      for await (const row of table.search({ conditions: staleCondition(), limit: batchSize })) {
        candidates.push(row);
      }

      const touchedIds: string[] = [];
      for (const row of candidates) {
        const id = String((row as { id?: unknown }).id ?? "");
        if (!id) continue;
        const existing = await table.get(id);
        if (!existing) continue; // deleted since the search above — nothing to fix
        if (existing.embeddingModel === current) continue; // already stamped by a concurrent runner — idempotent skip

        const ok = await regen(id, existing);
        if (ok) touchedIds.push(id);
        // A failed regen leaves the row untouched (still matching
        // staleCondition — retried next batch/boot), never partially
        // written or marked done.
      }

      return { processed: touchedIds.length, touchedIds };
    },
  };
}
