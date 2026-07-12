/**
 * space.ts — pre-flight space check, step 1 of the ladder
 * (~/ops/FLAIR-MIGRATION-SAFETY.md, "Space pressure"):
 *
 * "Pre-flight space check before any write — estimate snapshot size AND the
 * migration's own working set (supersession transforms temporarily hold
 * old+new ≈ 2× for touched tables) vs free disk, with a headroom floor
 * (never fill past ~90% — a full disk bricks Harper itself)."
 *
 * Kern verdict: "Space estimate includes HNSW rebuild overhead (re-embed
 * rewrites every vector → index rebuild can be 2–3× raw vector size):
 * snapshot + new vectors + index overhead vs headroom floor." —
 * `estimateWorkingSetBytes` below is the caller's job (the runner computes
 * it per risk class); this module just evaluates the estimate against real
 * (or test-overridden) disk free/total space.
 */
import { statfsSync } from "node:fs";

export const DEFAULT_HEADROOM_FLOOR = 0.9; // never project past 90% used

/**
 * Test-only escape hatch: when set, overrides the real statfs-reported free
 * byte count. Used by the halt-on-blocked-space integration test (real
 * Harper spawned as a child process — the test can't inject a JS dependency
 * into that process, only environment variables) to force the ladder's
 * step-1 check to fail deterministically without needing an actually-full
 * disk. Unset (the default) in every real deployment, so this is inert in
 * production.
 */
export const TEST_FREE_BYTES_ENV = "FLAIR_MIGRATION_TEST_FREE_BYTES";

export interface SpaceProbe {
  getFreeBytes(dataDir: string): number;
  getTotalBytes(dataDir: string): number;
}

function realGetFreeBytes(dataDir: string): number {
  const override = process.env[TEST_FREE_BYTES_ENV];
  if (override !== undefined) {
    const n = Number(override);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const st = statfsSync(dataDir);
  return st.bavail * st.bsize;
}

function realGetTotalBytes(dataDir: string): number {
  const st = statfsSync(dataDir);
  return st.blocks * st.bsize;
}

export const defaultSpaceProbe: SpaceProbe = {
  getFreeBytes: realGetFreeBytes,
  getTotalBytes: realGetTotalBytes,
};

export interface SpaceCheckInput {
  dataDir: string;
  /** Estimated bytes the snapshot (scoped to risk class) will consume. */
  estimatedSnapshotBytes: number;
  /**
   * Estimated bytes the migration's own working set needs beyond the
   * snapshot — e.g. HNSW rebuild overhead (2-3x raw vector size) for a
   * re-embed, or old+new row duplication for a content-transform. 0 for a
   * migration with no extra working-set footprint.
   */
  estimatedWorkingSetBytes: number;
  headroomFloor?: number;
}

export interface SpaceCheckResult {
  ok: boolean;
  freeBytes: number;
  totalBytes: number;
  neededBytes: number;
  projectedUsedFraction: number;
  reason?: string;
}

/**
 * Evaluates the pre-flight space check. Fails (ok:false) if the needed
 * bytes don't fit in free space OR if consuming them would project disk
 * usage past the headroom floor — matching invariant III's "never fill past
 * ~90%" rule exactly (a technically-fitting migration that would still push
 * the disk to 95% full is refused, same as one that doesn't fit at all).
 */
export function checkSpace(input: SpaceCheckInput, probe: SpaceProbe = defaultSpaceProbe): SpaceCheckResult {
  const floor = input.headroomFloor ?? DEFAULT_HEADROOM_FLOOR;
  const freeBytes = probe.getFreeBytes(input.dataDir);
  const totalBytes = probe.getTotalBytes(input.dataDir);
  const neededBytes = input.estimatedSnapshotBytes + input.estimatedWorkingSetBytes;

  const usedBytesNow = Math.max(0, totalBytes - freeBytes);
  const projectedUsedBytes = usedBytesNow + neededBytes;
  const projectedUsedFraction = totalBytes > 0 ? projectedUsedBytes / totalBytes : 1;

  const fits = neededBytes <= freeBytes;
  const withinFloor = projectedUsedFraction <= floor;
  const ok = fits && withinFloor;

  let reason: string | undefined;
  if (!ok) {
    reason =
      `need ${neededBytes} bytes free (snapshot + migration working set), have ${freeBytes}; ` +
      `proceeding would exceed the ${Math.round(floor * 100)}% disk headroom floor — ` +
      `prune old snapshots (flair keeps last-3/30-day) or set FLAIR_SNAPSHOT_DIR to a volume with more room`;
  }

  return { ok, freeBytes, totalBytes, neededBytes, projectedUsedFraction, reason };
}
