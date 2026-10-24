/**
 * memory-write-lock.ts — the per-memory-id write serialization protocol
 * (flair#2478 slice 1). The ordinary owner PUT and PATCH (resources/Memory.ts,
 * the HTTP re-embed PATCH included), the owner DELETE (with a skill row's live
 * head) and an untagged owner POST naming an id or a `supersedes` target
 * (slice 1 part 2) run under it, and so do the automatic
 * writers converted so far: the visibility backfill and the promotion stamps
 * (slice 2), the embedding backfill that follows a Memory write signed by a
 * verified Ed25519 agent (resources/auth-middleware.ts), the embedding-stamp
 * migration's `.content`-suffix fallback (slice 3), the synthetic CI
 * migration's re-stamp of its own rows, and the operator purge
 * (resources/MemoryPurge.ts, whole target set) (slice 3b); the maintenance
 * archive/expiry action (resources/MemoryMaintenance.ts) and the usage-count
 * writer (resources/usage-recording.ts) (slice 3b part 1); the ordinary
 * (non-skill) feed write-back and the feed dedup repair
 * (resources/MemoryFeed.ts) and both `lastReflected` stamps
 * (resources/Memory.ts's derivedFrom sources and resources/MemoryReflect.ts's
 * gathered sources) (slice 3b part 2); and the federation merge of an
 * incoming Memory row (resources/Federation.ts) and the batch reindex writer
 * (resources/MemoryReindex.ts) (slice 3c); and basement/restore of a
 * non-skill row (resources/MemoryArchive.ts, through the checked write below)
 * (slice 1 part 3a). The other Memory writers convert in later parts.
 *
 * A writer that must make its read, decision and write on one committed basis
 * runs under one key per ID of `Memory.primaryStore`'s lock: `["memory", fullStoredId]`.
 * Within one Harper process the lock is per key and shared by its threads
 * (resources/key-lock.ts). A caller opens and settles its owned transaction
 * inside the callback, so the key is held across the commit. Two PUT paths can
 * join a transaction they do not own, which then commits after the put returns
 * and so after the key is released: a put composed into its caller's
 * transaction (manual promotion, via withComposedWriteTransaction in
 * resources/request-transaction.ts), and the admin `_reindex` re-PUT when the
 * request carries an open transaction, which it joins as it did before the lock
 * (with none open, it owns its transaction and commits before the release).
 *
 * A same-id writer that finds the key held waits and retries within its budget
 * ({@link MEMORY_LOCK_ATTEMPTS} attempts with a {@link MEMORY_LOCK_WAIT_MS} ms
 * wait between them — the bound resources/usage-recording.ts and
 * resources/instruction-version-record.ts use). If the holder releases inside
 * the budget, the writer takes the key, unless an attempt observes an
 * outcome-unknown marker for the id (then it is refused `write_outcome_unknown`,
 * below, even while the key is held). A writer that then opens a new owned
 * transaction (the ordinary PUT and PATCH) reads the row as stored at that
 * moment: the holder's committed row when the holder owned its transaction (a
 * composed or `_reindex` holder that joined another transaction may release
 * before that transaction commits). A composed or `_reindex` writer that joins
 * an already-open request transaction reads from that transaction's snapshot
 * instead, which can predate the acquisition. Otherwise it is refused:
 *
 *  - `503 memory_busy` — the key stayed held for the whole budget. Nothing was
 *    written, so the request can be sent again unchanged. The body carries the
 *    caller id and nothing else: it is byte-identical whether the target id
 *    exists or not, so a lock miss never reveals stored-row state (Sherlock S7).
 *
 * Two more lock refusals, also `503`:
 *
 *  - `memory_lock_unavailable` — `Memory.primaryStore` has no lock. The write
 *    is refused, never run unserialized, and nothing was written. There is no
 *    production fallback; a unit-test double supplies a lock on its mock table.
 *  - `write_outcome_unknown` — the id's last owned write settled with an
 *    unresolved outcome: its commit may have landed while its verification read
 *    failed. Do not replay that write blindly: read the row first, and treat a
 *    row that already holds it as written. {@link markMemoryWriteOutcomeUnknown}
 *    records the marker; until a process restart clears it (the fencing step),
 *    PUT/PATCH check the addressed id; DELETE also checks the resolved skill
 *    head. An automatic writer that takes the lock through
 *    {@link withMemoryWriteLockOnce} writes nothing to a marked id; the feed
 *    dedup repair records the marker when its committed update's confirmation
 *    read fails or does not show the update, and the other automatic writers
 *    do not set it for their own unconfirmed write, which they report or log.
 *    A POST that takes the lock checks the ids it locks; a POST that takes
 *    none, and the writers that take no per-id lock, do not check the marker.
 *
 * The marker is module state, so it is per Harper worker thread. That covers
 * the whole instance only in the supported single-worker mode: flair refuses to
 * serve on more than one worker thread (resources/multi-worker-guard.ts,
 * flair#2059; every route but `/Health` and `/health` answers 503
 * `multi_worker_unsupported`).
 * Under the explicit `FLAIR_MULTI_WORKER_UNSAFE=1` opt-in, a marker set on one
 * worker is not seen by another.
 *
 * The critical section contains the write paths' embedding calls — the ordinary
 * PUT's regen (and its create-path dedup probe), a locked POST's dedup probe
 * and embedding, the re-embed PATCH's compute and its recompute, and the PATCH
 * embedding refresh — and each is bounded by
 * {@link MEMORY_LOCKED_PROVIDER_TIMEOUT_MS} through {@link boundLockedProviderCall};
 * a call still pending when the timeout callback runs, or one that settles after
 * the bound, is refused with `503 memory_provider_timeout` and nothing is
 * written. An in-process timeout cannot preempt a provider that never yields the
 * event loop. The automatic embedding writers compute their vector before they
 * take the lock, so they make no provider call while holding it. A hold longer than
 * {@link MEMORY_LOCK_HOLD_WATCHDOG_MS} is logged — the lock keys and the phase
 * named in {@link MemoryWriteLockOptions.phase}, and elapsed time — when the
 * timer runs or the callback settles. The watchdog never releases a key.
 *
 * Global lock order: a writer takes its sorted Memory id locks first, then the
 * instruction-version lock (resources/instruction-version-record.ts), then the
 * usage ledger (resources/usage-recording.ts). Part 2 converts the writers that
 * take the instruction lock and write Memory to take their Memory id locks
 * before it.
 *
 * Acquisition is sorted and deduplicated, so two writers that share ids take
 * them in the same order. A partial acquisition is released before the wait, so
 * a writer never blocks on the next key while holding one.
 *
 * The lock token (flair#2478 part 3a). The callback receives a
 * {@link MemoryWriteLockToken}, minted after every key of the call is held. Its
 * state lives in a registry private to this module: the store it was acquired
 * on, the sorted ids, the acquisition and whether it is live. A copied or
 * fabricated object is not in the registry, so it is refused. A checked Memory
 * write (resources/Memory.ts `putMemoryWithLock` / `patchMemoryWithLock`)
 * requires a live token for the store and every id it writes, and runs inside
 * the locked transaction scope of resources/memory-write-transaction.ts. When
 * the callback settles, the acquisition closes to new scopes, waits for a scope
 * still open to settle, revokes the token, and only then releases the keys.
 */

import { TEST_FAULT_INJECTION_ENV } from "./txn-pause-point.js";
import type { KeyLockStore } from "./key-lock.js";

/** The `Memory.primaryStore` key namespace (flair#2478). */
export const MEMORY_LOCK_NAMESPACE = "memory";
/** The owner-verb busy budget: {@link MEMORY_LOCK_ATTEMPTS} attempts, {@link MEMORY_LOCK_WAIT_MS} ms apart. */
export const MEMORY_LOCK_ATTEMPTS = 200;
export const MEMORY_LOCK_WAIT_MS = 10;
/** The lock-miss error code. */
export const MEMORY_BUSY_ERROR = "memory_busy";
/** The unresolved-outcome error code. */
export const WRITE_OUTCOME_UNKNOWN_ERROR = "write_outcome_unknown";
/** The no-lock error code: the store has no per-id lock, so the write is refused. */
export const MEMORY_LOCK_UNAVAILABLE_ERROR = "memory_lock_unavailable";
/** The provider-bound error code: an embedding call made under the lock outlasted its bound. */
export const MEMORY_PROVIDER_TIMEOUT_ERROR = "memory_provider_timeout";

/** The bound on one embedding provider call made while the per-id write lock is
 *  held (flair#2478). See {@link boundLockedProviderCall}. */
export const MEMORY_LOCKED_PROVIDER_TIMEOUT_MS = 20_000;
/** The observe-only hold watchdog's threshold (flair#2478). If the event loop
 *  cannot resume during a long hold, logging waits for settlement. No lock release. */
export const MEMORY_LOCK_HOLD_WATCHDOG_MS = 5_000;
/** Env overrides, honoured only under the fault-injection gate, that lower the
 *  two bounds for tests (a never-resolving stub or a long hold would otherwise
 *  cost the test its own bound). */
export const MEMORY_PROVIDER_TIMEOUT_ENV = "FLAIR_MEMORY_LOCK_PROVIDER_TIMEOUT_MS";
export const MEMORY_LOCK_HOLD_WATCHDOG_ENV = "FLAIR_MEMORY_LOCK_HOLD_WATCHDOG_MS";

/** A provider call still pending when the timeout callback runs, or settling after the bound, is refused with this error. */
export class MemoryProviderTimeout extends Error {
  constructor(readonly ms: number) {
    super(`an embedding provider call made under the memory write lock did not settle within ${ms}ms`);
    this.name = "MemoryProviderTimeout";
  }
}

/** The provider bound in force: {@link MEMORY_LOCKED_PROVIDER_TIMEOUT_MS}, or the
 *  test override when the fault-injection gate is on. */
export function memoryLockedProviderTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const override = testBound(env, MEMORY_PROVIDER_TIMEOUT_ENV);
  return override ?? MEMORY_LOCKED_PROVIDER_TIMEOUT_MS;
}

/** The hold-watchdog threshold in force: {@link MEMORY_LOCK_HOLD_WATCHDOG_MS},
 *  or the test override when the fault-injection gate is on. */
export function memoryLockHoldWatchdogMs(env: NodeJS.ProcessEnv = process.env): number {
  const override = testBound(env, MEMORY_LOCK_HOLD_WATCHDOG_ENV);
  return override ?? MEMORY_LOCK_HOLD_WATCHDOG_MS;
}

/** A positive, finite override read only under the fault-injection gate. */
function testBound(env: NodeJS.ProcessEnv, name: string): number | undefined {
  if (env[TEST_FAULT_INJECTION_ENV] !== "1") return undefined;
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Run one embedding provider call bounded by {@link memoryLockedProviderTimeoutMs}.
 * `getEmbedding` takes no AbortSignal and swallows its own failures (returning
 * null). A call still pending when the timeout callback runs, or one that settles
 * after the bound (checked against elapsed time at settlement), rejects with
 * {@link MemoryProviderTimeout}; the caller refuses 503 `memory_provider_timeout`
 * without writing. The provider call itself is not cancelled, and a provider that
 * never yields the event loop cannot be preempted.
 */
export function boundLockedProviderCall<T>(call: () => Promise<T>, env: NodeJS.ProcessEnv = process.env): Promise<T> {
  const ms = memoryLockedProviderTimeoutMs(env);
  const started = performance.now();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new MemoryProviderTimeout(ms)), ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    call().then(
      (value) => {
        clearTimeout(timer);
        if (performance.now() - started > ms) reject(new MemoryProviderTimeout(ms));
        else resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(performance.now() - started > ms ? new MemoryProviderTimeout(ms) : error);
      },
    );
  });
}

/** Per-id unknown-outcome markers (Kern pin 2 / Flint decision). Module state:
 *  one set per worker thread, which is the whole instance in the supported
 *  single-worker mode (see the header). */
const outcomeUnknown = new Set<string>();

/** The `["memory", fullStoredId]` lock key for one stored id. */
export function memoryLockKey(id: string | number): string[] {
  return [MEMORY_LOCK_NAMESPACE, String(id)];
}

/** Record that `id`'s last owned write settled with an unknown outcome. Cleared
 *  only by process restart — there is no production clear path. */
export function markMemoryWriteOutcomeUnknown(id: string | number): void {
  outcomeUnknown.add(String(id));
}

/** Is `id` marked outcome-unknown? A later writer checks this before acquiring. */
export function memoryWriteOutcomeUnknown(id: string | number): boolean {
  return outcomeUnknown.has(String(id));
}

/** TEST-ONLY: forget the marker for `id` so one test cannot leak into the next.
 *  Never called by production code (the production clear path is restart). */
export function resetMemoryWriteOutcomeUnknownForTest(id: string | number): void {
  outcomeUnknown.delete(String(id));
}

declare const MEMORY_WRITE_LOCK_TOKEN: unique symbol;
/** The capability the lock callback receives (flair#2478 part 3a). Opaque: an
 *  empty frozen object whose state is in this module's private registry. */
export type MemoryWriteLockToken = { readonly [MEMORY_WRITE_LOCK_TOKEN]: true };

/** Why a token or a locked transaction was refused. */
export type MemoryWriteCapabilityRefusal =
  | "not_a_token"
  | "revoked"
  | "wrong_store"
  | "id_not_covered"
  | "scope_open"
  | "not_a_transaction"
  | "transaction_mismatch"
  | "transaction_closed";

/** A checked write or a locked transaction scope was refused its capability. */
export class MemoryWriteCapabilityError extends Error {
  constructor(readonly reason: MemoryWriteCapabilityRefusal, message: string) {
    super(`memory write capability refused (${reason}): ${message}`);
    this.name = "MemoryWriteCapabilityError";
  }
}

/** How a locked transaction scope settled: a rejection carries its error. */
type ScopeSettlement = { ok: true } | { ok: false; error: unknown };

interface TokenState {
  readonly store: KeyLockStore;
  readonly ids: readonly string[];
  readonly idSet: ReadonlySet<string>;
  /** This acquisition's identity: a new object per acquisition. */
  readonly acquisition: object;
  live: boolean;
  /** False once the callback has settled: no new scope is admitted. */
  admitting: boolean;
  /** The locked transaction scope open on this acquisition, if any. */
  open: Promise<ScopeSettlement> | null;
}

/** The registry: the authoritative state of every token this module minted. */
const tokens = new WeakMap<object, TokenState>();

function mintToken(store: KeyLockStore, ids: readonly string[]): MemoryWriteLockToken {
  const token = Object.freeze(Object.create(null)) as MemoryWriteLockToken;
  const frozen = Object.freeze([...ids]);
  tokens.set(token, {
    store, ids: frozen, idSet: new Set(frozen), acquisition: Object.freeze({}), live: true, admitting: true, open: null,
  });
  return token;
}

function tokenState(held: unknown): TokenState {
  const state = held !== null && typeof held === "object" ? tokens.get(held) : undefined;
  if (!state) throw new MemoryWriteCapabilityError("not_a_token", "not a lock token issued by this registry");
  return state;
}

/**
 * Refuse `held` unless it is a live token from this registry, acquired on
 * `expected.store` (when given) and covering every id in `expected.ids` (when
 * given). Throws {@link MemoryWriteCapabilityError}.
 */
export function assertMemoryWriteLockToken(
  held: unknown,
  expected: { store?: unknown; ids?: readonly (string | number)[] } = {},
): void {
  const state = tokenState(held);
  if (!state.live) throw new MemoryWriteCapabilityError("revoked", "the lock token's acquisition has been released");
  if ("store" in expected && expected.store !== state.store) {
    throw new MemoryWriteCapabilityError("wrong_store", "the lock token was acquired on another store");
  }
  for (const id of expected.ids ?? []) {
    if (!state.idSet.has(String(id))) {
      throw new MemoryWriteCapabilityError("id_not_covered", "the write names an id the lock token does not hold");
    }
  }
}

/** The sorted ids a token holds (read from the registry). Throws for a non-token. */
export function memoryWriteLockTokenIds(held: unknown): readonly string[] {
  return tokenState(held).ids;
}

/** The identity of the acquisition a token belongs to (read from the registry). */
export function memoryWriteLockAcquisition(held: unknown): object {
  return tokenState(held).acquisition;
}

/**
 * Admit one locked transaction scope on a live token's acquisition
 * (resources/memory-write-transaction.ts). Synchronous, so the acquisition
 * knows about the scope before the scope's first suspension. One scope is open
 * at a time; none is admitted after the callback has settled. The returned
 * `settle` reports how the scope ended.
 */
export function admitLockedScope(held: unknown): { settle(failure?: { error: unknown }): void } {
  assertMemoryWriteLockToken(held);
  const state = tokenState(held);
  if (!state.admitting) throw new MemoryWriteCapabilityError("revoked", "the lock callback has settled");
  if (state.open) throw new MemoryWriteCapabilityError("scope_open", "a locked transaction is already open on this acquisition");
  let settle!: (value: ScopeSettlement) => void;
  const open = new Promise<ScopeSettlement>((resolve) => { settle = resolve; });
  state.open = open;
  let settled = false;
  return {
    settle(failure?: { error: unknown }) {
      if (settled) return;
      settled = true;
      if (state.open === open) state.open = null;
      settle(failure ? { ok: false, error: failure.error } : { ok: true });
    },
  };
}

/**
 * Close the acquisition to new scopes, wait for a scope still open to settle,
 * then revoke the token. With `propagate`, a failure or refusal of a scope
 * that was still open when the callback settled is thrown (the callback did
 * not await it); a refusal arrives as a `LockedScopeRefusedError`.
 */
async function settleAcquisition(held: MemoryWriteLockToken, propagate: boolean): Promise<void> {
  const state = tokens.get(held)!;
  state.admitting = false;
  const open = state.open;
  const settlement = open ? await open : { ok: true as const };
  state.live = false;
  if (propagate && !settlement.ok) throw settlement.error;
}

function revokeToken(held: MemoryWriteLockToken): void {
  const state = tokens.get(held);
  if (state) {
    state.admitting = false;
    state.live = false;
  }
}

/** The optional per-call context: the phase the hold warning names. */
export interface MemoryWriteLockOptions {
  readonly phase?: string;
}

export type MemoryLockOutcome<T> =
  | { kind: "done"; value: T }
  | { kind: "busy" }
  | { kind: "unknown"; id: string }
  | { kind: "unavailable" };

type LockableStore = Partial<KeyLockStore> | null | undefined;

/** The sorted, deduplicated ids and their lock keys. */
function normalizeIds(ids: readonly (string | number)[]): { ids: string[]; keys: string[][] } {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    const text = String(id);
    if (!seen.has(text)) {
      seen.add(text);
      unique.push(text);
    }
  }
  unique.sort();
  return { ids: unique, keys: unique.map(memoryLockKey) };
}

function lockStore(store: unknown): KeyLockStore | undefined {
  const lock = store as LockableStore;
  if (typeof lock?.tryLock !== "function" || typeof lock?.unlock !== "function") return undefined;
  return lock as KeyLockStore;
}

function releaseAll(lock: KeyLockStore, acquired: string[][]): void {
  for (let i = acquired.length - 1; i >= 0; i--) lock.unlock(acquired[i]);
  acquired.length = 0;
}

/**
 * Run `fn` while holding every `["memory", id]` key for `ids` (sorted,
 * deduplicated), up to {@link MEMORY_LOCK_ATTEMPTS} attempts spaced
 * {@link MEMORY_LOCK_WAIT_MS}. Returns `busy` when the budget is exhausted;
 * `unknown` when one of the ids carries an unknown-outcome marker; `unavailable`
 * when the store has no lock or `ids` is empty. `fn` does not run in those cases.
 */
export async function withMemoryWriteLock<T>(
  store: unknown,
  ids: readonly (string | number)[],
  fn: (held: MemoryWriteLockToken) => Promise<T>,
  options: MemoryWriteLockOptions = {},
): Promise<MemoryLockOutcome<T>> {
  return acquire(lockStore(store), normalizeIds(ids), MEMORY_LOCK_ATTEMPTS, MEMORY_LOCK_WAIT_MS, fn, options);
}

/** One attempt, no wait, per call; a writer that retries calls it again and
 *  acquires again. Used by the automatic writers: the visibility
 *  backfill, the automatic promotion stamp, the embedding backfill, the
 *  embedding-stamp migration's `.content`-suffix fallback, the synthetic CI
 *  migration's re-stamp, the maintenance archive/expiry action, the
 *  usage-count writer, the feed dedup repair, both `lastReflected` stamps,
 *  the federation merge of a Memory row and the batch
 *  reindex writer. A held lock or a
 *  marker answers `busy`/`unknown`; that attempt of the writer writes nothing
 *  (an earlier attempt of the same call may have; each writer logs that).
 *  Whether the id is visited again is each writer's own rule (a later scan
 *  decides whether a migration row is still stale; the embedding backfill runs
 *  again only after the id's next successful HTTP Memory POST, PUT or PATCH
 *  signed by a verified Ed25519 agent, the requests that reach the auth
 *  middleware's post-response hook; a Basic-admin write starts none; a later
 *  federation re-offer or reindex run retries the row). */
export async function withMemoryWriteLockOnce<T>(
  store: unknown,
  ids: readonly (string | number)[],
  fn: (held: MemoryWriteLockToken) => Promise<T>,
  options: MemoryWriteLockOptions = {},
): Promise<MemoryLockOutcome<T>> {
  return acquire(lockStore(store), normalizeIds(ids), 1, 0, fn, options);
}

/** Start the observe-only watchdog; return its settlement check. */
function startHoldWatchdog(keys: readonly (readonly string[])[], phase: string): () => void {
  const ms = memoryLockHoldWatchdogMs();
  const started = performance.now();
  let logged = false;
  const logHold = () => {
    if (logged) return;
    logged = true;
    console.warn(`[memory-write-lock] hold exceeded ${ms}ms: keys=${JSON.stringify(keys)} phase=${phase} elapsed=${Math.round(performance.now() - started)}ms`);
  };
  const timer = setTimeout(logHold, ms);
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => {
    clearTimeout(timer);
    if (performance.now() - started > ms) logHold();
  };
}

async function acquire<T>(
  lock: KeyLockStore | undefined,
  normalized: { ids: string[]; keys: string[][] },
  attempts: number,
  waitMs: number,
  fn: (held: MemoryWriteLockToken) => Promise<T>,
  options: MemoryWriteLockOptions = {},
): Promise<MemoryLockOutcome<T>> {
  if (!lock || normalized.keys.length === 0) return { kind: "unavailable" };
  const acquired: string[][] = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    const marked = normalized.ids.find((id) => memoryWriteOutcomeUnknown(id));
    if (marked !== undefined) return { kind: "unknown", id: marked };
    let gotAll = true;
    for (const key of normalized.keys) {
      if (lock.tryLock(key)) acquired.push(key);
      else {
        gotAll = false;
        break;
      }
    }
    if (gotAll) {
      const watchdog = startHoldWatchdog(normalized.keys, options.phase ?? "unknown");
      // The token is minted only now, with every key of the call held.
      const scope = mintToken(lock, normalized.ids);
      let settled = false;
      try {
        lock.resetReadTxn?.();
        // The marker was checked at the top of this attempt; nothing between
        // that check and here yields, so it cannot have changed.
        const outcome: MemoryLockOutcome<T> = { kind: "done", value: await fn(scope) };
        settled = true;
        await settleAcquisition(scope, true);
        return outcome;
      } finally {
        if (!settled) await settleAcquisition(scope, false);
        revokeToken(scope);
        watchdog();
        // Release only after `fn` returns and any locked transaction scope on
        // this acquisition has settled. A callback that owns its transaction
        // has settled it by then, so the lock spans that commit; a transaction
        // the callback only joined commits later, after this release.
        releaseAll(lock, acquired);
      }
    }
    // Partial acquisition: release what we hold before waiting on the rest.
    releaseAll(lock, acquired);
    if (attempt + 1 < attempts && waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  return { kind: "busy" };
}

/** The lock-miss refusal: `503 memory_busy`, caller id only, no row state. */
export function memoryBusyResponse(callerId: string): Response {
  return new Response(JSON.stringify({ error: MEMORY_BUSY_ERROR, caller: callerId }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
}

/** The unresolved-outcome refusal: `503 write_outcome_unknown`. */
export function writeOutcomeUnknownResponse(): Response {
  return new Response(
    JSON.stringify({
      error: WRITE_OUTCOME_UNKNOWN_ERROR,
      outcome: "unconfirmed",
      message: "the write outcome is unknown. Read the affected row before writing again.",
    }),
    { status: 503, headers: { "content-type": "application/json" } },
  );
}

/** The provider-bound refusal: `503 memory_provider_timeout`. Nothing was written. */
export function memoryProviderTimeoutResponse(): Response {
  return new Response(
    JSON.stringify({
      error: MEMORY_PROVIDER_TIMEOUT_ERROR,
      message: "the embedding provider did not answer within its bound; nothing was written, retry",
    }),
    { status: 503, headers: { "content-type": "application/json" } },
  );
}

/** The no-lock refusal: `503 memory_lock_unavailable`. Nothing was written. */
export function memoryLockUnavailableResponse(): Response {
  return new Response(
    JSON.stringify({
      error: MEMORY_LOCK_UNAVAILABLE_ERROR,
      message: "this instance's Memory store has no per-id write lock, so the write was refused; nothing was written",
    }),
    { status: 503, headers: { "content-type": "application/json" } },
  );
}
