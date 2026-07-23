/**
 * types.ts — shared shapes for the zero-touch migration runner (flair#695).
 *
 * Governed by flair#695 (the four invariants) and
 * flair#695 (the runner design + K&S verdict
 * refinements). Every migration registered in resources/migrations/registry.ts
 * implements the `Migration` interface below.
 */

/**
 * Risk class governs the WHOLE safety posture (Kern verdict, not just
 * snapshot scope): batch size, snapshot scope, and completion-gate
 * strictness all key off this one classification. See
 * resources/migrations/risk-policy.ts for the concrete posture per class.
 *
 *   - derived-only:      embeddings/indexes/stamps — recomputable, source
 *                         untouched. Safe to lose entirely; cheapest posture.
 *   - schema-additive:   new nullable field(s), old fields keep functioning.
 *                         No row rewrites of source fields.
 *   - content-transform: rewrites memory content/structure via supersession
 *                         (write-new, keep-old-with-lineage). Strictest
 *                         posture — old rows retained in-store, never
 *                         mutated in place (invariant I).
 */
export type RiskClass = "derived-only" | "schema-additive" | "content-transform";

export type MigrationState =
  | "idle"
  | "checking"
  | "preflight"
  | "snapshotting"
  | "running"
  | "completing"
  | "halted"
  | "completed"
  | "failed";

export interface MigrationProgress {
  id: string;
  rowsDone: number;
  rowsRemaining: number;
  state: MigrationState;
  /** Present when state is "halted" or "failed" — the exact, actionable reason. */
  reason?: string;
}

/** Table(s) a migration's source-field envelope hash is computed over. */
export type SourceTable = "Memory" | "Relationship";

export interface RunBatchResult {
  /** Rows actually touched (written) in this batch call. 0 means no more pending work. */
  processed: number;
  /** IDs touched this batch — used by the content-transform gate (old-row envelope + new-row presence). */
  touchedIds: string[];
  /**
   * content-transform ONLY: `${table}:${id}` -> hash of that row's
   * SOURCE_FIELDS as they were immediately before this batch superseded it.
   * The migration computes this itself (it already reads the row before
   * writing) since the runner has no way to know which rows a batch will
   * touch before run() executes. The runner accumulates these across all
   * batches and re-verifies each one against the CURRENT stored row at
   * completion — proving the old row's source fields never changed
   * (invariant I), the strictest gate per the risk-class policy.
   */
  oldRowSourceHashes?: Record<string, string>;
  /**
   * content-transform ONLY: the NEW record id superseding each touched old
   * id (used by the completion gate's new-row-presence check — every
   * touched old row must have a successor). Empty/omitted for
   * derived-only/schema-additive migrations, which never create a new row.
   */
  newRowIds?: string[];
}

export interface Migration {
  /** Stable, unique identifier — used as the state-file key, lock scope note, and ledger refId. */
  id: string;
  riskClass: RiskClass;
  /** Table(s) this migration's source fields live on (drives envelope hashing scope). */
  affectsTables: SourceTable[];
  /**
   * Cheap, read-only, bounded (limit=1-style) — answers "is there pending
   * work," never O(corpus). Never called at all once the on-disk state
   * marker says this migration already completed at the current running
   * version (Kern's short-circuit).
   */
  detect(): Promise<boolean>;
  /**
   * Exact count of rows still pending. May be O(corpus) — only called
   * around the completion gate and for progress display, never on the
   * boot-readiness path.
   */
  countPending(): Promise<number>;
  /**
   * Process up to `batchSize` pending rows. MUST be idempotent — safe to
   * call again on rows already processed (re-running finds zero drift).
   * Progress lives IN THE DATA (the field this migration stamps IS the
   * marker) — no separate journal/checkpoint file.
   */
  run(batchSize: number): Promise<RunBatchResult>;
  /**
   * OPTIONAL completion-gate safety net (flair#807). If countPending()
   * reports a nonzero, would-otherwise-halt count, the runner calls this
   * (bounded by GATE_SAFETY_NET_MAX_RECHECK — see runner.ts) to re-verify up
   * to `limit` of those "pending" rows by a DIRECT per-row read, bypassing
   * whatever query mechanism countPending() itself used. Root cause this
   * exists for: countPending()'s search-based query can be misled by a
   * stale/desynced secondary index on a migrated store (see
   * resources/migrations/embedding-stamp.ts's flair#807 doc for the
   * concrete mechanism); a `.get()`-by-id primary-key lookup is immune to
   * that class of bug. Returns COUNTS ONLY — never row ids — so the runner
   * can log a loud, actionable WARN without exposing which records.
   *
   * A migration that omits this gets exactly the prior behavior: a nonzero
   * countPending() at the gate always halts. Implementing it is a purely
   * additive opt-in, never required for correctness of the base gate.
   */
  recheckPending?(limit: number): Promise<{ sampled: number; falsePositives: number }>;
}
