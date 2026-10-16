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
 * Both runtime legs consult the SAME verdict — the recall leg through
 * `embeddingSpaceVerdict()`, the dedup leg through `isEmbeddingSpaceUniform()`,
 * both over one consult — a single chokepoint (like `prefixesEnabled()`), never
 * scattered per-call-site checks.
 *
 * ─── Unknown verdict = FAIL CLOSED (flair#2530) ──────────────────────────────
 * A scan can be pending (before the first scan completes) or fail (a boot race,
 * a transient read error). The verdict is then UNKNOWN, and "unknown" is NOT
 * "known uniform": only a scan that found every row which stores a vector to
 * carry a trusted current-space `embeddingModel` stamp opens the gate
 * (`isEmbeddingSpaceUniform()` returns true). That is STAMP-METADATA
 * uniformity over the rows that store a vector: the scan counts a row that
 * stores a vector and whose `embeddingModel` is not a trusted current-space
 * stamp — an absent stamp, the hash-fallback marker `hash-512d`, or a foreign
 * model — with the same raw comparison the vector query's stamp condition uses,
 * and a count above zero makes the verdict non-uniform (flair#2573 slice 1).
 * What a caller-supplied vector's bytes contain is still not verified; that is
 * deferred to slice 2). Every non-uniform state — pending
 * (`unverified`), a failed scan (`scan-failed`), a non-current stamp observed
 * by a scan or a foreign write (`mixed`), or a stored vector without a trusted
 * stamp (`excluded`) — makes a consumer take its
 * MIXED-space path: when a query embedding is available outside bm25-only
 * mode, the recall leg drops it and
 * serves keyword-only results (none, for a request with no query text; for
 * `explain: true`, a plan with no embedding leg) with a state-named warning;
 * the dedup leg no-ops. A recall in bm25-only mode (which never uses a query
 * embedding, so a supplied one is dropped unconsulted) or after a failed
 * embedding generation never consults the guard and has no state to name. A
 * consult never blocks on an in-flight scan to obtain a verdict; it fails closed now,
 * and only a later SUCCESSFUL scan that finds the stamps uniform reopens the
 * gate. An error from the scan's table lookup or corpus read is classified into
 * a bounded reason (never row content); a published failure is logged once per
 * reason, a refused stale one each time it is refused; the consult schedule
 * retries unchanged. A known foreign stamp outranks a scan error: the state is
 * `mixed` whenever one is known, and `reason` keeps the last failed scan's
 * error whether that scan failed before or after the stamp was seen.
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
import { TEST_FAULT_INJECTION_ENV, txnPausePoint } from "./txn-pause-point.js";

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
/** Pure: does the row store a vector? A row with no vector never enters the
 *  HNSW graph, so it is no hazard to a vector query whatever its stamp. */
export function hasStoredVector(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : ArrayBuffer.isView(value) ? value.byteLength > 0 : false;
}

/** Pure: is `stamp` EXACTLY one of the current space's raw forms? The vector
 *  query's stamp condition matches raw strings (Harper `equals`), so this is the
 *  comparison the admission rule makes — no trimming. */
export function isTrustedRawStamp(stamp: string | null | undefined, currentModelId: string): boolean {
  return typeof stamp === "string" && currentSpaceRawForms(currentModelId).includes(stamp);
}

/** Pure: is every active (real-vector) stamp in the set the current space? An
 *  empty set (fresh store) is uniform. No-vector stamps (null / `hash-512d`)
 *  are ignored — they carry no cross-space cosine hazard. */
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
// flair#2573 slice 1 — how many rows the last published scan found that store a
// vector but carry no trusted current-space stamp (absent, `hash-512d`, or a
// non-current model). `null` until a scan publishes (an unknown count is never
// reported as zero). A count above zero makes the verdict non-uniform: a stored
// vector of unknown space is one the runtime cosine legs must not touch.
let _excluded: number | null = null;
// flair#2573 slice 1 — a write that stores a vector without a trusted stamp (an
// absent stamp, the `hash-512d` marker, or a foreign space) can change the
// count, and advances `_writeEpoch` so an in-flight scan cannot publish the
// older count or clear this flag. While set, the consult fails closed; a scan
// that publishes a fresh count clears it.
let _excludedStale = false;
let _lastScanAt = 0;
let _scanning: Promise<void> | undefined;
// flair#2481 — foreign-space write notes invalidate an in-flight scan's verdict.
let _writeEpoch = 0;
// flair#2530 — the bounded reason of the last failed scan that published, or
// null; cleared when a later scan publishes a verdict. It reads as
// `scan-failed` unless a foreign stamp is known, which makes the state `mixed`
// (see guardSnapshot).
let _lastScanError: string | null = null;
const _loggedScanErrorReasons = new Set<string>();
// flair#2508 — scan-start ordering. `recomputeLatch()` (the boot pre-warm's
// path) runs `scan()` directly, bypassing the `_scanning` latch that serialises
// consult scans, so two scans can overlap; a scan that started earlier and
// finishes later must not overwrite the verdict of one that started later.
// Each scan takes the next sequence number when it begins and publishes only
// when no scan that started later has already published. When the write epoch
// is unchanged, a refused publish is named and writes nothing; when a foreign
// write changed the epoch, the #2481 check in scan() runs first instead,
// discarding the scan and resetting the retry timer. A failed scan's error
// (flair#2530) is an outcome under the same rules: it publishes, and advances
// `_publishedScanSeq`, only when no later-started scan has published.
let _scanSeq = 0;
let _publishedScanSeq = 0;

// While the latch is TRIPPED, re-verify at most this often, so a completed
// re-embed reopens the gate without paying a scan on every degraded query.
// The happy (uniform) path never scans here at all — it returns in O(1).
const RECHECK_MS = 30_000;
const MAX_DIAG_STAMPS = 12;

async function scan(): Promise<void> {
  const startEpoch = _writeEpoch;
  const scanSeq = ++_scanSeq;
  // Test-only: inert unless the fault-injection opt-in is set and this point is
  // armed. It holds this scan before its read, so a consult that arrives while
  // the boot pre-warm is parked observes the unknown (not-yet-verified) verdict
  // a real boot window exposes.
  const parked = txnPausePoint("space-guard-scan");
  if (parked) await parked;
  const currentStamp = _modelIdGetter();
  const currentNorm = normalizeStamp(currentStamp);
  // The raw forms that denote the current space, compared EXACTLY as the vector
  // query's stamp condition compares them (Harper `equals` applies no whitespace
  // or prefix normalisation). A row whose raw stamp is not one of these is not
  // one the vector legs may touch.
  const trustedRaw = new Set(currentSpaceRawForms(currentStamp));
  const seen = new Set<string>();
  let uniform = true;
  // Rows that store a vector but carry no trusted current-space stamp. A count
  // above zero makes the verdict non-uniform (see `guardSnapshot`).
  let excluded = 0;
  // Which half of the scan threw, for the bounded failure reason below.
  let phase: "table" | "read" = "table";
  try {
    const table = await _tableGetter();
    phase = "read";
    // Project the stamp and the vector attribute. Two rules, kept separate:
    //  - uniformity (flair#2481, unchanged): any space-bearing stamp that is not
    //    the current space makes the corpus `mixed`, whether or not the row
    //    stores a vector;
    //  - the excluded count (flair#2573): a row that stores a vector without a
    //    trusted current-space stamp. A row with no vector never enters the HNSW
    //    graph, so it is not counted.
    for await (const row of table.search({ select: ["embeddingModel", "embedding"] })) {
      const rec = row as { embeddingModel?: unknown; embedding?: unknown };
      const raw = typeof rec.embeddingModel === "string" ? rec.embeddingModel : null;
      const n = normalizeStamp(raw);
      if (n !== null) {
        if (seen.size < MAX_DIAG_STAMPS) seen.add(n);
        if (n !== currentNorm) uniform = false;
      }
      if (hasStoredVector(rec.embedding) && !(raw !== null && trustedRaw.has(raw))) excluded++;
    }
    // Test-only: inert unless the fault-injection opt-in is set and this point
    // is armed (flair#2508). It holds this scan after its read, so a scan that
    // started later can read and publish before this one resumes.
    const paused = txnPausePoint("scan-verdict");
    if (paused) await paused;
    // A changed epoch discards this scan's verdict and makes the next consult rescan.
    if (_writeEpoch !== startEpoch) {
      _lastScanAt = 0;
      return;
    }
    // flair#2508 — a scan that started later already published its verdict; this
    // stale one must not overwrite it. Refused by name; nothing is written.
    if (scanSeq < _publishedScanSeq) {
      console.warn(
        `embedding-space-guard: stale scan verdict refused (scan ${scanSeq} superseded by scan ${_publishedScanSeq}); nothing written`,
      );
      return;
    }
    _activeStamps = [...seen];
    _uniform = uniform;
    _excluded = excluded;
    _excludedStale = false;
    _publishedScanSeq = scanSeq;
    _lastScanAt = Date.now();
    // A published verdict clears any earlier failed-scan state.
    _lastScanError = null;
  } catch {
    // The same two checks as the verdict publish above, in the same order. A
    // changed epoch discards this scan (flair#2481) — the foreign write already
    // closed the gate.
    if (_writeEpoch !== startEpoch) {
      _lastScanAt = 0;
      return;
    }
    // flair#2508 — a scan that started later already published its outcome; this
    // stale failure must not turn that verdict back to unknown. Refused by name.
    if (scanSeq < _publishedScanSeq) {
      console.warn(
        `embedding-space-guard: stale scan failure refused (scan ${scanSeq} superseded by scan ${_publishedScanSeq}); nothing written`,
      );
      return;
    }
    // Record a bounded reason (never row content) and log each reason once; the
    // prior verdict is left untouched and the consult schedule retries. The
    // state now reads `scan-failed`, or stays `mixed` when a foreign stamp is
    // known; either way consumers fail closed (flair#2530). The failure is this
    // scan's published outcome, so an earlier-started scan that finishes later
    // cannot clear it.
    noteScanFailure(phase === "table" ? SCAN_ERROR_TABLE_UNAVAILABLE : SCAN_ERROR_SCAN_FAILED);
    _publishedScanSeq = scanSeq;
  }
}

function runScan(): Promise<void> {
  if (!_scanning) _scanning = scan().finally(() => { _scanning = undefined; });
  return _scanning;
}

// ─── Verdict state (flair#2530, flair#2573) ──────────────────────────────────
// The latch's verdict has FIVE operator-visible states. Only `uniform` — a scan
// that found every row storing a vector stamped with the current space — opens
// the gate. The other four are NOT "known
// uniform" and fail closed: `unverified` (no scan has reached a verdict yet, or
// a write may since have changed the count), `scan-failed` (the last scan to
// publish an outcome threw, and no foreign
// stamp is known), `mixed` (a scan or a foreign write observed a
// non-current stamp), and `excluded` (every stamp a scan saw is current, but the
// scan also found a stored vector with no trusted current-space stamp). `mixed`
// outranks `scan-failed`: a known foreign stamp
// decides the state whether a failed scan came before or after it.
export type EmbeddingSpaceGuardState = "uniform" | "mixed" | "unverified" | "scan-failed" | "excluded";

export interface EmbeddingSpaceVerdict {
  /** true ONLY when a scan verified the stamps uniform. False ⇒ take the mixed path. */
  uniform: boolean;
  state: EmbeddingSpaceGuardState;
  /** The last failed scan's bounded reason, cleared when a later scan
   *  publishes a verdict; null otherwise. Present with `scan-failed`, and with
   *  `mixed` when a scan failed before or after the foreign stamp became known.
   *  Never row content. */
  reason: string | null;
  /** The current engine-qualified space id (a metadata string, never a vector). */
  current: string;
  /** The (capped) distinct stamps observed by the last published scan and by
   *  later foreign writes, for the diagnostic. An observation can be stale (a
   *  foreign row since deleted) until a successful rescan. */
  found: string[];
  /** Rows the last published scan found that store a vector but carry no trusted
   *  current-space stamp (absent, `hash-512d`, or a non-current model). A count
   *  above zero makes the verdict non-uniform; the row still matches on a lexical
   *  leg. `null` when no scan has published a count — never reported as zero. */
  excluded: number | null;
}

/** The state-named warning a guard-degraded consumer surfaces when it refuses
 *  its embedding leg (flair#2530, flair#2559). The verdict is never `uniform`
 *  here (that state is never degraded), so the four cases are exactly the
 *  non-uniform states. Each names itself; the non-current-stamp wording is used
 *  ONLY for the `mixed` state. `response` says what the caller gets back:
 *  keyword-only results (the request has query text), no results (it has none),
 *  or an `explain` plan with no embedding leg. Shared by the recall leg
 *  (resources/SemanticSearch.ts) and MemoryBootstrap's task-relevant selection
 *  (resources/MemoryBootstrap.ts) so both name the state with ONE wording. */
export function spaceGuardWarning(v: EmbeddingSpaceVerdict, response: "keyword" | "none" | "plan"): string {
  const outcome =
    response === "keyword" ? "results are keyword-only"
    : response === "none" ? "no results (the request has no query text to fall back on)"
    : "the plan has no embedding leg";
  if (v.state === "scan-failed") {
    return `semantic search unavailable — embedding space unverified: last scan failed (${v.reason}); ${outcome}.`;
  }
  if (v.state === "unverified") {
    return `semantic search unavailable — embedding space not yet verified; ${outcome}.`;
  }
  if (v.state === "excluded") {
    return (
      `semantic search unavailable — the store holds a stored vector with no trusted current-space stamp ` +
      `(${v.excluded ?? "unknown"} row(s)); ${outcome}. Re-embed or remove the row`
    );
  }
  return (
    `semantic search unavailable — a non-current embedding model stamp was observed ` +
    `(current: ${v.current}; found: ${v.found.join(", ")}); ${outcome}. ` +
    `Reconcile to one space with: flair reembed --stale-only`
  );
}

/** Bounded, row-content-free reasons a scan can fail with. An error from the
 *  scan's table lookup or corpus read is classified into one of these; the raw
 *  message is never surfaced or logged. */
export const SCAN_ERROR_TABLE_UNAVAILABLE = "the Memory table was not available";
export const SCAN_ERROR_SCAN_FAILED = "the Memory corpus scan failed";

/** Record a scan failure: remember the bounded reason and log each reason ONCE.
 *  The consult schedule retries unchanged; this only names the state. Never
 *  logs the raw error (which could carry row content). */
function noteScanFailure(reason: string): void {
  _lastScanError = reason;
  if (_loggedScanErrorReasons.has(reason)) return;
  _loggedScanErrorReasons.add(reason);
  console.warn(
    `embedding-space-guard: corpus scan failed (${reason}); ` +
      `the store is not known to be uniform until a scan succeeds`,
  );
}

/** Read the verdict + its state together, without scanning. Callers must not
 *  use this to decide AND expect it to reflect a scan they just started. */
function guardSnapshot(): EmbeddingSpaceVerdict {
  const current = normalizeStamp(_modelIdGetter()) ?? _modelIdGetter();
  const found = [..._activeStamps];
  const excluded = _excluded;
  // A known foreign stamp comes first, so no failed scan, earlier or later,
  // turns the `mixed` state into an advisory `scan-failed`; the error rides in `reason`.
  if (_uniform === false) return { uniform: false, state: "mixed", reason: _lastScanError, current, found, excluded };
  if (_lastScanError !== null) {
    return { uniform: false, state: "scan-failed", reason: _lastScanError, current, found, excluded };
  }
  // flair#2573 — a write may have stored a vector without a trusted stamp since
  // the published count. An unknown count fails closed until a scan republishes.
  if (_excludedStale) return { uniform: false, state: "unverified", reason: null, current, found, excluded };
  if (_uniform === true) {
    // A count above zero means a stored vector the runtime cosine legs must not
    // touch, so the verdict is non-uniform even though every stamp a scan saw is
    // in the current space.
    if (excluded !== null && excluded > 0) {
      return { uniform: false, state: "excluded", reason: null, current, found, excluded };
    }
    return { uniform: true, state: "uniform", reason: null, current, found, excluded };
  }
  return { uniform: false, state: "unverified", reason: null, current, found, excluded };
}

/** The consult decision. Fails closed and never awaits an in-flight scan: an
 *  unknown verdict must be reported NOW (the caller takes its mixed-space path)
 *  rather than block until a scan finishes. A pending or stale verdict kicks off
 *  a (re)scan; if it succeeds and finds the stamps uniform, later consults pass.
 *  The snapshot is taken synchronously, so the state cannot drift from the
 *  decision. */
function consultGuard(): EmbeddingSpaceVerdict {
  if (_uniform === true && _lastScanError === null && !_excludedStale) return guardSnapshot();
  if (_uniform === undefined || _excludedStale || Date.now() - _lastScanAt >= RECHECK_MS) {
    void runScan();
  }
  return guardSnapshot();
}

/** THE single chokepoint. Returns true when a scan found every row that stores
 *  a vector to carry a trusted current-space `embeddingModel` stamp (stamp
 *  metadata only; a stored vector with no such stamp makes the verdict
 *  non-uniform, flair#2573), false
 *  otherwise — including the UNKNOWN verdict (pending first scan, or a failed
 *  scan), which fails closed (the caller must take its mixed-space path). O(1)
 *  on the happy path: once verified-uniform, no scan; a pending or tripped
 *  verdict kicks off a (re)scan the caller does NOT wait for, so the unknown
 *  verdict is reported now, not after the scan. */
export function isEmbeddingSpaceUniform(): Promise<boolean> {
  return Promise.resolve(consultGuard().uniform);
}

/**
 * flair#2573 slice 1 — is `stamp` a trusted current-space model stamp for the
 * configured model? True only for a space-bearing stamp that denotes the current
 * space (the engine-qualified id or its bare-name equivalent), compared exactly
 * as the vector query's stamp condition compares it. An absent stamp, the
 * `hash-512d` marker and a foreign model are all untrusted: a row carrying one
 * is a stored vector whose space the runtime cosine legs must not touch, and the
 * guard's verdict is non-uniform while one is stored. Reads the injectable
 * model-id getter so tests can pin the space. Metadata compare only (never a
 * vector-byte comparison).
 */
export function isTrustedVectorStamp(stamp: string | null | undefined): boolean {
  return isTrustedRawStamp(stamp, _modelIdGetter());
}

/**
 * flair#2573 slice 1 — the Harper condition matching rows whose `embeddingModel`
 * is one of the current space's raw forms. This is DEFENCE IN DEPTH: the guard's
 * verdict is the load-bearing exclusion (a non-uniform verdict makes every
 * consumer refuse the embedding leg), and a query `conditions` entry cannot keep
 * a vector out of Harper's HNSW traversal — its distance is computed before an
 * admission condition is applied. Used as an ADDITIONAL condition on a vector
 * (HNSW) query ONLY — never folded into the caller's `conditions`, which also
 * drive the lexical leg (a row with an untrusted stamp must still match
 * lexically).
 */
export function trustedVectorCondition(): {
  operator: "or";
  conditions: { attribute: string; comparator: "equals"; value: string }[];
} {
  return {
    operator: "or",
    conditions: currentSpaceRawForms(_modelIdGetter()).map((value) => ({
      attribute: "embeddingModel",
      comparator: "equals" as const,
      value,
    })),
  };
}

/** The full verdict for a consumer that must NAME the state it degraded on
 *  (the recall leg's `_warning`). Decision and state are captured together, so
 *  the state cannot drift from the decision under a concurrent scan. Fails
 *  closed exactly as `isEmbeddingSpaceUniform()` does. */
export function embeddingSpaceVerdict(): Promise<EmbeddingSpaceVerdict> {
  return Promise.resolve(consultGuard());
}

/** The guard state for an operator surface (`flair doctor` via /Health), without
 *  running a scan. Never blocks, never reads a vector. */
export function spaceGuardState(): { state: EmbeddingSpaceGuardState; reason: string | null; excluded: number | null } {
  const v = guardSnapshot();
  return { state: v.state, reason: v.reason, excluded: v.excluded };
}

/**
 * Write-maintained trip: a persisted FOREIGN-space stamp closes the gate
 * immediately, no rescan.
 */
export function noteWriteStamp(stamp: string | null | undefined): void {
  let n: string | null;
  let current: string | null;
  try {
    const currentStamp = _modelIdGetter();
    if (isTrustedRawStamp(stamp, currentStamp)) return; // a trusted current-space stamp
    n = normalizeStamp(stamp);
    current = normalizeStamp(currentStamp);
  } catch (err) {
    // The stamp could not be read against the current space: fail closed, as
    // for any other unreadable state, and invalidate an in-flight scan.
    _uniform = false;
    _excludedStale = true;
    _writeEpoch++;
    throw err;
  }
  // The write stored a vector without a trusted stamp — an absent/empty stamp,
  // the `hash-512d` marker, or a foreign space. The published count no longer
  // covers it. Advance the epoch so an in-flight scan cannot publish the older
  // count or clear the stale flag; the next scan republishes.
  _excludedStale = true;
  _writeEpoch++;
  // A space-bearing, non-current stamp additionally trips the uniformity latch
  // now, with no rescan, and is named in the diagnostic.
  if (n !== null && n !== current) {
    if (!_activeStamps.includes(n) && _activeStamps.length < MAX_DIAG_STAMPS) _activeStamps.push(n);
    _uniform = false;
  }
}

/**
 * Force a fresh corpus scan, then return the current published latch
 * decision: true only when the latch reads verified uniform with no scan error.
 * The explicit "re-embed completion clears it" primitive — used by the boot
 * pre-warm, and callable after a bulk re-embed to reopen the gate promptly
 * rather than waiting out RECHECK_MS. A later-started scan may have published
 * that decision, so it does not say whether THIS scan succeeded.
 */
export async function recomputeLatch(): Promise<boolean> {
  _lastScanAt = 0; // bypass the throttle
  await scan();
  // A count above zero is also not "verified uniform": a stored vector of
  // unknown space is one the runtime cosine legs must not touch (flair#2573).
  return _uniform === true && _lastScanError === null && !_excludedStale && (_excluded === null || _excluded === 0);
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
// before the Memory table is live, the scan fails (`scan-failed`) and a later
// consult rescans — correctness never depends on this pre-warm (fail-closed
// either way); it only decides whether the first queries serve embeddings or
// take the mixed-space path until a scan completes.
let _prewarmScheduled = false;
// Settles when the most recently scheduled pre-warm's scan has finished,
// whatever its outcome. Read only through `_prewarmSettledForTests()`.
let _prewarmSettled: Promise<void> | undefined;
export function scheduleSpaceGuardPrewarm(): void {
  if (_prewarmScheduled) return;
  _prewarmScheduled = true;
  _prewarmSettled = new Promise<void>((resolve) => {
    setImmediate(() => { void recomputeLatch().catch(() => {}).then(() => resolve()); });
  });
}

/**
 * Test-only barrier (flair#2508): resolves once the most recently scheduled
 * pre-warm's scan has finished, so a test can wait for it before it injects a
 * table getter or arms a pause point. Gated like the pause points: returns
 * `undefined` unless the fault-injection opt-in
 * (`FLAIR_ENABLE_TEST_FAULT_INJECTION=1`) is set, and also when no pre-warm
 * was ever scheduled.
 */
export function _prewarmSettledForTests(env: NodeJS.ProcessEnv = process.env): Promise<void> | undefined {
  if (env[TEST_FAULT_INJECTION_ENV] !== "1") return undefined;
  return _prewarmSettled;
}

// Test-only seams — mirror embeddings-boot.ts's `_resetEmbeddingsBackendRegistrationForTests`.
export function _setGuardTableGetterForTests(fn: () => Promise<MemoryTableLike>): void { _tableGetter = fn; }
export function _setGuardModelIdForTests(fn: () => string): void { _modelIdGetter = fn; }
export function _resetGuardForTests(): void {
  _tableGetter = defaultTableGetter;
  _modelIdGetter = getModelId;
  _uniform = undefined;
  _activeStamps = [];
  _excluded = null;
  _excludedStale = false;
  _lastScanAt = 0;
  _scanning = undefined;
  _writeEpoch = 0;
  _lastScanError = null;
  _loggedScanErrorReasons.clear();
  _scanSeq = 0;
  _publishedScanSeq = 0;
  // `_prewarmSettled` is kept: a reset cannot cancel a pre-warm that is already
  // scheduled, so its barrier must stay awaitable.
  _prewarmScheduled = false;
}

scheduleSpaceGuardPrewarm();
