/**
 * embedding-space-guard.ts — the QUERY-TIME vector-space uniformity gate
 * (embedding-provider-seam design §3, slice 1; K&S-final).
 *
 * ─── The bug this closes ────────────────────────────────────────────────────
 * There is NO query-time embedding-space guard today. Search cosines a query
 * against every stored vector regardless of its `embeddingModel` stamp;
 * Harper's `cosineDistance` silently zero-pads a mismatched-dimension vector
 * and returns a garbage score instead of throwing (same-dims/different-space
 * is silent garbage too), and `health.ts` only *warns*. So a mixed-space
 * corpus — the transient state during ANY re-embed / model change — serves
 * silently-wrong recall. This module makes a mismatched-space cosine
 * impossible by construction on BOTH runtime cosine legs (recall + write-time
 * dedup), the load-bearing safety piece Kern made a condition of sign-off.
 *
 * ─── Shape ──────────────────────────────────────────────────────────────────
 * A PURE core (`normalizeStamp` / `currentSpaceRawForms` / `isUniformStampSet`
 * — Harper-free, unit-testable directly, same discipline as dedup.ts / bm25.ts)
 * plus a boot-computed + write-maintained "corpus uniform in the current space"
 * LATCH so the gate costs ~nothing per query:
 *   - boot pre-warm scans the DISTINCT active stamps once (module side effect,
 *     same convention as embeddings-boot.ts / migration-boot.ts);
 *   - a write persisting a FOREIGN stamp (federation / replication / an
 *     explicit-stamp PUT) trips the latch immediately, no rescan;
 *   - while tripped, a consult re-verifies at most once per RECHECK_MS, so a
 *     completed re-embed REOPENS the gate automatically (any re-embed path —
 *     the boot migration OR a live `flair reembed`), with no cross-process
 *     signal needed.
 * Both runtime legs consult the SAME `isEmbeddingSpaceUniform()` — a single
 * chokepoint (like `prefixesEnabled()`), never scattered per-call-site checks.
 *
 * ─── Why the harper import is deferred ──────────────────────────────────────
 * `harper` is dynamic-imported inside the scan only (never a top-level import)
 * — exactly the reason embeddings-provider.ts defers it: a static
 * `import { databases } from "harper"` would make ANY test that imports this
 * file for its pure core alone eagerly load Harper's real `dist/index.js`,
 * which throws at module scope outside a real Harper boot. The pure exports
 * carry no harper dependency at all.
 */
import { EMBEDDING_ENGINE, getModelId } from "./embeddings-provider.js";

// ─── Pure core (Harper-free) ────────────────────────────────────────────────

/**
 * Stamps that denote "no real vector space" and so never contribute to the
 * uniformity set: an absent/empty stamp, and the legacy `hash-512d`
 * hash-fallback marker (a row with no genuine model embedding). A missing or
 * empty stored embedding cosines to a safe 0 (retrieval-core / dedup both
 * guard `Array.isArray(embedding) ? … : []`), never a cross-space garbage
 * score, so excluding these mirrors health.ts's own `realModels` filter.
 */
const NON_SPACE_STAMPS: ReadonlySet<string> = new Set(["hash-512d"]);

/**
 * Canonicalize an `embeddingModel` stamp to its ENGINE-QUALIFIED space id, or
 * `null` for a no-vector-space stamp. This is the one-time bare-name → `gguf:`
 * equivalence: today's corpus is stamped with the BARE nomic name (no engine
 * prefix), which denotes the SAME space as the engine-qualified id
 * `getModelId()` now writes — so a bare stamp must NOT read as a foreign space
 * and false-trip the gate. A qualified stamp (any engine, contains `:`) is
 * already canonical; a bare stamp (no `:`) is the legacy gguf form and gets the
 * `<engine>:` prefix. `getModelId()` guarantees a model id never itself
 * contains `:` (it rejects a `FLAIR_EMBEDDING_MODEL` override that does), so a
 * single `:` unambiguously separates engine from model.
 */
export function normalizeStamp(stamp: string | null | undefined): string | null {
  if (stamp == null) return null;
  const s = String(stamp).trim();
  if (s === "" || NON_SPACE_STAMPS.has(s)) return null;
  return s.includes(":") ? s : `${EMBEDDING_ENGINE}:${s}`;
}

/** The bare model id of an engine-qualified stamp (`gguf:x` → `x`); a stamp
 *  with no engine prefix is returned unchanged. Inverse of the prefixing in
 *  `normalizeStamp`. */
export function stripEnginePrefix(stamp: string): string {
  const i = stamp.indexOf(":");
  return i === -1 ? stamp : stamp.slice(i + 1);
}

/**
 * The RAW stamp forms that all denote the CURRENT embedding space: the
 * engine-qualified id `getModelId()` returns, plus its one-time bare-name
 * equivalent. A stamp comparator (the migration's staleCondition, the CLI's
 * `--stale-only`) treats a row as current-space iff its stamp is one of these,
 * so a bare-stamped legacy row is never re-embedded as "stale". De-duplicated
 * so a bare `currentModelId` (a unit-test injection) yields a single form.
 */
export function currentSpaceRawForms(currentModelId: string): string[] {
  return [...new Set([currentModelId, stripEnginePrefix(currentModelId)])];
}

/** Pure: is `stamp` one of the current-space raw forms? (metadata-string
 *  compare only — never a vector-byte comparison; see
 *  embedding-identity-tripwire.test.ts / flair#749). */
export function isCurrentSpaceStamp(stamp: string | null | undefined, currentModelId: string): boolean {
  const n = normalizeStamp(stamp);
  return n !== null && n === normalizeStamp(currentModelId);
}

/**
 * Pure: is every active (real-vector) stamp in the set the current space? An
 * empty set (fresh store) is uniform. No-vector stamps (null / `hash-512d`)
 * are ignored — they carry no cross-space cosine hazard.
 */
export function isUniformStampSet(
  distinctStamps: Iterable<string | null | undefined>,
  currentModelId: string,
): boolean {
  const current = normalizeStamp(currentModelId);
  for (const raw of distinctStamps) {
    const n = normalizeStamp(raw);
    if (n === null) continue;
    if (n !== current) return false;
  }
  return true;
}

// ─── Boot-computed + write-maintained latch (per Harper worker process) ──────

type MemoryTableLike = { search(query: unknown): AsyncIterable<Record<string, unknown>> };

async function defaultTableGetter(): Promise<MemoryTableLike> {
  const { databases } = await import("harper");
  return (databases as unknown as { flair: { Memory: MemoryTableLike } }).flair.Memory;
}

let _tableGetter: () => Promise<MemoryTableLike> = defaultTableGetter;
let _modelIdGetter: () => string = getModelId;

// `undefined` = not yet computed (pre-boot). Consult treats this as "scan
// now"; a scan failure leaves it undefined so the next consult retries rather
// than caching a verdict we could not compute.
let _uniform: boolean | undefined = undefined;
let _activeStamps: string[] = []; // normalized, capped — for the degrade diagnostic only
let _lastScanAt = 0;
let _scanning: Promise<void> | undefined;

// While the latch is TRIPPED, re-verify at most this often, so a completed
// re-embed reopens the gate without paying a scan on every degraded query.
// The happy (uniform) path never scans here at all — it returns in O(1).
const RECHECK_MS = 30_000;
const MAX_DIAG_STAMPS = 12;

async function scan(): Promise<void> {
  const current = normalizeStamp(_modelIdGetter());
  const seen = new Set<string>();
  let uniform = true;
  try {
    const table = await _tableGetter();
    // Project ONLY the stamp — never the vector — so the boot scan is far
    // cheaper than health.ts's existing full-record corpus read.
    for await (const row of table.search({ select: ["embeddingModel"] })) {
      const n = normalizeStamp((row as { embeddingModel?: unknown }).embeddingModel as string | null | undefined);
      if (n === null) continue;
      if (seen.size < MAX_DIAG_STAMPS) seen.add(n);
      if (n !== current) uniform = false;
    }
    _activeStamps = [...seen];
    _uniform = uniform;
    _lastScanAt = Date.now();
  } catch {
    // No live table yet (boot race) — leave the prior verdict untouched and
    // retry on the next consult. Never cache a verdict we couldn't compute.
  }
}

function runScan(): Promise<void> {
  if (!_scanning) _scanning = scan().finally(() => { _scanning = undefined; });
  return _scanning;
}

/**
 * THE single chokepoint. Returns true when the store is uniform in the current
 * embedding space (safe to cosine the query/candidate against stored vectors),
 * false when it is not (a mixed-space corpus — the caller must NOT cosine).
 *
 * O(1) on the happy path: once known-uniform, no scan, no allocation. Only
 * (re)scans when the latch is unknown (pre-boot) or tripped-and-stale.
 */
export async function isEmbeddingSpaceUniform(): Promise<boolean> {
  if (_uniform === true) return true;
  if (_uniform === undefined || Date.now() - _lastScanAt >= RECHECK_MS) {
    await runScan();
  }
  return _uniform ?? true;
}

/**
 * Write-maintained trip: a persisted FOREIGN-space stamp closes the gate
 * immediately, no rescan. A normal local write always stamps the current id
 * (`getModelId()`), so it never trips; only a federation/replication write or
 * an explicit-stamp PUT carrying another space's stamp does.
 */
export function noteWriteStamp(stamp: string | null | undefined): void {
  const n = normalizeStamp(stamp);
  if (n === null) return;
  if (n !== normalizeStamp(_modelIdGetter())) {
    if (!_activeStamps.includes(n) && _activeStamps.length < MAX_DIAG_STAMPS) _activeStamps.push(n);
    _uniform = false;
  }
}

/**
 * Force a fresh corpus scan and return the resulting uniformity. The explicit
 * "re-embed completion clears it" primitive — used by the boot pre-warm, and
 * callable after a bulk re-embed to reopen the gate promptly rather than
 * waiting out RECHECK_MS.
 */
export async function recomputeLatch(): Promise<boolean> {
  _lastScanAt = 0; // bypass the throttle
  await scan();
  return _uniform ?? true;
}

/**
 * Structured diagnostic for the degrade path — the current space id and the
 * (capped) set of distinct active stamps observed, so the recall leg's
 * `_warning` can name both spaces + the `flair reembed` remedy. Metadata
 * strings only, never vectors.
 */
export function spaceGuardDiagnostics(): { current: string; found: string[] } {
  return { current: normalizeStamp(_modelIdGetter()) ?? _modelIdGetter(), found: [..._activeStamps] };
}

// ─── Boot pre-warm (module side effect) ──────────────────────────────────────
// Best-effort, single-shot, deferred to after the current synchronous load
// phase (same setImmediate convention as migration-boot.ts). If it fires
// before the Memory table is live, the scan silently no-ops and the first real
// consult computes the latch lazily — correctness never depends on this
// pre-warm, only the first query's latency does.
let _prewarmScheduled = false;
export function scheduleSpaceGuardPrewarm(): void {
  if (_prewarmScheduled) return;
  _prewarmScheduled = true;
  setImmediate(() => { void recomputeLatch().catch(() => {}); });
}

// Test-only seams — mirror embeddings-boot.ts's `_resetEmbeddingsBackendRegistrationForTests`.
export function _setGuardTableGetterForTests(fn: () => Promise<MemoryTableLike>): void { _tableGetter = fn; }
export function _setGuardModelIdForTests(fn: () => string): void { _modelIdGetter = fn; }
export function _resetGuardForTests(): void {
  _tableGetter = defaultTableGetter;
  _modelIdGetter = getModelId;
  _uniform = undefined;
  _activeStamps = [];
  _lastScanAt = 0;
  _scanning = undefined;
  _prewarmScheduled = false;
}

scheduleSpaceGuardPrewarm();
