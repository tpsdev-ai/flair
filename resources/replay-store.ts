/**
 * replay-store.ts — the ONE instance-wide check-and-record behind both replay
 * guards (flair#2061, slice S1a of flair#2052):
 *
 *   - agent auth (TPS-Ed25519), key `a:<agentId>:<nonce>` — the auth gate
 *     (auth-middleware.ts), the per-resource fallback (agent-auth.ts) and the
 *     Presence heartbeat (Presence.ts);
 *   - federation body signatures, key `f:<nonce>` — FederationPair and
 *     FederationSync (Federation.ts, via verifyFederationRequestBody).
 *
 * The XAA ID-JAG `jti` record (flair#2073) uses the same `recordOnce` on its
 * own table; see `claimIdJagJti` below. The OAuth single-use record (flair#2145)
 * uses it on one more, for a redeemed authorization code (`c:<sha256>`) and a
 * rotated refresh token (`r:<sha256>`); see `claimOAuthSingleUse` below.
 *
 * The record of truth is the local `ReplayNonce` table (schemas/replay.graphql:
 * `replicate: false`, `expiration: 120`). Every Harper thread of this instance
 * reads and writes the same rows. Per-thread memory holds only keys this thread
 * has seen recorded — its own write, or a row it read back from the store: it
 * may refuse early on a HIT, and a MISS always goes to the store.
 *
 * Check-and-record, `recordOnce()` (wrapped by each guard's `claim()`):
 *   1. `tryLock([REPLAY_LOCK_NAMESPACE, key])` on the table's primary store. The
 *      lock is per key and shared by every thread of the process. Not acquired
 *      means another claim of the same key is in progress: "contended". The
 *      guard refuses that request as a replay but does not remember the key,
 *      because the other claim may still fail to write it.
 *   2. Read the key fresh (`getEntry`; on LMDB the thread's cached read snapshot
 *      is dropped first). Present: "replay".
 *   3. `put` the row in its OWN transaction and await the commit.
 *   4. `unlock` in `finally` — only a lock this call acquired.
 * Anything thrown, and any gap in the store contract below, is "unavailable",
 * and every caller REFUSES the request on it. Nothing falls back to memory.
 *
 * Harper 5.2.8 has no conditional create that is atomic across threads; the
 * per-key lock is the primitive that serialises the read with the write (Harper
 * uses it the same way for source-fill de-duplication). The lock space is
 * database-wide on RocksDB, so the key is namespaced.
 *
 * Callers claim a key only AFTER the request's signature has verified, and
 * BEFORE the request has any effect.
 *
 * Eviction is Harper's table expiration: its scan runs on the last worker only,
 * so once per instance, and removes a row no earlier than REPLAY_RETENTION_MS
 * after it was written. A key stays acceptable to its window check for at most
 * 2 × window after it is first recorded, so the retention must exceed twice
 * every window that uses the store; a guard whose window does not fit is
 * unavailable. `primaryStore` is not a documented Harper API: its methods are
 * checked on every claim, reported once per worker at boot, and pinned against
 * the installed Harper by test/unit-isolated/replay-store.test.ts.
 */
import { databases } from "harper";
import { WINDOW_MS } from "./ed25519-auth.js";
import { FEDERATION_WINDOW_MS, verifyBodySignatureFreshOnce, type VerifyFreshOnceResult } from "./federation-crypto.js";

/** The table name in the `flair` database (schemas/replay.graphql). */
export const REPLAY_TABLE = "ReplayNonce";

/**
 * Seconds a row is kept. MUST equal `expiration:` on `type ReplayNonce` in
 * schemas/replay.graphql (pinned by test/unit-isolated/replay-store.test.ts).
 */
export const REPLAY_RETENTION_S = 120;
export const REPLAY_RETENTION_MS = REPLAY_RETENTION_S * 1000;

/** First element of every lock key, so no other lock on the database collides. */
export const REPLAY_LOCK_NAMESPACE = "flair-replay";

export type ReplayScope = "a" | "f";

/** Outcome of a claim. Only "recorded" lets a request through. */
export type ReplayClaim = "recorded" | "replay" | "unavailable";

/**
 * Outcome of `recordOnce`. "replay": the key's row is in the store.
 * "contended": another claim of the key holds its lock, so whether the key ends
 * up recorded is not known yet.
 */
export type RecordOutcome = "recorded" | "replay" | "contended";

/** The store's dependencies, resolved on every claim (tests inject fakes). */
export interface ReplayStoreDeps {
  /** Harper table class for `flair.ReplayNonce`, or for `name`. */
  table: any;
  /** Harper's `transaction(context, callback)`. */
  transaction: any;
  /** The table's name in the `flair` database. Default: REPLAY_TABLE. */
  name?: string;
  /** First element of every lock key. Default: REPLAY_LOCK_NAMESPACE. */
  lockNamespace?: string;
}

/** Named refusal state: the store cannot be used, so signed requests are refused. */
export class ReplayStoreUnavailable extends Error {
  readonly gap: string;
  constructor(gap: string) {
    super(`ReplayStoreUnavailable: ${gap}`);
    this.name = "ReplayStoreUnavailable";
    this.gap = gap;
  }
}

/** Harper's `transaction` is assigned onto the global at load (as in request-transaction.ts). */
export function harperReplayDeps(): ReplayStoreDeps {
  return {
    table: (databases as any)?.flair?.[REPLAY_TABLE],
    transaction: (globalThis as any).transaction,
  };
}

const STORE_METHODS = ["tryLock", "unlock", "getEntry"] as const;

/**
 * What stops the store from being used, or null. Checks the table, the three
 * primary-store methods the claim relies on, the table's `put`, Harper's
 * `transaction`, and — when the table reports its expiration — that rows
 * outlive twice `windowMs`.
 */
export function replayStoreContractGap(deps: ReplayStoreDeps, windowMs?: number): string | null {
  const name = deps?.name ?? REPLAY_TABLE;
  const table = deps?.table;
  if (!table) return `table flair.${name} is not defined`;
  const store = table.primaryStore;
  if (!store) return `flair.${name} has no primaryStore`;
  for (const m of STORE_METHODS) {
    if (typeof store[m] !== "function") return `flair.${name}.primaryStore.${m} is not a function`;
  }
  if (typeof table.put !== "function") return `flair.${name}.put is not a function`;
  if (typeof deps.transaction !== "function") return "Harper's transaction() is not available";
  if (windowMs !== undefined) {
    const expirationMs = table.expirationMS;
    if (typeof expirationMs === "number" && expirationMs > 0 && expirationMs <= 2 * windowMs) {
      return `flair.${name} keeps rows ${expirationMs} ms, not longer than twice the ${windowMs} ms window`;
    }
  }
  return null;
}

/**
 * Why a window cannot use the store, or null. `source` names where the window
 * comes from (an env variable), so the refusal says what to change.
 */
export function replayWindowGap(windowMs: number, source?: string): string | null {
  const what = source ? `replay window ${windowMs} ms (${source})` : `replay window ${windowMs} ms`;
  if (!Number.isFinite(windowMs) || windowMs <= 0) return `${what} is not a positive number`;
  if (2 * windowMs >= REPLAY_RETENTION_MS) {
    return `${what} must be below ${REPLAY_RETENTION_MS / 2} ms: flair.${REPLAY_TABLE} keeps a nonce ${REPLAY_RETENTION_MS} ms, and that must exceed twice the window`;
  }
  return null;
}

/**
 * The atomic check-and-record. Resolves "recorded" when this call writes the
 * key's row (one claim per key, across every thread of the instance), "replay"
 * when the row is already in the store, and "contended" when another claim of
 * `key` holds its lock. THROWS on a contract gap or any store error;
 * `ReplayGuard.claim` turns that into "unavailable".
 */
export async function recordOnce(key: string, seenAt: number, deps: ReplayStoreDeps): Promise<RecordOutcome> {
  const gap = replayStoreContractGap(deps);
  if (gap) throw new ReplayStoreUnavailable(gap);
  const { table, transaction } = deps;
  const store = table.primaryStore;
  const lockKey = [deps.lockNamespace ?? REPLAY_LOCK_NAMESPACE, key];
  if (!store.tryLock(lockKey)) return "contended";
  try {
    store.resetReadTxn?.();
    if (store.getEntry(key) != null) return "replay";
    await transaction({}, () => table.put({ id: key, seenAt }));
    return "recorded";
  } finally {
    store.unlock(lockKey);
  }
}

// ─── Refusal logging (bounded) ─────────────────────────────────────────────

const LOG_INTERVAL_MS = 10_000;
const lastLogged = new Map<string, number>();

const REFUSED: Record<ReplayScope | "x" | "o", string> = {
  a: "TPS-Ed25519 signed request",
  f: "federation signed request",
  x: "XAA jwt-bearer grant whose assertion carries a jti",
  o: "OAuth request that redeems an authorization code or rotates a refresh token",
};

function noteUnavailable(scope: ReplayScope | "x" | "o", err: unknown, table: string = REPLAY_TABLE): void {
  const reason =
    err instanceof ReplayStoreUnavailable
      ? err.message
      : `ReplayStoreUnavailable: store error (${(err as any)?.constructor?.name ?? "Error"}: ${String((err as any)?.message ?? err).slice(0, 200)})`;
  const tag = `${scope}|${reason}`;
  const now = Date.now();
  if (now - (lastLogged.get(tag) ?? 0) < LOG_INTERVAL_MS) return;
  if (lastLogged.size > 64) lastLogged.clear();
  lastLogged.set(tag, now);
  console.error(
    `[flair-replay] ${reason}. Every ${REFUSED[scope]} is refused until the ` +
      `flair.${table} store is usable (see resources/replay-store.ts).`,
  );
}

// ─── Guard: memory HIT cache in front of the store ─────────────────────────

export interface ReplayGuard {
  readonly scope: ReplayScope;
  readonly windowMs: number;
  /** Where the window is configured, when it is configurable. */
  readonly windowSource?: string;
  /** True only when THIS thread already saw `key` recorded in the store. A false proves nothing. */
  knownReplay(key: string, now?: number): boolean;
  /** Authoritative check-and-record. Anything but "recorded" must refuse the request. */
  claim(key: string, now?: number): Promise<ReplayClaim>;
  /** Test-only: drop this thread's memory cache (never the store). */
  resetCacheForTest(): void;
}

export interface ReplayGuardOptions {
  scope: ReplayScope;
  windowMs: number;
  windowSource?: string;
  deps?: () => ReplayStoreDeps;
  /** Upper bound on memory entries; the cache is cleared past it (the store stays authoritative). */
  cacheLimit?: number;
}

export function createReplayGuard(opts: ReplayGuardOptions): ReplayGuard {
  const { scope, windowMs, windowSource } = opts;
  const resolveDeps = opts.deps ?? harperReplayDeps;
  const cacheLimit = opts.cacheLimit ?? 100_000;
  const windowGap = replayWindowGap(windowMs, windowSource);
  // A key can pass its window check for at most 2 × window after it is first
  // recorded; past that a memory entry can no longer refuse anything.
  const cacheTtlMs = 2 * windowMs;
  const seen = new Map<string, number>();
  let lastPrune = 0;

  function prune(now: number): void {
    if (now - lastPrune < 1000 && seen.size < cacheLimit) return;
    lastPrune = now;
    for (const [k, t] of seen) if (now - t > cacheTtlMs) seen.delete(k);
    if (seen.size >= cacheLimit) seen.clear();
  }

  return {
    scope,
    windowMs,
    windowSource,
    knownReplay(key: string, now: number = Date.now()): boolean {
      prune(now);
      return seen.has(`${scope}:${key}`);
    },
    async claim(key: string, now: number = Date.now()): Promise<ReplayClaim> {
      const full = `${scope}:${key}`;
      try {
        if (windowGap) throw new ReplayStoreUnavailable(windowGap);
        const deps = resolveDeps();
        const gap = replayStoreContractGap(deps, windowMs);
        if (gap) throw new ReplayStoreUnavailable(gap);
        const outcome = await recordOnce(full, now, deps);
        // A contended key is refused for this request but not remembered: the
        // claim holding its lock may still fail to write it, and the next
        // presentation must be decided by the store.
        if (outcome === "contended") return "replay";
        // Remembered only once the store has confirmed the row: written here,
        // or read back from it.
        prune(now);
        seen.set(full, now);
        return outcome;
      } catch (err) {
        noteUnavailable(scope, err);
        return "unavailable";
      }
    },
    resetCacheForTest(): void {
      seen.clear();
      lastPrune = 0;
    },
  };
}

// ─── The two guards ────────────────────────────────────────────────────────

/** Agent auth (TPS-Ed25519). Key `a:<agentId>:<nonce>`. */
export const agentReplayGuard = createReplayGuard({
  scope: "a",
  windowMs: WINDOW_MS,
  windowSource: "FLAIR_AGENT_AUTH_WINDOW_MS",
});

/** Federation body signatures. Key `f:<nonce>`. */
export const federationReplayGuard = createReplayGuard({ scope: "f", windowMs: FEDERATION_WINDOW_MS });

function agentKey(agentId: string, nonce: string): string {
  return `${agentId}:${nonce}`;
}

/**
 * Memory HIT short-circuit for agent auth. May run before the signature is
 * verified; a false says nothing and the request still has to claim.
 */
export function isKnownAgentReplay(agentId: string, nonce: string, now: number = Date.now()): boolean {
  return agentReplayGuard.knownReplay(agentKey(agentId, nonce), now);
}

export type AgentNonceClaim =
  | { ok: true }
  | { ok: false; error: "nonce_replay_detected"; status: 401 }
  | { ok: false; error: "replay_store_unavailable"; status: 503 };

/**
 * Claim (agentId, nonce) for this request, instance-wide. Call it after the
 * signature has verified and before the request has any effect; refuse on
 * anything but `{ ok: true }`.
 */
export async function claimAgentNonce(agentId: string, nonce: string, now: number = Date.now()): Promise<AgentNonceClaim> {
  const verdict = await agentReplayGuard.claim(agentKey(agentId, nonce), now);
  if (verdict === "recorded") return { ok: true };
  if (verdict === "replay") return { ok: false, error: "nonce_replay_detected", status: 401 };
  return { ok: false, error: "replay_store_unavailable", status: 503 };
}

/**
 * The federation endpoints' check (FederationPair, FederationSync): signature,
 * freshness, then the nonce claimed instance-wide. Refuse on anything but ok.
 */
export function verifyFederationRequestBody(body: Record<string, any>, publicKeyB64url: string): Promise<VerifyFreshOnceResult> {
  return verifyBodySignatureFreshOnce(body, publicKeyB64url, {
    windowMs: FEDERATION_WINDOW_MS,
    replay: federationReplayGuard,
  });
}

// ─── XAA ID-JAG jti (flair#2073) ───────────────────────────────────────────

/** Used ID-JAG `jti` values (schemas/oauth.graphql), one row per jti, keyed by the jti. */
export const ID_JAG_REPLAY_TABLE = "IdJagReplay";

/** First element of every jti lock key, so a jti never shares a lock key with a nonce. */
export const ID_JAG_LOCK_NAMESPACE = "flair-replay-id-jag";

export function idJagReplayDeps(): ReplayStoreDeps {
  return {
    table: (databases as any)?.flair?.[ID_JAG_REPLAY_TABLE],
    transaction: (globalThis as any).transaction,
    name: ID_JAG_REPLAY_TABLE,
    lockNamespace: ID_JAG_LOCK_NAMESPACE,
  };
}

/**
 * The reason `deps`' table cannot remember a key for `minRetentionMs`, or null.
 * `basis` completes the sentence that says what the minimum covers.
 */
export function storeRetentionGap(deps: ReplayStoreDeps, minRetentionMs: number, basis: string): string | null {
  const gap = replayStoreContractGap(deps);
  if (gap) return gap;
  const expirationMs = deps.table.expirationMS;
  if (typeof expirationMs === "number" && expirationMs > 0 && expirationMs <= minRetentionMs) {
    return `flair.${deps.name ?? REPLAY_TABLE} keeps rows ${expirationMs} ms, not longer than the ${minRetentionMs} ms ${basis}`;
  }
  return null;
}

/**
 * Claim an ID-JAG's `jti` once per instance, through `recordOnce`. Call it after
 * the assertion has validated and before the grant has any effect; refuse on
 * anything but "recorded". `minRetentionMs` is the longest an accepted
 * assertion can stay acceptable after its jti is recorded: a table whose rows
 * do not outlive it is unavailable.
 */
export async function claimIdJagJti(jti: string, minRetentionMs: number, now: number = Date.now()): Promise<ReplayClaim> {
  try {
    const deps = idJagReplayDeps();
    const gap = storeRetentionGap(deps, minRetentionMs, "an assertion can stay acceptable");
    if (gap) throw new ReplayStoreUnavailable(gap);
    // A lock miss ("contended") is refused like a stored row.
    return (await recordOnce(jti, now, deps)) === "recorded" ? "recorded" : "replay";
  } catch (err) {
    noteUnavailable("x", err, ID_JAG_REPLAY_TABLE);
    return "unavailable";
  }
}

// ─── OAuth single-use records (flair#2145) ─────────────────────────────────

/** One row per redeemed authorization code or rotated refresh token (schemas/oauth.graphql). */
export const OAUTH_SINGLE_USE_TABLE = "OAuthSingleUse";

/** First element of every single-use lock key, so it never collides with a nonce or a jti lock. */
export const OAUTH_SINGLE_USE_LOCK_NAMESPACE = "flair-replay-oauth";

/** Which key a single-use row records: `code` redeems an authorization code, `refresh` rotates a refresh token. */
export type OAuthSingleUseKind = "code" | "refresh";

export function oauthSingleUseDeps(): ReplayStoreDeps {
  return {
    table: (databases as any)?.flair?.[OAUTH_SINGLE_USE_TABLE],
    transaction: (globalThis as any).transaction,
    name: OAUTH_SINGLE_USE_TABLE,
    lockNamespace: OAUTH_SINGLE_USE_LOCK_NAMESPACE,
  };
}

/**
 * Claim a redeemed authorization code (`c:<sha256>`) or a rotated refresh token
 * (`r:<sha256>`) once per instance, through `recordOnce`. Call it after the
 * request has been validated and before it has any effect; refuse on anything
 * but "recorded". `sha256Hex` is the SHA-256 of the code or token, so the
 * record holds no redeemable secret. `minRetentionMs` is the longest the code
 * or token can be presented after its row is recorded: a table whose rows do
 * not outlive it is unavailable.
 */
export async function claimOAuthSingleUse(
  kind: OAuthSingleUseKind,
  sha256Hex: string,
  minRetentionMs: number,
  now: number = Date.now(),
): Promise<ReplayClaim> {
  try {
    const deps = oauthSingleUseDeps();
    const gap = storeRetentionGap(deps, minRetentionMs, "a redeemed authorization code or refresh token can be presented");
    if (gap) throw new ReplayStoreUnavailable(gap);
    // A lock miss ("contended") is refused like a stored row.
    return (await recordOnce(`${kind === "refresh" ? "r" : "c"}:${sha256Hex}`, now, deps)) === "recorded" ? "recorded" : "replay";
  } catch (err) {
    noteUnavailable("o", err, OAUTH_SINGLE_USE_TABLE);
    return "unavailable";
  }
}

// ─── Boot report ───────────────────────────────────────────────────────────

/** Every gap that would refuse requests on this thread, or an empty list. */
export function replayStoreBootGaps(deps: ReplayStoreDeps = harperReplayDeps()): string[] {
  const gaps: string[] = [];
  for (const g of [agentReplayGuard, federationReplayGuard]) {
    const gap = replayWindowGap(g.windowMs, g.windowSource) ?? replayStoreContractGap(deps, g.windowMs);
    if (gap) gaps.push(`${g.scope === "a" ? "agent auth" : "federation"}: ${gap}`);
  }
  return gaps;
}

/** Run during the awaited resource-module import, after graphqlSchema loads. */
function reportAtBoot(fn: () => void): void {
  // Harper defines `server.workerCount` on worker threads; unit tests and the
  // CLI never reach this. The jsResource initial load awaits module imports,
  // and the worker waits for that load before it starts listening.
  if (typeof (globalThis as any).server?.workerCount !== "number") return;
  try {
    fn();
  } catch (err: any) {
    console.error(`[flair-replay] ReplayStoreUnavailable at boot: ${err?.message ?? err}`);
  }
}

// Once per worker thread, after the schema's tables are bound.
reportAtBoot(() => {
  for (const gap of replayStoreBootGaps()) {
    console.error(`[flair-replay] ReplayStoreUnavailable at boot (${gap}). Signed requests on this path are refused.`);
  }
});

/**
 * A store whose rows must outlive a minimum, reported at boot by the module
 * that owns it (the XAA jti store, the OAuth single-use store).
 */
export interface ReplayStoreBootStore {
  /** Names the store in the boot line, e.g. "XAA jti". */
  label: string;
  /** The store's dependencies, resolved when the report runs. */
  deps: () => ReplayStoreDeps;
  /** Rows must be kept longer than this. */
  minRetentionMs: number;
  /** What the minimum covers, for the refusal text: e.g. "an assertion can stay acceptable". */
  retentionBasis: string;
}

/**
 * Every gap that would refuse a request through `store` on this thread, each
 * labelled with the store's name, or an empty list.
 */
export function replayStoreStoreGaps(store: ReplayStoreBootStore): string[] {
  const gap = storeRetentionGap(store.deps(), store.minRetentionMs, store.retentionBasis);
  return gap ? [`${store.label}: ${gap}`] : [];
}

/**
 * Print `store`'s gaps once per worker thread at boot, beside the replay
 * guards' (`replayStoreBootGaps`): a misconfigured table is named before the
 * first request instead of on the first claim. Call it at module load, from the
 * module that owns the store, while Harper awaits that resource import.
 */
export function reportReplayStoreGapsAtBoot(store: ReplayStoreBootStore): void {
  reportAtBoot(() => {
    for (const gap of replayStoreStoreGaps(store)) {
      console.error(
        `[flair-replay] ReplayStoreUnavailable at boot (${gap}). Requests through that store are refused until it is usable (see resources/replay-store.ts).`,
      );
    }
  });
}
