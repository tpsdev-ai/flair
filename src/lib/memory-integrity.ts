/**
 * memory-integrity.ts — the out-of-store integrity watcher's checkpoint and
 * comparison logic (flair#2213, slice 1 of #971; covers #1244's unnoticed-loss
 * risk).
 *
 * The default checkpoint is `~/.flair/integrity-checkpoint.json` (mode 0600,
 * written atomically); `--checkpoint` selects another path, which must stay
 * outside Harper data. It stores per-tier counts and Memory ids (durability
 * and instanceToken). `flair integrity check` compares the corpus to it:
 *
 *   - a durable-tier id (permanent / persistent) missing, or with a changed or
 *     missing previously nonempty token, without new matching history, is an UNEXPLAINED LOSS.
 *     A row returning with its checkpointed token can make the next scan healthy.
 *   - a durable-tier id gone WITH a new matching deletion record is history-backed.
 *   - a present id with changed durability reports a TIER CHANGE, including replacements.
 *   - a durable-tier count decrease beyond the id-set diff is also an alert.
 *   - a scan that cannot read the instance reports UNKNOWN, never healthy, and
 *     never overwrites the checkpoint.
 *
 * This module compares scans and reads and writes checkpoints.
 */
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  version: 2;
  /** ISO timestamp of the successful scan this checkpoint records. */
  scannedAt: string;
  byDurability: Record<Tier, number>;
  /** id -> durability at the checkpoint. */
  ids: Record<string, string>;
  instanceTokens: Record<string, string | null>;
  historyIds: string[];
}

export interface MemoryRowLite {
  id: string;
  durability: string;
  instanceToken?: string | null;
}

export interface DeletionRecordLite {
  id: string;
  memoryId: string;
  memoryInstanceToken?: string | null;
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
  reason?: "replaced";
}

export interface IntegrityVerdict {
  status: IntegrityStatus;
  /** For `unknown`: why the scan failed. */
  reason?: string;
  scannedAt: string;
  total: number;
  counts: Record<Tier, number>;
  /** History-backed attributions for missing checkpointed incarnations. */
  attributedDeletes: AttributedDeletion[];
  /** Ids whose durability changed since the checkpoint. */
  tierChanges: TierChange[];
  /** Missing or replaced durable ids without matching new history. */
  losses: UnexplainedLoss[];
  /** Durable count decreases beyond the id-set diff, tier -> delta. */
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
  const instanceTokens: Record<string, string | null> = Object.create(null);
  for (const row of rows) {
    ids[row.id] = normalizeTier(row.durability);
    instanceTokens[row.id] = typeof row.instanceToken === "string" && row.instanceToken.length > 0 ? row.instanceToken : null;
  }
  return { version: 2, scannedAt, byDurability: tallyByDurability(rows), ids, instanceTokens, historyIds: deletions.map(d => d.id) };
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
 * Compare the live corpus with the checkpoint; filter checkpoint-seen history here.
 */
export function compareScan(opts: {
  checkpoint: IntegrityCheckpoint;
  rows: readonly MemoryRowLite[];
  deletions: readonly DeletionRecordLite[];
  scannedAt: string;
}): IntegrityVerdict {
  const { checkpoint, rows, deletions, scannedAt } = opts;
  const current = new Map<string, MemoryRowLite>();
  for (const row of rows) current.set(row.id, row);
  const counts = tallyByDurability(rows);

  const deletedTiers = new Map<string, DeletionRecordLite>();
  const seenHistory = new Set(checkpoint.historyIds);
  for (const d of deletions) {
    if (seenHistory.has(d.id)) continue;
    const instanceToken = checkpoint.instanceTokens[d.memoryId];
    if (!instanceToken || d.memoryInstanceToken !== instanceToken) continue;
    const prev = deletedTiers.get(d.memoryId);
    if (!prev || d.at > prev.at) deletedTiers.set(d.memoryId, d);
  }

  const attributedDeletes: AttributedDeletion[] = [];
  const tierChanges: TierChange[] = [];
  const losses: UnexplainedLoss[] = [];

  for (const [id, cpTier] of Object.entries(checkpoint.ids)) {
    const curRow = current.get(id);
    const curToken = typeof curRow?.instanceToken === "string" && curRow.instanceToken.length > 0 ? curRow.instanceToken : null;
    const cpToken = checkpoint.instanceTokens[id];
    const replaced = curRow !== undefined && !!cpToken && curToken !== cpToken;
    if (curRow === undefined || replaced) {
      const record = deletedTiers.get(id);
      if (record) {
        attributedDeletes.push({ id, tier: cpTier, at: record.at });
      } else if (isDurableTier(cpTier)) {
        losses.push({ id, tier: cpTier, ...(replaced ? { reason: "replaced" as const } : {}) });
      }
      // Non-durable losses without a record are out of the monitored set.
    }
    if (curRow === undefined) continue;
    const curTier = normalizeTier(curRow.durability);
    if (curTier !== cpTier) tierChanges.push({ id, from: cpTier, to: curTier });
  }

  // Named losses, attributions and tier changes account for the id-set diff.
  const unexplainedDecrease: Record<string, number> = {};
  for (const tier of DURABLE_TIERS) {
    const attributedOut = attributedDeletes.filter((d) => d.tier === tier && !current.has(d.id)).length;
    const lostOut = losses.filter((l) => l.tier === tier && !current.has(l.id)).length;
    const changedOut = tierChanges.filter((c) => c.from === tier && c.to !== tier).length;
    const changedIn = tierChanges.filter((c) => c.to === tier && c.from !== tier).length;
    const explainedDrop = attributedOut + lostOut + changedOut - changedIn;
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

/** The default checkpoint path under the operator's flair config dir. */
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
  try {
    lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    return { kind: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
  try {
    const parsed = JSON.parse(raw) as IntegrityCheckpoint;
    if (parsed?.version !== 2 || typeof parsed.scannedAt !== "string" ||
        typeof parsed.ids !== "object" || parsed.ids === null || Array.isArray(parsed.ids) ||
        !Object.entries(parsed.ids).every(([id, tier]) => id.length > 0 && (ALL_TIERS as readonly unknown[]).includes(tier)) ||
        typeof parsed.instanceTokens !== "object" || parsed.instanceTokens === null || Array.isArray(parsed.instanceTokens) ||
        Object.keys(parsed.instanceTokens).length !== Object.keys(parsed.ids).length ||
        !Object.keys(parsed.ids).every(id => Object.hasOwn(parsed.instanceTokens, id) &&
          (parsed.instanceTokens[id] === null || (typeof parsed.instanceTokens[id] === "string" && parsed.instanceTokens[id]!.length > 0))) ||
        !Array.isArray(parsed.historyIds) || !parsed.historyIds.every(id => typeof id === "string" && id.length > 0) ||
        !parsed.byDurability || !ALL_TIERS.every(tier => Number.isSafeInteger(parsed.byDurability[tier]) && parsed.byDurability[tier] >= 0)) {
      return { kind: "unreadable", reason: "checkpoint is not a version-2 integrity checkpoint" };
    }
    const ids: Record<string, string> = Object.create(null);
    for (const [id, tier] of Object.entries(parsed.ids)) ids[id] = tier;
    parsed.ids = ids;
    const instanceTokens: Record<string, string | null> = Object.create(null);
    for (const [id, instanceToken] of Object.entries(parsed.instanceTokens)) instanceTokens[id] = instanceToken;
    parsed.instanceTokens = instanceTokens;
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
