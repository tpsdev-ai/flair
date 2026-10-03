/**
 * memory-integrity.ts — the out-of-store integrity watcher's checkpoint and
 * comparison logic (flair#2213, slice 1 of #971; covers #1244's unnoticed-loss
 * risk).
 *
 * A checkpoint of the last SUCCESSFUL scan — per-tier counts AND the set of
 * Memory ids (id -> durability) — lives OUTSIDE the Harper database, under the
 * operator's flair config dir (`~/.flair/integrity-checkpoint.json`, mode 0600,
 * written atomically). `flair integrity check` scans the live corpus and
 * compares it to that checkpoint:
 *
 *   - a durable-tier id (permanent / persistent) that is GONE and has no
 *     new deletion record is an UNEXPLAINED LOSS → alert, naming the id. It never
 *     clears itself: only `--accept` advances the checkpoint while a loss is open.
 *   - a durable-tier id gone WITH a new deletion record is an ATTRIBUTED delete.
 *   - an id whose durability changed is an observed TIER CHANGE.
 *   - a durable-tier count decrease not explained by those is also an alert
 *     (belt-and-braces against a count/id-set drift).
 *   - a scan that cannot read the instance reports UNKNOWN, never healthy, and
 *     never overwrites the checkpoint.
 *
 * This module compares scans and reads and writes checkpoints.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export const INTEGRITY_CHECKPOINT_FILENAME = "integrity-checkpoint.json";

/** The tiers the watcher treats as durable — a loss here is the alert. */
export const DURABLE_TIERS = ["permanent", "persistent"] as const;
export const ALL_TIERS = ["permanent", "persistent", "standard", "ephemeral"] as const;
export type Tier = (typeof ALL_TIERS)[number];

export function isDurableTier(tier: string | undefined | null): boolean {
  return tier === "permanent" || tier === "persistent";
}

export interface IntegrityCheckpoint {
  version: 1;
  /** ISO timestamp of the successful scan this checkpoint records. */
  scannedAt: string;
  byDurability: Record<Tier, number>;
  /** id -> durability at the checkpoint. */
  ids: Record<string, string>;
  historyIds: string[];
}

export interface MemoryRowLite {
  id: string;
  durability: string;
}

export interface DeletionRecordLite {
  id: string;
  memoryId: string;
  durability?: string | null;
  at: string;
}

export type IntegrityStatus = "healthy" | "alert" | "unknown" | "baseline";

export interface AttributedDeletion {
  id: string;
  tier: string;
  at: string;
}

export interface TierChange {
  id: string;
  from: string;
  to: string;
}

export interface UnexplainedLoss {
  id: string;
  tier: string;
}

export interface IntegrityVerdict {
  status: IntegrityStatus;
  /** For `unknown`: why the scan failed. */
  reason?: string;
  scannedAt: string;
  total: number;
  counts: Record<Tier, number>;
  /** Durable ids gone with a deletion record (a deliberate delete). */
  attributedDeletes: AttributedDeletion[];
  /** Ids whose durability changed since the checkpoint. */
  tierChanges: TierChange[];
  /** Durable ids gone with NO deletion record — the alert. */
  losses: UnexplainedLoss[];
  /** Durable tiers whose count dropped more than those explain, tier -> delta. */
  unexplainedDecrease: Record<string, number>;
  /** True when the checkpoint was advanced to this scan's state. */
  checkpointWritten: boolean;
}

/** Coerce any stored value to a known tier; anything else buckets to `standard`. */
export function normalizeTier(durability: unknown): Tier {
  return typeof durability === "string" && (ALL_TIERS as readonly string[]).includes(durability)
    ? (durability as Tier)
    : "standard";
}

/** A fresh per-tier tally of a row set. */
export function tallyByDurability(rows: readonly MemoryRowLite[]): Record<Tier, number> {
  const counts = { permanent: 0, persistent: 0, standard: 0, ephemeral: 0 } as Record<Tier, number>;
  for (const row of rows) counts[normalizeTier(row.durability)]++;
  return counts;
}

export function emptyCheckpoint(scannedAt: string, rows: readonly MemoryRowLite[], deletions: readonly DeletionRecordLite[] = []): IntegrityCheckpoint {
  const ids: Record<string, string> = Object.create(null);
  for (const row of rows) ids[row.id] = normalizeTier(row.durability);
  return { version: 1, scannedAt, byDurability: tallyByDurability(rows), ids, historyIds: deletions.map(d => d.id) };
}

/** UNKNOWN, with no checkpoint write. */
export function unknownVerdict(reason: string, scannedAt: string): IntegrityVerdict {
  return {
    status: "unknown",
    reason,
    scannedAt,
    total: 0,
    counts: { permanent: 0, persistent: 0, standard: 0, ephemeral: 0 },
    attributedDeletes: [],
    tierChanges: [],
    losses: [],
    unexplainedDecrease: {},
    checkpointWritten: false,
  };
}

/**
 * Compare the live corpus (`rows`) with the checkpoint. `deletions` are the
 * deletion records the watcher could read, excluding records seen at the checkpoint.
 */
export function compareScan(opts: {
  checkpoint: IntegrityCheckpoint;
  rows: readonly MemoryRowLite[];
  deletions: readonly DeletionRecordLite[];
  scannedAt: string;
}): IntegrityVerdict {
  const { checkpoint, rows, deletions, scannedAt } = opts;
  const current = new Map<string, string>();
  for (const row of rows) current.set(row.id, normalizeTier(row.durability));
  const counts = tallyByDurability(rows);

  const deletedTiers = new Map<string, DeletionRecordLite>();
  const seenHistory = new Set(checkpoint.historyIds);
  for (const d of deletions) {
    if (seenHistory.has(d.id)) continue;
    // Latest record wins; a re-deleted id is still one deletion.
    const prev = deletedTiers.get(d.memoryId);
    if (!prev || d.at > prev.at) deletedTiers.set(d.memoryId, d);
  }

  const attributedDeletes: AttributedDeletion[] = [];
  const tierChanges: TierChange[] = [];
  const losses: UnexplainedLoss[] = [];

  for (const [id, cpTier] of Object.entries(checkpoint.ids)) {
    const curTier = current.get(id);
    if (curTier === undefined) {
      const record = deletedTiers.get(id);
      if (record) {
        attributedDeletes.push({ id, tier: cpTier, at: record.at });
      } else if (isDurableTier(cpTier)) {
        losses.push({ id, tier: cpTier });
      }
      // A missing non-durable id without a record is out of the monitored set.
      continue;
    }
    if (curTier !== cpTier) tierChanges.push({ id, from: cpTier, to: curTier });
  }

  // Belt-and-braces: a durable-tier count that dropped more than the id-set
  // diff explains (a count/id-set drift) is also an alert.
  const unexplainedDecrease: Record<string, number> = {};
  for (const tier of DURABLE_TIERS) {
    const attributedOut = attributedDeletes.filter((d) => d.tier === tier).length;
    const changedOut = tierChanges.filter((c) => c.from === tier && c.to !== tier).length;
    const changedIn = tierChanges.filter((c) => c.to === tier && c.from !== tier).length;
    const explainedDrop = attributedOut + changedOut - changedIn;
    const actualDrop = checkpoint.byDurability[tier] - counts[tier];
    const unexplained = actualDrop - explainedDrop;
    if (unexplained > 0) unexplainedDecrease[tier] = unexplained;
  }

  const alerting = losses.length > 0 || Object.keys(unexplainedDecrease).length > 0;
  return {
    status: alerting ? "alert" : "healthy",
    scannedAt,
    total: rows.length,
    counts,
    attributedDeletes,
    tierChanges,
    losses,
    unexplainedDecrease,
    checkpointWritten: false,
  };
}

/** The checkpoint path under the operator's flair config dir. */
export function integrityCheckpointPath(home: string): string {
  return join(home, ".flair", INTEGRITY_CHECKPOINT_FILENAME);
}

export type CheckpointRead =
  | { kind: "absent" }
  | { kind: "ok"; checkpoint: IntegrityCheckpoint }
  | { kind: "unreadable"; reason: string };

/**
 * Read the checkpoint. A missing file is `absent` (the first scan establishes
 * the baseline); a present-but-unreadable file is `unreadable` — UNKNOWN, never
 * "no checkpoint". Never a silent default.
 */
export function readCheckpoint(path: string): CheckpointRead {
  if (!existsSync(path)) return { kind: "absent" };
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    return { kind: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
  try {
    const parsed = JSON.parse(raw) as IntegrityCheckpoint;
    if (parsed?.version !== 1 || typeof parsed.scannedAt !== "string" ||
        typeof parsed.ids !== "object" || parsed.ids === null || Array.isArray(parsed.ids) ||
        !Object.entries(parsed.ids).every(([id, tier]) => id.length > 0 && (ALL_TIERS as readonly unknown[]).includes(tier)) ||
        !Array.isArray(parsed.historyIds) || !parsed.historyIds.every(id => typeof id === "string" && id.length > 0) ||
        !parsed.byDurability || !ALL_TIERS.every(tier => Number.isSafeInteger(parsed.byDurability[tier]) && parsed.byDurability[tier] >= 0)) {
      return { kind: "unreadable", reason: "checkpoint is not a version-1 integrity checkpoint" };
    }
    const ids: Record<string, string> = Object.create(null);
    for (const [id, tier] of Object.entries(parsed.ids)) ids[id] = tier;
    parsed.ids = ids;
    return { kind: "ok", checkpoint: parsed };
  } catch (err) {
    return { kind: "unreadable", reason: `checkpoint is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Write the checkpoint atomically: a 0600 temp file beside it, then rename. A
 * failure throws — the caller reports it and never claims a checkpoint landed.
 */
export function writeCheckpoint(path: string, checkpoint: IntegrityCheckpoint): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(checkpoint)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}
