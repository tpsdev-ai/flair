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
  /**
   * Rows recorded as unconfirmed (flair#2840): a write this migration made but
   * could not verify, or a loopback re-embed that answered 503
   * `write_outcome_unknown`, which can reflect an earlier writer's unresolved
   * write rather than this migration's. A listed id leaves the count when a
   * later batch verifies its write, or a later read answers `at-target` (the
   * row needs no further write from this migration) or `no-row`. A later cycle
   * starts from the record it reads from the state file, whose id list is
   * capped, so ids beyond the list are carried only in its count, which no
   * later batch or read reduces. `unconfirmedIds` carries at most
   * {@link UNCONFIRMED_IDS_LIMIT} of them; this count is not capped.
   */
  rowsUnconfirmed?: number;
  /** Up to {@link UNCONFIRMED_IDS_LIMIT} unconfirmed row ids, in the order they
   *  were recorded. Absent when the record names none. */
  unconfirmedIds?: string[];
}

/**
 * How many of a run's unconfirmed row ids are reported. During a run the
 * runner holds the ids recorded in this run, and the listed ids it carried in,
 * in a Set; the list written to the progress record and the state file is
 * capped at this many. The count is not capped (flair#2840).
 */
export const UNCONFIRMED_IDS_LIMIT = 100;

/** Table(s) a migration's source-field envelope hash is computed over. */
export type SourceTable = "Memory" | "Relationship";

export interface RunBatchResult {
  /** Rows actually touched (written) in this batch call. 0 means no more pending work. */
  processed: number;
  /** IDs touched this batch — used by the content-transform gate (old-row envelope + new-row presence). */
  touchedIds: string[];
  /**
   * IDs this batch reports as unconfirmed (flair#2840): a write the batch made
   * but could not verify, or a loopback re-embed that answered 503
   * `write_outcome_unknown`, which can reflect an earlier writer's unresolved
   * write. Disjoint from `touchedIds`: a row whose write a later attempt
   * in the same batch verified belongs in `touchedIds`, not here. The runner
   * unions these across batches, removing the ids a later batch verifies, into
   * the progress record.
   */
  unconfirmedIds?: string[];
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

/**
 * Thrown by a migration's run() on the paths that wrap the failure ending a
 * batch (flair#2840): the synthetic write-back, the visibility backfill and
 * embedding-stamp's `.content`-suffix retry read. It carries that batch's
 * outcomes so far — the rows it touched and the rows it recorded as
 * unconfirmed — so the runner can merge them into the unconfirmed record even
 * though no {@link RunBatchResult} is returned. A throw from a path that does
 * not wrap its batch carries no outcomes.
 */
export class BatchOutcomeError extends Error {
  readonly touchedIds: readonly string[];
  readonly unconfirmedIds: readonly string[];

  constructor(outcome: { touchedIds: readonly string[]; unconfirmedIds: readonly string[] }, cause: unknown) {
    super((cause as Error)?.message ?? String(cause), { cause });
    this.name = "BatchOutcomeError";
    this.touchedIds = [...outcome.touchedIds];
    this.unconfirmedIds = [...outcome.unconfirmedIds];
  }
}

/** What a re-read of a recorded unconfirmed row shows (flair#2840). */
export type UnconfirmedVerdict = "at-target" | "no-row" | "pending";

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
   * version (Kern's short-circuit) — unless `alwaysDetect` is set.
   */
  detect(): Promise<boolean>;
  /**
   * When true, the runner ALWAYS calls detect() even if the on-disk marker
   * says this migration already completed at the current running version.
   * Use for migrations whose pending work is a property of the corpus (a
   * stamp, a missing field) rather than of the release — a version-keyed
   * short-circuit can mark them "done" while the rows they exist to heal
   * are still stale (flair#1073: embedding-stamp completed at 0.30.0 with
   * 554 pre-flip rows still on the bare model id).
   *
   * detect() stays cheap (limit=1); this only skips the file-derived
   * short-circuit, never a full corpus walk on the boot-readiness path.
   */
  alwaysDetect?: boolean;
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
  /**
   * OPTIONAL (flair#2840). The runner calls this for each row id a state-file
   * record lists as unconfirmed, on each cycle that acquires the migration lock
   * (including one with no pending work), to decide whether the id can be
   * cleared: `at-target` when this read found the row needs no further write
   * from this migration, `no-row` when it found no row, `pending` to keep the
   * id. For visibility backfill, `at-target` means a visibility value is
   * present, whoever wrote it; an owner's later value supersedes the
   * unconfirmed write. A read that throws is treated as unknown and also keeps
   * the id. Omitted by migrations that never report unconfirmed ids.
   */
  checkUnconfirmed?(id: string): Promise<UnconfirmedVerdict>;
}
