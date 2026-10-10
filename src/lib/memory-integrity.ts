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
 *   - a scan that cannot read the corpus or checkpoint reports UNKNOWN, never
 *     healthy, and leaves the checkpoint unchanged.
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
  /**
   * Bounds the next scan's deletion-history read: rows at or after
   * `watermark - DELETION_HISTORY_MARGIN_MS` are read, older rows are not.
   * Never later than `scannedAt`, and never later than the `at` of any
   * history row this checkpoint still needs (so the oldest live watermark
   * also bounds retention safely). Absent on a checkpoint written before this
   * field existed, which reads as `unknown` — the scan falls back to a full
   * read, never "nothing new".
   */
  watermark?: string;
  byDurability: Record<Tier, number>;
  /** id -> durability at the checkpoint. */
  ids: Record<string, string>;
  instanceTokens: Record<string, string | null>;
  historyIds: string[];
}

/**
 * Margin (ms) applied to a checkpoint watermark on both sides of the
 * deletion-history read and of retention.
 *
 * A row's `at` is stamped by `recordMemoryDeletion` when the delete records
 * its history, inside the delete's transaction and therefore BEFORE it
 * commits; the watcher only sees it once the commit is visible, up to a
 * transaction later than `at`. The watcher's own clock (its `scannedAt`) is
 * also a different clock from the instance's. The margin must exceed both the
 * longest such delay and the largest clock difference between the two hosts.
 * Five minutes is comfortably above both for an operator-run scan, and the
 * cost of a too-large margin is only re-reading a few minutes of history.
 */
export const DELETION_HISTORY_MARGIN_MS = 5 * 60_000;

/**
 * The time from which the next scan must read deletion history, or null when
 * the watermark is absent or unparseable (the caller must then read the whole
 * table — never treat an unknown watermark as "nothing new").
 */
export function deletionReadSince(
  checkpoint: IntegrityCheckpoint | null | undefined,
  marginMs = DELETION_HISTORY_MARGIN_MS,
): string | null {
  const watermark = checkpoint?.watermark;
  if (typeof watermark !== "string" || watermark.length === 0) return null;
  const ms = Date.parse(watermark);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms - marginMs).toISOString();
}

/**
 * The instant before which deletion history may be pruned: the OLDEST live
 * checkpoint watermark, minus the margin. Returns null when there are no
 * watermarks or any of them is absent or unparseable — the caller then prunes
 * nothing and names the reason.
 *
 * A checkpoint's watermark is never later than the `at` of a history row it
 * still needs (see `emptyCheckpoint`), so no row an older checkpoint needs is
 * older than the oldest watermark — which is why the oldest, not the newest,
 * watermark is the bound.
 */
export function retentionCutoff(
  watermarks: readonly (string | null | undefined)[],
  marginMs = DELETION_HISTORY_MARGIN_MS,
): string | null {
  if (watermarks.length === 0) return null;
  let oldest: number | null = null;
  for (const watermark of watermarks) {
    if (typeof watermark !== "string" || watermark.length === 0) return null;
    const ms = Date.parse(watermark);
    if (!Number.isFinite(ms)) return null;
    if (oldest === null || ms < oldest) oldest = ms;
  }
  return new Date((oldest as number) - marginMs).toISOString();
}

/**
 * The history rows retention may prune: rows strictly older than the cutoff,
 * oldest first, at most `cap`. A row whose `at` is missing or unparseable is
 * never selected — an unreadable age is not proof of age.
 */
export function historyRowsToPrune(
  rows: readonly DeletionRecordLite[],
  cutoffIso: string,
  cap: number,
): DeletionRecordLite[] {
  const cutoff = Date.parse(cutoffIso);
  if (!Number.isFinite(cutoff)) return [];
  return rows
    .filter((row) => {
      const ms = typeof row.at === "string" ? Date.parse(row.at) : NaN;
      return Number.isFinite(ms) && ms < cutoff;
    })
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .slice(0, Math.max(0, cap));
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

export function emptyCheckpoint(scannedAt: string, rows: readonly MemoryRowLite[], deletions: readonly DeletionRecordLite[] = [], seenHistoryIds: readonly string[] = []): IntegrityCheckpoint {
  const ids: Record<string, string> = Object.create(null);
  const instanceTokens: Record<string, string | null> = Object.create(null);
  for (const row of rows) {
    ids[row.id] = normalizeTier(row.durability);
    instanceTokens[row.id] = typeof row.instanceToken === "string" && row.instanceToken.length > 0 ? row.instanceToken : null;
  }
  const seen = new Set(seenHistoryIds);
  const historyIds = deletions
    .filter(d => seen.has(d.id) && isDurableTier(ids[d.memoryId]) &&
      !!instanceTokens[d.memoryId] && instanceTokens[d.memoryId] === d.memoryInstanceToken)
    .map(d => d.id);
  // The watermark is `scannedAt`, pulled back to the `at` of any retained
  // history row this checkpoint still needs (a durable id whose nonempty token
  // matches and that is not already absorbed). Those rows must be re-read by the
  // next scan, and must survive retention, so the watermark may not pass them.
  const absorbed = new Set(historyIds);
  let watermark = scannedAt;
  for (const d of deletions) {
    if (absorbed.has(d.id) || !isDurableTier(ids[d.memoryId])) continue;
    const token = instanceTokens[d.memoryId];
    if (!token || token !== d.memoryInstanceToken) continue;
    if (typeof d.at === "string" && d.at.length > 0 && d.at < watermark) watermark = d.at;
  }
  return { version: 2, scannedAt, watermark, byDurability: tallyByDurability(rows), ids, instanceTokens, historyIds };
}

export function deletionRecordsToPrune(checkpoint: IntegrityCheckpoint, deletions: readonly DeletionRecordLite[]): string[] {
  const seen = new Set(checkpoint.historyIds);
  return deletions.filter(d => seen.has(d.id) || !isDurableTier(checkpoint.ids[d.memoryId]) ||
    !checkpoint.instanceTokens[d.memoryId] || checkpoint.instanceTokens[d.memoryId] !== d.memoryInstanceToken).map(d => d.id);
}

/** UNKNOWN; `checkpointWritten` defaults to false. */
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
        (parsed.watermark !== undefined && (typeof parsed.watermark !== "string" || parsed.watermark.length === 0)) ||
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
