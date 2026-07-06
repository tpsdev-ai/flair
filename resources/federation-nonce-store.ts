/**
 * federation-nonce-store.ts — persistent backing for the federation
 * anti-replay NonceStore (federation-edge-hardening slice 4).
 *
 * The gap: `federationNonceStore` in Federation.ts was a bare in-memory Map
 * (`createNonceStore()` in federation-crypto.ts). On process restart it's
 * wiped, so a signed federation request captured within its ±30s freshness
 * window (verifyBodySignatureFresh) could be replayed once, post-restart.
 * This module closes that window by backing the SAME `NonceStore` interface
 * with the `Nonce` Harper table, while keeping every method synchronous —
 * `verifyBodySignatureFresh` and its 2 call sites in Federation.ts are
 * UNCHANGED (they still call `.has()` / `.set()` / `.evict()` with no
 * `await`), so the entire existing federation-crypto-replay test suite
 * (all synchronous assertions) keeps working unmodified.
 *
 * How the sync interface stays sync against an inherently-async DB API:
 *   - `has()` / `evict()` read/mutate an in-memory Map (via the existing
 *     `createNonceStore()`), exactly as before — no DB round trip.
 *   - `set()` updates that same in-memory Map synchronously (so replay
 *     detection within THIS process's lifetime is unchanged), and fires an
 *     async `Nonce.put()` in the background (not awaited) to persist the
 *     nonce for the NEXT restart. A failed/slow persist never blocks or
 *     fails request handling — see the perf/durability tradeoff note below.
 *   - `hydrate()` is the new piece: an explicit async step that loads
 *     not-yet-expired rows from the `Nonce` table into the in-memory Map.
 *     Call it once, on startup, BEFORE the store starts guarding live
 *     traffic — that's what makes a nonce recorded by the PREVIOUS process
 *     visible to a FRESH store instance after a restart (the whole point).
 *
 * Known tradeoff (flagged, not fixed here — would require making NonceStore
 * async, which ripples into ~40 synchronous call sites across
 * federation-crypto-replay.test.ts + federation-sync-e2e.test.ts):
 * `set()`'s persistence is fire-and-forget. A crash in the narrow gap
 * between "response sent" and "async put() resolved" can still lose that
 * one nonce — narrowing the replay window to that gap, not eliminating it
 * outright. Defense-in-depth: the ±30s freshness check + signature
 * verification are still the primary guards; this closes the common case
 * (graceful restart / redeploy), not the crash-mid-request edge case.
 */
import { createNonceStore } from "./federation-crypto.js";
import type { NonceStore } from "./federation-crypto.js";

export interface PersistentNonceStore extends NonceStore {
  /**
   * Load not-yet-expired nonces from the `Nonce` table into the in-memory
   * cache. Call once at startup before the store guards live traffic.
   */
  hydrate(opts?: { retentionMs?: number; now?: number }): Promise<void>;
}

export interface PersistentNonceStoreOptions {
  /** Injected `databases` object — tests pass a fake; production lazy-imports @harperfast/harper. */
  db?: any;
}

/** 2x the standard 30s freshness window — matches the in-memory `evict()` cutoff already used by verifyBodySignatureFresh. */
export const DEFAULT_RETENTION_MS = 60_000;

async function resolveDb(opts: PersistentNonceStoreOptions, cache: { db?: Promise<any> }): Promise<any> {
  if (opts.db) return opts.db;
  if (!cache.db) {
    cache.db = import("@harperfast/harper").then((h: any) => h.databases);
  }
  return cache.db;
}

/**
 * Create a `NonceStore` backed by the `Nonce` Harper table.
 *
 * Wraps the existing in-memory `createNonceStore()` (unchanged behavior for
 * `has()`/`set()`/`evict()` within this process) and adds:
 *   - background persistence of newly-set nonces (`set()`)
 *   - an explicit `hydrate()` to reload previously-persisted nonces (used
 *     at startup, and by tests simulating a restart with a fresh instance)
 */
export function createPersistentNonceStore(
  opts: PersistentNonceStoreOptions = {},
): PersistentNonceStore {
  const memory = createNonceStore();
  const dbCache: { db?: Promise<any> } = {};

  return {
    has(key: string): boolean {
      return memory.has(key);
    },
    evict(olderThan: number): void {
      memory.evict(olderThan);
    },
    set(key: string, value: number): void {
      memory.set(key, value);
      // Fire-and-forget persistence — see module header for the tradeoff.
      void (async () => {
        try {
          const db = await resolveDb(opts, dbCache);
          await db.flair.Nonce.put({ id: key, seenAt: value });
        } catch (err: any) {
          console.error(
            "[federation-nonce-store] failed to persist nonce (in-memory record already made — this process's replay guard is unaffected):",
            err?.message ?? err,
          );
        }
      })();
    },
    async hydrate(hydrateOpts?: { retentionMs?: number; now?: number }): Promise<void> {
      const retentionMs = hydrateOpts?.retentionMs ?? DEFAULT_RETENTION_MS;
      const now = hydrateOpts?.now ?? Date.now();
      const cutoff = now - retentionMs;
      try {
        const db = await resolveDb(opts, dbCache);
        for await (const row of db.flair.Nonce.search()) {
          if (row?.id != null && typeof row.seenAt === "number" && row.seenAt >= cutoff) {
            memory.set(String(row.id), row.seenAt);
          }
        }
      } catch (err: any) {
        console.error(
          "[federation-nonce-store] failed to hydrate from Nonce table (starting with an empty replay guard):",
          err?.message ?? err,
        );
      }
    },
  };
}

// ─── Eviction sweep — periodic Nonce table hygiene ─────────────────────────
//
// Mirrors federation-cleanup.ts's 5-min setInterval hub-pattern. Decoupled
// from the in-memory `evict()` above (which runs per-request and only trims
// the local Map): this sweep deletes rows from the `Nonce` TABLE itself so
// it doesn't grow unbounded across restarts. No native TTL in this repo —
// same app-managed-sweep idiom as PairingToken cleanup.
//
// Runs on every instance (hub AND spoke) — unlike PairingToken cleanup
// (hub-only, since only hubs issue pairing tokens), both FederationPair and
// FederationSync can be the RECEIVING side of a signed request on either
// role, so both roles accumulate rows in the Nonce table and both need the
// sweep.

const NONCE_CLEANUP_INTERVAL_MS = 300_000; // 5 minutes

let nonceCleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Core sweep logic — exposed for unit testing. Deletes `Nonce` rows with
 * `seenAt` older than `retentionMs` (default: 2x the 30s freshness window).
 */
export async function runNonceCleanupTick(
  opts: {
    db?: any;
    retentionMs?: number;
    now?: number;
  } = {},
): Promise<{ deleted: number; scanned: number }> {
  let db: any;
  if (opts.db) {
    db = opts.db;
  } else {
    const harper = await import("@harperfast/harper");
    db = harper.databases;
  }

  const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
  const now = opts.now ?? Date.now();
  const cutoff = now - retentionMs;

  const toDelete: string[] = [];
  let scanned = 0;
  try {
    for await (const row of db.flair.Nonce.search()) {
      scanned++;
      if (typeof row?.seenAt === "number" && row.seenAt < cutoff) {
        toDelete.push(row.id);
      }
    }
  } catch (err: any) {
    console.error(
      "[federation-nonce-store] failed to query Nonce records:",
      err?.message ?? err,
    );
    return { deleted: 0, scanned: 0 };
  }

  let deleted = 0;
  for (const id of toDelete) {
    try {
      await db.flair.Nonce.delete(id);
      deleted++;
    } catch (err: any) {
      console.error(
        "[federation-nonce-store] failed to delete expired nonce:",
        err?.message ?? err,
      );
    }
  }

  return { deleted, scanned };
}

/**
 * Initialise the periodic Nonce-table eviction sweep (5-min cadence).
 *
 * In test environments, callers pass a mock `db` via `opts` so this module
 * never imports @harperfast/harper at the top level (mirrors
 * federation-cleanup.ts's `initFederationCleanup`).
 */
export async function initNonceStoreCleanup(
  opts?: {
    db?: any;
    retentionMs?: number;
    immediateTick?: boolean;
  },
): Promise<void> {
  const immediate = opts?.immediateTick ?? true;

  let db: any;
  if (opts?.db) {
    db = opts.db;
  } else {
    try {
      const harper = await import("@harperfast/harper");
      db = harper.databases;
    } catch (err: any) {
      console.error(
        "[federation-nonce-store] failed to load @harperfast/harper:",
        err?.message ?? err,
      );
      return;
    }
  }

  const retentionMs = opts?.retentionMs ?? DEFAULT_RETENTION_MS;

  console.log("[federation-nonce-store] starting nonce eviction sweep (5-min cadence)");
  if (nonceCleanupTimer) clearInterval(nonceCleanupTimer);

  nonceCleanupTimer = setInterval(() => {
    runNonceCleanupTick({ db, retentionMs }).catch((err: any) => {
      console.error("[federation-nonce-store] cleanup tick error:", err?.message ?? err);
    });
  }, NONCE_CLEANUP_INTERVAL_MS);

  if (immediate) {
    runNonceCleanupTick({ db, retentionMs }).catch((err: any) => {
      console.error("[federation-nonce-store] initial cleanup tick error:", err?.message ?? err);
    });
  }
}
