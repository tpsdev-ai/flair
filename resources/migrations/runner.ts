/**
 * runner.ts — the migration cycle orchestrator. One call to
 * `runMigrationCycle()` = one full pass: detect pending migrations → (if
 * any) one shared async pre-hash → per-migration pre-flight ladder →
 * risk-scoped snapshot → throttled batches with per-row markers →
 * risk-scoped completion gate → post-hash comparison → ledger OrgEvent →
 * state-file update → snapshot prune.
 *
 * Halt-don't-brick everywhere (~/ops/FLAIR-MIGRATION-SAFETY.md invariant
 * II): this function NEVER throws — every failure mode (space-blocked,
 * snapshot-failed, pre-hash-failed, gate-failed, an unexpected exception)
 * resolves to a halted/failed progress entry + (where applicable) a ledger
 * event, and the loop moves on to the next migration rather than
 * propagating. The caller (resources/MigrationBoot.ts) is the boot path —
 * an exception escaping this function would risk destabilizing an
 * already-serving process, which is exactly what invariant II forbids.
 */
import { acquireMigrationLock, type AcquireResult } from "./lock.js";
import { checkSpace, defaultSpaceProbe, type SpaceProbe } from "./space.js";
import { createMigrationSnapshot, pruneMigrationSnapshots } from "./snapshot.js";
import { createContentOnlyExport } from "./export.js";
import { computeCorpusEnvelope, type CorpusEnvelope, type TableAccessor } from "./envelope.js";
import { hashSourceFields, sourceFieldsFor } from "./source-fields.js";
import { postureFor, type SnapshotScope } from "./risk-policy.js";
import { readMigrationState, writeMigrationStateEntry, isShortCircuited, defaultStatePath } from "./state.js";
import { writeLedgerEvent, type LedgerDeps, type LedgerEvent } from "./ledger.js";
import { setCyclePhase, setMigrationProgress, seedIdleProgress } from "./progress.js";
import type { MigrationRegistry } from "./registry.js";
import type { Migration, RiskClass, SourceTable } from "./types.js";
import { join } from "node:path";

export interface RunnerDeps {
  registry: MigrationRegistry;
  /** Table accessor for the migration's own table AND for full-corpus envelope hashing. */
  getTable: (table: SourceTable) => TableAccessor;
  dataDir: string;
  runningVersion: string;
  statePath?: string;
  lockPath?: string;
  snapshotRoot?: string;
  exportRoot?: string;
  spaceProbe?: SpaceProbe;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  ledgerDeps?: LedgerDeps;
  batchDelayMs?: number;
  initiator?: "auto" | "operator";
  headroomFloor?: number;
}

interface ResolvedDeps extends Required<Omit<RunnerDeps, "spaceProbe" | "ledgerDeps" | "headroomFloor">> {
  spaceProbe: SpaceProbe;
  ledgerDeps: LedgerDeps;
  headroomFloor: number | undefined;
}

function resolveDeps(deps: RunnerDeps): ResolvedDeps {
  const dataDir = deps.dataDir;
  return {
    registry: deps.registry,
    getTable: deps.getTable,
    dataDir,
    runningVersion: deps.runningVersion,
    statePath: deps.statePath ?? defaultStatePath(dataDir),
    lockPath: deps.lockPath ?? join(dataDir, ".migrations", "lock"),
    snapshotRoot: deps.snapshotRoot ?? join(dataDir, ".migrations", "snapshots"),
    exportRoot: deps.exportRoot ?? join(dataDir, ".migrations", "exports"),
    spaceProbe: deps.spaceProbe ?? defaultSpaceProbe,
    now: deps.now ?? (() => new Date()),
    sleep: deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))),
    ledgerDeps: deps.ledgerDeps ?? {},
    batchDelayMs: deps.batchDelayMs ?? 100,
    initiator: deps.initiator ?? "auto",
    headroomFloor: deps.headroomFloor,
  };
}

// ─── space/snapshot sizing heuristics (overridable via RunnerDeps in future if ever needed) ──

function estimateSnapshotBytes(scope: SnapshotScope, pendingCount: number): number {
  switch (scope) {
    case "metadata-only":
      return 4096;
    case "schema+metadata":
      return 8192;
    case "pointers+metadata":
      return 256 * Math.max(pendingCount, 1);
  }
}

/**
 * Kern verdict: "Space estimate includes HNSW rebuild overhead (re-embed
 * rewrites every vector → index rebuild can be 2–3× raw vector size)." Uses
 * a fixed per-row estimate (~6KB raw nomic-embed-text vector * 3) — a real
 * per-corpus vector-size probe would be more precise but isn't needed for a
 * conservative pre-flight gate; overestimating just makes the halt fire
 * slightly earlier, which is the safe direction.
 */
function estimateWorkingSetBytes(riskClass: RiskClass, pendingCount: number): number {
  switch (riskClass) {
    case "derived-only":
      return 18 * 1024 * pendingCount; // ~3x a 768-dim float32 vector (~6KB) per touched row
    case "schema-additive":
      return 0; // additive-only — no row rewrites of source fields
    case "content-transform":
      return 4 * 1024 * pendingCount; // old+new temporarily coexist for touched rows
  }
}

export interface CycleResult {
  ran: boolean;
  reason?: string;
}

/**
 * Runs one full migration cycle. Safe to call repeatedly (e.g. once per
 * boot) — a cycle with nothing pending returns immediately without taking
 * the lock's file-write cost or computing the envelope.
 */
export async function runMigrationCycle(rawDeps: RunnerDeps): Promise<CycleResult> {
  const deps = resolveDeps(rawDeps);
  const allIds = deps.registry.list().map((m) => m.id);
  seedIdleProgress(allIds);

  let lock: AcquireResult;
  try {
    lock = acquireMigrationLock({ lockPath: deps.lockPath });
  } catch (err) {
    // Even the lock's own filesystem calls must never crash the boot path.
    return { ran: false, reason: `lock error: ${(err as Error)?.message ?? String(err)}` };
  }
  if (!lock.acquired) {
    return { ran: false, reason: `single-flight: ${lock.reason}` };
  }

  try {
    return await runCycleLocked(deps, lock);
  } catch (err) {
    // Belt-and-suspenders: runCycleLocked already halts individual
    // migrations internally, but an error escaping it entirely (e.g. a bug)
    // must still never propagate out of the boot path.
    setCyclePhase("done", `unexpected cycle error: ${(err as Error)?.message ?? String(err)}`);
    return { ran: false, reason: `unexpected error: ${(err as Error)?.message ?? String(err)}` };
  } finally {
    lock.release();
  }
}

async function runCycleLocked(deps: ResolvedDeps, lock: Extract<AcquireResult, { acquired: true }>): Promise<CycleResult> {
  const state = readMigrationState(deps.statePath);
  const candidates: Migration[] = [];

  for (const migration of deps.registry.list()) {
    if (isShortCircuited(state, migration.id, deps.runningVersion)) {
      setMigrationProgress({ id: migration.id, rowsDone: 0, rowsRemaining: 0, state: "completed" });
      continue;
    }
    setMigrationProgress({ id: migration.id, rowsDone: 0, rowsRemaining: 0, state: "checking" });
    let pending: boolean;
    try {
      pending = await migration.detect();
    } catch (err) {
      setMigrationProgress({
        id: migration.id,
        rowsDone: 0,
        rowsRemaining: 0,
        state: "failed",
        reason: `detect() threw: ${(err as Error)?.message ?? String(err)}`,
      });
      continue;
    }
    if (!pending) {
      setMigrationProgress({ id: migration.id, rowsDone: 0, rowsRemaining: 0, state: "completed" });
      continue;
    }
    candidates.push(migration);
  }

  if (candidates.length === 0) {
    return { ran: false, reason: "nothing pending" };
  }

  // ── ONE shared async pre-hash for the whole cycle (K&S: computed once,
  // after ready, before any migration's first write; failure → halt all
  // pending candidates rather than guessing which ones are safe). ──
  setCyclePhase("pre-hash");
  let envelope: CorpusEnvelope;
  try {
    envelope = await computeCorpusEnvelope(deps.getTable, deps.now);
  } catch (err) {
    const reason = `pre-flight integrity check failed: ${(err as Error)?.message ?? String(err)}`;
    for (const migration of candidates) {
      setMigrationProgress({ id: migration.id, rowsDone: 0, rowsRemaining: 0, state: "halted", reason });
    }
    setCyclePhase("done", reason);
    return { ran: false, reason };
  }
  setCyclePhase("running");

  for (const migration of candidates) {
    await runOneMigration(migration, envelope, deps, lock);
  }

  setCyclePhase("done");
  return { ran: true };
}

async function haltMigration(
  migration: Migration,
  reason: string,
  ctx: { deps: ResolvedDeps; startedAt: string; rowsDone: number; rowsRemaining: number; hashEnvelopeMatch: boolean | null; state: ReturnType<typeof readMigrationState> },
): Promise<void> {
  const { deps, startedAt, rowsDone, rowsRemaining, hashEnvelopeMatch, state } = ctx;
  const endedAt = deps.now().toISOString();
  setMigrationProgress({ id: migration.id, rowsDone, rowsRemaining, state: "halted", reason });

  const fromVersion = state[migration.id]?.completedAtVersion ?? "unknown";
  const evt: LedgerEvent = {
    migrationId: migration.id,
    initiator: deps.initiator,
    fromVersion,
    toVersion: deps.runningVersion,
    scope: "full",
    startedAt,
    endedAt,
    outcome: "halted",
    rowsProcessed: rowsDone,
    rowsRemaining,
    hashEnvelopeMatch,
    error: reason,
  };
  try {
    await writeLedgerEvent(evt, deps.ledgerDeps);
  } catch {
    // A ledger-write failure must not compound the halt — the migration is
    // already safely stopped on the pre-migration shape either way.
  }

  // Deliberately NOT calling writeMigrationStateEntry with lastOutcome
  // "halted" as completedAtVersion-bearing — isShortCircuited() only fires
  // on lastOutcome === "success", so a halted migration is retried on every
  // subsequent boot until it clears, never permanently stuck.
  try {
    writeMigrationStateEntry(deps.statePath, migration.id, {
      lastOutcome: "halted",
      reason,
      rowsProcessed: rowsDone,
      rowsRemaining,
    });
  } catch {
    /* best-effort — the in-memory progress + ledger event already recorded the halt */
  }
}

async function runOneMigration(
  migration: Migration,
  envelope: CorpusEnvelope,
  deps: ResolvedDeps,
  lock: Extract<AcquireResult, { acquired: true }>,
): Promise<void> {
  const startedAt = deps.now().toISOString();
  const state = readMigrationState(deps.statePath);
  const posture = postureFor(migration.riskClass);

  setMigrationProgress({ id: migration.id, rowsDone: 0, rowsRemaining: 0, state: "preflight" });

  // ── Ladder step 1: space check (with HNSW/working-set overhead) ──
  let initialRemaining: number;
  try {
    initialRemaining = await migration.countPending();
  } catch (err) {
    await haltMigration(migration, `countPending() threw: ${(err as Error)?.message ?? String(err)}`, {
      deps,
      startedAt,
      rowsDone: 0,
      rowsRemaining: 0,
      hashEnvelopeMatch: null,
      state,
    });
    return;
  }

  const estSnapshot = estimateSnapshotBytes(posture.snapshotScope, initialRemaining);
  const estWorkingSet = estimateWorkingSetBytes(migration.riskClass, initialRemaining);
  let space = checkSpace(
    { dataDir: deps.dataDir, estimatedSnapshotBytes: estSnapshot, estimatedWorkingSetBytes: estWorkingSet, headroomFloor: deps.headroomFloor },
    deps.spaceProbe,
  );

  if (!space.ok) {
    // ── Ladder step 2: prune snapshots, then retry ──
    pruneMigrationSnapshots(deps.snapshotRoot);
    space = checkSpace(
      { dataDir: deps.dataDir, estimatedSnapshotBytes: estSnapshot, estimatedWorkingSetBytes: estWorkingSet, headroomFloor: deps.headroomFloor },
      deps.spaceProbe,
    );
  }

  if (!space.ok) {
    // ── Ladder step 5: no safe path → halt-don't-brick ──
    await haltMigration(migration, `blocked on disk: ${space.reason}`, {
      deps,
      startedAt,
      rowsDone: 0,
      rowsRemaining: initialRemaining,
      hashEnvelopeMatch: null,
      state,
    });
    return;
  }

  // ── Ladder step 3 (+ step 4 fallback): risk-scoped snapshot, or a
  // content-only export if the snapshot mechanism itself fails. ──
  setMigrationProgress({ id: migration.id, rowsDone: 0, rowsRemaining: initialRemaining, state: "snapshotting" });
  try {
    createMigrationSnapshot(
      {
        migrationId: migration.id,
        scope: posture.snapshotScope,
        rowCounts: { [migration.affectsTables[0] ?? "Memory"]: initialRemaining },
        fromVersion: state[migration.id]?.completedAtVersion ?? "unknown",
        toVersion: deps.runningVersion,
      },
      { snapshotRoot: deps.snapshotRoot, now: deps.now },
    );
  } catch (snapErr) {
    try {
      const table = migration.affectsTables[0] ?? "Memory";
      const accessor = deps.getTable(table);
      const rows: Record<string, unknown>[] = [];
      for await (const row of accessor.search({})) rows.push(row);
      createContentOnlyExport(
        { migrationId: migration.id, table, rows, fromVersion: state[migration.id]?.completedAtVersion ?? "unknown" },
        { exportRoot: deps.exportRoot, now: deps.now },
      );
    } catch (expErr) {
      await haltMigration(
        migration,
        `snapshot failed (${(snapErr as Error)?.message ?? String(snapErr)}) and the content-only export fallback also failed (${(expErr as Error)?.message ?? String(expErr)})`,
        { deps, startedAt, rowsDone: 0, rowsRemaining: initialRemaining, hashEnvelopeMatch: null, state },
      );
      return;
    }
  }

  // ── Execution: throttled batches, resumable via per-row markers ──
  setMigrationProgress({ id: migration.id, rowsDone: 0, rowsRemaining: initialRemaining, state: "running" });
  let rowsDone = 0;
  const oldRowHashes = new Map<string, string>();
  const newRowIds: string[] = [];
  try {
    for (;;) {
      const result = await migration.run(posture.batchSize);
      rowsDone += result.processed;
      if (result.oldRowSourceHashes) {
        for (const [k, v] of Object.entries(result.oldRowSourceHashes)) oldRowHashes.set(k, v);
      }
      if (result.newRowIds) newRowIds.push(...result.newRowIds);

      setMigrationProgress({
        id: migration.id,
        rowsDone,
        rowsRemaining: Math.max(0, initialRemaining - rowsDone),
        state: "running",
      });
      lock.touch();

      if (result.processed === 0) break;
      await deps.sleep(deps.batchDelayMs);
    }
  } catch (err) {
    await haltMigration(migration, `run() threw mid-batch: ${(err as Error)?.message ?? String(err)}`, {
      deps,
      startedAt,
      rowsDone,
      rowsRemaining: Math.max(0, initialRemaining - rowsDone),
      hashEnvelopeMatch: null,
      state,
    });
    return;
  }

  // ── Completion gate — strictness per risk class ──
  setMigrationProgress({ id: migration.id, rowsDone, rowsRemaining: 0, state: "completing" });
  let finalRemaining: number;
  try {
    finalRemaining = await migration.countPending();
  } catch (err) {
    await haltMigration(migration, `post-batch countPending() threw: ${(err as Error)?.message ?? String(err)}`, {
      deps,
      startedAt,
      rowsDone,
      rowsRemaining: 0,
      hashEnvelopeMatch: null,
      state,
    });
    return;
  }

  let hashEnvelopeMatch: boolean | null = null;
  let gateOk = finalRemaining === 0;

  if (gateOk && posture.gate === "count+full-envelope") {
    try {
      const postEnvelope = await computeCorpusEnvelope(deps.getTable, deps.now);
      hashEnvelopeMatch = postEnvelope.corpusHash === envelope.corpusHash;
      gateOk = gateOk && hashEnvelopeMatch;
    } catch (err) {
      hashEnvelopeMatch = false;
      gateOk = false;
      await haltMigration(migration, `post-hash computation failed: ${(err as Error)?.message ?? String(err)}`, {
        deps,
        startedAt,
        rowsDone,
        rowsRemaining: finalRemaining,
        hashEnvelopeMatch,
        state,
      });
      return;
    }
  } else if (gateOk && posture.gate === "count+old-row-envelope+new-row-presence") {
    let allMatch = true;
    for (const [key, preHash] of oldRowHashes) {
      const sepIdx = key.indexOf(":");
      const table = key.slice(0, sepIdx) as SourceTable;
      const id = key.slice(sepIdx + 1);
      let current: Record<string, unknown> | null = null;
      try {
        current = await deps.getTable(table).get(id);
      } catch {
        allMatch = false;
        break;
      }
      const currentHash = current ? hashSourceFields(current, sourceFieldsFor(table)) : null;
      if (currentHash !== preHash) {
        allMatch = false;
        break;
      }
    }
    const presenceOk = newRowIds.length === oldRowHashes.size;
    hashEnvelopeMatch = allMatch && presenceOk;
    gateOk = gateOk && hashEnvelopeMatch;
  }
  // "count+marker" (derived-only): gateOk already reflects finalRemaining === 0;
  // no content-hash comparison — recomputable by definition (Kern verdict).

  const endedAt = deps.now().toISOString();

  if (!gateOk) {
    const reasonParts = [`rowsRemaining=${finalRemaining}`];
    if (hashEnvelopeMatch === false) reasonParts.push("hash envelope mismatch");
    await haltMigration(migration, `completion gate failed: ${reasonParts.join(", ")}`, {
      deps,
      startedAt,
      rowsDone,
      rowsRemaining: finalRemaining,
      hashEnvelopeMatch,
      state,
    });
    return;
  }

  // ── Success: ledger → state → prune ──
  const evt: LedgerEvent = {
    migrationId: migration.id,
    initiator: deps.initiator,
    fromVersion: state[migration.id]?.completedAtVersion ?? "unknown",
    toVersion: deps.runningVersion,
    scope: "full",
    startedAt,
    endedAt,
    outcome: "success",
    rowsProcessed: rowsDone,
    rowsRemaining: 0,
    hashEnvelopeMatch,
  };
  try {
    await writeLedgerEvent(evt, deps.ledgerDeps);
  } catch {
    // A ledger-write failure after a genuinely successful migration must not
    // flip the outcome to failed — the data-safety work already completed.
  }

  try {
    writeMigrationStateEntry(deps.statePath, migration.id, {
      completedAtVersion: deps.runningVersion,
      completedAt: endedAt,
      lastOutcome: "success",
      rowsProcessed: rowsDone,
      rowsRemaining: 0,
    });
  } catch {
    /* best-effort — worst case this migration's detect() runs (cheaply) again next boot */
  }

  pruneMigrationSnapshots(deps.snapshotRoot);
  setMigrationProgress({ id: migration.id, rowsDone, rowsRemaining: 0, state: "completed" });
}
